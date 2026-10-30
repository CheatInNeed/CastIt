// The companion's own Cast sender: protocol framing, mDNS parsing, and the receiver controller
// against a fake TV that speaks CASTV2 over a local (non-TLS) socket.
import net, { type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CastDeviceInfo, CastError, CastRequest, CastStatus } from '@castit/shared';
import { CastChannel, decodeMessage, encodeFrame, FrameReader, NS } from '../../apps/companion/src/cast/channel.ts';
import { buildQuery, isVideoDevice, parseRecords } from '../../apps/companion/src/cast/discovery.ts';
import { DEFAULT_MEDIA_RECEIVER, Receiver } from '../../apps/companion/src/cast/receiver.ts';
import { encodeNative, NativeReader } from '../../apps/companion/src/native.ts';

describe('CASTV2 framing', () => {
  it('round-trips messages, also when split across chunks', () => {
    const payload = JSON.stringify({ type: 'LOAD', title: 'é'.repeat(200) });
    const frame = encodeFrame('sender-0', 'web-1', NS.media, payload);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    const reader = new FrameReader();
    expect(reader.push(frame.subarray(0, 7))).toEqual([]);
    const [body] = reader.push(Buffer.concat([frame.subarray(7), frame]));
    expect(decodeMessage(body!)).toEqual({ source: 'sender-0', destination: 'web-1', namespace: NS.media, payload });
  });

  it('frames native messages little-endian', () => {
    const reader = new NativeReader();
    const data = Buffer.concat([encodeNative({ id: 1 }), encodeNative({ id: 2, type: 'hello' })]);
    expect(data.readUInt32LE(0)).toBe(8);
    expect(reader.push(data.subarray(0, 13))).toEqual([{ id: 1 }]);
    expect(reader.push(data.subarray(13))).toEqual([{ id: 2, type: 'hello' }]);
  });
});

/** Builds an mDNS response like a Chromecast's, with name compression. */
function mdnsResponse(): Buffer {
  const parts: Buffer[] = [];
  const offsets = new Map<string, number>();
  let length = 12;
  const push = (b: Buffer) => {
    parts.push(b);
    length += b.length;
  };
  const name = (n: string) => {
    const labels = n.split('.');
    for (let i = 0; i < labels.length; i++) {
      const rest = labels.slice(i).join('.');
      const known = offsets.get(rest);
      if (known !== undefined) return push(Buffer.from([0xc0 | (known >> 8), known & 0xff]));
      offsets.set(rest, length);
      push(Buffer.concat([Buffer.from([Buffer.byteLength(labels[i]!)]), Buffer.from(labels[i]!)]));
    }
    push(Buffer.from([0]));
  };
  const record = (n: string, type: number, rdata: () => void) => {
    name(n);
    push(Buffer.from([0, type, 0, 1, 0, 0, 0, 120]));
    const lengthAt = parts.length;
    push(Buffer.alloc(2));
    const before = length;
    rdata();
    parts[lengthAt]!.writeUInt16BE(length - before);
  };
  const instance = 'Chromecast-abc._googlecast._tcp.local';
  record('_googlecast._tcp.local', 12, () => name(instance));
  record(instance, 16, () => {
    for (const kv of ['id=abc123', 'fn=Living Room TV', 'md=Chromecast', 'ca=4101']) push(Buffer.concat([Buffer.from([kv.length]), Buffer.from(kv)]));
  });
  record(instance, 33, () => {
    push(Buffer.from([0, 0, 0, 0, 0x1f, 0x49]));
    name('abc123.local');
  });
  record('abc123.local', 1, () => push(Buffer.from([192, 168, 1, 50])));
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
  return Buffer.concat([header, ...parts]);
}

describe('mDNS', () => {
  it('asks for the Cast service', () => {
    const q = buildQuery();
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.toString('latin1')).toContain('_googlecast');
  });

  it('reads PTR, TXT, SRV and A records with compressed names', () => {
    const r = parseRecords(mdnsResponse());
    expect(r.instances).toEqual(['Chromecast-abc._googlecast._tcp.local']);
    const key = 'chromecast-abc._googlecast._tcp.local';
    expect(r.txt.get(key)).toMatchObject({ id: 'abc123', fn: 'Living Room TV', ca: '4101' });
    expect(r.srv.get(key)).toEqual({ port: 8009, target: 'abc123.local' });
    expect(r.a.get('abc123.local')).toBe('192.168.1.50');
  });

  it('leaves out speakers and groups', () => {
    expect(isVideoDevice({ ca: '264709' })).toBe(true);
    expect(isVideoDevice({ ca: '2052' })).toBe(false);
    expect(isVideoDevice({ md: 'Google Cast Group', ca: '2053' })).toBe(false);
  });
});

// ---------------------------------------------------------------- fake TV

interface Received {
  namespace: string;
  data: Record<string, unknown>;
}

class FakeTv {
  server!: Server;
  received: Received[] = [];
  app: { sessionId: string; transportId: string } | null = null;
  media: { contentId: string; state: string; time: number } | null = null;
  private sockets: Socket[] = [];

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.push(socket);
      const reader = new FrameReader();
      socket.on('data', (chunk) => {
        for (const body of reader.push(chunk)) {
          const m = decodeMessage(body);
          this.onMessage(socket, m.source, m.namespace, JSON.parse(m.payload!) as Record<string, unknown>);
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  private send(socket: Socket, source: string, namespace: string, data: Record<string, unknown>): void {
    socket.write(encodeFrame(source, 'sender-0', namespace, JSON.stringify(data)));
  }

  private receiverStatus(requestId: unknown): Record<string, unknown> {
    const applications = this.app ? [{ appId: DEFAULT_MEDIA_RECEIVER, ...this.app }] : [];
    return { type: 'RECEIVER_STATUS', requestId, status: { applications, volume: { level: 0.5, muted: false } } };
  }

  private mediaStatus(requestId: unknown, withMedia = false): Record<string, unknown> {
    if (!this.media) return { type: 'MEDIA_STATUS', requestId, status: [] };
    const entry: Record<string, unknown> = { mediaSessionId: 1, playerState: this.media.state, currentTime: this.media.time, supportedMediaCommands: 15 };
    if (withMedia) entry.media = { contentId: this.media.contentId, streamType: 'BUFFERED', duration: 100, metadata: { title: 'Clip' } };
    return { type: 'MEDIA_STATUS', requestId, status: [entry] };
  }

  private onMessage(socket: Socket, source: string, namespace: string, data: Record<string, unknown>): void {
    if (namespace === NS.heartbeat || namespace === NS.connection) return;
    this.received.push({ namespace, data });
    const t = this.app?.transportId ?? 'web-1';
    if (namespace === NS.receiver) {
      if (data.type === 'LAUNCH') this.app = { sessionId: 'session-1', transportId: 'web-1' };
      if (data.type === 'STOP') {
        this.app = null;
        this.media = null;
      }
      this.send(socket, 'receiver-0', NS.receiver, this.receiverStatus(data.requestId));
      return;
    }
    const contentId = ((data.media as { contentId?: string } | undefined)?.contentId ?? '') as string;
    switch (data.type) {
      case 'LOAD':
        if (contentId.includes('broken')) {
          this.send(socket, t, NS.media, { type: 'LOAD_FAILED', requestId: data.requestId, detailedErrorCode: 104 });
          return;
        }
        this.media = { contentId, state: 'BUFFERING', time: Number(data.currentTime ?? 0) };
        this.send(socket, t, NS.media, this.mediaStatus(data.requestId, true));
        setTimeout(() => {
          this.media!.state = 'PLAYING';
          this.send(socket, t, NS.media, this.mediaStatus(0));
        }, 20);
        return;
      case 'GET_STATUS':
        this.send(socket, t, NS.media, this.mediaStatus(data.requestId, true));
        return;
      case 'PAUSE':
        this.media!.state = 'PAUSED';
        this.send(socket, t, NS.media, this.mediaStatus(data.requestId));
        return;
      case 'STOP':
        this.media = null;
        this.send(socket, t, NS.media, this.mediaStatus(data.requestId));
        return;
    }
  }
}

const request = (url: string, requestId = 'r1'): CastRequest => ({
  requestId,
  sourceTabId: 1,
  candidateId: 'c1',
  url,
  contentType: 'application/x-mpegurl',
  streamType: 'BUFFERED',
  title: 'Clip',
  engine: 'direct',
});

describe('Receiver (against a fake TV)', () => {
  const tv = new FakeTv();
  let device: CastDeviceInfo;
  let statuses: CastStatus[];
  let results: Array<{ requestId: string; error?: CastError }>;
  let receiver: Receiver;
  const connect = (d: CastDeviceInfo) =>
    new Promise<CastChannel>((resolve, reject) => {
      const socket = net.connect(d.port, d.host, () => resolve(new CastChannel(socket)));
      socket.once('error', reject);
    });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  beforeAll(async () => {
    device = { id: 'tv', name: 'Test TV', host: '127.0.0.1', port: await tv.start() };
  });
  afterAll(() => tv.stop());
  beforeEach(() => {
    receiver?.close();
    tv.received = [];
    tv.app = null;
    tv.media = null;
    statuses = [];
    results = [];
    receiver = new Receiver(
      { status: (s) => statuses.push(s), loadResult: (requestId, error) => results.push({ requestId, error }), playbackProblem: () => undefined },
      connect,
    );
  });

  it('launches the media receiver, loads, and confirms only once the TV plays', async () => {
    await receiver.cast(device, { ...request('https://cdn.example/a.m3u8'), startTime: 42, textTracks: [{ id: 1, url: 'http://x/s.vtt', name: 'English' }] });
    expect(tv.received.find((m) => m.data.type === 'LAUNCH')?.data.appId).toBe('CC1AD845');
    const load = tv.received.find((m) => m.data.type === 'LOAD')!.data as { media: Record<string, unknown>; currentTime: number; sessionId: string };
    expect(load).toMatchObject({ currentTime: 42, sessionId: 'session-1' });
    expect(load.media).toMatchObject({ contentId: 'https://cdn.example/a.m3u8', contentUrl: 'https://cdn.example/a.m3u8', streamType: 'BUFFERED' });
    expect(load.media.tracks).toEqual([expect.objectContaining({ trackId: 1, type: 'TEXT', trackContentType: 'text/vtt' })]);
    await until(() => results.length > 0);
    expect(results).toEqual([{ requestId: 'r1', error: undefined }]);
    expect(receiver.status()).toMatchObject({ phase: 'playing', sessionActive: true, deviceName: 'Test TV', duration: 100, canSeek: true, volume: 0.5 });
  });

  it('turns the receiver’s error detail into a specific failure', async () => {
    await receiver.cast(device, request('https://cdn.example/broken.mkv'));
    expect(results[0]?.error?.code).toBe('UNSUPPORTED_CONTAINER');
    expect(receiver.status().phase).toBe('error');
  });

  it('sends remote commands and ends the session on stop', async () => {
    await receiver.cast(device, request('https://cdn.example/a.m3u8'));
    await until(() => receiver.status().phase === 'playing');
    expect(receiver.execute({ type: 'togglePlay' })).toBeNull();
    expect(receiver.execute({ type: 'seek', time: 500 })).toBeNull();
    expect(receiver.execute({ type: 'volume', level: 2 })).toBeNull();
    await until(() => receiver.status().phase === 'paused');
    expect(tv.received.find((m) => m.data.type === 'SEEK')?.data.currentTime).toBe(99);
    expect(tv.received.find((m) => m.data.type === 'SET_VOLUME')?.data.volume).toEqual({ level: 1 });
    receiver.execute({ type: 'stop' });
    await until(() => !receiver.status().sessionActive);
    expect(receiver.status().requestId).toBeUndefined();
  });

  it('re-attaches to its own cast after a restart, but not to someone else’s', async () => {
    tv.app = { sessionId: 'session-9', transportId: 'web-1' };
    tv.media = { contentId: 'https://cdn.example/a.m3u8', state: 'PLAYING', time: 10 };
    await receiver.adopt(device, request('https://cdn.example/other.m3u8', 'old'));
    expect(receiver.status()).toMatchObject({ sessionActive: false, requestId: undefined });
    await receiver.adopt(device, request('https://cdn.example/a.m3u8', 'mine'));
    expect(receiver.status()).toMatchObject({ sessionActive: true, requestId: 'mine', phase: 'playing' });
    expect(tv.received.some((m) => m.data.type === 'LAUNCH')).toBe(false);
  });

  it('reports a TV it cannot reach as a device problem', async () => {
    await receiver.cast({ ...device, port: 1 }, request('https://cdn.example/a.m3u8'));
    expect(results[0]?.error?.code).toBe('NO_DEVICE');
  });
});
