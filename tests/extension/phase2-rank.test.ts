// Phase 2: ranking with manifest knowledge, frame trees, redirects, failures and navigation.
import { describe, expect, it } from 'vitest';
import { assessCastability } from '../../apps/extension/src/lib/castability.ts';
import { parseHls } from '../../apps/extension/src/lib/manifests.ts';
import { summarizeManifest } from '../../apps/extension/src/lib/probe.ts';
import { codecsFromMime, frameDistance, isPrimaryCandidate, rankCandidates } from '../../apps/extension/src/lib/rank.ts';
import {
  networkCandidateId,
  recordManifest,
  recordSoftNavigation,
  recordSubframeNavigation,
} from '../../apps/extension/src/lib/store.ts';
import { DASH_LIVE_WIDEVINE, HLS_MASTER, HLS_MEDIA_TS_VOD } from '../fixtures/manifests.ts';
import { NOW, stateWith, video } from './helpers.ts';

const MASTER = 'https://cdn.e.com/show/master.m3u8?sig=1';

function masterSummary() {
  const hls = parseHls(HLS_MASTER, MASTER)!;
  const media = parseHls(HLS_MEDIA_TS_VOD, 'https://cdn.e.com/show/360p/index.m3u8')!;
  return summarizeManifest('hls', { reachable: true, status: 200, cors: '*', hls, hlsMedia: media }, NOW);
}

describe('manifest-aware ranking', () => {
  it('hides variant playlists of an inspected master and shows its qualities', () => {
    const state = stateWith([
      { url: MASTER, at: NOW - 10_000 },
      { url: 'https://cdn.e.com/show/360p/index.m3u8', at: NOW - 9_000 },
      { url: 'https://cdn.e.com/show/1080p/index.m3u8?token=other', at: NOW - 8_000 },
    ]);
    recordManifest(state, networkCandidateId(MASTER), masterSummary());

    const ranked = rankCandidates(state, NOW);
    expect(ranked.map((c) => c.url)).toEqual([MASTER]);
    expect(ranked[0]!.quality).toBe('1080p');
    expect(ranked[0]!.codecs).toContain('avc1.640028');
    expect(ranked[0]!.reasons).toContain('master playlist (2 qualities)');
    expect(ranked[0]!.live).toBe(false);
  });

  it('summarizes master playlists for the popup', () => {
    const s = masterSummary();
    expect(s).toMatchObject({ role: 'master', variantCount: 2, audioTracks: 1, subtitleTracks: 1, cors: true, valid: true });
    expect(s.childKeys).toContain('https://cdn.e.com/show/audio/en.m3u8');
    expect(s.duration).toBeCloseTo(16.5);
  });

  it('blocks DRM known from inspection before the user clicks Cast', () => {
    const url = 'https://cdn.e.com/live.mpd';
    const state = stateWith([{ url }]);
    recordManifest(state, networkCandidateId(url), summarizeManifest('dash', { reachable: true, status: 200, cors: '*', dash: { live: true, encrypted: true, drmSystems: ['Widevine'], codecs: [] } }, NOW));
    const [c] = rankCandidates(state, NOW);
    expect(assessCastability(c!).blocker?.code).toBe('DRM');
    expect(DASH_LIVE_WIDEVINE).toContain('dynamic');
  });
});

describe('frames', () => {
  it('relates nested frames through the frame tree', () => {
    const state = stateWith([]);
    recordSubframeNavigation(state, 3, 0, 'https://site.example/embed');
    recordSubframeNavigation(state, 7, 3, 'https://player.example/iframe');
    expect(frameDistance(state, 7, 3)).toBe(1);
    expect(frameDistance(state, 7, 0)).toBe(1);
    expect(frameDistance(state, 3, 3)).toBe(0);
    recordSubframeNavigation(state, 9, 0, 'https://other.example/');
    expect(frameDistance(state, 7, 9)).toBe(Infinity);
  });

  it('associates a manifest with a MediaSource player in a nested frame and marks it embedded', () => {
    const state = stateWith(
      [
        { url: 'https://player-cdn.e.net/hls/master.m3u8', frameId: 3 },
        { url: 'https://unrelated.e.org/other.m3u8', frameId: 9, at: NOW - 1000 },
      ],
      [{ frameId: 7, url: 'https://player.e.net/inner', videos: [video({ src: 'blob:https://player.e.net/1', isBlob: true, paused: false })] }],
    );
    state.frameTree['3'] = { parentFrameId: 0, url: 'https://player.e.net/embed' };
    state.frameTree['7'] = { parentFrameId: 3, url: 'https://player.e.net/inner' };
    state.frameTree['9'] = { parentFrameId: 0, url: 'https://unrelated.e.org/' };

    const ranked = rankCandidates(state, NOW);
    expect(ranked[0]!.url).toBe('https://player-cdn.e.net/hls/master.m3u8');
    expect(ranked[0]!.reasons).toContain('nested frame of the MediaSource player');
    expect(ranked[0]!.embedded).toBe(true);
    expect(ranked[0]!.frameHost).toBe('player.e.net');
    expect(ranked.find((c) => c.url.includes('unrelated'))?.video).toBeUndefined();
  });

  it('treats streams from ad frames and ad initiators as ads', () => {
    const state = stateWith([
      { url: 'https://cdn.adnet.example/creative.mp4', frameId: 4, totalSize: 5_000_000 },
      { url: 'https://cdn.adnet.example/other.mp4', initiator: 'https://imasdk.googleapis.com', totalSize: 5_000_000 },
    ]);
    state.frameTree['4'] = { parentFrameId: 0, url: 'https://securepubads.g.doubleclick.net/frame' };
    expect(rankCandidates(state, NOW).every((c) => c.isAd)).toBe(true);
  });

  it('carries EME use and SourceBuffer codecs onto the associated stream', () => {
    const state = stateWith(
      [{ url: 'https://cdn.e.com/v.mpd' }],
      [
        {
          frameId: 0,
          emeKeySystems: ['com.widevine.alpha'],
          videos: [video({ src: 'blob:x', isBlob: true, paused: false, mseMimeTypes: ['video/mp4; codecs="hev1.1.6.L93.B0"'] })],
        },
      ],
    );
    const [c] = rankCandidates(state, NOW);
    expect(c!.drmHint).toEqual(['com.widevine.alpha']);
    expect(c!.codecs).toEqual(['hev1.1.6.L93.B0']);
    const assessment = assessCastability(c!);
    expect(assessment.level).toBe('unlikely');
    expect(assessment.notes.join(' ')).toMatch(/DRM/);
    expect(assessment.notes.join(' ')).toMatch(/HEVC/);
  });
});

describe('failures, redirects and navigation', () => {
  it('drops media the page failed to load unless a player references it, then explains why', () => {
    const dead = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    expect(rankCandidates(stateWith([{ url: dead, status: 403 }]), NOW)).toEqual([]);

    const state = stateWith([{ url: dead, status: 403 }], [{ frameId: 0, videos: [video({ src: dead, error: 4, videoHeight: 0 })] }]);
    const [c] = rankCandidates(state, NOW);
    expect(c!.lastStatus).toBe(403);
    expect(c!.reasons).toContain('the page player failed to load it');
    const assessment = assessCastability(c!);
    expect(assessment.level).toBe('unlikely');
    expect(assessment.notes.join(' ')).toMatch(/could not load this URL/);
    expect(assessment.notes.join(' ')).toMatch(/HTTP 403/);
  });

  it('a later successful response clears the failure', () => {
    const url = 'https://cdn.e.com/movie.mp4';
    const state = stateWith([
      { url, status: 403, at: NOW - 5000 },
      { url, status: 206, at: NOW - 1000, totalSize: 90_000_000 },
    ]);
    expect(rankCandidates(state, NOW)[0]!.lastStatus).toBeUndefined();
  });

  it('merges a DOM src with the redirected network response and keeps the original URL', () => {
    const original = 'https://archive.org/download/x/movie.mp4';
    const final = 'https://dn1.ca.archive.org/0/items/x/movie.mp4';
    const state = stateWith(
      [{ url: original, finalUrl: final, totalSize: 60_000_000 }],
      [{ frameId: 0, videos: [video({ src: original, paused: false })] }],
    );
    const ranked = rankCandidates(state, NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.url).toBe(original);
    expect(ranked[0]!.video?.paused).toBe(false);
  });

  it('demotes streams seen before an SPA navigation', () => {
    const state = stateWith([
      { url: 'https://cdn.e.com/old/master.m3u8', at: NOW - 20_000 },
      { url: 'https://cdn.e.com/new/master.m3u8', at: NOW - 2_000 },
    ]);
    expect(recordSoftNavigation(state, 'https://site.example/watch#comments', NOW - 15_000)).toBe(false);
    expect(recordSoftNavigation(state, 'https://site.example/watch/2', NOW - 10_000)).toBe(true);
    const ranked = rankCandidates(state, NOW);
    expect(ranked[0]!.url).toBe('https://cdn.e.com/new/master.m3u8');
    expect(ranked[1]!.reasons).toContain('from before the page navigated');
  });
});

describe('codecsFromMime', () => {
  it('parses SourceBuffer types', () => {
    expect(codecsFromMime('video/mp4; codecs="avc1.64001f, mp4a.40.2"')).toEqual(['avc1.64001f', 'mp4a.40.2']);
    expect(codecsFromMime('video/webm; codecs=vp9')).toEqual(['vp9']);
    expect(codecsFromMime('video/mp4')).toEqual([]);
  });
});

describe('numbered stream pieces', () => {
  const dash = (n: number) => `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_3840x2160_12000k/bbb_30fps_3840x2160_12000k_${n}.m4v`;

  it('hides DASH pieces like bbb_30fps_3840x2160_12000k_15.m4v (seen on the test page)', () => {
    const state = stateWith([
      { url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd', at: NOW - 20_000 },
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({ url: dash(n), contentType: 'video/mp4', totalSize: 5_000_000, at: NOW - 19_000 + n })),
      { url: 'https://media.w3.org/2010/05/sintel/trailer_hd.mp4', totalSize: 14_000_000 },
    ]);
    expect(rankCandidates(state, NOW).map((c) => c.label)).toEqual(['bbb_30fps.mpd', 'trailer_hd.mp4']);
  });

  it('keeps real separate videos: too few, far apart, or played by the page', () => {
    const ep = (n: number) => `https://cdn.e.com/show/episode${n}.mp4`;
    expect(rankCandidates(stateWith([{ url: ep(1), totalSize: 9e8 }, { url: ep(2), totalSize: 9e8 }]), NOW)).toHaveLength(2);
    expect(rankCandidates(stateWith([1, 40, 90].map((n) => ({ url: ep(n), totalSize: 9e8 }))), NOW)).toHaveLength(3);
    const played = stateWith(
      [1, 2, 3].map((n) => ({ url: ep(n), totalSize: 9e8 })),
      [{ frameId: 0, videos: [video({ src: ep(2), paused: false })] }],
    );
    expect(rankCandidates(played, NOW)).toHaveLength(3);
  });

  it('separates real videos from other stream files', () => {
    const state = stateWith(
      [{ url: 'https://cdn.e.com/master.m3u8' }, { url: 'https://cdn.e.com/preview.mp4', totalSize: 5e6 }],
      [{ frameId: 0, videos: [video({ src: 'https://cdn.e.com/movie.mp4' })] }],
    );
    const primary = rankCandidates(state, NOW).filter(isPrimaryCandidate).map((c) => c.label).sort();
    expect(primary).toEqual(['master.m3u8', 'movie.mp4']);
  });
});
