import { ChevronDown, CircleDot } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Severity } from "@shared/wall";
import { SEVERITY_SHAPE } from "@/components/SeverityDot";
import { cn } from "@/lib/utils";

// One alert on the Alerts board: its mark, what happened, the reading drawn
// against its normal, and how long it has been open, in columns that line up
// down the board. It opens in place like a `ListRow` (the button carries
// `aria-expanded`, the body is `[data-list-row-body]`), and its row verbs sit
// beside the button, never inside it.

/** The columns every row and the board's column heads share. Under 42rem the
 * reading drops under the title and the age keeps its own label. */
export const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 @2xl:grid-cols-[auto_minmax(0,1fr)_minmax(10rem,12rem)_3.5rem_auto]";

/** A wide board under a pointer: the verbs float over the row's end while it
 * is pointed at or focused, so no column is spent on buttons nobody is
 * pressing. Everywhere else they are a line of their own under the row. */
const FLOAT =
  "@2xl:[@media(hover:hover)]:pointer-events-none @2xl:[@media(hover:hover)]:absolute @2xl:[@media(hover:hover)]:inset-y-px @2xl:[@media(hover:hover)]:end-px @2xl:[@media(hover:hover)]:w-auto @2xl:[@media(hover:hover)]:max-w-full @2xl:[@media(hover:hover)]:justify-end @2xl:[@media(hover:hover)]:rounded-e-lg @2xl:[@media(hover:hover)]:bg-card @2xl:[@media(hover:hover)]:p-0 @2xl:[@media(hover:hover)]:pe-3 @2xl:[@media(hover:hover)]:ps-2 @2xl:[@media(hover:hover)]:opacity-0 @2xl:[@media(hover:hover)]:shadow-[-1.5rem_0_1rem_-0.5rem_var(--color-card)]";

const SEVERITY_WORD: Record<Severity, string> = { error: "Error", warn: "Warning", info: "Info" };

/** The severity as a shape, so it is never colour alone, with its word for a
 * screen reader. A parked row wears the muted parked mark instead. */
export function AlertMark({ severity, parked = false, quiet = false }: { severity: Severity; parked?: boolean; quiet?: boolean }) {
  if (parked || severity === "info") {
    return (
      <span className="flex size-5 items-center justify-center text-muted-foreground" data-alert-mark={parked ? "parked" : "info"}>
        <CircleDot aria-hidden className="size-4" strokeWidth={2} />
        <span className="sr-only">{parked ? "Snoozed" : SEVERITY_WORD[severity]}: </span>
      </span>
    );
  }
  const Shape = SEVERITY_SHAPE[severity];
  return (
    <span className={cn("flex size-5 items-center justify-center", severity === "error" ? "text-error" : "text-warn", quiet && "opacity-60")} data-alert-mark={severity}>
      <Shape aria-hidden className="size-4" strokeWidth={2.25} />
      <span className="sr-only">{SEVERITY_WORD[severity]}: </span>
    </span>
  );
}

export interface BoardRowProps {
  mark: ReactNode;
  title: ReactNode;
  caption?: ReactNode;
  /** The reading against its normal: a column on a desk, a line under the
   * title on a phone. */
  evidence?: ReactNode;
  /** How long it has been open. */
  age: string;
  /** What the age is: a column head names it on a desk, so there it is read
   * aloud only; `always` keeps it on screen at every width. */
  ageLabel: string;
  ageLabelAlways?: boolean;
  /** The row's one decision, on the row: quiet on a desk until the row is
   * pointed at or focused. */
  rowActions?: ReactNode;
  /** The rarer verbs, inside the opened row after the evidence. */
  actions?: ReactNode;
  children?: ReactNode;
  /** A link named this row: open it and bring it into view. */
  focused?: boolean;
  quiet?: boolean;
  marks?: Record<`data-${string}`, string>;
}

export function BoardRow({
  mark,
  title,
  caption,
  evidence,
  age,
  ageLabel,
  ageLabelAlways = false,
  rowActions,
  actions,
  children,
  focused = false,
  quiet = false,
  marks,
}: BoardRowProps) {
  const [open, setOpen] = useState(focused);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);

  return (
    <li
      ref={ref}
      className={cn("group/row m-0 rounded-lg ring-inset hover:ring-1 hover:ring-border/70", open && "ring-1 ring-border/70")}
      data-open={open}
      {...marks}
    >
      <div className="relative flex flex-wrap items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={cn(ROW_GRID, "w-full min-w-0 rounded-lg px-3 py-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        >
          <span className="col-start-1 row-start-1">{mark}</span>
          <span className="col-start-2 row-start-1 grid min-w-0 gap-0.5">
            <span className={cn("text-sm font-medium break-words", quiet ? "text-muted-foreground" : "text-foreground")}>
              {title}
            </span>
            {caption ? (
              // A sentence: it wraps rather than losing its end to an ellipsis.
              <span className="text-xs text-muted-foreground">{caption}</span>
            ) : null}
          </span>
          {evidence ? (
            <span className="col-span-2 col-start-2 row-start-2 block w-full max-w-xs @2xl:col-span-1 @2xl:col-start-3 @2xl:row-start-1 @2xl:max-w-none" data-alert-reading="">
              {evidence}
            </span>
          ) : null}
          <span className="col-start-3 row-start-1 flex flex-col items-end gap-0.5 @2xl:col-start-4">
            <span className={cn("whitespace-nowrap text-sm font-semibold tabular-nums", quiet ? "text-muted-foreground" : "text-foreground")}>{age}</span>
            <span className={cn("whitespace-nowrap text-micro text-muted-foreground", !ageLabelAlways && "@2xl:sr-only")}>{ageLabel}</span>
          </span>
          <ChevronDown
            aria-hidden
            data-row-affordance="expand"
            className={cn("col-start-4 row-start-1 size-4 text-muted-foreground motion-safe:transition-transform @2xl:col-start-5", open && "rotate-180")}
          />
        </button>
        {rowActions ? (
          <span
            className={cn(
              "flex w-full flex-wrap items-center gap-1 pb-2 pe-2 ps-11",
              FLOAT,
              "motion-safe:transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 has-[[data-snooze-picker]]:pointer-events-auto has-[[data-snooze-picker]]:opacity-100",
            )}
            data-list-row-actions=""
          >
            {rowActions}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 px-3 pb-3 ps-11 text-xs leading-relaxed text-muted-foreground max-sm:wrap-anywhere" data-list-row-body="">
          {children}
          {actions ? <span className="flex flex-wrap items-center gap-2">{actions}</span> : null}
        </div>
      ) : null}
    </li>
  );
}
