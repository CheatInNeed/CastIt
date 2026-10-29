// Control API contract between the extension and the local companion (http://127.0.0.1:47800).

export const COMPANION_DEFAULT_URL = 'http://127.0.0.1:47800';
export const COMPANION_PROTOCOL = 1;

export interface CompanionHealth {
  name: 'castit-companion';
  version: string;
  protocol: number;
  /** At least one browser has been paired. */
  paired: boolean;
  /** LAN base URL the Chromecast fetches media from. */
  mediaBaseUrl: string;
  ffmpeg: boolean;
}

export interface CompanionPairRequest {
  code: string;
  label?: string;
}

export interface CompanionPairResponse {
  apiKey: string;
}

/**
 * Explicit, per-cast upstream request settings. Cookies and Authorization are never accepted
 * here: the companion never forwards browser credentials.
 */
export interface UpstreamContext {
  referer?: string;
  origin?: string;
  userAgent?: string;
}

export interface CreateSessionRequest {
  url: string;
  kind: 'hls' | 'dash' | 'progressive' | 'unknown';
  context: UpstreamContext;
}

export interface UpstreamCheck {
  ok: boolean;
  status?: number;
  contentType?: string;
  error?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  /** URL to give the Chromecast. */
  mediaUrl: string;
  expiresAt: number;
  check: UpstreamCheck;
}

export interface CompanionSessionInfo {
  sessionId: string;
  /** Upstream origin + path only (query strings are never listed). */
  upstream: string;
  createdAt: number;
  lastUsed: number;
  expiresAt: number;
  boundClient?: string;
  requests: number;
  bytesServed: number;
}

export interface CompanionErrorBody {
  error: string;
  code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'BLOCKED_ADDRESS' | 'NOT_FOUND' | 'PAIRING_FAILED' | 'INTERNAL';
}

/** Extension-side view of the companion, shown in the popup. */
export interface CompanionStatus {
  state: 'offline' | 'unpaired' | 'paired' | 'rejected';
  url: string;
  version?: string;
  mediaBaseUrl?: string;
  error?: string;
}

export type EngineMode = 'auto' | 'direct' | 'companion';
