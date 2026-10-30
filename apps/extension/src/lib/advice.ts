// One short "what you can do" for each error, tuned to what the user already has set up.
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
    return `This video is DRM-protected (${drmNames(info.drmKeySystems).join(', ')}), which Castit can’t cast. Use the site’s own Cast button.`;
  }
  if (info.mediaSource) {
    return 'This player streams in a private format (like YouTube). Use the site’s own Cast button, or reload and play again.';
  }
  return 'No video found. Play the video, then open Castit again.';
}

const SETUP = 'Run `npm run setup` in the Castit folder.';

export function adviceFor(error: CastError, ctx: AdviceContext): string | undefined {
  switch (error.code) {
    case 'NO_VIDEO':
      return 'Play the video on the page, then open Castit again.';
    case 'STREAM_UNAVAILABLE':
      return 'Reload the page and play the video again.';
    case 'MANIFEST_INACCESSIBLE':
    case 'SEGMENT_FAILURE':
    case 'RECEIVER_LOAD_FAILED':
      return ctx.companion === 'ready' ? undefined : SETUP;
    case 'AUTH_REQUIRED':
      return 'The site only gives this video to logged-in browsers. Use its own Cast button.';
    case 'DRM':
      return 'Use the site’s own Cast button.';
    case 'UNSUPPORTED_CODEC':
    case 'UNSUPPORTED_CONTAINER':
    case 'TRANSCODE_FAILED':
      if (ctx.companion !== 'ready') return SETUP;
      if (!ctx.ffmpeg) return 'Install FFmpeg (brew install ffmpeg) to convert this video.';
      return 'Set your TV model in Castit’s settings.';
    case 'NO_DEVICE':
      return 'Check that the TV is on and on the same Wi-Fi. A VPN can hide it.';
    case 'PLAYBACK_TIMEOUT':
      return 'Weak Wi-Fi can cause this. Try again, or pick a lower quality in settings.';
    case 'COMPANION_UNAVAILABLE':
      return SETUP;
    default:
      return undefined;
  }
}
