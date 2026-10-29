import { describe, expect, it } from 'vitest';
import {
  castContentType,
  classifyMedia,
  extensionOf,
  isAdUrl,
  isLikelySegmentUrl,
  labelForUrl,
  totalSizeFromHeaders,
} from '../../apps/extension/src/lib/media-types.ts';

describe('classifyMedia', () => {
  it('recognises manifests by extension even with generic content types', () => {
    expect(classifyMedia('https://cdn.example.com/v/master.m3u8?token=abc', 'text/plain')?.kind).toBe('hls');
    expect(classifyMedia('https://cdn.example.com/v/manifest.mpd', 'application/octet-stream')?.kind).toBe('dash');
  });

  it('recognises manifests by content type without an extension', () => {
    expect(classifyMedia('https://api.example.com/play?id=1', 'application/vnd.apple.mpegurl; charset=utf-8')?.kind).toBe('hls');
    expect(classifyMedia('https://api.example.com/play?id=1', 'application/dash+xml')?.kind).toBe('dash');
  });

  it('recognises URL hints such as Azure format=m3u8', () => {
    expect(classifyMedia('https://x.streaming.media.azure.net/abc/video.ism/manifest(format=m3u8-aapl)')?.kind).toBe('hls');
  });

  it('classifies progressive files', () => {
    expect(classifyMedia('https://example.com/movie.mp4', 'video/mp4')).toEqual({ kind: 'progressive', container: 'mp4', audioOnly: false });
    expect(classifyMedia('https://example.com/movie.webm')?.container).toBe('webm');
    expect(classifyMedia('https://example.com/song.mp3')?.audioOnly).toBe(true);
  });

  it('classifies segments', () => {
    expect(classifyMedia('https://cdn.example.com/hls/seg-00012.ts', 'video/mp2t')?.kind).toBe('segment');
    expect(classifyMedia('https://cdn.example.com/dash/chunk-stream0-00005.m4s')?.kind).toBe('segment');
    expect(classifyMedia('https://cdn.example.com/dash/init-stream0.mp4', 'video/mp4')?.kind).toBe('segment');
    expect(classifyMedia('https://cdn.example.com/v/12.mp4')?.kind).toBe('segment');
    expect(classifyMedia('https://rr1.example.com/videoplayback?itag=22&range=0-500000', 'video/mp4')?.kind).toBe('segment');
  });

  it('rejects non-media and non-http URLs', () => {
    expect(classifyMedia('https://example.com/page.html', 'text/html')).toBeNull();
    expect(classifyMedia('https://example.com/movie.mp4', 'text/html')).toBeNull();
    expect(classifyMedia('https://example.com/thumb.jpg', 'image/jpeg')).toBeNull();
    expect(classifyMedia('blob:https://example.com/123')).toBeNull();
    expect(classifyMedia('https://example.com/api', 'application/json')).toBeNull();
  });
});

describe('helpers', () => {
  it('extracts extensions from paths only', () => {
    expect(extensionOf('https://e.com/a/b.M3U8?x=1.mp4')).toBe('m3u8');
    expect(extensionOf('https://e.com/a/b')).toBeUndefined();
  });

  it('detects segment URLs', () => {
    expect(isLikelySegmentUrl('https://e.com/fragment_5.mp4')).toBe(true);
    expect(isLikelySegmentUrl('https://e.com/movie-part1.mp4')).toBe(false);
    expect(isLikelySegmentUrl('https://e.com/movie.mp4')).toBe(false);
  });

  it('maps Cast content types', () => {
    expect(castContentType('hls', 'unknown')).toBe('application/x-mpegurl');
    expect(castContentType('dash', 'unknown')).toBe('application/dash+xml');
    expect(castContentType('progressive', 'mp4')).toBe('video/mp4');
    expect(castContentType('progressive', 'mp4', true)).toBe('audio/mp4');
    expect(castContentType('progressive', 'mov')).toBe('video/mp4');
    expect(castContentType('progressive', 'webm')).toBe('video/webm');
  });

  it('flags advertisement URLs', () => {
    expect(isAdUrl('https://pubads.g.doubleclick.net/gampad/ads?iu=x')).toBe(true);
    expect(isAdUrl('https://cdn.example.com/preroll/clip.mp4')).toBe(true);
    expect(isAdUrl('https://cdn.example.com/movies/headroom.mp4')).toBe(false);
  });

  it('labels URLs with decoded file names', () => {
    expect(labelForUrl('https://e.com/v/My%20Movie.mp4?sig=1')).toBe('My Movie.mp4');
    expect(labelForUrl('https://e.com/')).toBe('e.com');
  });

  it('reads total sizes', () => {
    expect(totalSizeFromHeaders(206, 'bytes 0-1/123456789', '2')).toBe(123456789);
    expect(totalSizeFromHeaders(200, null, '5000')).toBe(5000);
    expect(totalSizeFromHeaders(206, 'bytes 0-1/*', '2')).toBeUndefined();
  });
});
