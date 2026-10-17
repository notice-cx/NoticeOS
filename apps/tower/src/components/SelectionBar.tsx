import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A list's Select: whether it is on, and which rows are picked. */
export interface Selection {
  selecting: boolean;
  /** Select starts it; Done leaves and drops every pick. */
  toggle: () => void;
  leave: () => void;
  picked: ReadonlySet<string>;
  pick: (ids: ReadonlySet<string>) => void;
  flip: (id: string) => void;
}

/**
 * The picks of one list. A list reads them against the rows it can still
 * act on (`picked.has(row.id)` over its selectable rows), so a row that left
 * the list since it was picked leaves the selection with it.
 */
export function useSelection(): Selection {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const leave = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  return {
    selecting,
    toggle: () => (selecting ? leave() : setSelecting(true)),
    leave,
    picked,
    pick: setPicked,
    flip: (id) => setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    }),
  };
}

/** Select beside a list's heading, and Done while selecting. */
export function SelectToggle({ selection, marks, className }: {
  selection: Selection;
  marks?: Record<string, string>;
  className?: string;
}) {
  return (
    <Button type="button" size="sm" variant="ghost" className={cn("ms-auto text-muted-foreground", className)}
      aria-pressed={selection.selecting} onClick={selection.toggle} {...marks}>
      {selection.selecting ? "Done" : "Select"}
    </Button>
  );
}

/** One row's checkbox. The whole square is the target, not the 16 px box. */
export function SelectBox({ checked, onToggle, label, marks, className }: {
  checked: boolean;
  onToggle: () => void;
  /** What the box selects, as a screen reader names it: the row's title. */
  label: string;
  marks?: Record<string, string>;
  className?: string;
}) {
  return (
    <label className={cn("grid size-11 shrink-0 cursor-pointer place-items-center", className)} {...marks}>
      <input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={onToggle} aria-label={`Select ${label}`} />
    </label>
  );
}

/**
 * The bar a list's Select draws over its rows: how many are picked, Select
 * all or Clear, the verbs for the picked rows at the end (each names how many
 * rows it sends), and the line a verb opens under them.
 */
export function SelectionBar({
  chosen,
  selectable,
  detail,
  onAll,
  onNone,
  actions,
  children,
  label,
  subject,
  marks,
  className,
}: {
  /** How many rows are picked. */
  chosen: number;
  /** How many rows can be picked; Select all names it. */
  selectable: number;
  /** What the count adds about the picked rows, such as "2 need a choice". */
  detail?: ReactNode;
  onAll: () => void;
  onNone: () => void;
  actions: ReactNode;
  /** The line a verb opens, under the bar's row. */
  children?: ReactNode;
  /** The group's name, such as "Selected tasks". */
  label: string;
  /** The status line's subject, such as `selection:tasks`. */
  subject: string;
  marks?: Record<string, string>;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-2 border-t border-border/60 px-5 py-2.5", className)} {...marks}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tabular-nums text-muted-foreground" role="status" data-status-for={subject}>
          {formatInt(chosen)} selected
          {detail ? <span data-selection-detail=""> · {detail}</span> : null}
        </span>
        {chosen < selectable ? (
          <Button type="button" size="sm" variant="ghost" onClick={onAll} data-select-all="">
            Select all {formatInt(selectable)}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={onNone} data-select-none="">
            Clear
          </Button>
        )}
        <span className="ms-auto flex flex-wrap items-center gap-2">{actions}</span>
      </div>
      {children}
    </div>
  );
}
