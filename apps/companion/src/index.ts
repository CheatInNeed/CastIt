// CLI entry point: `npm run companion` (add `-- --pair` to pair another browser).
import { settingsFromEnv } from './config.ts';
import { startCompanion, VERSION } from './server.ts';

const settings = settingsFromEnv();
const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  console.log(`Castit companion ${VERSION}

Options:
  --pair                 Show a new pairing code even if a browser is already paired
  --unpair-all           Forget every paired browser, then show a pairing code
  --public-host <ip>     Address the Chromecast uses to reach this computer (default: auto LAN IPv4)
  --media-port <port>    LAN media port (default 47801)
  --control-port <port>  Localhost control port (default 47800)
  --allow-private        Allow relaying from private/LAN upstream servers (off by default)
  --config-dir <dir>     Where pairing data is stored (default ~/.castit)`);
  process.exit(0);
}

const companion = await startCompanion(settings).catch((e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port already in use (${e.message}). Is the companion already running?`);
  else console.error(e);
  process.exit(1);
});

if (argv.includes('--unpair-all')) companion.store.revokeAll();

console.log(`
Castit companion ${VERSION}
  control API : ${companion.controlUrl}  (this computer only)
  media server: ${companion.mediaBaseUrl}  (Chromecast fetches from here)`);
if (settings.allowPrivateUpstreams) console.log('  WARNING: --allow-private is on; LAN/loopback upstreams can be relayed.');

if (!companion.store.paired || argv.includes('--pair') || argv.includes('--unpair-all')) {
  const code = companion.pairing.issue();
  console.log(`
  Pairing code: ${code}   (valid 10 minutes, 5 attempts)
  Open the Castit popup → Companion → enter this code.
`);
} else {
  console.log('\n  Already paired. Run with --pair to pair another browser.\n');
}

const shutdown = async () => {
  console.log('\nStopping companion…');
  await companion.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
