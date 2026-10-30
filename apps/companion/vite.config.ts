// Bundles the companion (and @castit/shared) into one Node ES module, which `npm run setup`
// installs as Chrome's native messaging host. Node built-ins stay external.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: `${here}src/index.ts`,
    outDir: `${here}dist`,
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'castit-companion.mjs' } },
  },
});
