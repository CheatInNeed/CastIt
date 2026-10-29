import { describe, expect, it } from 'vitest';
import {
  dedupeCandidates,
  dedupeKey,
  mediaSourceDetected,
  qualityLabel,
  rankCandidates,
  selectMainCandidate,
} from '../../apps/extension/src/lib/rank.ts';
import { NOW, stateWith, video } from './helpers.ts';

describe('dedupeKey', () => {
  it('ignores volatile signing / cache-busting params but keeps identifying ones', () => {
    expect(dedupeKey('https://cdn.e.com/v.m3u8?token=a&expires=1')).toBe(dedupeKey('https://cdn.e.com/v.m3u8?expires=2&token=b'));
    expect(dedupeKey('https://e.com/video?id=1')).not.toBe(dedupeKey('https://e.com/video?id=2'));
    expect(dedupeKey('https://E.com/v.mp4#t=10')).toBe('https://e.com/v.mp4');
  });
});

describe('dedupeCandidates', () => {
  it('keeps the most recent original URL (signed URLs are never rewritten)', () => {
    const state = stateWith([
      { url: 'https://cdn.e.com/v/master.m3u8?token=OLD', at: NOW - 50_000 },
      { url: 'https://cdn.e.com/v/master.m3u8?token=NEW', at: NOW - 1_000 },
    ]);
    const deduped = dedupeCandidates(Object.values(state.candidates));
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.url).toBe('https://cdn.e.com/v/master.m3u8?token=NEW');
    expect(deduped[0]!.hits).toBe(2);
  });
});

describe('rankCandidates', () => {
  it('excludes segments, tiny files and returns nothing for an empty tab', () => {
    expect(rankCandidates(stateWith([]), NOW)).toEqual([]);
    const state = stateWith([
      { url: 'https://cdn.e.com/seg-1.ts', contentType: 'video/mp2t' },
      { url: 'https://cdn.e.com/thumb-preview.mp4', totalSize: 50_000 },
    ]);
    expect(rankCandidates(state, NOW)).toEqual([]);
  });

  it('prefers the master playlist (requested first) over variant playlists', () => {
    const state = stateWith([
      { url: 'https://cdn.e.com/show/master.m3u8', at: NOW - 10_000 },
      { url: 'https://cdn.e.com/show/1080p/chunklist.m3u8', at: NOW - 9_000 },
    ]);
    const ranked = rankCandidates(state, NOW);
    expect(ranked[0]!.url).toBe('https://cdn.e.com/show/master.m3u8');
  });

  it('ranks the currently playing video above other streams', () => {
    const state = stateWith(
      [{ url: 'https://cdn.e.com/trailer.mp4', totalSize: 80_000_000 }],
      [{ frameId: 0, videos: [video({ src: 'https://cdn.e.com/movie.mp4', paused: false })] }],
    );
    const ranked = rankCandidates(state, NOW);
    expect(ranked[0]!.url).toBe('https://cdn.e.com/movie.mp4');
    expect(ranked[0]!.origin).toBe('dom');
    expect(ranked[0]!.quality).toBe('1080p');
    expect(ranked[0]!.reasons).toContain('currently playing');
  });

  it('merges a DOM video with the network request for the same URL', () => {
    const state = stateWith(
      [{ url: 'https://cdn.e.com/movie.mp4', totalSize: 900_000_000 }],
      [{ frameId: 0, videos: [video({ src: 'https://cdn.e.com/movie.mp4', paused: false })] }],
    );
    const ranked = rankCandidates(state, NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.origin).toBe('network');
    expect(ranked[0]!.video?.paused).toBe(false);
  });

  it('associates manifests with a MediaSource player in the same (embedded) frame', () => {
    const state = stateWith(
      [
        { url: 'https://ads.e.com/ads/preroll.m3u8', frameId: 0 },
        { url: 'https://player-cdn.e.net/hls/master.m3u8', frameId: 7 },
      ],
      [{ frameId: 7, videos: [video({ src: 'blob:https://player.e.net/1', isBlob: true, paused: false })] }],
    );
    const ranked = rankCandidates(state, NOW);
    expect(ranked[0]!.url).toBe('https://player-cdn.e.net/hls/master.m3u8');
    expect(ranked[0]!.reasons).toContain('same frame as the MediaSource player');
    expect(ranked.find((c) => c.isAd)?.url).toBe('https://ads.e.com/ads/preroll.m3u8');
    expect(mediaSourceDetected(state)).toBe(true);
  });

  it('demotes short clips and advertisements', () => {
    const state = stateWith(
      [],
      [
        {
          frameId: 0,
          videos: [
            video({ key: 'ad', src: 'https://cdn.e.com/promo.mp4', duration: 15, paused: false, width: 250, height: 140 }),
            video({ key: 'main', src: 'https://cdn.e.com/episode.mp4', lastPlayedAt: NOW - 30_000 }),
          ],
        },
      ],
    );
    expect(rankCandidates(state, NOW)[0]!.url).toBe('https://cdn.e.com/episode.mp4');
  });

  it('is deterministic for equal scores', () => {
    const state = stateWith([
      { url: 'https://b.e.com/x.mp4', at: NOW - 100_000 },
      { url: 'https://a.e.com/x.mp4', at: NOW - 100_000 },
    ]);
    expect(rankCandidates(state, NOW).map((c) => c.url)).toEqual(['https://a.e.com/x.mp4', 'https://b.e.com/x.mp4']);
  });
});

describe('selectMainCandidate', () => {
  it('skips advertisements when another candidate exists', () => {
    const state = stateWith([
      { url: 'https://pubads.g.doubleclick.net/x/ad.mp4', at: NOW - 1000 },
      { url: 'https://cdn.e.com/show.mp4', at: NOW - 100_000 },
    ]);
    expect(selectMainCandidate(rankCandidates(state, NOW))?.url).toBe('https://cdn.e.com/show.mp4');
  });
});

describe('qualityLabel', () => {
  it('formats heights', () => {
    expect(qualityLabel(720)).toBe('720p');
    expect(qualityLabel(2160)).toBe('4K');
    expect(qualityLabel(0)).toBeUndefined();
  });
});
