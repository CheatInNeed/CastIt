// Pure media planning: what a given Cast receiver can play, the least work needed to make a
// stream playable (nothing → remux → audio-only encode → full transcode), and the FFmpeg
// arguments for it. No I/O here, so every decision is unit-testable.
import { join } from 'node:path';
import type { MediaPlanSummary, ReceiverProfile, TranscodeOptions } from '@castit/shared';
import { hardwareInitArgs, type EncoderInfo, type ProbeInfo, type ProbedStream } from './ffmpeg.ts';

interface VideoSupport {
  tenBit: boolean;
  /** Max H.264 level ×10 (e.g. 42 = 4.2). */
  maxLevel?: number;
}

interface ReceiverCapabilities {
  video: Record<string, VideoSupport>;
  maxHeight: number;
  maxFps: number;
  audio: string[];
  maxAudioChannels: number;
}

const BASE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

export const RECEIVER_CAPABILITIES: Record<ReceiverProfile, ReceiverCapabilities> = {
  compat: {
    video: { h264: { tenBit: false, maxLevel: 42 }, vp8: { tenBit: false } },
    maxHeight: 1080,
    maxFps: 60,
    audio: BASE_AUDIO,
    maxAudioChannels: 2,
  },
  ultra: {
    video: { h264: { tenBit: false, maxLevel: 52 }, hevc: { tenBit: true }, vp9: { tenBit: true }, vp8: { tenBit: false } },
    maxHeight: 2160,
    maxFps: 60,
    audio: BASE_AUDIO,
    maxAudioChannels: 6,
  },
  'google-tv': {
    video: { h264: { tenBit: false, maxLevel: 52 }, hevc: { tenBit: true }, vp9: { tenBit: true }, vp8: { tenBit: false } },
    maxHeight: 2160,
    maxFps: 60,
    audio: [...BASE_AUDIO, 'ac3', 'eac3'],
    maxAudioChannels: 8,
  },
  'gtv-streamer': {
    video: { h264: { tenBit: false, maxLevel: 52 }, hevc: { tenBit: true }, vp9: { tenBit: true }, vp8: { tenBit: false }, av1: { tenBit: true } },
    maxHeight: 2160,
    maxFps: 60,
    audio: [...BASE_AUDIO, 'ac3', 'eac3'],
    maxAudioChannels: 8,
  },
};

const QUALITY_HEIGHT: Record<TranscodeOptions['quality'], number | undefined> = {
  auto: undefined,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4 Part 2', mpeg2video: 'MPEG-2',
  msmpeg4v3: 'DivX 3', wmv3: 'WMV', vc1: 'VC-1', flv1: 'Sorenson/FLV', theora: 'Theora',
  aac: 'AAC', mp3: 'MP3', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)', dts: 'DTS', truehd: 'Dolby TrueHD',
  opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', wmav2: 'WMA', pcm_s16le: 'PCM', mp2: 'MPEG audio layer 2',
};
const codecName = (c: string) => CODEC_NAMES[c] ?? c.toUpperCase();

const H264_PROFILES = /^(baseline|constrained baseline|main|high|extended)$/i;
const EIGHT_BIT = /^(yuv420p|yuvj420p|nv12)$/;
const INTERLACED = /^(tt|bb|tb|bt)$/;
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'subviewer', 'microdvd']);

/** Audio codecs FFmpeg can copy into HLS segments that Cast receivers read. */
const HLS_AUDIO_COPY: Record<'mpegts' | 'fmp4', string[]> = {
  mpegts: ['aac', 'mp3', 'ac3', 'eac3'],
  fmp4: ['aac', 'ac3', 'eac3'],
};

export interface VideoPlan {
  stream: ProbedStream;
  mode: 'copy' | 'encode';
  targetHeight?: number;
  bitrate?: number;
  deinterlace: boolean;
  fps?: number;
}

export interface AudioPlan {
  stream: ProbedStream;
  mode: 'copy' | 'encode';
  channels: number;
  bitrate: number;
}

export interface MediaPlan {
  action: 'direct' | 'remux' | 'transcode';
  video?: VideoPlan;
  audio?: AudioPlan;
  subtitles: ProbedStream[];
  segmentType: 'mpegts' | 'fmp4';
  reasons: string[];
  details: string[];
}

export interface PlanInput {
  kind: 'hls' | 'dash' | 'progressive' | 'unknown';
  /** Lower-case file extension of the upstream URL path, if any. */
  extension?: string;
}

function pickVideo(streams: ProbedStream[], maxHeight: number): ProbedStream | undefined {
  const videos = streams.filter((s) => s.type === 'video' && !s.attachedPic);
  const fitting = videos.filter((s) => (s.height ?? 0) <= maxHeight);
  const pool = fitting.length ? fitting : videos;
  // Highest resolution within the limit (adaptive inputs expose every variant as a stream).
  return [...pool].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitRate ?? 0) - (a.bitRate ?? 0) || a.index - b.index)[0];
}

function pickAudio(streams: ProbedStream[]): ProbedStream | undefined {
  const audios = streams.filter((s) => s.type === 'audio');
  return audios.find((s) => s.isDefault) ?? audios[0];
}

/** Why the receiver can't decode this video stream (empty = it can). */
export function videoProblems(v: ProbedStream, caps: ReceiverCapabilities, capHeight: number): string[] {
  const problems: string[] = [];
  const support = caps.video[v.codec];
  if (!support) problems.push(`${codecName(v.codec)} video is not supported by this receiver`);
  else if (v.codec === 'h264') {
    if (v.profile && !H264_PROFILES.test(v.profile)) problems.push(`H.264 ${v.profile} profile is not supported`);
    if (v.level && support.maxLevel && v.level > support.maxLevel) problems.push(`H.264 level ${v.level / 10} is too high`);
  }
  if (support && v.pixFmt && !EIGHT_BIT.test(v.pixFmt) && !support.tenBit) problems.push(`${v.pixFmt} (10-bit or 4:2:2/4:4:4) video is not supported`);
  if ((v.height ?? 0) > capHeight) problems.push(`${v.height}p is above the ${capHeight}p limit`);
  if ((v.frameRate ?? 0) > caps.maxFps + 0.5) problems.push(`${Math.round(v.frameRate!)} fps is above ${caps.maxFps} fps`);
  if (v.fieldOrder && INTERLACED.test(v.fieldOrder)) problems.push('interlaced video');
  return problems;
}

export function audioProblems(a: ProbedStream, caps: ReceiverCapabilities): string[] {
  const problems: string[] = [];
  if (!caps.audio.includes(a.codec)) problems.push(`${codecName(a.codec)} audio is not supported by this receiver`);
  else if ((a.channels ?? 2) > caps.maxAudioChannels) problems.push(`${a.channels}-channel audio is above ${caps.maxAudioChannels} channels`);
  return problems;
}

/** Can the receiver open the source container as a single progressive file / adaptive stream? */
export function containerPlayable(probe: ProbeInfo, input: PlanInput, video?: ProbedStream, audio?: ProbedStream): boolean {
  if (input.kind === 'hls' || input.kind === 'dash') return true;
  const ext = input.extension ?? '';
  if (/mp4|mov/.test(probe.formatName) && ['', 'mp4', 'm4v', 'mov', 'm4a'].includes(ext)) return true;
  if (/webm|matroska/.test(probe.formatName) && ext === 'webm') {
    return (!video || ['vp8', 'vp9', 'av1'].includes(video.codec)) && (!audio || ['opus', 'vorbis'].includes(audio.codec));
  }
  if (probe.formatName === 'mp3' || probe.formatName === 'flac' || probe.formatName === 'ogg') return !video;
  return false;
}

/** Target video bitrate (bits/s) by output height, never far above the source's own rate. */
export function targetBitrate(height: number, sourceBitrate?: number): number {
  const table = height >= 2000 ? 16e6 : height >= 1400 ? 10e6 : height >= 1000 ? 6.5e6 : height >= 700 ? 4e6 : height >= 460 ? 2e6 : 1.2e6;
  if (!sourceBitrate) return table;
  return Math.max(800_000, Math.min(table, Math.round(sourceBitrate * 1.1)));
}

const pretty = (s: ProbedStream) =>
  s.type === 'video'
    ? `${codecName(s.codec)}${s.height ? ` ${s.height}p` : ''}${s.pixFmt && !EIGHT_BIT.test(s.pixFmt) ? ' 10-bit' : ''}`
    : `${codecName(s.codec)}${s.channels ? ` ${s.channels === 6 ? '5.1' : s.channels === 8 ? '7.1' : s.channels === 2 ? 'stereo' : s.channels === 1 ? 'mono' : `${s.channels}ch`}` : ''}`;

export function planMedia(probe: ProbeInfo, input: PlanInput, options: Pick<TranscodeOptions, 'profile' | 'quality' | 'mode'>): MediaPlan {
  const caps = RECEIVER_CAPABILITIES[options.profile];
  const capHeight = Math.min(caps.maxHeight, QUALITY_HEIGHT[options.quality] ?? caps.maxHeight);
  const video = pickVideo(probe.streams, capHeight);
  const audio = pickAudio(probe.streams);
  const reasons: string[] = [];
  const details: string[] = [];

  if (!video && !audio) {
    return { action: 'direct', subtitles: [], segmentType: 'mpegts', reasons: ['No audio or video streams were found.'], details };
  }

  const vProblems = video ? videoProblems(video, caps, capHeight) : [];
  const aProblems = audio ? audioProblems(audio, caps) : [];
  const containerOk = containerPlayable(probe, input, video, audio);
  reasons.push(...vProblems, ...aProblems);
  if (!containerOk) reasons.push(`the ${probe.formatName.split(',')[0]} container is not supported for direct playback`);

  const subtitles = probe.streams.filter((s) => s.type === 'subtitle' && TEXT_SUBTITLES.has(s.codec)).slice(0, 8);
  const imageSubs = probe.streams.filter((s) => s.type === 'subtitle' && !TEXT_SUBTITLES.has(s.codec));
  if (imageSubs.length) details.push(`${imageSubs.length} image-based subtitle track(s) (PGS/DVD) can't be converted to text and are skipped`);

  if (vProblems.length === 0 && aProblems.length === 0 && containerOk && options.mode !== 'force') {
    return { action: 'direct', subtitles: [], segmentType: 'mpegts', reasons: ['The receiver can play this stream as it is.'], details };
  }

  // Least work first: copy video when the receiver decodes it and HLS can carry it.
  const copyVideo = !!video && vProblems.length === 0 && (video.codec === 'h264' || (video.codec === 'hevc' && !!caps.video.hevc));
  const segmentType: MediaPlan['segmentType'] = copyVideo && video!.codec === 'hevc' ? 'fmp4' : 'mpegts';
  const copyAudio = !!audio && aProblems.length === 0 && HLS_AUDIO_COPY[segmentType].includes(audio.codec);

  let videoPlan: VideoPlan | undefined;
  if (video) {
    if (copyVideo) {
      videoPlan = { stream: video, mode: 'copy', deinterlace: false };
      details.push(`video copied (${pretty(video)})`);
    } else {
      const targetHeight = Math.min(video.height ?? capHeight, capHeight);
      const fps = (video.frameRate ?? 0) > caps.maxFps + 0.5 ? Math.min(caps.maxFps, 30) : undefined;
      videoPlan = {
        stream: video,
        mode: 'encode',
        targetHeight,
        bitrate: targetBitrate(targetHeight, video.bitRate ?? (probe.bitRate ? probe.bitRate * 0.9 : undefined)),
        deinterlace: !!video.fieldOrder && INTERLACED.test(video.fieldOrder),
        fps,
      };
      details.push(`${pretty(video)} → H.264 ${targetHeight}p`);
    }
  }

  let audioPlan: AudioPlan | undefined;
  if (audio) {
    if (copyAudio) {
      audioPlan = { stream: audio, mode: 'copy', channels: audio.channels ?? 2, bitrate: 0 };
      details.push(`audio copied (${pretty(audio)})`);
    } else {
      const channels = Math.min(audio.channels ?? 2, caps.maxAudioChannels, 6);
      audioPlan = { stream: audio, mode: 'encode', channels, bitrate: channels > 2 ? 384_000 : 192_000 };
      details.push(`${pretty(audio)} → AAC ${channels > 2 ? `${channels === 6 ? '5.1' : `${channels}ch`}` : 'stereo'}`);
    }
  }
  if (subtitles.length) details.push(`${subtitles.length} subtitle track(s) converted to WebVTT`);

  const encodes = videoPlan?.mode === 'encode' || audioPlan?.mode === 'encode';
  if (options.mode === 'force' && reasons.length === 0) reasons.push('conversion was requested');
  return { action: encodes ? 'transcode' : 'remux', video: videoPlan, audio: audioPlan, subtitles, segmentType, reasons, details };
}

export function summarizePlan(plan: MediaPlan, encoder?: EncoderInfo): MediaPlanSummary {
  return {
    action: plan.action,
    video: plan.video?.mode ?? 'none',
    audio: plan.audio?.mode ?? 'none',
    details: plan.details,
    reasons: plan.reasons,
    encoder: plan.video?.mode === 'encode' ? encoder?.name : undefined,
    subtitles: plan.subtitles.length,
  };
}

// ---------------------------------------------------------------- FFmpeg arguments

const kbps = (bits: number) => `${Math.round(bits / 1000)}k`;

function h264Level(height: number, fps: number): string {
  if (height > 1080) return '5.1';
  return fps > 30 && height >= 1080 ? '4.2' : '4.1';
}

/** Video encoder arguments for the chosen encoder, plus filters it needs. */
export function videoEncodeArgs(v: VideoPlan, encoder: EncoderInfo): { filters: string[]; args: string[] } {
  const filters: string[] = [];
  if (v.deinterlace) filters.push('yadif=0:-1:0');
  if (v.targetHeight && (v.stream.height ?? 0) > v.targetHeight) filters.push(`scale=-2:${v.targetHeight}`);
  if (v.fps) filters.push(`fps=${v.fps}`);
  const bitrate = v.bitrate ?? 4e6;
  const rate = ['-b:v', kbps(bitrate), '-maxrate', kbps(bitrate * 1.5), '-bufsize', kbps(bitrate * 2)];
  const fps = v.fps ?? v.stream.frameRate ?? 30;
  const level = h264Level(v.targetHeight ?? v.stream.height ?? 1080, fps);

  switch (encoder.name) {
    case 'h264_videotoolbox':
      filters.push('format=nv12');
      return { filters, args: ['-c:v', 'h264_videotoolbox', ...rate, '-profile:v', 'high', '-allow_sw', '1'] };
    case 'h264_nvenc':
      filters.push('format=yuv420p');
      return { filters, args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', ...rate, '-profile:v', 'high', '-level:v', level] };
    case 'h264_qsv':
      filters.push('format=nv12');
      return { filters, args: ['-c:v', 'h264_qsv', '-preset', 'faster', ...rate, '-profile:v', 'high'] };
    case 'h264_amf':
      filters.push('format=nv12');
      return { filters, args: ['-c:v', 'h264_amf', '-quality', 'speed', ...rate, '-profile:v', 'high'] };
    case 'h264_vaapi':
      filters.push('format=nv12', 'hwupload');
      return { filters, args: ['-c:v', 'h264_vaapi', ...rate, '-profile:v', 'high'] };
    default:
      filters.push('format=yuv420p');
      return {
        filters,
        args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', kbps(bitrate * 1.5), '-bufsize', kbps(bitrate * 2), '-profile:v', 'high', '-level:v', level],
      };
  }
}

function streamArgs(plan: MediaPlan, encoder: EncoderInfo): string[] {
  const args: string[] = [];
  if (plan.video) args.push('-map', `0:${plan.video.stream.index}`);
  if (plan.audio) args.push('-map', `0:${plan.audio.stream.index}`);
  args.push('-sn', '-dn');

  if (plan.video?.mode === 'copy') args.push('-c:v', 'copy');
  else if (plan.video) {
    const { filters, args: enc } = videoEncodeArgs(plan.video, encoder);
    if (filters.length) args.push('-vf', filters.join(','));
    args.push(...enc);
  }

  if (plan.audio?.mode === 'copy') args.push('-c:a', 'copy');
  else if (plan.audio) {
    // aresample=async keeps audio locked to video timestamps across gaps and seeks.
    args.push('-c:a', 'aac', '-b:a', kbps(plan.audio.bitrate), '-ac', String(plan.audio.channels), '-af', 'aresample=async=1');
  }
  args.push('-max_muxing_queue_size', '4096');
  return args;
}

function inputArgs(input: string, encoder: EncoderInfo, plan: MediaPlan, seek?: number): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (plan.video?.mode === 'encode') args.push(...hardwareInitArgs(encoder.name));
  if (/^https?:/.test(input)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (seek && seek > 0) args.push('-ss', seek.toFixed(3));
  args.push('-i', input);
  return args;
}

/**
 * Segmented VOD transcode: fixed-length segments with keyframes forced on every boundary, so a
 * complete VOD playlist can be published up front and any segment can be (re)generated on demand
 * by restarting at `startSegment`. Timestamps are shifted to the absolute timeline.
 */
export function segmentedArgs(o: {
  input: string;
  plan: MediaPlan;
  encoder: EncoderInfo;
  dir: string;
  segmentSeconds: number;
  startSegment: number;
}): string[] {
  const start = o.startSegment * o.segmentSeconds;
  return [
    ...inputArgs(o.input, o.encoder, o.plan, start),
    ...streamArgs(o.plan, o.encoder),
    '-force_key_frames', `expr:gte(t,n_forced*${o.segmentSeconds})`,
    '-output_ts_offset', String(start),
    '-f', 'hls',
    '-hls_time', String(o.segmentSeconds),
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-start_number', String(o.startSegment),
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', join(o.dir, 'seg-%d.ts'),
    join(o.dir, 'ffmpeg.m3u8'),
  ];
}

/**
 * FFmpeg-managed playlist: used for remuxing (video copied, so segment boundaries follow the
 * source's keyframes), for live inputs (sliding window) and when the duration is unknown.
 */
export function managedArgs(o: { input: string; plan: MediaPlan; encoder: EncoderInfo; dir: string; live: boolean }): string[] {
  const fmp4 = o.plan.segmentType === 'fmp4';
  return [
    ...inputArgs(o.input, o.encoder, o.plan),
    ...streamArgs(o.plan, o.encoder),
    ...(o.plan.video?.mode === 'encode' ? ['-force_key_frames', 'expr:gte(t,n_forced*4)'] : []),
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_segment_type', fmp4 ? 'fmp4' : 'mpegts',
    ...(fmp4 ? ['-hls_fmp4_init_filename', 'init.mp4'] : []),
    ...(o.live
      ? ['-hls_list_size', '8', '-hls_flags', 'delete_segments+temp_file+independent_segments']
      : ['-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file+independent_segments']),
    '-hls_segment_filename', join(o.dir, fmp4 ? 'seg-%d.m4s' : 'seg-%d.ts'),
    join(o.dir, 'index.m3u8'),
  ];
}

/** Extracts text subtitle streams to WebVTT files subs-<n>.vtt (n = position in plan.subtitles). */
export function subtitleArgs(o: { input: string; streams: ProbedStream[]; dir: string }): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (/^https?:/.test(o.input)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-i', o.input);
  o.streams.forEach((s, n) => args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', join(o.dir, `subs-${n}.vtt.part`)));
  return args;
}

/** Virtual VOD playlist listing every segment of a segmented transcode up front. */
export function virtualPlaylist(duration: number, segmentSeconds: number): string {
  const count = segmentCount(duration, segmentSeconds);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let i = 0; i < count; i++) {
    const length = i === count - 1 ? duration - i * segmentSeconds : segmentSeconds;
    lines.push(`#EXTINF:${length.toFixed(3)},`, `seg-${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Remainders shorter than this are folded into the previous segment (FFmpeg may not emit them). */
const MIN_TAIL_SECONDS = 0.5;

export function segmentCount(duration: number, segmentSeconds: number): number {
  return Math.max(1, Math.ceil((duration - MIN_TAIL_SECONDS) / segmentSeconds - 1e-6));
}
