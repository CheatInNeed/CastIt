// Two HTTP servers:
//   control (127.0.0.1 only): health, pairing, session management, for the extension.
//   media   (LAN):            /m/<session>/… streaming endpoints, for the Chromecast.
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  COMPANION_PROTOCOL,
  type CompanionErrorBody,
  type CompanionHealth,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type UpstreamCheck,
  type UpstreamContext,
} from '@castit/shared';
import { PairingStore, type CompanionSettings } from './config.ts';
import { toProxyUrl } from './manifest.ts';
import {
  controlRequestAllowed,
  PairingManager,
  randomToken,
  redactUrl,
  UpstreamBlockedError,
  validateUpstreamUrl,
} from './security.ts';
import { SessionStore, type SessionStoreOptions } from './sessions.ts';
import { handleMediaRequest } from './streaming.ts';
import { requestUpstream, upstreamHeaders } from './upstream.ts';

export const VERSION = '0.3.0';
const MAX_BODY_BYTES = 64 * 1024;

export interface CompanionOptions extends CompanionSettings {
  sessionOptions?: Partial<SessionStoreOptions>;
  log?: (message: string) => void;
  isLocalClient?: (address: string) => boolean;
}

export interface RunningCompanion {
  controlUrl: string;
  mediaBaseUrl: string;
  pairing: PairingManager;
  store: PairingStore;
  sessions: SessionStore;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: CompanionErrorBody['code'];
  constructor(status: number, code: CompanionErrorBody['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BAD_REQUEST', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON.');
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
  const store = new PairingStore(options.configDir);
  const pairing = new PairingManager();
  const sessions = new SessionStore(options.sessionOptions);

  const media = http.createServer((req, res) => {
    const ctx = { sessions, mediaBase: mediaBaseUrl, allowPrivate: options.allowPrivateUpstreams, log, isLocalClient: options.isLocalClient };
    handleMediaRequest(req, res, ctx).catch((e) => {
      log(`media handler failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  const control = http.createServer((req, res) => {
    handleControl(req, res).catch((e) => {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, code: e.code } satisfies CompanionErrorBody);
      log(`control handler failed: ${(e as Error).message}`);
      json(res, 500, { error: 'Internal error', code: 'INTERNAL' } satisfies CompanionErrorBody);
    });
  });

  const requireAuth = (req: IncomingMessage) => {
    const auth = req.headers.authorization ?? '';
    const key = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    if (!store.verify(key)) throw new HttpError(401, 'UNAUTHORIZED', 'Not paired with this companion.');
  };

  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!controlRequestAllowed(req.headers.host, req.headers.origin, controlPort)) {
      throw new HttpError(403, 'FORBIDDEN', 'Requests must come from the Castit extension on this computer.');
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') {
      const body: CompanionHealth = {
        name: 'castit-companion',
        version: VERSION,
        protocol: COMPANION_PROTOCOL,
        paired: store.paired,
        mediaBaseUrl,
        ffmpeg: false,
      };
      return json(res, 200, body);
    }

    if (route === 'POST /api/pair') {
      const body = await readJson<{ code?: string; label?: string }>(req);
      if (!pairing.verify(String(body.code ?? ''))) {
        throw new HttpError(401, 'PAIRING_FAILED', 'Wrong or expired pairing code. Start the companion with --pair for a new code.');
      }
      const apiKey = randomToken(32);
      store.add(apiKey, String(body.label ?? 'Castit extension'));
      log('paired a new browser');
      return json(res, 200, { apiKey });
    }

    if (route === 'POST /api/sessions') {
      requireAuth(req);
      const body = await readJson<CreateSessionRequest>(req);
      let upstream: URL;
      try {
        upstream = validateUpstreamUrl(String(body.url ?? ''), options.allowPrivateUpstreams);
      } catch (e) {
        throw new HttpError(400, 'BLOCKED_ADDRESS', (e as Error).message);
      }
      const kind = ['hls', 'dash', 'progressive'].includes(body.kind) ? body.kind : 'unknown';
      const context = sanitizeContext(body.context);
      const check = await checkUpstream(upstream, kind, context, options.allowPrivateUpstreams);
      if (check.error && /private or reserved|local host name/.test(check.error)) {
        throw new HttpError(400, 'BLOCKED_ADDRESS', check.error);
      }
      const session = sessions.create(upstream, kind, context);
      log(`session ${session.id.slice(0, 6)}… → ${redactUrl(upstream.href)} (check: ${check.status ?? check.error})`);
      const response: CreateSessionResponse = {
        sessionId: session.id,
        mediaUrl: toProxyUrl(mediaBaseUrl, session.id, upstream),
        expiresAt: sessions.idleExpiry(session),
        check,
      };
      return json(res, 200, response);
    }

    if (route === 'GET /api/sessions') {
      requireAuth(req);
      return json(res, 200, sessions.list());
    }

    const del = /^DELETE \/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(route);
    if (del) {
      requireAuth(req);
      sessions.delete(del[1]!);
      res.writeHead(204).end();
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Unknown endpoint.');
  }

  const listen = (server: Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
    });

  const controlPort = await listen(control, options.controlPort, '127.0.0.1');
  const mediaPort = await listen(media, options.mediaPort, options.mediaListenHost);
  const mediaBaseUrl = `http://${options.publicHost.includes(':') ? `[${options.publicHost}]` : options.publicHost}:${mediaPort}`;
  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();

  return {
    controlUrl: `http://127.0.0.1:${controlPort}`,
    mediaBaseUrl,
    pairing,
    store,
    sessions,
    async close() {
      clearInterval(sweeper);
      sessions.closeAll();
      control.closeAllConnections();
      media.closeAllConnections();
      await Promise.all([new Promise((r) => control.close(r)), new Promise((r) => media.close(r))]);
    },
  };
}

export { UpstreamBlockedError };
