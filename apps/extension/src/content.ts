// Castit content script: runs in every frame (all_frames), reports <video> elements to the
// background. It only sees its own frame's DOM; cross-origin iframes get their own instance,
// which is how embedded third-party players are covered without breaking browser isolation.
// Hints about MediaSource / EME / shadow roots come from the MAIN-world script (main-world.ts).
import type {
  BackgroundToContent,
  ContentRemoteMessage,
  ContentReportMessage,
  ContentSyncLostMessage,
  SyncStartResponse,
} from '@castit/shared';
import { describeVideo, findVideos, isReportable, markPlayed, pauseAll, videoKey } from './lib/detection.ts';
import { SyncSession } from './lib/sync-session.ts';
import { MAIN_EVENT, type MainWorldHint } from './main-world.ts';

declare global {
  interface Window {
    __castitContentLoaded?: boolean;
  }
}

// Guard against double injection (manifest injection + scripting.executeScript on install).
if (!window.__castitContentLoaded) {
  window.__castitContentLoaded = true;
  init();
}

const MEDIA_EVENTS = ['play', 'pause', 'loadedmetadata', 'emptied', 'ended', 'durationchange', 'seeked', 'error'];

function init(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportedAny = false;
  let firstScan = true;
  /** Set once any shadow root exists in this frame; until then scans stay shallow (cheap). */
  let shadowSeen = false;
  const shadowRoots = new WeakSet<ShadowRoot>();
  const mseByUrl = new Map<string, string[]>();
  const mseUnattributed: string[] = [];
  const emeKeySystems = new Set<string>();

  const onMediaEvent = (e: Event) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (e.type === 'play') markPlayed(e.target);
    schedule(100);
  };
  const onPlaying = (e: Event) => {
    if (e.target instanceof HTMLVideoElement) {
      markPlayed(e.target);
      schedule(100);
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.nodeName === 'VIDEO' || m.target.nodeName === 'SOURCE') return schedule(400);
        continue;
      }
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof Element && (node.nodeName === 'VIDEO' || node.querySelector('video'))) {
          return schedule(400);
        }
      }
    }
  });
  const observeOptions: MutationObserverInit = { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] };

  /** Media events don't bubble, so each root (document or shadow root) gets capture listeners. */
  const watchRoot = (root: Document | ShadowRoot) => {
    for (const type of MEDIA_EVENTS) root.addEventListener(type, onMediaEvent, true);
    root.addEventListener('playing', onPlaying, true);
    observer.observe(root, observeOptions);
  };

  const onShadowRoot = (root: ShadowRoot) => {
    shadowSeen = true;
    if (shadowRoots.has(root)) return;
    shadowRoots.add(root);
    watchRoot(root);
  };

  // The first scan walks shadow roots once; later scans only do so if this frame uses shadow DOM.
  // Reports are debounced, so the deep walk runs at most a few times per second.
  const collect = () => {
    const deep = shadowSeen || firstScan;
    firstScan = false;
    return findVideos(document, deep, onShadowRoot).filter((f) => isReportable(f.video));
  };

  const report = () => {
    timer = undefined;
    const videos = collect().map(({ video, inShadowRoot }) => {
      const src = video.currentSrc || video.getAttribute('src') || '';
      const mse = mseByUrl.get(src) ?? (src.startsWith('blob:') || !src ? mseUnattributed : []);
      return describeVideo(video, { inShadowRoot, mseMimeTypes: [...new Set(mse)] });
    });
    // Frames without videos stay silent (ad/analytics iframes would otherwise flood the worker).
    if (videos.length === 0 && emeKeySystems.size === 0 && !reportedAny) return;
    reportedAny = true;
    const message: ContentReportMessage = {
      type: 'content/report',
      url: location.href,
      title: window === window.top ? document.title : undefined,
      isTop: window === window.top,
      videos,
      emeKeySystems: [...emeKeySystems],
    };
    chrome.runtime.sendMessage(message).catch(() => undefined);
  };

  function schedule(delay: number): void {
    if (timer !== undefined) {
      if (delay >= 400) return;
      clearTimeout(timer);
    }
    timer = setTimeout(report, delay);
  }

  document.addEventListener(MAIN_EVENT, (e) => {
    let hint: MainWorldHint;
    try {
      hint = JSON.parse(String((e as CustomEvent).detail)) as MainWorldHint;
    } catch {
      return;
    }
    if (hint.type === 'mse' && typeof hint.mime === 'string') {
      const list = hint.url ? (mseByUrl.get(hint.url) ?? []) : mseUnattributed;
      if (list.length < 8) list.push(hint.mime.slice(0, 200));
      if (hint.url) mseByUrl.set(hint.url, list);
      schedule(400);
    } else if (hint.type === 'eme' && typeof hint.keySystem === 'string') {
      emeKeySystems.add(hint.keySystem.slice(0, 100));
      schedule(100);
    } else if (hint.type === 'shadow') {
      shadowSeen = true;
      schedule(400);
    }
  });

  watchRoot(document);

  // ------------------------------------------------------------ page player as remote control

  let sync: SyncSession | null = null;

  /** The video to sync: the one the cast came from, else the one the user was watching. */
  const pickVideo = (key: string | undefined): HTMLVideoElement | undefined => {
    const videos = findVideos(document, true).map((f) => f.video);
    if (key) {
      const match = videos.find((v) => videoKey(v) === key);
      if (match) return match;
    }
    const described = videos.filter(isReportable).map((v) => ({ v, d: describeVideo(v) }));
    described.sort(
      (a, b) =>
        Number(!b.d.paused) - Number(!a.d.paused) ||
        (b.d.lastPlayedAt ?? 0) - (a.d.lastPlayedAt ?? 0) ||
        b.d.width * b.d.height - a.d.width * a.d.height,
    );
    return described[0]?.v;
  };

  chrome.runtime.onMessage.addListener((message: BackgroundToContent, _sender, sendResponse) => {
    switch (message.type) {
      case 'content/refresh':
        report();
        break;
      case 'content/pause-local':
        if (pauseAll(findVideos(document, true).map((f) => f.video)) > 0) schedule(100);
        break;
      case 'content/sync-start': {
        const video = pickVideo(message.videoKey);
        // Frames without a player stay silent so the frame that has one answers.
        if (!video) {
          if (window === window.top && message.videoKey === undefined) {
            sendResponse({ ok: false, reason: 'No video element was found on the page.' } satisfies SyncStartResponse);
          }
          break;
        }
        sync?.stop('replaced', null, false);
        const requestId = message.requestId;
        sync = new SyncSession(video, {
          requestId,
          deviceName: message.deviceName,
          send: (command) =>
            chrome.runtime.sendMessage({ type: 'content/remote', requestId, command } satisfies ContentRemoteMessage).catch(() => undefined),
          onLost: (reason) =>
            chrome.runtime.sendMessage({ type: 'content/sync-lost', requestId, reason } satisfies ContentSyncLostMessage).catch(() => undefined),
        });
        sendResponse({ ok: true, videoKey: videoKey(video) } satisfies SyncStartResponse);
        break;
      }
      case 'content/sync-state':
        if (sync?.requestId === message.requestId) sync.receiverState(message.state);
        break;
      case 'content/sync-stop':
        if (sync?.requestId === message.requestId) {
          sync.stop(message.reason, message.lastTime, message.wasPlaying);
          sync = null;
          schedule(100);
        }
        break;
    }
    return false;
  });

  report();
}
