// Cast session management, media loading and playback verification (Default Media Receiver).
import type { CastError, CastPhase, CastRequest, CastStatus, RemoteCommand } from '@castit/shared';
import { loadError, midPlaybackError, PLAYBACK_TIMEOUT, sessionError } from './errors.ts';
import { Remote } from './remote.ts';

const VERIFY_TIMEOUT_MS = 30_000;
const TIME_UPDATE_INTERVAL_MS = 1000;

export interface CastEvents {
  status(status: CastStatus): void;
  loadResult(requestId: string, error?: CastError): void;
}

/** MediaInfo fields that exist in the SDK but are missing from @types/chromecast-caf-sender. */
type MediaInfoExtras = {
  contentUrl?: string;
  hlsSegmentFormat?: string;
  hlsVideoSegmentFormat?: string;
};

export function buildLoadRequest(req: CastRequest): chrome.cast.media.LoadRequest {
  const info = new chrome.cast.media.MediaInfo(req.url, req.contentType) as chrome.cast.media.MediaInfo & MediaInfoExtras;
  // contentUrl is what CAF receivers fetch; contentId is kept identical for older receivers.
  info.contentUrl = req.url;
  info.streamType = req.streamType === 'LIVE' ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
  if (req.duration) info.duration = req.duration;
  if (req.hlsSegmentFormat) info.hlsSegmentFormat = req.hlsSegmentFormat;
  if (req.hlsVideoSegmentFormat) info.hlsVideoSegmentFormat = req.hlsVideoSegmentFormat;

  const metadata = new chrome.cast.media.GenericMediaMetadata();
  metadata.title = req.title;
  if (req.subtitle) metadata.subtitle = req.subtitle;
  if (req.posterUrl) metadata.images = [new chrome.cast.Image(req.posterUrl)];
  info.metadata = metadata;

  const load = new chrome.cast.media.LoadRequest(info);
  load.autoplay = true;
  if (req.startTime) load.currentTime = req.startTime;
  return load;
}

export class CastController {
  private context!: cast.framework.CastContext;
  private remote!: Remote;
  /** Waiting for a session (device choice) before it can be loaded. */
  private pending: CastRequest | null = null;
  /** Most recently loaded request. */
  private current: CastRequest | null = null;
  private loading = false;
  /** Overrides the receiver-derived phase while Castit itself is busy or failed. */
  private override: CastPhase | null = null;
  private error: CastError | undefined;
  private verify: { requestId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastTimeEmit = 0;

  constructor(private readonly events: CastEvents) {}

  init(): void {
    this.context = cast.framework.CastContext.getInstance();
    this.context.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      // Re-join a session started from this origin (e.g. after reloading the controller tab).
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      resumeSavedSession: true,
    });
    this.remote = new Remote((field) => this.onPlayerChange(field));
    this.context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) =>
      this.onSessionState(e),
    );
    this.context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, () => this.emit());
    this.emit();
  }

  get hasSession(): boolean {
    return !!this.context.getCurrentSession();
  }

  get queued(): CastRequest | null {
    return this.pending ?? this.current;
  }

  /** Loads now if a session exists; otherwise waits for the user to choose a device. */
  async load(req: CastRequest): Promise<void> {
    if (req.requestId === this.pending?.requestId || req.requestId === this.current?.requestId) return;
    this.pending = req;
    this.error = undefined;
    if (this.hasSession) {
      await this.loadPending();
    } else {
      this.override = 'awaiting-device';
      this.emit();
    }
  }

  /** Opens Chrome's Cast device picker. Must run inside a user gesture (click). */
  async requestDevice(): Promise<void> {
    this.error = undefined;
    this.override = 'connecting';
    this.emit();
    let code: unknown;
    try {
      code = await this.context.requestSession();
    } catch (e) {
      code = e;
    }
    if (code) {
      this.override = this.pending ? 'awaiting-device' : null;
      this.error = sessionError(code);
      this.emit();
    }
    // On success, SESSION_STARTED loads the pending request.
  }

  execute(command: RemoteCommand): CastError | null {
    const result = this.remote.execute(command);
    if (command.type === 'stop' || command.type === 'disconnect') this.clearVerification();
    this.emit();
    return result;
  }

  private onSessionState(e: cast.framework.SessionStateEventData): void {
    const S = cast.framework.SessionState;
    switch (e.sessionState) {
      case S.SESSION_STARTED:
      case S.SESSION_RESUMED:
        this.override = null;
        if (this.pending) void this.loadPending();
        break;
      case S.SESSION_START_FAILED:
        this.override = this.pending ? 'awaiting-device' : null;
        this.error = sessionError(e.errorCode);
        break;
      case S.SESSION_ENDED:
        this.clearVerification();
        this.current = null;
        this.override = this.pending ? 'awaiting-device' : null;
        break;
    }
    this.emit();
  }

  private async loadPending(): Promise<void> {
    const req = this.pending;
    const session = this.context.getCurrentSession();
    if (!req || !session || this.loading) return;
    this.loading = true;
    this.pending = null;
    this.current = req;
    this.override = 'loading';
    this.emit();

    let code: unknown;
    try {
      code = await session.loadMedia(buildLoadRequest(req));
    } catch (e) {
      code = e;
    }
    this.loading = false;
    if (code) {
      this.fail(req.requestId, loadError(code));
      return;
    }
    // loadMedia resolving only means the receiver accepted the request; wait for real playback.
    this.override = null;
    this.clearVerification();
    this.verify = {
      requestId: req.requestId,
      timer: setTimeout(() => this.fail(req.requestId, PLAYBACK_TIMEOUT), VERIFY_TIMEOUT_MS),
    };
    this.checkPlayback();
    this.emit();
  }

  private checkPlayback(): void {
    const phase = this.remote.phase(this.idleReason());
    if (this.verify) {
      if (phase === 'playing') {
        const { requestId } = this.verify;
        this.clearVerification();
        this.events.loadResult(requestId);
      } else if (phase === 'error') {
        this.fail(this.verify.requestId, loadError('load_media_failed'));
      }
    } else if (phase === 'error' && this.current && !this.error) {
      this.error = midPlaybackError();
    }
  }

  private fail(requestId: string, error: CastError): void {
    this.clearVerification();
    this.error = error;
    this.override = 'error';
    this.events.loadResult(requestId, error);
    this.emit();
  }

  private clearVerification(): void {
    if (this.verify) clearTimeout(this.verify.timer);
    this.verify = null;
  }

  private idleReason(): chrome.cast.media.IdleReason | null {
    return this.context.getCurrentSession()?.getMediaSession()?.idleReason ?? null;
  }

  private onPlayerChange(field: string): void {
    if (field === 'playerState' || field === 'isMediaLoaded') {
      // A new receiver state supersedes Castit's own "loading"/"error" overlay.
      if (this.override === 'loading' && !this.loading) this.override = null;
      if (this.override === 'error' && this.remote.player.playerState === chrome.cast.media.PlayerState.PLAYING) {
        this.override = null;
        this.error = undefined;
      }
      this.checkPlayback();
    }
    if (field === 'currentTime') {
      const now = Date.now();
      if (now - this.lastTimeEmit < TIME_UPDATE_INTERVAL_MS) return;
      this.lastTimeEmit = now;
    }
    this.emit();
  }

  status(): CastStatus {
    const session = this.context.getCurrentSession();
    const player = this.remote.player;
    const derived = session ? this.remote.phase(this.idleReason()) : 'idle';
    const req = this.current ?? this.pending;
    const metadata = player.mediaInfo?.metadata as { title?: string } | undefined;
    return {
      phase: this.override ?? derived,
      sessionActive: !!session,
      devicesAvailable: this.context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE,
      deviceName: session?.getCastDevice().friendlyName,
      title: metadata?.title ?? req?.title,
      contentUrl: player.mediaInfo?.contentId ?? req?.url,
      currentTime: player.currentTime || 0,
      duration: player.duration > 0 ? player.duration : (req?.duration ?? null),
      live: player.isMediaLoaded ? this.remote.live : req?.streamType === 'LIVE',
      canSeek: player.canSeek,
      canPause: player.canPause,
      volume: player.volumeLevel,
      muted: player.isMuted,
      requestId: req?.requestId,
      sourceTabId: req?.sourceTabId,
      engine: req?.engine,
      error: this.error,
      updatedAt: Date.now(),
    };
  }

  private emit(): void {
    this.events.status(this.status());
  }
}
