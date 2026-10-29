import {
  formatTime,
  type CompanionPairResult,
  type CompanionStatus,
  type EngineMode,
  type TranscodeSettings,
  PHASE_LABELS,
  type CandidateView,
  type CastError,
  type CastStatus,
  type CommandResponse,
  type PopupCastResponse,
  type PopupRequest,
  type PopupState,
  type RemoteCommand,
} from '@castit/shared';
import { selectMainCandidate } from '../lib/rank.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let tabId = -1;
let state: PopupState | null = null;
let selectedId: string | undefined;
let userSelected = false;
let seeking = false;

function send<T>(message: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function showError(error: CastError | null): void {
  const box = $('error');
  box.hidden = !error;
  box.textContent = error ? error.message + (error.detail ? ` (${error.detail})` : '') : '';
}

async function refresh(): Promise<void> {
  state = await send<PopupState>({ type: 'popup/get-state', tabId });
  render();
}

function render(): void {
  if (!state) return;
  renderConnection(state);
  renderCandidates(state);
  renderNow(state.castStatus);
  renderSync(state);
  renderCompanion(state.companion, state.engineMode, state.transcodeSettings);
  renderNotice(state.notice);
}

function renderSync(s: PopupState): void {
  const line = $('now-sync');
  const sync = s.sync;
  line.hidden = sync.state === 'off';
  line.textContent =
    sync.state === 'active'
      ? `The page’s own player is your remote${sync.frameHost ? ` (player on ${sync.frameHost})` : ''}: play, pause and seek there.`
      : (sync.reason ?? '');
}

function renderNotice(notice: string | null): void {
  const box = $('notice');
  box.hidden = !notice;
  box.textContent = notice ?? '';
}

const COMPANION_LABEL: Record<CompanionStatus['state'], string> = {
  offline: 'Not running',
  unpaired: 'Not paired',
  rejected: 'Pairing revoked',
  paired: 'Ready',
};

function renderCompanion(status: CompanionStatus, mode: EngineMode, transcode: TranscodeSettings): void {
  const pill = $('companion-state');
  pill.textContent = COMPANION_LABEL[status.state];
  pill.className = `pill small ${status.state === 'paired' ? 'on' : ''}`;
  const hint = $('companion-hint');
  hint.textContent =
    status.state === 'offline'
      ? 'Optional. Relays streams the Chromecast cannot fetch itself (missing CORS, Referer checks). Start it with `npm run companion`.'
      : status.state === 'paired'
        ? `Relaying via ${status.mediaBaseUrl ?? 'your computer'} when needed. ${
            status.ffmpeg
              ? `Converting with FFmpeg (${status.hwEncoder ? `hardware: ${status.hwEncoder.replace('h264_', '')}` : 'software'}).`
              : 'FFmpeg not found: streams the TV cannot decode will not be converted.'
          }`
        : 'Enter the pairing code shown in the companion terminal.';
  $('transcode-settings').hidden = !(status.state === 'paired' && status.ffmpeg);
  const profile = $<HTMLSelectElement>('tc-profile');
  const quality = $<HTMLSelectElement>('tc-quality');
  if (document.activeElement !== profile) profile.value = transcode.profile;
  if (document.activeElement !== quality) quality.value = transcode.quality;
  $('pair-form').hidden = status.state !== 'unpaired' && status.state !== 'rejected';
  $('companion-forget').hidden = status.state !== 'paired' && status.state !== 'rejected';
  const select = $<HTMLSelectElement>('engine-mode');
  if (document.activeElement !== select) select.value = mode;
  // Draw attention to setup when a candidate would benefit from the companion.
  const details = $<HTMLDetailsElement>('companion');
  if (status.state !== 'paired' && state?.candidates.some((c) => c.assessment.companionHelps)) details.open = true;
}

function renderConnection(s: PopupState): void {
  const pill = $('connection');
  const status = s.castStatus;
  if (status?.sessionActive) {
    pill.textContent = `● ${status.deviceName ?? 'Cast device'}`;
    pill.className = 'pill on';
  } else if (s.controllerConnected) {
    pill.textContent = status && !status.devicesAvailable ? 'No Cast devices found' : 'Controller ready';
    pill.className = 'pill';
  } else {
    pill.textContent = 'Controller closed';
    pill.className = 'pill';
  }
}

const KIND_LABEL: Record<string, string> = { hls: 'HLS', dash: 'DASH', progressive: 'FILE', unknown: '?' };
const LEVEL_LABEL: Record<string, string> = {
  likely: 'Castable',
  possible: 'Maybe castable',
  unlikely: 'Unlikely',
  unsupported: 'Not castable',
};

function renderCandidates(s: PopupState): void {
  const list = $('candidates');
  list.replaceChildren();

  if (!userSelected || !s.candidates.some((c) => c.id === selectedId)) {
    selectedId = selectMainCandidate(s.candidates)?.id;
  }

  for (const c of s.candidates) list.append(candidateRow(c));

  const empty = $('empty');
  empty.hidden = s.candidates.length > 0;
  empty.textContent = s.mediaSourceDetected
    ? 'A MediaSource (blob:) player is active, but no HLS/DASH manifest was observed. Reload the page and start the video again so Castit can see the stream requests.'
    : 'No video detected yet. Start playing the video, then reopen Castit.';

  const selected = s.candidates.find((c) => c.id === selectedId);
  const castButton = $<HTMLButtonElement>('cast');
  castButton.disabled = !selected || selected.assessment.level === 'unsupported';
}

function candidateRow(c: CandidateView): HTMLElement {
  const row = document.createElement('label');
  row.className = 'candidate';
  row.title = c.url;

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'candidate';
  radio.checked = c.id === selectedId;
  radio.addEventListener('change', () => {
    selectedId = c.id;
    userSelected = true;
    if (state) renderCandidates(state);
  });

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = c.label;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const tag = (text: string, cls = '') => {
    const span = document.createElement('span');
    span.className = `tag ${cls}`;
    span.textContent = text;
    meta.append(span);
  };
  tag(KIND_LABEL[c.kind] ?? c.kind.toUpperCase());
  if (c.container !== 'unknown' && c.kind === 'progressive') tag(c.container.toUpperCase());
  if (c.manifest?.role === 'master' && c.manifest.variantCount > 1) tag(`${c.manifest.variantCount} qualities`);
  if (c.quality) tag(c.quality);
  if (c.live) tag('LIVE');
  if (c.video && !c.video.paused) tag('PLAYING');
  const codec = videoCodecLabel(c.codecs);
  if (codec) tag(codec);
  if (c.isAd) tag('AD');
  tag(LEVEL_LABEL[c.assessment.level] ?? c.assessment.level, `level-${c.assessment.level}`);
  let host = '';
  try {
    host = new URL(c.url).hostname;
  } catch {
    /* keep empty */
  }
  meta.append(c.embedded && c.frameHost && c.frameHost !== host ? `${host} · in player ${c.frameHost}` : host);

  row.append(radio, name, meta);
  if (c.assessment.notes.length) {
    const notes = document.createElement('ul');
    notes.className = 'notes';
    for (const note of c.assessment.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      notes.append(li);
    }
    row.append(notes);
  }
  return row;
}

const CODEC_LABELS: Array<[RegExp, string]> = [
  [/^(avc1|avc3)/i, 'H.264'],
  [/^(hvc1|hev1)/i, 'HEVC'],
  [/^av01/i, 'AV1'],
  [/^(vp09|vp9)/i, 'VP9'],
  [/^vp8/i, 'VP8'],
];

function videoCodecLabel(codecs: string[]): string | undefined {
  for (const codec of codecs) {
    const match = CODEC_LABELS.find(([re]) => re.test(codec));
    if (match) return match[1];
  }
  return undefined;
}

function renderNow(status: CastStatus | null): void {
  const section = $('now');
  const active = !!status && (status.sessionActive || !['idle', 'error'].includes(status.phase));
  section.hidden = !active;
  if (status?.phase === 'error' && status.error) showError(status.error);
  if (!status || !active) return;

  $('now-device').textContent =
    (status.deviceName ? ` · ${status.deviceName}` : '') +
    (status.engine === 'companion' ? ' · via companion' : status.engine === 'transcode' ? ' · converted' : '');
  const plan = $('now-plan');
  plan.hidden = !status.plan?.details.length || status.plan.action === 'direct';
  plan.textContent = status.plan ? status.plan.details.join(' · ') : '';
  const subsRow = $('now-subs-row');
  const subs = $<HTMLSelectElement>('now-subs');
  subsRow.hidden = !status.textTracks?.length;
  if (status.textTracks?.length && document.activeElement !== subs) {
    subs.replaceChildren(new Option('Off', ''), ...status.textTracks.map((t) => new Option(t.name, String(t.id))));
    subs.value = status.activeTextTrack ? String(status.activeTextTrack) : '';
  }
  $('now-phase').textContent = PHASE_LABELS[status.phase] ?? status.phase;
  $('now-title').textContent = status.title ?? '';

  const seek = $<HTMLInputElement>('now-seek');
  seek.disabled = status.live || !status.canSeek || !status.duration;
  seek.max = String(Math.max(0, Math.floor(status.duration ?? 0)));
  if (!seeking) seek.value = String(Math.floor(status.currentTime));
  $('now-time').textContent = formatTime(seeking ? Number(seek.value) : status.currentTime);
  $('now-duration').textContent = status.live ? 'LIVE' : formatTime(status.duration);

  $('btn-play').textContent = status.phase === 'playing' || status.phase === 'buffering' ? '❚❚' : '▶';
  $('btn-mute').textContent = status.muted ? '🔇' : '🔊';
  const volume = $<HTMLInputElement>('now-volume');
  if (document.activeElement !== volume) volume.value = String(status.volume);
}

async function command(cmd: RemoteCommand): Promise<void> {
  const response = await send<CommandResponse>({ type: 'popup/command', command: cmd });
  showError(response.ok ? null : response.error);
}

function wire(): void {
  $('cast').addEventListener('click', async () => {
    if (!selectedId) return;
    const button = $<HTMLButtonElement>('cast');
    button.disabled = true;
    button.textContent = 'Checking stream…';
    showError(null);
    const response = await send<PopupCastResponse>({ type: 'popup/cast', tabId, candidateId: selectedId });
    if (response.ok) {
      button.textContent = response.controller === 'opened' ? 'Opening controller…' : 'Sent to Chromecast';
    } else {
      showError(response.error);
      button.textContent = 'Cast';
      button.disabled = false;
    }
  });

  $('btn-play').addEventListener('click', () => void command({ type: 'togglePlay' }));
  $('btn-back').addEventListener('click', () => void command({ type: 'seekRelative', delta: -10 }));
  $('btn-fwd').addEventListener('click', () => void command({ type: 'seekRelative', delta: 30 }));
  $('btn-stop').addEventListener('click', () => void command({ type: 'stop' }));
  $('btn-mute').addEventListener('click', () => void command({ type: 'mute', muted: !state?.castStatus?.muted }));

  const seek = $<HTMLInputElement>('now-seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('now-time').textContent = formatTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    seeking = false;
    void command({ type: 'seek', time: Number(seek.value) });
  });

  const volume = $<HTMLInputElement>('now-volume');
  volume.addEventListener('change', () => void command({ type: 'volume', level: Number(volume.value) }));

  $('open-controller').addEventListener('click', () => void send({ type: 'popup/open-controller' }));

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('pair-code');
    const button = $<HTMLButtonElement>('pair-btn');
    button.disabled = true;
    const result = await send<CompanionPairResult>({ type: 'popup/companion-pair', code: input.value });
    button.disabled = false;
    if (result.ok) {
      input.value = '';
      showError(null);
      await refresh();
    } else {
      showError({ code: 'COMPANION_UNAVAILABLE', message: result.error });
    }
  });
  $('companion-forget').addEventListener('click', async () => {
    await send({ type: 'popup/companion-forget' });
    await refresh();
  });
  const saveTranscode = async () => {
    const settings: TranscodeSettings = {
      profile: $<HTMLSelectElement>('tc-profile').value as TranscodeSettings['profile'],
      quality: $<HTMLSelectElement>('tc-quality').value as TranscodeSettings['quality'],
    };
    await send({ type: 'popup/set-transcode', settings });
    await refresh();
  };
  $('tc-profile').addEventListener('change', () => void saveTranscode());
  $('tc-quality').addEventListener('change', () => void saveTranscode());
  $('now-subs').addEventListener('change', () => {
    const value = $<HTMLSelectElement>('now-subs').value;
    void command({ type: 'subtitles', trackId: value ? Number(value) : null });
  });
  $('engine-mode').addEventListener('change', async () => {
    await send({ type: 'popup/set-engine', mode: $<HTMLSelectElement>('engine-mode').value as EngineMode });
    await refresh();
  });

  // Live updates: receiver status and tab detections are written to storage.session by the worker.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.castStatus && state) {
      state.castStatus = (changes.castStatus.newValue as CastStatus | undefined) ?? null;
      renderConnection(state);
      renderNow(state.castStatus);
    }
    if (changes.syncTarget && state) void refresh();
    if (changes.castNotice && state) {
      state.notice = (changes.castNotice.newValue as string | undefined) ?? null;
      renderNotice(state.notice);
    }
    if (changes[`tab:${tabId}`] && !refreshTimer) {
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 300);
    }
  });
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  wire();
  await refresh();
}

void main();
