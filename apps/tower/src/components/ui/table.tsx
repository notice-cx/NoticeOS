import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * IN A NARROW BOX, A WIDE TABLE IS NOT A TABLE (beads `ro-md80`, `ro-ujb9.169`).
 *
 * Every desk table already scrolls inside its own box, so no page has ever
 * scrolled sideways. That is not the same as being usable: at 390px the alerts
 * queue put Resolve past the right edge and Home's nine-column asset row showed
 * two and a half of them, so the phone's answer to "what is wrong and can I
 * clear it" was "drag the table". Nothing is hidden — the row REFLOWS into a
 * card whose cells each carry their own column label, which is the one thing a
 * stacked cell loses.
 *
 * ONE MECHANISM, DECLARED ONCE. The whole behavior is arbitrary-variant CSS on
 * the `<table>` element, so a caller opts in with `stacked` and labels its cells
 * (`<TableCell label="Status">`); `TableHeader`, `TableRow` and `TableCell` need
 * to know nothing about it and no surface grows a second row component. The
 * header row hides below `sm` because every label it holds is now on the cell
 * itself — hiding it twice over would be the duplicate, not the omission.
 *
 * A cell with no `label` still stacks (it is a full-width line of the card), and
 * a cell with no content at all is dropped rather than drawn as an empty
 * labelled line. A cell that holds only CHROME says `dropWhenStacked` and is
 * gone; a plain `max-sm:hidden` on the cell would lose to the `[&_td]` rules
 * here, which is a specificity trap worth spending one declared attribute to
 * close. A row that OPENS says so with `TableRow opens`, and the stacked card
 * draws the › itself (bead `ro-ujb9.13`) — a chevron cell of the row's own
 * spoke to a mouse and was dropped for the thumb that needed it.
 *
 * NARROW IS THE TABLE'S BOX, NOT THE SCREEN (bead `ro-ujb9.169`). The reflow
 * is keyed to the width of the box the table sits in — a container query at
 * `sm`'s 40rem — not to the viewport. On a phone every box is narrower than
 * that, so nothing there changes; on a 768-wide tablet a table inside a
 * ~450px card (a site's Panel refresh on Settings) now reflows too, instead of
 * hiding its right-hand columns behind a sideways scroll a touch browser does
 * not draw. A table whose box is 40rem or wider keeps its columns, and scrolls
 * inside that box as it always did.
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
  // A FOLDED row shows its summary line and nothing else (bead `ro-c59x`). The
  // reflow above trades width for height, and a register with many rows spends
  // it all: /financials ran 28,244px at 390×844 because 22 rows × 6 fields is
  // 132 labelled lines. A row that folds is one line until it is asked for.
  "@max-[40rem]:[&_tr[data-stack-fold]_td[data-fold]]:hidden " +
  // Its counterpart: a cell that exists only for the stacked card, because the
  // desk's own header row is the summary a narrow box lost.
  "@min-[40rem]:[&_td[data-stack-only]]:hidden " +
  // A ROW THAT OPENS SAYS SO ON A PHONE (bead `ro-ujb9.13`). On a desk the
  // pointer, the hover ground and the linked name say it; a thumb has none of
  // those, so the stacked card draws the disclosure chevron › at its top end —
  // the same mark `ListRow` ends an opening row with — drawn, like the labels
  // above, by the table's own rules so no cell has to carry it.
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
  /** In a box narrower than 40rem, reflow each row into a labelled card. See
   * the notes above. */
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
  /** A press on the row opens its subject (its `onClick` navigates). The row
   * carries the pointer, and its stacked card draws the › a thumb reads it by
   * (bead `ro-ujb9.13`). Keep a real link inside for the keyboard. */
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
  /** Chrome the stacked card has no room for and no use for. See the note above. */
  dropWhenStacked?: boolean;
  /** This cell folds away while its row is `foldedWhenStacked` (bead `ro-c59x`). */
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
