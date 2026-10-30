// Builds the background service worker (ES module) and the popup page.
// The content script is built separately (vite.content.config.ts) because
// content scripts cannot be ES modules and must not share chunks.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Copies manifest.json and the icons into the build. */
function manifest(): Plugin {
  return {
    name: 'castit-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: readFileSync(`${here}manifest.json`, 'utf8') });
      for (const icon of readdirSync(`${here}icons`)) {
        this.emitFile({ type: 'asset', fileName: `icons/${icon}`, source: readFileSync(`${here}icons/${icon}`) });
      }
    },
  };
}

export default defineConfig({
  root: `${here}src`,
  define: {
    // Lets the popup notice a background worker still running code from an older build.
    __BUILD_ID__: JSON.stringify(String(Date.now())),
  },
  plugins: [manifest()],
  build: {
    outDir: `${here}dist`,
    emptyOutDir: false,
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        background: `${here}src/background.ts`,
        popup: `${here}src/popup/index.html`,
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
