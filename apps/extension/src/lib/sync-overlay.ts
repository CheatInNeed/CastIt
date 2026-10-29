// Small "Casting to …" badge drawn over the page's player while it acts as a remote.
// Lives in a closed shadow root so page CSS can't restyle it and it can't restyle the page.
// Only the badge itself takes pointer events; it follows the video on scroll/resize and moves
// into the fullscreen element when the player goes fullscreen.
import { formatTime, PHASE_LABELS, type SyncReceiverState } from '@castit/shared';

const STYLE = `
:host { all: initial; }
.badge {
  position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
  max-width: 360px; padding: 5px 6px 5px 10px; border-radius: 999px;
  font: 600 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff;
  background: rgba(17, 24, 39, 0.82); box-shadow: 0 2px 10px rgba(0,0,0,.35);
  pointer-events: auto; user-select: none; backdrop-filter: blur(6px);
}
.text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { opacity: .75; font-weight: 500; }
button {
  all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 50%;
  display: grid; place-items: center; background: rgba(255,255,255,.15); font-size: 11px;
}
button:hover { background: rgba(255,255,255,.3); }
button:focus-visible { outline: 2px solid #60a5fa; }
`;

export interface OverlayHandlers {
  togglePlay(): void;
  stop(): void;
}

export class SyncOverlay {
  private readonly host: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly text: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly video: HTMLVideoElement;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onLayout = () => this.position();
  private readonly onFullscreen = () => this.attach();

  constructor(video: HTMLVideoElement, handlers: OverlayHandlers) {
    this.video = video;
    this.host = document.createElement('castit-overlay');
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.badge = document.createElement('div');
    this.badge.className = 'badge';
    this.badge.setAttribute('role', 'status');
    this.text = document.createElement('span');
    this.text.className = 'text';
    this.playButton = document.createElement('button');
    this.playButton.title = 'Play/pause on the TV';
    this.playButton.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.togglePlay();
    });
    const stop = document.createElement('button');
    stop.textContent = '■';
    stop.title = 'Stop casting';
    stop.setAttribute('aria-label', 'Stop casting');
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.stop();
    });
    this.badge.append(this.text, this.playButton, stop);
    root.append(style, this.badge);

    this.attach();
    window.addEventListener('scroll', this.onLayout, { capture: true, passive: true });
    window.addEventListener('resize', this.onLayout, { passive: true });
    document.addEventListener('fullscreenchange', this.onFullscreen);
    // Players move/resize without scroll events (theatre mode, SPA layouts).
    this.timer = setInterval(this.onLayout, 1000);
    this.update(null);
  }

  /** In fullscreen only the fullscreen element is visible, so the badge must live inside it. */
  private attach(): void {
    const parent = document.fullscreenElement ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
    this.position();
  }

  private position(): void {
    const rect = this.video.getBoundingClientRect();
    const visible = rect.width > 80 && rect.height > 45 && rect.bottom > 0 && rect.top < window.innerHeight;
    this.badge.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    this.badge.style.top = `${Math.max(8, rect.top + 10)}px`;
    this.badge.style.left = `${Math.max(8, rect.left + 10)}px`;
  }

  update(state: SyncReceiverState | null, deviceName?: string): void {
    const device = state?.deviceName ?? deviceName ?? 'TV';
    const phase = state ? (PHASE_LABELS[state.phase] ?? state.phase) : 'Starting…';
    const time = state && !state.live ? ` · ${formatTime(state.currentTime)}${state.duration ? ` / ${formatTime(state.duration)}` : ''}` : '';
    this.text.innerHTML = '';
    const strong = document.createElement('span');
    strong.textContent = `Casting to ${device}`;
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = ` · ${phase}${time}`;
    this.text.append(strong, dim);
    const playing = state?.phase === 'playing' || state?.phase === 'buffering';
    this.playButton.textContent = playing ? '❚❚' : '▶';
    this.playButton.setAttribute('aria-label', playing ? 'Pause on TV' : 'Play on TV');
  }

  destroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('scroll', this.onLayout, { capture: true });
    window.removeEventListener('resize', this.onLayout);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.host.remove();
  }
}
