# Castit

**Send the video you're watching in Chrome to your Chromecast or Google TV.**

Castit is a Chrome extension that finds the actual video stream on a web page and plays it on your TV. It doesn't mirror your tab or screen: the TV fetches and plays the video itself, in full quality, while your computer stays free.

- **Works on most video pages**, including players embedded from other sites, HLS and DASH streams, live streams and plain video files.
- **One click.** Castit finds your TV on the network and picks the video you're watching.
- **Use the website's own player as the remote.** Play, pause and seek there, and the TV follows.
- **Fixes common problems by itself.** When the TV can't fetch or play a stream, Castit relays it through your computer, or converts it with FFmpeg if you have it installed.
- **Clear answers.** When something can't be cast (for example DRM-protected video), Castit tells you why and what you can do.

> **Status:** version 1.1, tested on macOS with Chrome. Linux should work. Windows isn't supported yet. See [Known limitations](docs/limitations.md).

## Requirements

- **Google Chrome** 116 or later, on macOS or Linux (Chromium, Brave and Edge should work too, but are untested)
- **[Node.js](https://nodejs.org)** 22.18 or later
- **A Chromecast or Google TV** on the same Wi-Fi network as your computer
- Optional: **[FFmpeg](https://ffmpeg.org)**, to convert videos your TV can't play (macOS: `brew install ffmpeg`)

## Installation

1. **Download Castit:**

   ```bash
   git clone https://github.com/CheatInNeed/CastIt.git
   ```

2. **Set it up** in the downloaded folder (one time):

   ```bash
   cd CastIt
   ```

   ```bash
   npm install
   ```

   ```bash
   npm run setup
   ```

   This builds the extension and installs Castit's small helper program, which Chrome starts by itself when needed. Nothing has to keep running in a terminal.

3. **Add it to Chrome:** open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and choose the `apps/extension/dist` folder.

The first time you cast, your computer may ask whether Node may accept incoming network connections. Allow it, so your TV can reach videos that Castit relays.

## How to use it

1. Open a page with a video and **start playing it**.
2. Click the **Castit icon** in Chrome's toolbar (or press **Alt+Shift+C**). The video you're watching is already selected, and your TV is shown at the top. With several TVs, pick one there.
3. Click **Cast**.

The video now plays on your TV, starting where you were, and pauses on the page. Control it from the page's own player, from the Castit panel, or with **Alt+Shift+P** (play/pause). Click **■** in the panel to stop casting.

The number on the Castit icon shows how many videos it found on the page. A green ▶ marks the tab that is casting.

**Settings** (the sliders icon in the panel):

- **Casting:** *Automatic* (recommended), or force *Direct only*, *Always relay* or *Always convert*.
- **TV model** and **Quality** (shown when FFmpeg is installed): tell Castit what your TV can play, so it converts only when needed.

## Troubleshooting

| Problem | What to try |
|---|---|
| The panel says **One-time setup** | Run `npm run setup` in the Castit folder, then reload the extension on `chrome://extensions`. |
| **No TV found** | Check that the TV is on and on the same Wi-Fi as your computer. A VPN can hide it. |
| **No video found** | Start playing the video first, then open Castit again. If the page was open before Castit was installed, reload it. |
| "DRM-protected" or "private format" | Castit can't cast this video (Netflix, YouTube and similar). Use the site's own Cast button. |
| The TV starts but stops or never plays | Castit tries other ways by itself. If it still fails, click **Copy details** in the panel and include the text when you report it. |
| Converted videos stutter | Pick a lower **Quality** in settings. |

The helper writes a log to `~/.castit/companion.log`.

## What Castit will never do

- **Capture or mirror your tab or screen.** The TV plays the original stream.
- **Bypass DRM**, logins or paywalls, or extract keys.
- **Send your cookies or passwords anywhere.** When Castit fetches a stream itself, it sends only the page address (`Referer`/`Origin`) and browser name, like a browser would without your login.
- **Talk to anything but your own TV and the video's own server.** Castit has no accounts, no analytics and no servers of its own.

## Updating and removing

- **Update:** run `git pull` and then `npm run setup` again, and click reload on Castit in `chrome://extensions`.
- **Remove:** run `npm run uninstall-companion`, then remove the extension in `chrome://extensions`.

## Documentation

- [How Castit works](docs/architecture.md): the parts, and why a helper and an in-page panel
- [The helper](docs/helper.md): finding TVs, relaying, security, FFmpeg conversion
- [Casting in detail](docs/casting.md): the page player as remote, and how Castit picks a method
- [Compatibility](docs/compatibility.md): which kinds of sites were tested and how
- [Known limitations](docs/limitations.md)
- [Development](docs/development.md): build commands, tests and a manual test checklist
