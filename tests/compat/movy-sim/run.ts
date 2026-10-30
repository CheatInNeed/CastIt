// npm run compat:site — starts the movy-like test site on this computer's LAN address.
import { networkInterfaces } from 'node:os';
import { pickLanAddress } from '../../../apps/companion/src/config.ts';
import { startSim } from './server.ts';

const host = process.env.CASTIT_SIM_HOST ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1';
const sim = await startSim({ host });
console.log(`
Castit test site (movy-like) is running:
  open       ${sim.site}/watch/1
  player     ${sim.player}   (embedded, different origin)
  video CDN  ${sim.cdn}      (signed links, Referer + CORS limited to the player)

The CDN rejects the Chromecast's direct requests on purpose. Run the companion with
--allow-private (this CDN is on your LAN) so Castit can relay with the player's Referer:
  npm run companion -- --allow-private
Ctrl-C to stop.
`);
process.on('SIGINT', () => void sim.close().then(() => process.exit(0)));
