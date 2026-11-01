# Development

Castit is an npm workspace written in TypeScript:

| Folder | What it is |
|---|---|
| `apps/extension` | The Chrome extension (background worker, content scripts, panel) |
| `apps/companion` | The helper: Node.js native messaging host (Cast sender, discovery, relay, FFmpeg) |
| `packages/shared` | Types and message protocols shared by both |
| `tests` | Vitest unit, DOM, integration and end-to-end tests, a fake Cast TV, recorded sites, a manual test page |

Run `npm install` once, then `npm run setup` to build and install. After changing code, run `npm run setup` again (or `npm run dev:extension` while working on the extension only) and reload Castit on `chrome://extensions`.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Builds everything and installs the helper for Chrome (and Chromium, Brave, Edge when present) |
| `npm run uninstall-companion` | Removes the helper again |
| `npm run build` | Builds the extension (`apps/extension/dist`) and the helper bundle (`apps/companion/dist`) |
| `npm test` | Runs the unit and integration tests (Vitest) |
| `npm run typecheck` | Type-checks all packages |
| `npm run dev:extension` | Rebuilds the extension on every change (reload it on `chrome://extensions`) |
| `npm run dev:testpage` | Serves `tests/manual` on http://localhost:5174 |
| `npm run compat` | Shows what Castit would list and choose on each recorded real site |
| `npm run compat:site` | Starts the local aggregator-style test site (aggregator → embedded player → protected video server) |
| `npm run icons` | Regenerates the icons |

The extension's manifest carries a fixed public `key`, so its ID (`eflnlfagpgmlccfedomaaofcdlaehikl`) is the same on every computer; the helper only accepts that ID. The helper logs to `~/.castit/companion.log`.

## Manual test checklist

With `npm run dev:testpage` running and the extension loaded (reload it on `chrome://extensions` after each build). Open http://localhost:5174, and reload the page between scenarios for a clean list. Each section of the page also states what to expect.

1. **Progressive MP4 (redirected):** play video 1 and open Castit. Expect one `big_buck_bunny_720p_surround.mp4` candidate (FILE · MP4 · 360p · PLAYING · Castable). It is the archive.org URL, not its `dn….archive.org` redirect target. Cast it. Expect the TV to start from about the same position and the page's video to pause.
2. **HLS through MediaSource:** play video 2 and open Castit. The first time, several `.m3u8` entries may appear; within a second Castit inspects the master and leaves one: HLS · N qualities · 1080p · H.264 · Castable.
3. **DASH through MediaSource:** play video 3. Expect one DASH candidate linked to the playing player.
4. **Cross-origin embedded player:** press ▶ inside the iframe (scenario 4). Expect the HLS candidate to read "… · in player 127.0.0.1".
5. **Dynamic player:** click "Insert player in 1.5 s" with Castit open. The Sintel MP4 should appear without reopening it.
6. **Closed shadow root:** play scenario 6. The Sintel trailer must be detected, even though the page's own scripts cannot see that video.
7. **Ad-like clip and broken source:** scenario 7 ranks low (short clip, small player, tiny file). Scenario 8 is listed as "Unlikely" with "The page's own player could not load this URL…", and is never pre-selected.
8. **Page player as remote:** cast scenario 2 (HLS) and wait for the TV to play. The page's player should pause and show the "Casting to …" badge, and the panel should show it ON TV. Press the player's ▶: the TV should pause; press again: it plays. Click the page's timeline: the TV seeks there. Pause from the panel: the page's timeline jumps to the TV's position. Click ■ in the panel while the TV plays: the page stays paused at the TV's position.
9. **Embedded player as remote:** do the same with scenario 4 (cross-origin iframe).
10. **Helper not installed:** run `npm run uninstall-companion`, reload the extension and open the panel. It should show *One-time setup* and disable **Cast**. Run `npm run setup` again.
11. **Forced relay:** set **Casting → Always relay** and cast scenario 1 or 2. `~/.castit/companion.log` should log a session. Seek around: the TV's range requests keep playback going without a full download.
12. **Automatic fallback:** with **Automatic** selected, cast a stream whose host lacks CORS (try a real site). Castit either relays straight away or retries through the relay after the direct load fails.
13. **Remote control:** while casting, try play/pause, seek, volume, mute and stop from the panel. Each should act on the TV.
14. **Service worker restart:** on `chrome://extensions`, open Castit's service worker DevTools and use **Stop** while the TV plays, then open the panel again. The helper restarts, re-attaches to the running cast, and the controls work.
15. **Errors:** turn the TV off (or disconnect from its Wi-Fi) and open the panel: the header should say *No TV found*, and casting should explain the TV can't be reached.
16. **No video:** open a page with no video. Expect "No video found…".
17. **Automatic recovery:** with **Automatic** selected, cast a stream that fails directly (a real site without CORS is ideal). The attempts list should show the failed direct attempt with a specific reason, then the working method. Click **Copy details** and paste it somewhere: it should list both attempts and contain no `?…=` query strings.
18. **Conversion (needs FFmpeg):** open a page with an MKV, or set **Always convert** and cast scenario 1. Seek far ahead: playback should resume within a couple of seconds. If the file has subtitles, choose them in the Subtitles menu.
19. **Real sites:** try a few sites that embed third-party players. Note what Castit lists and whether casting works.
