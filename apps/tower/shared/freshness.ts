// Age / staleness math for the freshness badges (doc 10 principle 2: every tile
// shows the age of its data; the badge turns amber past 2× the lane's expected
// cadence). Pure functions, shared by the Worker (ingest summary) and the client
// (per-tile <AgeBadge>) so "amber" means the same thing on both sides.

import { AMBER_MULTIPLIER, CADENCE_HOURS } from "./wall";

const HOUR_MS = 3_600_000;

/** Milliseconds since `iso`, or null if absent/unparseable. Never negative. */
export function ageMs(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

/** Amber = data older than `multiplier`× the lane cadence. Missing data (no
 * timestamp) is treated as amber — an absent age is never "fresh". */
export function isAmber(
  nowMs: number,
  iso: string | null | undefined,
  cadenceHours: number,
  multiplier: number = AMBER_MULTIPLIER,
): boolean {
  const age = ageMs(nowMs, iso);
  if (age === null) return true;
  return age > cadenceHours * HOUR_MS * multiplier;
}

/** Compact human age: "12s", "5m", "3h", "9d", or "—" when unknown. */
export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** Convenience for the pulse lane (nightly cadence). */
export function pulseAmber(nowMs: number, iso: string | null | undefined): boolean {
  return isAmber(nowMs, iso, CADENCE_HOURS.pulse);
}
