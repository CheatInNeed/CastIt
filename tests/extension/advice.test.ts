import { describe, expect, it } from 'vitest';
import type { CastErrorCode } from '@castit/shared';
import { adviceFor, drmNames, emptyPageExplanation } from '../../apps/extension/src/lib/advice.ts';

const e = (code: CastErrorCode) => ({ code, message: 'x' });
const none = { companion: 'offline' as const, ffmpeg: false };
const paired = { companion: 'paired' as const, ffmpeg: false };
const full = { companion: 'paired' as const, ffmpeg: true };

describe('adviceFor', () => {
  it('suggests the next missing piece of setup', () => {
    expect(adviceFor(e('MANIFEST_INACCESSIBLE'), none)).toMatch(/npm run companion/);
    expect(adviceFor(e('MANIFEST_INACCESSIBLE'), paired)).toMatch(/Copy diagnostics/);
    expect(adviceFor(e('UNSUPPORTED_CODEC'), none)).toMatch(/FFmpeg installed/);
    expect(adviceFor(e('UNSUPPORTED_CODEC'), paired)).toMatch(/brew install ffmpeg/);
    expect(adviceFor(e('UNSUPPORTED_CODEC'), full)).toMatch(/Your Chromecast/);
  });

  it('is honest about what Castit will not do', () => {
    expect(adviceFor(e('DRM'), full)).toMatch(/own Cast button/);
    expect(adviceFor(e('AUTH_REQUIRED'), full)).toMatch(/never uses your login/);
  });

  it('covers practical problems and stays quiet when there is nothing to add', () => {
    expect(adviceFor(e('NO_DEVICE'), none)).toMatch(/same Wi-Fi/);
    expect(adviceFor(e('STREAM_UNAVAILABLE'), none)).toMatch(/Reload the page/);
    expect(adviceFor(e('SESSION_CANCELLED'), none)).toBeUndefined();
  });
});

describe('emptyPageExplanation', () => {
  it('names DRM first (Netflix-style pages)', () => {
    expect(drmNames(['com.widevine.alpha', 'com.microsoft.playready.recommendation', 'com.widevine.alpha'])).toEqual(['Widevine', 'PlayReady']);
    const text = emptyPageExplanation({ drmKeySystems: ['com.widevine.alpha'], mediaSource: true });
    expect(text).toMatch(/DRM-protected video \(Widevine\)/);
    expect(text).toMatch(/own Cast button/);
  });

  it('points private-format players (YouTube-style) to the site’s own Cast button', () => {
    expect(emptyPageExplanation({ drmKeySystems: [], mediaSource: true })).toMatch(/private format.*own Cast button/);
  });

  it('falls back to the plain hint', () => {
    expect(emptyPageExplanation({ drmKeySystems: [], mediaSource: false })).toMatch(/Start playing the video/);
  });
});
