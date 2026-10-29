// Maps Cast SDK error codes (chrome.cast.ErrorCode string values) to specific Castit errors.
import type { CastError } from '@castit/shared';

export function sessionError(code: unknown): CastError {
  switch (code) {
    case 'cancel':
      return { code: 'SESSION_CANCELLED', message: 'Device selection was cancelled.' };
    case 'receiver_unavailable':
      return {
        code: 'NO_DEVICE',
        message: 'No compatible Cast device is available. Check that the Chromecast is on and on the same network.',
      };
    case 'timeout':
      return { code: 'NO_DEVICE', message: 'The Chromecast did not respond in time.' };
    case 'extension_missing':
    case 'extension_not_compatible':
    case 'api_not_initialized':
      return { code: 'NO_DEVICE', message: 'Google Cast is not available in this browser.', detail: String(code) };
    default:
      return { code: 'NO_DEVICE', message: 'Could not start a Cast session.', detail: String(code) };
  }
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
    case 'receiver_unavailable':
      return sessionError(code);
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Cast device names arrive HTML-escaped (e.g. "Peter&#39;s TV"). Decodes named and numeric
 * entities into plain text; the result is only ever shown via textContent.
 */
export function decodeEntities(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]!.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

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
