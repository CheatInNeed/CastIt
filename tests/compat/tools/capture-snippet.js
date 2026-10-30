// Capture snippet for compatibility fixtures. Run in the page (top frame of the player) after
// playback has started; it returns a compact JSON capture of what Castit's network observer and
// content script would have seen. Long runs of segments are trimmed to a few examples per series,
// and very long query strings are shortened, to keep fixtures small.
(() => {
  const media = /\.(m3u8|mpd|mp4|m4s|m4v|m4a|ts|webm|aac|mp3|mkv|ogv|mov|cmfv|cmfa)(\?|$)|videoplayback|\/range\/|manifest|playlist|master|chunklist|segment|\/hls\/|\/dash\//i;
  const series = new Map();
  const seen = new Set();
  const requests = [];
  for (const e of performance.getEntriesByType('resource')) {
    if (!/^https?:/.test(e.name) || seen.has(e.name) || !media.test(e.name)) continue;
    seen.add(e.name);
    const u = new URL(e.name);
    // Series = same folder and name except the final running number (as Castit groups them).
    const key = u.host + u.pathname.replace(/\d+(?=\.[a-z0-9]+$)/i, '#');
    const n = (series.get(key) ?? 0) + 1;
    series.set(key, n);
    if (n > 4) continue;
    const url = e.name.length > 600 ? e.name.slice(0, 600) : e.name;
    requests.push({ url, type: e.initiatorType, at: Math.round(e.startTime) });
    if (requests.length >= 80) break;
  }
  const videos = [...document.querySelectorAll('video')].map((v, i) => {
    const r = v.getBoundingClientRect();
    const src = v.currentSrc || v.getAttribute('src') || undefined;
    return {
      key: `v${i + 1}`, src, sources: [...v.querySelectorAll('source')].map((s) => s.src).filter(Boolean),
      isBlob: (!!src && src.startsWith('blob:')) || (!!v.srcObject && !src), paused: v.paused, ended: v.ended,
      currentTime: Math.round(v.currentTime), duration: Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null,
      live: v.duration === Infinity, width: Math.round(r.width), height: Math.round(r.height),
      videoWidth: v.videoWidth, videoHeight: v.videoHeight, poster: v.poster || undefined, muted: v.muted,
      readyState: v.readyState, error: v.error ? v.error.code : null,
      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight, inShadowRoot: false, mseMimeTypes: [],
    };
  });
  const trimmed = [...series.entries()].filter(([, n]) => n > 4).map(([k, n]) => `${k} ×${n}`);
  return { pageUrl: location.href, iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter((s) => /^https?:/.test(s)).slice(0, 10), requests, trimmed, videos };
})()
