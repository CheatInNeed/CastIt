// Maps Cast receiver replies and connection failures to specific Castit errors.
import type { CastError } from '@castit/shared';

/** The TV could not be reached or refused to start the media player app. */
export function connectError(deviceName: string, reason: unknown): CastError {
  return {
    code: 'NO_DEVICE',
    message: `Could not connect to ${deviceName}. Check that it is on and on the same Wi-Fi as this computer.`,
    detail: reason instanceof Error ? reason.message : String(reason),
  };
}

export function loadError(code: unknown): CastError {
  switch (code) {
    case 'load_media_failed':
      return {
        code: 'RECEIVER_LOAD_FAILED',
        message: 'The Chromecast could not load this stream.',
        detail:
          'Common causes: the stream host blocks cross-origin requests (no CORS headers), the URL needs your cookies or a Referer, the signed URL expired, or the codec is unsupported.',
      };
    case 'timeout':
      return { code: 'PLAYBACK_TIMEOUT', message: 'The Chromecast did not answer the load request in time.' };
    case 'session_error':
    case 'channel_error':
      return { code: 'RECEIVER_LOAD_FAILED', message: 'The connection to the Chromecast failed while loading.', detail: String(code) };
    case 'cancel':
      return { code: 'SESSION_CANCELLED', message: 'Loading was cancelled.' };
    default:
      return { code: 'RECEIVER_LOAD_FAILED', message: 'The Chromecast rejected the load request.', detail: String(code) };
  }
}

export function midPlaybackError(): CastError {
  return {
    code: 'SEGMENT_FAILURE',
    message: 'Playback stopped on the Chromecast with an error.',
    detail:
      'The receiver could not fetch or decode part of the stream (segments blocked, expired URL, or unsupported codec).',
  };
}

export const PLAYBACK_TIMEOUT: CastError = {
  code: 'PLAYBACK_TIMEOUT',
  message: 'The Chromecast accepted the stream, but playback did not start within 30 seconds.',
};

/** An error the receiver reported on the media channel (CAF DetailedErrorCode). */
export interface ReceiverError {
  detailedErrorCode: number;
  reason?: string;
  at: number;
}

/**
 * Refines a generic failure with the receiver's DetailedErrorCode, so the user learns *what*
 * broke (playlist download, segment download, decoding, DRM) and the strategy can pick the right
 * next engine (relay for access problems, FFmpeg for codec problems).
 */
export function withReceiverDetail(base: CastError, receiver: ReceiverError | undefined): CastError {
  if (!receiver) return base;
  const code = receiver.detailedErrorCode;
  const detail = `Chromecast error ${code}${receiver.reason ? ` (${receiver.reason})` : ''}.`;
  if ([311, 312, 400, 411, 412, 420, 421, 422, 423, 431].includes(code)) {
    return {
      code: 'MANIFEST_INACCESSIBLE',
      message: 'The Chromecast could not download or read the stream’s playlist (often blocked by the server: CORS or Referer checks).',
      detail,
    };
  }
  if ([313, 314].includes(code)) {
    return { code: 'SEGMENT_FAILURE', message: 'The Chromecast could not fetch the stream’s decryption key.', detail };
  }
  if ([103, 300, 301, 315, 321, 322, 331, 332, 500].includes(code)) {
    return { code: 'SEGMENT_FAILURE', message: 'The Chromecast could not download parts of the video.', detail };
  }
  if ([102, 110, 316].includes(code)) {
    return { code: 'UNSUPPORTED_CODEC', message: 'The Chromecast could not decode this video (unsupported codec, profile or resolution).', detail };
  }
  if (code === 104) {
    return { code: 'UNSUPPORTED_CONTAINER', message: 'The Chromecast does not support this video format.', detail };
  }
  if (code >= 200 && code < 300) {
    return { code: 'DRM', message: 'The stream needs a DRM license the Chromecast does not have.', detail };
  }
  return { ...base, detail: base.detail ? `${base.detail} ${detail}` : detail };
}

export const STALLED: CastError = {
  code: 'SEGMENT_FAILURE',
  message: 'Playback on the TV froze: no progress for 20 seconds.',
};
