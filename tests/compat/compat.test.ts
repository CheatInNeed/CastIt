// Real-site compatibility: every recorded capture in tests/fixtures/compat must produce the
// expected popup outcome when replayed through Castit's detection, ranking and castability code.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay, type CompatFixture } from './replay.ts';

const dir = new URL('../fixtures/compat/', import.meta.url);
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as CompatFixture);

describe.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
  const result = replay(fixture);
  const all = [...result.primary, ...result.others];

  it(`pre-selects ${fixture.expect.main ?? 'nothing'}`, () => {
    expect(result.main?.label ?? null).toBe(fixture.expect.main);
    if (fixture.expect.mainKind) expect(result.main?.kind).toBe(fixture.expect.mainKind);
    if (fixture.expect.level) expect(result.main?.level).toBe(fixture.expect.level);
    if (fixture.expect.note) expect(result.main?.notes.join(' ')).toMatch(new RegExp(fixture.expect.note, 'i'));
    if (fixture.expect.live !== undefined) expect(result.main?.live).toBe(fixture.expect.live);
  });

  it('lists the right videos and hides stream pieces', () => {
    for (const label of fixture.expect.primary ?? []) expect(result.primary).toContain(label);
    for (const label of fixture.expect.hidden ?? []) expect(all).not.toContain(label);
    if (fixture.expect.mediaSource !== undefined) expect(result.mediaSource).toBe(fixture.expect.mediaSource);
  });
});
