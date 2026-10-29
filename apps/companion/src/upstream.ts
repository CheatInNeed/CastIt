// Upstream HTTP(S) requests with SSRF-guarded DNS, timeouts and cancellation.
// Redirects are NOT followed here: the media proxy hands them to the receiver as proxied
// redirects, so relative URLs in manifests resolve against the final location.
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { guardedLookup } from './security.ts';

export interface UpstreamOptions {
  method?: 'GET' | 'HEAD';
  headers?: OutgoingHttpHeaders;
  allowPrivate: boolean;
  /** No bytes for this long → abort. */
  idleTimeoutMs?: number;
}

export interface UpstreamRequest {
  response: Promise<IncomingMessage>;
  abort: () => void;
}

export function requestUpstream(url: URL, options: UpstreamOptions): UpstreamRequest {
  const transport = url.protocol === 'https:' ? https : http;
  let abort = () => undefined as void;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        lookup: guardedLookup(options.allowPrivate) as never,
        timeout: options.idleTimeoutMs ?? 20_000,
      },
      resolve,
    );
    abort = () => req.destroy(new Error('aborted'));
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
  return { response, abort: () => abort() };
}

/** Headers sent upstream: only the explicit session context plus safe client headers. */
export function upstreamHeaders(
  context: { referer?: string; origin?: string; userAgent?: string },
  client: { range?: string; ifRange?: string; accept?: string },
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    accept: client.accept || '*/*',
    'accept-encoding': 'identity',
    'user-agent': context.userAgent || 'Mozilla/5.0 (Castit companion)',
  };
  if (client.range) headers.range = client.range;
  if (client.ifRange) headers['if-range'] = client.ifRange;
  if (context.referer) headers.referer = context.referer;
  if (context.origin) headers.origin = context.origin;
  // Never: cookie, authorization, proxy-authorization.
  return headers;
}
