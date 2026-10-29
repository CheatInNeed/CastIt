// Extension-side client for the local companion's control API.
import {
  COMPANION_DEFAULT_URL,
  COMPANION_PROTOCOL,
  type CompanionErrorBody,
  type CompanionHealth,
  type CompanionStatus,
  type CreateSessionRequest,
  type CreateSessionResponse,
} from '@castit/shared';

export interface CompanionConfig {
  url: string;
  apiKey?: string;
}

const STORAGE_KEY = 'companion';

export async function loadCompanionConfig(): Promise<CompanionConfig> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as CompanionConfig | undefined;
  return { url: stored?.url ?? COMPANION_DEFAULT_URL, apiKey: stored?.apiKey };
}

export async function saveCompanionConfig(config: CompanionConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export class CompanionError extends Error {
  readonly status: number;
  readonly code: CompanionErrorBody['code'] | 'OFFLINE';
  constructor(status: number, code: CompanionError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(config: CompanionConfig, path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${path}`, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });
  } catch (e) {
    throw new CompanionError(0, 'OFFLINE', `The local companion is not running at ${config.url}.`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & Partial<CompanionErrorBody>;
  if (!res.ok) throw new CompanionError(res.status, body.code ?? 'INTERNAL', body.error ?? `Companion answered HTTP ${res.status}.`);
  return body;
}

export async function companionStatus(config: CompanionConfig): Promise<CompanionStatus> {
  let health: CompanionHealth;
  try {
    health = await call<CompanionHealth>(config, '/api/health', {}, 1500);
  } catch (e) {
    return { state: 'offline', url: config.url, error: (e as Error).message };
  }
  const base = { url: config.url, version: health.version, mediaBaseUrl: health.mediaBaseUrl };
  if (health.name !== 'castit-companion' || health.protocol !== COMPANION_PROTOCOL) {
    return { ...base, state: 'offline', error: 'Incompatible companion version.' };
  }
  if (!config.apiKey) return { ...base, state: 'unpaired' };
  try {
    await call(config, '/api/sessions', {}, 1500);
    return { ...base, state: 'paired' };
  } catch (e) {
    if (e instanceof CompanionError && e.status === 401) return { ...base, state: 'rejected', error: 'Pairing was revoked; pair again.' };
    return { ...base, state: 'offline', error: (e as Error).message };
  }
}

export async function pairCompanion(config: CompanionConfig, code: string): Promise<CompanionConfig> {
  const { apiKey } = await call<{ apiKey: string }>(config, '/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code, label: `Chrome (${navigator.platform || 'unknown'})` }),
  });
  const next = { ...config, apiKey };
  await saveCompanionConfig(next);
  return next;
}

export function createCompanionSession(config: CompanionConfig, request: CreateSessionRequest): Promise<CreateSessionResponse> {
  return call<CreateSessionResponse>(config, '/api/sessions', { method: 'POST', body: JSON.stringify(request) });
}

export async function deleteCompanionSession(config: CompanionConfig, sessionId: string): Promise<void> {
  await call(config, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, 3000).catch(() => undefined);
}
