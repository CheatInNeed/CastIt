// Security primitives: tokens, pairing, SSRF protection and request origin checks.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** URL-safe random token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of a secret against a stored SHA-256 hash. */
export function matchesHash(secret: string, hash: string): boolean {
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- pairing

/**
 * One short-lived numeric code shown in the companion's terminal. The user types it into the
 * Castit popup, which exchanges it for a long-lived API key. Few attempts per code, then the
 * code is burned and a new one must be issued from the terminal.
 */
export class PairingManager {
  private code: string | null = null;
  private expiresAt = 0;
  private attempts = 0;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(ttlMs = 10 * 60_000, maxAttempts = 5) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
  }

  issue(now = Date.now()): string {
    const digits = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = digits;
    this.expiresAt = now + this.ttlMs;
    this.attempts = 0;
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }

  get active(): boolean {
    return this.code !== null && Date.now() < this.expiresAt;
  }

  verify(input: string, now = Date.now()): boolean {
    if (!this.code || now >= this.expiresAt) {
      this.code = null;
      return false;
    }
    this.attempts++;
    const candidate = String(input).replace(/\D/g, '');
    const ok = candidate.length === 6 && timingSafeEqual(Buffer.from(candidate), Buffer.from(this.code));
    if (ok || this.attempts >= this.maxAttempts) this.code = null;
    return ok;
  }
}

// ---------------------------------------------------------------- SSRF protection

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPublicV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 hextets. */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip.split('%')[0]!.toLowerCase();
  // Trailing embedded IPv4 (e.g. ::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t].map((p) => parseInt(p || '0', 16));
  return parts.length === 8 && parts.every((p) => Number.isFinite(p)) ? parts : null;
}

function isPublicV6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const [a, b] = h as [number, number, ...number[]];
  if (h.every((x) => x === 0)) return false; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return false; // ::1
  // IPv4-mapped / translated: judge the embedded IPv4 address.
  const embedded = `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPublicV4(embedded);
  if (a === 0x64 && b === 0xff9b) return isPublicV4(embedded);
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  return true;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip.split('%')[0]!);
  if (version === 4) return isPublicV4(ip);
  if (version === 6) return isPublicV6(ip);
  return false;
}

export class UpstreamBlockedError extends Error {
  readonly code = 'BLOCKED_ADDRESS';
}

/**
 * Validates a URL the companion is asked to fetch: http(s) only, no embedded credentials,
 * and (unless private upstreams are explicitly allowed) no private/loopback IP literals.
 * Host names are checked again at connect time by `guardedLookup`, which also defeats DNS
 * rebinding because the address that was checked is the address that is used.
 */
export function validateUpstreamUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamBlockedError('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamBlockedError('Only http(s) URLs can be relayed.');
  if (url.username || url.password) throw new UpstreamBlockedError('URLs with embedded credentials are not relayed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (isIP(host) && !isPublicAddress(host)) throw new UpstreamBlockedError(`${host} is a private or reserved address.`);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new UpstreamBlockedError(`${host} is a local host name.`);
    }
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup replacement for http.request that refuses private/reserved addresses. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const allowed = addresses.filter((a) => allowPrivate || isPublicAddress(a.address));
      if (allowed.length === 0) {
        return callback(new UpstreamBlockedError(`${hostname} resolves to a private or reserved address.`), []);
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

// ---------------------------------------------------------------- control API request checks

/**
 * Defeats DNS-rebinding and drive-by requests from web pages against the localhost control API:
 * the Host must be the loopback address we listen on, and a browser Origin, if present, must be
 * an extension.
 */
export function controlRequestAllowed(host: string | undefined, origin: string | undefined, port: number): boolean {
  const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host || !okHosts.includes(host.toLowerCase())) return false;
  if (origin && origin !== 'null' && !origin.startsWith('chrome-extension://')) return false;
  if (origin === 'null') return false;
  return true;
}

/** Normalises ::ffff:1.2.3.4 to 1.2.3.4. */
export function normalizeRemote(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

/** Addresses of this computer (loopback + every interface), refreshed at most once a minute. */
let ownCache: { at: number; addresses: Set<string> } | undefined;
export function isThisMachine(address: string, now = Date.now()): boolean {
  if (isLoopback(address)) return true;
  if (!ownCache || now - ownCache.at > 60_000) {
    const addresses = new Set<string>();
    for (const infos of Object.values(networkInterfaces())) for (const info of infos ?? []) addresses.add(info.address);
    ownCache = { at: now, addresses };
  }
  return ownCache.addresses.has(address);
}

/** Removes query strings (often signatures) from URLs before logging or listing them. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
