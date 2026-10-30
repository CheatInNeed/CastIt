// Minimal Google Cast (CASTV2) sender channel: TLS to the device (port 8009), 4-byte big-endian
// length-prefixed protobuf CastMessage frames carrying JSON payloads. Only what Castit needs:
// virtual connections, heartbeat, and JSON requests matched by requestId.
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const;

export const PLATFORM = 'receiver-0';
export const SENDER = 'sender-0';

export interface CastMessage {
  source: string;
  destination: string;
  namespace: string;
  /** Parsed JSON payload (binary payloads are ignored). */
  data: Record<string, unknown>;
}

const MAX_FRAME = 64 * 1024;
const HEARTBEAT_MS = 5000;
/** No traffic at all (not even PONG) for this long: the device is gone. */
const DEAD_MS = 20_000;

// ---------------------------------------------------------------- protobuf CastMessage

function varint(n: number): Buffer {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function stringField(field: number, value: string): Buffer {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);
}

/** Encodes one frame: length prefix + CastMessage (protocol_version CASTV2_1_0, STRING payload). */
export function encodeFrame(source: string, destination: string, namespace: string, payload: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // 1: protocol_version = 0
    stringField(2, source),
    stringField(3, destination),
    stringField(4, namespace),
    Buffer.from([0x28, 0x00]), // 5: payload_type = STRING
    stringField(6, payload),
  ]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

/** Decodes a CastMessage body (without the length prefix). */
export function decodeMessage(body: Buffer): { source: string; destination: string; namespace: string; payload?: string } {
  const out = { source: '', destination: '', namespace: '', payload: undefined as string | undefined };
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = body[pos++];
      if (byte === undefined) throw new Error('Truncated Cast message.');
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return result;
      shift += 7;
    }
  };
  while (pos < body.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      const value = body.subarray(pos, pos + len);
      pos += len;
      if (field === 2) out.source = value.toString('utf8');
      else if (field === 3) out.destination = value.toString('utf8');
      else if (field === 4) out.namespace = value.toString('utf8');
      else if (field === 6) out.payload = value.toString('utf8');
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}.`);
    }
  }
  return out;
}

/** Splits a byte stream into frame bodies. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('Cast frame too large.');
      if (this.buffer.length < 4 + len) break;
      frames.push(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
    }
    return frames;
  }
}

// ---------------------------------------------------------------- channel

/**
 * One connection to a Cast device. Emits 'message' (CastMessage) and 'close' (once).
 * Sends CONNECT to the platform receiver on start and keeps the connection alive with PINGs.
 */
export class CastChannel extends EventEmitter {
  private readonly reader = new FrameReader();
  private readonly pending = new Map<number, { resolve: (m: CastMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequestId = 1 + Math.floor(Math.random() * 100_000);
  private lastSeen = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly socket: Duplex;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) return this.close();
      this.send(PLATFORM, NS.heartbeat, { type: 'PING' });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.send(PLATFORM, NS.connection, { type: 'CONNECT' });
  }

  /** Opens a TLS connection (Cast devices use self-signed certificates). */
  static connect(host: string, port: number, timeoutMs = 8000): Promise<CastChannel> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs });
      const fail = (e: Error) => {
        socket.destroy();
        reject(e);
      };
      socket.once('timeout', () => fail(new Error(`The TV at ${host} did not answer.`)));
      socket.once('error', fail);
      socket.once('secureConnect', () => {
        socket.off('error', fail);
        socket.setTimeout(0);
        resolve(new CastChannel(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Local address of the connection (the address the TV can reach this computer on). */
  get localAddress(): string | undefined {
    return (this.socket as Duplex & { localAddress?: string }).localAddress;
  }

  send(destination: string, namespace: string, data: Record<string, unknown>, source = SENDER): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(source, destination, namespace, JSON.stringify(data)));
  }

  /** Sends a request with a fresh requestId without waiting for the reply (it arrives as a 'message'). */
  command(destination: string, namespace: string, data: Record<string, unknown>): void {
    this.send(destination, namespace, { ...data, requestId: this.nextRequestId++ });
  }

  /** Sends a request with a fresh requestId and resolves with the reply carrying the same id. */
  request(destination: string, namespace: string, data: Record<string, unknown>, timeoutMs = 10_000): Promise<CastMessage> {
    if (this.closed) return Promise.reject(new Error('The connection to the TV is closed.'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(destination, namespace, { ...data, requestId });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('The connection to the TV closed.'));
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit('close');
  }

  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    let frames: Buffer[];
    try {
      frames = this.reader.push(chunk);
    } catch {
      return this.close();
    }
    for (const frame of frames) {
      let decoded;
      let data: Record<string, unknown>;
      try {
        decoded = decodeMessage(frame);
        if (decoded.payload === undefined) continue;
        data = JSON.parse(decoded.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (decoded.namespace === NS.heartbeat && data.type === 'PING') {
        this.send(decoded.source, NS.heartbeat, { type: 'PONG' }, decoded.destination);
        continue;
      }
      const message: CastMessage = { source: decoded.source, destination: decoded.destination, namespace: decoded.namespace, data };
      const requestId = typeof data.requestId === 'number' ? data.requestId : 0;
      const waiter = requestId ? this.pending.get(requestId) : undefined;
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(requestId);
        waiter.resolve(message);
      }
      this.emit('message', message);
    }
  }
}
