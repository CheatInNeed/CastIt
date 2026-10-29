import { describe, expect, it } from 'vitest';
import type { CastabilityAssessment } from '@castit/shared';
import { chooseEngine, shouldFallBack, upstreamContextFor, withCompanion } from '../../apps/extension/src/lib/engine.ts';
import { assessCastability } from '../../apps/extension/src/lib/castability.ts';
import { candidate } from './helpers.ts';

const plain: CastabilityAssessment = { level: 'likely', engine: 'direct', notes: [] };
const noCors: CastabilityAssessment = { level: 'possible', engine: 'direct', notes: [], companionHelps: 'the stream host sends no CORS headers' };

describe('castability → companion signal', () => {
  it('flags missing CORS and Referer refusals as fixable by the companion', () => {
    // cors: null in a probe means the header was absent.
    expect(assessCastability(candidate(), { reachable: true, status: 200, cors: null }).companionHelps).toMatch(/CORS/);
    expect(assessCastability(candidate({ kind: 'progressive', container: 'mp4' }), { reachable: true, status: 200, cors: null }).companionHelps).toBeUndefined();
    const hls = { reachable: true, status: 200, cors: null as string | null };
    expect(assessCastability(candidate({ kind: 'progressive', container: 'mp4' }), { ...hls, status: 403 }).companionHelps).toMatch(/Referer/);
  });
});

describe('chooseEngine', () => {
  it('auto: direct unless the companion is ready and would help', () => {
    expect(chooseEngine('auto', plain, true)).toEqual({ engine: 'direct' });
    expect(chooseEngine('auto', noCors, false)).toEqual({ engine: 'direct' });
    expect(chooseEngine('auto', noCors, true)).toEqual({ engine: 'companion' });
  });

  it('honours forced modes', () => {
    expect(chooseEngine('direct', noCors, true)).toEqual({ engine: 'direct' });
    expect(chooseEngine('companion', plain, true)).toEqual({ engine: 'companion' });
    const missing = chooseEngine('companion', plain, false);
    expect('error' in missing && missing.error.code).toBe('COMPANION_UNAVAILABLE');
  });
});

describe('withCompanion', () => {
  it('upgrades the shown rating only when the companion is ready', () => {
    expect(withCompanion(noCors, true, 'auto')).toMatchObject({ level: 'likely', engine: 'companion' });
    expect(withCompanion({ ...noCors, level: 'unlikely' }, true, 'auto').level).toBe('possible');
    const offline = withCompanion(noCors, false, 'auto');
    expect(offline.level).toBe('possible');
    expect(offline.notes.at(-1)).toMatch(/not running or not paired/);
    expect(withCompanion(noCors, true, 'direct')).toBe(noCors);
  });

  it('never overrides blockers', () => {
    const drm: CastabilityAssessment = { level: 'unsupported', engine: null, notes: [], blocker: { code: 'DRM', message: 'x' }, companionHelps: 'x' };
    expect(withCompanion(drm, true, 'companion')).toBe(drm);
  });
});

describe('shouldFallBack', () => {
  const failed = { code: 'RECEIVER_LOAD_FAILED' as const, message: 'x' };
  it('retries once through the companion for receiver-side failures in auto mode', () => {
    expect(shouldFallBack('auto', ['direct'], failed, true)).toBe(true);
    expect(shouldFallBack('auto', ['direct', 'companion'], failed, true)).toBe(false);
    expect(shouldFallBack('direct', ['direct'], failed, true)).toBe(false);
    expect(shouldFallBack('auto', ['direct'], failed, false)).toBe(false);
    expect(shouldFallBack('auto', ['direct'], { code: 'NO_DEVICE', message: 'x' }, true)).toBe(false);
  });
});

describe('upstreamContextFor', () => {
  it('mimics strict-origin-when-cross-origin referrers', () => {
    const cross = upstreamContextFor({ url: 'https://cdn.example.net/a.m3u8', kind: 'hls' }, 'https://player.example.com/embed/123?x=1', undefined, 'UA');
    expect(cross).toEqual({ userAgent: 'UA', referer: 'https://player.example.com/', origin: 'https://player.example.com' });
    const same = upstreamContextFor({ url: 'https://site.example/v.mp4', kind: 'progressive' }, 'https://site.example/watch/9', undefined, 'UA');
    expect(same).toEqual({ userAgent: 'UA', referer: 'https://site.example/watch/9' });
  });

  it('prefers the request initiator as Origin and skips non-http frames', () => {
    const ctx = upstreamContextFor({ url: 'https://cdn.example.net/a.mpd', kind: 'dash' }, 'about:blank', 'https://player.example.com', 'UA');
    expect(ctx).toEqual({ userAgent: 'UA', origin: 'https://player.example.com' });
  });
});
