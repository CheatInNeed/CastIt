// One plain sentence of "what you can do" for each error, tuned to what the user already has set up.
import type { CastError, CompanionStatus } from '@castit/shared';

export interface AdviceContext {
  companion: CompanionStatus['state'];
  ffmpeg: boolean;
}

const KEY_SYSTEM_NAMES: Array<[RegExp, string]> = [
  [/widevine/i, 'Widevine'],
  [/playready|microsoft/i, 'PlayReady'],
  [/fps|fairplay|apple/i, 'FairPlay'],
  [/clearkey/i, 'ClearKey'],
];

/** Readable DRM system names from EME key-system strings (e.g. com.widevine.alpha → Widevine). */
export function drmNames(keySystems: string[]): string[] {
  const names = keySystems.map((k) => KEY_SYSTEM_NAMES.find(([re]) => re.test(k))?.[1] ?? k);
  return [...new Set(names)];
}

/**
 * Why the popup lists nothing castable, in plain words. Order matters: a DRM page (Netflix, Disney+…)
 * says so first; a MediaSource player without any usable playlist (YouTube streams in its own
 * format) points to the site's own Cast button before suggesting a reload.
 */
export function emptyPageExplanation(info: { drmKeySystems: string[]; mediaSource: boolean }): string {
  if (info.drmKeySystems.length) {
    return `This page plays DRM-protected video (${drmNames(info.drmKeySystems).join(', ')}). Castit can’t cast protected video and never bypasses DRM. Use the site’s own Cast button if it has one.`;
  }
  if (info.mediaSource) {
    return 'The page’s player builds the video itself from pieces, and no playlist Castit can hand to a Chromecast was seen. Some sites (YouTube, for example) stream in a private format only their own player understands; use the site’s own Cast button there. Elsewhere, reload the page and start the video again so Castit sees the stream from the beginning.';
  }
  return 'No video detected yet. Start playing the video, then reopen Castit.';
}

const PAIR = 'Start the local companion (npm run companion) and pair it under “Local companion”';

export function adviceFor(error: CastError, ctx: AdviceContext): string | undefined {
  const paired = ctx.companion === 'paired';
  switch (error.code) {
    case 'NO_VIDEO':
      return 'Start playing the video on the page, then open Castit again.';
    case 'STREAM_UNAVAILABLE':
      return 'Reload the page and start the video again, so Castit sees a fresh link.';
    case 'MANIFEST_INACCESSIBLE':
    case 'SEGMENT_FAILURE':
    case 'RECEIVER_LOAD_FAILED':
      return paired
        ? 'Copy diagnostics shows exactly what the TV reported; send it along if you report a problem.'
        : `${PAIR}: it can fetch streams the Chromecast is blocked from.`;
    case 'AUTH_REQUIRED':
      return 'This site only gives the video to logged-in browsers, and Castit never uses your login. If the site has its own Cast button, use that.';
    case 'DRM':
      return 'Protected video can only be cast with the site’s own Cast button, if it has one.';
    case 'UNSUPPORTED_CODEC':
    case 'UNSUPPORTED_CONTAINER':
    case 'TRANSCODE_FAILED':
      if (!paired) return `${PAIR}, with FFmpeg installed, to convert this video.`;
      if (!ctx.ffmpeg) return 'Install FFmpeg (brew install ffmpeg) and restart the companion to convert this video.';
      return 'Check “Your Chromecast” under Local companion, so Castit converts exactly what your TV can’t play.';
    case 'NO_DEVICE':
      return 'Check that the Chromecast is on and on the same Wi-Fi as this computer. A VPN can hide it.';
    case 'PLAYBACK_TIMEOUT':
      return paired
        ? 'Weak Wi-Fi can cause this. Try a lower “Conversion quality” under Local companion.'
        : 'Weak Wi-Fi can cause this; so can a blocked stream. Pairing the local companion lets Castit try another way.';
    case 'COMPANION_UNAVAILABLE':
      return `${PAIR}.`;
    case 'INTERNAL':
      return 'Click Copy diagnostics and include the text when you report this.';
    default:
      return undefined;
  }
}
