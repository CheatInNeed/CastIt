// Domain types shared by the extension and the companion.
import type { MediaPlanSummary, TextTrackInfo } from './companion.ts';

export type StreamKind =
  | 'hls' // HLS playlist (.m3u8)
  | 'dash' // DASH manifest (.mpd)
  | 'progressive' // a single self-contained file (MP4, WebM, ...)
  | 'segment' // a piece of an adaptive stream; never castable on its own
  | 'unknown';

export type Container =
  | 'mp4'
  | 'webm'
  | 'mov'
  | 'mkv'
  | 'ogg'
  | 'flv'
  | 'avi'
  | 'ts'
  | 'mp3'
  | 'aac'
  | 'unknown';

/** A media response observed through chrome.webRequest. */
export interface NetworkCandidate {
  id: string;
  /** The exact URL as requested by the page (signed query strings preserved). */
  url: string;
  kind: StreamKind;
  container: Container;
  audioOnly: boolean;
  /** Content-Type response header, if any. */
  mimeType?: string;
  frameId: number;
  initiator?: string;
  /** Total resource size from Content-Range / Content-Length when known. */
  totalSize?: number;
  /** URL actually served after redirects, when it differs from `url`. */
  finalUrl?: string;
  /** HTTP status of the most recent response (>= 400 means the page's own request failed). */
  lastStatus?: number;
  firstSeen: number;
  lastSeen: number;
  hits: number;
}

/** Snapshot of an HTML5 <video> element, reported by the content script. */
export interface VideoElementInfo {
  /** Stable per-element key inside its frame. */
  key: string;
  /** currentSrc || src, made absolute. May be a blob: URL. */
  src?: string;
  /** <source> children, absolute. */
  sources: string[];
  /** True when the element plays a MediaSource/blob: URL (assembled in the browser). */
  isBlob: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  /** Seconds; null when unknown or infinite (live). */
  duration: number | null;
  live: boolean;
  /** Rendered size in CSS pixels. */
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  poster?: string;
  muted: boolean;
  readyState: number;
  /** Epoch ms of the last 'playing' event seen for this element. */
  lastPlayedAt?: number;
  /** MediaError code when the element failed to load its source (1-4), else null. */
  error: number | null;
  /** Intersects the viewport and has a non-zero size. */
  visible: boolean;
  /** Lives inside a (possibly closed) shadow root. */
  inShadowRoot: boolean;
  /** SourceBuffer MIME types (with codecs) of the MediaSource attached to this element. */
  mseMimeTypes: string[];
}

export interface FrameReport {
  frameId: number;
  url: string;
  title?: string;
  isTop: boolean;
  videos: VideoElementInfo[];
  /** Key systems the frame's player actually attached to a media element (EME). */
  emeKeySystems: string[];
  updatedAt: number;
}

/** Parent links learnt from sub_frame navigations (webRequest), used to relate nested frames. */
export interface FrameNode {
  parentFrameId: number;
  url: string;
}

export type ManifestEncryption = 'none' | 'aes-128' | 'sample-aes' | 'drm';

/** What Castit learnt by fetching an HLS/DASH manifest (without cookies). */
export interface ManifestSummary {
  kind: 'hls' | 'dash';
  inspectedAt: number;
  reachable: boolean;
  status?: number;
  /** Access-Control-Allow-Origin present? null when unknown (not reachable). */
  cors: boolean | null;
  /** The response parsed as a manifest of the expected kind. */
  valid: boolean;
  role?: 'master' | 'media' | 'mpd';
  live?: boolean;
  maxHeight?: number;
  variantCount: number;
  audioTracks: number;
  subtitleTracks: number;
  codecs: string[];
  encryption: ManifestEncryption;
  drmSystems: string[];
  duration?: number;
  segmentFormat?: string;
  /** Dedupe keys of variant/rendition playlists referenced by this master. */
  childKeys: string[];
  error?: string;
}

/** Everything Castit knows about one tab. Persisted in chrome.storage.session. */
export interface TabMediaState {
  tabId: number;
  pageUrl?: string;
  /** Set when the top document changed URL without reloading (SPA navigation). */
  navigatedAt?: number;
  candidates: Record<string, NetworkCandidate>;
  /** Keyed by String(frameId). */
  frames: Record<string, FrameReport>;
  /** Keyed by String(frameId). */
  frameTree: Record<string, FrameNode>;
  /** Keyed by network candidate id. */
  manifests: Record<string, ManifestSummary>;
}

export type Castability = 'likely' | 'possible' | 'unlikely' | 'unsupported';

export type CastEngine = 'direct' | 'companion' | 'transcode';

/** A castable stream after merging network + DOM evidence and ranking. */
export interface RankedCandidate {
  id: string;
  url: string;
  kind: StreamKind;
  container: Container;
  audioOnly: boolean;
  mimeType?: string;
  /** Where the URL came from. */
  origin: 'network' | 'dom';
  frameId: number;
  /** Human readable label (file name). */
  label: string;
  /** e.g. "1080p" when known. */
  quality?: string;
  totalSize?: number;
  /** The video element playing (or associated with) this stream, if any. */
  video?: VideoElementInfo;
  /** Frame of `video` (may differ from frameId when a manifest feeds a player in another frame). */
  videoFrameId?: number;
  /** Requested from (or shown in) a sub-frame, e.g. an embedded third-party player. */
  embedded: boolean;
  /** Host of the frame the stream belongs to. */
  frameHost?: string;
  manifest?: ManifestSummary;
  live: boolean;
  /** Codec strings known from the manifest or the page's SourceBuffers. */
  codecs: string[];
  /** EME key systems in use by the associated player (DRM hint). */
  drmHint: string[];
  /** HTTP status of the page's last request for this URL, if it failed. */
  lastStatus?: number;
  score: number;
  reasons: string[];
  lastSeen: number;
  isAd: boolean;
}

export interface CastabilityAssessment {
  level: Castability;
  engine: CastEngine | null;
  notes: string[];
  /** Set when casting must not be attempted; explains why. */
  blocker?: CastError;
  /** Why relaying through the local companion would help (no CORS, Referer checks, …). */
  companionHelps?: string;
  /** Why converting with the companion's FFmpeg would help (container/codec the receiver can't play). */
  transcodeHelps?: string;
}

export type CastErrorCode =
  | 'NO_VIDEO'
  | 'STREAM_UNAVAILABLE'
  | 'MANIFEST_INACCESSIBLE'
  | 'AUTH_REQUIRED'
  | 'DRM'
  | 'UNSUPPORTED_CODEC'
  | 'UNSUPPORTED_CONTAINER'
  | 'SEGMENT_FAILURE'
  | 'NO_DEVICE'
  | 'SESSION_CANCELLED'
  | 'RECEIVER_LOAD_FAILED'
  | 'PLAYBACK_TIMEOUT'
  | 'COMPANION_UNAVAILABLE'
  | 'TRANSCODE_FAILED'
  | 'SYNC_UNAVAILABLE'
  | 'INTERNAL';

export interface CastError {
  code: CastErrorCode;
  message: string;
  detail?: string;
}

export type HlsSegmentFormat = 'ts' | 'fmp4' | 'aac' | 'mp3' | 'ac3' | 'e_ac3' | 'ts_aac';
export type HlsVideoSegmentFormat = 'mpeg2_ts' | 'fmp4';

/** Everything the companion needs to load a stream on the TV. */
export interface CastRequest {
  requestId: string;
  sourceTabId: number;
  candidateId: string;
  url: string;
  contentType: string;
  streamType: 'BUFFERED' | 'LIVE';
  hlsSegmentFormat?: HlsSegmentFormat;
  hlsVideoSegmentFormat?: HlsVideoSegmentFormat;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  /** Resume position in seconds (VOD only). */
  startTime?: number;
  duration?: number;
  engine: CastEngine;
  /** Sidecar WebVTT subtitles (from the companion). */
  textTracks?: TextTrackInfo[];
  /** What the companion's FFmpeg does to this stream, when it converts it. */
  plan?: MediaPlanSummary;
}

export type CastPhase =
  | 'idle'
  | 'connecting'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/** Receiver state as reported by the companion. */
export interface CastStatus {
  phase: CastPhase;
  sessionActive: boolean;
  /** Whether any Cast device is visible on the network. */
  devicesAvailable: boolean;
  deviceName?: string;
  title?: string;
  contentUrl?: string;
  currentTime: number;
  duration: number | null;
  live: boolean;
  canSeek: boolean;
  canPause: boolean;
  volume: number;
  muted: boolean;
  requestId?: string;
  sourceTabId?: number;
  engine?: CastEngine;
  /** Subtitle tracks offered to the receiver, and the one shown (null = off). */
  textTracks?: Array<{ id: number; name: string; language?: string }>;
  activeTextTrack?: number | null;
  /** Conversion summary when the companion transcodes/remuxes. */
  plan?: MediaPlanSummary;
  error?: CastError;
  updatedAt: number;
}

export type RemoteCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePlay' }
  | { type: 'seek'; time: number }
  | { type: 'seekRelative'; delta: number }
  | { type: 'volume'; level: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'stop' }
  | { type: 'disconnect' }
  | { type: 'rate'; rate: number }
  | { type: 'subtitles'; trackId: number | null };
