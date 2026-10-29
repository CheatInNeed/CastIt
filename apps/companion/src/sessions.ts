// Media sessions: one per cast. A session id is an unguessable capability that appears in the
// media URLs given to the Chromecast; it expires when idle and after a hard maximum lifetime.
import type { CompanionSessionInfo, UpstreamContext } from '@castit/shared';
import { randomToken, redactUrl } from './security.ts';

export interface MediaSession {
  id: string;
  upstreamUrl: string;
  kind: string;
  context: UpstreamContext;
  /** Upstream origins (scheme://host:port) this session may fetch from. */
  allowedOrigins: Set<string>;
  createdAt: number;
  lastUsed: number;
  /** Hard expiry (absolute). */
  expiresAt: number;
  /** The first non-loopback client to use the session (normally the Chromecast). */
  boundClient?: string;
  /** Abort functions of in-flight upstream requests. */
  active: Set<() => void>;
  requests: number;
  bytesServed: number;
}

export interface SessionStoreOptions {
  idleTtlMs: number;
  maxTtlMs: number;
  maxSessions: number;
}

export const DEFAULT_SESSION_OPTIONS: SessionStoreOptions = {
  idleTtlMs: 30 * 60_000,
  maxTtlMs: 12 * 60 * 60_000,
  maxSessions: 16,
};

export function originOf(url: URL | string): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  return `${u.protocol}//${u.host}`;
}

export class SessionStore {
  private readonly sessions = new Map<string, MediaSession>();
  private readonly options: SessionStoreOptions;
  /** Called whenever a session ends (deleted, expired or evicted), e.g. to stop its FFmpeg job. */
  onDelete?: (id: string) => void;

  constructor(options: Partial<SessionStoreOptions> = {}) {
    this.options = { ...DEFAULT_SESSION_OPTIONS, ...options };
  }

  create(upstream: URL, kind: string, context: UpstreamContext, now = Date.now()): MediaSession {
    this.sweep(now);
    // Keep the newest sessions when the limit is reached.
    while (this.sessions.size >= this.options.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      this.delete(oldest.id);
    }
    const session: MediaSession = {
      id: randomToken(24),
      upstreamUrl: upstream.href,
      kind,
      context,
      allowedOrigins: new Set([originOf(upstream)]),
      createdAt: now,
      lastUsed: now,
      expiresAt: now + this.options.maxTtlMs,
      active: new Set(),
      requests: 0,
      bytesServed: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Returns a live session (refreshing its idle timer), or undefined if unknown/expired. */
  use(id: string, now = Date.now()): MediaSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.expired(session, now)) {
      this.delete(id);
      return undefined;
    }
    session.lastUsed = now;
    return session;
  }

  peek(id: string): MediaSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    for (const abort of session.active) abort();
    session.active.clear();
    this.sessions.delete(id);
    this.onDelete?.(id);
    return true;
  }

  sweep(now = Date.now()): void {
    for (const session of this.sessions.values()) if (this.expired(session, now)) this.delete(session.id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }

  idleExpiry(session: MediaSession): number {
    return Math.min(session.lastUsed + this.options.idleTtlMs, session.expiresAt);
  }

  list(now = Date.now()): CompanionSessionInfo[] {
    this.sweep(now);
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      upstream: redactUrl(s.upstreamUrl),
      createdAt: s.createdAt,
      lastUsed: s.lastUsed,
      expiresAt: this.idleExpiry(s),
      boundClient: s.boundClient,
      requests: s.requests,
      bytesServed: s.bytesServed,
    }));
  }

  private expired(session: MediaSession, now: number): boolean {
    return now >= session.expiresAt || now - session.lastUsed >= this.options.idleTtlMs;
  }
}
