import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../../apps/extension/src/lib/media-types.ts';
import {
  clearFrame,
  emptyTabState,
  MAX_CANDIDATES_PER_TAB,
  recordFrameReport,
  recordNetworkMedia,
} from '../../apps/extension/src/lib/store.ts';
import { video } from './helpers.ts';

const mp4 = classifyMedia('https://e.com/a.mp4')!;

describe('tab store', () => {
  it('records and refreshes network candidates', () => {
    const state = emptyTabState(1);
    recordNetworkMedia(state, { url: 'https://e.com/a.mp4', classification: mp4, frameId: 0 }, 1000);
    recordNetworkMedia(state, { url: 'https://e.com/a.mp4', classification: mp4, frameId: 0, totalSize: 99 }, 2000);
    const [c] = Object.values(state.candidates);
    expect(c).toMatchObject({ firstSeen: 1000, lastSeen: 2000, hits: 2, totalSize: 99 });
  });

  it('caps candidates per tab, evicting the oldest', () => {
    const state = emptyTabState(1);
    for (let i = 0; i <= MAX_CANDIDATES_PER_TAB; i++) {
      recordNetworkMedia(state, { url: `https://e.com/${i}.mp4`, classification: mp4, frameId: 0 }, i);
    }
    const urls = Object.values(state.candidates).map((c) => c.url);
    expect(urls).toHaveLength(MAX_CANDIDATES_PER_TAB);
    expect(urls).not.toContain('https://e.com/0.mp4');
  });

  it('ignores empty reports from frames that never had videos', () => {
    const state = emptyTabState(1);
    expect(recordFrameReport(state, 3, { url: 'https://ads.e.com', isTop: false, videos: [] }, 1)).toBe(false);
    expect(recordFrameReport(state, 0, { url: 'https://e.com/w', isTop: true, videos: [video()] }, 1)).toBe(true);
    expect(state.pageUrl).toBe('https://e.com/w');
    // Once a frame had videos, an empty report is meaningful (player removed).
    expect(recordFrameReport(state, 0, { url: 'https://e.com/w', isTop: true, videos: [] }, 2)).toBe(true);
  });

  it('clears a navigated frame and the media it requested', () => {
    const state = emptyTabState(1);
    recordNetworkMedia(state, { url: 'https://e.com/a.mp4', classification: mp4, frameId: 5 }, 1);
    recordNetworkMedia(state, { url: 'https://e.com/b.mp4', classification: mp4, frameId: 0 }, 1);
    recordFrameReport(state, 5, { url: 'https://p.e.com', isTop: false, videos: [video()] }, 1);
    expect(clearFrame(state, 5)).toBe(true);
    expect(Object.values(state.candidates).map((c) => c.url)).toEqual(['https://e.com/b.mp4']);
    expect(state.frames['5']).toBeUndefined();
    expect(clearFrame(state, 5)).toBe(false);
  });
});
