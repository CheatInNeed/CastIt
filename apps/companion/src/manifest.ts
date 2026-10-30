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
  /** The receiver must get these bytes as this media type (see withMediaHint). */
  as?: 'mp4' | 'ts';
}

const PROXY_PATH = /^\/m\/([A-Za-z0-9_-]{16,})\/(https?)\/([^/?#]+)((?:\/|\?)[^#]*)?$/;
const MEDIA_HINT = /~castit\.(mp4|ts)(?=\?|$)/;

/** Parses a request path (req.url) back into session id + upstream URL. */
export function parseProxyPath(path: string): ParsedProxyPath | null {
  const m = PROXY_PATH.exec(path);
  if (!m) return null;
  let rest = m[4] ?? '/';
  const hint = MEDIA_HINT.exec(rest);
  if (hint) rest = rest.slice(0, hint.index) + rest.slice(hint.index + hint[0].length);
  return {
    sessionId: m[1]!,
    upstream: `${m[2]}://${m[3]}${rest.startsWith('?') ? `/${rest}` : rest}`,
    ...(hint ? { as: hint[1] as 'mp4' | 'ts' } : {}),
  };
}

/**
 * Some sites disguise video segments as images or text (seg-1.png served as image/png) so CDNs
 * cache them. Cast receivers pick a parser from the name and type, so such segments get a
 * `~castit.mp4` / `~castit.ts` suffix that the relay strips again and answers with the real type.
 */
export const DISGUISED_SEGMENT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|css|js|html?|txt|json)$/i;

export function withMediaHint(proxyUrl: string, as: 'mp4' | 'ts'): string {
  const q = proxyUrl.indexOf('?');
  return q < 0 ? `${proxyUrl}~castit.${as}` : `${proxyUrl.slice(0, q)}~castit.${as}${proxyUrl.slice(q)}`;
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
export function rewriteHls(text: string, baseUrl: string, map: UrlMapper, keepVariant?: (attributes: string) => boolean): string {
  // Media playlists: disguised segments (and their init segment) get a media type hint.
  const segmentType = /#EXT-X-MAP/i.test(text) ? 'mp4' : 'ts';
  const segmentMap: UrlMapper = /#EXTINF/i.test(text)
    ? (absolute) => {
        const out = map(absolute);
        return out && DISGUISED_SEGMENT.test(absolute.pathname) ? withMediaHint(out, segmentType) : out;
      }
    : map;
  const lines = keepVariant ? dropVariants(text.split(/(\r?\n)/), keepVariant) : text.split(/(\r?\n)/);
  return lines
    .map((line) => {
      if (line === '\n' || line === '\r\n' || line.trim() === '') return line;
      if (line.trimStart().startsWith('#')) {
        const uriMap = /^#EXT-X-(MAP|PART):/i.test(line.trimStart()) ? segmentMap : map;
        return line.replace(/URI="([^"]*)"/g, (_, uri: string) => `URI="${mapReference(uri, baseUrl, uriMap, false)}"`);
      }
      return mapReference(line, baseUrl, segmentMap, false);
    })
    .join('');
}

/**
 * Leaves out master playlist variants the receiver can't play (e.g. a 4K HEVC HDR variant next
 * to H.264 ones), so it can't pick one and fail. Keeps everything when nothing would be left.
 */
function dropVariants(lines: string[], keep: (attributes: string) => boolean): string[] {
  const drop = new Set<number>();
  let variants = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart();
    if (/^#EXT-X-I-FRAME-STREAM-INF:/i.test(line)) {
      if (!keep(line)) drop.add(i);
      continue;
    }
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    variants++;
    if (keep(line)) continue;
    drop.add(i);
    // The variant's URI is the next line that is neither blank nor a tag.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (!next) continue;
      if (!next.startsWith('#')) drop.add(j);
      if (!next.startsWith('#') || /^#EXT-X-STREAM-INF:/i.test(next)) break;
    }
  }
  const dropped = [...drop].filter((i) => /^#EXT-X-STREAM-INF:/i.test(lines[i]!.trimStart())).length;
  if (dropped === 0 || dropped === variants) return lines;
  return lines.filter((_, i) => !drop.has(i));
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
