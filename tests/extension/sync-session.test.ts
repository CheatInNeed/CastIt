// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteCommand } from '@castit/shared';
import { SyncSession } from '../../apps/extension/src/lib/sync-session.ts';

let activated = false;
Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: activated }) });

afterEach(() => {
  document.body.innerHTML = '';
  activated = false;
});

/** A <video> whose play/pause flip `paused` and fire events, like a real element. */
function fakeVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  document.body.appendChild(v);
  let paused = false;
  Object.defineProperty(v, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(v, 'duration', { configurable: true, get: () => 600 });
  v.pause = vi.fn(() => {
    if (paused) return;
    paused = true;
    v.dispatchEvent(new Event('pause'));
  });
  v.play = vi.fn(() => {
    paused = false;
    v.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  v.getBoundingClientRect = () => ({ width: 640, height: 360, top: 20, left: 20, bottom: 380, right: 660 }) as DOMRect;
  return v;
}

const overlays = () => document.querySelectorAll('castit-overlay').length;

describe('SyncSession', () => {
  it('pauses the page, shows the badge, and turns the page’s play button into a TV toggle', () => {
    const video = fakeVideo();
    const sent: RemoteCommand[] = [];
    const session = new SyncSession(video, { requestId: 'r1', deviceName: 'Living Room', send: (c) => sent.push(c), onLost: () => undefined });
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(overlays()).toBe(1);

    // A page script restarting playback: re-paused, nothing sent to the TV.
    void video.play();
    expect(sent).toEqual([]);
    expect(video.paused).toBe(true);

    // The user clicks the page's play button.
    activated = true;
    void video.play();
    expect(sent).toEqual([{ type: 'togglePlay' }]);
    expect(video.paused).toBe(true);

    session.stop('replaced', null, false);
    expect(overlays()).toBe(0);
  });

  it('forwards a user seek and mirrors TV state without echoing it back', () => {
    const video = fakeVideo();
    const sent: RemoteCommand[] = [];
    const session = new SyncSession(video, { requestId: 'r1', send: (c) => sent.push(c), onLost: () => undefined });

    activated = true;
    video.currentTime = 300;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    expect(sent).toEqual([{ type: 'seek', time: 300 }]);

    // The TV pauses at 420 s: the page follows, and that seek isn't sent back to the TV.
    session.receiverState({ phase: 'paused', currentTime: 420, duration: 600, live: false, canSeek: true, volume: 1, muted: false });
    expect(video.currentTime).toBe(420);
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    expect(sent).toHaveLength(1);
    session.stop('stopped', 420, false);
  });

  it('resumes local playback where the TV was after a disconnect', () => {
    const video = fakeVideo();
    const session = new SyncSession(video, { requestId: 'r1', send: () => undefined, onLost: () => undefined });
    session.stop('disconnected', 333, true);
    expect(video.currentTime).toBe(333);
    expect(video.paused).toBe(false);
    // Events after stopping are no longer handled.
    expect(overlays()).toBe(0);
  });

  it('reports when the page fights the sync', () => {
    const video = fakeVideo();
    const onLost = vi.fn();
    const session = new SyncSession(video, { requestId: 'r1', send: () => undefined, onLost });
    for (let i = 0; i < 10; i++) void video.play();
    expect(onLost).toHaveBeenCalledOnce();
    expect(video.muted).toBe(true);
    session.stop('stopped', null, false);
    expect(video.muted).toBe(false);
  });
});
