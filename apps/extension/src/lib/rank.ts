// Deterministic, pure candidate merging + ranking.
//
// Inputs are everything Castit knows about a tab: network responses (with frame ids and the
// frame tree), <video> elements reported by every frame, and manifests inspected so far.
// Output is a list of castable streams, best first. Nothing here touches the network or DOM.
import type {
  ManifestSummary,
  NetworkCandidate,
  RankedCandidate,
  TabMediaState,
  VideoElementInfo,
} from '@castit/shared';
import { classifyMedia, dedupeKey, hashString, isAdUrl, labelForUrl, safeUrl } from './media-types.ts';

export { dedupeKey } from './media-types.ts';

/** Collapses network candidates sharing a dedupe key, keeping the most recently seen URL. */
export function dedupeCandidates(list: NetworkCandidate[]): NetworkCandidate[] {
  const byKey = new Map<string, NetworkCandidate>();
  for (const candidate of list) {
    const key = dedupeKey(candidate.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate });
      continue;
    }
    const newer = candidate.lastSeen >= existing.lastSeen ? candidate : existing;
    byKey.set(key, {
      ...newer,
      firstSeen: Math.min(existing.firstSeen, candidate.firstSeen),
      hits: existing.hits + candidate.hits,
      totalSize: newer.totalSize ?? existing.totalSize ?? candidate.totalSize,
    });
  }
  return [...byKey.values()];
}

export function qualityLabel(height: number | undefined): string | undefined {
  if (!height || height <= 0) return undefined;
  if (height >= 2000) return '4K';
  return `${height}p`;
}

/** Codec list from a SourceBuffer type such as `video/mp4; codecs="avc1.64001f,mp4a.40.2"`. */
export function codecsFromMime(mime: string): string[] {
  const m = /codecs\s*=\s*"?([^";]+)"?/i.exec(mime);
  return m ? m[1]!.split(',').map((c) => c.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------- frames

interface FrameVideo extends VideoElementInfo {
  frameId: number;
}

function allVideos(state: TabMediaState): FrameVideo[] {
  return Object.values(state.frames).flatMap((f) => f.videos.map((v) => ({ ...v, frameId: f.frameId })));
}

export function frameAncestors(state: TabMediaState, frameId: number): number[] {
  const out: number[] = [];
  let current = frameId;
  while (current !== 0 && out.length < 32) {
    const parent = state.frameTree?.[String(current)]?.parentFrameId;
    if (parent === undefined || parent < 0 || out.includes(parent)) break;
    out.push(parent);
    current = parent;
  }
  // Frames we never saw navigate (e.g. present before install) are assumed to sit under the top frame.
  if (frameId !== 0 && !out.includes(0)) out.push(0);
  return out;
}

/** 0 = same frame, 1 = ancestor/descendant, Infinity = unrelated. */
export function frameDistance(state: TabMediaState, a: number, b: number): number {
  if (a === b) return 0;
  if (frameAncestors(state, a).includes(b) || frameAncestors(state, b).includes(a)) return 1;
  return Infinity;
}

export function frameUrl(state: TabMediaState, frameId: number): string | undefined {
  return (
    state.frames[String(frameId)]?.url ??
    state.frameTree?.[String(frameId)]?.url ??
    (frameId === 0 ? state.pageUrl : undefined)
  );
}

/** A frame, or one of its ancestors, is an ad frame (e.g. the IMA SDK iframe). */
function inAdFrame(state: TabMediaState, frameId: number): boolean {
  if (frameId === 0) return false;
  return [frameId, ...frameAncestors(state, frameId)].some((id) => id !== 0 && isAdUrl(frameUrl(state, id) ?? ''));
}

/** Best "main" video among several: playing first, then recently played, then visible, then biggest. */
function preferVideo(a: FrameVideo | undefined, b: FrameVideo): FrameVideo {
  if (!a) return b;
  if (a.paused !== b.paused) return a.paused ? b : a;
  if ((a.lastPlayedAt ?? 0) !== (b.lastPlayedAt ?? 0)) return (a.lastPlayedAt ?? 0) > (b.lastPlayedAt ?? 0) ? a : b;
  if (a.visible !== b.visible) return a.visible ? a : b;
  return a.width * a.height >= b.width * b.height ? a : b;
}

export function mediaSourceDetected(state: TabMediaState): boolean {
  return allVideos(state).some((v) => v.isBlob);
}

// ---------------------------------------------------------------- ranking

const MIN_SIZE_BYTES = 200 * 1024;
const RECENT_PLAY_MS = 2 * 60_000;

function hostOf(url: string | undefined): string | undefined {
  return url ? safeUrl(url)?.hostname : undefined;
}

function baseCandidate(state: TabMediaState, frameId: number, url: string): Pick<
  RankedCandidate,
  'frameId' | 'embedded' | 'frameHost' | 'label' | 'score' | 'reasons' | 'codecs' | 'drmHint' | 'live' | 'isAd'
> {
  return {
    frameId,
    embedded: frameId !== 0,
    frameHost: hostOf(frameUrl(state, frameId)),
    label: labelForUrl(url),
    score: 0,
    reasons: [],
    codecs: [],
    drmHint: [],
    live: false,
    isAd: isAdUrl(url) || inAdFrame(state, frameId),
  };
}

/**
 * Merges network observations, DOM <video> elements and manifest knowledge into a ranked list
 * of castable streams. Segments, variant playlists of a known master, blob: URLs, tiny files and
 * requests that failed for the page itself are excluded. Highest score first; ties are broken by
 * recency, then URL, so the order is fully deterministic.
 */
export function rankCandidates(state: TabMediaState, now = Date.now()): RankedCandidate[] {
  const videos = allVideos(state);
  const manifests = state.manifests ?? {};

  // Manifest knowledge is keyed by candidate id; index it by dedupe key so re-signed URLs share it.
  const manifestByKey = new Map<string, ManifestSummary>();
  const childKeys = new Set<string>();
  for (const [id, summary] of Object.entries(manifests)) {
    const c = state.candidates[id];
    if (c) manifestByKey.set(dedupeKey(c.url), summary);
    for (const key of summary.childKeys) childKeys.add(key);
  }

  const network = dedupeCandidates(Object.values(state.candidates).filter((c) => c.kind !== 'segment'));
  const items = new Map<string, RankedCandidate>();
  const aliases = new Map<string, string>();

  // Earliest HLS playlist per frame: players request the master playlist before variants.
  const firstHls = new Map<number, number>();
  for (const c of network) {
    if (c.kind === 'hls') firstHls.set(c.frameId, Math.min(firstHls.get(c.frameId) ?? Infinity, c.firstSeen));
  }

  for (const c of network) {
    const key = dedupeKey(c.url);
    if (c.kind === 'hls' && childKeys.has(key)) continue; // a variant/rendition of a known master
    const manifest = manifestByKey.get(key);
    const failed = c.lastStatus !== undefined && c.lastStatus >= 400;
    const ranked: RankedCandidate = {
      ...baseCandidate(state, c.frameId, c.url),
      id: c.id,
      url: c.url,
      kind: c.kind,
      container: c.container,
      audioOnly: c.audioOnly,
      mimeType: c.mimeType,
      origin: 'network',
      totalSize: c.totalSize,
      lastSeen: c.lastSeen,
      manifest,
      lastStatus: failed ? c.lastStatus : undefined,
      codecs: manifest?.codecs ?? [],
    };
    if (c.initiator && isAdUrl(c.initiator)) ranked.isAd = true;
    if (c.kind === 'hls' && firstHls.get(c.frameId) === c.firstSeen) {
      ranked.score += 10;
      ranked.reasons.push('first playlist requested (likely master)');
    }
    items.set(key, ranked);
    if (c.finalUrl) aliases.set(dedupeKey(c.finalUrl), key);
  }

  // DOM videos with directly playable URLs (not blob:).
  for (const video of videos) {
    const urls = video.src ? [video.src] : video.sources;
    for (const url of urls) {
      if (!/^https?:/i.test(url)) continue;
      const directKey = dedupeKey(url);
      const key = aliases.get(directKey) ?? directKey;
      const existing = items.get(key);
      if (existing) {
        existing.video = preferVideo(existing.video as FrameVideo | undefined, video);
        continue;
      }
      const cls = classifyMedia(url) ?? { kind: 'progressive', container: 'unknown', audioOnly: false };
      if (cls.kind === 'segment') continue;
      items.set(key, {
        ...baseCandidate(state, video.frameId, url),
        id: `d:${hashString(url)}`,
        url,
        kind: cls.kind,
        container: cls.container,
        audioOnly: cls.audioOnly,
        origin: 'dom',
        video,
        lastSeen: video.lastPlayedAt ?? 0,
      });
    }
  }

  // Manifests feeding a MediaSource (blob:) player in the same frame, or a parent/child frame.
  const blobPlayers = videos.filter((v) => v.isBlob);
  for (const item of items.values()) {
    if (item.video || (item.kind !== 'hls' && item.kind !== 'dash')) continue;
    let best: { player: FrameVideo; distance: number } | undefined;
    for (const player of blobPlayers) {
      const distance = frameDistance(state, item.frameId, player.frameId);
      if (distance === Infinity) continue;
      if (!best || distance < best.distance || (distance === best.distance && preferVideo(best.player, player) === player)) {
        best = { player, distance };
      }
    }
    if (best) {
      item.video = best.player;
      item.reasons.push(best.distance === 0 ? 'same frame as the MediaSource player' : 'nested frame of the MediaSource player');
    }
  }

  const result: RankedCandidate[] = [];
  for (const item of items.values()) {
    if (item.totalSize !== undefined && item.totalSize < MIN_SIZE_BYTES && item.kind === 'progressive') continue;
    // The page's own request failed and no player references it: nothing to cast.
    if (item.lastStatus !== undefined && !item.video) continue;
    enrich(state, item);
    score(state, item, now);
    result.push(item);
  }
  return result.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen || a.url.localeCompare(b.url));
}

function enrich(state: TabMediaState, item: RankedCandidate): void {
  const video = item.video as FrameVideo | undefined;
  if (item.codecs.length === 0 && video?.mseMimeTypes.length) {
    item.codecs = [...new Set(video.mseMimeTypes.flatMap(codecsFromMime))];
  }
  const frameId = video?.frameId ?? item.frameId;
  item.drmHint = state.frames[String(frameId)]?.emeKeySystems ?? [];
  if (video) item.videoFrameId = video.frameId;
  item.live = item.manifest?.live ?? video?.live ?? false;
  item.quality = qualityLabel(item.manifest?.maxHeight) ?? qualityLabel(video?.videoHeight);
}

function score(state: TabMediaState, item: RankedCandidate, now: number): void {
  const add = (points: number, reason: string) => {
    item.score += points;
    item.reasons.push(reason);
  };

  if (item.kind === 'hls') add(30, 'HLS stream');
  else if (item.kind === 'dash') add(30, 'DASH stream');
  else if (item.kind === 'progressive') add(15, 'progressive file');

  const m = item.manifest;
  if (m) {
    if (m.role === 'master') add(15, `master playlist (${m.variantCount} qualities)`);
    if (m.live === false && m.duration !== undefined && m.duration > 0 && m.duration < 45) add(-20, 'short stream (ad?)');
    if (!m.valid && m.reachable && (m.status ?? 200) < 400) add(-20, 'not a valid manifest');
  }

  const v = item.video;
  if (v) {
    const isDirect = !v.isBlob && (v.src === item.url || v.sources.includes(item.url));
    if (!v.paused && !v.ended) add(60, 'currently playing');
    else if (v.lastPlayedAt && now - v.lastPlayedAt < RECENT_PLAY_MS) add(30, 'recently played');
    if (v.width * v.height >= 640 * 360) add(10, 'large player');
    else if (v.width > 0 && v.width < 300) add(-15, 'small player');
    if (v.visible) add(5, 'visible');
    if (!v.live && v.duration !== null && v.duration > 0 && v.duration < 45) add(-20, 'short clip (ad or preview?)');
    if (isDirect && v.error !== null) add(-40, 'the page player failed to load it');
  }
  if (item.quality) {
    const height = item.manifest?.maxHeight ?? v?.videoHeight ?? 0;
    add(Math.min(Math.floor(height / 360) * 2, 8), 'resolution');
  }

  if (item.isAd) add(-80, 'advertisement');
  if (item.audioOnly) add(-40, 'audio only');
  if (item.lastStatus !== undefined) add(-40, `page request failed (HTTP ${item.lastStatus})`);
  if (item.totalSize !== undefined) {
    if (item.totalSize < 2 * 1024 * 1024) add(-40, 'tiny file');
    else if (item.totalSize > 50 * 1024 * 1024) add(10, 'large file');
  }
  if (item.kind === 'hls' && !m) {
    if (/master|index|playlist|manifest/i.test(item.label)) add(5, 'master-like name');
    if (/chunklist|media_|_\d{3,4}p|^\d{3,4}p?\./i.test(item.label)) add(-5, 'variant-like name');
  }
  if (item.container === 'mkv' || item.container === 'flv' || item.container === 'avi') {
    add(-10, 'container may need transcoding');
  }
  if (state.navigatedAt && item.lastSeen < state.navigatedAt && (!v || v.paused)) {
    add(-30, 'from before the page navigated');
  }
  if (now - item.lastSeen < 30_000) add(5, 'seen recently');
}

/** The candidate Castit pre-selects: best-ranked non-ad stream, else the best overall. */
export function selectMainCandidate<T extends RankedCandidate>(ranked: T[]): T | undefined {
  return ranked.find((c) => !c.isAd) ?? ranked[0];
}
