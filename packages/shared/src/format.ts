/** Formats seconds as m:ss or h:mm:ss. */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  loading: 'Loading…',
  buffering: 'Buffering…',
  playing: 'Playing',
  paused: 'Paused',
  ended: 'Ended',
  error: 'Error',
};
