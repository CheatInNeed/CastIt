// Control API contract between the extension and the local companion (http://127.0.0.1:47800).

export const COMPANION_DEFAULT_URL = 'http://127.0.0.1:47800';
export const COMPANION_PROTOCOL = 1;

export interface CompanionHealth {
  name: 'castit-companion';
  version: string;
  protocol: number;
  /** At least one browser has been paired. */
  paired: boolean;
  /** LAN base URL the Chromecast fetches media from. */
  mediaBaseUrl: string;
  ffmpeg: boolean;
  ffmpegVersion?: string;
  /** Hardware H.264 encoder in use (e.g. h264_videotoolbox), null = software (libx264). */
  hwEncoder?: string | null;
}

export interface CompanionPairRequest {
  code: string;
  label?: string;
}

export interface CompanionPairResponse {
  apiKey: string;
}

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

export interface CompanionErrorBody {
  error: string;
  code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'BLOCKED_ADDRESS' | 'NOT_FOUND' | 'PAIRING_FAILED' | 'INTERNAL';
}

/** Extension-side view of the companion, shown in the popup. */
export interface CompanionStatus {
  state: 'offline' | 'unpaired' | 'paired' | 'rejected';
  url: string;
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
