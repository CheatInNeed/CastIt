// Outlines a page video while the user hovers its row in the Castit popup, so it is obvious
// which player a detected stream belongs to. Drawn in a closed shadow root, never intercepts clicks.
const STYLE = `
:host { all: initial; }
.box {
  position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;
  border: 3px solid #3b82f6; border-radius: 6px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35), 0 0 18px rgba(59, 130, 246, 0.9);
  transition: all 120ms ease-out;
}
.label {
  position: absolute; top: 6px; left: 6px; padding: 3px 8px; border-radius: 999px;
  font: 600 12px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff; background: #2563eb;
}
`;

let current: { host: HTMLElement; timer: ReturnType<typeof setInterval>; expire: ReturnType<typeof setTimeout> } | null = null;

export function clearHighlight(): void {
  if (!current) return;
  clearInterval(current.timer);
  clearTimeout(current.expire);
  current.host.remove();
  current = null;
}

/** Outlines `video` (scrolling it into view) until cleared or for at most 6 s. */
export function highlightVideo(video: HTMLVideoElement): void {
  clearHighlight();
  const host = document.createElement('castit-highlight');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Castit: this video';
  box.append(label);
  root.append(style, box);
  (document.fullscreenElement ?? document.documentElement).appendChild(host);

  const rect = video.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) video.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const place = () => {
    const r = video.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    box.style.display = visible ? 'block' : 'none';
    // A hidden video (zero size) gets no outline; the popup says so instead.
    Object.assign(box.style, { top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  };
  place();
  current = { host, timer: setInterval(place, 100), expire: setTimeout(clearHighlight, 6000) };
}
