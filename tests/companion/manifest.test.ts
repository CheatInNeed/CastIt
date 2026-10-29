import { describe, expect, it } from 'vitest';
import {
  manifestKindFromBody,
  manifestKindFromHeaders,
  mediaContentType,
  parseProxyPath,
  rewriteDash,
  rewriteHls,
  toProxyUrl,
} from '../../apps/companion/src/manifest.ts';

const BASE = 'http://192.168.1.20:47801';
const SID = 'abcdefghijklmnopqrstuvwxyz012345';
const map = (u: URL) => toProxyUrl(BASE, SID, u);

describe('proxy URL mapping', () => {
  it('round-trips upstream URLs including ports and signed queries', () => {
    const upstream = 'https://cdn.example.com:8443/v/1080p/index.m3u8?Policy=eyJ%3D&Signature=a~b_c-d&Key-Pair-Id=K1';
    const proxied = toProxyUrl(BASE, SID, upstream);
    expect(proxied).toBe(`${BASE}/m/${SID}/https/cdn.example.com:8443/v/1080p/index.m3u8?Policy=eyJ%3D&Signature=a~b_c-d&Key-Pair-Id=K1`);
    const parsed = parseProxyPath(proxied.slice(BASE.length));
    expect(parsed).toEqual({ sessionId: SID, upstream });
  });

  it('handles root paths and bare queries', () => {
    expect(parseProxyPath(`/m/${SID}/http/e.com`)?.upstream).toBe('http://e.com/');
    expect(parseProxyPath(`/m/${SID}/http/e.com?x=1`)?.upstream).toBe('http://e.com/?x=1');
  });

  it('rejects malformed paths', () => {
    expect(parseProxyPath('/m/short/https/e.com/a')).toBeNull();
    expect(parseProxyPath(`/m/${SID}/ftp/e.com/a`)).toBeNull();
    expect(parseProxyPath('/etc/passwd')).toBeNull();
  });
});

describe('rewriteHls', () => {
  it('rewrites variant lines, segments and URI attributes; leaves skd:// alone', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?t=1",IV=0x1',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-id",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="https://audio.example.net/en.m3u8"',
      '#EXTINF:6.0,',
      'seg-1.m4s?token=abc',
      '#EXTINF:6.0,',
      'https://other-cdn.example.org/seg-2.m4s',
      '',
    ].join('\r\n');
    const out = rewriteHls(playlist, 'https://cdn.example.com/show/v/index.m3u8?sig=1', map);
    const p = `${BASE}/m/${SID}`;
    expect(out).toContain(`URI="${p}/https/cdn.example.com/show/v/key.bin?t=1"`);
    expect(out).toContain('URI="skd://fairplay-id"');
    expect(out).toContain(`URI="${p}/https/cdn.example.com/show/v/init.mp4"`);
    expect(out).toContain(`URI="${p}/https/audio.example.net/en.m3u8"`);
    expect(out).toContain(`\r\n${p}/https/cdn.example.com/show/v/seg-1.m4s?token=abc\r\n`);
    expect(out).toContain(`${p}/https/other-cdn.example.org/seg-2.m4s`);
    expect(out.startsWith('#EXTM3U\r\n')).toBe(true);
  });

  it('leaves references the mapper refuses untouched', () => {
    const out = rewriteHls('#EXTM3U\nhttp://10.0.0.1/a.ts\n', 'https://e.com/x.m3u8', () => null);
    expect(out).toBe('#EXTM3U\nhttp://10.0.0.1/a.ts\n');
  });
});

describe('rewriteDash', () => {
  it('rewrites absolute BaseURL/template URLs (with XML entities) and keeps relative ones', () => {
    const mpd = `<MPD type="static">
  <BaseURL>https://cdn.example.com/dash/</BaseURL>
  <Period>
    <AdaptationSet>
      <SegmentTemplate initialization="https://cdn2.example.com/init-$RepresentationID$.mp4?a=1&amp;b=2" media="chunk-$Number$.m4s"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    const out = rewriteDash(mpd, 'https://cdn.example.com/dash/manifest.mpd', map);
    const p = `${BASE}/m/${SID}`;
    expect(out).toContain(`<BaseURL>${p}/https/cdn.example.com/dash/</BaseURL>`);
    expect(out).toContain(`initialization="${p}/https/cdn2.example.com/init-$RepresentationID$.mp4?a=1&amp;b=2"`);
    expect(out).toContain('media="chunk-$Number$.m4s"');
  });
});

describe('content types', () => {
  it('detects manifests by header, extension or body', () => {
    expect(manifestKindFromHeaders('application/vnd.apple.mpegurl', 'https://e.com/x')).toBe('hls');
    expect(manifestKindFromHeaders('text/plain', 'https://e.com/a/master.m3u8?x')).toBe('hls');
    expect(manifestKindFromHeaders(undefined, 'https://e.com/a.mpd')).toBe('dash');
    expect(manifestKindFromHeaders('video/mp2t', 'https://e.com/a.ts')).toBeNull();
    expect(manifestKindFromBody('﻿#EXTM3U\n')).toBe('hls');
    expect(manifestKindFromBody('<?xml version="1.0"?>\n<MPD xmlns="urn">')).toBe('dash');
    expect(manifestKindFromBody('\u0000\u0000\u0000 ftyp')).toBeNull();
  });

  it('fixes generic media content types by extension', () => {
    expect(mediaContentType('application/octet-stream', 'https://e.com/seg.ts')).toBe('video/mp2t');
    expect(mediaContentType(undefined, 'https://e.com/a.m4s')).toBe('video/iso.segment');
    expect(mediaContentType('video/mp4', 'https://e.com/a.bin')).toBe('video/mp4');
  });
});
