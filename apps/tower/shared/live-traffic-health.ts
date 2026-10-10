import type { Ga4RealtimeAsset } from '@noticeos/contract';

/** How old a realtime reading may be before the Wall calls it out of date. The
 * worst-case chain from a Google read to the pixel is about 170s (60s ingest
 * cache, 30s dashboard poll, up to 50s of serial property refreshes, 30s Wall
 * clock); 180s clears it and stays inside the counter's own 5-minute window. */
export const LIVE_TRAFFIC_FRESH_MS = 180_000;

export function liveTrafficIsRecent(iso: string, nowMs: number): boolean {
  const age = nowMs - Date.parse(iso);
  return Number.isFinite(age) && age >= -10_000 && age < LIVE_TRAFFIC_FRESH_MS;
}

/** What went wrong with a live read, as the words the Wall shows — never the
 * raw code. A retry is automatic and dated by the snapshot's `nextAttemptAt`,
 * so none needs a sentence. */
export function liveTrafficFailure(code: string | undefined): string {
  if (code === 'ga4_read_in_progress') return 'Checking traffic';
  if (code === 'ga4_read_cache_unavailable' || code === 'ga4_read_coordination_unavailable') return 'Traffic refresh unavailable';
  if (code && /_http_429$/.test(code)) return 'Google rate limit';
  if (code && /(_http_40[13]$|invalid_grant|credential|oauth|auth_failed)/.test(code)) return 'Google access issue';
  if (code?.startsWith('ga4_intraday')) return 'Traffic report unavailable';
  return 'Live traffic unavailable';
}

/**
 * The one live-traffic issue a Wall site row names, or null when its reading
 * is good (`LiveUsers`). The hourly comparison's own state is not an issue
 * here: the realtime counts still work without it.
 */
export function liveTrafficCardIssue(snapshot: Ga4RealtimeAsset | undefined, reconnecting: boolean, nowMs: number): string | null {
  if (reconnecting) return snapshot?.status === 'success' ? 'Reconnecting' : 'Live traffic unavailable';
  if (snapshot?.status === 'error' && Date.parse(snapshot.observedAt) <= nowMs + 10_000 && Date.parse(snapshot.nextAttemptAt ?? '') > nowMs) return liveTrafficFailure(snapshot.errorCode);
  if (snapshot && !liveTrafficIsRecent(snapshot.observedAt, nowMs)) return 'Reading out of date';
  return snapshot?.status === 'error' ? liveTrafficFailure(snapshot.errorCode) : null;
}
