import { describe, expect, it } from 'vitest';
import { loadError, sessionError } from '../../apps/controller/src/errors.ts';

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
