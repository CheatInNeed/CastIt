import { describe, expect, it } from 'vitest';
import type { CastabilityAssessment, CastError } from '@castit/shared';
import {
  alternativesFor,
  describeAttempts,
  firstStep,
  newStrategy,
  nextStep,
  type AttemptRecord,
  type StrategyState,
} from '../../apps/extension/src/lib/strategy.ts';
import { withReceiverDetail } from '../../apps/controller/src/errors.ts';
import { candidate, video } from './helpers.ts';

const ok: CastabilityAssessment = { level: 'likely', engine: 'direct', notes: [] };
const drm: CastabilityAssessment = { level: 'unsupported', engine: null, notes: [], blocker: { code: 'DRM', message: 'DRM-protected.' } };
const withFfmpeg = { ready: true, ffmpeg: true };
const relayOnly = { ready: true, ffmpeg: false };
const noCompanion = { ready: false, ffmpeg: false };

const loadFailed: CastError = { code: 'RECEIVER_LOAD_FAILED', message: 'The Chromecast could not load this stream.' };
const manifestBlocked: CastError = { code: 'MANIFEST_INACCESSIBLE', message: 'The Chromecast could not download the playlist.' };
const codec: CastError = { code: 'UNSUPPORTED_CODEC', message: 'The Chromecast could not decode this video.' };

const streams = [
  { id: 'hls', label: 'master.m3u8' },
  { id: 'dash', label: 'manifest.mpd' },
];

/** Plays a step: records it as a failed attempt with `error`. */
function fail(s: StrategyState, step: ReturnType<typeof firstStep>, error: CastError, delivery?: AttemptRecord['delivery']) {
  if (step.kind !== 'attempt') throw new Error(`expected an attempt, got ${JSON.stringify(step)}`);
  s.attempts.push({ candidateId: step.candidateId, label: step.candidateId, engine: step.engine, delivery, outcome: 'failed', error, startedAt: 0 });
}

describe('strategy: engine ladder', () => {
  it('starts direct, then lets FFmpeg analyse, then tries the other stream of the same player', () => {
    const s = newStrategy('auto', streams);
    const assess = () => ok;
    const first = firstStep(s, assess, withFfmpeg);
    expect(first).toEqual({ kind: 'attempt', candidateId: 'hls', engine: 'direct', force: false });

    fail(s, first, manifestBlocked);
    const second = nextStep(s, manifestBlocked, assess, withFfmpeg);
    expect(second).toEqual({ kind: 'attempt', candidateId: 'hls', engine: 'transcode', force: false });

    fail(s, second, loadFailed, 'remux');
    const third = nextStep(s, loadFailed, assess, withFfmpeg);
    expect(third).toEqual({ kind: 'attempt', candidateId: 'dash', engine: 'direct', force: false });
  });

  it('forces conversion after an analysis that only relayed', () => {
    const s = newStrategy('auto', streams);
    const step = firstStep(s, () => ok, withFfmpeg);
    fail(s, step, loadFailed);
    const analysis = nextStep(s, loadFailed, () => ok, withFfmpeg);
    fail(s, analysis, loadFailed, 'relay');
    expect(nextStep(s, loadFailed, () => ok, withFfmpeg)).toEqual({ kind: 'attempt', candidateId: 'hls', engine: 'transcode', force: true });
  });

  it('sends codec errors straight to a forced conversion', () => {
    const s = newStrategy('auto', streams);
    const step = firstStep(s, () => ok, withFfmpeg);
    fail(s, step, codec);
    expect(nextStep(s, codec, () => ok, withFfmpeg)).toEqual({ kind: 'attempt', candidateId: 'hls', engine: 'transcode', force: true });
  });

  it('relays without FFmpeg, and tries the next stream when nothing else is left', () => {
    const s = newStrategy('auto', streams);
    const step = firstStep(s, () => ok, relayOnly);
    fail(s, step, loadFailed);
    const relay = nextStep(s, loadFailed, () => ok, relayOnly);
    expect(relay).toEqual({ kind: 'attempt', candidateId: 'hls', engine: 'companion', force: false });
    fail(s, relay, codec);
    expect(nextStep(s, codec, () => ok, relayOnly)).toMatchObject({ candidateId: 'dash' });
  });
});

describe('strategy: streams and giving up', () => {
  it('skips a DRM-protected chosen stream in favour of a playable sibling', () => {
    const s = newStrategy('auto', streams);
    expect(firstStep(s, (id) => (id === 'hls' ? drm : ok), noCompanion)).toEqual({ kind: 'attempt', candidateId: 'dash', engine: 'direct', force: false });
  });

  it('stops at once for problems no stream or engine can fix', () => {
    const s = newStrategy('auto', streams);
    const step = firstStep(s, () => ok, withFfmpeg);
    const noDevice: CastError = { code: 'NO_DEVICE', message: 'No Cast device.' };
    fail(s, step, noDevice);
    expect(nextStep(s, noDevice, () => ok, withFfmpeg)).toMatchObject({ kind: 'give-up', error: { code: 'NO_DEVICE' } });
  });

  it('gives up with the most specific cause and how much was tried', () => {
    const s = newStrategy('direct', [streams[0]!]);
    const step = firstStep(s, () => ok, noCompanion);
    fail(s, step, manifestBlocked);
    const end = nextStep(s, { code: 'PLAYBACK_TIMEOUT', message: 'Timed out.' }, () => ok, noCompanion);
    expect(end.kind).toBe('give-up');
    if (end.kind === 'give-up') {
      expect(end.error.code).toBe('MANIFEST_INACCESSIBLE');
      expect(end.error.message).toMatch(/^Castit tried 1 ways?|could not download the playlist/);
    }
  });

  it('explains when the very first stream is blocked and has no siblings', () => {
    const s = newStrategy('auto', [streams[0]!]);
    expect(firstStep(s, () => drm, withFfmpeg)).toEqual({ kind: 'give-up', error: drm.blocker });
  });

  it('describes attempts in plain words', () => {
    const s = newStrategy('auto', streams);
    s.attempts.push(
      { candidateId: 'hls', label: 'master.m3u8', engine: 'direct', outcome: 'failed', error: manifestBlocked, startedAt: 0 },
      { candidateId: 'hls', label: 'master.m3u8', engine: 'transcode', delivery: 'relay', outcome: 'playing', startedAt: 0 },
    );
    expect(describeAttempts(s)).toEqual([
      '1. Direct to the Chromecast: The Chromecast could not download the playlist.',
      '2. Through the local companion (FFmpeg found nothing to convert): playing ✓',
    ]);
  });
});

describe('alternativesFor', () => {
  it('offers only other streams of the same player, never ads', () => {
    const player = video({ key: 'v1' });
    const chosen = candidate({ id: 'a', video: player, videoFrameId: 3 });
    const ranked = [
      chosen,
      candidate({ id: 'b', video: player, videoFrameId: 3 }),
      candidate({ id: 'c', video: player, videoFrameId: 3, isAd: true }),
      candidate({ id: 'd', video: video({ key: 'v2' }), videoFrameId: 3 }),
      candidate({ id: 'e', video: player, videoFrameId: 0 }),
      candidate({ id: 'f', video: player, videoFrameId: 3 }),
      candidate({ id: 'g', video: player, videoFrameId: 3 }),
    ];
    expect(alternativesFor(chosen, ranked).map((c) => c.id)).toEqual(['b', 'f']);
    expect(alternativesFor(candidate({ id: 'x' }), ranked)).toEqual([]);
  });
});

describe('receiver error codes', () => {
  const base: CastError = { code: 'RECEIVER_LOAD_FAILED', message: 'Could not load.' };
  it('turns Chromecast detailed error codes into specific causes', () => {
    expect(withReceiverDetail(base, { detailedErrorCode: 311, at: 0 }).code).toBe('MANIFEST_INACCESSIBLE');
    expect(withReceiverDetail(base, { detailedErrorCode: 301, at: 0 }).code).toBe('SEGMENT_FAILURE');
    expect(withReceiverDetail(base, { detailedErrorCode: 102, at: 0 }).code).toBe('UNSUPPORTED_CODEC');
    expect(withReceiverDetail(base, { detailedErrorCode: 104, at: 0 }).code).toBe('UNSUPPORTED_CONTAINER');
    expect(withReceiverDetail(base, { detailedErrorCode: 201, at: 0 }).code).toBe('DRM');
    const unknown = withReceiverDetail(base, { detailedErrorCode: 999, reason: 'GENERIC', at: 0 });
    expect(unknown).toMatchObject({ code: 'RECEIVER_LOAD_FAILED', detail: 'Chromecast error 999 (GENERIC).' });
    expect(withReceiverDetail(base, undefined)).toBe(base);
  });
});
