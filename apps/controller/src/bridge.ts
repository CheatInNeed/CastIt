// Connection from the controller page to the Castit extension.
// Chrome exposes chrome.runtime.connect(extensionId) to web pages only when the page's origin is
// listed in the extension's externally_connectable. The extension additionally checks the
// origin and a per-browser-session pairing token passed in the URL fragment (never sent to a server).
import {
  CONTROLLER_PORT_NAME,
  PROTOCOL_VERSION,
  type BackgroundToController,
  type ControllerToBackground,
} from '@castit/shared';

export type BridgeState = 'connecting' | 'connected' | 'unavailable' | 'rejected';

export class ExtensionBridge {
  private port: chrome.runtime.Port | null = null;
  private attempts = 0;
  private state: BridgeState = 'connecting';

  constructor(
    private readonly extensionId: string | null,
    private readonly token: string | null,
    private readonly onMessage: (message: BackgroundToController) => void,
    private readonly onState: (state: BridgeState, detail?: string) => void,
  ) {}

  connect(): void {
    if (!this.extensionId || !this.token) {
      return this.setState('unavailable', 'Open this page from the Castit popup so it can pair with the extension.');
    }
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.connect) {
      return this.setState(
        'unavailable',
        'The Castit extension is not reachable from this origin. Is it installed and built for this controller URL?',
      );
    }

    let port: chrome.runtime.Port;
    try {
      port = runtime.connect(this.extensionId, { name: CONTROLLER_PORT_NAME });
    } catch (e) {
      return this.setState('unavailable', `Cannot connect to the extension: ${String(e)}`);
    }
    this.port = port;

    port.onMessage.addListener((message: BackgroundToController) => {
      if (message.type === 'controller/rejected') {
        this.setState('rejected', message.reason);
        return;
      }
      if (message.type === 'controller/welcome') {
        this.attempts = 0;
        this.setState('connected');
      }
      this.onMessage(message);
    });

    // The extension's service worker may be suspended or restarted at any time; reconnect.
    port.onDisconnect.addListener(() => {
      void runtime.lastError;
      if (this.port === port) this.port = null;
      if (this.state === 'rejected') return;
      this.setState('connecting');
      const delay = Math.min(500 * 2 ** this.attempts++, 10_000);
      setTimeout(() => this.connect(), delay);
    });

    port.postMessage({ type: 'controller/hello', token: this.token, version: PROTOCOL_VERSION } satisfies ControllerToBackground);
  }

  send(message: ControllerToBackground): void {
    try {
      this.port?.postMessage(message);
    } catch {
      this.port = null;
    }
  }

  private setState(state: BridgeState, detail?: string): void {
    this.state = state;
    this.onState(state, detail);
  }
}

/** Reads ?ext=<id> and #token=<token> (persisted for reloads of this tab). */
export function pairingFromLocation(): { extensionId: string | null; token: string | null } {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const extensionId = params.get('ext') ?? sessionStorage.getItem('castit.ext');
  const token = hash.get('token') ?? sessionStorage.getItem('castit.token');
  if (extensionId) sessionStorage.setItem('castit.ext', extensionId);
  if (token) sessionStorage.setItem('castit.token', token);
  return { extensionId, token };
}
