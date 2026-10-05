import { showsNightlyReport } from "@noticeos/contract/reporting";
import { ageMs, formatAge, isAmber } from "@shared/freshness";
import { CADENCE_HOURS } from "@shared/wall";
import { NoNightlyReport } from "@/components/AgeBadge";
import { ClockAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * How old a site's nightly report is, as one age — amber past twice its
 * cadence — or the neutral "No report" mark when none is expected (bead
 * `ro-pbzu.3`). Home's assets table asks this in its Reported column; it lived
 * beside the pre-D28 Wall card until that card left the Tower (bead
 * `ro-trai.20`), and the threshold, the mark and the hover sentence stay in
 * this one place.
 */
export function ReportFreshness({
  iso,
  nowMs,
  label = true,
  declared = false,
}: {
  iso: string | null;
  nowMs: number;
  /** The word "Updated" before the age. Off where a column header already says
   * it (Home's assets table, bead `ro-78qo.6`): one fact does not need saying
   * twice on one row. */
  label?: boolean;
  /** The operator declared this site sends no nightly report (bead
   * `ro-ujb9.96.8`). */
  declared?: boolean;
}) {
  // No report expected — none ever sent (D29 amended, bead `ro-ujb9.121`) or
  // declared away — and none current: the neutral "No report", glyph and word,
  // no age, never amber.
  if (!iso || !showsNightlyReport(declared, iso, nowMs)) return <NoNightlyReport />;
  const stale = isAmber(nowMs, iso, CADENCE_HOURS.pulse);
  // A late report is a glyph as well as amber, and says "late" to a screen
  // reader (bead `ro-ujb9.14`): the colour and a hover title were the only
  // difference between a late report and an on-time one.
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs tabular-nums", stale ? "text-warn" : "text-muted-foreground")}
      title={stale ? "Nightly report is older than 2× its expected cadence" : "Latest nightly report age; other data sources refresh independently"}
      data-report-late={stale ? "" : undefined}
    >
      {stale ? <ClockAlert aria-hidden className="size-3 shrink-0" /> : null}
      <span>
        {label ? <span className="hidden lg:inline">Updated </span> : null}
        {formatAge(ageMs(nowMs, iso))} ago
        {stale ? <span className="sr-only"> · late</span> : null}
      </span>
    </span>
  );
}
