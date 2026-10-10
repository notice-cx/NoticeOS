import type { Ga4RealtimeAsset } from "@noticeos/contract";
import { ClockAlert } from "lucide-react";
import { useState } from "react";
import { ageMs, formatAge } from "@shared/freshness";
import { liveTrafficCardIssue } from "@shared/live-traffic-health";
import type { AssetCard } from "@shared/wall";
import { MinutePulse, type MinutePulseSize } from "@/components/surface/MinutePulse";
import { formatInt } from "@/lib/format";
import { useTweenedNumber } from "@/lib/use-tweened-number";

// A site's live users on the Wall: "84 · 30 min", the figure counting to each
// new reading, over the minute pulse, with "19 · 5 min" beside its bright end.
// One cell for every tier: a compact row, a roomier row, a phone card and the
// one-site Today tile.
//
// Honest in every state, never a zero it did not read:
//   fresh     the reading as it is;
//   stale     older than three minutes (`liveTrafficCardIssue`): the figures
//             and the pulse drop to neutral ink beside a clock and the age;
//   failed    the last read was refused: the last pulse this cell drew stays,
//             dimmed the same way with its age — the failure's label is the
//             clock's name;
//   none      no GA4 on the site, or no reading yet: a dash.

type Reading = Extract<Ga4RealtimeAsset, { status: "success" }>;

export type LiveState = "fresh" | "stale" | "failed" | "none";

/**
 * The reading to draw: the snapshot when it is one, otherwise the last one this
 * cell drew. The Wall's poll replaces a refused site's reading with its error,
 * and "a failed read keeps the last pulse" is the cell's to remember.
 */
export function useLastGoodReading(snapshot: Ga4RealtimeAsset | undefined): Reading | undefined {
  const current = snapshot?.status === "success" ? snapshot : undefined;
  const [kept, setKept] = useState<Reading | undefined>(current);
  // The documented render-time update ("storing information from previous
  // renders"): no effect, so the kept reading is never a frame behind.
  if (current && current !== kept) setKept(current);
  return current ?? kept;
}

/** Which of the four states a cell is in, from what it was given. */
export function liveState(snapshot: Ga4RealtimeAsset | undefined, shown: Reading | undefined, issue: string | null): LiveState {
  if (!shown) return "none";
  if (snapshot?.status !== "success") return "failed";
  return issue ? "stale" : "fresh";
}

export interface LiveUsersProps {
  asset: AssetCard;
  snapshot: Ga4RealtimeAsset | undefined;
  reconnecting: boolean;
  nowMs: number;
  /** Off where it is not in the table. */
  cell?: boolean;
  /** The figure's type step. */
  face?: string;
  /** The pulse's size; follows the face unless the caller says. */
  size?: MinutePulseSize;
}

export function LiveUsers({ asset, snapshot, reconnecting, nowMs, cell = true, face = "text-wall-stat", size }: LiveUsersProps) {
  const role = cell ? "cell" : undefined;
  const collects = asset.dataSources.some(
    (source) => source.id === "ga4" && (source.state === "live" || source.state === "degraded"),
  );
  const kept = useLastGoodReading(snapshot);
  const shown = collects ? kept : undefined;
  const issue = liveTrafficCardIssue(snapshot, reconnecting, nowMs);
  const state = liveState(snapshot, shown, issue);
  if (!shown) {
    return (
      <span role={role} className="text-wall-stat text-muted-foreground" title={issue ?? undefined} data-live="none">
        —
      </span>
    );
  }
  const dimmed = state !== "fresh";
  const pulse = size ?? (face === "text-wall-hero-sm" ? "roomy" : "row");
  // The words beside a figure: a compact row's are the Wall's smallest step.
  const unit = pulse === "row" ? "text-wall-micro" : "text-wall-body";
  const minutes = shown.activeUsersByMinute ?? null;
  // A roomier row has height to spare and no width (its charts are at their
  // floors), so its count takes a line of its own; a compact row has neither,
  // and the count shares the figure's line; the one-site tile has both.
  const stacked = pulse === "roomy";
  // Over the bright end of the pulse: that window's own count — or, when the
  // reading is old, how old, since its last five minutes no longer are.
  const end = dimmed ? (
    <span className={`ml-auto inline-flex items-center gap-1 self-center ${unit} text-muted-foreground tabular-nums`} data-live-age>
      <ClockAlert className="size-4 shrink-0 text-warn" aria-label={issue ?? "Reading out of date"} role="img" />
      {formatAge(ageMs(nowMs, shown.observedAt))}
    </span>
  ) : (
    // Clear of the unit when one is drawn; in the table the header carries
    // it and the cell stays as narrow as its figures.
    <RecentCount value={shown.activeUsers5m} unit={unit} space={stacked ? "" : cell ? "pl-2 sites:pl-0" : "pl-3"} />
  );
  return (
    <span
      role={role}
      // As wide as its column, so every row's pulse ends on the same line.
      className="flex min-w-0 flex-col gap-1"
      title={issue ?? undefined}
      data-live={state}
    >
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <LiveCount value={shown.activeUsers30m} face={face} dimmed={dimmed} />
        {/* Said once in the table's header (`LIVE_HEADING`); a phone's
            stacked row and the one-site tile have none. */}
        <span className={`${unit} text-muted-foreground ${cell ? "sites:hidden" : ""}`} data-live-unit>
          {`${DOT}30 min`}
        </span>
        {stacked ? null : end}
      </span>
      {stacked ? <span className="flex whitespace-nowrap">{end}</span> : null}
      {minutes ? (
        <span className="flex justify-end" data-live-recent>
          <MinutePulse minutes={minutes} size={pulse} dimmed={dimmed} />
        </span>
      ) : null}
    </span>
  );
}

/** The LIVE column's heading: the figure under it is the last 30 minutes. */
export const LIVE_HEADING = "Live · 30 min";

/** " · " in thin spaces: a figure's unit sits close to it in a narrow cell. */
const DOT = " · ";

/** The 30-minute figure, counting to a new reading. */
function LiveCount({ value, face, dimmed }: { value: number; face: string; dimmed: boolean }) {
  const reading = Math.max(0, Math.round(value));
  const shown = useTweenedNumber(reading);
  return (
    <output
      aria-label={`Live users: ${formatInt(reading)}`}
      aria-live="polite"
      aria-atomic="true"
      className={`${face} font-semibold leading-tight tracking-tight tabular-nums ${dimmed ? "text-muted-foreground" : "text-foreground"}`}
      data-live-count
      data-value={reading}
    >
      {formatInt(shown)}
    </output>
  );
}

/** "19 · 5 min": the bright end's own count, in the pulse's ink. */
function RecentCount({ value, unit, space }: { value: number; unit: string; space: string }) {
  const reading = Math.max(0, Math.round(value));
  const shown = useTweenedNumber(reading);
  return (
    <span className={`ml-auto ${space} ${unit} tabular-nums`} data-live-recent-count data-value={reading}>
      <span className="font-semibold text-traffic">{formatInt(shown)}</span>
      <span className="text-muted-foreground">{`${DOT}5 min`}</span>
    </span>
  );
}
