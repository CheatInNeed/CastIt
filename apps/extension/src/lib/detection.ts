// DOM-side video detection helpers used by the content script.
import type { VideoElementInfo } from '@castit/shared';

const keys = new WeakMap<HTMLVideoElement, string>();
const lastPlayed = new WeakMap<HTMLVideoElement, number>();
let counter = 0;

export function videoKey(video: HTMLVideoElement): string {
  let key = keys.get(video);
  if (!key) {
    key = `v${++counter}`;
    keys.set(video, key);
  }
  return key;
}

export function markPlayed(video: HTMLVideoElement): void {
  lastPlayed.set(video, Date.now());
}

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return undefined;
  }
}

/** Open or closed shadow root of an element. Content scripts may read closed roots via chrome.dom. */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: HTMLElement) => ShadowRoot | null } } })
    .chrome?.dom;
  try {
    return dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? el.shadowRoot;
  } catch {
    return el.shadowRoot;
  }
}

export interface FoundVideo {
  video: HTMLVideoElement;
  inShadowRoot: boolean;
}

/**
 * Finds <video> elements in `root`. With `deep`, also descends into (open or closed) shadow
 * roots and reports every shadow root found via `onShadowRoot`.
 */
export function findVideos(
  root: Document | ShadowRoot,
  deep: boolean,
  onShadowRoot?: (root: ShadowRoot) => void,
  inShadowRoot = false,
): FoundVideo[] {
  const found: FoundVideo[] = Array.from(root.querySelectorAll('video'), (video) => ({ video, inShadowRoot }));
  if (!deep) return found;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = shadowRootOf(el);
    if (!shadow) continue;
    onShadowRoot?.(shadow);
    found.push(...findVideos(shadow, true, onShadowRoot, true));
  }
  return found;
}

export interface DescribeContext {
  inShadowRoot?: boolean;
  /** SourceBuffer types for this video's MediaSource, when known. */
  mseMimeTypes?: string[];
  viewport?: { width: number; height: number };
}

export function describeVideo(video: HTMLVideoElement, ctx: DescribeContext = {}): VideoElementInfo {
  const src = absolute(video.currentSrc) ?? absolute(video.getAttribute('src'));
  const sources = Array.from(video.querySelectorAll('source'))
    .map((s) => absolute(s.getAttribute('src')))
    .filter((s): s is string => !!s);
  const rect = video.getBoundingClientRect();
  const viewport = ctx.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const duration = Number.isFinite(video.duration) ? video.duration : null;
  return {
    key: videoKey(video),
    src,
    sources,
    isBlob: !!src?.startsWith('blob:') || (!!(video as HTMLVideoElement & { srcObject?: unknown }).srcObject && !src),
    paused: video.paused,
    ended: video.ended,
    currentTime: video.currentTime || 0,
    duration: duration && duration > 0 ? duration : null,
    live: video.duration === Infinity,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    poster: absolute(video.poster || null),
    muted: video.muted,
    readyState: video.readyState,
    lastPlayedAt: lastPlayed.get(video),
    error: video.error?.code ?? null,
    visible:
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width,
    inShadowRoot: ctx.inShadowRoot ?? false,
    mseMimeTypes: ctx.mseMimeTypes ?? [],
  };
}

/** Videos worth reporting: those with a source, that have played, or that failed to load. */
export function isReportable(v: HTMLVideoElement): boolean {
  return !!(v.currentSrc || v.getAttribute('src') || v.querySelector('source') || !v.paused || lastPlayed.has(v) || v.error);
}

/** Pauses the given playing videos; returns how many were paused. */
export function pauseAll(videos: HTMLVideoElement[]): number {
  let paused = 0;
  for (const video of videos) {
    if (!video.paused) {
      video.pause();
      paused++;
    }
  }
  return paused;
}
