// Replays a recorded real-site capture (tests/fixtures/compat/*.json) through Castit's own
// detection, manifest inspection, ranking and castability code, and reports what the popup
// would list and pre-select. Used by compat.test.ts and the `npm run compat` report.
import type { ManifestSummary, VideoElementInfo } from '@castit/shared';
import { assessCastability } from '../../apps/extension/src/lib/castability.ts';
import { classifyMedia } from '../../apps/extension/src/lib/media-types.ts';
import { isPrimaryCandidate, mediaSourceDetected, rankCandidates, selectMainCandidate } from '../../apps/extension/src/lib/rank.ts';
import { emptyTabState, networkCandidateId, recordFrameReport, recordManifest, recordNetworkMedia } from '../../apps/extension/src/lib/store.ts';

export interface CompatFixture {
  name: string;
  category: string;
  /** What the site is and why it is in the suite. */
  about: string;
  pageUrl: string;
  capturedAt: string;
  requests: Array<{ url: string; type: string; at: number }>;
  videos: VideoElementInfo[];
  /** Manifest inspection results (fetched without cookies, like the popup does). */
  manifests: Record<string, ManifestSummary>;
  expect: {
    /** Label of the stream Castit should pre-select, or null when nothing castable should be offered. */
    main: string | null;
    mainKind?: string;
    /** Labels that must appear in the main list. */
    primary?: string[];
    /** Labels that must not appear anywhere (segments, variants, ads…). */
    hidden?: string[];
    /** Castability shown for the main stream (before any companion help). */
    level?: string;
    /** A note on the main stream must match this. */
    note?: string;
    mediaSource?: boolean;
    /** The main stream must be recognised as live (cast with streamType LIVE). */
    live?: boolean;
  };
}

export interface ReplayResult {
  main?: { label: string; kind: string; level: string; notes: string[]; linked: boolean; live: boolean };
  primary: string[];
  others: string[];
  mediaSource: boolean;
}

export function replay(fixture: CompatFixture): ReplayResult {
  const start = Date.parse(fixture.capturedAt) - 60_000;
  const state = emptyTabState(1, fixture.pageUrl);
  for (const r of [...fixture.requests].sort((a, b) => a.at - b.at)) {
    const classification = classifyMedia(r.url);
    if (!classification || classification.kind === 'segment') continue;
    recordNetworkMedia(state, { url: r.url, classification, frameId: 0, status: 200 }, start + r.at);
  }
  for (const [url, summary] of Object.entries(fixture.manifests)) recordManifest(state, networkCandidateId(url), summary);
  recordFrameReport(state, 0, { url: fixture.pageUrl, isTop: true, videos: fixture.videos.map((v) => ({ ...v, lastPlayedAt: v.paused ? undefined : start + 60_000 })) }, start + 60_000);

  const ranked = rankCandidates(state, start + 61_000);
  const main = selectMainCandidate(ranked);
  const assessment = main ? assessCastability(main) : undefined;
  return {
    main:
      main && assessment
        ? { label: main.label, kind: main.kind, level: assessment.level, notes: assessment.notes, linked: !!main.video, live: main.live }
        : undefined,
    primary: ranked.filter(isPrimaryCandidate).map((c) => c.label),
    others: ranked.filter((c) => !isPrimaryCandidate(c)).map((c) => c.label),
    mediaSource: mediaSourceDetected(state),
  };
}
