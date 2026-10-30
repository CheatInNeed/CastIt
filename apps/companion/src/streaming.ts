// The media proxy the Chromecast talks to. Streams upstream bytes straight through (no
// buffering beyond Node's stream highWaterMark), forwards Range requests, rewrites manifests,
// turns upstream redirects into proxied redirects, and aborts upstream work when the receiver
// disconnects.
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import {
  isGenericContentType,
  manifestKindFromBody,
  manifestKindFromHeaders,
  mediaContentType,
  parseProxyPath,
  rewriteDash,
  rewriteHls,
  toProxyUrl,
} from './manifest.ts';
import { variantPlayable } from './plan.ts';
import { isThisMachine, normalizeRemote, redactUrl, UpstreamBlockedError, validateUpstreamUrl } from './security.ts';
import { originOf, type MediaSession, type SessionStore } from './sessions.ts';
import { JobFileNotFound, type JobManager } from './transcoder.ts';
import { requestUpstream, upstreamHeaders } from './upstream.ts';

export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export interface MediaContext {
  sessions: SessionStore;
  /** e.g. http://192.168.1.20:47801 */
  mediaBase: string;
  allowPrivate: boolean;
  log: (message: string) => void;
  /** Requests from this computer never claim a session's device binding (overridable in tests). */
  isLocalClient?: (address: string) => boolean;
  jobs?: JobManager;
}

const JOB_PATH = /^\/t\/([A-Za-z0-9_-]{16,})\/([A-Za-z0-9_.-]+)(?:\?.*)?$/;

const JOB_TYPES: Array<[RegExp, string]> = [
  [/\.m3u8$/, 'application/vnd.apple.mpegurl'],
  [/\.ts$/, 'video/mp2t'],
  [/\.m4s$/, 'video/iso.segment'],
  [/\.mp4$/, 'video/mp4'],
  [/\.vtt(\.part)?$/, 'text/vtt; charset=utf-8'],
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

/** Upstream response headers that are safe and useful to pass to the receiver. */
const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'content-encoding'];

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/** Handles OPTIONS/method checks and device binding. Returns false when the response was sent. */
function admit(req: IncomingMessage, res: ServerResponse, session: MediaSession, ctx: MediaContext): boolean {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...CORS_HEADERS,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, If-Range, Accept, Content-Type',
      // Private Network Access preflight: the receiver page (public HTTPS origin) reaching a LAN address.
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
    });
    res.end();
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed', { allow: 'GET, HEAD, OPTIONS' });
    return false;
  }

  // Bind the session to the first client that isn't this computer (the Chromecast); refuse others.
  const client = normalizeRemote(req.socket.remoteAddress);
  if (!(ctx.isLocalClient ?? isThisMachine)(client)) {
    session.boundClient ??= client;
    if (session.boundClient !== client) {
      ctx.log(`refused ${client}: session is bound to ${session.boundClient}`);
      send(res, 403, 'This media session belongs to another device.');
      return false;
    }
  }
  return true;
}

export async function handleMediaRequest(req: IncomingMessage, res: ServerResponse, ctx: MediaContext): Promise<void> {
  const job = JOB_PATH.exec(req.url ?? '');
  if (job) return handleJobRequest(req, res, ctx, job[1]!, job[2]!);

  const parsed = parseProxyPath(req.url ?? '');
  const session = parsed ? ctx.sessions.use(parsed.sessionId) : undefined;
  // Unknown and expired sessions look identical: nothing to learn by probing ids.
  if (!parsed || !session) return send(res, 404, 'Not found');
  if (!admit(req, res, session, ctx)) return;

  let upstream: URL;
  try {
    upstream = validateUpstreamUrl(parsed.upstream, ctx.allowPrivate);
  } catch (e) {
    return send(res, 403, (e as Error).message);
  }
  if (!session.allowedOrigins.has(originOf(upstream))) {
    ctx.log(`refused host outside session: ${upstream.host}`);
    return send(res, 403, 'Host not part of this media session.');
  }

  session.requests++;
  const { response, abort } = requestUpstream(upstream, {
    method: req.method as 'GET' | 'HEAD',
    allowPrivate: ctx.allowPrivate,
    headers: upstreamHeaders(session.context, {
      range: header(req, 'range'),
      ifRange: header(req, 'if-range'),
      accept: header(req, 'accept'),
    }),
  });
  session.active.add(abort);
  const cleanup = () => session.active.delete(abort);
  // Receiver went away (seek, stop, buffer full): stop pulling from upstream immediately.
  res.on('close', () => {
    if (!res.writableFinished) abort();
    cleanup();
  });

  let up: IncomingMessage;
  try {
    up = await response;
  } catch (e) {
    cleanup();
    if (res.destroyed) return;
    if (e instanceof UpstreamBlockedError) return send(res, 403, e.message);
    ctx.log(`upstream error for ${redactUrl(upstream.href)}: ${(e as Error).message}`);
    return send(res, 502, `Upstream unreachable: ${(e as Error).message}`);
  }

  try {
    await relay(up, req, res, upstream, session, ctx, parsed.as);
  } catch (e) {
    if (!res.destroyed && (e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      ctx.log(`relay error for ${redactUrl(upstream.href)}: ${(e as Error).message}`);
    }
    up.destroy();
    if (!res.headersSent) send(res, 502, 'Relay failed');
    else res.destroy();
  } finally {
    cleanup();
  }
}

async function relay(
  up: IncomingMessage,
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  session: MediaSession,
  ctx: MediaContext,
  as?: 'mp4' | 'ts',
): Promise<void> {
  const status = up.statusCode ?? 502;

  // Redirect: hand the receiver a proxied redirect so it re-resolves relative URLs correctly.
  if (status >= 300 && status < 400 && up.headers.location) {
    up.resume();
    let target: URL;
    try {
      target = validateUpstreamUrl(new URL(up.headers.location, upstream).href, ctx.allowPrivate);
    } catch (e) {
      return send(res, 403, (e as Error).message);
    }
    session.allowedOrigins.add(originOf(target));
    return send(res, status, '', { location: toProxyUrl(ctx.mediaBase, session.id, target) });
  }

  if (status >= 400) {
    up.resume();
    return send(res, status, `Upstream answered HTTP ${status}`);
  }

  const contentType = up.headers['content-type'];
  let kind = as ? null : manifestKindFromHeaders(contentType, upstream.href);
  // Only manifests and sniffed bodies are decoded; media bytes pass through as sent.
  let body: Readable | undefined;
  let head: Buffer | undefined;

  // Generic content type and no manifest extension: peek at the first bytes.
  if (!kind && !as && req.method === 'GET' && isGenericContentType(contentType) && !/\.(ts|m4s|mp4|m4v|webm|mkv|aac|mp3|key)$/i.test(upstream.pathname)) {
    body = decoded(up);
    head = await firstChunk(body);
    kind = head ? manifestKindFromBody(head.toString('utf8', 0, Math.min(head.length, 4096))) : null;
  }

  if (kind && req.method === 'GET') {
    const text = await readAll(body ?? decoded(up), head, MAX_MANIFEST_BYTES);
    const map = (absolute: URL) => {
      try {
        validateUpstreamUrl(absolute.href, ctx.allowPrivate);
      } catch {
        return null; // leave blocked references untouched; they will simply fail on the receiver
      }
      session.allowedOrigins.add(originOf(absolute));
      return toProxyUrl(ctx.mediaBase, session.id, absolute);
    };
    const profile = session.profile;
    const keep = profile ? (attributes: string) => variantPlayable(attributes, profile) : undefined;
    const rewritten = kind === 'hls' ? rewriteHls(text, upstream.href, map, keep) : rewriteDash(text, upstream.href, map);
    const out = Buffer.from(rewritten, 'utf8');
    session.bytesServed += out.length;
    res.writeHead(status === 206 ? 200 : status, {
      ...CORS_HEADERS,
      'content-type': kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
      'content-length': String(out.length),
      'cache-control': 'no-cache',
    });
    res.end(out);
    return;
  }

  // Media bytes: stream through untouched.
  // Disguised segments (see withMediaHint) are sent as what they really are.
  const type = as === 'mp4' ? 'video/mp4' : as === 'ts' ? 'video/mp2t' : mediaContentType(contentType, upstream.href);
  const headers: Record<string, string> = { ...CORS_HEADERS, 'content-type': type };
  for (const name of PASS_HEADERS) {
    const value = up.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  if (body && body !== up) {
    // We decoded while sniffing, so the bytes we send are no longer encoded.
    delete headers['content-encoding'];
    delete headers['content-length'];
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    up.resume();
    res.end();
    return;
  }
  const source = body ?? up;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      if (head) {
        session.bytesServed += head.length;
        yield head;
      }
      for await (const chunk of chunks) {
        session.bytesServed += chunk.length;
        yield chunk;
      }
    },
    res,
  );
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Decompresses only when we are going to read the body ourselves (manifests / peeking). */
function decoded(up: IncomingMessage): Readable {
  switch ((up.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
      return up.pipe(createGunzip());
    case 'deflate':
      return up.pipe(createInflate());
    case 'br':
      return up.pipe(createBrotliDecompress());
    default:
      return up;
  }
}

function firstChunk(stream: Readable): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      stream.pause();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

async function readAll(stream: Readable, head: Buffer | undefined, limit: number): Promise<string> {
  const chunks: Buffer[] = head ? [head] : [];
  let size = head?.length ?? 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Manifest too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Serves FFmpeg output (playlist, segments, subtitles) for a session's transcode job. */
async function handleJobRequest(req: IncomingMessage, res: ServerResponse, ctx: MediaContext, sessionId: string, name: string): Promise<void> {
  const session = ctx.sessions.use(sessionId);
  const job = session ? ctx.jobs?.get(sessionId) : undefined;
  if (!session || !job) return send(res, 404, 'Not found');
  if (!admit(req, res, session, ctx)) return;

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  session.requests++;
  try {
    if (name === 'index.m3u8') {
      const body = Buffer.from(await job.playlist(abort.signal), 'utf8');
      res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(body.length), 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const subtitle = /^subs-(\d+)\.vtt$/.exec(name);
    const path = subtitle ? await job.subtitle(Number(subtitle[1]), abort.signal) : await job.segment(name, abort.signal);
    const type = JOB_TYPES.find(([re]) => re.test(path))?.[1] ?? 'application/octet-stream';
    const size = statSync(path).size;
    res.writeHead(200, { ...CORS_HEADERS, 'content-type': type, 'content-length': String(size), 'cache-control': subtitle ? 'no-cache' : 'max-age=3600' });
    if (req.method === 'HEAD') return void res.end();
    session.bytesServed += size;
    await pipeline(createReadStream(path), res);
  } catch (e) {
    if (res.destroyed || abort.signal.aborted) return;
    if (e instanceof JobFileNotFound) return send(res, 404, 'Not found');
    // A file deleted between the wait and the read (pruned): the receiver simply retries.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, 'Not found');
    ctx.log(`job ${sessionId.slice(0, 6)}…: ${(e as Error).message}`);
    send(res, 503, (e as Error).message, { 'retry-after': '2' });
  }
}
