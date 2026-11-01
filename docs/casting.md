# Casting in detail

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
- **Not fighting.** If a page keeps restarting its player by itself (more than 6 times in 5 s), Castit stops fighting and mutes it instead.
- **Only the right frame.** The background accepts remote commands only from the exact tab and frame that was synced, for the current cast.

When no controllable player is found (e.g. the page navigated away), the page is just paused. Castit's own controls (the panel, `Alt+Shift+P`) always work.

## How Castit decides (automatic strategy)

Every cast is a short series of *attempts*. Each attempt pairs one stream with one method, cheapest first.

1. **Pick the first method from what is already known.**
   - Containers the TV can't open (FLV, AVI) and codecs it can't decode (HEVC on older Chromecasts, …) go to FFmpeg conversion.
   - Missing CORS headers and Referer checks go to the companion relay.
   - DRM and expired links stop with an explanation.
   - Everything else goes direct.
2. **Verify on the TV.** An attempt only counts once the Chromecast reports it is *playing*. For the next two minutes, Castit also watches for freezes: "playing" or "buffering" with no progress for 20 s counts as a failure.
3. **Read the TV's own error.** The Chromecast's detailed error code turns "couldn't load" into a specific cause, and that picks the next method:

   | TV's error | Castit's next step |
   |---|---|
   | Couldn't download the playlist, a segment or the key | Through the companion (with FFmpeg, it first checks whether conversion is needed) |
   | Couldn't decode the video | Straight to FFmpeg conversion |
   | DRM | Stop; Castit doesn't bypass DRM |

4. **Recover.** If playback fails or freezes in the first 3 minutes, Castit switches to the next method and resumes at the same position. A plain relay that fails is followed by a forced conversion.
5. **Try the same video another way.** When every method failed for one stream, Castit tries other streams of the *same page player* (sites often offer both HLS and DASH). It never switches to a different video or an advert.
6. **Give up with a reason.** If nothing plays, the message names the most specific cause found across all attempts, e.g. "Castit tried 3 ways; none played. Most likely cause: …".

**In the panel**, the list of attempts appears whenever a cast failed or needed more than one attempt, for example:

```
1. Direct to the Chromecast: The Chromecast could not download or read the stream's playlist (often blocked by the server: CORS or Referer checks).
2. Repackaged by FFmpeg (no re-encoding): playing ✓
```

**Stop trying** cancels a running series of attempts. After a failure, **Copy details** copies a plain-text report for bug reports. It contains the page and stream addresses *without* their query strings (which often hold signatures), what was detected, every attempt with the TV's error codes, and the companion and FFmpeg status.

The strategy is a pure, unit-tested module (`apps/extension/src/lib/strategy.ts`). The background worker only executes its steps.
