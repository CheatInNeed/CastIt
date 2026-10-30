// Casting to one TV with Google's Default Media Receiver over CASTV2: starts the receiver app,
// loads media, verifies that playback really starts, watches the first minutes for freezes, and
// executes remote commands. Reports a CastStatus after every change (and every second while playing).
import type { CastDeviceInfo, CastError, CastPhase, CastRequest, CastStatus, RemoteCommand } from '@castit/shared';
import { CastChannel, NS, PLATFORM, type CastMessage } from './channel.ts';
import {
  connectError,
  loadError,
  midPlaybackError,
  PLAYBACK_TIMEOUT,
  STALLED,
  withReceiverDetail,
  type ReceiverError,
} from './errors.ts';

export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const VERIFY_TIMEOUT_MS = 30_000;
/** After playback is verified, watch this long for freezes (broken segments, throttled relays…). */
const WATCH_MS = 120_000;
const STALL_MS = 20_000;
/** Receiver errors older than this are not attributed to a new failure. */
const RECEIVER_ERROR_TTL_MS = 30_000;
const TICK_MS = 1000;
const ERROR_GRACE_MS = 500;
/** Ask for a fresh media status this often (the receiver only reports changes). */
const POLL_TICKS = 5;
/** supportedMediaCommands bits. */
const CMD_PAUSE = 1;
const CMD_SEEK = 2;

export interface ReceiverEvents {
  status(status: CastStatus): void;
  loadResult(requestId: string, error?: CastError): void;
  /** Playback failed or froze after it had been verified (position in seconds). */
  playbackProblem(requestId: string, error: CastError, position: number): void;
}

interface MediaInfo {
  contentId?: string;
  contentUrl?: string;
  streamType?: string;
  duration?: number | null;
  metadata?: { title?: string };
  tracks?: Array<{ trackId: number; type: string; name?: string; language?: string }>;
}

interface MediaStatus {
  mediaSessionId: number;
  playerState: string;
  idleReason?: string;
  currentTime: number;
  playbackRate?: number;
  supportedMediaCommands?: number;
  activeTrackIds?: number[];
  media?: MediaInfo;
}

interface App {
  sessionId: string;
  transportId: string;
}

export type Connect = (device: CastDeviceInfo) => Promise<CastChannel>;

const defaultConnect: Connect = (device) => CastChannel.connect(device.host, device.port);

function findApp(data: Record<string, unknown>): App | null {
  const status = data.status as { applications?: Array<{ appId?: string; sessionId?: string; transportId?: string }> } | undefined;
  const app = status?.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
  return app?.sessionId && app.transportId ? { sessionId: app.sessionId, transportId: app.transportId } : null;
}

export function buildLoad(req: CastRequest, sessionId: string): Record<string, unknown> {
  const media: Record<string, unknown> = {
    // contentUrl is what CAF receivers fetch; contentId is kept identical for older receivers.
    contentId: req.url,
    contentUrl: req.url,
    contentType: req.contentType,
    streamType: req.streamType === 'LIVE' ? 'LIVE' : 'BUFFERED',
    metadata: {
      metadataType: 0,
      title: req.title,
      ...(req.subtitle ? { subtitle: req.subtitle } : {}),
      ...(req.posterUrl ? { images: [{ url: req.posterUrl }] } : {}),
    },
  };
  if (req.duration) media.duration = req.duration;
  if (req.hlsSegmentFormat) media.hlsSegmentFormat = req.hlsSegmentFormat;
  if (req.hlsVideoSegmentFormat) media.hlsVideoSegmentFormat = req.hlsVideoSegmentFormat;
  if (req.textTracks?.length) {
    media.tracks = req.textTracks.map((t) => ({
      trackId: t.id,
      type: 'TEXT',
      subtype: 'SUBTITLES',
      trackContentId: t.url,
      trackContentType: 'text/vtt',
      name: t.name,
      ...(t.language ? { language: t.language } : {}),
    }));
  }
  return { type: 'LOAD', sessionId, media, autoplay: true, currentTime: req.startTime ?? 0, activeTrackIds: [] };
}

/** Phase derived purely from the receiver's media status. */
export function phaseOf(media: MediaStatus | null): CastPhase {
  switch (media?.playerState) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED':
      return 'paused';
    case 'BUFFERING':
      return 'buffering';
    case 'LOADING':
      return 'loading';
    case 'IDLE':
      if (media.idleReason === 'FINISHED') return 'ended';
      if (media.idleReason === 'ERROR') return 'error';
      return 'idle';
    default:
      return 'idle';
  }
}

export class Receiver {
  /** Set by the host from discovery; reported in every status. */
  devicesAvailable = false;
  private readonly events: ReceiverEvents;
  private readonly connect: Connect;
  private channel: CastChannel | null = null;
  private device: CastDeviceInfo | null = null;
  private app: App | null = null;
  private volume = { level: 1, muted: false };
  private media: MediaStatus | null = null;
  private mediaInfo: MediaInfo | null = null;
  private statusAt = 0;
  /** Most recently loaded (or adopted) request. */
  private current: CastRequest | null = null;
  /** Overrides the receiver-derived phase while Castit itself is busy or failed. */
  private override: CastPhase | null = null;
  private error: CastError | undefined;
  private verify: { requestId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private receiverError: ReceiverError | undefined;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private watch: {
    requestId: string;
    startedAt: number;
    lastProgressAt: number;
    lastTime: number;
    reported: boolean;
    timer: ReturnType<typeof setInterval>;
  } | null = null;

  constructor(events: ReceiverEvents, connect: Connect = defaultConnect) {
    this.events = events;
    this.connect = connect;
  }

  /** Starts the receiver app on `device` if needed and loads `req`; the outcome arrives via loadResult. */
  async cast(device: CastDeviceInfo, req: CastRequest): Promise<void> {
    if (req.requestId === this.current?.requestId) return;
    this.current = req;
    this.error = undefined;
    this.override = 'connecting';
    this.clearVerification();
    this.stopWatching();
    this.emit();

    let app: App | null;
    try {
      app = await this.ensureApp(device, true);
    } catch (e) {
      if (this.current?.requestId === req.requestId) this.fail(req.requestId, connectError(device.name, e));
      return;
    }
    if (this.current?.requestId !== req.requestId || !app || !this.channel) return;

    this.override = 'loading';
    this.receiverError = undefined;
    this.media = null;
    this.mediaInfo = null;
    this.emit();
    let reply: CastMessage;
    try {
      reply = await this.channel.request(app.transportId, NS.media, buildLoad(req, app.sessionId), VERIFY_TIMEOUT_MS);
    } catch (e) {
      if (this.current?.requestId === req.requestId) {
        this.fail(req.requestId, this.refine(loadError((e as Error).message === 'timeout' ? 'timeout' : 'channel_error')));
      }
      return;
    }
    if (this.current?.requestId !== req.requestId) return;
    if (reply.data.type !== 'MEDIA_STATUS') {
      this.noteReceiverError(reply.data);
      // The detailed reason often follows in a separate ERROR message.
      await new Promise((r) => setTimeout(r, ERROR_GRACE_MS));
      if (this.current?.requestId !== req.requestId) return;
      const type = String(reply.data.type);
      const code = type === 'LOAD_CANCELLED' ? 'cancel' : type === 'LOAD_FAILED' ? 'load_media_failed' : String(reply.data.reason ?? type);
      this.fail(req.requestId, this.refine(loadError(code)));
      return;
    }
    // The receiver accepted the request; wait for real playback.
    this.override = null;
    this.verify = {
      requestId: req.requestId,
      timer: setTimeout(() => this.fail(req.requestId, PLAYBACK_TIMEOUT), VERIFY_TIMEOUT_MS),
    };
    this.checkPlayback();
    this.emit();
  }

  /**
   * Re-attaches to a cast started by an earlier run of the companion (Chrome stops it when idle),
   * but only when the TV is still playing that very stream: a cast started from another device
   * is never mistaken for Castit's.
   */
  async adopt(device: CastDeviceInfo, req: CastRequest): Promise<void> {
    if (this.current || this.app) return;
    try {
      const app = await this.ensureApp(device, false);
      if (!app || !this.channel) return this.reset();
      const reply = await this.channel.request(app.transportId, NS.media, { type: 'GET_STATUS' });
      const entry = (reply.data.status as MediaStatus[] | undefined)?.[0];
      const info = entry?.media ?? this.mediaInfo;
      if (!info || (info.contentId !== req.url && info.contentUrl !== req.url) || this.current) return this.reset();
      this.current = req;
      this.emit();
    } catch {
      this.reset();
    }
  }

  execute(command: RemoteCommand): CastError | null {
    const channel = this.channel;
    const app = this.app;
    if (!channel || !app) return { code: 'NO_DEVICE', message: 'Nothing is casting right now.' };
    const sendMedia = (data: Record<string, unknown>) =>
      channel.command(app.transportId, NS.media, { ...data, mediaSessionId: this.media?.mediaSessionId });
    const sendReceiver = (data: Record<string, unknown>) => channel.command(PLATFORM, NS.receiver, data);

    switch (command.type) {
      case 'volume':
        sendReceiver({ type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, command.level)) } });
        return null;
      case 'mute':
        sendReceiver({ type: 'SET_VOLUME', volume: { muted: command.muted } });
        return null;
      case 'stop':
      case 'disconnect':
        // Stopping the receiver app returns the TV to its home screen.
        this.clearVerification();
        this.stopWatching();
        if (this.media) sendMedia({ type: 'STOP' });
        sendReceiver({ type: 'STOP', sessionId: app.sessionId });
        return null;
    }

    const media = this.media;
    if (!media) return { code: 'RECEIVER_LOAD_FAILED', message: 'Nothing is loaded on the TV.' };
    switch (command.type) {
      case 'togglePlay':
        sendMedia({ type: media.playerState === 'PAUSED' || media.playerState === 'IDLE' ? 'PLAY' : 'PAUSE' });
        break;
      case 'play':
        sendMedia({ type: 'PLAY' });
        break;
      case 'pause':
        sendMedia({ type: 'PAUSE' });
        break;
      case 'seek':
      case 'seekRelative': {
        if (!((media.supportedMediaCommands ?? 0) & CMD_SEEK)) return { code: 'INTERNAL', message: 'This stream cannot be seeked.' };
        const target = command.type === 'seek' ? command.time : this.position() + command.delta;
        const duration = this.mediaInfo?.duration ?? 0;
        const max = duration > 0 ? duration - 1 : target;
        sendMedia({ type: 'SEEK', currentTime: Math.max(0, Math.min(target, max)) });
        break;
      }
      case 'rate':
        sendMedia({ type: 'SET_PLAYBACK_RATE', playbackRate: Math.max(0.5, Math.min(2, command.rate)) });
        break;
      case 'subtitles':
        sendMedia({ type: 'EDIT_TRACKS_INFO', activeTrackIds: command.trackId === null ? [] : [command.trackId] });
        break;
    }
    return null;
  }

  status(): CastStatus {
    const media = this.media;
    const info = this.mediaInfo;
    const req = this.current;
    const textTracks = (info?.tracks ?? [])
      .filter((t) => t.type === 'TEXT')
      .map((t) => ({ id: t.trackId, name: t.name || t.language || `Track ${t.trackId}`, language: t.language || undefined }));
    const commands = media?.supportedMediaCommands ?? 0;
    return {
      phase: this.override ?? (this.app ? phaseOf(media) : 'idle'),
      sessionActive: !!this.app,
      devicesAvailable: this.devicesAvailable,
      deviceName: this.app || req ? this.device?.name : undefined,
      title: info?.metadata?.title ?? req?.title,
      contentUrl: info?.contentId ?? req?.url,
      currentTime: this.position(),
      duration: info?.duration && info.duration > 0 ? info.duration : (req?.duration ?? null),
      live: info ? info.streamType === 'LIVE' : req?.streamType === 'LIVE',
      canSeek: (commands & CMD_SEEK) !== 0,
      canPause: (commands & CMD_PAUSE) !== 0,
      volume: this.volume.level,
      muted: this.volume.muted,
      requestId: req?.requestId,
      sourceTabId: req?.sourceTabId,
      engine: req?.engine,
      plan: req?.plan,
      textTracks,
      activeTextTrack: textTracks.find((t) => media?.activeTrackIds?.includes(t.id))?.id ?? null,
      error: this.error,
      updatedAt: Date.now(),
    };
  }

  /** Disconnects without stopping anything on the TV. */
  close(): void {
    this.clearVerification();
    this.stopWatching();
    this.channel?.close();
  }

  // ---------------------------------------------------------------- connection

  /** Connects to `device` (reusing the open connection) and finds or launches the receiver app. */
  private async ensureApp(device: CastDeviceInfo, launch: boolean): Promise<App | null> {
    if (!this.channel || this.channel.isClosed || this.device?.id !== device.id) {
      // Detach first, so closing the old connection doesn't end the cast being started.
      const old = this.channel;
      this.channel = null;
      old?.close();
      this.app = null;
      this.device = device;
      const channel = await this.connect(device);
      this.channel = channel;
      channel.on('message', (m: CastMessage) => {
        if (this.channel === channel) this.onMessage(m);
      });
      channel.once('close', () => {
        if (this.channel === channel) this.onChannelClosed();
      });
    }
    const channel = this.channel;
    if (this.app) return this.app;
    let app = findApp((await channel.request(PLATFORM, NS.receiver, { type: 'GET_STATUS' })).data);
    if (!app && launch) {
      const reply = await channel.request(PLATFORM, NS.receiver, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER }, 30_000);
      if (reply.data.type === 'LAUNCH_ERROR') throw new Error(`The TV refused to start the media player (${String(reply.data.reason ?? 'unknown reason')}).`);
      app = findApp(reply.data) ?? (await this.waitForApp(channel));
    }
    if (!app) return null;
    this.app = app;
    channel.send(app.transportId, NS.connection, { type: 'CONNECT' });
    this.startTicker();
    return app;
  }

  /** Some receivers confirm LAUNCH before listing the app; wait for the status that does. */
  private waitForApp(channel: CastChannel): Promise<App> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.off('message', listener);
        reject(new Error('The media player did not start on the TV.'));
      }, 15_000);
      const listener = (m: CastMessage) => {
        const app = m.data.type === 'RECEIVER_STATUS' ? findApp(m.data) : null;
        if (!app) return;
        clearTimeout(timer);
        channel.off('message', listener);
        resolve(app);
      };
      channel.on('message', listener);
    });
  }

  private onChannelClosed(): void {
    const hadApp = !!this.app;
    this.channel = null;
    this.endSession();
    if (hadApp) this.error = { code: 'NO_DEVICE', message: 'Lost the connection to the TV.' };
    this.emit();
  }

  /** Forgets a connection that turned out not to be needed (adopt found nothing of ours). */
  private reset(): void {
    const channel = this.channel;
    this.channel = null;
    channel?.close();
    this.endSession();
    // Tells the extension that the cast it remembered is over.
    this.emit();
  }

  private endSession(): void {
    this.clearVerification();
    this.stopWatching();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.app = null;
    this.media = null;
    this.mediaInfo = null;
    this.current = null;
    this.override = null;
  }

  // ---------------------------------------------------------------- receiver messages

  private onMessage(m: CastMessage): void {
    const { data } = m;
    if (m.namespace === NS.receiver && data.type === 'RECEIVER_STATUS') {
      const volume = (data.status as { volume?: { level?: number; muted?: boolean } } | undefined)?.volume;
      if (typeof volume?.level === 'number') this.volume.level = volume.level;
      if (typeof volume?.muted === 'boolean') this.volume.muted = volume.muted;
      // The receiver app was stopped (from the TV remote, another phone, or by us).
      if (this.app && findApp(data)?.sessionId !== this.app.sessionId) this.endSession();
      this.emit();
      return;
    }
    if (m.namespace === NS.connection && data.type === 'CLOSE' && this.app && m.source === this.app.transportId) {
      this.endSession();
      this.emit();
      return;
    }
    if (m.namespace !== NS.media || !this.app || m.source !== this.app.transportId) return;
    this.noteReceiverError(data);
    if (data.type !== 'MEDIA_STATUS') return;
    // While connecting/loading only the reply to our own LOAD counts (not the old media's last words).
    if ((this.override === 'connecting' || this.override === 'loading') && !data.requestId) return;
    const entries = (data.status as MediaStatus[] | undefined) ?? [];
    const entry = entries.find((e) => e.mediaSessionId === this.media?.mediaSessionId) ?? entries[0];
    if (!entry) {
      this.media = null;
    } else {
      if (entry.media) {
        // Someone else loaded something else on the TV: it is no longer Castit's cast.
        const url = entry.media.contentId;
        if (this.current && url && url !== this.current.url && entry.media.contentUrl !== this.current.url && !this.override) {
          this.clearVerification();
          this.stopWatching();
          this.current = null;
        }
        this.mediaInfo = entry.media;
      }
      this.media = entry;
      this.statusAt = Date.now();
    }
    // A new receiver state supersedes Castit's own "error" overlay once it plays again.
    if (this.override === 'error' && entry?.playerState === 'PLAYING') {
      this.override = null;
      this.error = undefined;
    }
    this.checkPlayback();
    this.emit();
  }

  /** Receiver error messages on the media channel carry a DetailedErrorCode; keep the latest. */
  private noteReceiverError(data: Record<string, unknown>): void {
    if (typeof data.detailedErrorCode === 'number' && /ERROR|FAILED|INVALID/.test(String(data.type ?? ''))) {
      this.receiverError = { detailedErrorCode: data.detailedErrorCode, reason: data.reason as string | undefined, at: Date.now() };
    }
  }

  private refine(error: CastError): CastError {
    const recent = this.receiverError && Date.now() - this.receiverError.at < RECEIVER_ERROR_TTL_MS ? this.receiverError : undefined;
    return withReceiverDetail(error, recent);
  }

  // ---------------------------------------------------------------- playback verification

  private checkPlayback(): void {
    const phase = this.override ?? phaseOf(this.media);
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

  /** Watches the first minutes of verified playback for freezes the receiver doesn't report. */
  private startWatching(requestId: string): void {
    this.stopWatching();
    const now = Date.now();
    this.watch = {
      requestId,
      startedAt: now,
      lastProgressAt: now,
      lastTime: this.media?.currentTime ?? 0,
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
    const phase = phaseOf(this.media);
    // The raw reported position (refreshed by polling), not the interpolated one.
    const time = this.media?.currentTime ?? 0;
    if (phase === 'paused' || time > w.lastTime + 0.25) {
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
    this.events.playbackProblem(requestId, error, Math.floor(this.position()));
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

  // ---------------------------------------------------------------- position + status updates

  /** Current position, interpolated between the receiver's (change-only) status reports. */
  private position(): number {
    const media = this.media;
    if (!media) return 0;
    let time = media.currentTime || 0;
    if (media.playerState === 'PLAYING') time += ((Date.now() - this.statusAt) / 1000) * (media.playbackRate ?? 1);
    const duration = this.mediaInfo?.duration ?? 0;
    return duration > 0 ? Math.min(time, duration) : time;
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (!this.app || !this.channel) return;
      this.ticks++;
      if (this.media && this.ticks % POLL_TICKS === 0) {
        this.channel.command(this.app.transportId, NS.media, { type: 'GET_STATUS', mediaSessionId: this.media.mediaSessionId });
      }
      const phase = phaseOf(this.media);
      if (phase === 'playing' || phase === 'buffering' || this.ticks % 10 === 0) this.emit();
    }, TICK_MS);
    this.ticker.unref?.();
  }

  private emit(): void {
    this.events.status(this.status());
  }
}
