# Castit

Castit is a Chrome (Manifest V3) extension that casts the **actual media stream** of a web page (HLS, DASH, MP4, WebM) to a Chromecast or Google Cast device. It never mirrors, captures or records the tab.

> **Status: Phase 5 (website as remote control).** Direct Casting works end to end. Detection covers embedded cross-origin players, MediaSource players, shadow DOM and HLS/DASH manifests. The optional local companion relays streams the Chromecast can't fetch itself, and with FFmpeg installed it converts formats the Chromecast can't play. Castit picks the cheapest method that works: direct → relay → convert. While casting, the website's own player works as the remote control.

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
- Optional, for converting formats: [FFmpeg](https://ffmpeg.org) with `ffprobe`, on your `PATH` (macOS: `brew install ffmpeg`). Tested with FFmpeg 9.0. Without it the companion still relays streams.
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
| `npm run companion` | Starts the local streaming companion (add `-- --pair` to pair another browser, `-- --help` for options, `-- --ffmpeg <path>` for a custom FFmpeg) |

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

### Format conversion with FFmpeg

When FFmpeg is installed, the companion can also make streams the Chromecast can't *decode* playable: MKV/AVI/FLV files, HEVC or AV1 on older Chromecasts, 10-bit video, Dolby/DTS audio, and so on. It always does the least work possible:

1. **Analyse.** `ffprobe` reads the stream *through the companion's own relay*, so the same SSRF guard and Referer apply. The planner then compares every stream with what your Chromecast decodes.
2. **Play as is** when everything is supported: the stream is only relayed.
3. **Remux** (no re-encoding) when the codecs are fine but the container isn't, e.g. H.264/AAC inside MKV. Video and audio are copied into HLS segments in real time or faster.
4. **Convert only what's needed.** For example, Dolby Digital 5.1 becomes stereo AAC while the video is copied.
5. **Transcode the video** to H.264 when the TV can't decode it. This uses the **hardware encoder** when one works (VideoToolbox on macOS; NVENC, QSV, AMF or VAAPI elsewhere, each verified with a test encode at startup), otherwise `libx264`. If the hardware encoder fails mid-job, it retries once in software.

Transcoded video is cut into fixed 4-second HLS segments with a keyframe forced at every boundary. That means:

- **Instant seek bar.** The *whole* playlist is published up front, so the TV shows the full duration and can seek anywhere straight away. Seeking past what has been encoded restarts FFmpeg at that point; the next segment arrives in under a second on this Mac.
- **Correct sync.** Timestamps are shifted onto the original timeline (`-output_ts_offset`) and audio is kept in sync with `aresample=async`.
- **Bounded CPU and disk.** Encoding pauses when it gets ~3 minutes ahead of playback and resumes when playback catches up; segments well behind playback are deleted.
- **Clean up.** Each job lives in a private temp folder that is deleted when the cast ends, when the companion stops (Ctrl-C), or, after a crash, on the next start.

Remuxed and live streams use FFmpeg's own growing playlist instead. Seeking ahead works as far as has been produced, which is usually all of it within seconds for a remux.

Text subtitles (SRT, ASS, WebVTT, MP4 text) are converted to WebVTT and offered to the TV. Pick them in the popup or on the controller page. Image subtitles (PGS, DVD) can't be converted to text and are skipped.

**Popup settings** (under *Local companion*, when FFmpeg is available):

- **Your Chromecast** decides what counts as playable:
  - *Any Chromecast (safest)*: H.264 ≤ 1080p, AAC/MP3/Opus/Vorbis/FLAC.
  - *Chromecast Ultra*: adds HEVC, VP9, 4K.
  - *Chromecast with Google TV*: adds Dolby Digital.
  - *Google TV Streamer*: adds AV1.
- **Conversion quality** caps the output resolution (Auto, 1080p, 720p, 480p). Lower is less CPU and less Wi-Fi.
- **Casting method → Always convert (FFmpeg)** forces conversion, which is useful for testing.

In *Automatic* mode, Castit converts up front when it already knows it must: an FLV/AVI file, an MKV, or HEVC/AV1 codecs seen in the manifest or the page's player. Otherwise, after a direct cast fails on the TV, the companion analyses the stream and converts only if that's the problem. If a plain relay also fails, it forces a conversion as a last resort.

## The website's player as a remote control

Once the TV is actually playing, the page's own video player becomes the remote. This works for ordinary HTML5 players and for embedded players in other sites' iframes, because the content script runs inside the iframe too.

- **The page goes quiet.** The page's video is paused and stays paused, so there's no double audio and nothing downloads twice. A small badge over the player shows "Casting to *TV* · Playing · 12:34 / 45:00", with its own play/pause and stop buttons.
- **Page controls drive the TV.**
  - **Play button:** the page always shows "paused", so pressing it (or the player's keyboard shortcut) toggles play/pause on the TV.
  - **Timeline:** seeking on the page seeks the TV. Dragging is coalesced into one seek.
  - **Volume, mute and speed:** forwarded to the TV.
- **The TV drives the page's timeline.** When the TV pauses, the page jumps to exactly that spot. While the TV plays, the page is only nudged when it drifts by more than 10 s (at most every 15 s), because every jump can make the page's player fetch data. When the TV finishes, the page moves to the end.
- **Casting ends.** The page is put at the TV's last position. If you disconnected while the TV was playing, the page resumes playing there (when the browser allows autoplay). Stopping or reaching the end leaves the page paused.

**How feedback loops and accidental control are avoided:**

- **Ignoring its own changes.** Every change Castit makes to the page's video (pause, jump) is recorded as *expected*, and the events it causes are ignored.
- **Requiring a real gesture.** Only actions with a real user gesture (`navigator.userActivation`) are sent to the TV. A page script calling `play()` by itself never controls the TV; it is simply paused again.
- **Not fighting.** If a page keeps restarting its player by itself (more than 6 times in 5 s), Castit stops fighting, mutes it instead, and says so in the popup.
- **Only the right frame.** The background accepts remote commands only from the exact tab and frame that was synced, for the current cast.

When no controllable player is found (e.g. the page navigated away), the popup says so. Castit's own controls (popup, controller page, `Alt+Shift+P`) always work.

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
8. **Page player as remote:** cast scenario 2 (HLS) and wait for the TV to play. The page's player should pause and show the "Casting to …" badge, and the popup should say "The page’s own player is your remote". Press the player's ▶: the TV should pause; press again: it plays. Click the page's timeline: the TV seeks there. Pause from the popup: the page's timeline jumps to the TV's position. Click **Disconnect** in the controller while the TV plays: the page continues from where the TV was.
9. **Embedded player as remote:** do the same with scenario 4 (cross-origin iframe). The popup should mention "player on 127.0.0.1".
10. **Companion pairing:** run `npm run companion`. Expand **Local companion** in the popup; it should say "Not paired". Enter the code; it should switch to "Ready".
11. **Forced relay:** set the casting method to **Always via companion** and cast scenario 1 or 2. The popup's "Now casting" line should say "via companion", and the companion terminal should log a session. Seek around: the receiver's range requests show up as playback continuing without a full download.
12. **Automatic fallback:** with **Automatic** selected, cast a stream whose host lacks CORS (try a real site). Castit either picks the companion straight away, with the reason in the candidate's notes, or retries through it after the direct load fails.
13. **Remote control:** while casting, try play/pause, seek, volume, mute and stop from the popup and from the controller page. Each should act on the TV.
14. **Service worker restart:** on `chrome://extensions`, open Castit's service worker DevTools and use **Stop**, then open the popup again. The candidates (kept in `storage.session`) and the controls should still work, because the controller reconnects on its own.
15. **Errors:** close the controller tab and press play/pause in the popup. Expect "The Castit controller page is not open…". Cast with no Chromecast on the network. Expect "No Cast devices found" or a "No compatible Cast device…" message, not a generic failure.
16. **No video:** open a page with no video. Expect "No video detected yet…".
17. **Conversion (needs FFmpeg):** with the companion running, check that the popup says "Converting with FFmpeg (hardware: videotoolbox)" or similar. Open a page with an MKV, or set **Always convert** and cast scenario 1. The popup's "Now casting" line should say "· converted" and list what is converted. Seek far ahead: playback should resume within a couple of seconds. If the file has subtitles, choose them in the Subtitles menu.
18. **Companion stopped:** stop the companion and set **Always via companion**. Casting should fail with "The local companion is not running or not paired…".
19. **Real sites:** try a few sites that embed third-party players. Note what the popup lists and whether casting works. These reports drive Phase 7.

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
- **Verified on a real Chromecast:** a DASH stream was relayed through the companion and played on the TV, so the receiver does accept media over plain `http://` from your LAN. The companion also answers Private Network Access preflights in case a receiver requires them.
- **Firewall prompt:** your OS firewall (macOS asks on first run) must allow incoming connections to Node on port 47801, or the Chromecast can't reach the relay.
- **Wrong LAN address:** if you are on a VPN or have several network adapters, the auto-detected LAN address may be one the Chromecast can't reach. Use `npm run companion -- --public-host <your-lan-ip>`.
- **Device binding on networks that change IPs:** a session is bound to one device IP. If the Chromecast changes IP mid-cast, cast again to get a new session.
- **What the Phase 4 FFmpeg test covered:** real FFmpeg 9.0 with VideoToolbox. A 2-minute 10-bit HEVC + Dolby Digital 5.1 + SRT MKV was analysed in 0.1 s and converted to H.264 1080p + AAC with WebVTT subtitles. The output played in a browser HLS player with the full duration shown, and a seek to 95 s resumed within 5 s. Seek-restarts produced the right segment in 0.7 s, timestamps stayed on the original timeline (within ~50 ms), and remux and play-as-is behaved correctly. A real public HLS stream was remuxed. Temp folders and FFmpeg processes were gone after each cast and after Ctrl-C.
- **What has not been tested for Phase 4:** conversion with a real Chromecast. The automated real-FFmpeg test only runs when FFmpeg is installed; it is skipped otherwise.
- **Seams after a seek-restart:** they can carry a timestamp jump of up to ~50 ms (audio priming); players normally absorb this.
- **DASH inputs:** these can only be converted if your FFmpeg has the DASH demuxer. Homebrew's build doesn't, so DASH streams are relayed unchanged.
- **One audio track:** only one is converted (the default). Alternative audio tracks aren't offered yet.
- **Transcoding is CPU/GPU-heavy:** at most 2 conversion jobs run at once (the oldest is stopped). Without a hardware encoder, 4K → 1080p needs a fast CPU to stay ahead of playback.
- **CORS and Referer checks** stop Direct Casting for many HLS/DASH sites. Castit detects both and uses the companion when it's paired.
- **Streams that need login cookies** fail even through the companion, because it never forwards browser cookies. Neither engine can relay tokens bound to your browser or IP; the companion keeps the same IP, so IP-bound tokens usually do work through it.
- **The probe fetches the stream URL once.** A strictly single-use URL could be used up by the probe. This is rare.
- **The master playlist is guessed until the popup inspects it**, from request order and file name. The badge count may include variant playlists until then.
- **Inspection sends extra requests without cookies.** Manifests that need cookies show as "authentication required", even though the page itself plays them.
- **Not seen:** players that fetch media from Web Workers or service workers may not be attributed to the right frame. Players using MediaSource inside workers bypass the MAIN-world hook (codecs unknown, still detected via the network).
- **Possible site conflicts:** pages that check that built-ins are unmodified (rare anti-tamper scripts) could notice the four wrapped APIs.
- **Not passed to the receiver yet:** multiple audio and subtitle tracks (they are counted).
- **Ad detection is heuristic** (URL, frame, duration, size).
- **What the Phase 5 test covered:** the sync logic is unit-tested, and a DOM test covers a simulated `<video>`. It was also checked against a real hls.js player in a browser with real mouse clicks:
  - starting the sync paused it, and a script-initiated `play()` was re-paused without reaching the TV;
  - the player's ▶ sent one toggle and its timeline sent one seek;
  - a TV "paused at 120 s" moved the page there without echoing back;
  - a disconnect resumed the page at the TV's position.
- **Verified on a real Chromecast:** the page's player as remote (play/pause and seeking from the page), handing playback back to the page after a disconnect, and an embedded cross-origin player as remote.
- **Page UI while casting:** the page's player shows "paused" the whole time. The badge shows the TV's real state.
- **Players without a `<video>` element:** players that draw on a canvas or control the TV through their own Cast integration can't be synced; use Castit's controls.
- **Players' own JavaScript APIs** (e.g. the YouTube iframe API) are not used; Castit works with the `<video>` element inside the frame.
- **Media keys and OS media controls:** these don't carry a user gesture inside the page, so they aren't forwarded.
- **Playback speed:** forwarded with the standard Cast `SET_PLAYBACK_RATE` message (0.5×–2×); support depends on the receiver.
- **Fullscreen badge:** the badge follows the player into fullscreen only when the fullscreen element contains it.
- **DRM-protected streams** (Widevine, PlayReady, FairPlay, SAMPLE-AES) are detected and refused with an explanation. Castit never extracts keys or decrypts.
- **No extension icons yet.** Chrome shows a default letter icon. Icons are planned for Phase 8.

## Roadmap

1. ✅ Extension foundation: detection, popup, Direct Cast, controller, basic remote
2. ✅ Advanced detection: frame tree, cross-origin embeds, MediaSource/EME hints, shadow DOM, manifest inspection, redirects, failure evidence, better ranking
3. ✅ Local streaming companion (Node.js): pairing, Range, HLS/DASH relay, SSRF protection, Direct → Companion fallback
4. ✅ FFmpeg: codec analysis per Chromecast type, stream copy/remux, audio-only conversion, hardware-accelerated transcoding, seekable segmented HLS, WebVTT subtitles, cleanup
5. ✅ Website as remote control: page play/seek/volume/speed → TV, TV state → page, loop prevention, embedded players, restore on cast end
6. Automatic engine selection and failure recovery
7. Compatibility testing across site categories
8. Polish, reconnection, production builds
