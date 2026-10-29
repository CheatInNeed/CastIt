// Message protocol between the extension contexts and the controller page.
import type { CompanionStatus, EngineMode } from './companion.ts';
import type {
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

export type ContentToBackground = ContentReportMessage;

export type BackgroundToContent =
  /** Ask every frame to send a fresh report right away. */
  | { type: 'content/refresh' }
  /** Pause local playback because the receiver took over. */
  | { type: 'content/pause-local' };

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
  /** Background progress/failure note, e.g. an automatic companion fallback. */
  notice: string | null;
}

export type PopupRequest =
  | { type: 'popup/get-state'; tabId: number }
  | { type: 'popup/cast'; tabId: number; candidateId: string }
  | { type: 'popup/command'; command: RemoteCommand }
  | { type: 'popup/open-controller' }
  | { type: 'popup/companion-pair'; code: string }
  | { type: 'popup/companion-forget' }
  | { type: 'popup/set-engine'; mode: EngineMode };

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
  | { type: 'controller/load-result'; requestId: string; ok: false; error: CastError };

export type BackgroundToController =
  | { type: 'controller/welcome'; pending: CastRequest | null }
  | { type: 'controller/rejected'; reason: string }
  | { type: 'controller/load'; request: CastRequest }
  | { type: 'controller/command'; command: RemoteCommand };
