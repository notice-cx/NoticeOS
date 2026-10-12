import { CircleCheck } from "lucide-react";
import { sitePath } from "@shared/first-run";
import type { AssetCard, SystemBand } from "@shared/wall";
import type { WallFeedItem } from "@shared/wall-feed";
import { EventTimeline, type TimelineEvent, type TimelineLane, type TimelineSpan } from "@/components/viz/EventTimeline";
import { IssueGlyph } from "@/components/wall/NeedsYou";
import { useWallFeed } from "@/hooks/useWallFeed";
import { timelineFromWall } from "@/lib/viz-adapters";
import type { WallIssue } from "@/lib/wall-issues";
import { withSystemIssues } from "@/lib/wall-system-state";

// The Wall's account of what is broken: every open problem as a bar from its
// onset to now and the feed's stored events as marks, one row per site and
// one for the System, on the last 24 hours. The TV has a fixed height, so it
// draws the worst problems that fit and counts the rest in its heading.

const DAY_MS = 86_400_000;
/**
 * Bars and mark rows the TV draws: Needs you's top three. Every open bar ends
 * at now, so a site's bars never share a line and each costs one; a row of
 * marks costs one more. Three keep seven sites' rows whole beside it at
 * 1920×1080.
 */
export const WALL_TIMELINE_ROWS = 3;

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

interface Timeline {
  lanes: TimelineLane[];
  spans: TimelineSpan[];
  events: TimelineEvent[];
}

const SEVERITY_RANK = { error: 0, warn: 1 } as const;

/**
 * What fits `budget` lines, worst first: open errors, then open warnings (the
 * newest first within each), then the rows of marks, a problem's own row
 * before a quiet one. Returns how many problems were left undrawn.
 */
export function fitTimeline(timeline: Timeline, fromMs: number, toMs: number, budget: number): Timeline & { more: number } {
  const order = new Map(timeline.lanes.map((lane, index) => [lane.id, index]));
  const onset = (span: TimelineSpan) => (span.from === null ? Number.NEGATIVE_INFINITY : Date.parse(span.from));
  const open = timeline.spans
    .filter((span) => span.to === null)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || onset(b) - onset(a));
  const spans = open.slice(0, Math.max(0, budget));
  let left = budget - spans.length;
  const withProblems = new Set(spans.map((span) => span.lane));
  const events = timeline.events.filter((event) => {
    const at = Date.parse(event.at);
    return at >= fromMs && at <= toMs;
  });
  const marked = [...new Set(events.map((event) => event.lane))].sort(
    (a, b) => Number(withProblems.has(b)) - Number(withProblems.has(a)) || (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
  );
  const markRows = new Set<string>();
  for (const lane of marked) {
    if (left <= 0) break;
    markRows.add(lane);
    left -= 1;
  }
  const kept = new Set([...withProblems, ...markRows]);
  return {
    lanes: timeline.lanes.filter((lane) => kept.has(lane.id)),
    spans,
    events: events.filter((event) => markRows.has(event.lane)),
    more: open.length - spans.length,
  };
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

export interface WallTimelineProps {
  assets: AssetCard[];
  /** Every open problem (`wallIssues`); the System's own are added here. */
  issues: readonly WallIssue[];
  system?: SystemBand;
  /** The feed's stored events, newest first. */
  feed: readonly WallFeedItem[];
  /** The feed window's start, the dashed rule; null before the first read. */
  since: string | null;
  /** The feed's last read failed: its marks are the last good ones. */
  failed?: boolean;
  nowMs: number;
}

export function WallTimeline({ assets, issues, system, feed, since, failed = false, nowMs }: WallTimelineProps) {
  const all = withSystemIssues(issues, system, nowMs);
  const fromMs = nowMs - DAY_MS;
  // A site the widget's filter left out keeps its events off the System's row.
  const shown = new Set<string | null>([null, system?.assetId ?? null, ...assets.map((asset) => asset.id)]);
  const marks = feed.filter((item) => shown.has(item.asset));
  const fitted = fitTimeline(timelineFromWall(assets, all, marks, sitePath), fromMs, nowMs, WALL_TIMELINE_ROWS);
  const errors = all.filter((issue) => issue.severity === "error").length;
  const warnings = all.length - errors;
  // Every condition this widget evaluates, so the materiality suite finds its
  // calm too: the System's four only when the System was read.
  const conditions = new Set<string>(["open-flags", "rollback-failure", "signal-freshness"]);
  if (system) for (const condition of ["os-runner-health", "scheduled-lane-health", "budget-guardrail"]) conditions.add(condition);

  return (
    // The axis's rules reach a few pixels past each row by design; the bottom
    // padding is the room they paint into, and the clip keeps them there.
    <section
      aria-label="The last 24 hours"
      className="flex min-w-0 flex-col gap-2 overflow-hidden pb-1"
      data-wall-timeline={all.length > 0 ? "problems" : "calm"}
      data-material-condition={[...conditions].join(" ")}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Last 24 hours</h2>
        <span className="inline-flex items-center gap-1.5 text-wall-micro tabular-nums text-muted-foreground" data-timeline-status>
          {all.length === 0 ? (
            <>
              <CircleCheck className="size-4 shrink-0 text-healthy" aria-hidden />
              Nothing broken
            </>
          ) : (
            <>
              <IssueGlyph severity={errors > 0 ? "error" : "warn"} className="size-4 shrink-0" />
              {[errors > 0 ? plural(errors, "error") : null, warnings > 0 ? plural(warnings, "warning") : null].filter(Boolean).join(" · ")}
            </>
          )}
          {fitted.more > 0 ? <span data-timeline-more> · +{fitted.more} more</span> : null}
          {failed ? <span data-timeline-reconnecting> · Reconnecting</span> : null}
        </span>
      </div>
      <EventTimeline
        lanes={fitted.lanes}
        spans={fitted.spans}
        events={fitted.events}
        window={{ from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() }}
        nowMs={nowMs}
        marker={since ? { at: since, label: "Since last night" } : undefined}
        readOnly
        ariaLabel="What happened in the last 24 hours"
      />
    </section>
  );
}

/** The widget the Wall draws: the timeline, with the feed's own read for its marks. */
export function WallTimelineWidget(props: Omit<WallTimelineProps, "feed" | "since" | "failed">) {
  const { data, isError } = useWallFeed();
  return <WallTimeline {...props} feed={data?.items ?? []} since={data?.since ?? null} failed={isError} />;
}
