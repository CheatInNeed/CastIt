// Fills in `manifests` of compat fixtures by inspecting each HLS/DASH URL exactly as the
// popup does (fetch without cookies, parse, summarise). Run:
//   node tests/compat/tools/inspect-manifests.ts tests/fixtures/compat/<name>.json …
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyMedia } from '../../../apps/extension/src/lib/media-types.ts';
import { probeStream, summarizeManifest } from '../../../apps/extension/src/lib/probe.ts';

for (const file of process.argv.slice(2)) {
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  fixture.manifests = {};
  for (const r of fixture.requests as Array<{ url: string }>) {
    const kind = classifyMedia(r.url)?.kind;
    if (kind !== 'hls' && kind !== 'dash') continue;
    const probe = await probeStream({ url: r.url, kind });
    const summary = summarizeManifest(kind, probe, 0);
    fixture.manifests[r.url] = summary;
    console.log(`${file.split('/').pop()}: ${kind} ${summary.role ?? '?'} status=${summary.status ?? probe.error} cors=${summary.cors} ${r.url.slice(0, 90)}`);
  }
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}
