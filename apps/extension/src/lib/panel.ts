// Castit's panel over the page (top frame only): the popup page in an iframe. Unlike Chrome's
// popup window, an element in the page can have rounded corners and blur what is behind it.
// The iframe lives in a closed shadow root so page styles can't reach it; the token in its URL
// lets the popup page refuse to render when a website embeds it on its own.

let host: HTMLElement | null = null;
let frame: HTMLIFrameElement | null = null;

export function togglePanel(token: string): void {
  if (host) return closePanel();
  host = document.createElement('castit-panel');
  host.style.cssText = 'all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;';
  frame = document.createElement('iframe');
  frame.src = `${chrome.runtime.getURL('popup/index.html')}#panel=${encodeURIComponent(token)}`;
  frame.allow = 'clipboard-write';
  frame.title = 'Castit';
  frame.style.cssText = [
    'display: block',
    'width: 340px',
    'height: 120px',
    'max-height: calc(100vh - 24px)',
    'border: 0',
    'border-radius: 18px',
    'background: transparent',
    // Must match the panel page's scheme, or Chrome paints the iframe opaque.
    'color-scheme: light dark',
    'backdrop-filter: blur(28px) saturate(170%)',
    '-webkit-backdrop-filter: blur(28px) saturate(170%)',
    'box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(0, 0, 0, 0.18)',
    'transition: height 0.12s ease-out',
  ].join(';');
  host.attachShadow({ mode: 'closed' }).append(frame);
  (document.fullscreenElement ?? document.documentElement).append(host);
  window.addEventListener('message', onMessage);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

export function closePanel(): void {
  window.removeEventListener('message', onMessage);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  host?.remove();
  host = null;
  frame = null;
}

function onMessage(event: MessageEvent): void {
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data as { castitPanel?: string; height?: number } | null;
  if (data?.castitPanel === 'close') closePanel();
  else if (data?.castitPanel === 'size' && typeof data.height === 'number') frame.style.height = `${Math.ceil(data.height)}px`;
}

/** Clicks inside the panel happen in the iframe; any click the page itself sees is outside. */
function onOutside(event: PointerEvent): void {
  if (host && !event.composedPath().includes(host)) closePanel();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePanel();
}
