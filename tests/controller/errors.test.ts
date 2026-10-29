import { describe, expect, it } from 'vitest';
import { decodeEntities, loadError, sessionError } from '../../apps/controller/src/errors.ts';

describe('Cast SDK error mapping', () => {
  it('maps session errors to specific codes', () => {
    expect(sessionError('cancel').code).toBe('SESSION_CANCELLED');
    expect(sessionError('receiver_unavailable').code).toBe('NO_DEVICE');
  });

  it('maps load errors with an actionable explanation', () => {
    const e = loadError('load_media_failed');
    expect(e.code).toBe('RECEIVER_LOAD_FAILED');
    expect(e.detail).toMatch(/CORS/);
    expect(loadError('timeout').code).toBe('PLAYBACK_TIMEOUT');
    expect(loadError('something_new').detail).toBe('something_new');
  });
});

describe('decodeEntities', () => {
  it('turns HTML-escaped Cast device names into plain text', () => {
    expect(decodeEntities('Peter&#39;s TV')).toBe("Peter's TV");
    expect(decodeEntities('Tom &amp; Jerry&#x2019;s &quot;TV&quot;')).toBe('Tom & Jerry\u2019s "TV"');
    expect(decodeEntities('Living Room')).toBe('Living Room');
    expect(decodeEntities('&bogus; &#0;')).toBe('&bogus; &#0;');
    expect(decodeEntities(undefined)).toBeUndefined();
  });
});
