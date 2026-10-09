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

/**
 * One subject and the rows about it (bead `ro-ujb9.96.6.5`). A list whose rows
 * repeat their subject — "/calculator · Chrome OS", "/calculator · age input",
 * "/calculator · TypeError…" — says it once, as the group's heading, and each
 * row keeps only what differs. Rows arrive most important first.
 */
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
  /** The header's one link out, doc 14's "All →". */
  action?: ListPanelAction;
  /** Rows shown before the expander. doc 14's default is three: a panel is an
   * answer to "what needs me", and the fourth row is already the long tail. */
  limit?: number;
  /** What the panel says when it has nothing — a glyph and a short line, never
   * a paragraph (doc 14). */
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
 * THE DESK'S ONE LIST OF THINGS THAT NEED SOMETHING (doc 14).
 *
 * *Registry justification:* the same list existed three times — the asset
 * page's `AttentionBand`, `ExecutiveFindingsList`'s default rendering, and
 * Home's operator inbox card — each with its own header, its own row shape and
 * its own idea of how many rows is too many. This is one: eyebrow, quiet count,
 * one link out, three rows, and an expander for the rest.
 *
 * The extra rows are DISCLOSED rather than dropped. A panel that silently keeps
 * four of seven items is lying about the size of the queue, and the count in the
 * header is what makes the difference visible before the expander is pressed.
 *
 * ITS HEADER IS A `SectionLabel` (bead `ro-78qo.33`). The eyebrow, the quiet
 * count and the one link out were drawn here as well as there, which is a
 * near-duplicate of exactly the kind the registry exists to catch — so the panel
 * supplies its card's padding and keeps its own props, and the header itself
 * comes from the vocabulary.
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
      {/* THE ONE EYEBROW (bead `ro-78qo.33`). This header drew the same three
          parts as `SectionLabel` — tracked uppercase title, quiet count, one
          link out — in a second file. It composes it instead: the card's own
          padding arrives as a class, the count as the caption and "All →" as
          the action, and this panel's props did not change. */}
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

/** The four states a row's mark can carry. `ok` is the one that is not a doc 02
 * severity: a finished thing in a list of unfinished ones, drawn in the health
 * green that already means "evidenced all-clear". */
export type ListRowTone = Severity | "ok";

const TONE_CLASS: Record<ListRowTone, string> = {
  ...severityTextClass,
  // doc 14 settles the row's four tones as error, warn, ok and MUTED. `info`
  // keeps doc 02's name in the type — it is a severity — and wears the muted
  // ink, because a discovery in a list of things that need doing is the one
  // row that is not asking for anything.
  info: "text-muted-foreground",
  ok: "text-healthy",
};

/** doc 14's mark set. The glyph carries the meaning and the ring carries the
 * tone, so neither is colour-only (doc 14). A caller overrides the glyph where
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
   * ring carries the colour, the mark carries the meaning, so neither is
   * colour-only (doc 14). */
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
  /** Buttons for the expanded row — where doc 14 moves the per-card actions. */
  actions?: ReactNode;
  /**
   * The row's ONE decision, on the row itself: visible without expanding it,
   * beside the value on a desk and on its own line under the title on a phone
   * (bead `ro-ujb9.96.7.11`, Linear Triage's accept/decline on the row). The
   * evidence and the rarer verbs stay in the expansion.
   */
  rowActions?: ReactNode;
  /**
   * The row's action is ONE short press that fits beside the title on a phone
   * too — a data source's Connect (bead `ro-ujb9.96.7.5`, mockup e2-phone) —
   * so it stays on the row's line instead of taking a line of its own.
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
   * `data-*` marks that belong to the ROW, spread onto its `<li>` (bead
   * `ro-78qo.40`).
   *
   * `AlertRow` carries four — `data-flag-kind`, `data-flag-severity`,
   * `data-visual-state` and `data-material-condition` — and they are the
   * contract the materiality suite and the desk's own audit read. When that row
   * was folded into this one (`ro-78qo.17`) they had nowhere to go but the
   * title span, so a mark describing the whole row sat on a child of it and
   * claimed a smaller subtree than it meant.
   *
   * DATA ATTRIBUTES ONLY, and the type says so: this is a hook for marks a
   * measurement reads, not a way to reach past the component and set `onClick`
   * or `role` on a row whose behaviour it owns. `Sparkline` already forwards
   * `data-spark` for exactly this reason, which makes it the precedent rather
   * than a new idea.
   */
  marks?: Record<`data-${string}`, string>;
}

/**
 * One row: a mark, what it is, and what it is worth. It expands IN PLACE, so
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
      {/* WHAT A PRESS DOES, SAID BY THE ROW'S LAST MARK (bead `ro-ujb9.13`).
          Three grammars and no fourth: › opens a page (the disclosure
          indicator Apple's HIG gives a row that drills in — an ↗ reads as
          "leaves the product"), ⌄ opens the row in place, and a row with
          neither does nothing and has no hover either. On a phone there is no
          hover to find out by, so the mark is the only way to know. */}
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
      {/* THE DECISION ON THE ROW (bead `ro-ujb9.96.7.11`). A sibling of the
          row's own button, never inside it — a button in a button is not a
          control a keyboard or a screen reader can reach. On a phone it takes
          its own line, indented under the title. */}
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
      {/* ONE COLUMN THAT CANNOT GROW PAST THE ROW (bead `ro-ujb9.79`). An
          implicit grid column is sized to its widest child's min-content, so
          one unbreakable string inside the evidence (a doc reference, a URL)
          widened the whole body and every paragraph with it: at 390px the
          Sources tab ran up to 285px off the right edge. `minmax(0,1fr)` holds
          the body to the row's width, and on a phone `wrap-anywhere` lets a URL,
          path or id with no spaces break rather than push past it. Phone only,
          so a desk-width row lays out exactly as it did. */}
      {open ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-b-md bg-muted/40 px-2 pb-2.5 ps-9 text-xs leading-relaxed text-muted-foreground max-sm:wrap-anywhere" data-list-row-body>
          {children}
          {actions ? <span className="flex flex-wrap gap-2">{actions}</span> : null}
        </div>
      ) : null}
    </li>
  );
}
