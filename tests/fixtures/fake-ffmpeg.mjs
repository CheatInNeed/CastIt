// Stand-in for the ffmpeg binary in tests. Understands just enough of Castit's arguments to
// produce HLS segments / playlists / WebVTT files, and logs every invocation.
//   FAKE_FFMPEG_LOG   file to append one JSON line (the argv) per run
//   FAKE_TOTAL        total segments of the media (default 30)
//   FAKE_INTERVAL_MS  delay between segments (default 30)
//   FAKE_FAIL_HW=1    exit 1 when a hardware encoder is requested
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify(args)}\n`);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (process.env.FAKE_FAIL_HW === '1' && /_(videotoolbox|nvenc|qsv|vaapi|amf)$/.test(value('-c:v') ?? '')) {
  process.stderr.write('Error: hardware encoder unavailable\n');
  process.exit(1);
}

if (args.includes('webvtt')) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' && args[i + 1] === 'webvtt') writeFileSync(args[i + 2], 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
  }
  process.exit(0);
}

const pattern = value('-hls_segment_filename');
if (!pattern) process.exit(0);
const playlist = args.at(-1);
const total = Number(process.env.FAKE_TOTAL ?? 30);
const interval = Number(process.env.FAKE_INTERVAL_MS ?? 30);
let n = Number(value('-start_number') ?? 0);
const listed = [];

const timer = setInterval(() => {
  if (n >= total) {
    clearInterval(timer);
    if (value('-hls_playlist_type') === 'event') writeList(true);
    process.exit(0);
  }
  const file = pattern.replace('%d', String(n));
  writeFileSync(`${file}.tmp`, Buffer.alloc(188, 0x47));
  renameSync(`${file}.tmp`, file);
  listed.push(file);
  n++;
  writeList(false);
}, interval);

function writeList(ended) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:EVENT'];
  for (const file of listed) lines.push('#EXTINF:4.000000,', file.slice(dirname(file).length + 1));
  if (ended) lines.push('#EXT-X-ENDLIST');
  writeFileSync(join(dirname(playlist), 'tmp.m3u8'), `${lines.join('\n')}\n`);
  renameSync(join(dirname(playlist), 'tmp.m3u8'), playlist);
}

process.on('SIGTERM', () => process.exit(143));
