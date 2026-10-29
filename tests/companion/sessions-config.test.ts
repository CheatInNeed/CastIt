import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PairingStore, pickLanAddress } from '../../apps/companion/src/config.ts';
import { SessionStore } from '../../apps/companion/src/sessions.ts';

describe('SessionStore', () => {
  const url = new URL('https://cdn.example.com/a.m3u8?sig=secret');

  it('creates unguessable sessions scoped to the upstream origin', () => {
    const store = new SessionStore();
    const s = store.create(url, 'hls', {}, 0);
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect([...s.allowedOrigins]).toEqual(['https://cdn.example.com']);
    expect(store.create(url, 'hls', {}, 0).id).not.toBe(s.id);
  });

  it('expires idle and over-age sessions, refreshing on use', () => {
    const store = new SessionStore({ idleTtlMs: 100, maxTtlMs: 250 });
    const s = store.create(url, 'hls', {}, 0);
    expect(store.use(s.id, 90)).toBeDefined();
    expect(store.use(s.id, 180)).toBeDefined();
    expect(store.use(s.id, 260)).toBeUndefined();
    const t = store.create(url, 'hls', {}, 1000);
    expect(store.use(t.id, 1101)).toBeUndefined();
  });

  it('aborts in-flight upstream requests on delete and evicts the oldest beyond the limit', () => {
    const store = new SessionStore({ maxSessions: 2 });
    const a = store.create(url, 'hls', {}, 0);
    const abort = vi.fn();
    a.active.add(abort);
    store.create(url, 'hls', {}, 1);
    store.create(url, 'hls', {}, 2);
    expect(store.peek(a.id)).toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('lists sessions without query strings', () => {
    const store = new SessionStore();
    store.create(url, 'hls', {}, Date.now());
    expect(store.list()[0]!.upstream).toBe('https://cdn.example.com/a.m3u8?…');
  });
});

describe('pickLanAddress', () => {
  it('prefers a private LAN address on a physical interface', () => {
    const iface = (address: string, internal = false) => ({
      address,
      family: 'IPv4' as const,
      internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    });
    expect(
      pickLanAddress({
        lo0: [iface('127.0.0.1', true)],
        utun3: [iface('10.8.0.2')],
        bridge100: [iface('192.168.64.1')],
        en0: [iface('192.168.1.23')],
      }),
    ).toBe('192.168.1.23');
    expect(pickLanAddress({ lo0: [iface('127.0.0.1', true)] })).toBeUndefined();
  });
});

describe('PairingStore', () => {
  it('persists only key hashes, with private file permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castit-'));
    const store = new PairingStore(dir);
    expect(store.paired).toBe(false);
    store.add('super-secret-key', 'Chrome');
    const raw = readFileSync(join(dir, 'companion.json'), 'utf8');
    expect(raw).not.toContain('super-secret-key');
    expect(statSync(join(dir, 'companion.json')).mode & 0o777).toBe(0o600);
    const reloaded = new PairingStore(dir);
    expect(reloaded.verify('super-secret-key')).toBe(true);
    expect(reloaded.verify('wrong')).toBe(false);
    reloaded.revokeAll();
    expect(new PairingStore(dir).paired).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
