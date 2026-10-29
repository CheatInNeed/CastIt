// Castit MAIN-world hooks. Runs at document_start in the page's own JavaScript world (every frame)
// and only *observes* a few media APIs, reporting hints to the isolated content script:
//   - MediaSource: which blob: URL belongs to a MediaSource and which SourceBuffer MIME types
//     (codecs) the player adds, so blob: players can be described and matched.
//   - EME: which key system a player actually attaches to a media element (a DRM signal).
//     Only the key-system name is read; keys, licenses and media data are never touched.
//   - attachShadow: a cue to rescan, since videos inside shadow roots are invisible to normal queries.
// Every wrapper calls the original first-class API unchanged and swallows its own errors.
// Messages are CustomEvents on `document` carrying JSON strings; a page could forge them, which
// only affects how Castit describes that page's own media.

export const MAIN_EVENT = 'castit:main';

export type MainWorldHint =
  | { type: 'mse'; url?: string; mime: string }
  | { type: 'eme'; keySystem: string }
  | { type: 'shadow' };

export function installMainWorldHooks(win: Window & typeof globalThis = window): void {
  const flag = '__castitMainWorld';
  if ((win as unknown as Record<string, unknown>)[flag]) return;
  Object.defineProperty(win, flag, { value: true });

  const emit = (hint: MainWorldHint) => {
    try {
      win.document.dispatchEvent(new win.CustomEvent(MAIN_EVENT, { detail: JSON.stringify(hint) }));
    } catch {
      /* never break the page */
    }
  };

  const MS = win.MediaSource;
  const mediaSourceUrls = new WeakMap<object, string>();

  if (MS && win.URL?.createObjectURL) {
    const createObjectURL = win.URL.createObjectURL;
    win.URL.createObjectURL = function (this: unknown, obj: Blob | MediaSource) {
      const url = createObjectURL.call(win.URL, obj);
      try {
        if (obj instanceof MS) mediaSourceUrls.set(obj, url);
      } catch {
        /* ignore */
      }
      return url;
    } as typeof URL.createObjectURL;

    const addSourceBuffer = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (this: MediaSource, type: string) {
      const buffer = addSourceBuffer.call(this, type);
      emit({ type: 'mse', url: mediaSourceUrls.get(this), mime: String(type) });
      return buffer;
    };
  }

  const Access = win.MediaKeySystemAccess;
  const Media = win.HTMLMediaElement;
  if (Access && Media?.prototype.setMediaKeys) {
    // Players often *probe* every key system at startup, so requestMediaKeySystemAccess alone
    // would flag clear content. Only attaching MediaKeys to an element counts as DRM use.
    const keySystems = new WeakMap<object, string>();
    const createMediaKeys = Access.prototype.createMediaKeys;
    Access.prototype.createMediaKeys = function (this: MediaKeySystemAccess) {
      const keySystem = this.keySystem;
      return createMediaKeys.call(this).then((keys) => {
        try {
          keySystems.set(keys, keySystem);
        } catch {
          /* ignore */
        }
        return keys;
      });
    };
    const setMediaKeys = Media.prototype.setMediaKeys;
    Media.prototype.setMediaKeys = function (this: HTMLMediaElement, keys: MediaKeys | null) {
      if (keys) emit({ type: 'eme', keySystem: keySystems.get(keys) ?? 'unknown' });
      return setMediaKeys.call(this, keys);
    };
  }

  const attachShadow = win.Element?.prototype.attachShadow;
  if (attachShadow) {
    let last = 0;
    win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = attachShadow.call(this, init);
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        emit({ type: 'shadow' });
      }
      return root;
    };
  }
}
