// Job runner tests against a fake ffmpeg (tests/fixtures/fake-ffmpeg.mjs), so they run anywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ProbedStream } from '../../apps/companion/src/ffmpeg.ts';
import { planMedia } from '../../apps/companion/src/plan.ts';
import { JobManager, ManagedJob, SegmentedJob, sweepStaleJobDirs, type JobSpec } from '../../apps/companion/src/transcoder.ts';

const root = mkdtempSync(join(tmpdir(), 'castit-transcoder-test-'));
const fakeFfmpeg = join(root, 'ffmpeg');
const logFile = join(root, 'calls.log');

beforeAll(() => {
  writeFileSync(fakeFfmpeg, `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-ffmpeg.mjs')}" "$@"\n`);
  chmodSync(fakeFfmpeg, 0o755);
  process.env.FAKE_FFMPEG_LOG = logFile;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const jobs: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(jobs.splice(0).map((job) => job.close()));
  delete process.env.FAKE_FAIL_HW;
  delete process.env.FAKE_TOTAL;
  writeFileSync(logFile, '');
});

const s = (x: Partial<ProbedStream> & Pick<ProbedStream, 'index' | 'type' | 'codec'>): ProbedStream => ({ isDefault: false, attachedPic: false, ...x });
const hevc = s({ index: 0, type: 'video', codec: 'hevc', height: 1080, width: 1920, pixFmt: 'yuv420p', frameRate: 30 });
const h264 = s({ index: 0, type: 'video', codec: 'h264', profile: 'High', level: 40, height: 720, width: 1280, pixFmt: 'yuv420p', frameRate: 30 });
const aac = s({ index: 1, type: 'audio', codec: 'aac', channels: 2 });
const srt = s({ index: 2, type: 'subtitle', codec: 'subrip', language: 'eng' });

function spec(streams: ProbedStream[], extra: Partial<JobSpec> = {}): JobSpec {
  const plan = planMedia({ formatName: 'matroska,webm', duration: 120, streams }, { kind: 'progressive', extension: 'mkv' }, { mode: 'auto', profile: 'compat', quality: 'auto' });
  return { input: 'http://127.0.0.1:1/m/x/https/e.com/a.mkv', plan, encoder: { name: 'libx264', hardware: false }, ffmpegPath: fakeFfmpeg, duration: 120, live: false, log: () => undefined, tmpRoot: root, ...extra };
}

const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const encodeCalls = () => calls().filter((a) => a.includes('-hls_segment_filename'));

describe('SegmentedJob', () => {
  it('publishes the full VOD playlist and serves segments as they are produced', async () => {
    const job = new SegmentedJob(spec([hevc, aac, srt]));
    jobs.push(job);
    expect(job.count).toBe(30);
    expect((await job.playlist()).match(/#EXTINF/g)).toHaveLength(30);
    const path = await job.segment('seg-0.ts');
    expect(readFileSync(path).length).toBe(188);
    expect(job.delivered('http://h/t/x')).toMatchObject({ seekable: true, duration: 120, hlsSegmentFormat: 'ts', textTracks: [{ id: 1, name: 'ENG', url: 'http://h/t/x/subs-0.vtt' }] });
    expect(readFileSync(await job.subtitle(0), 'utf8')).toContain('WEBVTT');
  });

  it('restarts the encoder at the requested segment on a far seek', async () => {
    const job = new SegmentedJob(spec([hevc, aac]));
    jobs.push(job);
    await job.segment('seg-0.ts');
    await job.segment('seg-25.ts');
    const starts = encodeCalls().map((a) => a[a.indexOf('-start_number') + 1]);
    expect(starts).toEqual(['0', '25']);
    const seek = encodeCalls()[1]!;
    expect(seek[seek.indexOf('-ss') + 1]).toBe('100.000');
  });

  it('rejects segments outside the timeline and unknown files', async () => {
    const job = new SegmentedJob(spec([hevc, aac]));
    jobs.push(job);
    await expect(job.segment('seg-30.ts')).rejects.toThrow();
    await expect(job.segment('../../etc/passwd')).rejects.toThrow();
    await expect(job.subtitle(3)).rejects.toThrow();
  });

  it('falls back to the software encoder when the hardware encoder fails', async () => {
    process.env.FAKE_FAIL_HW = '1';
    const job = new SegmentedJob(spec([hevc, aac], { encoder: { name: 'h264_videotoolbox', hardware: true } }));
    jobs.push(job);
    await job.segment('seg-1.ts');
    const encoders = encodeCalls().map((a) => a[a.indexOf('-c:v') + 1]);
    expect(encoders).toEqual(['h264_videotoolbox', 'libx264']);
  });

  it('deletes its folder when closed', async () => {
    const job = new SegmentedJob(spec([hevc, aac]));
    await job.segment('seg-0.ts');
    await job.close();
    expect(existsSync(job.dir)).toBe(false);
    await expect(job.segment('seg-1.ts')).rejects.toThrow();
  });
});

describe('ManagedJob (remux)', () => {
  it('serves the FFmpeg-written playlist once it lists a segment', async () => {
    process.env.FAKE_TOTAL = '5';
    const job = new ManagedJob(spec([h264, aac]));
    jobs.push(job);
    expect(job.delivered('x')).toMatchObject({ seekable: false, streamType: 'BUFFERED' });
    expect(await job.playlist()).toContain('seg-0.ts');
    expect(await job.segment('seg-4.ts')).toMatch(/seg-4\.ts$/);
    await expect(job.segment('seg-9.ts')).rejects.toThrow(); // FFmpeg finished without it
    expect(encodeCalls()[0]).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']));
  });
});

describe('JobManager', () => {
  it('chooses the job type, limits concurrent jobs and closes them', async () => {
    const manager = new JobManager(2);
    const a = manager.create('a', spec([hevc, aac]));
    const b = manager.create('b', spec([h264, aac]));
    expect(a).toBeInstanceOf(SegmentedJob);
    expect(b).toBeInstanceOf(ManagedJob);
    manager.create('c', spec([hevc, aac]));
    expect(manager.get('a')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(a.dir)).toBe(false);
    await manager.closeAll();
    expect(manager.size).toBe(0);
  });

  it('sweeps stale job folders left by a crash', () => {
    const stale = join(root, 'castit-job-stale');
    mkdirSync(stale, { recursive: true });
    const old = (Date.now() - 7 * 3600_000) / 1000;
    utimesSync(stale, old, old);
    expect(sweepStaleJobDirs(root)).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
  });
});
