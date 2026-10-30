// Finds Cast devices on the local network with mDNS (_googlecast._tcp.local), the same way
// Chrome does. Audio-only devices and speaker groups are left out: they cannot show video.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import type { CastDeviceInfo } from '@castit/shared';

const SERVICE = '_googlecast._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;
/** Ask again this often; devices not heard from in FORGET_MS are dropped. */
const QUERY_INTERVAL_MS = 60_000;
const FORGET_MS = 4 * QUERY_INTERVAL_MS;

export function buildQuery(): Buffer {
  const labels = SERVICE.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // id 0, flags 0, 1 question
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, TYPE.PTR, 0, 1])]);
}

function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[pos];
    if (len === undefined) throw new Error('Truncated name.');
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!;
      continue;
    }
    if (len === 0) return [labels.join('.'), next < 0 ? pos + 1 : next];
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('Name compression loop.');
}

export interface MdnsRecords {
  /** PTR targets of the Cast service (instance names). */
  instances: string[];
  srv: Map<string, { target: string; port: number }>;
  txt: Map<string, Record<string, string>>;
  a: Map<string, string>;
}

/** Parses the answer, authority and additional records of one mDNS packet. */
export function parseRecords(buf: Buffer): MdnsRecords {
  const records: MdnsRecords = { instances: [], srv: new Map(), txt: new Map(), a: new Map() };
  const questions = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < questions; i++) pos = readName(buf, pos)[1] + 4;
  for (let i = 0; i < total; i++) {
    const [name, after] = readName(buf, pos);
    const type = buf.readUInt16BE(after);
    const length = buf.readUInt16BE(after + 8);
    const data = after + 10;
    const lower = name.toLowerCase();
    if (type === TYPE.PTR && lower === SERVICE) {
      records.instances.push(readName(buf, data)[0]);
    } else if (type === TYPE.SRV) {
      records.srv.set(lower, { port: buf.readUInt16BE(data + 4), target: readName(buf, data + 6)[0].toLowerCase() });
    } else if (type === TYPE.TXT) {
      const kv: Record<string, string> = {};
      for (let p = data; p < data + length; ) {
        const len = buf[p]!;
        const entry = buf.toString('utf8', p + 1, p + 1 + len);
        const eq = entry.indexOf('=');
        if (eq > 0) kv[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
        p += 1 + len;
      }
      records.txt.set(lower, kv);
    } else if (type === TYPE.A && length === 4) {
      records.a.set(lower, Array.from(buf.subarray(data, data + 4)).join('.'));
    }
    pos = data + length;
  }
  return records;
}

/** Whether a device can show video (TXT ca bit 0 = video out); speaker groups cannot. */
export function isVideoDevice(txt: Record<string, string>): boolean {
  if (/cast group/i.test(txt.md ?? '')) return false;
  const ca = Number(txt.ca);
  return !txt.ca || !Number.isFinite(ca) || (ca & 1) === 1;
}

interface Known extends CastDeviceInfo {
  seenAt: number;
}

/** Emits 'change' with the current device list whenever it changes. */
export class Discovery extends EventEmitter {
  /** One socket per LAN interface, each on a random port (see query()). */
  private readonly sockets = new Map<string, dgram.Socket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly known = new Map<string, Known>();
  /** Records collected across packets (SRV/TXT/A may arrive separately from the PTR). */
  private readonly srv = new Map<string, { target: string; port: number }>();
  private readonly txt = new Map<string, Record<string, string>>();
  private readonly a = new Map<string, string>();
  private readonly instances = new Set<string>();

  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void = () => undefined) {
    super();
    this.log = log;
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    setTimeout(() => this.query(), 3000).unref?.();
    this.timer = setInterval(() => {
      this.prune();
      this.query();
    }, QUERY_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
  }

  devices(): CastDeviceInfo[] {
    return [...this.known.values()]
      .map(({ seenAt: _, ...device }) => device)
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Asks the network again (e.g. when the popup opens); answers arrive within a second. */
  refresh(): void {
    this.query();
    setTimeout(() => this.query(), 1000).unref?.();
  }

  /**
   * Queries from a random port on each interface. Responders then answer by unicast to that port
   * ("legacy unicast", RFC 6762 §6.7), so Castit needn't share port 5353 with the system's own
   * mDNS responder (which Node cannot do on macOS).
   */
  private query(): void {
    const addresses = lanAddresses();
    for (const [address, socket] of this.sockets) {
      if (!addresses.includes(address)) {
        socket.close();
        this.sockets.delete(address);
      }
    }
    for (const address of addresses) {
      const existing = this.sockets.get(address);
      if (existing) {
        existing.send(buildQuery(), MDNS_PORT, MDNS_ADDRESS, () => undefined);
        continue;
      }
      const socket = dgram.createSocket('udp4');
      this.sockets.set(address, socket);
      socket.on('message', (msg) => this.onPacket(msg));
      socket.on('error', (e) => {
        this.log(`device discovery on ${address} failed: ${e.message}`);
        socket.close();
        if (this.sockets.get(address) === socket) this.sockets.delete(address);
      });
      socket.bind(0, address, () => {
        socket.setMulticastInterface(address);
        socket.send(buildQuery(), MDNS_PORT, MDNS_ADDRESS, () => undefined);
      });
    }
  }

  private onPacket(packet: Buffer): void {
    let records: MdnsRecords;
    try {
      if (packet.length < 12 || !(packet.readUInt16BE(2) & 0x8000)) return; // responses only
      records = parseRecords(packet);
    } catch {
      return;
    }
    for (const [k, v] of records.srv) this.srv.set(k, v);
    for (const [k, v] of records.txt) this.txt.set(k, v);
    for (const [k, v] of records.a) this.a.set(k, v);
    for (const instance of records.instances) this.instances.add(instance.toLowerCase());
    // Only devices this packet speaks about count as seen now.
    const touched = new Set([...records.instances.map((i) => i.toLowerCase()), ...records.srv.keys(), ...records.txt.keys()]);
    for (const instance of this.instances) {
      if (records.a.has(this.srv.get(instance)?.target ?? '')) touched.add(instance);
    }
    if (touched.size) this.resolve(touched);
  }

  private resolve(touched: Set<string>): void {
    let changed = false;
    const now = Date.now();
    for (const instance of touched) {
      if (!this.instances.has(instance)) continue;
      const srv = this.srv.get(instance);
      const txt = this.txt.get(instance);
      const host = srv && this.a.get(srv.target);
      if (!srv || !txt || !host || !isVideoDevice(txt)) continue;
      const id = txt.id ?? instance;
      const device: Known = { id, name: txt.fn || instance.split('.')[0]!, model: txt.md, host, port: srv.port, seenAt: now };
      const previous = this.known.get(id);
      if (!previous || previous.host !== device.host || previous.port !== device.port || previous.name !== device.name) changed = true;
      this.known.set(id, device);
    }
    if (changed) this.emit('change', this.devices());
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.known) {
      if (now - device.seenAt > FORGET_MS) {
        this.known.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change', this.devices());
  }
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
