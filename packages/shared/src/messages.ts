// Message protocol between the extension contexts (background, content scripts, popup).
import type { CastDeviceInfo, CompanionStatus, EngineMode, TranscodeSettings } from './companion.ts';
import type {
  CastPhase,
  CastabilityAssessment,
  CastError,
  CastStatus,
  RankedCandidate,
  RemoteCommand,
  VideoElementInfo,
} from './types.ts';

// ---------------------------------------------------------------- content ↔ background

export interface ContentReportMessage {
  type: 'content/report';
  url: string;
  title?: string;
  isTop: boolean;
  videos: VideoElementInfo[];
  emeKeySystems: string[];
}

/** A user action on the page's own player, forwarded to the TV while synced. */
export interface ContentRemoteMessage {
  type: 'content/remote';
  requestId: string;
  command: RemoteCommand;
}

/** The content script gave up syncing (e.g. the page keeps restarting playback). */
export interface ContentSyncLostMessage {
  type: 'content/sync-lost';
  requestId: string;
  reason: string;
}

export type ContentToBackground = ContentReportMessage | ContentRemoteMessage | ContentSyncLostMessage;

/** Receiver state forwarded to the synced page player. */
export interface SyncReceiverState {
  phase: CastPhase;
  currentTime: number;
  duration: number | null;
  live: boolean;
  canSeek: boolean;
  volume: number;
  muted: boolean;
  deviceName?: string;
}

export type SyncStartResponse = { ok: true; videoKey: string } | { ok: false; reason: string };

export type BackgroundToContent =
  /** Ask every frame to send a fresh report right away. */
  | { type: 'content/refresh' }
  /** Pause local playback because the receiver took over. */
  | { type: 'content/pause-local' }
  | { type: 'content/highlight'; videoKey: string | null }
  /** Show or hide Castit's panel over the page (top frame only); token authenticates the panel. */
  | { type: 'content/toggle-panel'; token: string }
  /** The TV is playing: turn the given (or main) <video> into a remote control. */
  | { type: 'content/sync-start'; requestId: string; videoKey?: string; deviceName?: string }
  | { type: 'content/sync-state'; requestId: string; state: SyncReceiverState }
  | {
      type: 'content/sync-stop';
      requestId: string;
      reason: 'ended' | 'stopped' | 'disconnected' | 'replaced';
      lastTime: number | null;
      wasPlaying: boolean;
    };

/** How (and whether) the page's own player is acting as a remote. */
export interface SyncInfo {
  state: 'active' | 'unavailable' | 'off';
  /** Host of the frame whose player is synced (embedded players). */
  frameHost?: string;
  reason?: string;
}

// ---------------------------------------------------------------- popup ↔ background

export interface CandidateView extends RankedCandidate {
  assessment: CastabilityAssessment;
}

export interface PopupState {
  tabId: number;
  pageUrl?: string;
  pageTitle?: string;
  candidates: CandidateView[];
  /** A <video> plays a blob: (MediaSource) URL somewhere in the tab. */
  mediaSourceDetected: boolean;
  /** EME key systems a player on the page attached (DRM in use), e.g. com.widevine.alpha. */
  drmKeySystems: string[];
  castStatus: CastStatus | null;
  companion: CompanionStatus;
  /** TVs found on the network, and the one Castit casts to. */
  devices: CastDeviceInfo[];
  deviceId?: string;
  engineMode: EngineMode;
  transcodeSettings: TranscodeSettings;
  /** Background progress/failure note, e.g. an automatic companion fallback. */
  notice: string | null;
  sync: SyncInfo;
  /** Candidate currently playing on the TV from this tab, if any. */
  castingCandidateId?: string;
  /** Build id of the running background worker (compared with the popup's own). */
  buildId: string;
  /** What Castit tried for the latest cast from this tab. */
  progress?: CastProgress;
}

export type PopupRequest =
  | { type: 'popup/get-state'; tabId: number }
  | { type: 'popup/cast'; tabId: number; candidateId: string; deviceId?: string }
  | { type: 'popup/command'; command: RemoteCommand }
  | { type: 'popup/set-device'; deviceId: string }
  | { type: 'popup/set-engine'; mode: EngineMode }
  | { type: 'popup/set-transcode'; settings: TranscodeSettings }
  | { type: 'popup/cast-cancel' }
  /** Plain-text report of the latest cast (query strings removed), for bug reports. */
  | { type: 'popup/diagnostics'; tabId: number }
  /** Outline a page video while the user hovers its row (videoKey null = clear). */
  | { type: 'popup/highlight'; tabId: number; frameId: number; videoKey: string | null };

export type HighlightResult = 'shown' | 'not-found' | 'unreachable';

export interface CastProgress {
  state: 'running' | 'playing' | 'failed' | 'cancelled';
  /** One line per attempt, e.g. "2. Through the local companion: playing ✓". */
  lines: string[];
  final?: CastError;
}

export type PopupCastResponse = { ok: true } | { ok: false; error: CastError };

export type CommandResponse = { ok: true } | { ok: false; error: CastError };
