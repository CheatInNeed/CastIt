// Fetches a candidate once, without cookies, right before casting.
// Requests are sent with `credentials: 'omit'` on purpose: that never forwards the user's
// cookies, and it approximates what the Chromecast will see (it has no cookies either).
import type { ManifestSummary, StreamKind } from '@castit/shared';
import { parseDash, parseHls, type DashInfo, type HlsInfo } from './manifests.ts';
import { dedupeKey, totalSizeFromHeaders } from './media-types.ts';

export interface ProbeResult {
  reachable: boolean;
  status?: number;
  contentType?: string;
  /** Access-Control-Allow-Origin value; null when the header is absent. */
  cors?: string | null;
  totalSize?: number;
  /** Top-level playlist. */
  hls?: HlsInfo;
  /** Media playlist (first variant of a master, or the playlist itself). */
  hlsMedia?: HlsInfo;
  dash?: DashInfo;
  error?: string;
}

type Fetch = typeof fetch;

export async function probeStream(
  candidate: { url: string; kind: StreamKind },
  fetchImpl: Fetch = fetch,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const init = (): RequestInit => ({ credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  try {
    if (candidate.kind === 'hls' || candidate.kind === 'dash') {
      const res = await fetchImpl(candidate.url, init());
      const result = baseResult(res);
      if (!res.ok) return result;
      const text = await res.text();
      const base = res.url || candidate.url;
      if (candidate.kind === 'dash') {
        result.dash = parseDash(text) ?? undefined;
        return result;
      }
      result.hls = parseHls(text, base) ?? undefined;
      result.hlsMedia = result.hls?.type === 'media' ? result.hls : undefined;
      const variant = result.hls?.variants[0];
      if (variant) {
        try {
          const media = await fetchImpl(variant.uri, init());
          if (media.ok) result.hlsMedia = parseHls(await media.text(), media.url || variant.uri) ?? undefined;
        } catch {
          // Variant details are optional; the master playlist alone is enough to cast.
        }
      }
      return result;
    }

    const res = await fetchImpl(candidate.url, { ...init(), headers: { Range: 'bytes=0-1' } });
    const result = baseResult(res);
    await res.body?.cancel().catch(() => undefined);
    return result;
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function baseResult(res: Response): ProbeResult {
  return {
    reachable: true,
    status: res.status,
    contentType: res.headers.get('content-type') ?? undefined,
    cors: res.headers.get('access-control-allow-origin'),
    totalSize: totalSizeFromHeaders(res.status, res.headers.get('content-range'), res.headers.get('content-length')),
  };
}

const KEY_FORMAT_NAMES: Array<[RegExp, string]> = [
  [/streamingkeydelivery/i, 'FairPlay'],
  [/edef8ba9|widevine/i, 'Widevine'],
  [/9a04f079|playready|com\.microsoft/i, 'PlayReady'],
];

/** Condenses a probe of an HLS/DASH URL into what ranking and castability need. */
export function summarizeManifest(kind: 'hls' | 'dash', probe: ProbeResult, now: number): ManifestSummary {
  const base = {
    kind,
    inspectedAt: now,
    reachable: probe.reachable,
    status: probe.status,
    cors: probe.reachable ? probe.cors !== null && probe.cors !== undefined : null,
    error: probe.error,
  };
  if (kind === 'dash') {
    const dash = probe.dash;
    return {
      ...base,
      valid: !!dash,
      role: dash ? 'mpd' : undefined,
      live: dash?.live,
      maxHeight: dash?.maxHeight,
      variantCount: 0,
      audioTracks: 0,
      subtitleTracks: 0,
      codecs: dash?.codecs ?? [],
      encryption: dash?.encrypted ? 'drm' : 'none',
      drmSystems: dash?.drmSystems ?? [],
      duration: dash?.duration,
      childKeys: [],
    };
  }

  const top = probe.hls;
  const media = probe.hlsMedia ?? (top?.type === 'media' ? top : undefined);
  const heights = top?.variants.map((v) => v.height ?? 0).filter((h) => h > 0) ?? [];
  const codecs = new Set<string>();
  for (const v of top?.variants ?? []) for (const codec of (v.codecs ?? '').split(',')) if (codec.trim()) codecs.add(codec.trim());
  const encryptions = [top?.encryption, media?.encryption];
  const encryption = encryptions.includes('drm')
    ? 'drm'
    : encryptions.includes('sample-aes')
      ? 'sample-aes'
      : encryptions.includes('aes-128')
        ? 'aes-128'
        : 'none';
  const keyFormats = [...(top?.keyFormats ?? []), ...(media?.keyFormats ?? [])];
  const drmSystems = [
    ...new Set(keyFormats.flatMap((f) => KEY_FORMAT_NAMES.filter(([re]) => re.test(f)).map(([, name]) => name))),
  ];

  return {
    ...base,
    valid: !!top,
    role: top?.type,
    live: media?.live,
    maxHeight: heights.length ? Math.max(...heights) : undefined,
    variantCount: top?.variants.length ?? 0,
    audioTracks: top?.audioRenditions ?? 0,
    subtitleTracks: top?.subtitleRenditions ?? 0,
    codecs: [...codecs],
    encryption,
    drmSystems,
    duration: media?.live ? undefined : media?.totalDuration,
    segmentFormat: media?.segmentFormat,
    childKeys: top ? [...top.variants.map((v) => dedupeKey(v.uri)), ...top.renditionUris.map(dedupeKey)] : [],
  };
}
