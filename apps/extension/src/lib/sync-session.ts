// Binds one page <video> to the Chromecast while casting: feeds its media events into the pure
// SyncController, applies the controller's local actions, forwards remote commands, and shows
// the overlay badge. Listeners sit on the element itself, so players inside shadow roots work.
import type { RemoteCommand, SyncReceiverState } from '@castit/shared';
import { SyncController, type LocalAction, type LocalEventType, type LocalSnapshot, type StopReason } from './playback-sync.ts';
import { SyncOverlay } from './sync-overlay.ts';

const EVENTS: LocalEventType[] = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'volumechange'];

export interface SyncSessionOptions {
  requestId: string;
  deviceName?: string;
  send: (command: RemoteCommand) => void;
  /** The page fights the sync (keeps restarting playback); Castit's own controls still work. */
  onLost: (reason: string) => void;
}

export class SyncSession {
  readonly requestId: string;
  readonly video: HTMLVideoElement;
  private readonly controller = new SyncController();
  private readonly overlay: SyncOverlay;
  private readonly options: SyncSessionOptions;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private stopped = false;
  private lostReported = false;

  constructor(video: HTMLVideoElement, options: SyncSessionOptions) {
    this.video = video;
    this.options = options;
    this.requestId = options.requestId;
    for (const type of EVENTS) video.addEventListener(type, this.onEvent);
    this.apply(this.controller.start(this.snapshot()));
    this.overlay = new SyncOverlay(video, {
      togglePlay: () => options.send({ type: 'togglePlay' }),
      stop: () => options.send({ type: 'stop' }),
    });
    this.overlay.update(null, options.deviceName);
    // Players that only emit 'seeking' while dragging get their final position forwarded here.
    this.flushTimer = setInterval(() => {
      const command = this.controller.flushPendingSeek();
      if (command) options.send(command);
    }, 150);
  }

  private snapshot(): LocalSnapshot {
    const v = this.video;
    return {
      currentTime: v.currentTime || 0,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
      paused: v.paused,
      playbackRate: v.playbackRate,
      volume: v.volume,
      muted: v.muted,
    };
  }

  private readonly onEvent = (e: Event) => {
    if (this.stopped) return;
    const userActivated = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? false;
    const result = this.controller.onLocalEvent({ ...this.snapshot(), type: e.type as LocalEventType, userActivated });
    for (const command of result.commands) this.options.send(command);
    this.apply(result.actions);
    if (this.controller.fighting && !this.lostReported) {
      this.lostReported = true;
      this.options.onLost('The page keeps restarting its own player, so it is muted instead of synced. Use Castit’s controls.');
    }
  };

  private apply(actions: LocalAction[]): void {
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'pause':
            this.video.pause();
            break;
          case 'play':
            void this.video.play()?.catch(() => undefined); // autoplay policy may refuse; the page stays paused
            break;
          case 'seek':
            this.video.currentTime = action.time;
            break;
          case 'mute':
            this.video.muted = action.muted;
            break;
        }
      } catch {
        // Some players throw on seeks before metadata; the next receiver update retries.
      }
    }
  }

  receiverState(state: SyncReceiverState): void {
    if (this.stopped) return;
    this.overlay.update(state);
    this.apply(this.controller.onReceiverState(state, this.snapshot()));
  }

  stop(reason: StopReason, lastTime: number | null, wasPlaying: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.flushTimer);
    for (const type of EVENTS) this.video.removeEventListener(type, this.onEvent);
    this.overlay.destroy();
    this.apply(this.controller.stop(reason, lastTime, wasPlaying, this.snapshot()));
  }
}
