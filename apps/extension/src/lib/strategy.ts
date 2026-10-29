// Pure casting strategy: which stream and which engine to try next, and how to explain the result.
//
// One "cast" is a sequence of attempts. Each attempt pairs a stream (candidate) with an engine,
// cheapest first: direct → companion relay → FFmpeg conversion. When every engine has failed for a
// stream, other streams of the *same page player* are tried (sites often offer HLS and DASH for one
// video); a different video or an advertisement is never substituted. The receiver's specific
// failure picks the next engine: access problems → relay, codec problems → conversion.
import type { CastabilityAssessment, CastEngine, CastError, CastErrorCode, EngineMode, RankedCandidate } from '@castit/shared';
import { chooseEngine, nextEngine, type CompanionAvailability } from './engine.ts';

export interface AttemptRecord {
  candidateId: string;
  label: string;
  engine: CastEngine;
  /** What the companion actually did (an FFmpeg analysis may decide a plain relay suffices). */
  delivery?: 'relay' | 'remux' | 'transcode';
  outcome: 'running' | 'playing' | 'failed';
  error?: CastError;
  startedAt: number;
  endedAt?: number;
}

export interface StrategyState {
  mode: EngineMode;
  /** Streams to try, best first: the user's choice, then alternatives for the same player. */
  candidates: Array<{ id: string; label: string }>;
  attempts: AttemptRecord[];
  state: 'running' | 'playing' | 'failed' | 'cancelled';
  /** Why the whole cast failed, when it did. */
  final?: CastError;
}

export type Step =
  | { kind: 'attempt'; candidateId: string; engine: CastEngine; force: boolean }
  | { kind: 'give-up'; error: CastError };

/** Errors that no other engine or stream can fix: stop immediately. */
const FATAL: CastErrorCode[] = ['NO_DEVICE', 'SESSION_CANCELLED', 'CONTROLLER_UNAVAILABLE', 'INTERNAL'];
/**
 * Errors no engine can fix for this stream (DRM, login required, expired URL): skip straight to
 * another stream of the same player. A receiver that merely couldn't *download* the manifest is
 * different: the companion relay exists for exactly that.
 */
const STREAM_SPECIFIC: CastErrorCode[] = ['DRM', 'AUTH_REQUIRED', 'STREAM_UNAVAILABLE'];

/** How specific (useful to the user) an error is, for picking the overall explanation. */
const SPECIFICITY: CastErrorCode[] = [
  'DRM',
  'AUTH_REQUIRED',
  'UNSUPPORTED_CODEC',
  'UNSUPPORTED_CONTAINER',
  'STREAM_UNAVAILABLE',
  'MANIFEST_INACCESSIBLE',
  'SEGMENT_FAILURE',
  'TRANSCODE_FAILED',
  'COMPANION_UNAVAILABLE',
  'RECEIVER_LOAD_FAILED',
  'PLAYBACK_TIMEOUT',
];

export const MAX_ALTERNATIVES = 2;

/**
 * Other streams that play the same page video as `chosen` (same player element and frame),
 * never ads, at most MAX_ALTERNATIVES, best-ranked first.
 */
export function alternativesFor(chosen: RankedCandidate, ranked: RankedCandidate[]): RankedCandidate[] {
  if (!chosen.video) return [];
  const frame = chosen.videoFrameId ?? chosen.frameId;
  return ranked
    .filter(
      (c) =>
        c.id !== chosen.id &&
        !c.isAd &&
        c.video?.key === chosen.video!.key &&
        (c.videoFrameId ?? c.frameId) === frame,
    )
    .slice(0, MAX_ALTERNATIVES);
}

export function newStrategy(mode: EngineMode, candidates: Array<{ id: string; label: string }>): StrategyState {
  return { mode, candidates, attempts: [], state: 'running' };
}

function attemptsFor(s: StrategyState, candidateId: string): AttemptRecord[] {
  return s.attempts.filter((a) => a.candidateId === candidateId);
}

/** First attempt for a stream, or null when this stream can't be cast with what is available. */
function firstFor(
  s: StrategyState,
  candidateId: string,
  assessment: CastabilityAssessment,
  comp: CompanionAvailability,
): Step | null {
  if (assessment.blocker && assessment.blocker.code !== 'UNSUPPORTED_CONTAINER') return null;
  const choice = chooseEngine(s.mode, assessment, comp);
  if ('error' in choice) return null;
  const force = s.mode === 'transcode' || assessment.blocker?.code === 'UNSUPPORTED_CONTAINER';
  return { kind: 'attempt', candidateId, engine: choice.engine, force: choice.engine === 'transcode' && force };
}

/** The first step of a cast (the user's chosen stream), or a clear reason it can't start. */
export function firstStep(
  s: StrategyState,
  assess: (candidateId: string) => CastabilityAssessment,
  comp: CompanionAvailability,
): Step {
  const [chosen] = s.candidates;
  if (!chosen) return { kind: 'give-up', error: { code: 'NO_VIDEO', message: 'No video detected.' } };
  const assessment = assess(chosen.id);
  if (assessment.blocker && assessment.blocker.code !== 'UNSUPPORTED_CONTAINER') {
    // A blocked chosen stream (DRM, expired…) may still have a castable sibling.
    return nextCandidate(s, 0, assess, comp) ?? { kind: 'give-up', error: assessment.blocker };
  }
  const choice = chooseEngine(s.mode, assessment, comp);
  if ('error' in choice) return { kind: 'give-up', error: choice.error };
  return firstFor(s, chosen.id, assessment, comp)!;
}

function nextCandidate(
  s: StrategyState,
  afterIndex: number,
  assess: (candidateId: string) => CastabilityAssessment,
  comp: CompanionAvailability,
): Step | null {
  for (const c of s.candidates.slice(afterIndex + 1)) {
    if (attemptsFor(s, c.id).length) continue;
    const step = firstFor(s, c.id, assess(c.id), comp);
    if (step) return step;
  }
  return null;
}

/** Decides what to do after the current attempt failed with `error`. */
export function nextStep(
  s: StrategyState,
  error: CastError,
  assess: (candidateId: string) => CastabilityAssessment,
  comp: CompanionAvailability,
): Step {
  const giveUp = (): Step => ({ kind: 'give-up', error: overallError(s, error) });
  if (s.state === 'cancelled' || FATAL.includes(error.code)) return giveUp();

  const current = s.attempts.at(-1);
  const index = Math.max(0, s.candidates.findIndex((c) => c.id === current?.candidateId));
  const candidateId = s.candidates[index]?.id;

  if (candidateId && !STREAM_SPECIFIC.includes(error.code)) {
    const tried = attemptsFor(s, candidateId).map((a) => (a.engine === 'transcode' && a.delivery === 'relay' ? 'companion' : a.engine));
    const next = nextEngine(s.mode, tried, error, comp);
    if (next) return { kind: 'attempt', candidateId, engine: next.engine, force: next.force };
  }
  return nextCandidate(s, index, assess, comp) ?? giveUp();
}

/** The most useful explanation across all attempts, prefixed with how much was tried. */
export function overallError(s: StrategyState, last: CastError): CastError {
  const errors = [...s.attempts.map((a) => a.error).filter((e): e is CastError => !!e), last];
  const rank = (e: CastError) => {
    const i = SPECIFICITY.indexOf(e.code);
    return i === -1 ? SPECIFICITY.length : i;
  };
  const best = [...errors].sort((a, b) => rank(a) - rank(b))[0] ?? last;
  const tries = Math.max(s.attempts.length, 1);
  if (tries === 1) return best;
  return { ...best, message: `Castit tried ${tries} ways; none played. Most likely cause: ${best.message}` };
}

export const ENGINE_LABEL: Record<CastEngine, string> = {
  direct: 'Direct to the Chromecast',
  companion: 'Through the local companion',
  transcode: 'Converted by FFmpeg',
};

const DELIVERY_LABEL: Record<NonNullable<AttemptRecord['delivery']>, string> = {
  relay: 'Through the local companion (FFmpeg found nothing to convert)',
  remux: 'Repackaged by FFmpeg (no re-encoding)',
  transcode: 'Converted by FFmpeg',
};

export function attemptLabel(a: AttemptRecord): string {
  return a.engine === 'transcode' && a.delivery ? DELIVERY_LABEL[a.delivery] : ENGINE_LABEL[a.engine];
}

/** One line per attempt, for the popup and the diagnostics report. */
export function describeAttempts(s: StrategyState): string[] {
  const multipleStreams = new Set(s.attempts.map((a) => a.candidateId)).size > 1;
  return s.attempts.map((a, i) => {
    const what = `${i + 1}. ${attemptLabel(a)}${multipleStreams ? ` (${a.label})` : ''}`;
    if (a.outcome === 'playing') return `${what}: playing ✓`;
    if (a.outcome === 'running') return `${what}: trying…`;
    return `${what}: ${a.error?.message ?? 'failed'}`;
  });
}
