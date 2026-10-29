// Companion settings (env/CLI) and the persisted pairing store (~/.castit/companion.json).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { matchesHash, sha256 } from './security.ts';

export interface CompanionSettings {
  controlPort: number;
  mediaPort: number;
  /** Interface the media server listens on (the Chromecast must reach it). */
  mediaListenHost: string;
  /** Address put into media URLs for the Chromecast; auto-detected LAN IPv4 by default. */
  publicHost: string;
  /** Allow relaying from private/loopback upstreams (tests, LAN media servers). Off by default. */
  allowPrivateUpstreams: boolean;
  configDir: string;
}

export function settingsFromEnv(env = process.env, argv = process.argv.slice(2)): CompanionSettings {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    controlPort: Number(arg('control-port') ?? env.CASTIT_CONTROL_PORT ?? 47800),
    mediaPort: Number(arg('media-port') ?? env.CASTIT_MEDIA_PORT ?? 47801),
    mediaListenHost: arg('media-listen') ?? env.CASTIT_MEDIA_LISTEN ?? '0.0.0.0',
    publicHost: arg('public-host') ?? env.CASTIT_PUBLIC_HOST ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1',
    allowPrivateUpstreams: argv.includes('--allow-private') || env.CASTIT_ALLOW_PRIVATE === '1',
    configDir: arg('config-dir') ?? env.CASTIT_HOME ?? join(homedir(), '.castit'),
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

// ---------------------------------------------------------------- paired clients

interface StoredKey {
  hash: string;
  label: string;
  createdAt: number;
}

interface StoredConfig {
  version: 1;
  apiKeys: StoredKey[];
}

/** API keys are stored only as SHA-256 hashes; the file is created with 0600 permissions. */
export class PairingStore {
  private readonly file: string;
  private data: StoredConfig;

  constructor(configDir: string) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    this.file = join(configDir, 'companion.json');
    this.data = this.load();
  }

  get paired(): boolean {
    return this.data.apiKeys.length > 0;
  }

  add(apiKey: string, label: string): void {
    this.data.apiKeys.push({ hash: sha256(apiKey), label: label.slice(0, 80), createdAt: Date.now() });
    this.save();
  }

  verify(apiKey: string | undefined): boolean {
    if (!apiKey) return false;
    return this.data.apiKeys.some((k) => matchesHash(apiKey, k.hash));
  }

  revokeAll(): void {
    this.data.apiKeys = [];
    this.save();
  }

  private load(): StoredConfig {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoredConfig;
      if (parsed.version === 1 && Array.isArray(parsed.apiKeys)) return parsed;
    } catch {
      /* first run or unreadable: start empty */
    }
    return { version: 1, apiKeys: [] };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
