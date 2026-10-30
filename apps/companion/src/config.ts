// Companion settings (environment variables or command-line flags).
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';

export interface CompanionSettings {
  mediaPort: number;
  /** Interface the media server listens on (the Chromecast must reach it). */
  mediaListenHost: string;
  /** Address put into media URLs for the Chromecast; auto-detected LAN IPv4 by default. */
  publicHost: string;
  /** Allow relaying from private/loopback upstreams (tests, LAN media servers). Off by default. */
  allowPrivateUpstreams: boolean;
  /** Where the log file lives (~/.castit). */
  configDir: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export function settingsFromEnv(env = process.env, argv = process.argv.slice(2)): CompanionSettings {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    mediaPort: Number(arg('media-port') ?? env.CASTIT_MEDIA_PORT ?? 47801),
    mediaListenHost: arg('media-listen') ?? env.CASTIT_MEDIA_LISTEN ?? '0.0.0.0',
    publicHost: arg('public-host') ?? env.CASTIT_PUBLIC_HOST ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1',
    allowPrivateUpstreams: argv.includes('--allow-private') || env.CASTIT_ALLOW_PRIVATE === '1',
    configDir: arg('config-dir') ?? env.CASTIT_HOME ?? join(homedir(), '.castit'),
    ffmpegPath: arg('ffmpeg') ?? env.CASTIT_FFMPEG ?? 'ffmpeg',
    ffprobePath: arg('ffprobe') ?? env.CASTIT_FFPROBE ?? 'ffprobe',
  };
}

const VIRTUAL_IFACE = /^(lo|docker|br-|veth|vbox|vmnet|utun|tun|tap|awdl|llw|bridge|zt|tailscale|wg)/i;

function isPrivateV4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/** Picks the LAN IPv4 a Chromecast on the same network can reach (skips VPN/virtual interfaces). */
export function pickLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) candidates.push({ name, address: info.address });
    }
  }
  const score = (c: { name: string; address: string }) =>
    (isPrivateV4(c.address) ? 2 : 0) + (VIRTUAL_IFACE.test(c.name) ? -3 : 0) + (/^(en|eth|wl|wlan)/i.test(c.name) ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]?.address;
}
