import { describe, expect, it } from 'vitest';
import { isPublicAddress, normalizeRemote, redactUrl, validateUpstreamUrl } from '../../apps/companion/src/security.ts';

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

describe('helpers', () => {
  it('normalises mapped IPv4 and redacts queries', () => {
    expect(normalizeRemote('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(redactUrl('https://e.com/a.m3u8?sig=secret')).toBe('https://e.com/a.m3u8?…');
  });
});
