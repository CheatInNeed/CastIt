// The movy-like test site end to end, offline: its protections behave like real aggregator/embed
// hosts, Castit judges the stream correctly, picks the companion, and the companion gets through
// by sending the player's Referer.
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanion, type RunningCompanion } from '../../apps/companion/src/server.ts';
import { assessCastability } from '../../apps/extension/src/lib/castability.ts';
import { chooseEngine, upstreamContextFor } from '../../apps/extension/src/lib/engine.ts';
import { classifyMedia, labelForUrl } from '../../apps/extension/src/lib/media-types.ts';
import { probeStream } from '../../apps/extension/src/lib/probe.ts';
import { candidate } from '../extension/helpers.ts';
import { startSim, type RunningSim } from './movy-sim/server.ts';

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nv720/index.m3u8\n';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg-0.ts\n#EXT-X-ENDLIST\n';

let upstream: Server;
let sim: RunningSim;
let companion: RunningCompanion;
const logs: string[] = [];
const configDir = mkdtempSync(join(tmpdir(), 'castit-movy-'));

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(MASTER);
    if (req.url === '/v720/index.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(MEDIA);
    if (req.url === '/v720/seg-0.ts') return res.writeHead(200, { 'content-type': 'video/mp2t' }).end(Buffer.alloc(188, 0x47));
    if (req.url === '/ad.mp4') return res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(1000));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  sim = await startSim({
    host: '127.0.0.1',
    listenHost: '127.0.0.1',
    ports: { site: 0, player: 0, cdn: 0 },
    upstream: `${base}/`,
    master: 'master.m3u8',
    adClip: `${base}/ad.mp4`,
    log: (line) => logs.push(line),
  });
  companion = await startCompanion({
    mediaPort: 0,
    mediaListenHost: '127.0.0.1',
    publicHost: '127.0.0.1',
    allowPrivateUpstreams: true, // the simulated CDN is local
    configDir,
    ffmpegPath: '/nonexistent/ffmpeg',
    ffprobePath: '/nonexistent/ffprobe',
    log: () => undefined,
  });
});

afterAll(async () => {
  await companion?.close();
  await sim?.close();
  await new Promise((r) => upstream?.close(r));
  rmSync(configDir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers });

describe('movy-like site: protections', () => {
  it('serves the site, the embedded player and an obfuscated, signed stream address', async () => {
    expect(await (await get(`${sim.site}/watch/1`)).text()).toContain(`${sim.player}/e/1`);
    const { file } = (await (await get(`${sim.player}/api/source/1`)).json()) as { file: string };
    const url = Buffer.from(file, 'base64').toString();
    expect(url).toMatch(new RegExp(`^${sim.cdn}/hls/\\d+-[0-9a-f]{20}/master\\.m3u8$`));
  });

  it('refuses requests without the player as Referer, and CORS for other origins', async () => {
    const url = sim.signedMaster();
    const bare = await get(url);
    expect(bare.status).toBe(403);
    const asReceiver = await get(url, { origin: 'https://www.gstatic.com', referer: 'https://www.gstatic.com/' });
    expect(asReceiver.status).toBe(403);
    expect(asReceiver.headers.get('access-control-allow-origin')).toBeNull();
    const asPlayer = await get(url, { origin: sim.player, referer: `${sim.player}/` });
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.headers.get('access-control-allow-origin')).toBe(sim.player);
    expect(logs.some((l) => l.includes('403 hotlink protection'))).toBe(true);
  });

  it('expires and verifies its signed links', async () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    expect((await get(sim.signedMaster(past), { referer: `${sim.player}/` })).status).toBe(410);
    const tampered = sim.signedMaster().replace(/-([0-9a-f])/, (_, c: string) => `-${c === 'a' ? 'b' : 'a'}`);
    expect((await get(tampered, { referer: `${sim.player}/` })).status).toBe(403);
  });
});

describe('movy-like site: Castit', () => {
  it('detects the signed master, sees the cookie-less refusal and chooses the companion', async () => {
    const url = sim.signedMaster();
    expect(classifyMedia(url)?.kind).toBe('hls');
    expect(labelForUrl(url)).toBe('master.m3u8');
    const probe = await probeStream({ url, kind: 'hls' });
    expect(probe.status).toBe(403);
    const assessment = assessCastability(candidate({ url, kind: 'hls', embedded: true }), probe);
    expect(assessment.level).toBe('unlikely');
    expect(assessment.companionHelps).toMatch(/Referer/);
    expect(chooseEngine('auto', assessment, { ready: true, ffmpeg: false })).toEqual({ engine: 'companion' });
  });

  it('gets through via the companion with the player’s Referer and Origin', async () => {
    const url = sim.signedMaster();
    const context = upstreamContextFor({ url, kind: 'hls' }, `${sim.player}/e/1`, sim.player, 'Chrome');
    expect(context).toMatchObject({ referer: `${sim.player}/`, origin: sim.player });
    const session = await companion.createSession({ url, kind: 'hls', context });
    expect(session.check).toMatchObject({ ok: true, status: 200 });

    // What the Chromecast would now fetch: master → variant → segment, all through the relay.
    const master = await (await fetch(session.mediaUrl)).text();
    const variantUrl = master.split('\n').find((l) => l.startsWith('http'))!;
    const variant = await (await fetch(variantUrl)).text();
    const segmentUrl = variant.split('\n').find((l) => l.startsWith('http'))!;
    const segment = Buffer.from(await (await fetch(segmentUrl)).arrayBuffer());
    expect(segment[0]).toBe(0x47);
  });
});
