// End-to-end: the real companion servers relaying from a local mock upstream.
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateSessionResponse } from '@castit/shared';
import { startCompanion, type RunningCompanion } from '../../apps/companion/src/server.ts';

const FILE_SIZE = 1_000_000;
const FILE = Buffer.alloc(FILE_SIZE, 7);
let upstream: Server;
let up = '';
const seen: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
let slowClosed: Promise<void>;
let resolveSlowClosed: () => void;

function upstreamHandler(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ url: req.url ?? '', headers: req.headers });
  const url = new URL(req.url ?? '/', 'http://x');
  switch (url.pathname) {
    case '/hls/master.m3u8':
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'set-cookie': 'tracking=1' });
      res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/index.m3u8?token=abc\n#EXT-X-STREAM-INF:BANDWIDTH=2000\n${up}/abs/1080p.m3u8\n`);
      return;
    case '/hls/720p/index.m3u8':
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:6,\nseg-0.ts\n#EXT-X-ENDLIST\n');
      return;
    case '/hls/720p/seg-0.ts':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4' });
      res.end(Buffer.from([0x47, 1, 2, 3]));
      return;
    case '/sniff':
      // Manifest served with a generic type, no extension, gzip-encoded.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync('#EXTM3U\n#EXTINF:6,\nseg.ts\n'));
      return;
    case '/movie.mp4': {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : FILE_SIZE - 1;
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${FILE_SIZE}`,
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
        });
        res.end(FILE.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(FILE_SIZE), 'accept-ranges': 'bytes' });
        res.end(FILE);
      }
      return;
    }
    case '/needs-referer.mp4':
      if (req.headers.referer !== 'https://player.example/') {
        res.writeHead(403).end('hotlink');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '3' }).end('abc');
      return;
    case '/redirect.m3u8':
      res.writeHead(302, { location: '/hls/master.m3u8' }).end();
      return;
    case '/slow.mp4':
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.alloc(64 * 1024));
      req.socket.on('close', () => resolveSlowClosed());
      return; // never ends
    default:
      res.writeHead(404).end();
  }
}

let companion: RunningCompanion;
const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
let apiKey = '';
const json = { 'content-type': 'application/json' };

async function api(path: string, init: RequestInit = {}, key = apiKey): Promise<Response> {
  return fetch(`${companion.controlUrl}${path}`, {
    ...init,
    headers: { ...json, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) },
  });
}

async function session(url: string, kind = 'hls', context: Record<string, unknown> = {}): Promise<CreateSessionResponse> {
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ url, kind, context }) });
  expect(res.status).toBe(200);
  return (await res.json()) as CreateSessionResponse;
}

/** GET via a specific local address so the media server sees different clients. */
function getFrom(url: string, localAddress: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http
      .get({ host: localAddress === '::1' ? '::1' : '127.0.0.1', port: target.port, path: target.pathname + target.search, localAddress }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  slowClosed = new Promise((r) => (resolveSlowClosed = r));
  upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  companion = await startCompanion({
    controlPort: 0,
    mediaPort: 0,
    mediaListenHost: '::',
    publicHost: '127.0.0.1',
    allowPrivateUpstreams: true,
    configDir: tempDir('castit-e2e-'),
    ffmpegPath: '/nonexistent/ffmpeg',
    ffprobePath: '/nonexistent/ffprobe',
    log: () => undefined,
    // Treat every client as a remote device so device binding can be exercised from loopback.
    isLocalClient: () => false,
  });

  const code = companion.pairing.issue();
  const res = await api('/api/pair', { method: 'POST', body: JSON.stringify({ code }) }, '');
  apiKey = ((await res.json()) as { apiKey: string }).apiKey;
});

afterAll(async () => {
  await companion?.close();
  await new Promise((r) => upstream?.close(r));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('control API', () => {
  it('reports health and requires pairing for sessions', async () => {
    const health = await (await api('/api/health', {}, '')).json();
    expect(health).toMatchObject({ name: 'castit-companion', paired: true, protocol: 1, ffmpeg: false });
    const res = await api('/api/sessions', { method: 'POST', body: '{}' }, 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects wrong pairing codes', async () => {
    const res = await api('/api/pair', { method: 'POST', body: JSON.stringify({ code: '000-000' }) }, '');
    expect(res.status).toBe(401);
  });

  it('refuses browser pages and rebinding hosts', async () => {
    expect((await api('/api/health', { headers: { origin: 'https://evil.example' } }, '')).status).toBe(403);
    const port = new URL(companion.controlUrl).port;
    const status = await new Promise<number>((resolve) =>
      http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `evil.example:${port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }),
    );
    expect(status).toBe(403);
  });

  it('lists sessions without query strings', async () => {
    await session(`${up}/hls/master.m3u8?sig=secret`);
    const list = (await (await api('/api/sessions')).json()) as Array<{ upstream: string }>;
    expect(list.some((s) => s.upstream.endsWith('/hls/master.m3u8?…'))).toBe(true);
    expect(JSON.stringify(list)).not.toContain('secret');
  });
});

describe('HLS relay', () => {
  it('rewrites the master and variants so every request goes through the session', async () => {
    const s = await session(`${up}/hls/master.m3u8`);
    expect(s.check).toMatchObject({ ok: true, status: 200 });
    const master = await fetch(s.mediaUrl);
    expect(master.headers.get('access-control-allow-origin')).toBe('*');
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(master.headers.get('set-cookie')).toBeNull();
    const text = await master.text();
    const lines = text.split('\n').filter((l) => l.startsWith('http'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`/m/${s.sessionId}/http/127.0.0.1:`);
    expect(lines[0]).toMatch(/\/hls\/720p\/index\.m3u8\?token=abc$/);

    const variant = await (await fetch(lines[0]!)).text();
    const segUrl = variant.split('\n').find((l) => l.startsWith('http'))!;
    const seg = await fetch(segUrl);
    expect(seg.headers.get('content-type')).toBe('video/mp2t');
    expect(Buffer.from(await seg.arrayBuffer())).toEqual(Buffer.from([0x47, 1, 2, 3]));
  });

  it('sniffs and decodes manifests served with generic types', async () => {
    const s = await session(`${up}/sniff`);
    const text = await (await fetch(s.mediaUrl)).text();
    expect(text).toContain('#EXTM3U');
    expect(text).toContain(`/m/${s.sessionId}/http/127.0.0.1:`);
  });

  it('turns upstream redirects into proxied redirects', async () => {
    const s = await session(`${up}/redirect.m3u8`);
    const res = await fetch(s.mediaUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(s.mediaUrl.replace('/redirect.m3u8', '/hls/master.m3u8'));
  });

  it('answers CORS / Private Network Access preflights', async () => {
    const s = await session(`${up}/hls/master.m3u8`);
    const res = await fetch(s.mediaUrl, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });
});

describe('progressive relay', () => {
  it('passes Range requests through without buffering the file', async () => {
    const s = await session(`${up}/movie.mp4`, 'progressive');
    const res = await fetch(s.mediaUrl, { headers: { range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${FILE_SIZE}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    const full = await fetch(s.mediaUrl);
    expect(full.headers.get('content-length')).toBe(String(FILE_SIZE));
    expect((await full.arrayBuffer()).byteLength).toBe(FILE_SIZE);
  });

  it('sends only the explicit context upstream: Referer yes, cookies never', async () => {
    const s = await session(`${up}/needs-referer.mp4`, 'progressive', {
      referer: 'https://player.example/',
      cookie: 'session=stolen',
      authorization: 'Bearer x',
    });
    expect(s.check.ok).toBe(true);
    expect(await (await fetch(s.mediaUrl, { headers: { cookie: 'a=b' } })).text()).toBe('abc');
    const hits = seen.filter((r) => r.url === '/needs-referer.mp4');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.headers.referer).toBe('https://player.example/');
      expect(hit.headers.cookie).toBeUndefined();
      expect(hit.headers.authorization).toBeUndefined();
    }
  });

  it('reports upstream refusal at session creation', async () => {
    const s = await session(`${up}/needs-referer.mp4`, 'progressive');
    expect(s.check).toMatchObject({ ok: false, status: 403 });
  });

  it('aborts the upstream download when the receiver disconnects', async () => {
    const s = await session(`${up}/slow.mp4`, 'progressive');
    const controller = new AbortController();
    const res = await fetch(s.mediaUrl, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(Promise.race([slowClosed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('timeout'), 3000))])).resolves.toBe(
      'closed',
    );
  });
});

describe('conversion without FFmpeg', () => {
  it('relays unchanged and explains why', async () => {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ url: `${up}/movie.mp4`, kind: 'progressive', context: {}, transcode: { mode: 'force', profile: 'compat', quality: 'auto' } }),
    });
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.delivery).toBe('relay');
    expect(body.analysisError).toMatch(/FFmpeg not found/);
  });
});

describe('session security', () => {
  it('refuses hosts that were not part of the session', async () => {
    const s = await session(`${up}/movie.mp4`, 'progressive');
    const other = s.mediaUrl.replace(/\/http\/127\.0\.0\.1:\d+\//, '/http/example.com/');
    expect((await fetch(other)).status).toBe(403);
  });

  it('returns 404 for unknown and deleted sessions', async () => {
    const s = await session(`${up}/movie.mp4`, 'progressive');
    expect((await api(`/api/sessions/${s.sessionId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(s.mediaUrl)).status).toBe(404);
    expect((await fetch(s.mediaUrl.replace(s.sessionId, 'x'.repeat(32)))).status).toBe(404);
  });

  it('binds a session to the first device that uses it', async () => {
    const s = await session(`${up}/movie.mp4`, 'progressive');
    expect(await getFrom(s.mediaUrl, '127.0.0.1')).toBe(200);
    expect(await getFrom(s.mediaUrl, '::1')).toBe(403);
  });

  it('blocks private upstreams unless explicitly allowed', async () => {
    const strict = await startCompanion({
      controlPort: 0,
      mediaPort: 0,
      mediaListenHost: '127.0.0.1',
      publicHost: '127.0.0.1',
      allowPrivateUpstreams: false,
      configDir: tempDir('castit-strict-'),
      ffmpegPath: '/nonexistent/ffmpeg',
      ffprobePath: '/nonexistent/ffprobe',
      log: () => undefined,
    });
    try {
      const code = strict.pairing.issue();
      const pair = await fetch(`${strict.controlUrl}/api/pair`, { method: 'POST', headers: json, body: JSON.stringify({ code }) });
      const key = ((await pair.json()) as { apiKey: string }).apiKey;
      const res = await fetch(`${strict.controlUrl}/api/sessions`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${key}` },
        body: JSON.stringify({ url: `${up}/movie.mp4`, kind: 'progressive', context: {} }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BLOCKED_ADDRESS');
    } finally {
      await strict.close();
    }
  });
});
