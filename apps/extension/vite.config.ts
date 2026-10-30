// Builds the background service worker (ES module) and the popup page.
// The content script is built separately (vite.content.config.ts) because
// content scripts cannot be ES modules and must not share chunks.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
export const controllerUrl = process.env.CASTIT_CONTROLLER_URL ?? 'http://localhost:5173/';

/** Emits manifest.json with externally_connectable limited to the controller origin. */
function manifest(): Plugin {
  return {
    name: 'castit-manifest',
    generateBundle() {
      const json = JSON.parse(readFileSync(`${here}manifest.json`, 'utf8'));
      json.externally_connectable = { matches: [`${new URL(controllerUrl).origin}/*`] };
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(json, null, 2) });
      for (const icon of readdirSync(`${here}icons`)) {
        this.emitFile({ type: 'asset', fileName: `icons/${icon}`, source: readFileSync(`${here}icons/${icon}`) });
      }
    },
  };
}

export default defineConfig({
  root: `${here}src`,
  define: {
    __CONTROLLER_URL__: JSON.stringify(controllerUrl),
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
