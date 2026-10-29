// Integration test: probes a real local HTTP server serving HLS, DASH and MP4.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeStream } from '../../apps/extension/src/lib/probe.ts';
import { DASH_VOD, HLS_MASTER, HLS_MEDIA_TS_VOD } from '../fixtures/manifests.ts';

let server: Server;
let base = '';
const seenCookies: (string | undefined)[] = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  seenCookies.push(req.headers.cookie);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const cors = url.searchParams.has('nocors') ? {} : { 'Access-Control-Allow-Origin': '*' };
  switch (url.pathname) {
    case '/show/master.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', ...cors }).end(HLS_MASTER);
      return;
    case '/show/360p/index.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', ...cors }).end(HLS_MEDIA_TS_VOD);
      return;
    case '/movie.mpd':
      res.writeHead(200, { 'Content-Type': 'application/dash+xml', ...cors }).end(DASH_VOD);
      return;
    case '/movie.mp4': {
      const total = 50_000_000;
      if (req.headers.range === 'bytes=0-1') {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-1/${total}`, 'Content-Length': '2' }).end(Buffer.alloc(2));
      } else {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(total) }).end();
      }
      return;
    }
    case '/private.m3u8':
      res.writeHead(403).end('forbidden');
      return;
    default:
      res.writeHead(404).end();
  }
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('probeStream (mock media server)', () => {
  it('parses an HLS master and its first variant', async () => {
    const result = await probeStream({ url: `${base}/show/master.m3u8`, kind: 'hls' });
    expect(result.status).toBe(200);
    expect(result.cors).toBe('*');
    expect(result.hls?.type).toBe('master');
    expect(result.hlsMedia?.type).toBe('media');
    expect(result.hlsMedia?.segmentFormat).toBe('ts');
  });

  it('reports a missing CORS header as null', async () => {
    const result = await probeStream({ url: `${base}/show/master.m3u8?nocors=1`, kind: 'hls' });
    expect(result.cors).toBeNull();
  });

  it('parses DASH', async () => {
    const result = await probeStream({ url: `${base}/movie.mpd`, kind: 'dash' });
    expect(result.dash?.maxHeight).toBe(1080);
  });

  it('range-probes progressive files without downloading them', async () => {
    const result = await probeStream({ url: `${base}/movie.mp4`, kind: 'progressive' });
    expect(result.status).toBe(206);
    expect(result.totalSize).toBe(50_000_000);
    expect(result.contentType).toBe('video/mp4');
  });

  it('surfaces HTTP errors and unreachable hosts', async () => {
    expect((await probeStream({ url: `${base}/private.m3u8`, kind: 'hls' })).status).toBe(403);
    expect((await probeStream({ url: `${base}/gone.mp4`, kind: 'progressive' })).status).toBe(404);
    const dead = await probeStream({ url: 'http://127.0.0.1:1/x.m3u8', kind: 'hls' }, fetch, 2000);
    expect(dead.reachable).toBe(false);
  });

  it('never sends cookies', () => {
    expect(seenCookies.every((c) => c === undefined)).toBe(true);
  });
});
