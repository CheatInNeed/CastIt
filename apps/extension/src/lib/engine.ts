// Pure engine selection (Direct vs Local Companion) and Direct → Companion fallback rules.
// Phase 6 grows this into the full decision engine; Phase 3 covers the two delivery engines.
import type {
  CastabilityAssessment,
  CastEngine,
  CastError,
  CastErrorCode,
  EngineMode,
  RankedCandidate,
  UpstreamContext,
} from '@castit/shared';
import { safeUrl } from './media-types.ts';

/** Receiver errors that relaying through the companion can plausibly fix. */
const FALLBACK_CODES: CastErrorCode[] = ['RECEIVER_LOAD_FAILED', 'PLAYBACK_TIMEOUT', 'SEGMENT_FAILURE'];

/** How the popup should present a candidate once the companion's availability is known. */
export function withCompanion(a: CastabilityAssessment, companionReady: boolean, mode: EngineMode): CastabilityAssessment {
  if (a.blocker || mode === 'direct') return a;
  if (mode === 'companion' && companionReady) {
    return { ...a, engine: 'companion', notes: [...a.notes, 'Will relay through the local companion.'] };
  }
  if (!a.companionHelps) return a;
  if (!companionReady) {
    return { ...a, notes: [...a.notes, 'The local companion could relay this stream; it is not running or not paired.'] };
  }
  return {
    ...a,
    level: a.level === 'unlikely' ? 'possible' : 'likely',
    engine: 'companion',
    notes: [...a.notes, `Will relay through the local companion (${a.companionHelps}).`],
  };
}

export type EngineChoice = { engine: CastEngine } | { error: CastError };

export function chooseEngine(mode: EngineMode, a: CastabilityAssessment, companionReady: boolean): EngineChoice {
  if (mode === 'direct') return { engine: 'direct' };
  if (mode === 'companion') {
    return companionReady
      ? { engine: 'companion' }
      : { error: { code: 'COMPANION_UNAVAILABLE', message: 'The local companion is not running or not paired. Start it with `npm run companion` and pair it in the popup.' } };
  }
  return { engine: companionReady && a.companionHelps ? 'companion' : 'direct' };
}

export function shouldFallBack(
  mode: EngineMode,
  tried: CastEngine[],
  error: CastError,
  companionReady: boolean,
): boolean {
  return mode === 'auto' && companionReady && !tried.includes('companion') && FALLBACK_CODES.includes(error.code);
}

/**
 * Upstream request settings for the companion, derived from where the page itself requested the
 * stream, mimicking a browser's default referrer policy (strict-origin-when-cross-origin):
 * the full frame URL for same-origin streams, only the frame's origin for cross-origin ones.
 * Origin is sent for HLS/DASH (players fetch those with CORS requests), not for plain files.
 */
export function upstreamContextFor(
  c: Pick<RankedCandidate, 'url' | 'kind'>,
  frameUrl: string | undefined,
  initiator: string | undefined,
  userAgent: string,
): UpstreamContext {
  const frame = frameUrl ? safeUrl(frameUrl) : null;
  const stream = safeUrl(c.url);
  const context: UpstreamContext = { userAgent };
  if (frame && /^https?:$/.test(frame.protocol)) {
    context.referer = stream && stream.origin === frame.origin ? frame.href : `${frame.origin}/`;
  }
  const origin = initiator && /^https?:\/\//.test(initiator) ? initiator : frame?.origin;
  if ((c.kind === 'hls' || c.kind === 'dash') && origin && origin !== 'null') context.origin = origin;
  return context;
}
