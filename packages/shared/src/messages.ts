// Message protocol between the extension contexts and the controller page.
import type { CompanionStatus, EngineMode, TranscodeSettings } from './companion.ts';
import type {
  CastPhase,
  CastabilityAssessment,
  CastError,
  CastRequest,
  CastStatus,
  RankedCandidate,
  RemoteCommand,
  VideoElementInfo,
} from './types.ts';

/** Name of the long-lived port the controller page opens to the extension. */
export const CONTROLLER_PORT_NAME = 'castit-controller';
export const PROTOCOL_VERSION = 1;

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
  castStatus: CastStatus | null;
  controllerConnected: boolean;
  controllerUrl: string;
  companion: CompanionStatus;
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
  | { type: 'popup/cast'; tabId: number; candidateId: string }
  | { type: 'popup/command'; command: RemoteCommand }
  | { type: 'popup/open-controller' }
  | { type: 'popup/companion-pair'; code: string }
  | { type: 'popup/companion-forget' }
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

export type CompanionPairResult = { ok: true; status: CompanionStatus } | { ok: false; error: string };

export type PopupCastResponse =
  | { ok: true; controller: 'loading' | 'opened' }
  | { ok: false; error: CastError };

export type CommandResponse = { ok: true } | { ok: false; error: CastError };

// ---------------------------------------------------------------- controller ↔ background

export type ControllerToBackground =
  | { type: 'controller/hello'; token: string; version: number }
  | { type: 'controller/status'; status: CastStatus }
  | { type: 'controller/load-result'; requestId: string; ok: true }
  | { type: 'controller/load-result'; requestId: string; ok: false; error: CastError }
  /** Playback broke or froze after it had started (position in seconds, for resuming). */
  | { type: 'controller/playback-problem'; requestId: string; error: CastError; position: number };

export type BackgroundToController =
  /**
   * pending: a cast waiting to be loaded. active: the cast that was playing when the controller
   * last disconnected (tab closed, worker restarted); a reopened controller adopts it if the TV
   * is still playing that stream, so remote control and page sync continue.
   */
  | { type: 'controller/welcome'; pending: CastRequest | null; active?: CastRequest | null }
  | { type: 'controller/rejected'; reason: string }
  | { type: 'controller/load'; request: CastRequest }
  | { type: 'controller/command'; command: RemoteCommand };
