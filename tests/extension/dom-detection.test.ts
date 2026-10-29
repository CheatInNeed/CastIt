// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeVideo, findVideos, isReportable, pauseAll } from '../../apps/extension/src/lib/detection.ts';
import { installMainWorldHooks, MAIN_EVENT, type MainWorldHint } from '../../apps/extension/src/main-world.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function addVideo(parent: ParentNode, src?: string): HTMLVideoElement {
  const v = document.createElement('video');
  if (src) v.setAttribute('src', src);
  parent.appendChild(v);
  return v;
}

describe('findVideos', () => {
  it('finds light-DOM videos without walking shadow roots when shallow', () => {
    addVideo(document.body, 'https://e.com/a.mp4');
    const host = document.createElement('div');
    document.body.appendChild(host);
    addVideo(host.attachShadow({ mode: 'open' }), 'https://e.com/b.mp4');
    expect(findVideos(document, false)).toHaveLength(1);
  });

  it('descends into nested open shadow roots when deep', () => {
    const outer = document.createElement('my-player');
    document.body.appendChild(outer);
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('my-controls');
    outerRoot.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    addVideo(innerRoot, 'https://e.com/deep.mp4');

    const roots: ShadowRoot[] = [];
    const found = findVideos(document, true, (r) => roots.push(r));
    expect(found).toHaveLength(1);
    expect(found[0]!.inShadowRoot).toBe(true);
    expect(roots).toEqual([outerRoot, innerRoot]);
  });

  it('reaches closed shadow roots through chrome.dom.openOrClosedShadowRoot', () => {
    const host = document.createElement('closed-player');
    document.body.appendChild(host);
    const closed = host.attachShadow({ mode: 'closed' });
    addVideo(closed, 'https://e.com/closed.mp4');
    expect(findVideos(document, true)).toHaveLength(0);

    vi.stubGlobal('chrome', { dom: { openOrClosedShadowRoot: (el: Element) => (el === host ? closed : null) } });
    expect(findVideos(document, true)).toHaveLength(1);
  });
});

describe('describeVideo', () => {
  it('reports source, load errors and MSE codecs', () => {
    const v = addVideo(document.body, 'https://e.com/a.mp4');
    Object.defineProperty(v, 'error', { value: { code: 4 } });
    const info = describeVideo(v, { mseMimeTypes: ['video/mp4; codecs="avc1"'], viewport: { width: 1000, height: 800 } });
    expect(info.src).toBe('https://e.com/a.mp4');
    expect(info.error).toBe(4);
    expect(info.isBlob).toBe(false);
    expect(info.mseMimeTypes).toEqual(['video/mp4; codecs="avc1"']);
    expect(isReportable(v)).toBe(true);
  });

  it('flags blob sources and computes visibility from the bounding box', () => {
    const v = addVideo(document.body, 'blob:https://e.com/123');
    v.getBoundingClientRect = () => ({ width: 640, height: 360, top: 10, left: 10, bottom: 370, right: 650 }) as DOMRect;
    const info = describeVideo(v, { viewport: { width: 1000, height: 800 } });
    expect(info.isBlob).toBe(true);
    expect(info.visible).toBe(true);
    v.getBoundingClientRect = () => ({ width: 640, height: 360, top: 2000, left: 10, bottom: 2360, right: 650 }) as DOMRect;
    expect(describeVideo(v, { viewport: { width: 1000, height: 800 } }).visible).toBe(false);
  });

  it('ignores empty placeholder videos', () => {
    expect(isReportable(addVideo(document.body))).toBe(false);
  });

  it('pauses only playing videos', () => {
    const playing = addVideo(document.body, 'https://e.com/a.mp4');
    const paused = addVideo(document.body, 'https://e.com/b.mp4');
    Object.defineProperty(playing, 'paused', { value: false, configurable: true });
    const spy = vi.spyOn(playing, 'pause').mockImplementation(() => undefined);
    const spy2 = vi.spyOn(paused, 'pause').mockImplementation(() => undefined);
    expect(pauseAll([playing, paused])).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy2).not.toHaveBeenCalled();
  });
});

describe('MAIN-world hooks', () => {
  it('reports MediaSource buffers, EME attachment and shadow roots without changing results', async () => {
    class FakeMediaSource {
      addSourceBuffer(type: string) {
        return { type };
      }
    }
    class FakeAccess {
      keySystem = 'com.widevine.alpha';
      createMediaKeys() {
        return Promise.resolve({ fake: 'keys' });
      }
    }
    const setMediaKeys = vi.fn(() => Promise.resolve());
    const win = window as unknown as Window & typeof globalThis & Record<string, unknown>;
    win.MediaSource = FakeMediaSource as unknown as typeof MediaSource;
    win.MediaKeySystemAccess = FakeAccess as unknown as typeof MediaKeySystemAccess;
    win.HTMLMediaElement.prototype.setMediaKeys = setMediaKeys;
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:https://e.com/ms-1';

    const hints: MainWorldHint[] = [];
    document.addEventListener(MAIN_EVENT, (e) => hints.push(JSON.parse(String((e as CustomEvent).detail))));

    installMainWorldHooks(win);
    installMainWorldHooks(win); // idempotent

    const ms = new FakeMediaSource();
    expect(URL.createObjectURL(ms as unknown as MediaSource)).toBe('blob:https://e.com/ms-1');
    expect(ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"')).toEqual({ type: 'video/mp4; codecs="avc1.64001f"' });

    const keys = await new FakeAccess().createMediaKeys();
    expect(keys).toEqual({ fake: 'keys' });
    await document.createElement('video').setMediaKeys(keys as unknown as MediaKeys);
    expect(setMediaKeys).toHaveBeenCalledOnce();

    document.createElement('div').attachShadow({ mode: 'open' });

    expect(hints).toEqual([
      { type: 'mse', url: 'blob:https://e.com/ms-1', mime: 'video/mp4; codecs="avc1.64001f"' },
      { type: 'eme', keySystem: 'com.widevine.alpha' },
      { type: 'shadow' },
    ]);
    URL.createObjectURL = originalCreate;
  });
});
