import { describe, expect, it } from 'vitest';
import { assessCastability } from '../../apps/extension/src/lib/castability.ts';
import { parseDash, parseHls } from '../../apps/extension/src/lib/manifests.ts';
import { buildCastRequest, resumePosition } from '../../apps/extension/src/lib/cast-request.ts';
import {
  DASH_LIVE_WIDEVINE,
  HLS_FAIRPLAY,
  HLS_MASTER,
  HLS_MEDIA_FMP4_LIVE,
  HLS_MEDIA_TS_VOD,
} from '../fixtures/manifests.ts';
import { candidate, video } from './helpers.ts';

describe('assessCastability', () => {
  it('rates plain HLS/MP4 as likely without a probe', () => {
    expect(assessCastability(candidate()).level).toBe('likely');
    expect(assessCastability(candidate({ kind: 'progressive', container: 'mp4' })).level).toBe('likely');
  });

  it('blocks containers the receiver cannot play', () => {
    const result = assessCastability(candidate({ kind: 'progressive', container: 'flv' }));
    expect(result.level).toBe('unsupported');
    expect(result.blocker?.code).toBe('UNSUPPORTED_CONTAINER');
  });

  it('reports expired URLs specifically', () => {
    const result = assessCastability(candidate(), { reachable: true, status: 410, cors: null });
    expect(result.blocker?.code).toBe('STREAM_UNAVAILABLE');
  });

  it('warns (but does not block) on 403', () => {
    const result = assessCastability(candidate(), { reachable: true, status: 403, cors: null });
    expect(result.level).toBe('unlikely');
    expect(result.blocker).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/authentication required/);
  });

  it('blocks DRM-protected HLS and DASH', () => {
    const hls = parseHls(HLS_FAIRPLAY, 'https://e.com/a.m3u8')!;
    expect(assessCastability(candidate(), { reachable: true, status: 200, cors: '*', hls, hlsMedia: hls }).blocker?.code).toBe('DRM');
    const dash = parseDash(DASH_LIVE_WIDEVINE)!;
    const result = assessCastability(candidate({ kind: 'dash' }), { reachable: true, status: 200, cors: '*', dash });
    expect(result.blocker?.code).toBe('DRM');
    expect(result.blocker?.message).toContain('Widevine');
  });

  it('downgrades HLS without CORS headers', () => {
    const hls = parseHls(HLS_MASTER, 'https://e.com/m.m3u8')!;
    const result = assessCastability(candidate(), { reachable: true, status: 200, cors: null, hls });
    expect(result.level).toBe('possible');
    expect(result.notes.join(' ')).toMatch(/CORS/);
  });

  it('flags invalid manifests', () => {
    const result = assessCastability(candidate(), { reachable: true, status: 200, cors: '*' });
    expect(result.level).toBe('unlikely');
  });
});

describe('buildCastRequest', () => {
  it('builds a buffered TS HLS request with resume position and metadata', () => {
    const media = parseHls(HLS_MEDIA_TS_VOD, 'https://e.com/360p/index.m3u8')!;
    const c = candidate({
      url: 'https://cdn.e.com/master.m3u8?token=abc',
      video: video({ currentTime: 120.7, duration: 3600, poster: 'https://e.com/p.jpg' }),
    });
    const req = buildCastRequest(c, { reachable: true, status: 200, cors: '*', hlsMedia: media }, { title: 'Show S1E1', url: 'https://site.example/watch/1' }, 'r1', 9);
    expect(req).toMatchObject({
      url: 'https://cdn.e.com/master.m3u8?token=abc',
      contentType: 'application/x-mpegurl',
      streamType: 'BUFFERED',
      hlsSegmentFormat: 'ts',
      hlsVideoSegmentFormat: 'mpeg2_ts',
      title: 'Show S1E1',
      subtitle: 'site.example',
      posterUrl: 'https://e.com/p.jpg',
      startTime: 120,
      duration: 3600,
      sourceTabId: 9,
      engine: 'direct',
    });
  });

  it('builds a live fMP4 request without resume position', () => {
    const media = parseHls(HLS_MEDIA_FMP4_LIVE, 'https://e.com/live.m3u8')!;
    const req = buildCastRequest(candidate({ video: video({ currentTime: 500, live: true, duration: null }) }), { reachable: true, cors: '*', hlsMedia: media }, {}, 'r2', 1);
    expect(req.streamType).toBe('LIVE');
    expect(req.hlsSegmentFormat).toBe('fmp4');
    expect(req.startTime).toBeUndefined();
    expect(req.duration).toBeUndefined();
    expect(req.title).toBe('master.m3u8');
  });

  it('resumes only away from the start and end', () => {
    expect(resumePosition(2, 100)).toBeUndefined();
    expect(resumePosition(95, 100)).toBeUndefined();
    expect(resumePosition(50.9, 100)).toBe(50);
    expect(resumePosition(50, null)).toBe(50);
  });
});
