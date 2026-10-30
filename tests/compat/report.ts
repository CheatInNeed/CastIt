// Prints what Castit would show for every recorded real-site capture: npm run compat
import { readdirSync, readFileSync } from 'node:fs';
import { replay, type CompatFixture } from './replay.ts';

const dir = new URL('../fixtures/compat/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as CompatFixture;
  const r = replay(fixture);
  console.log(`\n${fixture.name}  [${fixture.category}]`);
  console.log(`  ${fixture.about}`);
  console.log(`  pre-selected : ${r.main ? `${r.main.label} (${r.main.kind}, ${r.main.level}${r.main.live ? ', LIVE' : ''}${r.main.linked ? ', linked to player' : ''})` : '—'}`);
  if (r.main?.notes.length) console.log(`  notes        : ${r.main.notes.join(' ')}`);
  console.log(`  videos       : ${r.primary.join(', ') || '—'}`);
  console.log(`  other files  : ${r.others.join(', ') || '—'}`);
}
