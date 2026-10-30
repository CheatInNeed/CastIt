// Castit companion, run by Chrome as a native messaging host (installed by `npm run setup`).
// Chrome starts this process when the extension connects and closes stdin when it disconnects.
// stdout carries only protocol messages, so everything else is logged to ~/.castit/companion.log.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPANION_PROTOCOL,
  type CastDeviceInfo,
  type CompanionEvent,
  type CompanionHello,
  type CompanionReply,
  type CompanionRequest,
} from '@castit/shared';
import { Discovery } from './cast/discovery.ts';
import { Receiver } from './cast/receiver.ts';
import { settingsFromEnv } from './config.ts';
import { encodeNative, NativeReader } from './native.ts';
import { CompanionRequestError, startCompanion, VERSION } from './server.ts';

const settings = settingsFromEnv();
mkdirSync(settings.configDir, { recursive: true, mode: 0o700 });
const logFile = join(settings.configDir, 'companion.log');
try {
  if (statSync(logFile).size > 1_000_000) writeFileSync(logFile, '');
} catch {
  /* no log yet */
}
const log = (message: string) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never break the host */
  }
};
// Nothing may write to stdout except the protocol.
console.log = console.info = console.warn = console.error = (...args: unknown[]) => log(args.map(String).join(' '));

function write(message: CompanionEvent | CompanionReply): void {
  process.stdout.write(encodeNative(message));
}

const companion = await startCompanion({ ...settings, log }).catch((e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Another companion (e.g. a second Chrome profile) has the usual port: any free port works.
  log(`media port ${settings.mediaPort} busy; using a random port`);
  return startCompanion({ ...settings, mediaPort: 0, log });
});
log(`started ${VERSION} · media ${companion.mediaBaseUrl} · FFmpeg ${companion.ffmpeg.available ? 'yes' : 'no'}`);

const discovery = new Discovery(log);
const receiver = new Receiver({
  status: (status) => write({ type: 'event/status', status }),
  loadResult: (requestId, error) =>
    write(error ? { type: 'event/load-result', requestId, ok: false, error } : { type: 'event/load-result', requestId, ok: true }),
  playbackProblem: (requestId, error, position) => write({ type: 'event/playback-problem', requestId, error, position }),
});
discovery.on('change', (devices: CastDeviceInfo[]) => {
  receiver.devicesAvailable = devices.length > 0;
  write({ type: 'event/devices', devices });
});
discovery.start();

/** Re-attaching to a running cast finishes before commands are executed. */
let adopting: Promise<void> = Promise.resolve();

async function handle(request: CompanionRequest): Promise<unknown> {
  switch (request.type) {
    case 'hello': {
      if (request.active) adopting = receiver.adopt(request.active.device, request.active.request);
      const ffmpeg = companion.ffmpeg;
      return {
        name: 'castit-companion',
        version: VERSION,
        protocol: COMPANION_PROTOCOL,
        mediaBaseUrl: companion.mediaBaseUrl,
        ffmpeg: ffmpeg.available,
        hwEncoder: ffmpeg.available && ffmpeg.encoder.hardware ? ffmpeg.encoder.name : null,
        devices: discovery.devices(),
      } satisfies CompanionHello;
    }
    case 'devices':
      discovery.refresh();
      return discovery.devices();
    case 'create-session':
      return companion.createSession(request.request);
    case 'delete-session':
      companion.deleteSession(request.sessionId);
      return undefined;
    case 'cast':
      // The outcome arrives later as an event/load-result.
      void receiver.cast(request.device, request.request).catch((e) => log(`cast failed: ${(e as Error).message}`));
      return undefined;
    case 'command':
      await adopting;
      return receiver.execute(request.command);
    default:
      throw new CompanionRequestError('BAD_REQUEST', 'Unknown request.');
  }
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('stopping');
  // Leaves the TV playing: a direct cast does not need this computer.
  receiver.close();
  discovery.stop();
  await companion.close();
  process.exit(0);
}

const reader = new NativeReader();
process.stdin.on('data', (chunk: Buffer) => {
  let messages: unknown[];
  try {
    messages = reader.push(chunk);
  } catch (e) {
    log(`bad message from Chrome: ${(e as Error).message}`);
    return void shutdown();
  }
  for (const raw of messages) {
    const { id, ...request } = raw as CompanionRequest & { id: number };
    handle(request as CompanionRequest).then(
      (result) => write({ id, ok: true, result }),
      (e: Error) => write({ id, ok: false, error: e.message, code: e instanceof CompanionRequestError ? e.code : 'INTERNAL' }),
    );
  }
});
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
// Kill FFmpeg and delete temp folders even on an abrupt exit.
process.on('exit', () => companion.closeSync());
process.on('uncaughtException', (e) => {
  log(`crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
