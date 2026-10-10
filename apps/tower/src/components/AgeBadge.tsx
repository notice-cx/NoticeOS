import { CalendarOff, CircleHelp, CircleSlash2, Clock, ClockAlert } from "lucide-react";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { cn } from "@/lib/utils";

export interface AgeBadgeProps {
  /** Timestamp of the data this tile shows (ISO), or null if never received. */
  iso: string | null;
  /** The lane's expected cadence in hours; amber past 2×. */
  cadenceHours: number;
  /** Injected for deterministic tests; defaults to now. */
  nowMs?: number;
  /** True when the tile is showing a last-good value after a failed fetch. */
  lastGood?: boolean;
  className?: string;
}

/** Every tile carries one. Amber once the data is older than 2× its lane
 * cadence, because a stale tile that looks current hides a silent failure.
 * The badge owns the absent case: no timestamp says "never", and a timestamp
 * that cannot be parsed says "unknown", since "never" would be untrue. */
export function AgeBadge({ iso, cadenceHours, nowMs = Date.now(), lastGood = false, className }: AgeBadgeProps) {
  const amber = isAmber(nowMs, iso, cadenceHours);
  const ms = ageMs(nowMs, iso);
  const state = ms !== null ? "aged" : iso ? "unreadable" : "never";
  /* Stale is a glyph as well as amber, and says "stale" to a screen reader,
     so it does not depend on colour or a hover title. */
  const Icon =
    state === "never" ? CalendarOff : state === "unreadable" ? CircleHelp : amber ? ClockAlert : Clock;
  return (
    <span
      data-age-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
        amber ? "bg-warn-soft text-warn" : "bg-muted text-muted-foreground",
        className,
      )}
      title={
        state === "never"
          ? "Never reported — nothing has ever arrived from this source"
          : state === "unreadable"
            ? "The stored timestamp for this source could not be read"
            : amber
              ? "Stale — data is older than 2× its expected cadence"
              : lastGood
                ? "Last-good value (last fetch failed)"
                : "Data age"
      }
    >
      <Icon className="size-3" aria-hidden data-age-glyph={state === "aged" && amber ? "stale" : state} />
      {state === "never" ? "never" : state === "unreadable" ? "unknown" : formatAge(ms)}
      {state === "aged" && amber ? <span className="sr-only"> · stale</span> : null}
      {lastGood ? " · last-good" : ""}
    </span>
  );
}

/**
 * The nightly slot of an asset that declares it sends no report: nothing is
 * owed, so the neutral Not using slash, never amber and never "never".
 */
export function NoNightlyReport() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      title="Sends no nightly report"
      data-nightly-report="none"
    >
      <CircleSlash2 aria-hidden className="size-3" />
      No report
    </span>
  );
}
