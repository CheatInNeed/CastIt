// Minimal HLS / DASH manifest parsing (regex based: DOMParser is unavailable in service workers).
// Extracts only what casting decisions need: master vs media, live vs VOD, segment format,
// encryption/DRM, and quality.
import type { HlsSegmentFormat } from '@castit/shared';

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
}

export type HlsEncryption = 'none' | 'aes-128' | 'sample-aes' | 'drm';

export interface HlsInfo {
  type: 'master' | 'media';
  variants: HlsVariant[];
  live: boolean;
  segmentCount: number;
  firstSegmentUri?: string;
  /** Sum of #EXTINF durations (media playlists only). */
  totalDuration?: number;
  segmentFormat: 'ts' | 'fmp4' | 'aac' | 'mp3' | 'ac3' | 'unknown';
  encryption: HlsEncryption;
  keyFormats: string[];
  audioRenditions: number;
  subtitleRenditions: number;
  /** Absolute URIs of #EXT-X-MEDIA rendition playlists (alternate audio, subtitles). */
  renditionUris: string[];
}

const DRM_KEYFORMATS = /streamingkeydelivery|edef8ba9|com\.widevine|playready|9a04f079|com\.microsoft/i;

export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  return out;
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

export function parseHls(text: string, baseUrl: string): HlsInfo | null {
  if (!text.trimStart().startsWith('#EXTM3U')) return null;

  const variants: HlsVariant[] = [];
  const segments: string[] = [];
  const keys: Record<string, string>[] = [];
  let pendingVariant: Record<string, string> | null = null;
  let pendingDuration = 0;
  let totalDuration = 0;
  let hasEndList = false;
  let playlistType: string | undefined;
  let hasMap = false;
  let audio = 0;
  let subs = 0;
  const renditionUris: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) pendingVariant = parseAttributes(line.slice(18));
    else if (line === '#EXT-X-ENDLIST') hasEndList = true;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = line.slice(21).trim();
    else if (line.startsWith('#EXT-X-MAP')) hasMap = true;
    else if (line.startsWith('#EXT-X-KEY:')) keys.push(parseAttributes(line.slice(11)));
    else if (line.startsWith('#EXT-X-SESSION-KEY:')) keys.push(parseAttributes(line.slice(19)));
    else if (line.startsWith('#EXTINF:')) pendingDuration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice(13));
      if (attrs.TYPE === 'AUDIO') audio++;
      else if (attrs.TYPE === 'SUBTITLES') subs++;
      if (attrs.URI) renditionUris.push(resolve(attrs.URI, baseUrl));
    } else if (!line.startsWith('#')) {
      if (pendingVariant) {
        const [w, h] = (pendingVariant.RESOLUTION ?? '').split('x').map(Number);
        variants.push({
          uri: resolve(line, baseUrl),
          bandwidth: pendingVariant.BANDWIDTH ? Number(pendingVariant.BANDWIDTH) : undefined,
          width: w || undefined,
          height: h || undefined,
          codecs: pendingVariant.CODECS,
        });
        pendingVariant = null;
      } else {
        segments.push(resolve(line, baseUrl));
        totalDuration += pendingDuration;
        pendingDuration = 0;
      }
    }
  }

  const type = variants.length > 0 ? 'master' : 'media';
  return {
    type,
    variants,
    live: type === 'media' && !hasEndList && playlistType !== 'VOD',
    segmentCount: segments.length,
    firstSegmentUri: segments[0],
    totalDuration: type === 'media' && segments.length ? totalDuration : undefined,
    segmentFormat: type === 'media' ? segmentFormat(segments[0], hasMap) : 'unknown',
    ...encryptionOf(keys),
    audioRenditions: audio,
    subtitleRenditions: subs,
    renditionUris,
  };
}

function segmentFormat(firstSegment: string | undefined, hasMap: boolean): HlsInfo['segmentFormat'] {
  if (hasMap) return 'fmp4';
  const path = firstSegment ? (safePath(firstSegment) ?? firstSegment) : '';
  if (/\.(mp4|m4s|m4v|cmfv|cmfa)$/i.test(path)) return 'fmp4';
  if (/\.aac$/i.test(path)) return 'aac';
  if (/\.mp3$/i.test(path)) return 'mp3';
  if (/\.ac3$/i.test(path)) return 'ac3';
  return firstSegment ? 'ts' : 'unknown';
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function encryptionOf(keys: Record<string, string>[]): Pick<HlsInfo, 'encryption' | 'keyFormats'> {
  let encryption: HlsEncryption = 'none';
  const keyFormats: string[] = [];
  for (const key of keys) {
    const method = (key.METHOD ?? 'NONE').toUpperCase();
    if (method === 'NONE') continue;
    const format = key.KEYFORMAT ?? 'identity';
    if (!keyFormats.includes(format)) keyFormats.push(format);
    if (DRM_KEYFORMATS.test(format)) encryption = 'drm';
    else if (method.startsWith('SAMPLE-AES') && encryption !== 'drm') encryption = 'sample-aes';
    else if (method === 'AES-128' && encryption === 'none') encryption = 'aes-128';
  }
  return { encryption, keyFormats };
}

/** Maps a parsed media playlist to Cast HLS segment formats. */
export function castHlsFormats(
  info: HlsInfo | undefined,
): { hlsSegmentFormat?: HlsSegmentFormat; hlsVideoSegmentFormat?: 'mpeg2_ts' | 'fmp4' } {
  switch (info?.segmentFormat) {
    case 'fmp4':
      return { hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' };
    case 'aac':
      return { hlsSegmentFormat: 'aac' };
    case 'mp3':
      return { hlsSegmentFormat: 'mp3' };
    case 'ac3':
      return { hlsSegmentFormat: 'ac3' };
    case 'ts':
      return { hlsSegmentFormat: 'ts', hlsVideoSegmentFormat: 'mpeg2_ts' };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- DASH

export interface DashInfo {
  live: boolean;
  encrypted: boolean;
  drmSystems: string[];
  maxHeight?: number;
  codecs: string[];
  duration?: number;
}

const DRM_SYSTEM_IDS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'ClearKey',
};

export function parseDash(text: string): DashInfo | null {
  const mpd = /<MPD\b[^>]*>/i.exec(text);
  if (!mpd) return null;

  const drmSystems: string[] = [];
  let encrypted = false;
  for (const m of text.matchAll(/<ContentProtection\b[^>]*schemeIdUri\s*=\s*["']([^"']+)["']/gi)) {
    encrypted = true;
    const uuid = /urn:uuid:([0-9a-f-]{36})/i.exec(m[1]!)?.[1]?.toLowerCase();
    const name = uuid ? (DRM_SYSTEM_IDS[uuid] ?? uuid) : undefined;
    if (name && !drmSystems.includes(name)) drmSystems.push(name);
  }

  let maxHeight: number | undefined;
  const codecs = new Set<string>();
  for (const m of text.matchAll(/<(?:Representation|AdaptationSet)\b([^>]*)>/gi)) {
    const height = /\bheight\s*=\s*["'](\d+)["']/i.exec(m[1]!)?.[1];
    if (height) maxHeight = Math.max(maxHeight ?? 0, Number(height));
    const codec = /\bcodecs\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    if (codec) codecs.add(codec);
  }

  const durationAttr = /\bmediaPresentationDuration\s*=\s*["']([^"']+)["']/i.exec(mpd[0])?.[1];
  return {
    live: /\btype\s*=\s*["']dynamic["']/i.test(mpd[0]),
    encrypted,
    drmSystems,
    maxHeight,
    codecs: [...codecs],
    duration: durationAttr ? parseIsoDuration(durationAttr) : undefined,
  };
}

/** Parses ISO-8601 durations like PT1H2M3.5S. */
export function parseIsoDuration(value: string): number | undefined {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return undefined;
  const [, d, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  return d! * 86400 + h! * 3600 + min! * 60 + s!;
}
