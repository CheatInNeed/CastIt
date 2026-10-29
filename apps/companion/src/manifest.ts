// URL mapping between upstream URLs and companion media URLs, and HLS/DASH manifest rewriting.
//
// Media URLs mirror the upstream URL:  <mediaBase>/m/<session>/<scheme>/<host[:port]><path>?<query>
// Because the upstream path is preserved, *relative* references inside a manifest (segments,
// variant playlists, DASH templates) resolve on the receiver to the right proxied URL with no
// rewriting at all. Only absolute references are rewritten. Query strings (signatures) are kept
// byte-for-byte as the URL parser produced them.

export function toProxyUrl(mediaBase: string, sessionId: string, upstream: string | URL): string {
  const u = typeof upstream === 'string' ? new URL(upstream) : upstream;
  return `${mediaBase}/m/${sessionId}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`;
}

export interface ParsedProxyPath {
  sessionId: string;
  upstream: string;
}

const PROXY_PATH = /^\/m\/([A-Za-z0-9_-]{16,})\/(https?)\/([^/?#]+)((?:\/|\?)[^#]*)?$/;

/** Parses a request path (req.url) back into session id + upstream URL. */
export function parseProxyPath(path: string): ParsedProxyPath | null {
  const m = PROXY_PATH.exec(path);
  if (!m) return null;
  const rest = m[4] ?? '/';
  return { sessionId: m[1]!, upstream: `${m[2]}://${m[3]}${rest.startsWith('?') ? `/${rest}` : rest}` };
}

/** Maps an absolute URL to its proxied form; returns null to leave a reference untouched. */
export type UrlMapper = (absolute: URL) => string | null;

function mapReference(ref: string, base: string, map: UrlMapper, onlyAbsolute: boolean): string {
  const trimmed = ref.trim();
  if (!trimmed) return ref;
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//');
  if (onlyAbsolute && !isAbsolute) return ref;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return ref;
  }
  // skd://, data:, etc. are not fetched over HTTP; leave them alone.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return ref;
  return map(resolved) ?? ref;
}

/**
 * Rewrites every URI in an HLS playlist (variant/segment lines and URI="…" attributes of
 * EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-PART, …) to proxied URLs.
 * All references are rewritten (not just absolute ones) so playlists work even when the
 * receiver resolves them against a redirected URL.
 */
export function rewriteHls(text: string, baseUrl: string, map: UrlMapper): string {
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      if (line === '\n' || line === '\r\n' || line.trim() === '') return line;
      if (line.trimStart().startsWith('#')) {
        return line.replace(/URI="([^"]*)"/g, (_, uri: string) => `URI="${mapReference(uri, baseUrl, map, false)}"`);
      }
      return mapReference(line, baseUrl, map, false);
    })
    .join('');
}

const XML_DECODE: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_DECODE[m]!);
const encodeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Rewrites absolute URLs in a DASH MPD: <BaseURL>, <Location>, and the media / initialization /
 * sourceURL / xlink:href attributes. Relative references keep working through the mirrored path.
 */
export function rewriteDash(text: string, baseUrl: string, map: UrlMapper): string {
  const mapAbs = (raw: string) => {
    const decoded = decodeXml(raw);
    const mapped = mapReference(decoded, baseUrl, map, true);
    return mapped === decoded ? raw : encodeXml(mapped);
  };
  return text
    .replace(/(<(BaseURL|Location)\b[^>]*>)([^<]*)(<\/\2>)/g, (_, open: string, _tag, value: string, close: string) => `${open}${mapAbs(value)}${close}`)
    .replace(/\b(media|initialization|sourceURL|xlink:href)\s*=\s*"([^"]*)"/g, (_, attr: string, value: string) => `${attr}="${mapAbs(value)}"`);
}

const MANIFEST_TYPES: Array<[RegExp, 'hls' | 'dash']> = [
  [/mpegurl/i, 'hls'],
  [/dash\+xml/i, 'dash'],
];

export function manifestKindFromHeaders(contentType: string | undefined, url: string): 'hls' | 'dash' | null {
  for (const [re, kind] of MANIFEST_TYPES) if (contentType && re.test(contentType)) return kind;
  const path = safePath(url);
  if (/\.m3u8$/i.test(path)) return 'hls';
  if (/\.mpd$/i.test(path)) return 'dash';
  return null;
}

export function manifestKindFromBody(head: string): 'hls' | 'dash' | null {
  const start = head.replace(/^﻿/, '').trimStart();
  if (start.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(start.slice(0, 2048))) return 'dash';
  return null;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
  key: 'application/octet-stream',
};

const GENERIC = /^(application\/octet-stream|binary\/octet-stream|text\/plain|application\/x-www-form-urlencoded)?$/i;

/** Upstream Content-Type, or a correct one by extension when upstream sent a generic type. */
export function mediaContentType(upstreamType: string | undefined, url: string): string {
  const base = (upstreamType ?? '').split(';')[0]!.trim();
  if (base && !GENERIC.test(base)) return upstreamType!;
  const ext = /\.([a-z0-9]+)$/i.exec(safePath(url))?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || upstreamType || 'application/octet-stream';
}

export function isGenericContentType(contentType: string | undefined): boolean {
  return GENERIC.test((contentType ?? '').split(';')[0]!.trim());
}
