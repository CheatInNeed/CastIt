import {
  formatTime,
  type CompanionPairResult,
  type CompanionStatus,
  type EngineMode,
  type CastProgress,
  type HighlightResult,
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
import { adviceFor } from '../lib/advice.ts';
import { isPrimaryCandidate, selectMainCandidate } from '../lib/rank.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let tabId = -1;
let state: PopupState | null = null;
let selectedId: string | undefined;
let userSelected = false;
let seeking = false;

function send<T>(message: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function advice(error: CastError): string | undefined {
  return adviceFor(error, { companion: state?.companion?.state ?? 'offline', ffmpeg: !!state?.companion?.ffmpeg });
}

/** Error box: what went wrong (with detail), then what the user can do about it. */
function showError(error: CastError | null): void {
  const box = $('error');
  box.hidden = !error;
  box.replaceChildren();
  if (!error) return;
  const what = document.createElement('div');
  what.textContent = error.message + (error.detail ? ` (${error.detail})` : '');
  box.append(what);
  const tip = advice(error);
  if (tip) {
    const next = document.createElement('div');
    next.className = 'advice';
    next.textContent = `What you can do: ${tip}`;
    box.append(next);
  }
}

async function refresh(): Promise<void> {
  state = await send<PopupState>({ type: 'popup/get-state', tabId });
  render();
}

function render(): void {
  const s = state;
  if (!s) return;
  // A background worker from an older build may omit newer fields: render what we can.
  const parts = [
    () => renderStale(s),
    () => renderConnection(s),
    () => renderCandidates(s),
    () => renderNow(s.castStatus),
    () => renderReconnect(s),
    () => renderSync(s),
    () => renderCompanion(s.companion, s.engineMode, s.transcodeSettings),
    () => renderNotice(s.notice),
    () => renderProgress(s.progress),
  ];
  for (const part of parts) {
    try {
      part();
    } catch (e) {
      console.warn('Castit popup:', e);
    }
  }
}

/** A cast is (probably) still running, but nothing can control it until the controller is back. */
function renderReconnect(s: PopupState): void {
  $('now-reconnect').hidden = s.controllerConnected || !s.castStatus?.sessionActive;
}

function renderStale(s: PopupState): void {
  $('stale').hidden = s.buildId === __BUILD_ID__;
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

const PROGRESS_LABEL: Record<CastProgress['state'], string> = {
  running: 'Trying…',
  playing: 'Playing',
  failed: 'Failed',
  cancelled: 'Stopped',
};

/** Shown when something went wrong or more than one way was needed. */
function renderProgress(progress: CastProgress | undefined): void {
  const card = $('progress');
  card.hidden = !progress || (progress.state === 'playing' && progress.lines.length <= 1);
  if (!progress || card.hidden) return;
  const pill = $('progress-state');
  pill.textContent = PROGRESS_LABEL[progress.state];
  pill.className = `pill small ${progress.state === 'playing' ? 'on' : progress.state === 'running' ? 'warn' : ''}`;
  $('progress-list').replaceChildren(
    ...progress.lines.map((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      div.className = line.endsWith('✓') ? 'ok' : line.endsWith('trying…') ? 'busy' : 'bad';
      return div;
    }),
  );
  $('stop-trying').hidden = progress.state !== 'running';
  const tip = progress.state === 'failed' && progress.final ? advice(progress.final) : undefined;
  const advise = $('progress-advice');
  advise.hidden = !tip;
  advise.textContent = tip ? `What you can do: ${tip}` : '';
}

async function copyDiagnostics(button: HTMLElement): Promise<void> {
  const report = await send<string>({ type: 'popup/diagnostics', tabId });
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(report);
    button.textContent = 'Copied ✓';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => (button.textContent = label), 1500);
}

function renderNotice(notice: string | null): void {
  const box = $('notice');
  // The attempts card already states a final failure; don't say it twice.
  if (notice && notice === state?.progress?.final?.message) notice = null;
  box.hidden = !notice;
  box.textContent = notice ?? '';
}

const COMPANION_LABEL: Record<CompanionStatus['state'], string> = {
  offline: 'Not running',
  unpaired: 'Not paired',
  rejected: 'Pairing revoked',
  paired: 'Ready',
};

const COMPANION_PILL: Record<CompanionStatus['state'], string> = {
  offline: 'Companion off',
  unpaired: 'Companion: pair it',
  rejected: 'Companion: pair again',
  paired: 'Companion ✓',
};

function renderCompanion(status: CompanionStatus, mode: EngineMode, transcode: TranscodeSettings): void {
  const pill = $('companion-state');
  pill.textContent = COMPANION_LABEL[status.state];
  pill.className = `pill small ${status.state === 'paired' ? 'on' : status.state === 'offline' ? '' : 'warn'}`;
  const header = $('companion-pill');
  header.textContent = COMPANION_PILL[status.state];
  header.className = `pill ${status.state === 'paired' ? 'on' : status.state === 'offline' ? '' : 'warn'}`;
  header.title =
    status.state === 'paired'
      ? `Local companion running and paired (${status.mediaBaseUrl ?? ''})`
      : status.state === 'offline'
        ? 'Local companion not running (optional). Click for details.'
        : 'Local companion running but not paired. Click to pair.';
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
  if (!userSelected || !s.candidates.some((c) => c.id === selectedId)) {
    selectedId = s.castingCandidateId ?? selectMainCandidate(s.candidates)?.id;
  }

  // Real videos first; every other stream file the page fetched goes behind a fold.
  const primary = s.candidates.filter(isPrimaryCandidate);
  const main = primary.length ? primary : s.candidates;
  const others = primary.length ? s.candidates.filter((c) => !isPrimaryCandidate(c)) : [];
  $('candidates').replaceChildren(...main.map((c) => candidateRow(c, s)));
  $('others-list').replaceChildren(...others.map((c) => candidateRow(c, s)));
  const fold = $<HTMLDetailsElement>('others');
  fold.hidden = others.length === 0;
  $('others-summary').textContent = `Other stream files on this page (${others.length})`;
  if (others.some((c) => c.id === selectedId)) fold.open = true;

  const empty = $('empty');
  empty.hidden = s.candidates.length > 0;
  empty.textContent = s.mediaSourceDetected
    ? 'A MediaSource (blob:) player is active, but no HLS/DASH manifest was observed. Reload the page and start the video again so Castit can see the stream requests.'
    : 'No video detected yet. Start playing the video, then reopen Castit.';

  const selected = s.candidates.find((c) => c.id === selectedId);
  const castButton = $<HTMLButtonElement>('cast');
  castButton.disabled = !selected || selected.assessment.level === 'unsupported';
}

/** Where on the page this stream plays, in plain words. */
function whereText(c: CandidateView): { text: string; playing: boolean } {
  const v = c.video;
  const place = c.embedded && c.frameHost ? ` · embedded player from ${c.frameHost}` : '';
  if (!v) {
    return {
      text: c.kind === 'hls' || c.kind === 'dash' ? `Stream not linked to a player on the page${place}` : `Not linked to a player on the page${place}`,
      playing: false,
    };
  }
  const playing = !v.paused && !v.ended;
  const state = playing ? '▶ Playing' : v.ended ? 'Ended' : v.currentTime > 0 ? 'Paused' : 'Not started';
  const time = v.live ? 'LIVE' : v.duration ? `${formatTime(v.currentTime)} / ${formatTime(v.duration)}` : formatTime(v.currentTime);
  const size = v.width > 0 ? `${v.width}×${v.height} player` : 'hidden player';
  return { text: `${state} · ${time} · ${size}${v.visible ? '' : ' (off-screen)'}${place}`, playing };
}

const HOVER_PROBLEMS: Record<Exclude<HighlightResult, 'shown'>, string> = {
  unreachable: 'Can’t point this out: reload the page (it was opened before Castit was last updated).',
  'not-found': 'This player is no longer on the page.',
};

/** Outlines the row's video on the page; explains on the row when that isn't possible. */
async function highlight(c: CandidateView | null, row?: HTMLElement): Promise<void> {
  if (!c?.video) {
    void send({ type: 'popup/highlight', tabId, frameId: lastHighlightFrame, videoKey: null }).catch(() => undefined);
    return;
  }
  lastHighlightFrame = c.videoFrameId ?? c.frameId;
  const result = await send<HighlightResult>({ type: 'popup/highlight', tabId, frameId: lastHighlightFrame, videoKey: c.video.key }).catch(
    (): HighlightResult => 'unreachable',
  );
  const note = row?.querySelector<HTMLElement>('.hover-note');
  if (!note) return;
  note.hidden = result === 'shown';
  note.textContent = result === 'shown' ? '' : HOVER_PROBLEMS[result];
}
let lastHighlightFrame = 0;

function candidateRow(c: CandidateView, s: PopupState): HTMLElement {
  const row = document.createElement('label');
  row.className = `candidate${c.id === selectedId ? ' selected' : ''}`;
  row.title = c.url;
  row.addEventListener('mouseenter', () => void highlight(c, row));
  row.addEventListener('mouseleave', () => void highlight(null));

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'candidate';
  radio.checked = c.id === selectedId;
  radio.addEventListener('change', () => {
    selectedId = c.id;
    userSelected = true;
    if (state) renderCandidates(state);
  });
  radio.addEventListener('focus', () => void highlight(c, row));

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = c.label;
  if (c.id === s.castingCandidateId) {
    const onTv = document.createElement('span');
    onTv.className = 'tag on-tv';
    onTv.textContent = 'ON TV';
    name.prepend(onTv);
  }

  const where = whereText(c);
  const whereLine = document.createElement('div');
  whereLine.className = `where${where.playing ? ' playing' : ''}`;
  whereLine.textContent = where.text;

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
  meta.append(host);

  const hoverNote = document.createElement('div');
  hoverNote.className = 'hover-note';
  hoverNote.hidden = true;
  row.append(radio, name, whereLine, meta, hoverNote);
  // Notes only for the selected row, to keep the list scannable.
  if (c.id === selectedId && c.assessment.notes.length) {
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
    (status.engine === 'companion'
      ? ' · via companion'
      : status.engine === 'transcode'
        ? status.plan?.action === 'remux'
          ? ' · repackaged'
          : status.plan?.action === 'transcode'
            ? ' · converted'
            : ' · via companion'
        : '');
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
  $('reload-ext').addEventListener('click', () => chrome.runtime.reload());
  $('reconnect').addEventListener('click', () => void send({ type: 'popup/open-controller' }));
  $('copy-diag').addEventListener('click', (e) => void copyDiagnostics(e.currentTarget as HTMLElement));
  $('copy-diag-footer').addEventListener('click', (e) => void copyDiagnostics(e.currentTarget as HTMLElement));
  $('stop-trying').addEventListener('click', async () => {
    await send({ type: 'popup/cast-cancel' });
    await refresh();
  });
  $('companion-pill').addEventListener('click', () => {
    const details = $<HTMLDetailsElement>('companion');
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  window.addEventListener('blur', () => void highlight(null));

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('pair-code');
    const button = $<HTMLButtonElement>('pair-btn');
    button.disabled = true;
    const result = await send<CompanionPairResult>({ type: 'popup/companion-pair', code: input.value });
    button.disabled = false;
    const line = $('pair-result');
    line.hidden = false;
    if (result.ok) {
      input.value = '';
      line.className = 'small ok';
      line.textContent = 'Paired ✓ The companion will be used when a stream needs it.';
      await refresh();
    } else {
      line.className = 'small bad';
      line.textContent = result.error;
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
      // A fresh status means a controller is talking again: pick up its connection state.
      if (!state.controllerConnected) void refresh();
    }
    if (changes.syncTarget && state) void refresh();
    if (changes.castContext && state) void refresh();
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
