# Known limitations

## What Castit can't cast

- **DRM-protected video** (Netflix, Disney+, Vimeo and others using Widevine, PlayReady, FairPlay or SAMPLE-AES). Castit detects it and says so. It never extracts keys or decrypts anything.
- **Private streaming formats** (for example YouTube), where only the site's own player understands the stream. Use the site's own Cast button.
- **Streams that need your login cookies.** Castit never forwards browser cookies or credentials, so those fail even through the helper. Many logged-in sites still work, because their video links are signed instead. Tokens bound to your IP address usually work through the helper, since it uses the same IP.
- **Players without a `<video>` element** (canvas players, or players with their own Cast integration) can't be used as a remote. Castit's own controls still work.

## Platform and setup

- **Windows** isn't supported yet: the helper's installer handles macOS and Linux only.
- **Node.js is required** on the computer that casts, because the helper runs on Node.
- **Firewall:** your OS firewall must allow incoming connections to Node on port 47801, or the TV can't reach relayed streams. macOS asks the first time.
- **VPNs and several network adapters:** the helper may pick a LAN address the TV can't reach. Add `--public-host <your-lan-ip>` to the last line of `~/.castit/host/castit-companion`.
- **Changing IP addresses:** a relay session is bound to one TV address. If the TV changes IP mid-cast, cast again.

## Detection

- **The master playlist is guessed until the panel inspects it**, from request order and file name. The badge count may include variant playlists until then.
- **Inspection sends extra requests without cookies.** Manifests that need cookies show as "authentication required", even though the page itself plays them.
- **The probe fetches the stream URL once.** A strictly single-use URL could be used up by it. This is rare.
- **Workers:** players that fetch media from Web Workers or service workers may not be attributed to the right frame. MediaSource inside workers bypasses the page hook (codecs unknown, still detected via the network).
- **Anti-tamper scripts:** pages that check that built-ins are unmodified could notice the four wrapped browser APIs. This is rare.
- **Ad detection is heuristic** (URL, frame, duration, size).
- **Several audio and subtitle tracks** in a stream are counted, but not offered to the TV yet.

## Conversion (FFmpeg)

- **CPU and GPU heavy:** at most 2 conversions run at once (the oldest is stopped). Without a hardware encoder, 4K → 1080p needs a fast CPU to stay ahead of playback.
- **DASH input** can only be converted if your FFmpeg build has the DASH demuxer. Homebrew's build doesn't, so DASH streams are relayed unchanged.
- **One audio track** is converted (the default one).
- **Seams after a seek** can carry a timestamp jump of up to ~50 ms (audio priming). Players normally absorb this.

## Page player as remote

- The page's player shows "paused" the whole time; the badge over it shows the TV's real state.
- Media keys and OS media controls carry no user gesture inside the page, so they aren't forwarded.
- Players' own JavaScript APIs (such as the YouTube iframe API) aren't used.
- The badge follows the player into fullscreen only when the fullscreen element contains it.
- Playback speed is sent with the standard Cast `SET_PLAYBACK_RATE` message (0.5×–2×). Support depends on the receiver.

## Automatic recovery

- **Freeze detection** covers the first 2 minutes of playback. Later problems are reported, not recovered automatically, because expired links usually need the page to be reloaded.
- **TV error codes are best effort:** receivers that send no detailed error get the plain fallback order.

## Test status

| Area | Tested how |
|---|---|
| Detection and ranking | Unit tests, recorded real sites, and real hls.js playback in a browser |
| Direct casting | On a real Chromecast (with the earlier Cast SDK sender) |
| Relay through the helper | End-to-end tests, and a DASH stream relayed to a real Chromecast |
| FFmpeg conversion | Real FFmpeg 9.0 with VideoToolbox (HEVC 10-bit + Dolby 5.1 + SRT → H.264 + AAC + WebVTT, seeking). Not yet on a real TV |
| Page player as remote | DOM tests and real browser clicks, and on a real Chromecast |
| Automatic strategy | Unit tests. A real failing site on a TV has not been tried |
| Helper's own Cast sender (1.1) | TV discovery and a status check against a real TV. Loading, commands, error detail and re-attaching against a fake Cast TV. **Full casting to a real TV with the helper is still being verified** |
| Image-disguised HLS segments | End-to-end relay test. Not yet on a real TV |
| Panel | Checked visually with sample data, in light and dark mode |
