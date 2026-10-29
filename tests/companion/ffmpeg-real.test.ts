// End-to-end with the real FFmpeg: runs only when ffmpeg/ffprobe are installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateSessionResponse } from '@castit/shared';
import { startCompanion, type RunningCompanion } from '../../apps/companion/src/server.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('real FFmpeg conversion', () => {
  let dir = '';
  let upstream: http.Server;
  let companion: RunningCompanion;
  let key = '';
  let base = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'castit-ffmpeg-real-'));
    // 20 s of 720p HEVC + AC-3 5.1 in MKV with a subtitle: nothing an older Chromecast plays.
    writeFileSync(join(dir, 'subs.srt'), '1\n00:00:01,000 --> 00:00:03,000\nHello\n');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=20',
      '-f', 'lavfi', '-i', 'sine=f=440:d=20',
      '-i', join(dir, 'subs.srt'),
      '-map', '0:v', '-map', '1:a', '-map', '2:s',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
      '-c:a', 'ac3', '-ac', '6', '-c:s', 'srt', join(dir, 'clip.mkv'),
    ]);
    upstream = http.createServer((req, res) => {
      const data = readFileSync(join(dir, 'clip.mkv'));
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 });
        res.end(data.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': data.length });
        res.end(data);
      }
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    companion = await startCompanion({
      controlPort: 0,
      mediaPort: 0,
      mediaListenHost: '127.0.0.1',
      publicHost: '127.0.0.1',
      allowPrivateUpstreams: true,
      configDir: join(dir, 'cfg'),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      tmpRoot: dir,
      log: () => undefined,
    });
    const code = companion.pairing.issue();
    const res = await fetch(`${companion.controlUrl}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    key = ((await res.json()) as { apiKey: string }).apiKey;
  }, 60_000);

  afterAll(async () => {
    await companion?.close();
    await new Promise((r) => upstream?.close(r));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('analyses, transcodes to H.264/AAC HLS, seeks and extracts subtitles', async () => {
    const res = await fetch(`${companion.controlUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: `${base}/clip.mkv`, kind: 'progressive', context: {}, transcode: { mode: 'auto', profile: 'compat', quality: 'auto' } }),
    });
    const body = (await res.json()) as CreateSessionResponse;
    expect(body.delivery).toBe('transcode');
    expect(body.plan).toMatchObject({ video: 'encode', audio: 'encode', subtitles: 1 });
    expect(body.media).toMatchObject({ seekable: true, hlsSegmentFormat: 'ts' });
    expect(body.media!.duration).toBeCloseTo(20, 0);

    const playlist = await (await fetch(body.mediaUrl)).text();
    expect(playlist.match(/#EXTINF/g)).toHaveLength(5);
    const segBase = body.mediaUrl.replace('index.m3u8', '');
    for (const n of [0, 4]) {
      const seg = Buffer.from(await (await fetch(`${segBase}seg-${n}.ts`)).arrayBuffer());
      const file = join(dir, `out-${n}.ts`);
      writeFileSync(file, seg);
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
      expect(info.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(['aac', 'h264']);
      // Absolute timeline: segment n starts near n*4 s (+ the MPEG-TS muxer's fixed 1.4 s offset).
      expect(Number(info.format.start_time)).toBeCloseTo(n * 4 + 1.4, 0);
    }
    const vtt = await (await fetch(`${segBase}subs-0.vtt`)).text();
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Hello');
  }, 90_000);
});
