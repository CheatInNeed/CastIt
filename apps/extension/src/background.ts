// Castit background service worker.
//
// MV3 service workers are suspended after ~30 s idle and restarted on the next event, so all
// state that must survive lives in chrome.storage.session; listeners are registered
// synchronously at top level so Chrome can wake the worker for them. The only in-memory state
// is the companion's native messaging port (lib/companion.ts; a restarted companion re-attaches
// to the running cast) and short-lived throttling caches.
import {
  type BackgroundToContent,
  type CandidateView,
  type CastDeviceInfo,
  type CastabilityAssessment,
  type CastError,
  type CastRequest,
  type CastEngine,
  type CastProgress,
  type CastStatus,
  type CommandResponse,
  type CompanionEvent,
  type EngineMode,
  type HighlightResult,
  type StreamKind,
  type SyncInfo,
  type SyncStartResponse,
  type TranscodeSettings,
  type UpstreamContext,
  type ContentToBackground,
  type PopupCastResponse,
  type PopupRequest,
  type PopupState,
  type RemoteCommand,
  type TabMediaState,
} from '@castit/shared';
import { assessCastability } from './lib/castability.ts';
import { buildCastRequest } from './lib/cast-request.ts';
import {
  CompanionError,
  companionRequest,
  companionStatus,
  createCompanionSession,
  deleteCompanionSession,
  disconnectCompanion,
  setCompanionHandlers,
} from './lib/companion.ts';
import { upstreamContextFor, withCompanion } from './lib/engine.ts';
import {
  alternativesFor,
  attemptLabel,
  describeAttempts,
  firstStep,
  newStrategy,
  nextStep,
  type AttemptRecord,
  type Step,
  type StrategyState,
} from './lib/strategy.ts';
import { routeStatus, type SyncTarget } from './lib/sync-routing.ts';
import { classifyMedia, normalizeMime, totalSizeFromHeaders } from './lib/media-types.ts';
import { dedupeKey } from './lib/media-types.ts';
import { probeStream, summarizeManifest } from './lib/probe.ts';
import { frameUrl, isPrimaryCandidate, mediaSourceDetected, rankCandidates } from './lib/rank.ts';
import {
  emptyTabState,
  normalizeTabState,
  recordFrameReport,
  recordManifest,
  recordNetworkMedia,
  recordSoftNavigation,
  recordSubframeNavigation,
} from './lib/store.ts';

const KEY = {
  tab: (tabId: number) => `tab:${tabId}`,
  castStatus: 'castStatus',
  pendingCast: 'pendingCast',
  /** The cast playing on the TV ({device, request}), for a restarted companion to re-attach to. */
  activeCast: 'activeCast',
  castContext: 'castContext',
  castNotice: 'castNotice',
  companionSession: 'companionSession',
  engineMode: 'engineMode', // chrome.storage.local
  transcodeSettings: 'transcodeSettings', // chrome.storage.local
  syncTarget: 'syncTarget',
  /** TVs the companion found on the network. */
  devices: 'devices',
  /** The TV the user cast to last. */
  deviceId: 'deviceId', // chrome.storage.local
  /** Per-open secret that lets only Castit's own page panel load the popup UI. */
  panelToken: 'panelToken',
} as const;

const DEFAULT_TRANSCODE: TranscodeSettings = { profile: 'compat', quality: 'auto' };
/** Within this time after an attempt started, a playback failure switches engine automatically. */
const RECOVERY_WINDOW_MS = 3 * 60_000;

/** What one stream needs for (re)building load requests, so retries don't re-probe. */
interface CastInput {
  candidateId: string;
  label: string;
  kind: StreamKind;
  direct: CastRequest;
  upstream: UpstreamContext;
  assessment: CastabilityAssessment;
}

/** One cast from the popup: the strategy's progress plus what is needed to continue it. */
interface CastContext {
  tabId: number;
  device: CastDeviceInfo;
  strategy: StrategyState;
  inputs: Record<string, CastInput>;
  activeRequestId: string;
  activeCandidateId: string;
  /** Position to resume at when switching engine after playback had started. */
  resumeAt?: number;
  startedAt: number;
  /** The page player that should become the remote control once the TV plays. */
  sync: { tabId: number; frameId?: number; videoKey?: string; frameHost?: string };
}

// ---------------------------------------------------------------- tab state persistence

/** Serialises read-modify-write per storage key so concurrent webRequest events don't clobber each other. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function readTab(tabId: number): Promise<TabMediaState> {
  const key = KEY.tab(tabId);
  const stored = (await chrome.storage.session.get(key))[key] as TabMediaState | undefined;
  return stored ? normalizeTabState(stored) : emptyTabState(tabId);
}

/** `mutate` returns false when nothing changed (skips the write). */
function updateTab(tabId: number, mutate: (state: TabMediaState) => boolean | void): Promise<void> {
  return serialized(KEY.tab(tabId), async () => {
    const state = await readTab(tabId);
    if (mutate(state) === false) return;
    await chrome.storage.session.set({ [KEY.tab(tabId)]: state });
    scheduleBadge(tabId, state);
  });
}

function resetTab(tabId: number, pageUrl?: string): Promise<void> {
  return serialized(KEY.tab(tabId), async () => {
    await chrome.storage.session.set({ [KEY.tab(tabId)]: emptyTabState(tabId, pageUrl) });
    scheduleBadge(tabId, emptyTabState(tabId));
  });
}

/** Busy pages produce many state writes per second; the badge is recomputed at most every 400 ms. */
const badgeTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; state?: TabMediaState }>();

function scheduleBadge(tabId: number, state?: TabMediaState): void {
  const pending = badgeTimers.get(tabId);
  if (pending) {
    if (state) pending.state = state;
    return;
  }
  const entry = {
    state,
    timer: setTimeout(() => {
      badgeTimers.delete(tabId);
      void updateBadge(tabId, entry.state);
    }, 400),
  };
  badgeTimers.set(tabId, entry);
}

/** Blue count of videos found; a green ▶ on the tab that is casting. */
async function updateBadge(tabId: number, state?: TabMediaState): Promise<void> {
  const [tabState, session] = await Promise.all([state ?? readTab(tabId), chrome.storage.session.get([KEY.castContext, KEY.castStatus])]);
  const context = session[KEY.castContext] as CastContext | undefined;
  const status = session[KEY.castStatus] as CastStatus | undefined;
  const casting = context?.tabId === tabId && !!status?.sessionActive && status.requestId === context.activeRequestId;
  // Count real videos, not every stream file the page fetched.
  const ranked = rankCandidates(tabState);
  const count = ranked.filter(isPrimaryCandidate).length || ranked.length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: casting ? '#16a34a' : '#2563eb' });
    await chrome.action.setBadgeText({ tabId, text: casting ? '▶' : count > 0 ? String(Math.min(count, 99)) : '' });
    await chrome.action.setTitle({ tabId, title: casting ? `Castit: casting to ${status?.deviceName ?? 'your TV'}` : 'Castit' });
  } catch {
    // Tab closed in the meantime.
  }
}

/**
 * Removes state of tabs that no longer exist (a response that finished just after its tab
 * closed can write state again). Runs at most once a minute, when the popup opens.
 */
let lastSweep = 0;
async function sweepClosedTabs(): Promise<void> {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  const [all, tabs] = await Promise.all([chrome.storage.session.get(null), chrome.tabs.query({})]);
  const open = new Set(tabs.map((t) => `tab:${t.id}`));
  const stale = Object.keys(all).filter((k) => k.startsWith('tab:') && !open.has(k));
  if (stale.length) await chrome.storage.session.remove(stale);
}

// ---------------------------------------------------------------- network detection

// Navigation resets: a new top-level document clears the tab; a sub-frame navigation clears that
// frame and everything nested in it, and records the frame's parent so nested players can be
// related to the frame that plays them.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return undefined;
    if (d.type === 'main_frame') void resetTab(d.tabId, d.url);
    else void updateTab(d.tabId, (s) => recordSubframeNavigation(s, d.frameId, d.parentFrameId, d.url));
    return undefined;
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
);

// History-API navigations (SPAs) change the URL without a main_frame request.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) void updateTab(tabId, (s) => recordSoftNavigation(s, change.url!, Date.now()));
});

const MEDIA_TYPES: `${chrome.webRequest.ResourceType}`[] = ['media', 'xmlhttprequest', 'other'];

/** requestId → first URL of a redirect chain, so the page's own URL is kept (and cast). */
const redirectOrigins = new Map<string, string>();

chrome.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (!redirectOrigins.has(d.requestId)) redirectOrigins.set(d.requestId, d.url);
    if (redirectOrigins.size > 500) redirectOrigins.clear();
  },
  { urls: ['<all_urls>'], types: MEDIA_TYPES },
);
chrome.webRequest.onErrorOccurred.addListener((d) => void redirectOrigins.delete(d.requestId), {
  urls: ['<all_urls>'],
  types: MEDIA_TYPES,
});

/** tab|frame|url|status → last time recorded; avoids a storage write per byte-range request. */
const recentlySeen = new Map<string, number>();

// onResponseStarted (not onHeadersReceived) so cached responses are observed too.
// Observation only: no blocking, no request modification. Failed responses (>= 400) are
// recorded too, so Castit knows when the page itself could not load a stream.
chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    const original = redirectOrigins.get(d.requestId);
    redirectOrigins.delete(d.requestId);
    if (d.tabId < 0) return;
    const header = (name: string) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
    const contentType = header('content-type');
    const failed = d.statusCode >= 400;
    // Error bodies (XML/HTML) say nothing about the media type; classify those by URL only.
    const classification = classifyMedia(d.url, failed ? undefined : contentType);
    if (!classification || classification.kind === 'segment') return;

    const now = Date.now();
    const seenKey = `${d.tabId}|${d.frameId}|${d.url}|${failed}`;
    if (now - (recentlySeen.get(seenKey) ?? 0) < 5000) return;
    recentlySeen.set(seenKey, now);
    if (recentlySeen.size > 500) recentlySeen.clear();

    void updateTab(d.tabId, (s) => {
      recordNetworkMedia(
        s,
        {
          url: original ?? d.url,
          finalUrl: original ? d.url : undefined,
          classification,
          mimeType: failed ? undefined : normalizeMime(contentType) || undefined,
          frameId: d.frameId,
          initiator: d.initiator,
          totalSize: failed ? undefined : totalSizeFromHeaders(d.statusCode, header('content-range'), header('content-length')),
          status: d.statusCode,
        },
        now,
      );
    });
  },
  { urls: ['<all_urls>'], types: MEDIA_TYPES },
  ['responseHeaders'],
);

// ---------------------------------------------------------------- manifest inspection

const MAX_INSPECTIONS_PER_PASS = 8;
const inspecting = new Set<number>();

/**
 * Fetches (without cookies) the HLS/DASH manifests of a tab that haven't been inspected yet,
 * so the popup can show quality, live/VOD, DRM and CORS before casting, and hide variant
 * playlists of a master. Runs only when the popup asks, never on mere page loads.
 * Masters are requested first by players, so oldest-first lets variants be skipped.
 */
async function inspectManifests(tabId: number): Promise<void> {
  if (inspecting.has(tabId)) return;
  inspecting.add(tabId);
  try {
    for (let i = 0; i < MAX_INSPECTIONS_PER_PASS; i++) {
      const state = await readTab(tabId);
      const known = new Set<string>();
      for (const [id, summary] of Object.entries(state.manifests)) {
        const c = state.candidates[id];
        if (c) known.add(dedupeKey(c.url));
        for (const key of summary.childKeys) known.add(key);
      }
      const next = Object.values(state.candidates)
        .filter((c) => (c.kind === 'hls' || c.kind === 'dash') && !known.has(dedupeKey(c.url)))
        .filter((c) => c.lastStatus === undefined || c.lastStatus < 400)
        .sort((a, b) => a.firstSeen - b.firstSeen)[0];
      if (!next) return;
      const probe = await probeStream(next);
      const summary = summarizeManifest(next.kind as 'hls' | 'dash', probe, Date.now());
      await updateTab(tabId, (s) => recordManifest(s, next.id, summary));
    }
  } finally {
    inspecting.delete(tabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void serialized(KEY.tab(tabId), () => chrome.storage.session.remove(KEY.tab(tabId)));
});

// Content scripts declared in the manifest only run in pages loaded after install; inject into open tabs.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    if (tab.id === undefined) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['main-world.js'], world: 'MAIN' })
      .catch(() => undefined);
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
      .catch(() => undefined);
  }
});

// ---------------------------------------------------------------- companion (casting + relay)

interface ActiveCast {
  device: CastDeviceInfo;
  request: CastRequest;
}

setCompanionHandlers({
  hello: async () => ({
    type: 'hello',
    active: ((await chrome.storage.session.get(KEY.activeCast))[KEY.activeCast] as ActiveCast | undefined) ?? null,
  }),
  event: (event) => void onCompanionEvent(event),
});

async function onCompanionEvent(event: CompanionEvent): Promise<void> {
  switch (event.type) {
    case 'event/status':
      await onReceiverStatus(event.status);
      break;
    case 'event/devices':
      await chrome.storage.session.set({ [KEY.devices]: event.devices });
      break;
    case 'event/playback-problem':
      await onPlaybackProblem(event.requestId, event.error, event.position);
      break;
    case 'event/load-result': {
      const pending = (await chrome.storage.session.get(KEY.pendingCast))[KEY.pendingCast] as CastRequest | undefined;
      if (pending?.requestId === event.requestId) await chrome.storage.session.remove(KEY.pendingCast);
      if (!event.ok) {
        await onAttemptFailed(event.requestId, event.error);
        break;
      }
      await onAttemptPlaying(event.requestId);
      const context = await castContext();
      if (pending && context) await chrome.storage.session.set({ [KEY.activeCast]: { device: context.device, request: pending } satisfies ActiveCast });
      await chrome.storage.session.remove(KEY.castNotice);
      // The TV is playing: turn the page's player into a remote (this also pauses it).
      await startSync(event.requestId, pending);
      break;
    }
  }
}

/** With nothing on the TV for a while, let Chrome stop the companion (it restarts on demand). */
const IDLE_DISCONNECT_MS = 5 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleDisconnect(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const status = (await chrome.storage.session.get(KEY.castStatus))[KEY.castStatus] as CastStatus | undefined;
    if (status?.sessionActive) return scheduleIdleDisconnect();
    disconnectCompanion();
  }, IDLE_DISCONNECT_MS);
}

async function onReceiverStatus(status: CastStatus): Promise<void> {
  const previous = (await chrome.storage.session.get(KEY.castStatus))[KEY.castStatus] as CastStatus | undefined;
  await chrome.storage.session.set({ [KEY.castStatus]: status });
  if (!status.sessionActive) await chrome.storage.session.remove(KEY.activeCast);
  // Casting started or ended: flip the casting tab's badge.
  if (status.sessionActive !== previous?.sessionActive || status.requestId !== previous?.requestId) {
    const context = await castContext();
    if (context) scheduleBadge(context.tabId);
  }
  await routeToPage(status);
}

/** The TV to cast to: the one asked for, else the last one used, else the first one found. */
async function chooseDevice(deviceId?: string): Promise<CastDeviceInfo | undefined> {
  const devices = await companionRequest<CastDeviceInfo[]>({ type: 'devices' }).catch(() => [] as CastDeviceInfo[]);
  const preferred = deviceId ?? ((await chrome.storage.local.get(KEY.deviceId))[KEY.deviceId] as string | undefined);
  const device = devices.find((d) => d.id === preferred) ?? devices[0];
  if (device) await chrome.storage.local.set({ [KEY.deviceId]: device.id });
  return device;
}

// ---------------------------------------------------------------- page panel

// The toolbar button shows Castit as a panel over the page (an iframe of the popup page), which,
// unlike Chrome's popup window, can have rounded corners and a translucent, blurred background.
chrome.action.onClicked.addListener((tab) => void togglePanel(tab));

async function togglePanel(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [KEY.panelToken]: token });
  const message: BackgroundToContent = { type: 'content/toggle-panel', token };
  const send = () => chrome.tabs.sendMessage(tab.id!, message, { frameId: 0 });
  try {
    await send();
    return;
  } catch {
    // No Castit script in this page yet (it was open before Castit was installed or reloaded).
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await send();
  } catch {
    // Pages extensions may not touch (chrome://, the Web Store): show the classic popup instead.
    await chrome.action.setPopup({ tabId: tab.id, popup: 'popup/index.html' });
    await chrome.action.openPopup().catch(() => undefined);
    await chrome.action.setPopup({ tabId: tab.id, popup: '' });
  }
}

// ---------------------------------------------------------------- popup + content messages

async function engineMode(): Promise<EngineMode> {
  return ((await chrome.storage.local.get(KEY.engineMode))[KEY.engineMode] as EngineMode | undefined) ?? 'auto';
}

async function transcodeSettings(): Promise<TranscodeSettings> {
  const stored = (await chrome.storage.local.get(KEY.transcodeSettings))[KEY.transcodeSettings] as TranscodeSettings | undefined;
  return { ...DEFAULT_TRANSCODE, ...stored };
}

async function companion() {
  const status = await companionStatus();
  const ready = status.state === 'ready';
  scheduleIdleDisconnect();
  return { status, ready, ffmpeg: ready && !!status.ffmpeg };
}

async function popupState(tabId: number): Promise<PopupState> {
  const [state, tab, session, comp, mode, transcode, local] = await Promise.all([
    readTab(tabId),
    chrome.tabs.get(tabId).catch(() => undefined),
    chrome.storage.session.get([KEY.castStatus, KEY.castNotice, KEY.syncTarget, KEY.castContext, KEY.devices]),
    companion(),
    engineMode(),
    transcodeSettings(),
    chrome.storage.local.get(KEY.deviceId),
  ]);
  if (comp.ready) void companionRequest({ type: 'devices' }).catch(() => undefined);
  void inspectManifests(tabId);
  void sweepClosedTabs();
  const candidates: CandidateView[] = rankCandidates(state).map((c) => ({
    ...c,
    assessment: withCompanion(assessCastability(c), comp, mode),
  }));
  return {
    companion: comp.status,
    engineMode: mode,
    transcodeSettings: transcode,
    notice: (session[KEY.castNotice] as string | undefined) ?? null,
    tabId,
    pageUrl: tab?.url ?? state.pageUrl,
    pageTitle: tab?.title,
    candidates,
    mediaSourceDetected: mediaSourceDetected(state),
    drmKeySystems: [...new Set(Object.values(state.frames).flatMap((f) => f.emeKeySystems ?? []))],
    castStatus: (session[KEY.castStatus] as CastStatus | undefined) ?? null,
    devices: comp.ready ? ((session[KEY.devices] as CastDeviceInfo[] | undefined) ?? []) : [],
    deviceId: local[KEY.deviceId] as string | undefined,
    sync: syncInfo(session[KEY.syncTarget] as SyncTarget | undefined, (session[KEY.castStatus] as CastStatus | undefined) ?? null),
    castingCandidateId: castingCandidate(
      session[KEY.castContext] as CastContext | undefined,
      session[KEY.castStatus] as CastStatus | undefined,
      tabId,
    ),
    buildId: __BUILD_ID__,
    progress: progressFor(await castContext(), tabId),
  };
}

const err = (code: CastError['code'], message: string, detail?: string): CastError => ({ code, message, detail });

async function castCandidate(tabId: number, candidateId: string, deviceId?: string): Promise<PopupCastResponse> {
  // Ask every frame for a fresh snapshot so the resume position is current.
  await chrome.tabs.sendMessage(tabId, { type: 'content/refresh' } satisfies BackgroundToContent).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 250));

  const state = await readTab(tabId);
  const ranked = rankCandidates(state);
  const chosen = ranked.find((c) => c.id === candidateId);
  if (!chosen) {
    return { ok: false, error: err('NO_VIDEO', 'That stream is no longer detected. Play the video again and reopen Castit.') };
  }

  const [mode, comp] = await Promise.all([engineMode(), companion()]);
  if (!comp.ready) return { ok: false, error: err('COMPANION_UNAVAILABLE', comp.status.error ?? 'Castit’s helper is not running.') };
  const device = await chooseDevice(deviceId);
  if (!device) {
    return { ok: false, error: err('NO_DEVICE', 'No TV found. Check that it is on and on the same Wi-Fi as this computer.') };
  }
  const streams = [chosen, ...alternativesFor(chosen, ranked)];
  const playerFrame = chosen.videoFrameId ?? chosen.frameId;
  const context: CastContext = {
    tabId,
    device,
    strategy: newStrategy(mode, streams.map((c) => ({ id: c.id, label: c.label }))),
    inputs: {},
    activeRequestId: '',
    activeCandidateId: chosen.id,
    startedAt: Date.now(),
    sync: {
      tabId,
      frameId: playerFrame,
      videoKey: chosen.video?.key,
      frameHost: playerFrame !== 0 ? new URL(frameUrl(state, playerFrame) ?? 'about:blank').hostname || undefined : undefined,
    },
  };
  // The chosen stream is probed up front: DRM, expiry and codecs decide the first engine.
  await ensureInput(context, chosen.id);
  await chrome.storage.session.remove(KEY.castNotice);
  const assess = await assessor(context);
  return runSteps(context, firstStep(context.strategy, assess, comp), comp);
}

/** Probes a stream (once per cast) and prepares its direct load request and upstream context. */
async function ensureInput(context: CastContext, candidateId: string): Promise<CastInput | undefined> {
  const existing = context.inputs[candidateId];
  if (existing) return existing;
  const state = await readTab(context.tabId);
  const candidate = rankCandidates(state).find((c) => c.id === candidateId);
  if (!candidate) return undefined;

  const probe = await probeStream(candidate);
  if (candidate.kind === 'hls' || candidate.kind === 'dash') {
    const summary = summarizeManifest(candidate.kind, probe, Date.now());
    void updateTab(context.tabId, (s) => recordManifest(s, candidate.id, summary));
  }
  const tab = await chrome.tabs.get(context.tabId).catch(() => undefined);
  const input: CastInput = {
    candidateId,
    label: candidate.label,
    kind: candidate.kind,
    direct: buildCastRequest(candidate, probe, { title: tab?.title, url: tab?.url }, crypto.randomUUID(), context.tabId),
    upstream: upstreamContextFor(candidate, frameUrl(state, candidate.frameId) ?? tab?.url, state.candidates[candidate.id]?.initiator, navigator.userAgent),
    assessment: assessCastability(candidate, probe),
  };
  context.inputs[candidateId] = input;
  return input;
}

/** Assessment per stream for the strategy: probed when known, URL/page evidence otherwise. */
async function assessor(context: CastContext): Promise<(id: string) => CastabilityAssessment> {
  const ranked = rankCandidates(await readTab(context.tabId));
  return (id) => {
    const known = context.inputs[id]?.assessment;
    if (known) return known;
    const candidate = ranked.find((c) => c.id === id);
    return candidate
      ? assessCastability(candidate)
      : { level: 'unsupported', engine: null, notes: [], blocker: err('NO_VIDEO', 'The stream is no longer detected.') };
  };
}

async function saveContext(context: CastContext): Promise<void> {
  await chrome.storage.session.set({ [KEY.castContext]: context });
}

/**
 * Executes strategy steps until one is handed to the Chromecast (its result arrives later via
 * the companion) or the strategy gives up. Failures that happen before the receiver is involved
 * (companion refused, stream blocked) advance the strategy right here.
 */
async function runSteps(context: CastContext, step: Step, comp: Awaited<ReturnType<typeof companion>>): Promise<PopupCastResponse> {
  for (;;) {
    if (context.strategy.state === 'cancelled') return { ok: false, error: err('SESSION_CANCELLED', 'Stopped.') };
    if (step.kind === 'give-up') {
      context.strategy.state = 'failed';
      context.strategy.final = step.error;
      await saveContext(context);
      await replaceCompanionSession(null);
      if (context.strategy.attempts.length > 0) {
        await chrome.storage.session.set({ [KEY.castNotice]: step.error.message });
      }
      return { ok: false, error: step.error };
    }

    const current = step;
    const input = await ensureInput(context, current.candidateId);
    const assess = await assessor(context);
    const fail = async (error: CastError, engine: CastEngine) => {
      context.strategy.attempts.push({
        candidateId: current.candidateId,
        label: input?.label ?? current.candidateId,
        engine,
        outcome: 'failed',
        error,
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      return nextStep(context.strategy, error, assess, comp);
    };
    if (!input) {
      step = await fail(err('NO_VIDEO', 'The stream is no longer detected.'), step.engine);
      continue;
    }
    if (input.assessment.blocker && input.assessment.blocker.code !== 'UNSUPPORTED_CONTAINER') {
      step = await fail(input.assessment.blocker, step.engine);
      continue;
    }

    const base: CastRequest = { ...input.direct, requestId: crypto.randomUUID(), startTime: context.resumeAt ?? input.direct.startTime };
    let request = base;
    let delivery: AttemptRecord['delivery'];
    if (step.engine !== 'direct') {
      const relayed = await relayViaCompanion(base, input.kind, input.upstream, step.engine === 'transcode' ? step.force : undefined);
      if (!('requestId' in relayed)) {
        step = await fail(relayed, step.engine);
        continue;
      }
      request = relayed;
      if (step.engine === 'transcode') delivery = relayed.plan && relayed.plan.action !== 'direct' ? relayed.plan.action : 'relay';
    } else {
      await replaceCompanionSession(null);
    }

    context.strategy.attempts.push({
      candidateId: step.candidateId,
      label: input.label,
      engine: step.engine,
      delivery,
      outcome: 'running',
      startedAt: Date.now(),
    });
    context.activeRequestId = request.requestId;
    context.activeCandidateId = step.candidateId;
    await saveContext(context);
    await chrome.storage.session.set({ [KEY.pendingCast]: request });
    if (context.strategy.attempts.length > 1) {
      await chrome.storage.session.set({ [KEY.castNotice]: `Trying: ${attemptLabel(context.strategy.attempts.at(-1)!)}…` });
    }

    try {
      // The outcome arrives later as an event/load-result.
      await companionRequest({ type: 'cast', device: context.device, request });
      return { ok: true };
    } catch (e) {
      const error = err('COMPANION_UNAVAILABLE', (e as Error).message);
      Object.assign(context.strategy.attempts.at(-1)!, { outcome: 'failed', error, endedAt: Date.now() });
      step = { kind: 'give-up', error };
    }
  }
}

/**
 * Opens a companion session for `direct.url` and returns the request rewritten to the companion.
 * With `transcode` set (false = convert only if needed, true = always), FFmpeg analyses the
 * stream and the request points at the converted HLS output when conversion was needed.
 */
async function relayViaCompanion(
  direct: CastRequest,
  kind: StreamKind,
  upstream: UpstreamContext,
  transcode?: boolean,
): Promise<CastRequest | CastError> {
  let session;
  const settings = await transcodeSettings();
  try {
    session = await createCompanionSession({
      url: direct.url,
      kind: kind === 'hls' || kind === 'dash' || kind === 'progressive' ? kind : 'unknown',
      context: upstream,
      profile: settings.profile,
      transcode: transcode === undefined ? undefined : { mode: transcode ? 'force' : 'auto', ...settings },
    });
  } catch (e) {
    const code = e instanceof CompanionError && e.code === 'BLOCKED_ADDRESS' ? 'STREAM_UNAVAILABLE' : 'COMPANION_UNAVAILABLE';
    return err(code, (e as Error).message);
  }
  const { check } = session;
  if (!check.ok) {
    void deleteCompanionSession(session.sessionId);
    if (check.status === 401 || check.status === 403) {
      return err(
        'AUTH_REQUIRED',
        `The stream server refused the companion too (HTTP ${check.status}). It probably needs your login cookies, which Castit does not forward.`,
      );
    }
    if (check.status === 404 || check.status === 410) {
      return err('STREAM_UNAVAILABLE', `The stream URL returned HTTP ${check.status}; it has probably expired. Reload the page and play the video again.`);
    }
    return err('STREAM_UNAVAILABLE', `The companion could not fetch the stream (${check.status ? `HTTP ${check.status}` : (check.error ?? 'unknown error')}).`);
  }
  await replaceCompanionSession(session.sessionId);
  const media = session.media;
  if (!media) {
    // Relayed unchanged (no conversion requested, needed, or possible).
    return { ...direct, requestId: crypto.randomUUID(), url: session.mediaUrl, engine: 'companion', plan: session.plan };
  }
  return {
    ...direct,
    requestId: crypto.randomUUID(),
    url: session.mediaUrl,
    contentType: media.contentType,
    streamType: media.streamType,
    hlsSegmentFormat: media.hlsSegmentFormat,
    hlsVideoSegmentFormat: media.hlsVideoSegmentFormat,
    duration: media.duration ?? direct.duration,
    // Remuxed output only grows from the start, so resuming mid-way works only when segmented.
    startTime: media.seekable ? direct.startTime : undefined,
    textTracks: media.textTracks,
    plan: session.plan,
    engine: 'transcode',
  };
}

/** Keeps at most one companion session per browser: the one currently cast. */
async function replaceCompanionSession(sessionId: string | null): Promise<void> {
  const previous = (await chrome.storage.session.get(KEY.companionSession))[KEY.companionSession] as string | undefined;
  if (previous && previous !== sessionId) void deleteCompanionSession(previous);
  if (sessionId) await chrome.storage.session.set({ [KEY.companionSession]: sessionId });
  else await chrome.storage.session.remove(KEY.companionSession);
}

/** The receiver failed to start this attempt: let the strategy choose the next one. */
async function onAttemptFailed(requestId: string, error: CastError): Promise<void> {
  const context = await castContext();
  if (!context || context.activeRequestId !== requestId || context.strategy.state !== 'running') return;
  const attempt = context.strategy.attempts.at(-1);
  if (attempt) Object.assign(attempt, { outcome: 'failed', error, endedAt: Date.now() });
  const comp = await companion();
  const step = nextStep(context.strategy, error, await assessor(context), comp);
  if (step.kind === 'attempt') {
    await chrome.storage.session.set({ [KEY.castNotice]: `${attempt ? attemptLabel(attempt) : 'Casting'} failed: ${error.message} Trying another way…` });
  }
  await runSteps(context, step, comp);
}

/** The receiver verified playback. */
async function onAttemptPlaying(requestId: string): Promise<boolean> {
  const context = await castContext();
  if (!context || context.activeRequestId !== requestId) return false;
  const attempt = context.strategy.attempts.at(-1);
  if (attempt) Object.assign(attempt, { outcome: 'playing', endedAt: Date.now() });
  context.strategy.state = 'playing';
  context.resumeAt = undefined;
  await saveContext(context);
  return true;
}

/** Playback broke or froze after it started. Early on, switch engine and resume at the same spot. */
async function onPlaybackProblem(requestId: string, error: CastError, position: number): Promise<void> {
  const context = await castContext();
  if (!context || context.activeRequestId !== requestId) return;
  const attempt = context.strategy.attempts.at(-1);
  const early = !!attempt && Date.now() - attempt.startedAt < RECOVERY_WINDOW_MS;
  if (context.strategy.mode !== 'auto' || !early) {
    await chrome.storage.session.set({ [KEY.castNotice]: `Problem on the TV: ${error.message} Cast again from the popup to retry.` });
    return;
  }
  if (attempt) Object.assign(attempt, { outcome: 'failed', error, endedAt: Date.now() });
  context.strategy.state = 'running';
  context.resumeAt = position > 0 ? position : undefined;
  const comp = await companion();
  const step = nextStep(context.strategy, error, await assessor(context), comp);
  if (step.kind === 'give-up') {
    context.strategy.state = 'failed';
    context.strategy.final = step.error;
    await saveContext(context);
    await chrome.storage.session.set({ [KEY.castNotice]: `Problem on the TV: ${error.message}` });
    return;
  }
  await chrome.storage.session.set({ [KEY.castNotice]: `${error.message} Switching to another way and resuming…` });
  await runSteps(context, step, comp);
}

async function cancelCast(): Promise<void> {
  const context = await castContext();
  if (!context || context.strategy.state !== 'running') return;
  context.strategy.state = 'cancelled';
  await saveContext(context);
  await chrome.storage.session.set({ [KEY.castNotice]: 'Stopped trying.' });
  await sendCommand({ type: 'stop' });
}

function progressFor(context: CastContext | undefined, tabId: number): CastProgress | undefined {
  if (!context || context.tabId !== tabId || context.strategy.attempts.length === 0) return undefined;
  return { state: context.strategy.state, lines: describeAttempts(context.strategy), final: context.strategy.final };
}

/** Plain-text report for bug reports. Query strings (often signatures) are removed everywhere. */
async function diagnosticsReport(tabId: number): Promise<string> {
  const strip = (url: string | undefined) => (url ? url.split('#')[0]!.replace(/\?.*$/, '?…') : '–');
  const [context, comp, mode, tab, session, state] = await Promise.all([
    castContext(),
    companion(),
    engineMode(),
    chrome.tabs.get(tabId).catch(() => undefined),
    chrome.storage.session.get(KEY.castStatus),
    readTab(tabId),
  ]);
  const status = session[KEY.castStatus] as CastStatus | undefined;
  const lines = [
    `Castit diagnostics · ${new Date().toISOString()}`,
    `Extension ${chrome.runtime.getManifest().version} (build ${__BUILD_ID__}) · ${navigator.userAgent}`,
    `Page: ${strip(tab?.url)}`,
    `Casting method: ${mode} · Companion: ${comp.status.state}${comp.ready ? ` ${comp.status.version} (FFmpeg: ${comp.status.ffmpeg ? (comp.status.hwEncoder ?? 'software') : 'no'})` : ''}`,
    `Receiver: ${status?.deviceName ?? '–'} · ${status?.phase ?? 'no status'}${status?.engine ? ` · ${status.engine}` : ''}${status?.error ? ` · ${status.error.code}: ${status.error.message}` : ''}`,
    '',
    'Detected streams:',
    ...rankCandidates(state).slice(0, 12).map((c) => {
      const a = assessCastability(c, undefined);
      return `- ${c.label} [${c.kind}${c.quality ? ` ${c.quality}` : ''}] ${strip(c.url)} · ${a.level}${c.video ? ` · player ${c.video.key}${c.embedded ? ` in ${c.frameHost}` : ''}` : ''}${c.isAd ? ' · ad' : ''}`;
    }),
  ];
  if (context?.tabId === tabId) {
    lines.push('', `Latest cast (${context.strategy.mode}, ${context.strategy.state}):`);
    for (const input of Object.values(context.inputs)) {
      lines.push(`- stream ${input.label}: ${input.assessment.level}${input.assessment.notes.length ? ` · ${input.assessment.notes.join(' ')}` : ''}`);
    }
    lines.push(...describeAttempts(context.strategy).map((l) => `  ${l}`));
    const details = new Set(context.strategy.attempts.flatMap((a) => (a.error?.detail ? [`  (${a.error.code}) ${a.error.detail}`] : [])));
    lines.push(...details);
    if (context.strategy.final) lines.push(`Result: ${context.strategy.final.code}: ${context.strategy.final.message}`);
  }
  return lines.join('\n');
}

async function castContext(): Promise<CastContext | undefined> {
  const context = (await chrome.storage.session.get(KEY.castContext))[KEY.castContext] as CastContext | undefined;
  // Contexts stored by an older build lack the strategy; treat them as absent.
  return context?.strategy ? context : undefined;
}

// ---------------------------------------------------------------- page player sync

async function syncTarget(): Promise<SyncTarget | undefined> {
  return (await chrome.storage.session.get(KEY.syncTarget))[KEY.syncTarget] as SyncTarget | undefined;
}

function sendToPage(target: Pick<SyncTarget, 'tabId' | 'frameId'>, message: BackgroundToContent): Promise<unknown> {
  return chrome.tabs.sendMessage(target.tabId, message, { frameId: target.frameId ?? 0 });
}

/** The cast is verified playing: ask the source page's player to act as a remote control. */
async function startSync(requestId: string, pending: CastRequest | undefined): Promise<void> {
  const context = await castContext();
  const previous = await syncTarget();
  if (previous && previous.requestId !== requestId && previous.state === 'active') {
    await sendToPage(previous, { type: 'content/sync-stop', requestId: previous.requestId, reason: 'replaced', lastTime: null, wasPlaying: false }).catch(() => undefined);
  }
  const where = context?.activeRequestId === requestId ? context.sync : pending ? { tabId: pending.sourceTabId } : undefined;
  if (!where) return;
  const status = (await chrome.storage.session.get(KEY.castStatus))[KEY.castStatus] as CastStatus | undefined;

  let response: SyncStartResponse | undefined;
  try {
    response = (await sendToPage(where, {
      type: 'content/sync-start',
      requestId,
      videoKey: where.videoKey,
      deviceName: status?.deviceName,
    })) as SyncStartResponse | undefined;
  } catch {
    response = undefined;
  }

  const base = { tabId: where.tabId, frameId: where.frameId, frameHost: where.frameHost, requestId, lastTime: null, wasPlaying: true, deviceName: status?.deviceName };
  if (response?.ok) {
    await chrome.storage.session.set({ [KEY.syncTarget]: { ...base, videoKey: response.videoKey, state: 'active' } satisfies SyncTarget });
    return;
  }
  // No controllable player: at least silence the page so audio doesn't play twice.
  void chrome.tabs.sendMessage(where.tabId, { type: 'content/pause-local' } satisfies BackgroundToContent).catch(() => undefined);
  const reason = response?.reason ?? 'The page’s player could not be reached (it may have navigated away or be inaccessible). Use Castit’s controls.';
  await chrome.storage.session.set({ [KEY.syncTarget]: { ...base, state: 'unavailable', reason } satisfies SyncTarget });
}

/** Mirrors receiver state onto the page player and ends the sync when the cast ends. */
async function routeToPage(status: CastStatus): Promise<void> {
  const target = await syncTarget();
  if (!target) return;
  const route = routeStatus(target, status);
  const next = { ...target, ...route.update };
  if (target.state === 'active' && route.forward) {
    void sendToPage(target, { type: 'content/sync-state', requestId: target.requestId, state: route.forward }).catch(() => undefined);
  }
  if (route.stop) {
    if (target.state === 'active') {
      void sendToPage(target, {
        type: 'content/sync-stop',
        requestId: target.requestId,
        reason: route.stop,
        lastTime: next.lastTime,
        wasPlaying: next.wasPlaying,
      }).catch(() => undefined);
    }
    await chrome.storage.session.remove(KEY.syncTarget);
    return;
  }
  if (next.lastTime !== target.lastTime || next.wasPlaying !== target.wasPlaying || next.deviceName !== target.deviceName) {
    await chrome.storage.session.set({ [KEY.syncTarget]: next });
  }
}

/** Accepts remote commands only from the frame and cast the sync was set up for. */
async function onPageRemote(sender: chrome.runtime.MessageSender, requestId: string, command: RemoteCommand): Promise<void> {
  const target = await syncTarget();
  if (!target || target.state !== 'active' || target.requestId !== requestId) return;
  if (sender.tab?.id !== target.tabId || (sender.frameId ?? 0) !== (target.frameId ?? 0)) return;
  await sendCommand(command);
}

async function onSyncLost(sender: chrome.runtime.MessageSender, requestId: string, reason: string): Promise<void> {
  const target = await syncTarget();
  if (!target || target.requestId !== requestId || sender.tab?.id !== target.tabId) return;
  await chrome.storage.session.set({ [KEY.syncTarget]: { ...target, state: 'unavailable', reason } satisfies SyncTarget });
}

/** The candidate of this tab that is on the TV right now. */
function castingCandidate(context: CastContext | undefined, status: CastStatus | undefined, tabId: number): string | undefined {
  if (!context?.strategy || !status?.sessionActive || context.sync.tabId !== tabId) return undefined;
  if (status.requestId !== context.activeRequestId || ['idle', 'error', 'ended'].includes(status.phase)) return undefined;
  return context.activeCandidateId;
}

function syncInfo(target: SyncTarget | undefined, status: CastStatus | null): SyncInfo {
  if (!target || !status?.sessionActive) return { state: 'off' };
  return { state: target.state, frameHost: target.frameHost, reason: target.reason };
}

async function sendCommand(command: RemoteCommand): Promise<CommandResponse> {
  // Stopping ends the TV's player, so the relay (if any) is no longer needed.
  if (command.type === 'disconnect' || command.type === 'stop') void replaceCompanionSession(null);
  try {
    const error = await companionRequest<CastError | null>({ type: 'command', command }, 10_000);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: err('COMPANION_UNAVAILABLE', (e as Error).message) };
  }
}

chrome.runtime.onMessage.addListener((message: ContentToBackground | PopupRequest, sender, sendResponse) => {
  switch (message.type) {
    case 'content/remote':
      void onPageRemote(sender, message.requestId, message.command);
      return false;
    case 'content/sync-lost':
      void onSyncLost(sender, message.requestId, message.reason);
      return false;
    case 'content/report': {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId === undefined) return false;
      const frameId = sender.frameId;
      void updateTab(tabId, (s) =>
        recordFrameReport(
          s,
          frameId,
          { url: message.url, title: message.title, isTop: message.isTop, videos: message.videos, emeKeySystems: message.emeKeySystems },
          Date.now(),
        ),
      );
      return false;
    }
    case 'popup/get-state':
      void popupState(message.tabId).then(sendResponse);
      return true;
    case 'popup/cast':
      void castCandidate(message.tabId, message.candidateId, message.deviceId)
        .catch((e): PopupCastResponse => ({ ok: false, error: err('INTERNAL', 'Unexpected error while preparing the cast.', String(e)) }))
        .then(sendResponse);
      return true;
    case 'popup/command':
      void sendCommand(message.command).then(sendResponse);
      return true;
    case 'popup/set-device':
      void chrome.storage.local.set({ [KEY.deviceId]: message.deviceId }).then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/set-transcode':
      void chrome.storage.local.set({ [KEY.transcodeSettings]: message.settings }).then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/set-engine':
      void chrome.storage.local.set({ [KEY.engineMode]: message.mode }).then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/cast-cancel':
      void cancelCast().then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/diagnostics':
      void diagnosticsReport(message.tabId).then(sendResponse);
      return true;
    case 'popup/highlight':
      void chrome.tabs
        .sendMessage(message.tabId, { type: 'content/highlight', videoKey: message.videoKey } satisfies BackgroundToContent, { frameId: message.frameId })
        .then((r: { found?: boolean } | undefined): HighlightResult => (r?.found ? 'shown' : message.videoKey ? 'not-found' : 'shown'))
        // No Castit script answering in that frame: typically a page opened before Castit was reloaded.
        .catch((): HighlightResult => 'unreachable')
        .then(sendResponse);
      return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-play') void sendCommand({ type: 'togglePlay' });
});
