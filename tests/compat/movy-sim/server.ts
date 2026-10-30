// A local stand-in for aggregator streaming sites (movy.sx-like architecture), for testing Castit
// without visiting such sites:
//
//   site   (:47970)  aggregator page: pop-up ad overlay, ad iframe, and the player embedded from …
//   player (:47971)  … a separate player host: click-to-play, skippable pre-roll ad, then an API call
//                    returns the (base64-obfuscated) signed stream URL, played with hls.js
//   cdn    (:47972)  protected video server: signed, expiring paths; Referer must be the player host
//                    (hotlink protection); CORS only for the player host. It relays a public test
//                    stream, so nothing copyrighted is involved.
//
// Every refusal is logged, so the Chromecast's direct attempt (rejected) and the Castit companion's
// relayed attempt (accepted, it sends the player's Referer) are visible in the terminal.
import { createHmac, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

export interface SimOptions {
  /** Address pages use for the other origins (the Chromecast must reach the CDN for the direct attempt). */
  host: string;
  listenHost?: string;
  ports?: { site: number; player: number; cdn: number };
  /** HLS folder that is relayed (must contain the master playlist). */
  upstream?: string;
  master?: string;
  adClip?: string;
  /** How long signed stream URLs stay valid. */
  ttlSeconds?: number;
  log?: (line: string) => void;
}

export interface RunningSim {
  site: string;
  player: string;
  cdn: string;
  signedMaster(expires?: number): string;
  close(): Promise<void>;
}

const DEFAULTS = {
  upstream: 'https://test-streams.mux.dev/x36xhzz/',
  master: 'x36xhzz.m3u8',
  adClip: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:dark}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0d0f14;color:#e5e7eb}a{color:#60a5fa}
.wrap{max-width:960px;margin:0 auto;padding:20px}.card{background:#161a22;border:1px solid #2a2f3a;border-radius:10px;padding:16px;margin:12px 0}
iframe{border:0;display:block}.muted{color:#9ca3af;font-size:13px}</style></head><body>${body}</body></html>`;

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/** Streams an upstream response through, passing Range and the media headers. */
async function relay(req: IncomingMessage, res: ServerResponse, url: string, extra: Record<string, string> = {}): Promise<void> {
  const upstream = await fetch(url, { headers: req.headers.range ? { range: String(req.headers.range) } : {} });
  const headers: Record<string, string> = { ...extra };
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body || req.method === 'HEAD') return void res.end();
  Readable.fromWeb(upstream.body as never).pipe(res);
}

export async function startSim(options: SimOptions): Promise<RunningSim> {
  const opts = { ...DEFAULTS, ttlSeconds: 600, ...options };
  const log = opts.log ?? ((line: string) => console.log(line));
  const secret = randomBytes(16);
  const sig = (expires: number) => createHmac('sha256', secret).update(String(expires)).digest('hex').slice(0, 20);
  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve) => server.listen(port, opts.listenHost ?? '0.0.0.0', () => resolve((server.address() as AddressInfo).port)));

  const origins = { site: '', player: '', cdn: '' };
  const signedMaster = (expires = Math.floor(Date.now() / 1000) + opts.ttlSeconds) =>
    `${origins.cdn}/hls/${expires}-${sig(expires)}/${opts.master}`;

  // ------------------------------------------------------------ aggregator site
  const site = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') {
      return send(res, 200, page('MovieHub (Castit test site)', `<div class="wrap"><h1>MovieHub</h1><p class="muted">A local stand-in for aggregator streaming sites, for testing Castit.</p>
<div class="card"><h2>Big Buck Bunny (2008)</h2><p>Open source animated short.</p><a href="/watch/1">▶ Watch</a></div></div>`));
    }
    if (path === '/watch/1') {
      return send(res, 200, page('Watch Big Buck Bunny – MovieHub', `<div class="wrap"><h1>Big Buck Bunny</h1>
<div id="popup" class="card" style="position:fixed;right:16px;bottom:16px;width:280px;z-index:9;border-color:#b45309">
 <b>Special offer!</b><p class="muted">A fake pop-up ad, like aggregator sites show.</p><button onclick="this.parentNode.remove()">Close</button></div>
<div class="card"><iframe src="${origins.player}/e/1" allow="autoplay; fullscreen" allowfullscreen style="width:100%;aspect-ratio:16/9"></iframe></div>
<div class="card"><p class="muted">Advertisement</p><iframe src="/ads/frame" style="width:300px;height:170px"></iframe></div></div>`));
    }
    if (path === '/ads/frame') {
      return send(res, 200, page('ad', `<video src="${origins.cdn}/ads/preroll.mp4" autoplay muted loop playsinline style="width:300px;height:169px;background:#000"></video>`));
    }
    send(res, 404, 'Not found');
  });

  // ------------------------------------------------------------ player host
  const player = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/e/1') {
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Player</title>
<style>html,body{margin:0;height:100%;background:#000;font:600 14px system-ui,sans-serif;color:#fff}video{width:100%;height:100%;display:block}
#start{position:absolute;inset:0;margin:auto;width:150px;height:52px;font:inherit;cursor:pointer}
#skip{position:absolute;right:12px;bottom:48px;padding:6px 10px;display:none}#adlabel{position:absolute;left:12px;top:10px;display:none}</style></head>
<body><video id="v" controls playsinline></video><button id="start">▶ Play</button><button id="skip">Skip ad</button><span id="adlabel">Ad</span>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script>
const v = document.getElementById('v'), skip = document.getElementById('skip'), label = document.getElementById('adlabel');
async function main() {
  label.style.display = skip.style.display = 'none'; v.removeEventListener('ended', main);
  // The stream URL comes from an API, obfuscated, like many embed hosts do.
  const { file } = await (await fetch('/api/source/1')).json();
  const hls = new Hls(); hls.loadSource(atob(file)); hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
}
document.getElementById('start').onclick = (e) => {
  e.currentTarget.remove();
  v.src = '${origins.cdn}/ads/preroll.mp4'; label.style.display = 'block';
  setTimeout(() => (skip.style.display = 'block'), 3000);
  v.addEventListener('ended', main); v.play().catch(() => {});
};
skip.onclick = main;
</script></body></html>`);
    }
    if (path === '/api/source/1') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ file: Buffer.from(signedMaster()).toString('base64') }));
    }
    send(res, 404, 'Not found');
  });

  // ------------------------------------------------------------ protected CDN
  const cdn = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const who = `ua=${String(req.headers['user-agent'] ?? '').slice(0, 40)}`;
      if (url.pathname === '/ads/preroll.mp4') return relay(req, res, opts.adClip);

      const m = /^\/hls\/(\d+)-([0-9a-f]{20})\/(.+)$/.exec(url.pathname);
      if (!m) return send(res, 404, 'Not found');
      const origin = req.headers.origin;
      const cors: Record<string, string> =
        origin === origins.player ? { 'access-control-allow-origin': origins.player, vary: 'Origin' } : { vary: 'Origin' };
      if (req.method === 'OPTIONS') return send(res, 204, '', { ...cors, 'access-control-allow-headers': 'range' });

      const expires = Number(m[1]);
      if (m[2] !== sig(expires)) {
        log(`[cdn] 403 bad signature  ${who}`);
        return send(res, 403, 'Bad signature', cors);
      }
      if (expires * 1000 < Date.now()) {
        log(`[cdn] 410 link expired  ${who}`);
        return send(res, 410, 'Link expired', cors);
      }
      const referer = String(req.headers.referer ?? '');
      if (!referer.startsWith(`${origins.player}/`)) {
        log(`[cdn] 403 hotlink protection (referer=${referer || 'none'}, origin=${origin ?? 'none'})  ${who}`);
        return send(res, 403, 'Hotlink protection', cors);
      }
      if (m[3]!.endsWith('.m3u8')) log(`[cdn] 200 ${m[3]} (referer ok, origin=${origin ?? 'none'})  ${who}`);
      await relay(req, res, opts.upstream + m[3] + url.search, cors);
    })().catch((e: Error) => {
      log(`[cdn] relay error: ${e.message}`);
      if (!res.headersSent) send(res, 502, 'Upstream error');
      else res.destroy();
    });
  });

  const ports = opts.ports ?? { site: 47970, player: 47971, cdn: 47972 };
  const hostPart = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  origins.site = `http://${hostPart}:${await listen(site, ports.site)}`;
  origins.player = `http://${hostPart}:${await listen(player, ports.player)}`;
  origins.cdn = `http://${hostPart}:${await listen(cdn, ports.cdn)}`;

  return {
    ...origins,
    signedMaster,
    close: async () => {
      for (const s of [site, player, cdn]) s.closeAllConnections();
      await Promise.all([site, player, cdn].map((s) => new Promise((r) => s.close(r))));
    },
  };
}
