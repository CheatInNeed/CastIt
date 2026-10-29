import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from any static path (e.g. GitHub Pages /castit/).
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { target: 'chrome116' },
});
