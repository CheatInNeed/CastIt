// Pure helpers for classifying media URLs / Content-Types and choosing Cast content types.
import type { Container, StreamKind } from '@castit/shared';

export interface MediaClassification {
  kind: StreamKind;
  container: Container;
  audioOnly: boolean;
}

const c = (kind: StreamKind, container: Container, audioOnly = false): MediaClassification => ({
  kind,
  container,
  audioOnly,
});

const BY_EXTENSION: Record<string, MediaClassification> = {
  m3u8: c('hls', 'unknown'),
  mpd: c('dash', 'unknown'),
  mp4: c('progressive', 'mp4'),
  m4v: c('progressive', 'mp4'),
  mov: c('progressive', 'mov'),
  webm: c('progressive', 'webm'),
  mkv: c('progressive', 'mkv'),
  ogv: c('progressive', 'ogg'),
  flv: c('progressive', 'flv'),
  avi: c('progressive', 'avi'),
  mp3: c('progressive', 'mp3', true),
  m4a: c('progressive', 'mp4', true),
  aac: c('progressive', 'aac', true),
  // Pieces of adaptive streams.
  ts: c('segment', 'ts'),
  m2ts: c('segment', 'ts'),
  m4s: c('segment', 'mp4'),
  cmfv: c('segment', 'mp4'),
  cmfa: c('segment', 'mp4', true),
};

const BY_MIME: Record<string, MediaClassification> = {
  'application/vnd.apple.mpegurl': c('hls', 'unknown'),
  'application/x-mpegurl': c('hls', 'unknown'),
  'audio/mpegurl': c('hls', 'unknown'),
  'audio/x-mpegurl': c('hls', 'unknown'),
  'application/dash+xml': c('dash', 'unknown'),
  'video/mp4': c('progressive', 'mp4'),
  'video/webm': c('progressive', 'webm'),
  'video/quicktime': c('progressive', 'mov'),
  'video/x-matroska': c('progressive', 'mkv'),
  'video/ogg': c('progressive', 'ogg'),
  'video/x-flv': c('progressive', 'flv'),
  'video/x-msvideo': c('progressive', 'avi'),
  'audio/mp4': c('progressive', 'mp4', true),
  'audio/mpeg': c('progressive', 'mp3', true),
  'audio/aac': c('progressive', 'aac', true),
  'video/mp2t': c('segment', 'ts'),
  'video/iso.segment': c('segment', 'mp4'),
};

/** Content-Types that are generic and should not override what the URL says. */
const GENERIC_MIME = new Set(['application/octet-stream', 'binary/octet-stream', 'text/plain', '']);
/** Content-Types that prove the response is not media (e.g. an HTML error page at a .mp4 URL). */
const NON_MEDIA_MIME = /^(text\/(html|css|javascript|xml)|image\/|font\/|application\/(json|javascript|x-javascript))/;

export function normalizeMime(contentType: string | undefined | null): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

export function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Lower-case file extension of the URL path, if any. */
export function extensionOf(url: string): string | undefined {
  const parsed = safeUrl(url);
  if (!parsed) return undefined;
  const last = parsed.pathname.split('/').pop() ?? '';
  return /\.([a-z0-9]{2,5})$/i.exec(last)?.[1]?.toLowerCase();
}

/** Manifest hints elsewhere in the URL, e.g. Azure `(format=m3u8-aapl)` or `/stream.m3u8/index`. */
function hintFromUrl(url: string): MediaClassification | undefined {
  if (/format=m3u8|\.m3u8(?=[/?&#]|$)/i.test(url)) return BY_EXTENSION.m3u8;
  if (/format=mpd|\.mpd(?=[/?&#]|$)/i.test(url)) return BY_EXTENSION.mpd;
  return undefined;
}

const SEGMENT_QUERY = /[?&](range|bytes)=\d+-\d*/i;
const SEGMENT_PATH = [
  /\/range\/\d+-\d+/i,
  /(?:^|[/_.-])(?:seg|segment|chunk|frag|fragment)[-_]?\d+[^/]*$/i,
  /\/init(?:[-_][\w-]+)?\.(?:mp4|m4s|m4v)$/i,
  /\/\d+\.(?:m4s|m4v|mp4)$/i,
];

/** URLs that look like a piece of an adaptive stream rather than a whole file. */
export function isLikelySegmentUrl(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  if (SEGMENT_QUERY.test(parsed.search)) return true;
  return SEGMENT_PATH.some((re) => re.test(parsed.pathname));
}

/**
 * Classifies a request as media (or not). Returns null for non-media.
 * Content-Type wins when specific; the URL wins for manifests served with generic types.
 */
export function classifyMedia(url: string, contentType?: string | null): MediaClassification | null {
  const parsed = safeUrl(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;

  const mime = normalizeMime(contentType);
  if (NON_MEDIA_MIME.test(mime)) return null;

  const ext = extensionOf(url);
  const byExt = ext ? BY_EXTENSION[ext] : undefined;
  const byMime = GENERIC_MIME.has(mime) ? undefined : BY_MIME[mime];
  const hint = hintFromUrl(url);

  let result: MediaClassification | undefined;
  if (byExt && (byExt.kind === 'hls' || byExt.kind === 'dash')) result = byExt;
  else result = byMime ?? byExt ?? hint;
  if (!result) return null;

  if (result.kind === 'progressive' && isLikelySegmentUrl(url)) {
    result = { ...result, kind: 'segment' };
  }
  return result;
}

/** contentType to send in chrome.cast.media.MediaInfo. */
export function castContentType(kind: StreamKind, container: Container, audioOnly = false): string {
  if (kind === 'hls') return 'application/x-mpegurl';
  if (kind === 'dash') return 'application/dash+xml';
  switch (container) {
    case 'mp4':
      return audioOnly ? 'audio/mp4' : 'video/mp4';
    case 'mov':
      return 'video/mp4'; // Receivers play QuickTime/H.264 when declared as MP4.
    case 'webm':
      return audioOnly ? 'audio/webm' : 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'ogg':
      return 'video/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/aac';
    case 'ts':
      return 'video/mp2t';
    default:
      return 'video/mp4';
  }
}

const AD_PATTERN =
  /(?:doubleclick\.net|googlesyndication\.com|imasdk\.googleapis\.com|googleads\.|adservice\.|\/ads?\/|[/_.-](?:preroll|midroll|postroll|vast|vmap|advert|adserver)[/_.-]|[?&](?:ad_?id|adunit|vast)=)/i;

export function isAdUrl(url: string): boolean {
  return AD_PATTERN.test(url);
}

/** Readable label for a URL: decoded file name, or host. */
/** File names that say nothing about the video: shown with their (short) parent folder. */
const GENERIC_NAME = /^(master|index|playlist|manifest|main|video|stream|chunklist|prog_index|media)?\.(m3u8|mpd|mp4|webm)$/i;

/** Readable label for a URL: decoded file name (with its folder when the name is generic), or host. */
export function labelForUrl(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const last = parts.pop();
  if (!last) return parsed.hostname;
  const name = decode(last);
  const parent = parts.length ? decode(parts[parts.length - 1]!) : '';
  if (GENERIC_NAME.test(name) && parent && parent.length <= 24) return `${parent}/${name}`;
  return name;
}

/** Query parameters that change between requests for the same media (tokens, cache busters). */
const VOLATILE_PARAMS = new Set([
  'token', 'auth', 'auth_key', 'expires', 'exp', 'expiry', 'sig', 'signature', 'hdnts', 'hdnea',
  'policy', 'key-pair-id', 'st', 'e', 'h', 'hash', 'ts', 'timestamp', '_', 'cb', 'nocache', 'rand',
  'random', 'acl', 'validfrom', 'validto', 'range', 'bytes', 'x-amz-signature', 'x-amz-date',
  'x-amz-credential', 'x-amz-expires', 'x-amz-security-token', 'x-amz-signedheaders', 'x-amz-algorithm',
]);

/**
 * Key used only for comparing URLs. The original URL is always what gets cast;
 * this key never replaces it, so signed URLs stay intact.
 */
export function dedupeKey(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url;
  const kept = [...parsed.searchParams.entries()]
    .filter(([name]) => !VOLATILE_PARAMS.has(name.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = kept.map(([k, v]) => `${k}=${v}`).join('&');
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${query ? `?${query}` : ''}`;
}

/** 32-bit FNV-1a hash, hex. Used for stable candidate ids. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Total size from `Content-Range: bytes 0-1/12345` or Content-Length on a 200. */
export function totalSizeFromHeaders(
  status: number,
  contentRange?: string | null,
  contentLength?: string | null,
): number | undefined {
  const total = contentRange ? /\/(\d+)\s*$/.exec(contentRange)?.[1] : undefined;
  if (total) return Number(total);
  if (status === 200 && contentLength && /^\d+$/.test(contentLength.trim())) return Number(contentLength);
  return undefined;
}
