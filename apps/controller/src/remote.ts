// Remote control of the receiver via cast.framework.RemotePlayer / RemotePlayerController.
import type { CastError, CastPhase, RemoteCommand } from '@castit/shared';

export class Remote {
  readonly player = new cast.framework.RemotePlayer();
  readonly controller = new cast.framework.RemotePlayerController(this.player);

  constructor(onChange: (field: string) => void) {
    this.controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, (e) =>
      onChange((e as cast.framework.RemotePlayerChangedEvent).field),
    );
  }

  /** Phase derived purely from the receiver's media status. */
  phase(idleReason: chrome.cast.media.IdleReason | null | undefined): CastPhase {
    switch (this.player.playerState) {
      case chrome.cast.media.PlayerState.PLAYING:
        return 'playing';
      case chrome.cast.media.PlayerState.PAUSED:
        return 'paused';
      case chrome.cast.media.PlayerState.BUFFERING:
        return 'buffering';
      case chrome.cast.media.PlayerState.IDLE:
        if (idleReason === chrome.cast.media.IdleReason.FINISHED) return 'ended';
        if (idleReason === chrome.cast.media.IdleReason.ERROR) return 'error';
        return 'idle';
      default:
        return 'idle';
    }
  }

  get live(): boolean {
    return this.player.mediaInfo?.streamType === chrome.cast.media.StreamType.LIVE;
  }

  execute(command: RemoteCommand): CastError | null {
    const { player, controller } = this;
    if (!player.isConnected) {
      return { code: 'NO_DEVICE', message: 'No Cast session is active.' };
    }
    const mediaCommand = command.type !== 'volume' && command.type !== 'mute' && command.type !== 'disconnect';
    if (command.type === 'subtitles') {
      const media = cast.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession();
      if (!media) return { code: 'RECEIVER_LOAD_FAILED', message: 'Nothing is loaded on the Chromecast.' };
      const request = new chrome.cast.media.EditTracksInfoRequest(command.trackId === null ? [] : [command.trackId]);
      media.editTracksInfo(request, () => undefined, () => undefined);
      return null;
    }
    if (command.type === 'rate') {
      // RemotePlayer has no rate setter; send the standard media-namespace message (CAF receivers support it).
      const session = cast.framework.CastContext.getInstance().getCurrentSession();
      const media = session?.getMediaSession();
      if (!session || !media) return { code: 'RECEIVER_LOAD_FAILED', message: 'Nothing is loaded on the Chromecast.' };
      const rate = Math.max(0.5, Math.min(2, command.rate));
      void session
        .sendMessage('urn:x-cast:com.google.cast.media', { type: 'SET_PLAYBACK_RATE', mediaSessionId: media.mediaSessionId, playbackRate: rate, requestId: Date.now() % 1e9 })
        .catch(() => undefined);
      return null;
    }
    if (mediaCommand && !player.isMediaLoaded) {
      return { code: 'RECEIVER_LOAD_FAILED', message: 'Nothing is loaded on the Chromecast.' };
    }

    switch (command.type) {
      case 'togglePlay':
        controller.playOrPause();
        break;
      case 'play':
        if (player.isPaused) controller.playOrPause();
        break;
      case 'pause':
        if (!player.isPaused) controller.playOrPause();
        break;
      case 'seek':
      case 'seekRelative': {
        if (!player.canSeek) return { code: 'INTERNAL', message: 'This stream cannot be seeked.' };
        const target = command.type === 'seek' ? command.time : player.currentTime + command.delta;
        const max = player.duration > 0 ? player.duration - 1 : target;
        player.currentTime = Math.max(0, Math.min(target, max));
        controller.seek();
        break;
      }
      case 'volume':
        player.volumeLevel = Math.max(0, Math.min(1, command.level));
        controller.setVolumeLevel();
        break;
      case 'mute':
        if (player.isMuted !== command.muted) controller.muteOrUnmute();
        break;
      case 'stop':
        controller.stop();
        break;
      case 'disconnect':
        cast.framework.CastContext.getInstance().endCurrentSession(true);
        break;
    }
    return null;
  }
}
