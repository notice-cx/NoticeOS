import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A `stacked` table reflows each row into a card whose cells carry their own
 * column label (`<TableCell label="Status">`) when its box, not the viewport,
 * is narrower than 40rem (a container query). The behaviour is CSS on the
 * `<table>`, so rows and cells need no second component. Empty cells drop;
 * chrome cells say `dropWhenStacked`, because a plain `max-sm:hidden` loses to
 * the `[&_td]` rules here. Opening rows say `opens` and the card draws the ›.
 */
const STACKED =
  "@max-[40rem]:block " +
  "@max-[40rem]:[&_thead]:hidden " +
  "@max-[40rem]:[&_tbody]:block " +
  "@max-[40rem]:[&_tr]:mb-2 @max-[40rem]:[&_tr]:block @max-[40rem]:[&_tr]:rounded-md @max-[40rem]:[&_tr]:border @max-[40rem]:[&_tr]:border-border " +
  "@max-[40rem]:[&_tbody:last-child_tr:last-child]:mb-0 " +
  "@max-[40rem]:[&_td]:flex @max-[40rem]:[&_td]:flex-wrap @max-[40rem]:[&_td]:items-baseline @max-[40rem]:[&_td]:justify-between " +
  "@max-[40rem]:[&_td]:gap-x-3 @max-[40rem]:[&_td]:gap-y-1 @max-[40rem]:[&_td]:border-0 @max-[40rem]:[&_td]:px-3 @max-[40rem]:[&_td]:py-1.5 @max-[40rem]:[&_td]:text-left " +
  "@max-[40rem]:[&_td:empty]:hidden " +
  "@max-[40rem]:[&_td[data-stack-drop]]:hidden " +
  // A folded row shows its summary line and nothing else until it is opened.
  "@max-[40rem]:[&_tr[data-stack-fold]_td[data-fold]]:hidden " +
  // A cell that exists only for the stacked card.
  "@min-[40rem]:[&_td[data-stack-only]]:hidden " +
  // A row that opens draws the › chevron, the mark `ListRow` uses, at its top end.
  "@max-[40rem]:[&_tr[data-row-opens]]:relative " +
  "@max-[40rem]:[&_tr[data-row-opens]]:after:pointer-events-none @max-[40rem]:[&_tr[data-row-opens]]:after:absolute " +
  "@max-[40rem]:[&_tr[data-row-opens]]:after:end-4 @max-[40rem]:[&_tr[data-row-opens]]:after:top-6 " +
  "@max-[40rem]:[&_tr[data-row-opens]]:after:size-2 @max-[40rem]:[&_tr[data-row-opens]]:after:rotate-45 " +
  "@max-[40rem]:[&_tr[data-row-opens]]:after:border-e-[1.5px] @max-[40rem]:[&_tr[data-row-opens]]:after:border-t-[1.5px] " +
  "@max-[40rem]:[&_tr[data-row-opens]]:after:border-muted-foreground @max-[40rem]:[&_tr[data-row-opens]]:after:content-[''] " +
  "@max-[40rem]:[&_td[data-label]]:before:shrink-0 " +
  "@max-[40rem]:[&_td[data-label]]:before:font-semibold " +
  "@max-[40rem]:[&_td[data-label]]:before:uppercase @max-[40rem]:[&_td[data-label]]:before:tracking-wider " +
  "@max-[40rem]:[&_td[data-label]]:before:text-muted-foreground " +
  "@max-[40rem]:[&_td[data-label]]:before:content-[attr(data-label)]";

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** In a box narrower than 40rem, reflow each row into a labelled card. */
  stacked?: boolean;
}

export function Table({ className, stacked = false, ...props }: TableProps) {
  const table = (
    <table
      data-stacked={stacked ? "" : undefined}
      className={cn("w-full caption-bottom text-sm", stacked && STACKED, className)}
      {...props}
    />
  );
  // A stacked table's box is the container its rules measure; it scrolls only
  // while it still has columns (a query cannot style the box it measures, so
  // the scroller is the box's child).
  return stacked ? (
    <div className="@container relative w-full" data-table-box>
      <div className="@min-[40rem]:overflow-x-auto">{table}</div>
    </div>
  ) : (
    <div className="relative w-full overflow-x-auto">{table}</div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** In a table box narrower than 40rem, draw only `onlyWhenStacked` cells — each
   * marked `foldWhenStacked` is folded away until the row is opened. The desk is
   * unchanged in a wide box: the rule uses `@max-[40rem]`, not viewport width. */
  foldedWhenStacked?: boolean;
  /** A press on the row opens its subject (its `onClick` navigates); the stacked
   * card draws the ›. Keep a real link inside for the keyboard. */
  opens?: boolean;
}

export function TableRow({ className, foldedWhenStacked, opens, ...props }: TableRowProps) {
  return (
    <tr
      data-stack-fold={foldedWhenStacked ? "" : undefined}
      data-row-opens={opens ? "" : undefined}
      className={cn("border-b border-border transition-colors hover:bg-muted/40", opens && "cursor-pointer", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "h-9 px-3 text-left align-middle font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** The column this cell is in, painted in front of the value once the row has
   * stacked. Give it the same words the `TableHead` above uses. */
  label?: string;
  /** Chrome the stacked card has no room for; see the trap noted above. */
  dropWhenStacked?: boolean;
  /** This cell folds away while its row is `foldedWhenStacked`. */
  foldWhenStacked?: boolean;
  /** This cell exists ONLY for the stacked card — the summary line a folded row
   * shows in place of its fields. Hidden from `sm` up, where the header row and
   * the columns say the same thing. */
  onlyWhenStacked?: boolean;
}

export function TableCell({
  className,
  label,
  dropWhenStacked,
  foldWhenStacked,
  onlyWhenStacked,
  ...props
}: TableCellProps) {
  return (
    <td
      data-label={label}
      data-stack-drop={dropWhenStacked ? "" : undefined}
      data-fold={foldWhenStacked ? "" : undefined}
      data-stack-only={onlyWhenStacked ? "" : undefined}
      className={cn("px-3 py-2 align-middle", className)}
      {...props}
    />
  );
}
