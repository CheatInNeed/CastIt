// The companion's core: the LAN media server the Chromecast fetches relayed/converted streams
// from (/m/<session>/…, /t/<session>/…), plus the session operations the extension calls through
// the native messaging host (index.ts).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CompanionErrorCode,
  CreateSessionRequest,
  CreateSessionResponse,
  UpstreamCheck,
  UpstreamContext,
} from '@castit/shared';
import type { CompanionSettings } from './config.ts';
import { detectFfmpeg, probeMedia, type FfmpegCapabilities } from './ffmpeg.ts';
import { toProxyUrl } from './manifest.ts';
import { planMedia, RECEIVER_CAPABILITIES, summarizePlan } from './plan.ts';
import { redactUrl, UpstreamBlockedError, validateUpstreamUrl } from './security.ts';
import { SessionStore, type SessionStoreOptions } from './sessions.ts';
import { handleMediaRequest } from './streaming.ts';
import { JobManager, sweepStaleJobDirs } from './transcoder.ts';
import { requestUpstream, upstreamHeaders } from './upstream.ts';

export const VERSION = '1.1.0';

export interface CompanionOptions extends CompanionSettings {
  sessionOptions?: Partial<SessionStoreOptions>;
  log?: (message: string) => void;
  isLocalClient?: (address: string) => boolean;
  /** Where FFmpeg job directories are created (default: OS temp dir). */
  tmpRoot?: string;
}

export interface RunningCompanion {
  mediaBaseUrl: string;
  sessions: SessionStore;
  jobs: JobManager;
  ffmpeg: FfmpegCapabilities;
  /** Opens a relay session for an upstream stream (and starts FFmpeg when conversion is asked for and needed). */
  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse>;
  deleteSession(sessionId: string): void;
  /** Synchronous last-resort cleanup for process exit: kills FFmpeg, deletes job directories. */
  closeSync(): void;
  close(): Promise<void>;
}

export class CompanionRequestError extends Error {
  readonly code: CompanionErrorCode;
  constructor(code: CompanionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Only these context fields are accepted; anything else (cookies, auth headers) is dropped. */
function sanitizeContext(input: unknown): UpstreamContext {
  const ctx = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\r\n]/.test(v) ? v : undefined);
  const referer = str(ctx.referer, 4096);
  const origin = str(ctx.origin, 512);
  return {
    referer: referer && /^https?:\/\//i.test(referer) ? referer : undefined,
    origin: origin && /^https?:\/\/[^/]+$/i.test(origin) ? origin : undefined,
    userAgent: str(ctx.userAgent, 512),
  };
}

/** One small request to see whether the upstream accepts us with this context. */
async function checkUpstream(url: URL, kind: string, context: UpstreamContext, allowPrivate: boolean): Promise<UpstreamCheck> {
  const { response, abort } = requestUpstream(url, {
    allowPrivate,
    idleTimeoutMs: 10_000,
    headers: upstreamHeaders(context, { range: kind === 'progressive' ? 'bytes=0-1' : undefined }),
  });
  try {
    const res = await response;
    res.resume();
    const status = res.statusCode ?? 0;
    // Redirects count as reachable; the receiver will follow the proxied redirect.
    return { ok: status < 400, status, contentType: res.headers['content-type'] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    abort();
  }
}

export async function startCompanion(options: CompanionOptions): Promise<RunningCompanion> {
  const log = options.log ?? ((m: string) => console.log(`[castit] ${m}`));
  const sessions = new SessionStore(options.sessionOptions);
  const jobs = new JobManager();
  sessions.onDelete = (id) => void jobs.close(id);
  const swept = sweepStaleJobDirs(options.tmpRoot);
  if (swept) log(`removed ${swept} stale transcode folder(s)`);
  const ffmpeg = await detectFfmpeg({ ffmpeg: options.ffmpegPath, ffprobe: options.ffprobePath });

  const media = http.createServer((req, res) => {
    const ctx = { sessions, mediaBase: mediaBaseUrl, allowPrivate: options.allowPrivateUpstreams, log, isLocalClient: options.isLocalClient, jobs };
    handleMediaRequest(req, res, ctx).catch((e) => {
      log(`media handler failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  async function createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
    let upstream: URL;
    try {
      upstream = validateUpstreamUrl(String(body.url ?? ''), options.allowPrivateUpstreams);
    } catch (e) {
      throw new CompanionRequestError('BLOCKED_ADDRESS', (e as Error).message);
    }
    const kind = ['hls', 'dash', 'progressive'].includes(body.kind) ? body.kind : 'unknown';
    const context = sanitizeContext(body.context);
    const check = await checkUpstream(upstream, kind, context, options.allowPrivateUpstreams);
    if (check.error && /private or reserved|local host name/.test(check.error)) {
      throw new CompanionRequestError('BLOCKED_ADDRESS', check.error);
    }
    const session = sessions.create(upstream, kind, context);
    if (body.profile && body.profile in RECEIVER_CAPABILITIES) session.profile = body.profile;
    log(`session ${session.id.slice(0, 6)}… → ${redactUrl(upstream.href)} (check: ${check.status ?? check.error})`);
    const response: CreateSessionResponse = {
      sessionId: session.id,
      mediaUrl: toProxyUrl(mediaBaseUrl, session.id, upstream),
      expiresAt: sessions.idleExpiry(session),
      check,
      delivery: 'relay',
    };
    if (body.transcode && check.ok) await prepareConversion(session.id, upstream, kind, body.transcode, response);
    return response;
  }

  /**
   * Analyses the stream with ffprobe (reading it through this session's own relay, so the same
   * SSRF guard and Referer apply) and starts an FFmpeg job when the receiver can't play it as is.
   */
  async function prepareConversion(
    sessionId: string,
    upstream: URL,
    kind: string,
    request: NonNullable<CreateSessionRequest['transcode']>,
    response: CreateSessionResponse,
  ): Promise<void> {
    if (!ffmpeg.available) {
      response.analysisError = ffmpeg.error ?? 'FFmpeg is not available.';
      return;
    }
    if (kind === 'dash' && !ffmpeg.demuxers.dash) {
      response.analysisError = 'This FFmpeg build cannot read DASH streams.';
      return;
    }
    const wanted = {
      mode: request.mode === 'force' ? 'force' : 'auto',
      profile: ['compat', 'ultra', 'google-tv', 'gtv-streamer'].includes(request.profile) ? request.profile : 'compat',
      quality: ['auto', '1080p', '720p', '480p'].includes(request.quality) ? request.quality : 'auto',
    } as const;
    const input = toProxyUrl(`http://127.0.0.1:${mediaPort}`, sessionId, upstream);
    let probe;
    try {
      probe = await probeMedia({ ffmpeg: options.ffmpegPath, ffprobe: options.ffprobePath }, input);
    } catch (e) {
      response.analysisError = (e as Error).message;
      log(`analysis failed: ${response.analysisError}`);
      return;
    }
    const extension = /\.([a-z0-9]{2,5})$/i.exec(upstream.pathname)?.[1]?.toLowerCase();
    const plan = planMedia(probe, { kind: kind as 'hls' | 'dash' | 'progressive' | 'unknown', extension }, wanted);
    response.plan = summarizePlan(plan, ffmpeg.encoder);
    if (plan.action === 'direct') return; // playable as is: keep the plain relay

    const live = (kind === 'hls' || kind === 'dash') && !probe.duration;
    const job = jobs.create(sessionId, {
      input,
      plan,
      encoder: ffmpeg.encoder,
      ffmpegPath: options.ffmpegPath,
      duration: probe.duration,
      live,
      log,
      tmpRoot: options.tmpRoot,
    });
    const base = `${mediaBaseUrl}/t/${sessionId}`;
    response.delivery = plan.action;
    response.mediaUrl = `${base}/index.m3u8`;
    response.media = job.delivered(base);
    log(`${plan.action} ${sessionId.slice(0, 6)}…: ${plan.details.join('; ')}`);
  }

  const mediaPort = await new Promise<number>((resolve, reject) => {
    media.once('error', reject);
    media.listen(options.mediaPort, options.mediaListenHost, () => resolve((media.address() as AddressInfo).port));
  });
  const mediaBaseUrl = `http://${options.publicHost.includes(':') ? `[${options.publicHost}]` : options.publicHost}:${mediaPort}`;
  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();

  return {
    mediaBaseUrl,
    sessions,
    jobs,
    ffmpeg,
    createSession,
    deleteSession: (sessionId) => sessions.delete(sessionId),
    closeSync() {
      jobs.closeAllNow();
    },
    async close() {
      clearInterval(sweeper);
      sessions.closeAll();
      await jobs.closeAll();
      media.closeAllConnections();
      await new Promise((r) => media.close(r));
    },
  };
}

export { UpstreamBlockedError };
