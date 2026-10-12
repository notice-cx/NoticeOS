import type { CSSProperties, ReactNode } from "react";
import { SectionLabel, type SectionLabelAction } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

// Several measures, each against its own earlier window, in one ruled panel:
// the measure and its figure, its recent days as bars against the earlier
// level, and how far it moved as a bar growing from one shared zero line,
// right for better and left for worse. The eye runs down the change column to
// see which numbers rose and which fell before it reads a single percentage.
// The bars share one scale across the panel (and across panels given the same
// `scale`), so a long bar is a big move wherever it sits.

export interface ChangeRow {
  key: string;
  /** The measure: "Active users". */
  label: string;
  /** The window's figure, formatted; null when there is none, said by `absent`. */
  figure: string | null;
  /** Read after the figure, a step lighter: "a day", "visits". */
  unit?: string;
  /** Why there is no figure, in the operator's words. */
  absent?: string;
  /** Signed percent in the good direction: +12 is 12% better, whichever way
   * the raw number went. Null when there is no number to draw. */
  improvement: number | null;
  /** The change in words beside its bar: a `DeltaChip`, "Not comparable". */
  change?: ReactNode;
  /** The recent days, as a `BarStrip` with the earlier level as its baseline. */
  history?: ReactNode;
  /** Pressing the row; omitted, the row is a plain line. */
  onSelect?: () => void;
  selected?: boolean;
  marks?: Record<`data-${string}`, string>;
}

export interface ChangeRowsProps {
  title: string;
  caption?: ReactNode;
  action?: SectionLabelAction;
  rows: readonly ChangeRow[];
  /** What every change is measured against: "vs prior 28 days". */
  against: string;
  /** The percent a full half-bar stands for. Panels side by side pass the
   * same value so their bars compare; by default the largest move here. */
  scale?: number;
  id?: string;
  className?: string;
}

/** The scale a set of moves is drawn on: the largest, kept between 10% and
 * 100% so a quiet week still draws visible bars and one wild move does not
 * flatten the rest (it runs to the end of its half). */
export function changeScale(moves: readonly (number | null)[]): number {
  const largest = Math.max(0, ...moves.map((move) => (move === null ? 0 : Math.abs(move))));
  return Math.min(100, Math.max(10, Math.ceil(largest / 5) * 5));
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_auto] @lg:grid-cols-[minmax(8rem,11rem)_minmax(0,1fr)_minmax(7.5rem,10rem)]";

export function ChangeRows({ title, caption, action, rows, against, scale, id, className }: ChangeRowsProps) {
  const span = scale ?? changeScale(rows.map((row) => row.improvement));
  return (
    <section
      id={id}
      aria-label={title}
      data-change-rows=""
      className={cn("@container flex min-w-0 scroll-mt-4 flex-col rounded-xl bg-card ring-1 ring-border/70", className)}
    >
      <SectionLabel title={title} caption={caption} action={action} className="px-5 pb-2 pt-4" />
      <div className={cn("hidden gap-x-4 border-b border-border/60 px-5 pb-1.5 text-micro text-muted-foreground @lg:grid", COLUMNS)} aria-hidden>
        <span />
        <span />
        <span className="flex flex-col gap-0.5">
          <span className="text-center text-foreground/80">{against}</span>
          <span className="flex justify-between gap-2">
            <span>worse</span>
            <span>better</span>
          </span>
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map((row, index) => (
          <Row key={row.key} row={row} span={span} index={index} />
        ))}
      </ul>
    </section>
  );
}

function Row({ row, span, index }: { row: ChangeRow; span: number; index: number }) {
  const body = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          {row.figure === null ? (
            <span className="text-sm font-medium text-muted-foreground" data-change-absent="">
              {row.absent ?? "not reported yet"}
            </span>
          ) : (
            <>
              <span className="text-figure-sm tabular-nums text-foreground">{row.figure}</span>
              {row.unit ? <span className="text-xs text-muted-foreground">{row.unit}</span> : null}
            </>
          )}
        </span>
      </span>
      <span className="order-last col-span-2 min-w-0 @lg:order-none @lg:col-span-1">{row.history}</span>
      <span className="flex min-w-0 flex-col items-end gap-1 @lg:items-stretch">
        <ChangeBar improvement={row.improvement} span={span} index={index} />
        {row.change ? <span className="flex justify-end text-xs tabular-nums @lg:justify-center">{row.change}</span> : null}
      </span>
    </>
  );
  const grid = cn("grid w-full items-center gap-x-4 gap-y-2 px-5 py-3 text-start", COLUMNS);
  return (
    <li
      className="viz-arrive m-0 border-b border-border/40 last:border-b-0"
      style={{ "--viz-i": index } as CSSProperties}
      data-change-row={row.key}
      {...row.marks}
    >
      {row.onSelect ? (
        <button
          type="button"
          aria-pressed={row.selected ?? false}
          onClick={row.onSelect}
          className={cn(grid, "outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", row.selected && "bg-muted/40")}
        >
          {body}
        </button>
      ) : (
        <div className={grid}>{body}</div>
      )}
    </li>
  );
}

/** One move from the shared zero line: right and in the better ink when it
 * improved, left and in the worse ink when it did not. Past the scale the bar
 * stops at the end of its half. */
function ChangeBar({ improvement, span, index }: { improvement: number | null; span: number; index: number }) {
  const width = improvement === null ? 0 : Math.min(Math.abs(improvement), span) / span * 50;
  const better = improvement !== null && improvement > 0;
  return (
    <span
      aria-hidden
      className="relative block h-2.5 w-28 @lg:w-full"
      data-change-bar={improvement === null ? "none" : better ? "better" : improvement < 0 ? "worse" : "level"}
    >
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-viz-grid" />
      <span className="absolute inset-y-[-3px] start-1/2 w-px bg-muted-foreground/60" />
      {width > 0 ? (
        <span
          className={cn(
            "viz-grow-x absolute inset-y-0 rounded-full",
            better ? "start-1/2 bg-trend-positive" : "end-1/2 viz-from-end bg-trend-negative",
          )}
          style={{ width: `${Math.max(width, 1.5)}%`, "--viz-i": index } as CSSProperties}
        />
      ) : null}
    </span>
  );
}
