import type { Ga4RealtimeAsset } from '@noticeos/contract';

/** Live UI reads are independent of the scheduled collection evidence.
 *
 * How old a realtime reading may be before the Wall calls it out of date. The
 * budget is the sum of the clocks between a Google read and the pixel, at their
 * worst: the ingest serves a cached reading for up to 60s (one reading a
 * minute since the minute pulse, bead `ro-trai.27`; 30s before it), the
 * dashboard polls every 30s, one poll can wait up to 50s while five properties
 * refresh in series (the 15-minute hourly report rides in the same request,
 * each read on a 10s timeout), and the Wall's own clock ticks every 30s —
 * about 170s in all. 90s sat inside the old 140s budget, so a healthy feed
 * flashed "Reading out of date" for a few seconds every hourly refresh
 * (2026-09-14). 180s clears it and is still shorter than the 5-minute window
 * the counter reports, so a reading older than this is stale by the counter's
 * own definition. */
export const LIVE_TRAFFIC_FRESH_MS = 180_000;

export function liveTrafficIsRecent(iso: string, nowMs: number): boolean {
  const age = nowMs - Date.parse(iso);
  return Number.isFinite(age) && age >= -10_000 && age < LIVE_TRAFFIC_FRESH_MS;
}

/** What went wrong with a live read, as the words the Wall shows — never the
 * raw code. A retry is automatic and dated by the snapshot's `nextAttemptAt`,
 * so none needs a sentence (bead `ro-ujb9.96.6.2`). */
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
 * here: the realtime counts still work without it. Since bead `ro-trai.41`
 * this is the one reading of the live-traffic states; the page-wide summary
 * no screen drew is gone.
 */
export function liveTrafficCardIssue(snapshot: Ga4RealtimeAsset | undefined, reconnecting: boolean, nowMs: number): string | null {
  if (reconnecting) return snapshot?.status === 'success' ? 'Reconnecting' : 'Live traffic unavailable';
  if (snapshot?.status === 'error' && Date.parse(snapshot.observedAt) <= nowMs + 10_000 && Date.parse(snapshot.nextAttemptAt ?? '') > nowMs) return liveTrafficFailure(snapshot.errorCode);
  if (snapshot && !liveTrafficIsRecent(snapshot.observedAt, nowMs)) return 'Reading out of date';
  return snapshot?.status === 'error' ? liveTrafficFailure(snapshot.errorCode) : null;
}
