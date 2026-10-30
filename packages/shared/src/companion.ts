// Contract between the extension and the companion: a native messaging host that Chrome starts
// when the extension connects (and stops when it disconnects). Messages are JSON over stdio, so
// nothing listens on a control port and no pairing is needed: Chrome only lets Castit talk to it.
import type { CastError, CastRequest, CastStatus, RemoteCommand } from './types.ts';

export const NATIVE_HOST_NAME = 'com.castit.companion';
export const COMPANION_PROTOCOL = 2;

/** A Cast device found on the local network (mDNS). */
export interface CastDeviceInfo {
  /** Stable device id (mDNS TXT "id"). */
  id: string;
  name: string;
  model?: string;
  host: string;
  port: number;
}

/** Sent by the companion in reply to "hello". */
export interface CompanionHello {
  name: 'castit-companion';
  version: string;
  protocol: number;
  /** LAN base URL the Chromecast fetches relayed media from. */
  mediaBaseUrl: string;
  ffmpeg: boolean;
  /** Hardware H.264 encoder in use (e.g. h264_videotoolbox), null = software (libx264). */
  hwEncoder: string | null;
  devices: CastDeviceInfo[];
}

export type CompanionRequest =
  /** active: the cast that was playing when the companion last stopped, to re-attach to. */
  | { type: 'hello'; active?: { device: CastDeviceInfo; request: CastRequest } | null }
  | { type: 'devices' }
  | { type: 'create-session'; request: CreateSessionRequest }
  | { type: 'delete-session'; sessionId: string }
  | { type: 'cast'; device: CastDeviceInfo; request: CastRequest }
  | { type: 'command'; command: RemoteCommand };

export type CompanionErrorCode = 'BAD_REQUEST' | 'BLOCKED_ADDRESS' | 'INTERNAL';

export type CompanionReply =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string; code: CompanionErrorCode };

/** Pushed by the companion at any time. */
export type CompanionEvent =
  | { type: 'event/status'; status: CastStatus }
  | { type: 'event/load-result'; requestId: string; ok: true }
  | { type: 'event/load-result'; requestId: string; ok: false; error: CastError }
  /** Playback broke or froze after it had started (position in seconds, for resuming). */
  | { type: 'event/playback-problem'; requestId: string; error: CastError; position: number }
  | { type: 'event/devices'; devices: CastDeviceInfo[] };

/**
 * Explicit, per-cast upstream request settings. Cookies and Authorization are never accepted
 * here: the companion never forwards browser credentials.
 */
export interface UpstreamContext {
  referer?: string;
  origin?: string;
  userAgent?: string;
}

/**
 * Which Cast device family to produce output for. Codec support differs:
 *   compat     : any Chromecast (2nd/3rd gen): H.264 ≤ 1080p, AAC/MP3/Opus/Vorbis/FLAC
 *   ultra      : Chromecast Ultra: + HEVC, VP9, 4K
 *   google-tv  : Chromecast with Google TV (4K): + Dolby Digital (AC-3 / E-AC-3)
 *   gtv-streamer: Google TV Streamer: + AV1
 */
export type ReceiverProfile = 'compat' | 'ultra' | 'google-tv' | 'gtv-streamer';
export type TranscodeQuality = 'auto' | '1080p' | '720p' | '480p';

export interface TranscodeOptions {
  /** auto: only convert what the receiver can't play; force: always produce an HLS stream. */
  mode: 'auto' | 'force';
  profile: ReceiverProfile;
  quality: TranscodeQuality;
}

export interface CreateSessionRequest {
  url: string;
  kind: 'hls' | 'dash' | 'progressive' | 'unknown';
  context: UpstreamContext;
  /** The TV the stream is for; HLS variants it can't play are left out. */
  profile?: ReceiverProfile;
  /** Ask the companion to analyse the media with FFmpeg and convert it when needed. */
  transcode?: TranscodeOptions;
}

/** What FFmpeg will do, for display. */
export interface MediaPlanSummary {
  action: 'direct' | 'remux' | 'transcode';
  video: 'copy' | 'encode' | 'none';
  audio: 'copy' | 'encode' | 'none';
  /** e.g. "HEVC 2160p → H.264 1080p", "AC-3 5.1 → AAC stereo". */
  details: string[];
  /** Why conversion is needed (or not). */
  reasons: string[];
  encoder?: string;
  subtitles: number;
}

export interface TextTrackInfo {
  id: number;
  url: string;
  name: string;
  language?: string;
}

/** How the receiver must load what the companion delivers. */
export interface DeliveredMedia {
  contentType: string;
  streamType: 'BUFFERED' | 'LIVE';
  hlsSegmentFormat?: 'ts' | 'fmp4';
  hlsVideoSegmentFormat?: 'mpeg2_ts' | 'fmp4';
  duration?: number;
  /** The whole timeline is seekable immediately (segmented transcode) vs. as it is produced. */
  seekable: boolean;
  textTracks: TextTrackInfo[];
}

export interface UpstreamCheck {
  ok: boolean;
  status?: number;
  contentType?: string;
  error?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  /** URL to give the Chromecast. */
  mediaUrl: string;
  expiresAt: number;
  check: UpstreamCheck;
  /** relay: bytes passed through; remux: container changed (no re-encode); transcode: re-encoded. */
  delivery: 'relay' | 'remux' | 'transcode';
  plan?: MediaPlanSummary;
  /** Present when delivery is remux/transcode. */
  media?: DeliveredMedia;
  /** FFmpeg analysis failed; the stream is relayed unchanged instead. */
  analysisError?: string;
}

export interface CompanionSessionInfo {
  sessionId: string;
  /** Upstream origin + path only (query strings are never listed). */
  upstream: string;
  createdAt: number;
  lastUsed: number;
  expiresAt: number;
  boundClient?: string;
  requests: number;
  bytesServed: number;
}

/** Extension-side view of the companion, shown in the popup. */
export interface CompanionStatus {
  /** missing: not installed (`npm run setup`); offline: installed but failed to start. */
  state: 'ready' | 'missing' | 'offline';
  version?: string;
  mediaBaseUrl?: string;
  ffmpeg?: boolean;
  hwEncoder?: string | null;
  error?: string;
}

/** auto: direct → relay → convert as needed; transcode: always convert through FFmpeg. */
export type EngineMode = 'auto' | 'direct' | 'companion' | 'transcode';

export interface TranscodeSettings {
  profile: ReceiverProfile;
  quality: TranscodeQuality;
}
