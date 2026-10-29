// @vitest-environment happy-dom
// After Castit is reloaded, Chrome keeps the old content script running in open pages and Castit
// injects the new one. Only the newest copy may stay active.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

let listeners: Listener[];
let chromeStub: {
  runtime: {
    id: string | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: (l: Listener) => void; removeListener: (l: Listener) => void };
  };
};

beforeEach(() => {
  listeners = [];
  chromeStub = {
    runtime: {
      id: 'castit',
      sendMessage: vi.fn(() => Promise.resolve()),
      onMessage: {
        addListener: (l) => listeners.push(l),
        removeListener: (l) => (listeners = listeners.filter((x) => x !== l)),
      },
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  vi.resetModules();
  document.body.innerHTML = '<video src="https://e.com/movie.mp4"></video>';
});

afterEach(() => vi.unstubAllGlobals());

/** Fresh module instance each time, like a new injection into the same page. */
const load = () => {
  vi.resetModules();
  return import('../../apps/extension/src/content.ts');
};
const reports = () => chromeStub.runtime.sendMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'content/report').length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('content script re-injection', () => {
  it('the newest copy takes over and the old copy goes quiet', async () => {
    await load();
    expect(listeners).toHaveLength(1);
    await load();
    expect(listeners).toHaveLength(1); // old message listener removed

    await wait(150);
    const before = reports();
    document.querySelector('video')!.dispatchEvent(new Event('play'));
    await wait(200);
    expect(reports() - before).toBe(1); // one report, not one per copy
  });

  it('hover finds the video and answers', async () => {
    await load();
    await wait(150);
    const report = chromeStub.runtime.sendMessage.mock.calls.map(([m]) => m as { type: string; videos?: Array<{ key: string }> }).find((m) => m.type === 'content/report');
    const key = report!.videos![0]!.key;
    const respond = vi.fn();
    listeners[0]!({ type: 'content/highlight', videoKey: key }, {}, respond);
    expect(respond).toHaveBeenCalledWith({ found: true });
    expect(document.querySelectorAll('castit-highlight')).toHaveLength(1);
    listeners[0]!({ type: 'content/highlight', videoKey: 'v999' }, {}, respond);
    expect(respond).toHaveBeenLastCalledWith({ found: false });
  });

  it('a copy whose extension was reloaded shuts itself down instead of throwing', async () => {
    await load();
    chromeStub.runtime.id = undefined;
    document.querySelector('video')!.dispatchEvent(new Event('play'));
    await wait(200);
    expect(listeners).toHaveLength(0);
  });
});
