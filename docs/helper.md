# The helper (companion)

The helper does three jobs:

1. **Finds TVs.** It asks the network for Cast devices (mDNS, `_googlecast._tcp`), the way Chrome does. Speakers and speaker groups are left out.
2. **Casts.** It talks to the TV over the Cast protocol (TLS on port 8009): starts Google's Default Media Receiver, loads the stream, follows playback and sends remote commands. When the helper restarts mid-cast it re-attaches, but only if the TV still plays that exact stream.
3. **Relays and converts.** Direct casting hands the TV the stream URL. That fails when the TV isn't allowed to fetch the stream itself: the stream host sends no CORS headers, or it checks the `Referer`/`Origin` of the embedding player (hotlink protection). The helper then fetches the real stream bytes upstream with the right `Referer`/`Origin` and serves them to the TV over your LAN. With FFmpeg, it also converts what the TV can't decode.

**Casting method** (Castit panel → settings):

- **Automatic** (default): direct, but relays straight away when Castit already knows it's needed (no CORS, or HTTP 401/403 without the page's Referer). If a direct cast fails on the TV (load failed, segment failure, or no playback within 30 s), Castit retries through the relay.
- **Direct only** / **Always relay** / **Always convert**: force one method.

## How it works

- Media URLs mirror the upstream URL: `http://<lan-ip>:47801/m/<session>/<scheme>/<host>/<path>?<query>`. Relative references in manifests (segments, variants, DASH templates) therefore resolve to proxied URLs with no rewriting. Absolute references are rewritten: HLS lines and `URI="…"` attributes; DASH `BaseURL`, `Location`, `media`, `initialization`, `sourceURL`. Query strings (signatures) are kept exactly.
- `Range` requests are passed through, so seeking in large MP4s never downloads the whole file. Bytes are piped, never buffered; only manifests (≤ 10 MB) are read into memory.
- Upstream redirects are returned to the receiver as *proxied* redirects, so relative URLs resolve against the final location.
- When the receiver disconnects (seek, stop), the upstream request is aborted at once. Sessions expire after 30 minutes idle (12 hours at most). Replacing or ending a cast deletes its session.
- Manifests served with generic content types are detected by sniffing their first bytes; gzip/deflate/brotli are decoded.

## Security model

| Concern | What the companion does |
|---|---|
| Who can control it | Nothing listens for commands on the network. Chrome starts the helper and talks to it over stdin/stdout (native messaging), and its manifest lists only Castit's extension ID. |
| Who can fetch media | Each cast gets a random 192-bit session id in its URLs. The session is bound to the first device that uses it (the Chromecast); other devices on the LAN get 403. Requests from this computer never claim the binding. |
| SSRF / open proxy | Upstreams must be http(s) with no embedded credentials. Private, loopback, link-local, CGNAT, multicast and reserved addresses are blocked, both as IP literals and *after DNS resolution*: the checked address is the one connected to, which defeats DNS rebinding. A session can only fetch from hosts its own manifests or redirects referred to. `--allow-private` lifts the address check for LAN media servers and is off by default. |
| Credentials | The only upstream context accepted is `Referer`, `Origin` and `User-Agent`. Cookies, `Authorization` and other headers are never forwarded, whether they come from the receiver or the extension. Upstream `Set-Cookie` is never passed on. |
| Local files | There is no file serving and no `file:` upstreams. |
| Leaking URLs | Logs and session listings strip query strings (signatures). |

The companion does not bypass DRM, logins or paywalls. If the upstream refuses it (HTTP 401/403) even with the page's Referer, Castit reports "authentication required".

## Format conversion with FFmpeg

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

Text subtitles (SRT, ASS, WebVTT, MP4 text) are converted to WebVTT and offered to the TV. Pick them in the Castit panel. Image subtitles (PGS, DVD) can't be converted to text and are skipped.

**Settings** (in the Castit panel, when FFmpeg is available):

- **TV model** decides what counts as playable:
  - *Any Chromecast (safest)*: H.264 ≤ 1080p, AAC/MP3/Opus/Vorbis/FLAC.
  - *Chromecast Ultra*: adds HEVC, VP9, 4K.
  - *Chromecast with Google TV*: adds Dolby Digital.
  - *Google TV Streamer*: adds AV1.
- **Quality** caps the output resolution (Auto, 1080p, 720p, 480p). Lower is less CPU and less Wi-Fi.
- **Casting → Always convert** forces conversion, which is useful for testing.

In *Automatic* mode, Castit converts up front when it already knows it must: an FLV/AVI file, an MKV, or HEVC/AV1 codecs seen in the manifest or the page's player. Otherwise, after a direct cast fails on the TV, the helper analyses the stream and converts only if that's the problem. If a plain relay also fails, it forces a conversion as a last resort.
