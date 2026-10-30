import { describe, expect, it } from 'vitest';
import type { CastabilityAssessment } from '@castit/shared';
import { chooseEngine, nextEngine, upstreamContextFor, withCompanion } from '../../apps/extension/src/lib/engine.ts';
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

const ready = { ready: true, ffmpeg: false };
const withFfmpeg = { ready: true, ffmpeg: true };
const offline = { ready: false, ffmpeg: false };
const mkv: CastabilityAssessment = { level: 'possible', engine: 'direct', notes: [], transcodeHelps: 'MKV may need converting' };
const flv: CastabilityAssessment = {
  level: 'unsupported',
  engine: null,
  notes: ['Chromecast cannot play FLV files directly'],
  blocker: { code: 'UNSUPPORTED_CONTAINER', message: 'Chromecast cannot play FLV files directly' },
  transcodeHelps: 'FLV files must be converted',
};

describe('chooseEngine', () => {
  it('auto: cheapest engine that addresses the known problem', () => {
    expect(chooseEngine('auto', plain, withFfmpeg)).toEqual({ engine: 'direct' });
    expect(chooseEngine('auto', noCors, offline)).toEqual({ engine: 'direct' });
    expect(chooseEngine('auto', noCors, ready)).toEqual({ engine: 'companion' });
    expect(chooseEngine('auto', mkv, ready)).toEqual({ engine: 'direct' });
    expect(chooseEngine('auto', mkv, withFfmpeg)).toEqual({ engine: 'transcode' });
  });

  it('converts unsupported containers only through FFmpeg', () => {
    expect(chooseEngine('auto', flv, withFfmpeg)).toEqual({ engine: 'transcode' });
    expect(chooseEngine('auto', flv, ready)).toMatchObject({ error: { code: 'TRANSCODE_FAILED' } });
    expect(chooseEngine('auto', flv, offline)).toMatchObject({ error: { code: 'UNSUPPORTED_CONTAINER' } });
    expect(chooseEngine('direct', flv, withFfmpeg)).toMatchObject({ error: { code: 'UNSUPPORTED_CONTAINER' } });
  });

  it('honours forced modes', () => {
    expect(chooseEngine('direct', noCors, withFfmpeg)).toEqual({ engine: 'direct' });
    expect(chooseEngine('companion', plain, ready)).toEqual({ engine: 'companion' });
    expect(chooseEngine('companion', plain, offline)).toMatchObject({ error: { code: 'COMPANION_UNAVAILABLE' } });
    expect(chooseEngine('transcode', plain, withFfmpeg)).toEqual({ engine: 'transcode' });
    expect(chooseEngine('transcode', plain, ready)).toMatchObject({ error: { code: 'TRANSCODE_FAILED' } });
  });
});

describe('withCompanion', () => {
  it('upgrades the shown rating only when the companion is ready', () => {
    expect(withCompanion(noCors, ready, 'auto')).toMatchObject({ level: 'likely', engine: 'companion' });
    expect(withCompanion({ ...noCors, level: 'unlikely' }, ready, 'auto').level).toBe('possible');
    const off = withCompanion(noCors, offline, 'auto');
    expect(off.level).toBe('possible');
    expect(off.notes.at(-1)).toMatch(/npm run setup/);
    expect(withCompanion(noCors, ready, 'direct')).toBe(noCors);
  });

  it('lifts container blockers when FFmpeg can convert', () => {
    const lifted = withCompanion(flv, withFfmpeg, 'auto');
    expect(lifted).toMatchObject({ level: 'likely', engine: 'transcode' });
    expect(lifted.blocker).toBeUndefined();
    expect(withCompanion(flv, ready, 'auto').blocker?.code).toBe('UNSUPPORTED_CONTAINER');
  });

  it('never overrides other blockers', () => {
    const drm: CastabilityAssessment = { level: 'unsupported', engine: null, notes: [], blocker: { code: 'DRM', message: 'x' }, companionHelps: 'x', transcodeHelps: 'x' };
    expect(withCompanion(drm, withFfmpeg, 'transcode')).toBe(drm);
  });
});

describe('nextEngine', () => {
  const failed = { code: 'RECEIVER_LOAD_FAILED' as const, message: 'x' };
  it('steps down the ladder in automatic mode', () => {
    expect(nextEngine('auto', ['direct'], failed, withFfmpeg)).toEqual({ engine: 'transcode', force: false });
    expect(nextEngine('auto', ['direct'], failed, ready)).toEqual({ engine: 'companion', force: false });
    expect(nextEngine('auto', ['direct', 'companion'], failed, withFfmpeg)).toEqual({ engine: 'transcode', force: true });
    expect(nextEngine('auto', ['direct', 'companion'], failed, ready)).toBeNull();
    expect(nextEngine('auto', ['direct', 'transcode'], failed, withFfmpeg)).toBeNull();
  });

  it('does not retry in forced modes, without a companion, or for unrelated errors', () => {
    expect(nextEngine('direct', ['direct'], failed, withFfmpeg)).toBeNull();
    expect(nextEngine('auto', ['direct'], failed, offline)).toBeNull();
    expect(nextEngine('auto', ['direct'], { code: 'NO_DEVICE', message: 'x' }, withFfmpeg)).toBeNull();
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
