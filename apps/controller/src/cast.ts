// Cast session management, media loading and playback verification (Default Media Receiver).
import type { CastError, CastPhase, CastRequest, CastStatus, RemoteCommand } from '@castit/shared';
import {
  decodeEntities,
  loadError,
  midPlaybackError,
  PLAYBACK_TIMEOUT,
  sessionError,
  STALLED,
  withReceiverDetail,
  type ReceiverError,
} from './errors.ts';
import { Remote } from './remote.ts';

const VERIFY_TIMEOUT_MS = 30_000;
/** After playback is verified, watch this long for freezes (broken segments, throttled relays…). */
const WATCH_MS = 120_000;
const STALL_MS = 20_000;
/** Receiver errors older than this are not attributed to a new failure. */
const RECEIVER_ERROR_TTL_MS = 30_000;
const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';
const TIME_UPDATE_INTERVAL_MS = 1000;

export interface CastEvents {
  status(status: CastStatus): void;
  loadResult(requestId: string, error?: CastError): void;
  /** Playback failed or froze after it had been verified (position in seconds). */
  playbackProblem(requestId: string, error: CastError, position: number): void;
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

  if (req.textTracks?.length) {
    info.tracks = req.textTracks.map((t) => {
      const track = new chrome.cast.media.Track(t.id, chrome.cast.media.TrackType.TEXT);
      track.trackContentId = t.url;
      track.trackContentType = 'text/vtt';
      track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
      track.name = t.name;
      if (t.language) track.language = t.language;
      return track;
    });
  }

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
  private receiverError: ReceiverError | undefined;
  private listenedSession: cast.framework.CastSession | null = null;
  private watch: {
    requestId: string;
    startedAt: number;
    lastProgressAt: number;
    lastTime: number;
    reported: boolean;
    timer: ReturnType<typeof setInterval>;
  } | null = null;

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
    if (command.type === 'stop' || command.type === 'disconnect') {
      this.clearVerification();
      this.stopWatching();
    }
    this.emit();
    return result;
  }

  private onSessionState(e: cast.framework.SessionStateEventData): void {
    const S = cast.framework.SessionState;
    switch (e.sessionState) {
      case S.SESSION_STARTED:
      case S.SESSION_RESUMED:
        this.override = null;
        this.listenForReceiverErrors(e.session);
        if (this.pending) void this.loadPending();
        break;
      case S.SESSION_START_FAILED:
        this.override = this.pending ? 'awaiting-device' : null;
        this.error = sessionError(e.errorCode);
        break;
      case S.SESSION_ENDED:
        this.clearVerification();
        this.stopWatching();
        this.listenedSession = null;
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

    this.stopWatching();
    this.receiverError = undefined;
    this.listenForReceiverErrors(session);
    let code: unknown;
    try {
      code = await session.loadMedia(buildLoadRequest(req));
    } catch (e) {
      code = e;
    }
    this.loading = false;
    if (code) {
      this.fail(req.requestId, this.refine(loadError(code)));
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
        this.startWatching(requestId);
      } else if (phase === 'error') {
        this.fail(this.verify.requestId, this.refine(loadError('load_media_failed')));
      }
    } else if (phase === 'error' && this.current && !this.error) {
      this.error = this.refine(midPlaybackError());
      this.reportProblem(this.error);
    }
  }

  /** Receiver error messages on the media channel carry a DetailedErrorCode; keep the latest. */
  private listenForReceiverErrors(session: cast.framework.CastSession | null): void {
    if (!session || this.listenedSession === session) return;
    this.listenedSession = session;
    try {
      session.addMessageListener(MEDIA_NAMESPACE, (_ns, message) => {
        try {
          const data = JSON.parse(message) as { type?: string; detailedErrorCode?: number; reason?: string };
          if (typeof data.detailedErrorCode === 'number' && /ERROR|FAILED|INVALID/.test(data.type ?? '')) {
            this.receiverError = { detailedErrorCode: data.detailedErrorCode, reason: data.reason, at: Date.now() };
          }
        } catch {
          /* not JSON: ignore */
        }
      });
    } catch {
      // Some SDK versions keep the media namespace to themselves; errors then stay generic.
    }
  }

  private refine(error: CastError): CastError {
    const recent = this.receiverError && Date.now() - this.receiverError.at < RECEIVER_ERROR_TTL_MS ? this.receiverError : undefined;
    return withReceiverDetail(error, recent);
  }

  /** Watches the first minutes of verified playback for freezes the receiver doesn't report. */
  private startWatching(requestId: string): void {
    this.stopWatching();
    const now = Date.now();
    this.watch = {
      requestId,
      startedAt: now,
      lastProgressAt: now,
      lastTime: this.remote.player.currentTime,
      reported: false,
      timer: setInterval(() => this.checkStall(), 2000),
    };
  }

  private stopWatching(): void {
    if (this.watch) clearInterval(this.watch.timer);
    this.watch = null;
  }

  private checkStall(): void {
    const w = this.watch;
    if (!w) return;
    const now = Date.now();
    if (now - w.startedAt > WATCH_MS || this.current?.requestId !== w.requestId) return this.stopWatching();
    const phase = this.remote.phase(this.idleReason());
    const time = this.remote.player.currentTime;
    if (phase === 'paused' || time > w.lastTime + 0.25) {
      // Paused on purpose, or progressing: both reset the clock.
      w.lastProgressAt = now;
      w.lastTime = time;
      return;
    }
    if ((phase === 'playing' || phase === 'buffering') && now - w.lastProgressAt > STALL_MS) {
      this.reportProblem(this.refine(STALLED));
    }
  }

  private reportProblem(error: CastError): void {
    const requestId = this.current?.requestId;
    if (!requestId) return;
    if (this.watch?.requestId === requestId) {
      if (this.watch.reported) return;
      this.watch.reported = true;
    }
    this.events.playbackProblem(requestId, error, Math.floor(this.remote.player.currentTime || 0));
    this.stopWatching();
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
    const textTracks = (player.mediaInfo?.tracks ?? [])
      .filter((t) => t.type === chrome.cast.media.TrackType.TEXT)
      .map((t) => ({ id: t.trackId, name: t.name || t.language || `Track ${t.trackId}`, language: t.language || undefined }));
    const active = session?.getMediaSession()?.activeTrackIds ?? [];
    return {
      phase: this.override ?? derived,
      sessionActive: !!session,
      devicesAvailable: this.context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE,
      deviceName: decodeEntities(session?.getCastDevice().friendlyName),
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
      plan: req?.plan,
      textTracks,
      activeTextTrack: textTracks.find((t) => active.includes(t.id))?.id ?? null,
      error: this.error,
      updatedAt: Date.now(),
    };
  }

  private emit(): void {
    this.events.status(this.status());
  }
}
