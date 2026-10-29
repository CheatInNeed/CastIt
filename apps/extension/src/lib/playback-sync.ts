// Pure page-player ↔ Chromecast synchronisation logic (no DOM), used by the content script.
//
// While casting, the page's <video> stays paused (no double audio, no double download) and acts
// as a remote control:
//   - pressing the page's play button toggles play/pause on the TV (the page always shows
//     "paused", so every press is a toggle request);
//   - seeking, volume, mute and speed changes on the page are forwarded to the TV;
//   - the TV's position is mirrored back onto the page's timeline, sparingly (each local seek can
//     make the page's player fetch data).
// Feedback loops are prevented two ways: every change Castit makes to the local element is
// registered as an *expectation* and the resulting media events are swallowed; and only events
// that come with a real user gesture (navigator.userActivation) are forwarded, so a page script
// calling play() on its own never controls the TV.
import type { CastPhase, RemoteCommand } from '@castit/shared';

export interface LocalSnapshot {
  currentTime: number;
  duration: number | null;
  paused: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
}

export type LocalEventType = 'play' | 'pause' | 'seeking' | 'seeked' | 'ratechange' | 'volumechange';

export interface LocalEvent extends LocalSnapshot {
  type: LocalEventType;
  /** navigator.userActivation.isActive at the time of the event. */
  userActivated: boolean;
}

export interface ReceiverSyncState {
  phase: CastPhase;
  currentTime: number;
  duration: number | null;
  live: boolean;
  canSeek: boolean;
  volume: number;
  muted: boolean;
  deviceName?: string;
}

export type LocalAction =
  | { type: 'pause' }
  | { type: 'play' }
  | { type: 'seek'; time: number }
  | { type: 'mute'; muted: boolean };

export interface SyncResult {
  commands: RemoteCommand[];
  actions: LocalAction[];
}

export type StopReason = 'ended' | 'stopped' | 'disconnected' | 'replaced';

interface Expectation {
  kind: 'pause' | 'play' | 'seek' | 'mute';
  value?: number;
  until: number;
}

export const SYNC_TUNING = {
  /** How long an expected echo of our own change is waited for. */
  expectMs: 2500,
  /** Seek requests from scrubbing are coalesced over this window. */
  seekDebounceMs: 300,
  /** Re-align the page's timeline when it drifts this far from a playing TV… */
  playingDriftSeconds: 10,
  /** …but not more often than this. */
  playingMirrorIntervalMs: 15_000,
  /** When the TV is paused, align tightly (once). */
  pausedDriftSeconds: 1,
  /** More than this many unrequested local play() calls within the window: stop fighting, mute. */
  autoPlayLimit: 6,
  autoPlayWindowMs: 5000,
};

const PLAYING_PHASES: CastPhase[] = ['playing', 'buffering', 'loading'];

export class SyncController {
  private expectations: Expectation[] = [];
  private receiver: ReceiverSyncState | null = null;
  private lastMirrorAt = 0;
  private pendingSeek: { time: number; at: number } | null = null;
  private autoPlays: number[] = [];
  private mutedByUs = false;
  /** The page keeps restarting playback by itself; we only keep it muted. */
  fighting = false;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Called when casting starts: silence the page and remember to ignore our own pause. */
  start(local: LocalSnapshot): LocalAction[] {
    return local.paused ? [] : [this.ownPause()];
  }

  private expect(kind: Expectation['kind'], value?: number): void {
    this.expectations.push({ kind, value, until: this.now() + SYNC_TUNING.expectMs });
  }

  /** Consumes a matching expectation; true means "this event is our own echo". */
  private consume(kind: Expectation['kind'], value?: number): boolean {
    const now = this.now();
    this.expectations = this.expectations.filter((e) => e.until > now);
    const i = this.expectations.findIndex(
      (e) => e.kind === kind && (value === undefined || e.value === undefined || Math.abs(e.value - value) < 1.5),
    );
    if (i === -1) return false;
    this.expectations.splice(i, 1);
    return true;
  }

  private ownPause(): LocalAction {
    this.expect('pause');
    return { type: 'pause' };
  }

  private ownSeek(time: number): LocalAction {
    this.expect('seek', time);
    this.lastMirrorAt = this.now();
    return { type: 'seek', time };
  }

  onLocalEvent(e: LocalEvent): SyncResult {
    const commands: RemoteCommand[] = [];
    const actions: LocalAction[] = [];

    switch (e.type) {
      case 'play': {
        if (this.consume('play')) break;
        if (this.fighting) break;
        if (e.userActivated) {
          // The page shows "paused" while the TV plays, so a press means "toggle the TV".
          commands.push({ type: 'togglePlay' });
        } else if (this.registerAutoPlay()) {
          // A script keeps restarting local playback: don't fight it, just keep it silent.
          this.fighting = true;
          if (!e.muted) {
            this.mutedByUs = true;
            this.expect('mute');
            actions.push({ type: 'mute', muted: true });
          }
          break;
        }
        actions.push(this.ownPause());
        break;
      }
      case 'pause':
        // Local is paused by design; a pause is either our own echo or harmless.
        this.consume('pause');
        break;
      case 'seeking':
        if (this.consume('seek', e.currentTime)) {
          this.expect('seek', e.currentTime); // the matching 'seeked' follows
          break;
        }
        if (e.userActivated) this.pendingSeek = { time: e.currentTime, at: this.now() };
        break;
      case 'seeked':
        if (this.consume('seek', e.currentTime)) break;
        if (e.userActivated || this.pendingSeek) {
          this.pendingSeek = null;
          if (this.receiver?.canSeek !== false && !this.receiver?.live) commands.push({ type: 'seek', time: e.currentTime });
        }
        break;
      case 'ratechange':
        if (e.userActivated && e.playbackRate > 0) commands.push({ type: 'rate', rate: e.playbackRate });
        break;
      case 'volumechange':
        if (this.consume('mute')) break;
        if (e.userActivated) {
          commands.push({ type: 'volume', level: e.volume });
          commands.push({ type: 'mute', muted: e.muted });
        }
        break;
    }
    return { commands, actions };
  }

  /**
   * Pending scrub that never produced 'seeked' (some players only emit 'seeking' on drag):
   * call periodically; returns the seek to forward once the user stopped moving.
   */
  flushPendingSeek(): RemoteCommand | null {
    if (!this.pendingSeek || this.now() - this.pendingSeek.at < SYNC_TUNING.seekDebounceMs) return null;
    const { time } = this.pendingSeek;
    this.pendingSeek = null;
    if (this.receiver?.live || this.receiver?.canSeek === false) return null;
    return { type: 'seek', time };
  }

  private registerAutoPlay(): boolean {
    const now = this.now();
    this.autoPlays = this.autoPlays.filter((t) => now - t < SYNC_TUNING.autoPlayWindowMs);
    this.autoPlays.push(now);
    return this.autoPlays.length > SYNC_TUNING.autoPlayLimit;
  }

  /** Receiver status arrived: keep the page silent and its timeline roughly aligned. */
  onReceiverState(state: ReceiverSyncState, local: LocalSnapshot): LocalAction[] {
    const previous = this.receiver;
    this.receiver = state;
    const actions: LocalAction[] = [];
    if (!local.paused && !this.fighting) actions.push(this.ownPause());
    if (state.live || !state.canSeek || this.pendingSeek) return actions;

    let target: number | null = null;
    if (state.phase === 'ended' && previous?.phase !== 'ended') {
      target = Math.max(0, (state.duration ?? local.duration ?? state.currentTime) - 0.25);
    } else if (state.phase === 'paused') {
      if (Math.abs(local.currentTime - state.currentTime) > SYNC_TUNING.pausedDriftSeconds) target = state.currentTime;
    } else if (PLAYING_PHASES.includes(state.phase)) {
      const drift = Math.abs(local.currentTime - state.currentTime);
      if (drift > SYNC_TUNING.playingDriftSeconds && this.now() - this.lastMirrorAt > SYNC_TUNING.playingMirrorIntervalMs) {
        target = state.currentTime;
      }
    }
    if (target !== null && local.duration !== null) target = Math.min(target, Math.max(0, local.duration - 0.1));
    if (target !== null && target > 0) actions.push(this.ownSeek(target));
    return actions;
  }

  /**
   * Casting ended: put the page where the TV was. After a disconnect while the TV was playing,
   * resume locally so watching continues seamlessly.
   */
  stop(reason: StopReason, lastTime: number | null, wasPlaying: boolean, local: LocalSnapshot): LocalAction[] {
    const actions: LocalAction[] = [];
    if (this.mutedByUs) actions.push({ type: 'mute', muted: false });
    if (reason === 'replaced') return actions;
    const live = this.receiver?.live ?? false;
    if (!live && lastTime !== null && lastTime > 0 && Math.abs(local.currentTime - lastTime) > 0.5) {
      const max = local.duration !== null ? Math.max(0, local.duration - 0.1) : lastTime;
      actions.push({ type: 'seek', time: Math.min(lastTime, max) });
    }
    if (reason === 'disconnected' && wasPlaying) actions.push({ type: 'play' });
    this.expectations = [];
    return actions;
  }

  get receiverState(): ReceiverSyncState | null {
    return this.receiver;
  }
}

/** Whether a receiver phase counts as "the TV is playing" for restore decisions. */
export function isPlayingPhase(phase: CastPhase | undefined): boolean {
  return !!phase && PLAYING_PHASES.includes(phase);
}
