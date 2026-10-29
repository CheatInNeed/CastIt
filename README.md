# Castit

Castit is a Chrome (Manifest V3) extension that casts the **actual media stream** of a web page (HLS, DASH, MP4, WebM) to a Chromecast or Google Cast device. It never mirrors, captures or records the tab.

> **Status: Phase 3 (local streaming companion).** Direct Casting works end to end. Detection covers embedded cross-origin players, MediaSource players, shadow DOM and HLS/DASH manifests. An optional local companion relays streams the Chromecast can't fetch itself, and Castit switches to it automatically when Direct Casting fails. FFmpeg transcoding and page-player synchronisation come in later phases (see the roadmap below).

## How it works

```
 web page ──(webRequest + content script)──► extension background ──(port)──► controller page ──(Cast SDK)──► Chromecast
                                                   ▲      │                                                       │
                                     popup ────────┘      │ (optional, localhost API)              Direct: fetches the stream itself
                                                          ▼                                        Companion: fetches via your computer
                                                 local companion (Node) ◄──────── LAN media URL ─────────────────┘
                                                          │
                                                          └── fetches the real stream bytes upstream (never screen capture)
```

| Part | Path | Role |
|---|---|---|
| Extension | `apps/extension` | Detects media, ranks candidates, checks castability, popup UI and remote controls |
| Controller | `apps/controller` | Small web page that hosts the Google Cast Web Sender SDK and talks to the Chromecast |
| Companion | `apps/companion` | Optional Node.js relay: streams media bytes from the source to the Chromecast over your LAN |
| Shared | `packages/shared` | Types, the message protocol and the companion API contract |
| Tests | `tests/` | Vitest unit tests, DOM tests (happy-dom), mock-media-server integration tests, companion end-to-end tests, and a manual test page |

### Why a separate controller page?

MV3 forbids remotely hosted code in extensions, and the Cast Web Sender SDK can only be loaded from `gstatic.com`. So the SDK runs in an ordinary web page (`http://localhost:5173` during development, any static HTTPS host in production). That page connects to the extension with `chrome.runtime.connect(extensionId)`, which Chrome allows only for origins listed in the extension's `externally_connectable`. The extension also checks the sender origin and a random pairing token that it passes in the URL fragment when it opens the controller.

Chrome only opens its Cast device picker in response to a click on the page that requested it. The first cast in a browser session therefore takes **two clicks**: **Cast** in the popup, then **Choose Cast device** on the controller page. After that, while the session lasts, casting from the popup loads the new stream straight away.

## Requirements

- Google Chrome 116 or later (desktop)
- Node.js 22.18 or later (tested with Node 25) and npm. The companion runs its TypeScript directly with Node's built-in type stripping.
- A Chromecast / Google Cast device on the same network, for real casting

## Install and run (development)

```bash
npm install
```

```bash
npm run build
```

Then:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `apps/extension/dist`.
2. Start the controller page and leave it running:

   ```bash
   npm run dev:controller
   ```

3. Optional: serve the manual test page on http://localhost:5174 (it binds to `127.0.0.1` so the page can embed itself cross-origin from `http://127.0.0.1:5174`):

   ```bash
   npm run dev:testpage
   ```

To rebuild the extension on every change, run `npm run dev:extension` and click the reload icon on `chrome://extensions` after each rebuild.

### Production controller URL

The controller URL is fixed when the extension is built, because `externally_connectable` must be in the manifest:

```bash
CASTIT_CONTROLLER_URL="https://<user>.github.io/castit/" npm run build
```

Deploy `apps/controller/dist` to that URL. The build uses relative asset paths, so it works from a sub-path.

### Scripts

| Command | What it does |
|---|---|
| `npm test` | Runs the unit and integration tests (Vitest) |
| `npm run typecheck` | Type-checks all packages |
| `npm run build` | Builds the extension (`apps/extension/dist`) and the controller (`apps/controller/dist`) |
| `npm run dev:controller` | Starts the controller on http://localhost:5173 |
| `npm run dev:extension` | Rebuilds the extension on every change |
| `npm run dev:testpage` | Serves `tests/manual` on http://localhost:5174 |
| `npm run companion` | Starts the local streaming companion (add `-- --pair` to pair another browser, `-- --help` for options) |

## The local streaming companion (optional)

Direct Casting hands the Chromecast the stream URL. That fails when the Chromecast isn't allowed to fetch the stream itself. The two most common reasons:

- The stream host sends no CORS headers, which the Chromecast's HLS/DASH player requires.
- The stream host checks the `Referer`/`Origin` of the embedding player (hotlink protection).

The companion is a small Node.js server on your computer. The Chromecast fetches the media from it, and it fetches the real stream bytes upstream with the right `Referer`/`Origin`, adding CORS headers on the way. Media is relayed, not recorded or captured: nothing is written to disk, and nothing is decoded or re-encoded.

```bash
npm run companion
```

It prints a pairing code. Open the Castit popup, expand **Local companion**, enter the code and click **Pair**. Pairing is remembered on both sides, so later runs need no code.

**Casting method** (in the same section):

- **Automatic** (default): Direct, but uses the companion straight away when Castit already knows it's needed (no CORS, or HTTP 401/403 without the page's Referer). If a direct cast fails on the receiver (load failed, segment failure, or no playback within 30 s), Castit retries once through the companion. The popup then says "Retrying through the local companion…".
- **Direct only** / **Always via companion**: force one engine.

### How it works

- Media URLs mirror the upstream URL: `http://<lan-ip>:47801/m/<session>/<scheme>/<host>/<path>?<query>`. Relative references in manifests (segments, variants, DASH templates) therefore resolve to proxied URLs with no rewriting. Absolute references are rewritten: HLS lines and `URI="…"` attributes; DASH `BaseURL`, `Location`, `media`, `initialization`, `sourceURL`. Query strings (signatures) are kept exactly.
- `Range` requests are passed through, so seeking in large MP4s never downloads the whole file. Bytes are piped, never buffered; only manifests (≤ 10 MB) are read into memory.
- Upstream redirects are returned to the receiver as *proxied* redirects, so relative URLs resolve against the final location.
- When the receiver disconnects (seek, stop), the upstream request is aborted at once. Sessions expire after 30 minutes idle (12 hours at most). Replacing or ending a cast deletes its session.
- Manifests served with generic content types are detected by sniffing their first bytes; gzip/deflate/brotli are decoded.

### Security model

| Concern | What the companion does |
|---|---|
| Who can control it | The control API listens on `127.0.0.1:47800` only. It requires an API key obtained by pairing: a 6-digit code shown in the terminal, valid for 10 minutes and 5 attempts. Keys are stored only as SHA-256 hashes in `~/.castit/companion.json` (mode 0600). |
| Web pages attacking localhost | Requests carrying a web-page `Origin`, or a `Host` other than the loopback address (DNS rebinding), are refused. No CORS is offered on the control API. |
| Who can fetch media | Each cast gets a random 192-bit session id in its URLs. The session is bound to the first device that uses it (the Chromecast); other devices on the LAN get 403. Requests from this computer never claim the binding. |
| SSRF / open proxy | Upstreams must be http(s) with no embedded credentials. Private, loopback, link-local, CGNAT, multicast and reserved addresses are blocked, both as IP literals and *after DNS resolution*: the checked address is the one connected to, which defeats DNS rebinding. A session can only fetch from hosts its own manifests or redirects referred to. `--allow-private` lifts the address check for LAN media servers and is off by default. |
| Credentials | The only upstream context accepted is `Referer`, `Origin` and `User-Agent`. Cookies, `Authorization` and other headers are never forwarded, whether they come from the receiver or the extension. Upstream `Set-Cookie` is never passed on. |
| Local files | There is no file serving and no `file:` upstreams. |
| Leaking URLs | Logs and session listings strip query strings (signatures). |

The companion does not bypass DRM, logins or paywalls. If the upstream refuses it (HTTP 401/403) even with the page's Referer, Castit reports "authentication required".

## Using it

1. Open a page with a video and start playing it. The toolbar badge shows how many castable streams Castit found.
2. Click the Castit icon (or press **Alt+Shift+C**). The best candidate is pre-selected. Each candidate shows its format, quality, host and a castability rating.
3. Click **Cast**. Castit fetches the stream once without cookies to check it (expired URL? DRM? CORS? live or VOD? TS or fMP4 segments?), then hands it to the controller.
4. On the controller tab, click **Choose Cast device** and pick your Chromecast.
5. When the TV is actually playing, Castit pauses the video on the page. If you were part-way through a VOD video, the TV starts from the same position.
6. Control playback from the popup (play/pause, ±10/30 s, seek, volume, mute, stop) or from the controller page. **Alt+Shift+P** toggles play/pause.

## Manual test checklist

With `npm run dev:controller` and `npm run dev:testpage` running and the extension loaded (reload it on `chrome://extensions` after each build). Open http://localhost:5174, and reload the page between scenarios for a clean list. Each section of the page also states what to expect.

1. **Progressive MP4 (redirected):** play video 1 and open the popup. Expect one `big_buck_bunny_720p_surround.mp4` candidate (FILE · MP4 · 360p · PLAYING · Castable). It is the archive.org URL, not its `dn….archive.org` redirect target. Cast it. Expect the TV to start from about the same position and the page's video to pause.
2. **HLS through MediaSource:** play video 2 and open the popup. The first time, several `.m3u8` entries may appear; within a second the popup inspects the master and leaves one: HLS · N qualities · 1080p · H.264 · Castable.
3. **DASH through MediaSource:** play video 3. Expect one DASH candidate linked to the playing player.
4. **Cross-origin embedded player:** press ▶ inside the iframe (scenario 4). Expect the HLS candidate to read "… · in player 127.0.0.1".
5. **Dynamic player:** click "Insert player in 1.5 s" with the popup open. The Sintel MP4 should appear without reopening the popup.
6. **Closed shadow root:** play scenario 6. The Sintel trailer must be detected, even though the page's own scripts cannot see that video.
7. **Ad-like clip and broken source:** scenario 7 ranks low (short clip, small player, tiny file). Scenario 8 is listed as "Unlikely" with "The page's own player could not load this URL…", and is never pre-selected.
8. **Companion pairing:** run `npm run companion`. Expand **Local companion** in the popup; it should say "Not paired". Enter the code; it should switch to "Ready".
9. **Forced relay:** set the casting method to **Always via companion** and cast scenario 1 or 2. The popup's "Now casting" line should say "via companion", and the companion terminal should log a session. Seek around: the receiver's range requests show up as playback continuing without a full download.
10. **Automatic fallback:** with **Automatic** selected, cast a stream whose host lacks CORS (try a real site). Castit either picks the companion straight away, with the reason in the candidate's notes, or retries through it after the direct load fails.
11. **Remote control:** while casting, try play/pause, seek, volume, mute and stop from the popup and from the controller page. Each should act on the TV.
12. **Service worker restart:** on `chrome://extensions`, open Castit's service worker DevTools and use **Stop**, then open the popup again. The candidates (kept in `storage.session`) and the controls should still work, because the controller reconnects on its own.
13. **Errors:** close the controller tab and press play/pause in the popup. Expect "The Castit controller page is not open…". Cast with no Chromecast on the network. Expect "No Cast devices found" or a "No compatible Cast device…" message, not a generic failure.
14. **No video:** open a page with no video. Expect "No video detected yet…".
15. **Companion stopped:** stop the companion and set **Always via companion**. Casting should fail with "The local companion is not running or not paired…".
16. **Real sites:** try a few sites that embed third-party players. Note what the popup lists and whether casting works. These reports drive Phase 7.

## Design notes

- **No tab capture anywhere.** The manifest has no `tabCapture` or `desktopCapture`. The Chromecast fetches and decodes the stream itself.
- **Detection runs on two paths.** `chrome.webRequest.onResponseStarted` (observe-only, non-blocking) sees every media response from any frame, including cross-origin player iframes, with its tab and frame ID. The content script runs in all frames and reports `<video>` elements: source, playing state, size, poster and duration. A `blob:` source is treated as a sign of MediaSource playback, never as a castable URL. The manifest that feeds it is then found among the network candidates of the same frame.
- **Service-worker safe.** All state is in `chrome.storage.session`, and each tab's read-modify-write is serialised so concurrent events can't overwrite each other. A page navigation clears the tab, and a sub-frame navigation clears that frame. Only the controller port lives in memory, and the controller reconnects with backoff whenever the worker restarts.
- **Ranking is pure and deterministic** (`lib/rank.ts`). Points go to: the playing video, HLS/DASH manifests over single files, the first playlist requested (usually the master), large players, and higher resolution. Points come off for ads, short clips, tiny files and audio-only streams. Segments are excluded. Duplicate URLs are compared with signing and cache-buster parameters removed, but the original URL is always the one that gets cast.
- **The probe never sends cookies** (`credentials: 'omit'`). That keeps your credentials private, and it approximates what the Chromecast will see, since it has no cookies either.
- **Detection doesn't prove casting works.** A cast counts as successful only once the receiver reports `PLAYING`. If the stream fails to load, errors out, or doesn't start within 30 seconds, the error says which.

### Phase 2 additions

- **Frame tree.** Every `sub_frame` navigation records its parent frame (from `webRequest`, so no extra permission is needed). A frame that navigates is cleared together with every frame nested inside it. Streams are associated with a MediaSource player in the same frame first, then in a parent or child frame, so nested third-party embeds work. Streams requested from an ad frame (such as the IMA SDK iframe) or by an ad initiator are marked as ads.
- **MAIN-world hooks** (`src/main-world.ts`, about 1 KB, `document_start`, every frame). Content scripts can't see the page's JavaScript objects, so a tiny script in the page's own world wraps four APIs, calling the original every time:
  - `URL.createObjectURL` and `MediaSource.addSourceBuffer` link a `blob:` URL to its player and record its codecs (e.g. `avc1.64001f`).
  - `MediaKeySystemAccess.createMediaKeys` and `HTMLMediaElement.setMediaKeys` report the key system only when a player actually attaches DRM. Players often probe for DRM support on clear content, so a probe alone is not counted. No keys or licence data are read.
  - `attachShadow` is a cue to rescan for videos.

  Hints reach the content script as JSON `CustomEvent`s. A page could forge them, which would only change how Castit describes that page's own media.
- **Shadow DOM.** Shadow roots, open and closed, are searched with `chrome.dom.openOrClosedShadowRoot`, and each one gets its own media-event listeners and MutationObserver. Pages without shadow DOM stay on the cheap shallow scan.
- **Manifest inspection.** When the popup opens, the worker fetches the tab's not-yet-inspected HLS/DASH manifests, oldest first and without cookies. That gives master or media role, number of qualities, top resolution, codecs, live or VOD, audio and subtitle tracks, DRM and CORS. Variant and rendition playlists of a known master are then hidden. This happens only on demand, never just because a page loaded.
- **Redirects.** The URL the page asked for is kept and cast (the Chromecast follows redirects). The final URL is used to match it with the `<video>` element.
- **Failures count as evidence.** Media responses with HTTP ≥ 400 and `<video>` load errors (`MediaError`) are recorded. Streams that only failed are dropped. A player whose own source failed is shown as "Unlikely" with the reason.
- **SPA navigation.** A history-API URL change marks older, non-playing streams as "from before the page navigated" and ranks them lower.
- **Popup** shows quality, number of qualities, LIVE, codec (H.264/HEVC/AV1/VP9), AD, the embedding player's host, and DRM/CORS notes before you click Cast.

## Known limitations

- **What has been tested:** Phase 1 casting was tested by the user and works. Phase 2's detection is unit-tested, and its MAIN-world hooks were checked against real hls.js playback in a browser.
- **What the Phase 3 companion test covered:** end-to-end tests against a mock upstream (pairing, auth, relay, Range, redirects, cancellation, device binding, SSRF). Real public HLS was relayed and played back in a cross-origin hls.js player (1080p, no errors).
- **What has not been tested:** the companion with a real Chromecast. The receiver loads media over plain `http://` from your LAN; Cast devices normally allow this, but it is unverified. The companion answers Private Network Access preflights in case the receiver requires them.
- **Firewall prompt:** your OS firewall (macOS asks on first run) must allow incoming connections to Node on port 47801, or the Chromecast can't reach the relay.
- **Wrong LAN address:** if you are on a VPN or have several network adapters, the auto-detected LAN address may be one the Chromecast can't reach. Use `npm run companion -- --public-host <your-lan-ip>`.
- **Device binding on networks that change IPs:** a session is bound to one device IP. If the Chromecast changes IP mid-cast, cast again to get a new session.
- **CORS and Referer checks** stop Direct Casting for many HLS/DASH sites. Castit detects both and uses the companion when it's paired.
- **Streams that need login cookies** fail even through the companion, because it never forwards browser cookies. Neither engine can relay tokens bound to your browser or IP; the companion keeps the same IP, so IP-bound tokens usually do work through it.
- **The probe fetches the stream URL once.** A strictly single-use URL could be used up by the probe. This is rare.
- **The master playlist is guessed until the popup inspects it**, from request order and file name. The badge count may include variant playlists until then.
- **Inspection sends extra requests without cookies.** Manifests that need cookies show as "authentication required", even though the page itself plays them.
- **Not seen:** players that fetch media from Web Workers or service workers may not be attributed to the right frame. Players using MediaSource inside workers bypass the MAIN-world hook (codecs unknown, still detected via the network).
- **Possible site conflicts:** pages that check that built-ins are unmodified (rare anti-tamper scripts) could notice the four wrapped APIs.
- **Not passed to the receiver yet:** multiple audio and subtitle tracks (they are counted).
- **Ad detection is heuristic** (URL, frame, duration, size).
- **The page's own player is only paused** when the TV starts. Two-way synchronisation is Phase 5.
- **DRM-protected streams** (Widevine, PlayReady, FairPlay, SAMPLE-AES) are detected and refused with an explanation. Castit never extracts keys or decrypts.
- **No extension icons yet.** Chrome shows a default letter icon. Icons are planned for Phase 8.

## Roadmap

1. ✅ Extension foundation: detection, popup, Direct Cast, controller, basic remote
2. ✅ Advanced detection: frame tree, cross-origin embeds, MediaSource/EME hints, shadow DOM, manifest inspection, redirects, failure evidence, better ranking
3. ✅ Local streaming companion (Node.js): pairing, Range, HLS/DASH relay, SSRF protection, Direct → Companion fallback
4. FFmpeg: codec detection, stream copy and transcoding
5. Page-player ↔ Chromecast synchronisation
6. Automatic engine selection and failure recovery
7. Compatibility testing across site categories
8. Polish, reconnection, production builds
