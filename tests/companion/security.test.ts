import { describe, expect, it } from 'vitest';
import {
  controlRequestAllowed,
  isPublicAddress,
  matchesHash,
  normalizeRemote,
  PairingManager,
  redactUrl,
  sha256,
  validateUpstreamUrl,
} from '../../apps/companion/src/security.ts';

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['142.250.74.46', true],
    ['10.0.0.1', false],
    ['172.16.5.4', false],
    ['172.32.0.1', true],
    ['192.168.1.20', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.1.1', false],
    ['0.0.0.0', false],
    ['224.0.0.251', false],
    ['255.255.255.255', false],
    ['2606:4700:4700::1111', true],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd12:3456::1', false],
    ['ff02::1', false],
    ['::ffff:192.168.1.1', false],
    ['::ffff:8.8.8.8', true],
    ['64:ff9b::a00:1', false],
    ['2001:db8::1', false],
    ['not-an-ip', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('validateUpstreamUrl', () => {
  it('accepts public http(s) URLs unchanged', () => {
    const url = 'https://cdn.example.com/v/master.m3u8?Policy=abc&Signature=x%2By';
    expect(validateUpstreamUrl(url, false).href).toBe(url);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/a',
    'http://user:pass@example.com/',
    'http://127.0.0.1:8080/admin',
    'http://[::1]/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3000/',
    'http://printer.local/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => validateUpstreamUrl(url, false)).toThrow();
  });

  it('allows private upstreams only when explicitly enabled', () => {
    expect(validateUpstreamUrl('http://127.0.0.1:8080/a.mp4', true).host).toBe('127.0.0.1:8080');
    expect(() => validateUpstreamUrl('file:///etc/passwd', true)).toThrow();
  });
});

describe('PairingManager', () => {
  it('accepts the issued code once, with or without the dash', () => {
    const p = new PairingManager();
    const code = p.issue(0);
    expect(code).toMatch(/^\d{3}-\d{3}$/);
    expect(p.verify(code.replace('-', ''), 1)).toBe(true);
    expect(p.verify(code, 2)).toBe(false);
  });

  it('burns the code after too many attempts', () => {
    const p = new PairingManager(60_000, 3);
    const code = p.issue(0);
    const wrong = code === '000-000' ? '111-111' : '000-000';
    expect(p.verify(wrong, 1)).toBe(false);
    expect(p.verify(wrong, 2)).toBe(false);
    expect(p.verify(wrong, 3)).toBe(false);
    expect(p.verify(code, 4)).toBe(false);
  });

  it('expires', () => {
    const p = new PairingManager(1000);
    const code = p.issue(0);
    expect(p.verify(code, 1000)).toBe(false);
  });
});

describe('control request checks', () => {
  it('allows the extension and local tools', () => {
    expect(controlRequestAllowed('127.0.0.1:47800', undefined, 47800)).toBe(true);
    expect(controlRequestAllowed('localhost:47800', 'chrome-extension://abcdef', 47800)).toBe(true);
  });

  it('blocks web pages and DNS rebinding', () => {
    expect(controlRequestAllowed('127.0.0.1:47800', 'https://evil.example', 47800)).toBe(false);
    expect(controlRequestAllowed('127.0.0.1:47800', 'null', 47800)).toBe(false);
    expect(controlRequestAllowed('rebind.evil.example:47800', undefined, 47800)).toBe(false);
    expect(controlRequestAllowed(undefined, undefined, 47800)).toBe(false);
  });
});

describe('helpers', () => {
  it('compares secrets against hashes', () => {
    expect(matchesHash('secret', sha256('secret'))).toBe(true);
    expect(matchesHash('other', sha256('secret'))).toBe(false);
  });

  it('normalises mapped IPv4 and redacts queries', () => {
    expect(normalizeRemote('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(redactUrl('https://e.com/a.m3u8?sig=secret')).toBe('https://e.com/a.m3u8?…');
  });
});
