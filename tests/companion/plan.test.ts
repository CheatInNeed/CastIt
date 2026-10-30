import { describe, expect, it } from 'vitest';
import { parseProbeJson, type ProbeInfo, type ProbedStream } from '../../apps/companion/src/ffmpeg.ts';
import {
  managedArgs,
  planMedia,
  segmentCount,
  segmentedArgs,
  subtitleArgs,
  summarizePlan,
  targetBitrate,
  variantPlayable,
  videoEncodeArgs,
  virtualPlaylist,
} from '../../apps/companion/src/plan.ts';

const stream = (s: Partial<ProbedStream> & Pick<ProbedStream, 'index' | 'type' | 'codec'>): ProbedStream => ({
  isDefault: false,
  attachedPic: false,
  ...s,
});

const h264 = stream({ index: 0, type: 'video', codec: 'h264', profile: 'High', level: 41, width: 1920, height: 1080, pixFmt: 'yuv420p', frameRate: 30 });
const hevc10 = stream({ index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', width: 3840, height: 2160, pixFmt: 'yuv420p10le', frameRate: 24 });
const aac = stream({ index: 1, type: 'audio', codec: 'aac', channels: 2 });
const ac3 = stream({ index: 1, type: 'audio', codec: 'ac3', channels: 6 });
const srt = stream({ index: 2, type: 'subtitle', codec: 'subrip', language: 'eng' });
const pgs = stream({ index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle' });

const probe = (formatName: string, streams: ProbedStream[], duration = 3600): ProbeInfo => ({ formatName, duration, streams });
const auto = { mode: 'auto', profile: 'compat', quality: 'auto' } as const;
const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';

describe('planMedia', () => {
  it('leaves receiver-compatible files alone', () => {
    const plan = planMedia(probe(MP4, [h264, aac]), { kind: 'progressive', extension: 'mp4' }, auto);
    expect(plan.action).toBe('direct');
  });

  it('remuxes compatible codecs out of an unsupported container (no re-encode)', () => {
    const plan = planMedia(probe('matroska,webm', [h264, aac, srt]), { kind: 'progressive', extension: 'mkv' }, auto);
    expect(plan).toMatchObject({ action: 'remux', video: { mode: 'copy' }, audio: { mode: 'copy' }, segmentType: 'mpegts' });
    expect(plan.reasons.join()).toMatch(/matroska container/);
    expect(plan.subtitles).toEqual([srt]);
  });

  it('converts only the audio when only the audio is the problem', () => {
    const plan = planMedia(probe(MP4, [h264, ac3]), { kind: 'progressive', extension: 'mp4' }, auto);
    expect(plan).toMatchObject({ action: 'transcode', video: { mode: 'copy' }, audio: { mode: 'encode', channels: 2 } });
    expect(plan.details).toContain('Dolby Digital (AC-3) 5.1 → AAC stereo');
  });

  it('transcodes HEVC 10-bit 4K for an older Chromecast and skips image subtitles', () => {
    const plan = planMedia(probe('matroska,webm', [hevc10, ac3, srt, pgs]), { kind: 'progressive', extension: 'mkv' }, auto);
    expect(plan.action).toBe('transcode');
    expect(plan.video).toMatchObject({ mode: 'encode', targetHeight: 1080 });
    expect(plan.reasons).toEqual(expect.arrayContaining(['HEVC video is not supported by this receiver', '2160p is above the 1080p limit']));
    expect(plan.subtitles).toEqual([srt]);
    expect(plan.details.join()).toMatch(/image-based subtitle/);
  });

  it('copies HEVC (into fMP4 segments) for receivers that decode it', () => {
    const plan = planMedia(probe('matroska,webm', [hevc10, aac]), { kind: 'progressive', extension: 'mkv' }, { ...auto, profile: 'ultra' });
    expect(plan).toMatchObject({ action: 'remux', video: { mode: 'copy' }, segmentType: 'fmp4' });
  });

  it('keeps Dolby Digital on Google TV, converts it elsewhere', () => {
    expect(planMedia(probe(MP4, [h264, ac3]), { kind: 'progressive', extension: 'mp4' }, { ...auto, profile: 'google-tv' }).action).toBe('direct');
  });

  it('honours a quality cap and forced conversion', () => {
    const capped = planMedia(probe(MP4, [h264, aac]), { kind: 'progressive', extension: 'mp4' }, { ...auto, quality: '720p' });
    expect(capped.video).toMatchObject({ mode: 'encode', targetHeight: 720 });
    const forced = planMedia(probe(MP4, [h264, aac]), { kind: 'progressive', extension: 'mp4' }, { ...auto, mode: 'force' });
    expect(forced.action).toBe('remux');
    expect(forced.reasons).toEqual(['conversion was requested']);
  });

  it('flags H.264 profiles and levels the receiver cannot decode, and interlacing', () => {
    const hi10 = { ...h264, profile: 'High 10', pixFmt: 'yuv420p10le' };
    expect(planMedia(probe(MP4, [hi10, aac]), { kind: 'progressive', extension: 'mp4' }, auto).video?.mode).toBe('encode');
    const level51 = { ...h264, level: 51 };
    expect(planMedia(probe(MP4, [level51, aac]), { kind: 'progressive', extension: 'mp4' }, auto).reasons.join()).toMatch(/level 5.1/);
    const interlaced = { ...h264, fieldOrder: 'tt' };
    expect(planMedia(probe(MP4, [interlaced, aac]), { kind: 'progressive', extension: 'mp4' }, auto).video).toMatchObject({ mode: 'encode', deinterlace: true });
  });

  it('treats HLS inputs as container-compatible and picks the best variant within the limit', () => {
    const v720 = { ...h264, index: 0, height: 720 };
    const v1080 = { ...h264, index: 2, height: 1080 };
    const v2160 = { ...hevc10, index: 4 };
    const plan = planMedia(probe('hls', [v720, aac, v1080, v2160]), { kind: 'hls' }, { ...auto, mode: 'force' });
    expect(plan.video?.stream.index).toBe(2);
  });

  it('ignores cover art and handles audio-only files', () => {
    const cover = stream({ index: 0, type: 'video', codec: 'mjpeg', attachedPic: true, height: 500 });
    const flacFile = probe('flac', [cover, stream({ index: 1, type: 'audio', codec: 'flac', channels: 2 })]);
    expect(planMedia(flacFile, { kind: 'progressive', extension: 'flac' }, auto).action).toBe('direct');
    const wma = probe('asf', [stream({ index: 0, type: 'audio', codec: 'wmav2', channels: 2 })]);
    expect(planMedia(wma, { kind: 'progressive', extension: 'wma' }, auto)).toMatchObject({ action: 'transcode', audio: { mode: 'encode' } });
  });

  it('summarises for the popup', () => {
    const plan = planMedia(probe('matroska,webm', [hevc10, ac3, srt]), { kind: 'progressive', extension: 'mkv' }, auto);
    expect(summarizePlan(plan, { name: 'h264_videotoolbox', hardware: true })).toMatchObject({
      action: 'transcode',
      video: 'encode',
      audio: 'encode',
      encoder: 'h264_videotoolbox',
      subtitles: 1,
    });
  });
});

describe('variantPlayable', () => {
  it('judges HLS variants by codecs and resolution per receiver', () => {
    const hevc4k = 'BANDWIDTH=1,RESOLUTION=3840x1604,CODECS="hvc1.2.4.L153.B0,mp4a.40.2"';
    expect(variantPlayable('BANDWIDTH=1,RESOLUTION=1920x802,CODECS="avc1.640028,mp4a.40.2"', 'compat')).toBe(true);
    expect(variantPlayable(hevc4k, 'compat')).toBe(false);
    expect(variantPlayable(hevc4k, 'google-tv')).toBe(true);
    expect(variantPlayable('BANDWIDTH=1,CODECS="avc1.640028,ec-3"', 'compat')).toBe(false);
    expect(variantPlayable('BANDWIDTH=1', 'compat')).toBe(true);
  });
});

describe('bitrate', () => {
  it('scales with resolution and never far exceeds the source', () => {
    expect(targetBitrate(1080)).toBe(6.5e6);
    expect(targetBitrate(720)).toBe(4e6);
    expect(targetBitrate(1080, 2e6)).toBe(2.2e6);
    expect(targetBitrate(480, 100_000)).toBe(800_000);
  });
});

describe('FFmpeg arguments', () => {
  const plan = planMedia(probe('matroska,webm', [hevc10, ac3, srt]), { kind: 'progressive', extension: 'mkv' }, auto);

  it('builds segmented transcodes that can start at any segment on the absolute timeline', () => {
    const args = segmentedArgs({ input: 'http://127.0.0.1:1/m/x/a.mkv', plan, encoder: { name: 'libx264', hardware: false }, dir: '/tmp/j', segmentSeconds: 4, startSegment: 25 });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(at('-ss')).toBe('100.000');
    expect(at('-start_number')).toBe('25');
    expect(at('-output_ts_offset')).toBe('100');
    expect(at('-force_key_frames')).toBe('expr:gte(t,n_forced*4)');
    expect(at('-c:v')).toBe('libx264');
    expect(at('-vf')).toBe('scale=-2:1080,format=yuv420p');
    expect(at('-c:a')).toBe('aac');
    expect(at('-ac')).toBe('2');
    expect(at('-af')).toBe('aresample=async=1');
    expect(args).toEqual(expect.arrayContaining(['-map', '0:0', '-map', '0:1', '-sn', '-reconnect']));
    expect(args.at(-1)).toBe('/tmp/j/ffmpeg.m3u8');
  });

  it('uses each hardware encoder with the pixel format it needs', () => {
    expect(videoEncodeArgs(plan.video!, { name: 'h264_videotoolbox', hardware: true })).toMatchObject({
      filters: ['scale=-2:1080', 'format=nv12'],
      args: expect.arrayContaining(['-c:v', 'h264_videotoolbox', '-allow_sw', '1']),
    });
    expect(videoEncodeArgs(plan.video!, { name: 'h264_vaapi', hardware: true }).filters.slice(-2)).toEqual(['format=nv12', 'hwupload']);
    expect(videoEncodeArgs(plan.video!, { name: 'h264_nvenc', hardware: true }).args).toContain('h264_nvenc');
  });

  it('builds managed remux / live playlists', () => {
    const remux = planMedia(probe('matroska,webm', [h264, aac]), { kind: 'progressive', extension: 'mkv' }, auto);
    const vod = managedArgs({ input: 'in', plan: remux, encoder: { name: 'libx264', hardware: false }, dir: '/tmp/j', live: false });
    expect(vod).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy', '-hls_playlist_type', 'event']));
    expect(vod).not.toContain('-force_key_frames');
    const live = managedArgs({ input: 'in', plan: remux, encoder: { name: 'libx264', hardware: false }, dir: '/tmp/j', live: true });
    expect(live).toEqual(expect.arrayContaining(['-hls_list_size', '8', '-hls_flags', 'delete_segments+temp_file+independent_segments']));
  });

  it('extracts text subtitles to WebVTT', () => {
    expect(subtitleArgs({ input: 'in', streams: [srt], dir: '/tmp/j' })).toEqual(expect.arrayContaining(['-map', '0:2', '-c:s', 'webvtt', '/tmp/j/subs-0.vtt.part']));
  });
});

describe('virtual playlist', () => {
  it('lists every segment up front with an exact final length', () => {
    const text = virtualPlaylist(10.5, 4);
    expect(segmentCount(10.5, 4)).toBe(3);
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(text.match(/#EXTINF/g)).toHaveLength(3);
    expect(text).toContain('#EXTINF:2.500,\nseg-2.ts');
    expect(text.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(segmentCount(8, 4)).toBe(2);
    // A 0.02 s tail is folded into the last real segment.
    expect(segmentCount(20.02, 4)).toBe(5);
    expect(virtualPlaylist(20.02, 4)).toContain('#EXTINF:4.020,\nseg-4.ts');
  });
});

describe('parseProbeJson', () => {
  it('normalises ffprobe output', () => {
    const info = parseProbeJson(
      JSON.stringify({
        format: { format_name: 'matroska,webm', duration: '120.5', bit_rate: '4000000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 150, width: 3840, height: 2160, pix_fmt: 'yuv420p10le', avg_frame_rate: '24000/1001', disposition: { default: 1 } },
          { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '48000', tags: { language: 'eng' } },
          { index: 2, codec_type: 'attachment', codec_name: 'ttf' },
        ],
      }),
    );
    expect(info).toMatchObject({ formatName: 'matroska,webm', duration: 120.5, bitRate: 4e6 });
    expect(info.streams[0]).toMatchObject({ type: 'video', codec: 'hevc', frameRate: 23.976, isDefault: true });
    expect(info.streams[1]).toMatchObject({ type: 'audio', channels: 6, sampleRate: 48000, language: 'eng' });
    expect(info.streams[2]!.type).toBe('other');
  });
});
