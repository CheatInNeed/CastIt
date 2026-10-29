// FFmpeg discovery (binary, version, working hardware H.264 encoder) and ffprobe analysis.
// Processes are always spawned with argument arrays (never a shell), so URLs cannot inject commands.
import { spawn } from 'node:child_process';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

export interface EncoderInfo {
  /** FFmpeg encoder name, e.g. h264_videotoolbox or libx264. */
  name: string;
  hardware: boolean;
}

export interface FfmpegCapabilities {
  available: boolean;
  version?: string;
  /** Best working H.264 encoder (hardware preferred). */
  encoder: EncoderInfo;
  /** Demuxers relevant to streaming inputs. */
  demuxers: { hls: boolean; dash: boolean };
  error?: string;
}

export const SOFTWARE_ENCODER: EncoderInfo = { name: 'libx264', hardware: false };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a short-lived process with a timeout; output is capped. */
export function run(command: string, args: string[], timeoutMs = 15_000, maxOutput = 4 * 1024 * 1024): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Hardware H.264 encoders to try, best first, per platform. */
export function hardwareEncoderCandidates(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'darwin':
      return ['h264_videotoolbox'];
    case 'win32':
      return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    default:
      return ['h264_nvenc', 'h264_vaapi', 'h264_qsv'];
  }
}

/** Extra arguments some hardware encoders need around the encoder itself. */
export function hardwareInitArgs(encoder: string): string[] {
  return encoder === 'h264_vaapi' ? ['-vaapi_device', '/dev/dri/renderD128'] : [];
}

/**
 * Detects FFmpeg and picks an encoder. Listing an encoder doesn't mean the hardware is present,
 * so each candidate is verified with a tiny real encode.
 */
export async function detectFfmpeg(paths: FfmpegPaths, platform = process.platform): Promise<FfmpegCapabilities> {
  const version = await run(paths.ffmpeg, ['-hide_banner', '-version'], 5000);
  if (version.code !== 0) {
    return {
      available: false,
      encoder: SOFTWARE_ENCODER,
      demuxers: { hls: false, dash: false },
      error: `FFmpeg not found (${paths.ffmpeg}). Install it to enable transcoding.`,
    };
  }
  const probe = await run(paths.ffprobe, ['-hide_banner', '-version'], 5000);
  if (probe.code !== 0) {
    return { available: false, encoder: SOFTWARE_ENCODER, demuxers: { hls: false, dash: false }, error: `ffprobe not found (${paths.ffprobe}).` };
  }
  const [encoders, demuxers] = await Promise.all([
    run(paths.ffmpeg, ['-hide_banner', '-encoders'], 5000),
    run(paths.ffmpeg, ['-hide_banner', '-demuxers'], 5000),
  ]);
  const listed = (name: string) => new RegExp(`\\s${name}\\s`).test(encoders.stdout);

  let encoder = SOFTWARE_ENCODER;
  for (const candidate of hardwareEncoderCandidates(platform)) {
    if (!listed(candidate)) continue;
    const test = await run(
      paths.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        ...hardwareInitArgs(candidate),
        '-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.2',
        ...(candidate === 'h264_vaapi' ? ['-vf', 'format=nv12,hwupload'] : []),
        '-frames:v', '3', '-c:v', candidate, '-f', 'null', '-',
      ],
      10_000,
    );
    if (test.code === 0) {
      encoder = { name: candidate, hardware: true };
      break;
    }
  }
  if (!encoder.hardware && !listed('libx264')) {
    return {
      available: false,
      encoder,
      demuxers: { hls: false, dash: false },
      error: 'FFmpeg has no H.264 encoder (libx264) and no working hardware encoder.',
    };
  }

  return {
    available: true,
    version: /ffmpeg version (\S+)/.exec(version.stdout)?.[1],
    encoder,
    demuxers: { hls: /\shls\s/.test(demuxers.stdout), dash: /\sdash\s/.test(demuxers.stdout) },
  };
}

// ---------------------------------------------------------------- ffprobe

export interface ProbedStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  profile?: string;
  /** H.264/HEVC level as reported by FFmpeg (e.g. 41 for 4.1, 150 for HEVC 5.0). */
  level?: number;
  width?: number;
  height?: number;
  pixFmt?: string;
  frameRate?: number;
  fieldOrder?: string;
  channels?: number;
  sampleRate?: number;
  bitRate?: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  /** Cover art embedded as a video stream. */
  attachedPic: boolean;
}

export interface ProbeInfo {
  formatName: string;
  duration?: number;
  bitRate?: number;
  streams: ProbedStream[];
}

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  field_order?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

function rate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [n, d] = value.split('/').map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

const num = (v: string | number | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Normalises `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeJson(json: string): ProbeInfo {
  const data = JSON.parse(json) as { format?: Record<string, string>; streams?: RawStream[] };
  const streams: ProbedStream[] = (data.streams ?? []).map((s) => {
    const type = s.codec_type === 'video' || s.codec_type === 'audio' || s.codec_type === 'subtitle' ? s.codec_type : 'other';
    return {
      index: s.index,
      type,
      codec: (s.codec_name ?? 'unknown').toLowerCase(),
      profile: s.profile,
      level: s.level !== undefined && s.level >= 0 ? s.level : undefined,
      width: s.width,
      height: s.height,
      pixFmt: s.pix_fmt,
      frameRate: rate(s.avg_frame_rate) ?? rate(s.r_frame_rate),
      fieldOrder: s.field_order,
      channels: s.channels,
      sampleRate: num(s.sample_rate),
      bitRate: num(s.bit_rate),
      language: s.tags?.language,
      title: s.tags?.title,
      isDefault: s.disposition?.default === 1,
      attachedPic: s.disposition?.attached_pic === 1,
    };
  });
  const duration = num(data.format?.duration);
  return {
    formatName: data.format?.format_name ?? 'unknown',
    duration: duration && duration > 0 ? duration : undefined,
    bitRate: num(data.format?.bit_rate),
    streams,
  };
}

export async function probeMedia(paths: FfmpegPaths, input: string, timeoutMs = 25_000): Promise<ProbeInfo> {
  const result = await run(
    paths.ffprobe,
    [
      '-hide_banner', '-v', 'error',
      '-probesize', '10M', '-analyzeduration', '10M',
      '-print_format', 'json', '-show_format', '-show_streams',
      input,
    ],
    timeoutMs,
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').pop() || (result.code === null ? 'timed out' : `exit code ${result.code}`);
    throw new Error(`FFmpeg could not read the stream: ${reason}`);
  }
  return parseProbeJson(result.stdout);
}
