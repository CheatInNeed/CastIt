// Builds the extension: background + popup (vite.config.ts), then each content script as a
// self-contained IIFE (content scripts cannot be ES modules or share chunks).
// `--watch` rebuilds on change.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch') ? {} : null;

const contentScripts = [
  { entry: 'src/content.ts', fileName: 'content.js', name: 'CastitContent' },
  { entry: 'src/main-world-entry.ts', fileName: 'main-world.js', name: 'CastitMainWorld' },
];

await rm(`${root}dist`, { recursive: true, force: true });
await build({ configFile: `${root}vite.config.ts`, build: { watch } });
for (const script of contentScripts) {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: `${root}dist`,
      emptyOutDir: false,
      target: 'chrome116',
      watch,
      lib: { entry: `${root}${script.entry}`, formats: ['iife'], name: script.name, fileName: () => script.fileName },
    },
  });
}

if (!watch) console.log(`\nCastit extension built → ${root}dist (load it via chrome://extensions → Load unpacked)`);
