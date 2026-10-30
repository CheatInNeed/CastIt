// Castit's UI. Normally shown as a panel over the page (an iframe placed by the content script,
// see lib/panel.ts); on pages extensions can't touch it opens as Chrome's regular popup instead.
import {
  formatTime,
  PHASE_LABELS,
  type CandidateView,
  type CastError,
  type CastProgress,
  type CastStatus,
  type CommandResponse,
  type EngineMode,
  type PopupCastResponse,
  type PopupRequest,
  type PopupState,
  type RemoteCommand,
  type TranscodeSettings,
} from '@castit/shared';
import { adviceFor, emptyPageExplanation } from '../lib/advice.ts';
import { isPrimaryCandidate, selectMainCandidate } from '../lib/rank.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const embedded = window.top !== window;

// Static icons (no user data), set with innerHTML.
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  sound:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  muted:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9z"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
};
let tabId = -1;
let state: PopupState | null = null;
let selectedId: string | undefined;
let userSelected = false;
let seeking = false;
let casting = false;

function send<T>(message: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** Tells the page panel to close (embedded) or closes Chrome's popup. */
function close(): void {
  if (embedded) window.parent.postMessage({ castitPanel: 'close' }, '*');
  else window.close();
}

/** Error box: what went wrong, then what the user can do about it. */
function showError(error: CastError | null): void {
  const box = $('error');
  box.hidden = !error;
  box.replaceChildren();
  if (!error) return;
  const what = document.createElement('div');
  what.textContent = error.message;
  if (error.detail) what.title = error.detail;
  box.append(what);
  const tip = adviceFor(error, { companion: state?.companion?.state ?? 'offline', ffmpeg: !!state?.companion?.ffmpeg });
  if (tip) {
    const next = document.createElement('div');
    next.className = 'advice';
    next.textContent = tip;
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
    () => ($('stale').hidden = s.buildId === __BUILD_ID__),
    () => renderDevices(s),
    () => renderCandidates(s),
    () => renderNow(s.castStatus),
    () => renderSettings(s.engineMode, s.transcodeSettings, !!s.companion.ffmpeg),
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

/** The TV picker in the header, or why there is none. */
function renderDevices(s: PopupState): void {
  const missing = s.companion.state !== 'ready';
  $('setup').hidden = s.companion.state !== 'missing';
  const select = $<HTMLSelectElement>('device');
  const status = $('device-status');
  const devices = s.devices ?? [];
  select.hidden = missing || devices.length === 0;
  status.hidden = !select.hidden || s.companion.state === 'missing';
  status.textContent = s.companion.state === 'offline' ? 'Helper stopped' : 'No TV found';
  if (devices.length && document.activeElement !== select) {
    const casting = s.castStatus?.sessionActive ? devices.find((d) => d.name === s.castStatus?.deviceName)?.id : undefined;
    select.replaceChildren(...devices.map((d) => new Option(d.name, d.id)));
    select.value = casting ?? (devices.some((d) => d.id === s.deviceId) ? s.deviceId! : devices[0]!.id);
  }
}

function renderSettings(mode: EngineMode, transcode: TranscodeSettings, ffmpeg: boolean): void {
  const select = $<HTMLSelectElement>('engine-mode');
  if (document.activeElement !== select) select.value = mode;
  $('transcode-settings').hidden = !ffmpeg;
  const profile = $<HTMLSelectElement>('tc-profile');
  const quality = $<HTMLSelectElement>('tc-quality');
  if (document.activeElement !== profile) profile.value = transcode.profile;
  if (document.activeElement !== quality) quality.value = transcode.quality;
}

/** Shown while Castit tries more than one way, and when it failed. */
function renderProgress(progress: CastProgress | undefined): void {
  const card = $('progress');
  card.hidden = !progress || progress.state === 'playing' || progress.state === 'cancelled' || (progress.state === 'running' && progress.lines.length < 2);
  if (!progress || card.hidden) return;
  $('progress-list').replaceChildren(
    ...progress.lines.map((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      div.className = line.endsWith('✓') ? 'ok' : line.endsWith('trying…') ? 'busy' : 'bad';
      return div;
    }),
  );
  $('stop-trying').hidden = progress.state !== 'running';
  $('copy-diag').hidden = progress.state !== 'failed';
  if (progress.state === 'failed' && progress.final) showError(progress.final);
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
  // The error box already states a final failure; don't say it twice.
  if (notice && notice === state?.progress?.final?.message) notice = null;
  box.hidden = !notice;
  box.textContent = notice ?? '';
}

const KIND_LABEL: Record<string, string> = { hls: 'HLS', dash: 'DASH', progressive: 'FILE', unknown: '?' };
const LEVEL_LABEL: Record<string, string> = {
  possible: 'Maybe',
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
  $('others-summary').textContent = `${others.length} more stream file${others.length === 1 ? '' : 's'}`;
  if (others.some((c) => c.id === selectedId)) fold.open = true;

  const empty = $('empty');
  empty.hidden = s.candidates.length > 0;
  empty.textContent = emptyPageExplanation({ drmKeySystems: s.drmKeySystems ?? [], mediaSource: s.mediaSourceDetected });

  const selected = s.candidates.find((c) => c.id === selectedId);
  const button = $<HTMLButtonElement>('cast');
  button.hidden = s.candidates.length === 0;
  if (!casting) {
    button.disabled = !selected || selected.assessment.level === 'unsupported' || s.companion.state !== 'ready' || !s.devices?.length;
    button.textContent = selected && selected.id === s.castingCandidateId ? 'Cast again' : 'Cast';
  }
}

/** Playback state of the row's page player, in a few words. */
function playerText(c: CandidateView): { text: string; playing: boolean } {
  const v = c.video;
  if (!v) return { text: c.embedded && c.frameHost ? `In ${c.frameHost}` : 'Not in a player', playing: false };
  const playing = !v.paused && !v.ended;
  const status = playing ? '▶ Playing' : v.ended ? 'Ended' : v.currentTime > 0 ? 'Paused' : 'Not started';
  const time = v.live ? 'LIVE' : v.duration ? `${formatTime(v.currentTime)} / ${formatTime(v.duration)}` : '';
  return { text: time ? `${status} · ${time}` : status, playing };
}

/** Outlines the row's video on the page while hovered. */
function highlight(c: CandidateView | null): void {
  const frameId = c?.video ? (c.videoFrameId ?? c.frameId) : lastHighlightFrame;
  if (c?.video) lastHighlightFrame = frameId;
  void send({ type: 'popup/highlight', tabId, frameId, videoKey: c?.video?.key ?? null }).catch(() => undefined);
}
let lastHighlightFrame = 0;

function candidateRow(c: CandidateView, s: PopupState): HTMLElement {
  const row = document.createElement('label');
  row.className = `candidate${c.id === selectedId ? ' selected' : ''}`;
  row.title = c.url;
  row.addEventListener('mouseenter', () => highlight(c));
  row.addEventListener('mouseleave', () => highlight(null));

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
  if (c.id === s.castingCandidateId) {
    const onTv = document.createElement('span');
    onTv.className = 'tag on-tv';
    onTv.textContent = 'ON TV';
    name.prepend(onTv);
  }

  const player = playerText(c);
  const sub = document.createElement('div');
  sub.className = `sub${player.playing ? ' playing' : ''}`;
  sub.textContent = player.text;
  const tag = (text: string, cls = '') => {
    const span = document.createElement('span');
    span.className = `tag ${cls}`;
    span.textContent = text;
    sub.append(span);
  };
  tag(KIND_LABEL[c.kind] ?? c.kind.toUpperCase());
  if (c.quality) tag(c.quality);
  if (c.live) tag('LIVE');
  if (c.isAd) tag('AD');
  const level = LEVEL_LABEL[c.assessment.level];
  if (level) tag(level, `level-${c.assessment.level}`);
  row.append(radio, name, sub);

  // Why a selected stream may not work, in one line.
  const why = c.assessment.blocker?.message ?? (c.assessment.level === 'likely' ? undefined : c.assessment.notes[0]);
  if (c.id === selectedId && why) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = why;
    row.append(note);
  }
  return row;
}

function renderNow(status: CastStatus | null): void {
  const section = $('now');
  const active = !!status && (status.sessionActive || !['idle', 'error'].includes(status.phase));
  section.hidden = !active;
  if (status?.phase === 'error' && status.error) showError(status.error);
  if (!status || !active) return;

  const subs = $<HTMLSelectElement>('now-subs');
  $('now-subs-row').hidden = !status.textTracks?.length;
  if (status.textTracks?.length && document.activeElement !== subs) {
    subs.replaceChildren(new Option('Off', ''), ...status.textTracks.map((t) => new Option(t.name, String(t.id))));
    subs.value = status.activeTextTrack ? String(status.activeTextTrack) : '';
  }
  const phase = $('now-phase');
  phase.textContent = PHASE_LABELS[status.phase] ?? status.phase;
  phase.className = `pill${status.phase === 'playing' ? ' on' : ''}`;
  $('now-title').textContent = status.title ?? '';

  const seek = $<HTMLInputElement>('now-seek');
  seek.disabled = status.live || !status.canSeek || !status.duration;
  seek.max = String(Math.max(0, Math.floor(status.duration ?? 0)));
  if (!seeking) seek.value = String(Math.floor(status.currentTime));
  $('now-time').textContent = formatTime(seeking ? Number(seek.value) : status.currentTime);
  $('now-duration').textContent = status.live ? 'LIVE' : formatTime(status.duration);

  $('btn-play').innerHTML = status.phase === 'playing' || status.phase === 'buffering' ? ICON.pause : ICON.play;
  $('btn-mute').innerHTML = status.muted ? ICON.muted : ICON.sound;
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
    casting = true;
    button.disabled = true;
    button.textContent = 'Starting…';
    showError(null);
    const deviceId = $<HTMLSelectElement>('device').value || undefined;
    const response = await send<PopupCastResponse>({ type: 'popup/cast', tabId, candidateId: selectedId, deviceId });
    casting = false;
    if (!response.ok) showError(response.error);
    await refresh();
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
  $('now-subs').addEventListener('change', () => {
    const value = $<HTMLSelectElement>('now-subs').value;
    void command({ type: 'subtitles', trackId: value ? Number(value) : null });
  });

  $('device').addEventListener('change', () => void send({ type: 'popup/set-device', deviceId: $<HTMLSelectElement>('device').value }));
  $('settings-toggle').addEventListener('click', () => {
    const settings = $('settings');
    settings.hidden = !settings.hidden;
    $('settings-toggle').classList.toggle('on', !settings.hidden);
  });
  $('engine-mode').addEventListener('change', async () => {
    await send({ type: 'popup/set-engine', mode: $<HTMLSelectElement>('engine-mode').value as EngineMode });
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

  $('reload-ext').addEventListener('click', () => chrome.runtime.reload());
  $('copy-diag').addEventListener('click', (e) => void copyDiagnostics(e.currentTarget as HTMLElement));
  $('stop-trying').addEventListener('click', async () => {
    await send({ type: 'popup/cast-cancel' });
    await refresh();
  });
  $('close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('blur', () => highlight(null));

  // Live updates: receiver status, devices and tab detections are written to storage.session by the worker.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    refreshTimer ??= setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, 300);
  };
  chrome.storage.session.onChanged.addListener((changes) => {
    if (!state) return;
    if (changes.castStatus) {
      const previous = state.castStatus;
      state.castStatus = (changes.castStatus.newValue as CastStatus | undefined) ?? null;
      renderNow(state.castStatus);
      if (previous?.sessionActive !== state.castStatus?.sessionActive || previous?.requestId !== state.castStatus?.requestId) refreshSoon();
    }
    if (changes.castNotice) {
      state.notice = (changes.castNotice.newValue as string | undefined) ?? null;
      renderNotice(state.notice);
    }
    if (changes.syncTarget || changes.castContext || changes.devices || changes[`tab:${tabId}`]) refreshSoon();
  });
}

/** The panel loads the popup page from inside the web page; only Castit's own panel may. */
async function authorized(): Promise<boolean> {
  if (!embedded) return true;
  const token = new URLSearchParams(location.hash.slice(1)).get('panel');
  const stored = (await chrome.storage.session.get('panelToken')).panelToken as string | undefined;
  return !!token && token === stored;
}

/** Keeps the page panel as tall as the content. */
function reportSize(): void {
  const post = () => window.parent.postMessage({ castitPanel: 'size', height: document.body.getBoundingClientRect().height }, '*');
  new ResizeObserver(post).observe(document.body);
  post();
}

async function main(): Promise<void> {
  if (embedded) document.documentElement.classList.add('embedded');
  if (!(await authorized())) {
    document.body.replaceChildren();
    return;
  }
  const tab = (embedded ? await chrome.tabs.getCurrent() : undefined) ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id ?? -1;
  $('close').hidden = !embedded;
  wire();
  if (embedded) reportSize();
  await refresh();
}

void main();
