import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../../apps/extension/src/lib/media-types.ts';
import {
  clearFrame,
  descendantFrames,
  emptyTabState,
  normalizeTabState,
  recordFrameReport,
  recordManifest,
  recordNetworkMedia,
  recordSubframeNavigation,
} from '../../apps/extension/src/lib/store.ts';
import { video } from './helpers.ts';

const mp4 = classifyMedia('https://e.com/a.mp4')!;
const hls = classifyMedia('https://e.com/a.m3u8')!;

describe('frame tree', () => {
  it('clears a navigating frame together with all frames nested inside it', () => {
    const state = emptyTabState(1);
    recordSubframeNavigation(state, 2, 0, 'https://site.e.com/embed');
    recordSubframeNavigation(state, 5, 2, 'https://player.e.net/');
    recordSubframeNavigation(state, 6, 5, 'https://ads.e.org/');
    recordSubframeNavigation(state, 8, 0, 'https://chat.e.com/');
    recordNetworkMedia(state, { url: 'https://cdn.e.net/a.m3u8', classification: hls, frameId: 5 }, 1);
    recordNetworkMedia(state, { url: 'https://cdn.e.com/b.mp4', classification: mp4, frameId: 8 }, 1);
    recordFrameReport(state, 5, { url: 'https://player.e.net/', isTop: false, videos: [video()] }, 1);
    recordManifest(state, Object.values(state.candidates)[0]!.id, {
      kind: 'hls', inspectedAt: 1, reachable: true, cors: true, valid: true, variantCount: 0, audioTracks: 0,
      subtitleTracks: 0, codecs: [], encryption: 'none', drmSystems: [], childKeys: [],
    });

    expect(descendantFrames(state, 2).sort()).toEqual([5, 6]);

    // Frame 2 navigates again: 5 and 6 are gone, 2 is re-registered, 8 is untouched.
    recordSubframeNavigation(state, 2, 0, 'https://site.e.com/embed2');
    expect(Object.keys(state.frameTree).sort()).toEqual(['2', '8']);
    expect(state.frames['5']).toBeUndefined();
    expect(Object.values(state.candidates).map((c) => c.url)).toEqual(['https://cdn.e.com/b.mp4']);
    expect(state.manifests).toEqual({});
  });

  it('clearFrame reports no change for unknown frames', () => {
    expect(clearFrame(emptyTabState(1), 42)).toBe(false);
  });
});

describe('failed responses and redirects', () => {
  it('records status and final URL', () => {
    const state = emptyTabState(1);
    recordNetworkMedia(state, { url: 'https://e.com/a.mp4', classification: mp4, frameId: 0, status: 403 }, 1);
    recordNetworkMedia(
      state,
      { url: 'https://e.com/a.mp4', finalUrl: 'https://cdn.e.com/a.mp4', classification: mp4, frameId: 0, status: 206, totalSize: 10 },
      2,
    );
    expect(Object.values(state.candidates)[0]).toMatchObject({ lastStatus: 206, finalUrl: 'https://cdn.e.com/a.mp4', totalSize: 10 });
  });

  it('upgrades state stored by Phase 1', () => {
    const old = { tabId: 1, candidates: {}, frames: {} } as unknown as Parameters<typeof normalizeTabState>[0];
    expect(normalizeTabState(old)).toMatchObject({ frameTree: {}, manifests: {} });
  });

  it('frames that only report EME use are kept', () => {
    const state = emptyTabState(1);
    expect(recordFrameReport(state, 3, { url: 'https://p.e.com', isTop: false, videos: [], emeKeySystems: ['com.widevine.alpha'] }, 1)).toBe(true);
  });
});
