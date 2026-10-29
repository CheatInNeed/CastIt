// Castit background service worker.
//
// MV3 service workers are suspended after ~30 s idle and restarted on the next event, so all
// state that must survive lives in chrome.storage.session; listeners are registered
// synchronously at top level so Chrome can wake the worker for them. The only in-memory state
// is the live controller Port (a Port cannot be persisted; the controller reconnects when the
// worker restarts) and short-lived throttling caches.
import {
  CONTROLLER_PORT_NAME,
  PROTOCOL_VERSION,
  type BackgroundToContent,
  type BackgroundToController,
  type CandidateView,
  type CastError,
  type CastRequest,
  type CastEngine,
  type CastStatus,
  type CommandResponse,
  type CompanionPairResult,
  type EngineMode,
  type StreamKind,
  type UpstreamContext,
  type ContentToBackground,
  type ControllerToBackground,
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
  companionStatus,
  createCompanionSession,
  deleteCompanionSession,
  loadCompanionConfig,
  pairCompanion,
  saveCompanionConfig,
  type CompanionConfig,
} from './lib/companion.ts';
import { chooseEngine, shouldFallBack, upstreamContextFor, withCompanion } from './lib/engine.ts';
import { classifyMedia, normalizeMime, totalSizeFromHeaders } from './lib/media-types.ts';
import { dedupeKey } from './lib/media-types.ts';
import { probeStream, summarizeManifest } from './lib/probe.ts';
import { frameUrl, mediaSourceDetected, rankCandidates } from './lib/rank.ts';
import {
  emptyTabState,
  normalizeTabState,
  recordFrameReport,
  recordManifest,
  recordNetworkMedia,
  recordSoftNavigation,
  recordSubframeNavigation,
} from './lib/store.ts';

const CONTROLLER_URL = __CONTROLLER_URL__;
const CONTROLLER_ORIGIN = new URL(CONTROLLER_URL).origin;

const KEY = {
  tab: (tabId: number) => `tab:${tabId}`,
  castStatus: 'castStatus',
  pendingCast: 'pendingCast',
  controllerToken: 'controllerToken',
  controllerTabId: 'controllerTabId',
  castContext: 'castContext',
  castNotice: 'castNotice',
  companionSession: 'companionSession',
  engineMode: 'engineMode', // chrome.storage.local
} as const;

/** What the background needs to retry a cast through another engine. */
interface CastContext {
  direct: CastRequest;
  kind: StreamKind;
  upstream: UpstreamContext;
  mode: EngineMode;
  tried: CastEngine[];
  activeRequestId: string;
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
    await updateBadge(tabId, state);
  });
}

function resetTab(tabId: number, pageUrl?: string): Promise<void> {
  return serialized(KEY.tab(tabId), async () => {
    await chrome.storage.session.set({ [KEY.tab(tabId)]: emptyTabState(tabId, pageUrl) });
    await updateBadge(tabId, emptyTabState(tabId));
  });
}

async function updateBadge(tabId: number, state: TabMediaState): Promise<void> {
  const count = rankCandidates(state).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 99)) : '' });
  } catch {
    // Tab closed in the meantime.
  }
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
  void (async () => {
    if ((await chrome.storage.session.get(KEY.controllerTabId))[KEY.controllerTabId] === tabId) {
      await chrome.storage.session.remove(KEY.controllerTabId);
    }
  })();
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

// ---------------------------------------------------------------- controller connection

let controllerPort: chrome.runtime.Port | null = null;

async function controllerToken(): Promise<string> {
  const stored = (await chrome.storage.session.get(KEY.controllerToken))[KEY.controllerToken] as string | undefined;
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.session.set({ [KEY.controllerToken]: token });
  return token;
}

function postToController(message: BackgroundToController): boolean {
  if (!controllerPort) return false;
  try {
    controllerPort.postMessage(message);
    return true;
  } catch {
    controllerPort = null;
    return false;
  }
}

// Only the configured controller origin can connect (also enforced by externally_connectable),
// and it must present the per-browser-session token handed to it in the URL fragment.
chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== CONTROLLER_PORT_NAME || port.sender?.origin !== CONTROLLER_ORIGIN) {
    port.disconnect();
    return;
  }
  let authenticated = false;

  port.onMessage.addListener(async (raw: ControllerToBackground) => {
    if (!authenticated) {
      if (raw.type !== 'controller/hello') return;
      if (raw.version !== PROTOCOL_VERSION || raw.token !== (await controllerToken())) {
        port.postMessage({ type: 'controller/rejected', reason: 'Invalid or outdated pairing token. Open the controller from the Castit popup.' } satisfies BackgroundToController);
        port.disconnect();
        return;
      }
      authenticated = true;
      controllerPort = port;
      if (port.sender?.tab?.id !== undefined) {
        await chrome.storage.session.set({ [KEY.controllerTabId]: port.sender.tab.id });
      }
      const pending = ((await chrome.storage.session.get(KEY.pendingCast))[KEY.pendingCast] as CastRequest | undefined) ?? null;
      port.postMessage({ type: 'controller/welcome', pending } satisfies BackgroundToController);
      return;
    }

    switch (raw.type) {
      case 'controller/status':
        await onControllerStatus(raw.status);
        break;
      case 'controller/load-result': {
        const pending = (await chrome.storage.session.get(KEY.pendingCast))[KEY.pendingCast] as CastRequest | undefined;
        if (pending?.requestId === raw.requestId) await chrome.storage.session.remove(KEY.pendingCast);
        if (!raw.ok) {
          await fallBackToCompanion(raw.requestId, raw.error);
          break;
        }
        await chrome.storage.session.remove(KEY.castNotice);
        if (pending) {
          // The TV is playing: stop the page's own playback to avoid double audio.
          void chrome.tabs
            .sendMessage(pending.sourceTabId, { type: 'content/pause-local' } satisfies BackgroundToContent)
            .catch(() => undefined);
        }
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (controllerPort === port) controllerPort = null;
  });
});

async function onControllerStatus(status: CastStatus): Promise<void> {
  const previous = (await chrome.storage.session.get(KEY.castStatus))[KEY.castStatus] as CastStatus | undefined;
  await chrome.storage.session.set({ [KEY.castStatus]: status });
  // The controller needs a click (user gesture) to open Chrome's device picker; bring it forward.
  if (status.phase === 'awaiting-device' && previous?.phase !== 'awaiting-device') await focusController();
}

async function focusController(): Promise<boolean> {
  const tabId = (await chrome.storage.session.get(KEY.controllerTabId))[KEY.controllerTabId] as number | undefined;
  if (tabId === undefined) return false;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    await chrome.storage.session.remove(KEY.controllerTabId);
    return false;
  }
}

async function openController(): Promise<void> {
  if (await focusController()) return;
  const url = new URL(CONTROLLER_URL);
  url.searchParams.set('ext', chrome.runtime.id);
  url.hash = `token=${await controllerToken()}`;
  const tab = await chrome.tabs.create({ url: url.href });
  if (tab.id !== undefined) await chrome.storage.session.set({ [KEY.controllerTabId]: tab.id });
}

// ---------------------------------------------------------------- popup + content messages

async function engineMode(): Promise<EngineMode> {
  return ((await chrome.storage.local.get(KEY.engineMode))[KEY.engineMode] as EngineMode | undefined) ?? 'auto';
}

async function companion() {
  const config = await loadCompanionConfig();
  const status = await companionStatus(config);
  return { config, status, ready: status.state === 'paired' };
}

async function popupState(tabId: number): Promise<PopupState> {
  const [state, tab, session, comp, mode] = await Promise.all([
    readTab(tabId),
    chrome.tabs.get(tabId).catch(() => undefined),
    chrome.storage.session.get([KEY.castStatus, KEY.castNotice]),
    companion(),
    engineMode(),
  ]);
  void inspectManifests(tabId);
  const candidates: CandidateView[] = rankCandidates(state).map((c) => ({
    ...c,
    assessment: withCompanion(assessCastability(c), comp.ready, mode),
  }));
  return {
    companion: comp.status,
    engineMode: mode,
    notice: (session[KEY.castNotice] as string | undefined) ?? null,
    tabId,
    pageUrl: tab?.url ?? state.pageUrl,
    pageTitle: tab?.title,
    candidates,
    mediaSourceDetected: mediaSourceDetected(state),
    castStatus: (session[KEY.castStatus] as CastStatus | undefined) ?? null,
    controllerConnected: controllerPort !== null,
    controllerUrl: CONTROLLER_URL,
  };
}

const err = (code: CastError['code'], message: string, detail?: string): CastError => ({ code, message, detail });

async function castCandidate(tabId: number, candidateId: string): Promise<PopupCastResponse> {
  // Ask every frame for a fresh snapshot so the resume position is current.
  await chrome.tabs.sendMessage(tabId, { type: 'content/refresh' } satisfies BackgroundToContent).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 250));

  const state = await readTab(tabId);
  const candidate = rankCandidates(state).find((c) => c.id === candidateId);
  if (!candidate) {
    return { ok: false, error: err('NO_VIDEO', 'That stream is no longer detected. Play the video again and reopen Castit.') };
  }

  const probe = await probeStream(candidate);
  if (candidate.kind === 'hls' || candidate.kind === 'dash') {
    const summary = summarizeManifest(candidate.kind, probe, Date.now());
    void updateTab(tabId, (s) => recordManifest(s, candidate.id, summary));
  }
  const assessment = assessCastability(candidate, probe);
  if (assessment.blocker) return { ok: false, error: assessment.blocker };

  const [mode, comp] = await Promise.all([engineMode(), companion()]);
  const choice = chooseEngine(mode, assessment, comp.ready);
  if ('error' in choice) return { ok: false, error: choice.error };

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const direct = buildCastRequest(candidate, probe, { title: tab?.title, url: tab?.url }, crypto.randomUUID(), tabId);
  const upstream = upstreamContextFor(
    candidate,
    frameUrl(state, candidate.frameId) ?? tab?.url,
    state.candidates[candidate.id]?.initiator,
    navigator.userAgent,
  );

  let request = direct;
  if (choice.engine === 'companion') {
    const relayed = await relayViaCompanion(comp.config, direct, candidate.kind, upstream);
    if (!('requestId' in relayed)) return { ok: false, error: relayed };
    request = relayed;
  } else {
    await replaceCompanionSession(comp.config, null);
  }

  const context: CastContext = { direct, kind: candidate.kind, upstream, mode, tried: [choice.engine], activeRequestId: request.requestId };
  await chrome.storage.session.set({ [KEY.pendingCast]: request, [KEY.castContext]: context });
  await chrome.storage.session.remove(KEY.castNotice);

  if (postToController({ type: 'controller/load', request })) return { ok: true, controller: 'loading' };
  await openController();
  return { ok: true, controller: 'opened' };
}

/** Opens a companion session for `direct.url` and returns the request rewritten to the relay URL. */
async function relayViaCompanion(
  config: CompanionConfig,
  direct: CastRequest,
  kind: StreamKind,
  upstream: UpstreamContext,
): Promise<CastRequest | CastError> {
  let session;
  try {
    session = await createCompanionSession(config, {
      url: direct.url,
      kind: kind === 'hls' || kind === 'dash' || kind === 'progressive' ? kind : 'unknown',
      context: upstream,
    });
  } catch (e) {
    const code = e instanceof CompanionError && e.code === 'BLOCKED_ADDRESS' ? 'STREAM_UNAVAILABLE' : 'COMPANION_UNAVAILABLE';
    return err(code, (e as Error).message);
  }
  const { check } = session;
  if (!check.ok) {
    void deleteCompanionSession(config, session.sessionId);
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
  await replaceCompanionSession(config, session.sessionId);
  return { ...direct, requestId: crypto.randomUUID(), url: session.mediaUrl, engine: 'companion' };
}

/** Keeps at most one companion session per browser: the one currently cast. */
async function replaceCompanionSession(config: CompanionConfig, sessionId: string | null): Promise<void> {
  const previous = (await chrome.storage.session.get(KEY.companionSession))[KEY.companionSession] as string | undefined;
  if (previous && previous !== sessionId) void deleteCompanionSession(config, previous);
  if (sessionId) await chrome.storage.session.set({ [KEY.companionSession]: sessionId });
  else await chrome.storage.session.remove(KEY.companionSession);
}

/** Direct cast failed on the receiver: retry once through the companion when that can help. */
async function fallBackToCompanion(requestId: string, error: CastError): Promise<void> {
  const context = (await chrome.storage.session.get(KEY.castContext))[KEY.castContext] as CastContext | undefined;
  if (!context || context.activeRequestId !== requestId) return;
  const comp = await companion();
  if (!shouldFallBack(context.mode, context.tried, error, comp.ready)) return;

  await chrome.storage.session.set({ [KEY.castNotice]: `Direct casting failed (${error.message}). Retrying through the local companion…` });
  const relayed = await relayViaCompanion(comp.config, context.direct, context.kind, context.upstream);
  if (!('requestId' in relayed)) {
    await chrome.storage.session.set({ [KEY.castNotice]: `Direct casting failed, and the companion could not help: ${relayed.message}` });
    return;
  }
  context.tried.push('companion');
  context.activeRequestId = relayed.requestId;
  await chrome.storage.session.set({ [KEY.pendingCast]: relayed, [KEY.castContext]: context });
  if (!postToController({ type: 'controller/load', request: relayed })) await openController();
}

async function pairWithCompanion(code: string): Promise<CompanionPairResult> {
  try {
    const config = await pairCompanion(await loadCompanionConfig(), code);
    return { ok: true, status: await companionStatus(config) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function sendCommand(command: RemoteCommand): CommandResponse {
  if (command.type === 'disconnect') {
    void loadCompanionConfig().then((config) => replaceCompanionSession(config, null));
  }
  if (postToController({ type: 'controller/command', command })) return { ok: true };
  return {
    ok: false,
    error: err('CONTROLLER_UNAVAILABLE', 'The Castit controller page is not open, so the Chromecast cannot be controlled.'),
  };
}

chrome.runtime.onMessage.addListener((message: ContentToBackground | PopupRequest, sender, sendResponse) => {
  switch (message.type) {
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
      void castCandidate(message.tabId, message.candidateId)
        .catch((e): PopupCastResponse => ({ ok: false, error: err('INTERNAL', 'Unexpected error while preparing the cast.', String(e)) }))
        .then(sendResponse);
      return true;
    case 'popup/command':
      sendResponse(sendCommand(message.command));
      return false;
    case 'popup/companion-pair':
      void pairWithCompanion(message.code).then(sendResponse);
      return true;
    case 'popup/companion-forget':
      void loadCompanionConfig()
        .then((config) => saveCompanionConfig({ url: config.url }))
        .then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/set-engine':
      void chrome.storage.local.set({ [KEY.engineMode]: message.mode }).then(() => sendResponse({ ok: true }));
      return true;
    case 'popup/open-controller':
      void openController().then(() => sendResponse({ ok: true }));
      return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-play') sendCommand({ type: 'togglePlay' });
});
