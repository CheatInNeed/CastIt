import './style.css';
import { formatTime, PHASE_LABELS, type CastError, type CastStatus } from '@castit/shared';
import { ExtensionBridge, pairingFromLocation, type BridgeState } from './bridge.ts';
import { CastController } from './cast.ts';

declare global {
  interface Window {
    __castitCastReady: Promise<{ available: boolean; reason?: string }>;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let status: CastStatus | null = null;
let bridgeError: CastError | null = null;
let seeking = false;

function showError(error: CastError | null | undefined): void {
  const box = $('error');
  box.hidden = !error;
  box.textContent = error ? `${error.message}${error.detail ? ` ${error.detail}` : ''}` : '';
}

function renderBridge(state: BridgeState, detail?: string): void {
  const pill = $('ext-status');
  pill.textContent =
    state === 'connected' ? 'Extension connected' : state === 'connecting' ? 'Connecting to extension…' : 'Extension unavailable';
  pill.className = `pill ${state === 'connected' ? 'on' : state === 'connecting' ? '' : 'bad'}`;
  bridgeError = detail ? { code: 'CONTROLLER_UNAVAILABLE', message: detail } : null;
  showError(bridgeError ?? status?.error);
}

function render(s: CastStatus, queuedUrl?: string): void {
  status = s;
  const devicePill = $('device-status');
  devicePill.textContent = s.sessionActive
    ? `● ${s.deviceName ?? 'Cast device'}`
    : s.devicesAvailable
      ? 'Cast devices available'
      : 'No Cast devices found';
  devicePill.className = `pill ${s.sessionActive ? 'on' : s.devicesAvailable ? '' : 'bad'}`;

  $('media-title').textContent = s.title ?? 'Nothing queued';
  let host = '';
  try {
    host = new URL(s.contentUrl ?? queuedUrl ?? '').hostname;
  } catch {
    /* none */
  }
  $('media-meta').textContent = host ? `Stream from ${host}` : '';

  const choose = $<HTMLButtonElement>('choose-device');
  choose.hidden = s.sessionActive && s.phase !== 'awaiting-device';
  choose.disabled = s.phase === 'connecting';
  const hint = $('hint');
  hint.hidden = s.phase !== 'awaiting-device';
  hint.textContent = 'Chrome needs a click on this page to show the Cast device picker.';

  $('player').hidden = !s.sessionActive;
  $('player-device').textContent = s.deviceName ? ` · ${s.deviceName}` : '';
  $('player-phase').textContent = PHASE_LABELS[s.phase] ?? s.phase;

  const seek = $<HTMLInputElement>('seek');
  seek.disabled = s.live || !s.canSeek || !s.duration;
  seek.max = String(Math.floor(s.duration ?? 0));
  if (!seeking) seek.value = String(Math.floor(s.currentTime));
  $('time').textContent = formatTime(seeking ? Number(seek.value) : s.currentTime);
  $('duration').textContent = s.live ? 'LIVE' : formatTime(s.duration);
  $('play').textContent = s.phase === 'playing' || s.phase === 'buffering' ? '❚❚' : '▶';
  $('mute').textContent = s.muted ? '🔇' : '🔊';
  const volume = $<HTMLInputElement>('volume');
  if (document.activeElement !== volume) volume.value = String(s.volume);

  showError(s.error ?? bridgeError);
}

async function main(): Promise<void> {
  const { extensionId, token } = pairingFromLocation();

  const ready = await window.__castitCastReady;
  if (!ready.available) {
    renderBridge('unavailable');
    showError({ code: 'NO_DEVICE', message: `Google Cast is not available in this browser (${ready.reason ?? 'unknown reason'}). Use Google Chrome.` });
    return;
  }

  let bridge: ExtensionBridge | null = null;
  const castController = new CastController({
    status: (s) => {
      render(s, castController.queued?.url);
      bridge?.send({ type: 'controller/status', status: s });
    },
    loadResult: (requestId, error) =>
      bridge?.send(
        error ? { type: 'controller/load-result', requestId, ok: false, error } : { type: 'controller/load-result', requestId, ok: true },
      ),
  });

  bridge = new ExtensionBridge(
    extensionId,
    token,
    (message) => {
      switch (message.type) {
        case 'controller/welcome':
          bridge?.send({ type: 'controller/status', status: castController.status() });
          if (message.pending) void castController.load(message.pending);
          break;
        case 'controller/load':
          void castController.load(message.request);
          break;
        case 'controller/command': {
          const error = castController.execute(message.command);
          if (error) showError(error);
          break;
        }
      }
    },
    renderBridge,
  );

  castController.init();
  bridge.connect();

  // Heartbeat: keeps the popup's view fresh while paused and wakes the extension worker.
  setInterval(() => {
    if (castController.hasSession) bridge?.send({ type: 'controller/status', status: castController.status() });
  }, 10_000);

  const run = (command: Parameters<CastController['execute']>[0]) => showError(castController.execute(command));
  $('choose-device').addEventListener('click', () => void castController.requestDevice());
  $('play').addEventListener('click', () => run({ type: 'togglePlay' }));
  $('back').addEventListener('click', () => run({ type: 'seekRelative', delta: -10 }));
  $('fwd').addEventListener('click', () => run({ type: 'seekRelative', delta: 30 }));
  $('stop').addEventListener('click', () => run({ type: 'stop' }));
  $('disconnect').addEventListener('click', () => run({ type: 'disconnect' }));
  $('mute').addEventListener('click', () => run({ type: 'mute', muted: !status?.muted }));

  const seek = $<HTMLInputElement>('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('time').textContent = formatTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    seeking = false;
    run({ type: 'seek', time: Number(seek.value) });
  });
  const volume = $<HTMLInputElement>('volume');
  volume.addEventListener('change', () => run({ type: 'volume', level: Number(volume.value) }));
}

void main();
