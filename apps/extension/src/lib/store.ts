// Pure reducers for per-tab media state. The background persists the result in
// chrome.storage.session so nothing depends on service-worker memory surviving.
import type {
  FrameReport,
  ManifestSummary,
  NetworkCandidate,
  TabMediaState,
  VideoElementInfo,
} from '@castit/shared';
import { hashString, type MediaClassification } from './media-types.ts';

export const MAX_CANDIDATES_PER_TAB = 150;

export function emptyTabState(tabId: number, pageUrl?: string): TabMediaState {
  return { tabId, pageUrl, candidates: {}, frames: {}, frameTree: {}, manifests: {} };
}

/** Fills fields added after a state object was stored (e.g. by an older extension version). */
export function normalizeTabState(state: TabMediaState): TabMediaState {
  state.frameTree ??= {};
  state.manifests ??= {};
  return state;
}

export interface ObservedMedia {
  /** URL the page asked for (start of any redirect chain). */
  url: string;
  /** URL that finally answered, when redirected. */
  finalUrl?: string;
  classification: MediaClassification;
  mimeType?: string;
  frameId: number;
  initiator?: string;
  totalSize?: number;
  status?: number;
}

export function networkCandidateId(url: string): string {
  return `n:${hashString(url)}`;
}

/** Adds or refreshes a network candidate. Mutates and returns `state`. */
export function recordNetworkMedia(state: TabMediaState, obs: ObservedMedia, now: number): TabMediaState {
  const id = networkCandidateId(obs.url);
  const existing = state.candidates[id];
  if (existing) {
    existing.lastSeen = now;
    existing.hits += 1;
    existing.lastStatus = obs.status ?? existing.lastStatus;
    if (obs.status === undefined || obs.status < 400) {
      existing.totalSize ??= obs.totalSize;
      existing.mimeType ??= obs.mimeType;
      existing.finalUrl = obs.finalUrl ?? existing.finalUrl;
    }
    return state;
  }
  const candidate: NetworkCandidate = {
    id,
    url: obs.url,
    kind: obs.classification.kind,
    container: obs.classification.container,
    audioOnly: obs.classification.audioOnly,
    mimeType: obs.mimeType,
    frameId: obs.frameId,
    initiator: obs.initiator,
    totalSize: obs.totalSize,
    finalUrl: obs.finalUrl,
    lastStatus: obs.status,
    firstSeen: now,
    lastSeen: now,
    hits: 1,
  };
  state.candidates[id] = candidate;

  const all = Object.values(state.candidates);
  if (all.length > MAX_CANDIDATES_PER_TAB) {
    all.sort((a, b) => a.lastSeen - b.lastSeen);
    for (const old of all.slice(0, all.length - MAX_CANDIDATES_PER_TAB)) removeCandidate(state, old.id);
  }
  return state;
}

function removeCandidate(state: TabMediaState, id: string): void {
  delete state.candidates[id];
  delete state.manifests[id];
}

/** Stores a frame's <video> snapshot. Returns false when nothing meaningful changed. */
export function recordFrameReport(
  state: TabMediaState,
  frameId: number,
  report: { url: string; title?: string; isTop: boolean; videos: VideoElementInfo[]; emeKeySystems?: string[] },
  now: number,
): boolean {
  const key = String(frameId);
  const previous = state.frames[key];
  const emeKeySystems = report.emeKeySystems ?? [];
  if (!previous && report.videos.length === 0 && emeKeySystems.length === 0) return false;
  const next: FrameReport = { frameId, ...report, emeKeySystems, updatedAt: now };
  state.frames[key] = next;
  if (report.isTop) state.pageUrl = report.url;
  return true;
}

/** All frame ids below `frameId` in the known frame tree. */
export function descendantFrames(state: TabMediaState, frameId: number): number[] {
  const out: number[] = [];
  const queue = [frameId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [id, node] of Object.entries(state.frameTree)) {
      const child = Number(id);
      if (node.parentFrameId === parent && child !== frameId && !out.includes(child)) {
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * Forgets a (sub)frame that navigated away, and every frame nested inside it:
 * their videos and the media they requested.
 */
export function clearFrame(state: TabMediaState, frameId: number): boolean {
  let changed = false;
  for (const id of [frameId, ...descendantFrames(state, frameId)]) {
    const key = String(id);
    if (key in state.frames) changed = true;
    delete state.frames[key];
    if (id !== frameId && key in state.frameTree) {
      delete state.frameTree[key];
      changed = true;
    }
    for (const candidate of Object.values(state.candidates)) {
      if (candidate.frameId === id) {
        removeCandidate(state, candidate.id);
        changed = true;
      }
    }
  }
  return changed;
}

/** A sub-frame starts loading `url`: clear what it had and remember where it sits in the tree. */
export function recordSubframeNavigation(state: TabMediaState, frameId: number, parentFrameId: number, url: string): void {
  clearFrame(state, frameId);
  state.frameTree[String(frameId)] = { parentFrameId, url };
}

/** The top document changed URL without a reload (history API). */
export function recordSoftNavigation(state: TabMediaState, url: string, now: number): boolean {
  const strip = (u: string | undefined) => (u ?? '').split('#')[0];
  if (!state.pageUrl || strip(state.pageUrl) === strip(url)) {
    state.pageUrl ??= url;
    return false;
  }
  state.pageUrl = url;
  state.navigatedAt = now;
  return true;
}

export function recordManifest(state: TabMediaState, candidateId: string, summary: ManifestSummary): boolean {
  if (!state.candidates[candidateId]) return false;
  state.manifests[candidateId] = summary;
  return true;
}
