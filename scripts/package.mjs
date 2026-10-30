// Production build: npm run package -- --controller https://<you>.github.io/castit/
// Builds the controller and the extension for that controller address, then zips the extension
// into release/castit-extension-<version>.zip (load the unzipped folder, or upload the zip to the
// Chrome Web Store dashboard).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const controller = argv[argv.indexOf('--controller') + 1] ?? process.env.CASTIT_CONTROLLER_URL;

if (!controller || argv.indexOf('--controller') === -1 && !process.env.CASTIT_CONTROLLER_URL) {
  console.error('Usage: npm run package -- --controller https://<you>.github.io/castit/');
  process.exit(1);
}
let url;
try {
  url = new URL(controller);
} catch {
  console.error(`Not a valid URL: ${controller}`);
  process.exit(1);
}
const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
if (url.protocol !== 'https:' && !local) {
  console.error('The controller must be served over HTTPS (the Cast SDK and extension messaging require a secure page).');
  process.exit(1);
}
if (!url.pathname.endsWith('/')) url.pathname += '/';

const env = { ...process.env, CASTIT_CONTROLLER_URL: url.href };
const run = (args) => execFileSync('npm', args, { cwd: root, env, stdio: 'inherit' });
run(['run', 'build', '-w', '@castit/controller']);
run(['run', 'build', '-w', '@castit/extension']);

const { version } = JSON.parse(readFileSync(`${root}apps/extension/manifest.json`, 'utf8'));
mkdirSync(`${root}release`, { recursive: true });
const zip = `${root}release/castit-extension-${version}.zip`;
rmSync(zip, { force: true });
const zipped = spawnSync('zip', ['-qr', zip, '.'], { cwd: `${root}apps/extension/dist`, stdio: 'inherit' });

console.log(`
Castit ${version} built for controller ${url.href}
  extension : apps/extension/dist${zipped.status === 0 ? `\n  zip       : release/castit-extension-${version}.zip` : '  (zip not available on this system; load the folder instead)'}
  controller: apps/controller/dist  → publish this folder at ${url.href}
`);
