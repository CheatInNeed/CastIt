import { describe, expect, it } from 'vitest';
import { castHlsFormats, parseDash, parseHls, parseIsoDuration } from '../../apps/extension/src/lib/manifests.ts';
import {
  DASH_LIVE_WIDEVINE,
  DASH_VOD,
  HLS_AES128,
  HLS_FAIRPLAY,
  HLS_MASTER,
  HLS_MEDIA_FMP4_LIVE,
  HLS_MEDIA_TS_VOD,
} from '../fixtures/manifests.ts';

describe('parseHls', () => {
  it('parses a master playlist and resolves variant URIs relative to the playlist', () => {
    const info = parseHls(HLS_MASTER, 'https://cdn.example.com/show/master.m3u8?sig=abc')!;
    expect(info.type).toBe('master');
    expect(info.live).toBe(false);
    expect(info.variants).toHaveLength(2);
    expect(info.variants[0]).toMatchObject({ uri: 'https://cdn.example.com/show/360p/index.m3u8', height: 360, bandwidth: 800000 });
    // The variant's own query string is preserved exactly.
    expect(info.variants[1]!.uri).toBe('https://cdn.example.com/show/1080p/index.m3u8?token=xyz');
    expect(info.variants[1]!.codecs).toBe('avc1.640028,mp4a.40.2');
    expect(info.audioRenditions).toBe(1);
    expect(info.subtitleRenditions).toBe(1);
  });

  it('parses a VOD TS media playlist', () => {
    const info = parseHls(HLS_MEDIA_TS_VOD, 'https://cdn.example.com/show/360p/index.m3u8')!;
    expect(info.type).toBe('media');
    expect(info.live).toBe(false);
    expect(info.segmentCount).toBe(3);
    expect(info.segmentFormat).toBe('ts');
    expect(info.totalDuration).toBeCloseTo(16.5);
    expect(info.firstSegmentUri).toBe('https://cdn.example.com/show/360p/seg-0.ts');
    expect(info.encryption).toBe('none');
  });

  it('detects live fMP4 playlists', () => {
    const info = parseHls(HLS_MEDIA_FMP4_LIVE, 'https://live.example.com/ch1/index.m3u8')!;
    expect(info.live).toBe(true);
    expect(info.segmentFormat).toBe('fmp4');
  });

  it('distinguishes AES-128 from DRM', () => {
    expect(parseHls(HLS_AES128, 'https://e.com/a.m3u8')!.encryption).toBe('aes-128');
    const drm = parseHls(HLS_FAIRPLAY, 'https://e.com/a.m3u8')!;
    expect(drm.encryption).toBe('drm');
    expect(drm.keyFormats).toEqual(['com.apple.streamingkeydelivery']);
  });

  it('rejects non-playlists', () => {
    expect(parseHls('<html></html>', 'https://e.com/')).toBeNull();
  });

  it('maps segment formats to Cast HLS properties', () => {
    expect(castHlsFormats(parseHls(HLS_MEDIA_FMP4_LIVE, 'https://e.com/')!)).toEqual({
      hlsSegmentFormat: 'fmp4',
      hlsVideoSegmentFormat: 'fmp4',
    });
    expect(castHlsFormats(parseHls(HLS_MEDIA_TS_VOD, 'https://e.com/')!)).toEqual({
      hlsSegmentFormat: 'ts',
      hlsVideoSegmentFormat: 'mpeg2_ts',
    });
    expect(castHlsFormats(undefined)).toEqual({});
  });
});

describe('parseDash', () => {
  it('parses a static MPD', () => {
    const info = parseDash(DASH_VOD)!;
    expect(info.live).toBe(false);
    expect(info.encrypted).toBe(false);
    expect(info.maxHeight).toBe(1080);
    expect(info.duration).toBeCloseTo(3723.5);
    expect(info.codecs).toContain('avc1.640028');
  });

  it('detects live and DRM-protected MPDs', () => {
    const info = parseDash(DASH_LIVE_WIDEVINE)!;
    expect(info.live).toBe(true);
    expect(info.encrypted).toBe(true);
    expect(info.drmSystems).toEqual(['Widevine']);
  });

  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT30S')).toBe(30);
    expect(parseIsoDuration('PT1M')).toBe(60);
    expect(parseIsoDuration('P1DT1H')).toBe(90000);
    expect(parseIsoDuration('nonsense')).toBeUndefined();
  });
});
