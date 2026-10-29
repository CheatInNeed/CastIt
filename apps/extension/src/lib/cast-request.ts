// Builds the CastRequest the controller turns into a chrome.cast.media.LoadRequest.
import type { CastRequest, RankedCandidate } from '@castit/shared';
import { castHlsFormats } from './manifests.ts';
import { castContentType, labelForUrl, safeUrl } from './media-types.ts';
import type { ProbeResult } from './probe.ts';

export interface PageInfo {
  title?: string;
  url?: string;
}

/** Resume on the TV where the local player was, unless near the start or the end. */
export function resumePosition(currentTime: number, duration: number | null): number | undefined {
  if (currentTime < 5) return undefined;
  if (duration !== null && duration - currentTime < 10) return undefined;
  return Math.floor(currentTime);
}

export function buildCastRequest(
  c: RankedCandidate,
  probe: ProbeResult | undefined,
  page: PageInfo,
  requestId: string,
  sourceTabId: number,
): CastRequest {
  const hlsMedia = probe?.hlsMedia;
  const live = hlsMedia?.live ?? probe?.dash?.live ?? c.live;
  const duration = live
    ? undefined
    : (c.video?.duration ?? hlsMedia?.totalDuration ?? probe?.dash?.duration ?? undefined);

  const request: CastRequest = {
    requestId,
    sourceTabId,
    candidateId: c.id,
    url: c.url,
    contentType: castContentType(c.kind, c.container, c.audioOnly),
    streamType: live ? 'LIVE' : 'BUFFERED',
    title: page.title?.trim() || c.label,
    subtitle: safeUrl(page.url ?? '')?.hostname ?? safeUrl(c.url)?.hostname,
    posterUrl: c.video?.poster && /^https?:/i.test(c.video.poster) ? c.video.poster : undefined,
    startTime: !live && c.video ? resumePosition(c.video.currentTime, c.video.duration) : undefined,
    duration: duration ?? undefined,
    engine: 'direct',
  };
  if (c.kind === 'hls') Object.assign(request, castHlsFormats(hlsMedia));
  if (!request.title) request.title = labelForUrl(c.url);
  return request;
}
