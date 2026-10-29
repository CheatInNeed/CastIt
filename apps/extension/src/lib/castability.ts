// Pure castability assessment. Evidence comes from, in order of freshness:
//   1. a probe fetched right before casting,
//   2. a manifest inspected earlier (when the popup opened),
//   3. what the page itself experienced (failed requests, player load errors, EME use).
// It never declares success: only the receiver actually playing proves that.
import type { Castability, CastabilityAssessment, CastError, ManifestSummary, RankedCandidate } from '@castit/shared';
import { summarizeManifest, type ProbeResult } from './probe.ts';

const ORDER: Castability[] = ['likely', 'possible', 'unlikely', 'unsupported'];

const MEDIA_ERRORS: Record<number, string> = {
  1: 'aborted',
  2: 'network error',
  3: 'decode error',
  4: 'source not supported or unreachable',
};

interface Evidence {
  reachable: boolean;
  status?: number;
  cors: boolean | null;
  manifest?: ManifestSummary;
  /** Where the evidence came from, for wording. */
  source: 'probe' | 'inspection' | 'page';
}

function evidenceFor(c: RankedCandidate, probe?: ProbeResult): Evidence | undefined {
  if (probe) {
    const manifest = c.kind === 'hls' || c.kind === 'dash' ? summarizeManifest(c.kind, probe, 0) : undefined;
    return {
      reachable: probe.reachable,
      status: probe.status,
      cors: probe.reachable ? probe.cors !== null && probe.cors !== undefined : null,
      manifest,
      source: 'probe',
    };
  }
  if (c.manifest) {
    return { reachable: c.manifest.reachable, status: c.manifest.status, cors: c.manifest.cors, manifest: c.manifest, source: 'inspection' };
  }
  if (c.lastStatus !== undefined) return { reachable: true, status: c.lastStatus, cors: null, source: 'page' };
  return undefined;
}

export function assessCastability(c: RankedCandidate, probe?: ProbeResult): CastabilityAssessment {
  let level: Castability = 'likely';
  let companionHelps: string | undefined;
  const notes: string[] = [];
  const lower = (to: Castability, note?: string) => {
    if (ORDER.indexOf(to) > ORDER.indexOf(level)) level = to;
    if (note) notes.push(note);
  };
  const blocked = (error: CastError): CastabilityAssessment => ({
    level: 'unsupported',
    engine: null,
    notes: [...notes, error.message],
    blocker: error,
  });

  if (c.isAd) notes.push('This looks like an advertisement.');
  if (c.audioOnly) notes.push('Audio only.');

  switch (c.container) {
    case 'flv':
    case 'avi':
      return blocked({
        code: 'UNSUPPORTED_CONTAINER',
        message: `Chromecast cannot play ${c.container.toUpperCase()} files. Transcoding (local companion) is not available yet.`,
      });
    case 'mkv':
    case 'ogg':
    case 'mov':
      lower('possible', `Chromecast support for ${c.container.toUpperCase()} depends on the codecs inside.`);
      break;
  }
  if (c.kind === 'unknown') lower('possible', 'Unrecognised media type.');

  // What the page itself experienced.
  const video = c.video;
  if (video && !video.isBlob && video.error !== null && (video.src === c.url || video.sources.includes(c.url))) {
    lower(
      'unlikely',
      `The page's own player could not load this URL (${MEDIA_ERRORS[video.error] ?? `error ${video.error}`}).`,
    );
  }
  if (c.drmHint.length) {
    lower('unlikely', `The page's player uses DRM (${c.drmHint.join(', ')}); protected streams cannot be cast by Castit.`);
  }

  const ev = evidenceFor(c, probe);
  if (ev) {
    const by = ev.source === 'page' ? "The page's own request" : 'The stream server';
    if (!ev.reachable) {
      lower('possible', 'Castit could not fetch the stream itself; the Chromecast may still reach it.');
    } else if (ev.status !== undefined && ev.status >= 400) {
      const status = ev.status;
      if ((status === 404 || status === 410) && ev.source !== 'page') {
        return blocked({
          code: 'STREAM_UNAVAILABLE',
          message: `The stream URL returned HTTP ${status}; it has probably expired. Reload the page and play the video again.`,
        });
      }
      if (status === 401 || status === 403) {
        companionHelps = "the server may check the page's Referer/Origin";
        lower(
          'unlikely',
          ev.source === 'page'
            ? `${by} for this URL was refused (HTTP ${status}).`
            : `The server refused a request without your cookies/referrer (HTTP ${status}). The Chromecast will probably be refused too (authentication required).`,
        );
      } else {
        lower('unlikely', `${by} answered HTTP ${status}.`);
      }
    }

    const m = ev.manifest;
    const ok = ev.reachable && (ev.status ?? 200) < 400;
    if (m && ok && !m.valid) {
      lower('unlikely', `The response is not a valid ${m.kind.toUpperCase()} manifest (manifest inaccessible).`);
    }
    if (m?.encryption === 'drm') {
      return blocked({
        code: 'DRM',
        message: `This stream is DRM-protected${m.drmSystems.length ? ` (${m.drmSystems.join(', ')})` : ''}. The Default Media Receiver has no license for it, and Castit does not bypass DRM.`,
      });
    }
    if (m?.encryption === 'sample-aes') {
      lower('unlikely', 'SAMPLE-AES encrypted HLS is not supported by the Default Media Receiver.');
    }
    if ((c.kind === 'hls' || c.kind === 'dash') && ok && ev.cors === false) {
      companionHelps ??= 'the stream host sends no CORS headers';
      lower('possible', 'The stream host sent no CORS header. Chromecast players need CORS for HLS/DASH, so playback may fail.');
    }
  }

  const codecs = c.codecs.concat(ev?.manifest?.codecs ?? []).join(',');
  if (/\b(hvc1|hev1)/i.test(codecs)) lower('possible', 'HEVC video needs a Chromecast with Google TV / Ultra.');
  if (/\bav01/i.test(codecs)) lower('possible', 'AV1 video needs a recent Chromecast / Google TV device.');
  if (/\bvp09|\bvp9\b/i.test(codecs) && c.kind !== 'progressive') notes.push('VP9 plays on most, but not the oldest, Chromecasts.');
  if (/\b(ac-3|ec-3)\b/i.test(codecs)) notes.push('Dolby audio plays only when the TV/receiver supports it.');

  return { level, engine: 'direct', notes, companionHelps };
}
