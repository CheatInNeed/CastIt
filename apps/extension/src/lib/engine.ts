// Pure engine selection and the fallback ladder, cheapest first:
//   direct     the Chromecast fetches the stream itself
//   companion  the local companion relays the bytes unchanged (fixes CORS / Referer checks)
//   transcode  the companion analyses the stream with FFmpeg and remuxes/re-encodes only what the
//              receiver can't play (an analysis that finds nothing to fix falls back to a relay)
// Phase 6 grows this into the full decision engine.
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

export interface CompanionAvailability {
  /** The companion is running. */
  ready: boolean;
  /** FFmpeg available in the companion. */
  ffmpeg: boolean;
}

/** Receiver errors about *getting* the media: relaying (then converting) can plausibly fix them. */
const ACCESS_CODES: CastErrorCode[] = ['RECEIVER_LOAD_FAILED', 'PLAYBACK_TIMEOUT', 'SEGMENT_FAILURE', 'MANIFEST_INACCESSIBLE'];
/** Receiver errors about *decoding* the media: only FFmpeg conversion helps. */
const CODEC_CODES: CastErrorCode[] = ['UNSUPPORTED_CODEC', 'UNSUPPORTED_CONTAINER'];

const canTranscode = (c: CompanionAvailability) => c.ready && c.ffmpeg;

/** How the popup should present a candidate once the companion's abilities are known. */
export function withCompanion(a: CastabilityAssessment, comp: CompanionAvailability, mode: EngineMode): CastabilityAssessment {
  if (mode === 'direct') return a;

  // Containers/codecs the receiver can't play: FFmpeg can lift a container blocker.
  if (a.blocker) {
    if (a.blocker.code !== 'UNSUPPORTED_CONTAINER' || !a.transcodeHelps) return a;
    if (!canTranscode(comp)) {
      return { ...a, notes: [...a.notes, 'Install FFmpeg (brew install ffmpeg) to convert this stream.'] };
    }
    return {
      level: 'likely',
      engine: 'transcode',
      notes: [...a.notes.filter((n) => n !== a.blocker!.message), `Will convert with FFmpeg on your computer (${a.transcodeHelps}).`],
      companionHelps: a.companionHelps,
      transcodeHelps: a.transcodeHelps,
    };
  }

  if (mode === 'transcode' && canTranscode(comp)) {
    return { ...a, engine: 'transcode', notes: [...a.notes, 'Will convert with FFmpeg on your computer.'] };
  }
  if (mode === 'companion' && comp.ready) {
    return { ...a, engine: 'companion', notes: [...a.notes, 'Will relay through this computer.'] };
  }
  if (a.transcodeHelps && canTranscode(comp)) {
    return {
      ...a,
      level: a.level === 'unlikely' ? 'possible' : 'likely',
      engine: 'transcode',
      notes: [...a.notes, `Will check the stream and convert it if needed (${a.transcodeHelps}).`],
    };
  }
  if (a.companionHelps && comp.ready) {
    return {
      ...a,
      level: a.level === 'unlikely' ? 'possible' : 'likely',
      engine: 'companion',
      notes: [...a.notes, `Will relay through this computer (${a.companionHelps}).`],
    };
  }
  if ((a.companionHelps || a.transcodeHelps) && !comp.ready) {
    return { ...a, notes: [...a.notes, 'Castit’s helper could fix this stream; run `npm run setup`.'] };
  }
  return a;
}

export type EngineChoice = { engine: CastEngine } | { error: CastError };

const companionMissing: CastError = {
  code: 'COMPANION_UNAVAILABLE',
  message: 'Castit’s helper is not running. Run `npm run setup` in the Castit folder.',
};
const ffmpegMissing: CastError = {
  code: 'TRANSCODE_FAILED',
  message: 'FFmpeg is not installed, so Castit cannot convert streams. Install it with `brew install ffmpeg`.',
};

/** First engine to try. Blockers other than an FFmpeg-fixable container are handled by the caller. */
export function chooseEngine(mode: EngineMode, a: CastabilityAssessment, comp: CompanionAvailability): EngineChoice {
  const containerBlocked = a.blocker?.code === 'UNSUPPORTED_CONTAINER';
  if (mode === 'direct') return containerBlocked ? { error: a.blocker! } : { engine: 'direct' };
  if (mode === 'transcode') {
    if (!comp.ready) return { error: companionMissing };
    return comp.ffmpeg ? { engine: 'transcode' } : { error: ffmpegMissing };
  }
  if (containerBlocked) {
    if (!comp.ready) return { error: { ...a.blocker!, message: `${a.blocker!.message} ${companionMissing.message}` } };
    return comp.ffmpeg ? { engine: 'transcode' } : { error: ffmpegMissing };
  }
  if (mode === 'companion') {
    if (!comp.ready) return { error: companionMissing };
    return { engine: a.transcodeHelps && comp.ffmpeg ? 'transcode' : 'companion' };
  }
  // auto
  if (canTranscode(comp) && a.transcodeHelps) return { engine: 'transcode' };
  if (comp.ready && a.companionHelps) return { engine: 'companion' };
  return { engine: 'direct' };
}

/**
 * Next engine after a receiver-side failure in automatic mode, or null to give up.
 * Codec errors go straight to a forced FFmpeg conversion. Access errors go to the companion:
 * with FFmpeg it analyses first (telling codec problems apart from access problems); after a plain
 * relay fails, conversion is forced.
 */
export function nextEngine(
  mode: EngineMode,
  tried: CastEngine[],
  error: CastError,
  comp: CompanionAvailability,
): { engine: 'companion' | 'transcode'; force: boolean } | null {
  if (mode !== 'auto' || !comp.ready) return null;
  if (CODEC_CODES.includes(error.code)) {
    return comp.ffmpeg && !tried.includes('transcode') ? { engine: 'transcode', force: true } : null;
  }
  if (!ACCESS_CODES.includes(error.code)) return null;
  if (!tried.includes('companion') && !tried.includes('transcode')) {
    return comp.ffmpeg ? { engine: 'transcode', force: false } : { engine: 'companion', force: false };
  }
  if (tried.includes('companion') && !tried.includes('transcode') && comp.ffmpeg) return { engine: 'transcode', force: true };
  return null;
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
