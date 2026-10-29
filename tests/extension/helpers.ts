import type { RankedCandidate, TabMediaState, VideoElementInfo } from '@castit/shared';
import { classifyMedia } from '../../apps/extension/src/lib/media-types.ts';
import { emptyTabState, recordFrameReport, recordNetworkMedia } from '../../apps/extension/src/lib/store.ts';

export const NOW = 1_700_000_000_000;

export function video(overrides: Partial<VideoElementInfo> = {}): VideoElementInfo {
  return {
    key: 'v1',
    sources: [],
    isBlob: false,
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 3600,
    live: false,
    width: 1280,
    height: 720,
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    readyState: 4,
    error: null,
    visible: true,
    inShadowRoot: false,
    mseMimeTypes: [],
    ...overrides,
  };
}

export function stateWith(
  network: Array<{
    url: string;
    frameId?: number;
    at?: number;
    contentType?: string;
    totalSize?: number;
    status?: number;
    finalUrl?: string;
    initiator?: string;
  }>,
  frames: Array<{ frameId: number; videos: VideoElementInfo[]; isTop?: boolean; url?: string; emeKeySystems?: string[] }> = [],
): TabMediaState {
  const state = emptyTabState(1, 'https://site.example/watch');
  for (const n of network) {
    const classification = classifyMedia(n.url, n.contentType);
    if (!classification) throw new Error(`not media: ${n.url}`);
    recordNetworkMedia(
      state,
      {
        url: n.url,
        classification,
        frameId: n.frameId ?? 0,
        totalSize: n.totalSize,
        status: n.status,
        finalUrl: n.finalUrl,
        initiator: n.initiator,
      },
      n.at ?? NOW - 60_000,
    );
  }
  for (const f of frames) {
    recordFrameReport(
      state,
      f.frameId,
      {
        url: f.url ?? 'https://player.example/embed',
        isTop: f.isTop ?? f.frameId === 0,
        videos: f.videos,
        emeKeySystems: f.emeKeySystems,
      },
      NOW,
    );
  }
  return state;
}

export function candidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    id: 'n:1',
    url: 'https://cdn.example.com/master.m3u8',
    kind: 'hls',
    container: 'unknown',
    audioOnly: false,
    origin: 'network',
    frameId: 0,
    label: 'master.m3u8',
    score: 0,
    reasons: [],
    lastSeen: NOW,
    isAd: false,
    embedded: false,
    live: false,
    codecs: [],
    drmHint: [],
    ...overrides,
  };
}
