import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ListTodo } from "lucide-react";
import type { AssetCard, OperatorPosture } from "@shared/wall";
import { sumWorkWeeks } from "@shared/work";
import { WorkFlow, weekDaysIn, workRowsThatFit } from "@/components/viz/WorkFlow";
import { operatorWaiting } from "@/lib/operator-posture";
import { workFlowRows } from "@/lib/viz-adapters";

// The work as flow on the TV: what waits on the operator, what is in
// progress, done this week and blocked, each with its move over the week,
// this week's done against last week's on one bar, then one row per project,
// done growing left and the open queue right. Read-only: no row links anywhere.
//
// The tile is as tall as its content, so Fit content gives it nothing more.
// Given less (Fill the rest, or a share of its column), it draws the rows
// that fit whole and counts the rest on one line.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

export interface WallWorkProps {
  assets: readonly AssetCard[];
  /** The core inbox; null or absent stays unknown, never zero. */
  operator: OperatorPosture | null | undefined;
  nowMs: number;
}

export function WallWork({ assets, operator, nowMs }: WallWorkProps) {
  const rows = workFlowRows(assets);
  const waiting = operatorWaiting(operator, nowMs);
  // The weeks of the projects the rows draw, summed: one reading per figure.
  const weeks = sumWorkWeeks(assets.filter((asset) => asset.work).map((asset) => asset.work!.weeks));
  const shown = useRowsThatFit(rows.length);
  // Nothing read at all (no task source yet, or no snapshot): one quiet line,
  // the words Needs you uses, rather than a chart of unknowns.
  if (rows.length === 0 && waiting === null) {
    return (
      <section
        aria-label="Work this week"
        className="flex min-w-0 items-center gap-3 text-wall-body text-muted-foreground"
        data-wall-work="none"
        data-material-condition="human-gates"
      >
        <ListTodo className="size-6 shrink-0" aria-hidden />
        Tasks unknown
      </section>
    );
  }
  return (
    // Positioned, so each row's offset is read from the tile's own top.
    <div ref={shown.ref} className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-wall-work data-work-shown={shown.count ?? rows.length}>
      <WorkFlow
        rows={rows}
        waiting={waiting}
        weeks={weeks}
        title="Work this week"
        compact
        shownRows={shown.count ?? undefined}
        headingClassName={eyebrow}
        action={weeks ? <span className="text-wall-detail tabular-nums text-muted-foreground" data-work-days-in={weeks.daysIn}>{weekDaysIn(weeks.daysIn)}</span> : null}
      />
    </div>
  );
}

/**
 * How many project rows the tile's box holds whole (`workRowsThatFit`), read
 * from the drawn tile: its height, where its first row (or the line counting
 * the rest) starts, and one row's height. Null while every row fits, and
 * where nothing is laid out.
 */
function useRowsThatFit(rows: number): { ref: RefObject<HTMLDivElement | null>; count: number | null } {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number | null>(null);
  useLayoutEffect(() => {
    const tile = ref.current;
    if (!tile) return;
    const measure = () => {
      const first = tile.querySelector<HTMLElement>("[data-work-row], [data-work-more]");
      if (!first || tile.clientHeight === 0 || first.offsetHeight === 0) return setCount(null);
      const fits = workRowsThatFit({ height: tile.clientHeight, top: first.offsetTop, row: first.offsetHeight, rows });
      setCount(fits >= rows ? null : fits);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [rows]);
  return { ref, count };
}
