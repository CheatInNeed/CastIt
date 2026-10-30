// Pure routing of receiver status to the synced page player (background side).
import type { CastStatus, SyncReceiverState } from '@castit/shared';
import { isPlayingPhase, type StopReason } from './playback-sync.ts';

/** Which page player mirrors the current cast. Persisted in chrome.storage.session. */
export interface SyncTarget {
  tabId: number;
  /** Frame holding the player; undefined = top frame. */
  frameId?: number;
  videoKey?: string;
  requestId: string;
  state: 'active' | 'unavailable';
  reason?: string;
  frameHost?: string;
  /** Last receiver position (VOD), used to restore the page when casting ends. */
  lastTime: number | null;
  /** Whether the TV was playing at the last update. */
  wasPlaying: boolean;
  deviceName?: string;
}

export interface SyncRoute {
  /** Receiver state to forward to the page, if any. */
  forward?: SyncReceiverState;
  /** End the sync with this reason. */
  stop?: StopReason;
  /** Fields of the target to update. */
  update: Partial<SyncTarget>;
}

export function toSyncState(status: CastStatus): SyncReceiverState {
  return {
    phase: status.phase,
    currentTime: status.currentTime,
    duration: status.duration,
    live: status.live,
    canSeek: status.canSeek,
    volume: status.volume,
    muted: status.muted,
    deviceName: status.deviceName,
  };
}

export function routeStatus(target: SyncTarget, status: CastStatus): SyncRoute {
  if (!status.sessionActive) return { stop: 'disconnected', update: {} };
  if (status.requestId !== target.requestId) return { stop: 'replaced', update: {} };

  const update: Partial<SyncTarget> = { deviceName: status.deviceName ?? target.deviceName };
  if (!status.live && status.currentTime > 0) update.lastTime = status.currentTime;

  switch (status.phase) {
    case 'ended':
      return {
        forward: toSyncState(status),
        stop: 'ended',
        update: { ...update, lastTime: status.duration ?? status.currentTime, wasPlaying: false },
      };
    case 'idle':
    case 'error':
      return { stop: 'stopped', update };
    case 'playing':
    case 'buffering':
    case 'paused':
      update.wasPlaying = isPlayingPhase(status.phase);
      return { forward: toSyncState(status), update };
    default:
      // loading / connecting: nothing useful to mirror yet.
      return { update };
  }
}
