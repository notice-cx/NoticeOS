import { Children, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Severity } from "@shared/wall";
import { severityTextClass } from "@/lib/severity";
import { pillControlClass } from "@/components/ui/pill";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

export interface ListPanelAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

/** One subject and the rows about it: the subject is said once as the
 * heading, and each row keeps only what differs. Rows arrive most important
 * first. */
export interface ListPanelGroup {
  key: string;
  /** The subject every row in the group shares: a page, an asset. */
  title: ReactNode;
  /** The quiet count beside it — "6 found". Never a sentence. */
  count?: ReactNode;
  rows: ReactNode[];
  marks?: Record<`data-${string}`, string>;
}

export interface ListPanelProps {
  /** The eyebrow. One or two words: "Needs you", "What matters". */
  title: string;
  /** The quiet count beside it — "10 urgent · 67 open". Never a sentence. */
  count?: ReactNode;
  /** The header's one link out. */
  action?: ListPanelAction;
  /** Rows shown before the expander. */
  limit?: number;
  /** What the panel says when it has nothing: a glyph and a short line. */
  empty?: ReactNode;
  children?: ReactNode;
  /** Rows grouped under their shared subject, in place of `children`. Closed,
   * the panel shows the first row of each of the first `limit` groups — the
   * worst thing about each of the worst subjects — and its expander opens
   * every row of every group, in place. Groups arrive worst first. */
  groups?: ListPanelGroup[];
  className?: string;
}

/**
 * The desk's one list of things that need something: a `SectionLabel` header,
 * three rows, and an expander for the rest. Extra rows are disclosed, never
 * dropped, so the panel never misstates the size of the queue.
 */
export function ListPanel({
  title,
  count,
  action,
  limit = 3,
  empty,
  children,
  groups,
  className,
}: ListPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = groups ? groups.flatMap((group) => group.rows) : Children.toArray(children);
  // What the closed panel shows: `limit` rows, or — grouped — the first row of
  // each of the first `limit` groups. The expander names everything else.
  const collapsedCount = groups
    ? groups.slice(0, limit).reduce((total, group) => total + Math.min(1, group.rows.length), 0)
    : Math.min(rows.length, limit);
  const hiddenCount = rows.length - collapsedCount;
  const visible = showAll ? rows : rows.slice(0, limit);
  const shownGroups = groups
    ? showAll
      ? groups
      : groups.slice(0, limit).map((group) => ({ ...group, rows: group.rows.slice(0, 1) }))
    : null;

  return (
    <section
      className={cn("flex flex-col rounded-[10px] border border-border bg-card", className)}
      aria-label={title}
    >
      <SectionLabel
        title={title}
        caption={count}
        action={action ? { ...action, label: `${action.label} →` } : undefined}
        className="px-4 pb-2 pt-3"
      />

      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground">
          {empty ?? "Nothing needs you here."}
        </div>
      ) : shownGroups ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-2 pt-0">
          {shownGroups.map((group) => (
            <li key={group.key} className="m-0" data-list-group {...group.marks}>
              <h3 className="m-0 flex min-w-0 items-baseline gap-2 px-2 pb-0.5 pt-1">
                <span className="min-w-0 truncate text-xs font-semibold text-foreground">{group.title}</span>
                {/* Read aloud as "/calculator 6 found"; a flex gap is not a space. */}
                {group.count ? " " : null}
                {group.count ? (
                  <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">{group.count}</span>
                ) : null}
              </h3>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{group.rows}</ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-2 pt-0">{visible}</ul>
      )}

      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
          className={cn(
            "border-t border-border/60 px-4 py-2 text-start text-xs text-muted-foreground hover:text-foreground",
            pillControlClass,
            "motion-safe:transition-colors",
          )}
        >
          {showAll ? "Show fewer" : `Show ${hiddenCount} more`}
        </button>
      ) : null}
    </section>
  );
}

/** The four states a row's mark can carry. `ok` is not a flag severity: a
 * finished thing in a list of unfinished ones, drawn in the health green. */
export type ListRowTone = Severity | "ok";

const TONE_CLASS: Record<ListRowTone, string> = {
  ...severityTextClass,
  // `info` keeps the severity's name and wears muted ink: it is the one row
  // not asking for anything.
  info: "text-muted-foreground",
  ok: "text-healthy",
};

/** The mark set. The glyph carries the meaning and the ring carries the
 * tone, so neither is colour-only. A caller overrides the glyph where
 * the row is a finding (`△`) or a recommendation (`↗`) rather than a task. */
const TONE_GLYPH: Record<ListRowTone, string> = {
  error: "!",
  warn: "!",
  info: "◦",
  ok: "✓",
};

export interface ListRowProps {
  tone?: ListRowTone;
  /** Overrides the tone's own mark — "△" for a finding, "↗" for a move. The
   * ring carries the colour, the mark carries the meaning. */
  glyph?: ReactNode;
  title: ReactNode;
  /** One line under the title. Never a second sentence. */
  caption?: ReactNode;
  /** Essential dates/status may wrap instead of being shortened when closed. */
  captionWrap?: boolean;
  /** Right-aligned, and what it is. */
  value?: ReactNode;
  valueLabel?: ReactNode;
  /** The evidence, revealed in place. A row with none does not expand. */
  children?: ReactNode;
  /** Buttons for the expanded row. */
  actions?: ReactNode;
  /**
   * The row's one decision, on the row itself: visible without expanding it,
   * beside the value on a desk and on its own line under the title on a phone.
   * The evidence and the rarer verbs stay in the expansion.
   */
  rowActions?: ReactNode;
  /**
   * The row's action is one short press that fits beside the title on a phone
   * too (a data source's Connect), so it stays on the row's line.
   */
  rowActionsInline?: boolean;
  /** Under the row whether or not it is expanded — the answer box a row
   * action opens in place. */
  below?: ReactNode;
  defaultExpanded?: boolean;
  /** Navigation rows open an exact item instead of expanding an empty preview. */
  to?: string;
  returnTo?: string;
  className?: string;
  /**
   * `data-*` marks that belong to the row, spread onto its `<li>` (the
   * materiality suite and the desk audit read `AlertRow`'s). Data attributes
   * only, so a caller cannot reach past the component to set `onClick` or
   * `role`.
   */
  marks?: Record<`data-${string}`, string>;
}

/**
 * One row: a mark, what it is, and what it is worth. It expands in place, so
 * reading the evidence never moves the rest of the page.
 */
export function ListRow({
  tone = "info",
  glyph,
  title,
  caption,
  captionWrap = false,
  value,
  valueLabel,
  children,
  actions,
  rowActions,
  rowActionsInline = false,
  below,
  defaultExpanded = false,
  to,
  returnTo,
  className,
  marks,
}: ListRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const expandable = !to && Boolean(children ?? actions);
  const open = expandable && expanded;

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "grid size-4.5 shrink-0 place-items-center self-start rounded-full border-[1.5px] border-current text-[11px] font-semibold leading-none",
          TONE_CLASS[tone],
        )}
      >
        {glyph ?? TONE_GLYPH[tone]}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className={cn("text-sm text-foreground break-words", !open && "line-clamp-2 max-sm:line-clamp-none")}>{title}</span>
        {caption ? (
          <span className={cn("text-xs text-muted-foreground max-sm:whitespace-normal max-sm:wrap-anywhere", !open && !captionWrap && "truncate", captionWrap && "whitespace-normal")}>
            {caption}
          </span>
        ) : null}
      </span>
      {value !== undefined && value !== null ? (
        <span className="grid justify-items-end gap-0.5 text-end">
          <span className="text-[13px] font-semibold tabular-nums text-foreground">
            {value}
          </span>
          {valueLabel ? (
            <span className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
              {valueLabel}
            </span>
          ) : null}
        </span>
      ) : null}
      {/* The last mark says what a press does: › opens a page, ⌄ opens the
          row in place, and a row with neither does nothing and has no hover. */}
      {to ? <ChevronRight className="size-4 text-muted-foreground" aria-hidden data-row-affordance="open" /> : expandable ? (
        <ChevronDown className={cn("size-4 text-muted-foreground motion-safe:transition-transform", open && "rotate-180")} aria-hidden data-row-affordance="expand" />
      ) : null}
    </>
  );

  const shell = cn(
    "grid w-full items-center gap-2.5 rounded-md p-2 text-start",
    to || expandable ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]" : "grid-cols-[auto_minmax(0,1fr)_auto]",
    open && !rowActions && "bg-muted/40",
  );

  const main = to ? (
    <Link
      to={to}
      state={returnTo ? { returnTo } : undefined}
      className={cn(shell, pillControlClass, "hover:bg-muted/60 motion-safe:transition-colors")}
    >
      {body}
    </Link>
  ) : expandable ? (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setExpanded((current) => !current)}
      className={cn(
        shell,
        pillControlClass,
        "cursor-pointer hover:bg-muted/40 motion-safe:transition-colors",
      )}
    >
      {body}
    </button>
  ) : (
    <div className={shell}>{body}</div>
  );

  return (
    <li className={cn("m-0", className)} {...marks}>
      {/* A sibling of the row's own button, never inside it: a button in a
          button is unreachable by keyboard and screen reader. */}
      {rowActions ? (
        <div className={cn("flex items-center gap-x-2 rounded-md", !rowActionsInline && "max-sm:flex-wrap", open && "bg-muted/40")}>
          <div className="min-w-0 flex-1">{main}</div>
          <span
            className={cn(
              "flex shrink-0 flex-wrap items-center gap-2 pe-2",
              !rowActionsInline && "max-sm:w-full max-sm:ps-9 max-sm:pb-2",
            )}
            data-list-row-actions
          >
            {rowActions}
          </span>
        </div>
      ) : (
        main
      )}
      {below}
      {/* `minmax(0,1fr)` holds the body to the row's width: an implicit column
          would size to an unbreakable URL's min-content and widen the page. On
          a phone `wrap-anywhere` lets such a string break. */}
      {open ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-b-md bg-muted/40 px-2 pb-2.5 ps-9 text-xs leading-relaxed text-muted-foreground max-sm:wrap-anywhere" data-list-row-body>
          {children}
          {actions ? <span className="flex flex-wrap gap-2">{actions}</span> : null}
        </div>
      ) : null}
    </li>
  );
}
