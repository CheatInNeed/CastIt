// Extension-side connection to the companion, a native messaging host that Chrome starts when
// Castit connects (installed once with `npm run setup`). Requests carry an id and get one reply;
// events (receiver status, devices) arrive at any time. While the port is open Chrome keeps both
// the companion and this service worker running.
import {
  COMPANION_PROTOCOL,
  NATIVE_HOST_NAME,
  type CompanionErrorCode,
  type CompanionEvent,
  type CompanionHello,
  type CompanionReply,
  type CompanionRequest,
  type CompanionStatus,
  type CreateSessionRequest,
  type CreateSessionResponse,
} from '@castit/shared';

export class CompanionError extends Error {
  readonly code: CompanionErrorCode | 'MISSING' | 'OFFLINE';
  constructor(code: CompanionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const MISSING = 'Castit’s helper is not installed. Run `npm run setup` in the Castit folder once.';

type Hello = Extract<CompanionRequest, { type: 'hello' }>;

let port: chrome.runtime.Port | null = null;
let hello: Promise<CompanionHello> | null = null;
let lastError: CompanionError | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let onEvent: (event: CompanionEvent) => void = () => undefined;
let helloRequest: () => Promise<Hello> = async () => ({ type: 'hello' });

/** Where companion events go (the background registers this once). */
export function setCompanionHandlers(handlers: { event: (event: CompanionEvent) => void; hello: () => Promise<Hello> }): void {
  onEvent = handlers.event;
  helloRequest = handlers.hello;
}

function post(port: chrome.runtime.Port, request: CompanionRequest, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CompanionError('OFFLINE', 'Castit’s helper did not answer.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ ...request, id });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new CompanionError('OFFLINE', String(e)));
    }
  });
}

/** Connects (Chrome starts the companion if needed) and returns its hello. */
export function connectCompanion(): Promise<CompanionHello> {
  if (hello) return hello;
  const opened = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port = opened;
  opened.onMessage.addListener((message: CompanionReply | CompanionEvent) => {
    if ('id' in message) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new CompanionError(message.code, message.error));
      return;
    }
    onEvent(message);
  });
  opened.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? '';
    lastError = /not found|forbidden/i.test(reason)
      ? new CompanionError('MISSING', MISSING)
      : new CompanionError('OFFLINE', `Castit’s helper stopped${reason ? ` (${reason})` : ''}.`);
    if (port === opened) {
      port = null;
      hello = null;
    }
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(lastError);
    }
    pending.clear();
  });
  hello = (async () => {
    const result = (await post(opened, await helloRequest(), 10_000)) as CompanionHello;
    if (result.protocol !== COMPANION_PROTOCOL) {
      throw new CompanionError('OFFLINE', 'Castit’s helper is outdated. Run `npm run setup` again.');
    }
    lastError = null;
    return result;
  })();
  hello.catch(() => {
    if (port === opened) disconnectCompanion();
  });
  return hello;
}

export function disconnectCompanion(): void {
  const current = port;
  port = null;
  hello = null;
  current?.disconnect();
}

export function companionConnected(): boolean {
  return port !== null;
}

export async function companionRequest<T>(request: CompanionRequest, timeoutMs = 15_000): Promise<T> {
  await connectCompanion();
  if (!port) throw lastError ?? new CompanionError('OFFLINE', 'Castit’s helper is not running.');
  return (await post(port, request, timeoutMs)) as T;
}

export async function companionStatus(): Promise<CompanionStatus> {
  try {
    const h = await connectCompanion();
    return { state: 'ready', version: h.version, mediaBaseUrl: h.mediaBaseUrl, ffmpeg: h.ffmpeg, hwEncoder: h.hwEncoder };
  } catch (e) {
    const error = e instanceof CompanionError ? e : (lastError ?? new CompanionError('OFFLINE', String(e)));
    return { state: error.code === 'MISSING' ? 'missing' : 'offline', error: error.message };
  }
}

export function createCompanionSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
  // FFmpeg analysis (when requested) can take a while on slow upstreams.
  return companionRequest<CreateSessionResponse>({ type: 'create-session', request }, request.transcode ? 45_000 : 15_000);
}

export async function deleteCompanionSession(sessionId: string): Promise<void> {
  await companionRequest({ type: 'delete-session', sessionId }, 3000).catch(() => undefined);
}
