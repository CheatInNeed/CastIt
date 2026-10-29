// FFmpeg job management: one job per media session, writing HLS into a private temp directory.
//
//   SegmentedJob  re-encodes video into fixed 4 s segments. The full VOD playlist is published up
//                 front so the receiver can seek anywhere at once; a seek beyond the encoder's
//                 position restarts FFmpeg at that segment. The encoder is paused (SIGSTOP) when it
//                 runs far ahead of playback, and segments well behind playback are deleted.
//   ManagedJob    FFmpeg writes the playlist itself: remuxing (video copied, so segments follow the
//                 source's keyframes), live inputs (sliding window) and unknown durations.
//
// Both retry once with the software encoder if a hardware encoder fails, and remove their
// directory (and kill FFmpeg) when the session ends or the companion exits.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveredMedia } from '@castit/shared';
import { SOFTWARE_ENCODER, type EncoderInfo } from './ffmpeg.ts';
import { managedArgs, segmentCount, segmentedArgs, subtitleArgs, virtualPlaylist, type MediaPlan } from './plan.ts';

export const JOB_DIR_PREFIX = 'castit-job-';
const SEGMENT_SECONDS = 4;
/** Restart instead of waiting when the requested segment is this far beyond the encoder. */
const RESTART_DISTANCE = 3;
/** Pause the encoder when this many segments ahead of playback; resume below RESUME_AHEAD. */
const PAUSE_AHEAD = 45;
const RESUME_AHEAD = 20;
/** Keep this many already-played segments for small backward seeks. */
const KEEP_BEHIND = 10;
const WAIT_MS = 60_000;

export class JobFileNotFound extends Error {}

export interface JobSpec {
  input: string;
  plan: MediaPlan;
  encoder: EncoderInfo;
  ffmpegPath: string;
  duration?: number;
  live: boolean;
  log: (message: string) => void;
  tmpRoot?: string;
}

/** An FFmpeg child process with kill/pause/resume and a stderr tail for diagnostics. */
class FfmpegProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  exitCode: number | null | undefined;
  stopping = false;
  paused = false;
  private stderr = '';

  constructor(ffmpegPath: string, args: string[]) {
    this.child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4096);
    });
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e) => {
        this.stderr += e.message;
        this.exitCode = null;
        resolve(null);
      });
      this.child.on('close', (code) => {
        this.exitCode = code;
        resolve(code);
      });
    });
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  get errorTail(): string {
    return this.stderr.trim().split('\n').slice(-3).join(' ') || `FFmpeg exited with code ${this.exitCode}`;
  }

  pause(): void {
    if (process.platform === 'win32' || this.paused || !this.running) return;
    this.child.kill('SIGSTOP');
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.child.kill('SIGCONT');
    this.paused = false;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.running) return;
    this.stopping = true;
    this.resume();
    this.child.kill(signal);
    if (signal === 'SIGKILL') return;
    const force = setTimeout(() => this.running && this.child.kill('SIGKILL'), 3000);
    force.unref();
  }
}

function waitForFile(
  path: string,
  options: { timeoutMs: number; signal?: AbortSignal; failure: () => string | undefined; idle?: () => boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (existsSync(path)) return resolve();
      const failure = options.failure();
      if (failure) return reject(new Error(failure));
      if (options.signal?.aborted) return reject(new Error('aborted'));
      if (options.idle?.()) return reject(new JobFileNotFound('not produced'));
      if (Date.now() - started > options.timeoutMs) return reject(new Error('Timed out waiting for FFmpeg'));
      setTimeout(check, 100);
    };
    check();
  });
}

/** Text subtitle extraction to WebVTT, run alongside the main job. */
class SubtitleExtraction {
  readonly proc?: FfmpegProcess;
  private readonly dir: string;
  private failed = false;
  private done = false;

  constructor(dir: string, count: number, spec: JobSpec) {
    this.dir = dir;
    if (count === 0) {
      this.done = true;
      return;
    }
    this.proc = new FfmpegProcess(spec.ffmpegPath, subtitleArgs({ input: spec.input, streams: spec.plan.subtitles, dir }));
    void this.proc.exited.then((code) => {
      if (code === 0) {
        for (let i = 0; i < count; i++) {
          const part = join(dir, `subs-${i}.vtt.part`);
          if (existsSync(part)) renameSync(part, join(dir, `subs-${i}.vtt`));
        }
        this.done = true;
      } else if (!this.proc!.stopping) {
        this.failed = true;
        spec.log(`subtitle extraction failed: ${this.proc!.errorTail}`);
      }
    });
  }

  /** Complete file when extraction finished in time; otherwise whatever has been extracted. */
  async file(n: number, signal?: AbortSignal): Promise<string> {
    const final = join(this.dir, `subs-${n}.vtt`);
    try {
      await waitForFile(final, { timeoutMs: 45_000, signal, failure: () => (this.failed ? 'Subtitle extraction failed' : undefined), idle: () => this.done });
      return final;
    } catch {
      const part = join(this.dir, `subs-${n}.vtt.part`);
      if (existsSync(part)) return part;
      throw new JobFileNotFound('no subtitles');
    }
  }

}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swept on the next start (sweepStaleJobDirs) */
  }
}

export abstract class TranscodeJob {
  readonly dir: string;
  protected readonly spec: JobSpec;
  protected encoder: EncoderInfo;
  protected failure: string | undefined;
  protected readonly subtitles: SubtitleExtraction;
  private retriedSoftware = false;
  protected closed = false;

  constructor(spec: JobSpec) {
    this.spec = spec;
    this.dir = mkdtempSync(join(spec.tmpRoot ?? tmpdir(), JOB_DIR_PREFIX));
    this.encoder = spec.encoder;
    this.subtitles = new SubtitleExtraction(this.dir, spec.plan.subtitles.length, spec);
  }

  abstract delivered(baseUrl: string): DeliveredMedia;
  abstract playlist(signal?: AbortSignal): Promise<string>;
  abstract segment(name: string, signal?: AbortSignal): Promise<string>;
  protected abstract startEncoder(): void;
  /** The encoder process currently running, if any. */
  protected abstract encoderProcess(): FfmpegProcess | undefined;

  async subtitle(n: number, signal?: AbortSignal): Promise<string> {
    if (n < 0 || n >= this.spec.plan.subtitles.length) throw new JobFileNotFound('no such track');
    return this.subtitles.file(n, signal);
  }

  /** Called when an encoder process ends on its own. */
  protected onEncoderExit(proc: FfmpegProcess, code: number | null): void {
    if (proc.stopping || code === 0 || this.closed) return;
    if (this.encoder.hardware && this.spec.plan.video?.mode === 'encode' && !this.retriedSoftware) {
      this.spec.log(`hardware encoder ${this.encoder.name} failed (${proc.errorTail}); retrying with libx264`);
      this.retriedSoftware = true;
      this.encoder = SOFTWARE_ENCODER;
      this.startEncoder();
      return;
    }
    this.failure = `Transcoding failed: ${proc.errorTail}`;
    this.spec.log(this.failure);
  }

  protected spawn(args: string[]): FfmpegProcess {
    const proc = new FfmpegProcess(this.spec.ffmpegPath, args);
    void proc.exited.then((code) => this.onEncoderExit(proc, code));
    return proc;
  }

  /** Stops FFmpeg, then deletes the job folder once FFmpeg can no longer write into it. */
  close(): Promise<void> {
    this.closed = true;
    const procs = [this.encoderProcess(), this.subtitles.proc].filter((p): p is FfmpegProcess => !!p);
    for (const p of procs) p.kill();
    return Promise.all(procs.map((p) => p.exited)).then(() => removeDir(this.dir));
  }

  /** Synchronous variant for process exit: SIGKILL and best-effort delete. */
  closeNow(): void {
    this.closed = true;
    for (const p of [this.encoderProcess(), this.subtitles.proc]) p?.kill('SIGKILL');
    removeDir(this.dir);
  }

  protected textTracks(baseUrl: string): DeliveredMedia['textTracks'] {
    return this.spec.plan.subtitles.map((s, n) => ({
      id: n + 1,
      url: `${baseUrl}/subs-${n}.vtt`,
      name: s.title ?? (s.language && s.language !== 'und' ? s.language.toUpperCase() : `Subtitles ${n + 1}`),
      language: s.language && s.language !== 'und' ? s.language : undefined,
    }));
  }
}

export class SegmentedJob extends TranscodeJob {
  readonly count: number;
  private proc?: FfmpegProcess;
  private procStart = 0;
  /** Highest segment index known to exist contiguously from procStart. */
  private produced = -1;
  private lastRequested = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly duration: number;

  constructor(spec: JobSpec) {
    super(spec);
    this.duration = spec.duration!;
    this.count = segmentCount(this.duration, SEGMENT_SECONDS);
    this.startEncoder();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
  }

  delivered(baseUrl: string): DeliveredMedia {
    return {
      contentType: 'application/x-mpegurl',
      streamType: 'BUFFERED',
      hlsSegmentFormat: 'ts',
      hlsVideoSegmentFormat: 'mpeg2_ts',
      duration: this.duration,
      seekable: true,
      textTracks: this.textTracks(baseUrl),
    };
  }

  async playlist(): Promise<string> {
    return virtualPlaylist(this.duration, SEGMENT_SECONDS);
  }

  protected startEncoder(): void {
    this.proc?.kill();
    this.produced = this.procStart - 1;
    this.proc = this.spawn(
      segmentedArgs({ input: this.spec.input, plan: this.spec.plan, encoder: this.encoder, dir: this.dir, segmentSeconds: SEGMENT_SECONDS, startSegment: this.procStart }),
    );
  }

  protected encoderProcess(): FfmpegProcess | undefined {
    return this.proc;
  }

  private restartAt(n: number): void {
    this.spec.log(`seek: restarting encoder at segment ${n} (${n * SEGMENT_SECONDS}s)`);
    this.procStart = n;
    this.failure = undefined;
    this.startEncoder();
  }

  private segmentPath(n: number): string {
    return join(this.dir, `seg-${n}.ts`);
  }

  private updateProduced(): void {
    while (existsSync(this.segmentPath(this.produced + 1))) this.produced++;
  }

  async segment(name: string, signal?: AbortSignal): Promise<string> {
    const n = Number(/^seg-(\d+)\.ts$/.exec(name)?.[1] ?? NaN);
    if (this.closed || !Number.isInteger(n) || n < 0 || n >= this.count) throw new JobFileNotFound(name);
    this.lastRequested = n;
    const path = this.segmentPath(n);
    if (existsSync(path)) return path;

    this.updateProduced();
    const encoderBusy = this.proc?.running || this.proc?.exitCode === 0;
    if (!encoderBusy || n < this.procStart || n > this.produced + 1 + RESTART_DISTANCE || this.failure) this.restartAt(n);
    this.proc?.resume();
    // An encoder that finished without writing this segment never will (e.g. a sub-frame tail).
    const proc = this.proc;
    await waitForFile(path, { timeoutMs: WAIT_MS, signal, failure: () => this.failure, idle: () => proc?.exitCode === 0 && !existsSync(path) });
    return path;
  }

  private tick(): void {
    if (this.closed) return;
    this.updateProduced();
    const ahead = this.produced - this.lastRequested;
    if (ahead > PAUSE_AHEAD) this.proc?.pause();
    else if (ahead < RESUME_AHEAD) this.proc?.resume();
    // Drop segments well behind playback to bound disk use; they are regenerated if needed.
    for (const file of readdirSync(this.dir)) {
      const n = Number(/^seg-(\d+)\.ts$/.exec(file)?.[1] ?? NaN);
      if (Number.isInteger(n) && n < this.lastRequested - KEEP_BEHIND) unlinkSync(join(this.dir, file));
    }
  }

  override close(): Promise<void> {
    clearInterval(this.timer);
    return super.close();
  }

  override closeNow(): void {
    clearInterval(this.timer);
    super.closeNow();
  }
}

export class ManagedJob extends TranscodeJob {
  private proc?: FfmpegProcess;

  constructor(spec: JobSpec) {
    super(spec);
    this.startEncoder();
  }

  delivered(baseUrl: string): DeliveredMedia {
    const fmp4 = this.spec.plan.segmentType === 'fmp4';
    return {
      contentType: 'application/x-mpegurl',
      streamType: this.spec.live ? 'LIVE' : 'BUFFERED',
      hlsSegmentFormat: fmp4 ? 'fmp4' : 'ts',
      hlsVideoSegmentFormat: fmp4 ? 'fmp4' : 'mpeg2_ts',
      duration: this.spec.live ? undefined : this.spec.duration,
      seekable: false,
      textTracks: this.textTracks(baseUrl),
    };
  }

  protected startEncoder(): void {
    this.proc?.kill();
    this.proc = this.spawn(managedArgs({ input: this.spec.input, plan: this.spec.plan, encoder: this.encoder, dir: this.dir, live: this.spec.live }));
  }

  protected encoderProcess(): FfmpegProcess | undefined {
    return this.proc;
  }

  private get finished(): boolean {
    return this.proc?.exitCode === 0;
  }

  async playlist(signal?: AbortSignal): Promise<string> {
    const path = join(this.dir, 'index.m3u8');
    const started = Date.now();
    // Wait until FFmpeg has listed at least one segment, so the receiver doesn't see an empty list.
    for (;;) {
      if (existsSync(path)) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes('#EXTINF')) return text;
      }
      if (this.failure) throw new Error(this.failure);
      if (signal?.aborted) throw new Error('aborted');
      if (Date.now() - started > WAIT_MS) throw new Error('Timed out waiting for FFmpeg');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async segment(name: string, signal?: AbortSignal): Promise<string> {
    if (!/^(seg-\d+\.(ts|m4s)|init\.mp4)$/.test(name)) throw new JobFileNotFound(name);
    const path = join(this.dir, name);
    await waitForFile(path, { timeoutMs: WAIT_MS, signal, failure: () => this.failure, idle: () => this.finished });
    return path;
  }

}

export class JobManager {
  private readonly jobs = new Map<string, TranscodeJob>();
  private readonly closing = new Set<TranscodeJob>();
  private readonly maxJobs: number;

  constructor(maxJobs = 2) {
    this.maxJobs = maxJobs;
  }

  create(sessionId: string, spec: JobSpec): TranscodeJob {
    this.close(sessionId);
    // Transcodes are CPU/GPU heavy: keep only the most recent few.
    while (this.jobs.size >= this.maxJobs) this.close(this.jobs.keys().next().value!);
    const segmented = spec.plan.video?.mode === 'encode' && !spec.live && !!spec.duration;
    const job = segmented ? new SegmentedJob(spec) : new ManagedJob(spec);
    this.jobs.set(sessionId, job);
    return job;
  }

  get(sessionId: string): TranscodeJob | undefined {
    return this.jobs.get(sessionId);
  }

  close(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (!job) return Promise.resolve();
    this.jobs.delete(sessionId);
    // Track jobs until their folder is gone, so shutdown can wait for (or force) the cleanup.
    this.closing.add(job);
    return job.close().finally(() => this.closing.delete(job));
  }

  /** Closes every job, including waiting for ones already being closed. */
  async closeAll(): Promise<void> {
    const pending = [...this.closing].map((job) => job.close());
    await Promise.all([...[...this.jobs.keys()].map((id) => this.close(id)), ...pending]);
  }

  /** Process-exit cleanup: no waiting possible. */
  closeAllNow(): void {
    for (const job of [...this.jobs.values(), ...this.closing]) job.closeNow();
    this.jobs.clear();
    this.closing.clear();
  }

  get size(): number {
    return this.jobs.size;
  }
}

/** Removes job directories left behind by a crashed companion. */
export function sweepStaleJobDirs(root = tmpdir(), maxAgeMs = 6 * 60 * 60_000, now = Date.now()): number {
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(JOB_DIR_PREFIX)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with another cleanup */
    }
  }
  return removed;
}
