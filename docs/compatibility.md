# Compatibility

## How sites are tested

- **Recorded real sites (regression tests).** A snippet (`tests/compat/tools/capture-snippet.js`) is run on a real site while it plays. It records what Castit's network observer and page script would see: the stream requests (long runs of segments trimmed) and the `<video>` elements. Manifests are then inspected exactly as the panel does (`tests/compat/tools/inspect-manifests.ts`). Each recording lives in `tests/fixtures/compat/` and is replayed through Castit's real detection, ranking and castability code on every `npm test`. `npm run compat` prints the outcome per site.
- **A local aggregator-style test site (`npm run compat:site`).** It copies the architecture of aggregator streaming sites without visiting any:
  - an aggregator page with a pop-up ad and an ad iframe;
  - a player embedded from *another* origin, with click-to-play, a skippable pre-roll ad, and a stream address fetched from an API (obfuscated);
  - a video server with signed links that expire after 10 minutes, Referer (hotlink) checks, and CORS limited to the player.

  It relays a public test stream and logs every refusal. `tests/compat/movy-sim.test.ts` checks the whole path offline.

## Results

| Category | Site | What Castit lists and picks | How it should reach the TV | On a real Chromecast |
|---|---|---|---|---|
| HTML5 video, plain file | Wikimedia Commons (VP9 WebM, 4 `<source>`s, 2 empty placeholder players) | The 1080p file being played; "Maybe castable" (VP9) | Ultra / Google TV: direct. Older Chromecasts: converted by FFmpeg | Not yet |
| HTML5 video, redirected file | Test page scenario 1 (archive.org) | The page's own URL, not the redirect target | Direct | ✓ |
| HLS, MediaSource player | hls.js demo | The master only: 1080p, H.264, "Castable"; variants and segments hidden | Direct | ✓ (test page scenario 2) |
| DASH, MediaSource player | DASH-IF reference player | The `.mpd` only; numbered pieces hidden, even after a quality switch | Direct | ✓ (via companion) |
| Live HLS | Unified Streaming live channel | The master, **LIVE** (found by playlist inspection; the player reports a finite rewind window) | Direct, as a live stream | Not yet |
| Cross-origin embedded player | Test page scenario 4 | "… in player 127.0.0.1"; the page's player is the remote | Direct | ✓ |
| Embedded player with DRM | Vimeo embed | **"Not castable: DRM-protected (Widevine, PlayReady)"**. Vimeo encrypts even public videos | Refused with that explanation; Castit never bypasses DRM | Correct by design |
| Signed, expiring links | Vimeo (signature in the path), aggregator-style test site | Original signed URL kept exactly; an expired link gets "expired, reload the page" | Direct or relay | ✓ (relay); expiry not yet |
| Hotlink-protected embed (aggregator-style) | Local test site | The stream from the embedded player; ads marked AD | Direct refused (403) → companion relay with the player's Referer | Not yet |
| Logged-in sites | – | Castit never sends cookies | Usually works directly (signed links); otherwise "authentication required" | Not yet |
| Proprietary services (YouTube) | Not recorded: the embed refused to load in the test browser | No castable stream expected; YouTube streams in pieces only its own player understands | – | Not tested |

**Fixed because of these recordings:**
- **Quality switches:** after a player switched quality, the leftover pieces in the first quality's folder were listed as separate videos.
- **WebM rating:** WebM was rated "Castable" although it's usually VP9.
- **Nameless entries:** the stream named just `.m3u8` showed as a nameless entry; generic names like `master.m3u8` now show their folder.

## Testing on your own TV

Keep **Automatic** selected. On each site: play the video, open Castit, and check that the pre-selected entry is the video you were watching. Then cast. If anything is off, click **Copy details** and include the text in an issue.

1. **Live stream:** open the live channel above (`https://hlsjs.video-dev.org/demo/?src=https%3A%2F%2Fdemo.unified-streaming.com%2Fk8s%2Flive%2Fscte35.isml%2F.m3u8`) and cast. The TV should play it live, with no seek bar.
2. **VP9 file:** cast the Wikimedia video. If your Chromecast predates the Ultra, the attempts card should show a conversion (needs FFmpeg) or explain the codec.
3. **Aggregator-style test site:**
   1. Run `npm run compat:site`. The site runs on your own computer, which the helper refuses to relay from by default: add `--allow-private` to the last line of `~/.castit/host/castit-companion`, then reload the extension (the helper restarts with it). Run `npm run setup` afterwards to undo it.
   2. Open the printed `…/watch/1` address in Chrome, press ▶ in the player and skip the ad.
   3. Cast.

   Expected: the site's terminal logs a `403 hotlink protection` for the Chromecast, then `200 … (referer ok)` once Castit relays. The panel's attempts list shows that path.
4. **Expired link:** on the aggregator-style test site, wait 10+ minutes after pressing ▶, then cast. You should get a clear "expired, reload the page" message.
5. **Your own sites:** two or three sites you actually use, including one where you're logged in.
6. **DRM check:** a Vimeo video should be listed as *Not castable: DRM-protected*. That's expected.
