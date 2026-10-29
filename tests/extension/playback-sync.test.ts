import { describe, expect, it } from 'vitest';
import type { CastStatus } from '@castit/shared';
import { SYNC_TUNING, SyncController, type LocalEvent, type LocalSnapshot, type ReceiverSyncState } from '../../apps/extension/src/lib/playback-sync.ts';
import { routeStatus, type SyncTarget } from '../../apps/extension/src/lib/sync-routing.ts';

const local = (o: Partial<LocalSnapshot> = {}): LocalSnapshot => ({
  currentTime: 100,
  duration: 3600,
  paused: true,
  playbackRate: 1,
  volume: 1,
  muted: false,
  ...o,
});
const event = (type: LocalEvent['type'], o: Partial<LocalEvent> = {}): LocalEvent => ({ ...local(), type, userActivated: false, ...o });
const receiver = (o: Partial<ReceiverSyncState> = {}): ReceiverSyncState => ({
  phase: 'playing',
  currentTime: 100,
  duration: 3600,
  live: false,
  canSeek: true,
  volume: 1,
  muted: false,
  ...o,
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SyncController: page → TV', () => {
  it('pauses the page when casting starts and ignores the echo of its own pause', () => {
    const sync = new SyncController();
    expect(sync.start(local({ paused: false }))).toEqual([{ type: 'pause' }]);
    expect(sync.onLocalEvent(event('pause'))).toEqual({ commands: [], actions: [] });
  });

  it('turns a user press on the page’s play button into a TV toggle and keeps the page paused', () => {
    const sync = new SyncController();
    const result = sync.onLocalEvent(event('play', { userActivated: true, paused: false }));
    expect(result).toEqual({ commands: [{ type: 'togglePlay' }], actions: [{ type: 'pause' }] });
    // The pause we just issued comes back as an event: swallowed, no command.
    expect(sync.onLocalEvent(event('pause'))).toEqual({ commands: [], actions: [] });
  });

  it('never lets a page script control the TV, but keeps the page silent', () => {
    const sync = new SyncController();
    const result = sync.onLocalEvent(event('play', { userActivated: false, paused: false }));
    expect(result.commands).toEqual([]);
    expect(result.actions).toEqual([{ type: 'pause' }]);
  });

  it('stops fighting a page that keeps restarting playback and mutes it instead', () => {
    const c = clock();
    const sync = new SyncController(c.now);
    let last;
    for (let i = 0; i <= SYNC_TUNING.autoPlayLimit; i++) {
      last = sync.onLocalEvent(event('play', { paused: false }));
      c.advance(100);
    }
    expect(last!.actions).toEqual([{ type: 'mute', muted: true }]);
    expect(sync.fighting).toBe(true);
    // The muted page doesn't receive pauses any more, and our mute echo is ignored.
    expect(sync.onLocalEvent(event('volumechange', { muted: true, userActivated: false }))).toEqual({ commands: [], actions: [] });
    expect(sync.onReceiverState(receiver(), local({ paused: false }))).toEqual([]);
    // Restoring at the end unmutes.
    expect(sync.stop('stopped', null, false, local())).toEqual([{ type: 'mute', muted: false }]);
  });

  it('forwards user seeks once, on seeked', () => {
    const sync = new SyncController();
    expect(sync.onLocalEvent(event('seeking', { currentTime: 500, userActivated: true })).commands).toEqual([]);
    expect(sync.onLocalEvent(event('seeked', { currentTime: 500, userActivated: true })).commands).toEqual([{ type: 'seek', time: 500 }]);
  });

  it('forwards the final position of a drag that never fires seeked', () => {
    const c = clock();
    const sync = new SyncController(c.now);
    sync.onLocalEvent(event('seeking', { currentTime: 200, userActivated: true }));
    c.advance(100);
    sync.onLocalEvent(event('seeking', { currentTime: 260, userActivated: true }));
    expect(sync.flushPendingSeek()).toBeNull();
    c.advance(SYNC_TUNING.seekDebounceMs);
    expect(sync.flushPendingSeek()).toEqual({ type: 'seek', time: 260 });
    expect(sync.flushPendingSeek()).toBeNull();
  });

  it('does not forward seeks for live streams', () => {
    const sync = new SyncController();
    sync.onReceiverState(receiver({ live: true }), local());
    expect(sync.onLocalEvent(event('seeked', { currentTime: 500, userActivated: true })).commands).toEqual([]);
  });

  it('forwards volume, mute and speed only with a user gesture', () => {
    const sync = new SyncController();
    expect(sync.onLocalEvent(event('volumechange', { volume: 0.3 })).commands).toEqual([]);
    expect(sync.onLocalEvent(event('volumechange', { volume: 0.3, muted: true, userActivated: true })).commands).toEqual([
      { type: 'volume', level: 0.3 },
      { type: 'mute', muted: true },
    ]);
    expect(sync.onLocalEvent(event('ratechange', { playbackRate: 1.5, userActivated: true })).commands).toEqual([{ type: 'rate', rate: 1.5 }]);
  });
});

describe('SyncController: TV → page', () => {
  it('aligns the page tightly when the TV pauses, and ignores the echo of that seek', () => {
    const sync = new SyncController();
    expect(sync.onReceiverState(receiver({ phase: 'paused', currentTime: 742 }), local({ currentTime: 100 }))).toEqual([{ type: 'seek', time: 742 }]);
    expect(sync.onLocalEvent(event('seeking', { currentTime: 742 }))).toEqual({ commands: [], actions: [] });
    expect(sync.onLocalEvent(event('seeked', { currentTime: 742, userActivated: true }))).toEqual({ commands: [], actions: [] });
    expect(sync.onReceiverState(receiver({ phase: 'paused', currentTime: 742 }), local({ currentTime: 742 }))).toEqual([]);
  });

  it('re-aligns during playback only on large drift, and not too often', () => {
    const c = clock();
    const sync = new SyncController(c.now);
    expect(sync.onReceiverState(receiver({ currentTime: 105 }), local({ currentTime: 100 }))).toEqual([]);
    expect(sync.onReceiverState(receiver({ currentTime: 130 }), local({ currentTime: 100 }))).toEqual([{ type: 'seek', time: 130 }]);
    c.advance(1000);
    expect(sync.onReceiverState(receiver({ currentTime: 160 }), local({ currentTime: 130 }))).toEqual([]);
    c.advance(SYNC_TUNING.playingMirrorIntervalMs);
    expect(sync.onReceiverState(receiver({ currentTime: 190 }), local({ currentTime: 130 }))).toEqual([{ type: 'seek', time: 190 }]);
  });

  it('re-pauses a page that resumed by itself', () => {
    const sync = new SyncController();
    expect(sync.onReceiverState(receiver(), local({ paused: false }))).toEqual([{ type: 'pause' }]);
  });

  it('moves the page to the end when the TV finishes', () => {
    const sync = new SyncController();
    expect(sync.onReceiverState(receiver({ phase: 'ended', currentTime: 0, duration: 3600 }), local())).toEqual([{ type: 'seek', time: 3599.75 }]);
  });

  it('never seeks for live streams', () => {
    const sync = new SyncController();
    expect(sync.onReceiverState(receiver({ phase: 'paused', live: true, currentTime: 9999 }), local())).toEqual([]);
  });
});

describe('SyncController: restoring', () => {
  it('resumes locally at the TV position after a disconnect while playing', () => {
    const sync = new SyncController();
    expect(sync.stop('disconnected', 1234, true, local())).toEqual([{ type: 'seek', time: 1234 }, { type: 'play' }]);
  });

  it('only restores the position when stopped or ended', () => {
    const sync = new SyncController();
    expect(sync.stop('stopped', 1234, true, local())).toEqual([{ type: 'seek', time: 1234 }]);
    expect(new SyncController().stop('replaced', 1234, true, local())).toEqual([]);
  });
});

describe('routeStatus', () => {
  const target: SyncTarget = { tabId: 1, requestId: 'r1', state: 'active', lastTime: null, wasPlaying: true };
  const status = (o: Partial<CastStatus>): CastStatus => ({
    phase: 'playing',
    sessionActive: true,
    devicesAvailable: true,
    currentTime: 50,
    duration: 100,
    live: false,
    canSeek: true,
    canPause: true,
    volume: 1,
    muted: false,
    requestId: 'r1',
    updatedAt: 0,
    ...o,
  });

  it('forwards playing/paused states and remembers the position', () => {
    const r = routeStatus(target, status({ phase: 'paused', currentTime: 42 }));
    expect(r.forward?.phase).toBe('paused');
    expect(r.update).toMatchObject({ lastTime: 42, wasPlaying: false });
    expect(r.stop).toBeUndefined();
  });

  it('ends the sync for every way a cast can end', () => {
    expect(routeStatus(target, status({ sessionActive: false })).stop).toBe('disconnected');
    expect(routeStatus(target, status({ requestId: 'r2' })).stop).toBe('replaced');
    expect(routeStatus(target, status({ phase: 'idle' })).stop).toBe('stopped');
    const ended = routeStatus(target, status({ phase: 'ended', currentTime: 0 }));
    expect(ended).toMatchObject({ stop: 'ended', update: { lastTime: 100, wasPlaying: false } });
    expect(ended.forward?.phase).toBe('ended');
  });

  it('waits while the receiver is still loading', () => {
    expect(routeStatus(target, status({ phase: 'loading' }))).toEqual({ update: { deviceName: undefined, lastTime: 50 } });
  });
});
