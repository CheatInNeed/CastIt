# Architecture

```
 web page ──(webRequest + content script)──► extension background ──(native messaging)──► helper (Node) ──(Cast protocol)──► TV
                                                   ▲                                         │   ▲                            │
                              Castit panel ────────┘                                         │   └── LAN media URL ───────────┤ relayed / converted
                                                                                             │                                │
                                                                                             └── fetches the real stream ◄────┘ direct: TV fetches it itself
```

| Part | Path | Role |
|---|---|---|
| Extension | `apps/extension` | Detects media, ranks candidates, checks castability, the Castit panel and remote controls |
| Helper (companion) | `apps/companion` | Finds TVs (mDNS), casts to them over the Cast protocol, relays and converts streams the TV can't fetch or play itself |
| Shared | `packages/shared` | Types and the message protocols |
| Tests | `tests/` | Vitest unit tests, DOM tests (happy-dom), a fake Cast TV, companion end-to-end tests, and a manual test page |

## Why a helper instead of the Cast SDK?

Chrome extensions may not run code downloaded from the internet, and Google's Cast sender library only exists as a script on Google's servers. Earlier versions therefore ran it in a separate web page. Castit now speaks the Cast protocol itself from a small Node.js helper. Chrome starts it through **native messaging** when the extension connects, and stops it when it's idle; only the Castit extension is allowed to start it. That removes the controller page, the device-picker click and the pairing code.

## Why a panel over the page?

Chrome's toolbar popup is an opaque native window. Castit instead shows its panel inside the page (its own page in an iframe, isolated in a closed shadow root), so it can have rounded corners and blur what is behind it. On pages extensions can't touch (`chrome://` pages, the Web Store) it falls back to the normal popup. A per-open secret in the panel's address keeps websites from embedding it themselves.

## Design notes

- **No tab capture anywhere.** The manifest has no `tabCapture` or `desktopCapture`. The Chromecast fetches and decodes the stream itself.
- **Detection runs on two paths.** `chrome.webRequest.onResponseStarted` (observe-only, non-blocking) sees every media response from any frame, including cross-origin player iframes, with its tab and frame ID. The content script runs in all frames and reports `<video>` elements: source, playing state, size, poster and duration. A `blob:` source is treated as a sign of MediaSource playback, never as a castable URL. The manifest that feeds it is then found among the network candidates of the same frame.
- **Service-worker safe.** All state is in `chrome.storage.session`, and each tab's read-modify-write is serialised so concurrent events can't overwrite each other. A page navigation clears the tab, and a sub-frame navigation clears that frame. Only the helper's native messaging port lives in memory; when the worker restarts, the helper restarts too and re-attaches to the running cast.
- **Ranking is pure and deterministic** (`lib/rank.ts`). Points go to: the playing video, HLS/DASH manifests over single files, the first playlist requested (usually the master), large players, and higher resolution. Points come off for ads, short clips, tiny files and audio-only streams. Segments are excluded. Duplicate URLs are compared with signing and cache-buster parameters removed, but the original URL is always the one that gets cast.
- **The probe never sends cookies** (`credentials: 'omit'`). That keeps your credentials private, and it approximates what the Chromecast will see, since it has no cookies either.
- **Detection doesn't prove casting works.** A cast counts as successful only once the receiver reports `PLAYING`. If the stream fails to load, errors out, or doesn't start within 30 seconds, the error says which.

## Detection details

- **Frame tree.** Every `sub_frame` navigation records its parent frame (from `webRequest`, so no extra permission is needed). A frame that navigates is cleared together with every frame nested inside it. Streams are associated with a MediaSource player in the same frame first, then in a parent or child frame, so nested third-party embeds work. Streams requested from an ad frame (such as the IMA SDK iframe) or by an ad initiator are marked as ads.
- **MAIN-world hooks** (`src/main-world.ts`, about 1 KB, `document_start`, every frame). Content scripts can't see the page's JavaScript objects, so a tiny script in the page's own world wraps four APIs, calling the original every time:
  - `URL.createObjectURL` and `MediaSource.addSourceBuffer` link a `blob:` URL to its player and record its codecs (e.g. `avc1.64001f`).
  - `MediaKeySystemAccess.createMediaKeys` and `HTMLMediaElement.setMediaKeys` report the key system only when a player actually attaches DRM. Players often probe for DRM support on clear content, so a probe alone is not counted. No keys or licence data are read.
  - `attachShadow` is a cue to rescan for videos.

  Hints reach the content script as JSON `CustomEvent`s. A page could forge them, which would only change how Castit describes that page's own media.
- **Shadow DOM.** Shadow roots, open and closed, are searched with `chrome.dom.openOrClosedShadowRoot`, and each one gets its own media-event listeners and MutationObserver. Pages without shadow DOM stay on the cheap shallow scan.
- **Manifest inspection.** When the panel opens, the worker fetches the tab's not-yet-inspected HLS/DASH manifests, oldest first and without cookies. That gives master or media role, number of qualities, top resolution, codecs, live or VOD, audio and subtitle tracks, DRM and CORS. Variant and rendition playlists of a known master are then hidden. This happens only on demand, never just because a page loaded.
- **Redirects.** The URL the page asked for is kept and cast (the Chromecast follows redirects). The final URL is used to match it with the `<video>` element.
- **Failures count as evidence.** Media responses with HTTP ≥ 400 and `<video>` load errors (`MediaError`) are recorded. Streams that only failed are dropped. A player whose own source failed is shown as "Unlikely" with the reason.
- **SPA navigation.** A history-API URL change marks older, non-playing streams as "from before the page navigated" and ranks them lower.
- **The panel** shows quality, LIVE, AD and castability, and for the selected stream why it may not work, before you click Cast.
