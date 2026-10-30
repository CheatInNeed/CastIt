// Installs the Castit companion as Chrome's native messaging host, so Chrome starts it by itself
// whenever the extension needs it (no terminal, no pairing). Run via `npm run setup`.
//   ~/.castit/host/castit-companion.mjs  the bundled companion (apps/companion/dist)
//   ~/.castit/host/castit-companion      launcher Chrome runs (pins this Node, adds Homebrew to PATH for FFmpeg)
//   <browser>/NativeMessagingHosts/com.castit.companion.json
//                                        tells the browser that only the Castit extension may start it
// `--uninstall` removes all of it again.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.castit.companion';
const root = fileURLToPath(new URL('..', import.meta.url));
const home = homedir();
const hostDir = join(home, '.castit', 'host');
const uninstall = process.argv.includes('--uninstall');

/** NativeMessagingHosts folders of Chromium-based browsers; only those whose profile folder exists are used. */
const BROWSERS = {
  darwin: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map(
    (p) => join(home, 'Library/Application Support', p),
  ),
  linux: ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map((p) => join(home, '.config', p)),
}[platform()];

if (!BROWSERS) {
  console.error(`Automatic setup supports macOS and Linux; ${platform()} is not supported yet.`);
  process.exit(1);
}

/** Chrome derives an extension's id from the public key in its manifest. */
function extensionId() {
  const { key } = JSON.parse(readFileSync(join(root, 'apps/extension/manifest.json'), 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const browsers = BROWSERS.filter((dir) => existsSync(dir));

if (uninstall) {
  for (const dir of browsers) rmSync(join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`), { force: true });
  rmSync(hostDir, { recursive: true, force: true });
  console.log('Castit companion removed. (Logs remain in ~/.castit; delete that folder to remove everything.)');
  process.exit(0);
}

const bundle = join(root, 'apps/companion/dist/castit-companion.mjs');
if (!existsSync(bundle)) {
  console.error('Build first: npm run build');
  process.exit(1);
}
if (!browsers.length) {
  console.error('No Chrome profile folder found. Start Chrome once, then run npm run setup again.');
  process.exit(1);
}

mkdirSync(hostDir, { recursive: true, mode: 0o700 });
copyFileSync(bundle, join(hostDir, 'castit-companion.mjs'));
const launcher = join(hostDir, 'castit-companion');
// Chrome starts hosts with a minimal PATH; Homebrew's folders make FFmpeg findable.
writeFileSync(
  launcher,
  `#!/bin/sh\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nexec "${process.execPath}" "${join(hostDir, 'castit-companion.mjs')}" "$@"\n`,
);
chmodSync(launcher, 0o755);

const id = extensionId();
const manifest = {
  name: HOST_NAME,
  description: 'Castit companion',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${id}/`],
};
for (const dir of browsers) {
  const file = join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`
Castit is set up.
  Extension : ${join(root, 'apps/extension/dist')}  (chrome://extensions → Developer mode → Load unpacked)
  ID        : ${id}
  Companion : started by Chrome when needed (log: ~/.castit/companion.log)
`);
