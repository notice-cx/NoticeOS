import { type ReactNode } from "react";
import {
  lifecycleMoveSentence,
  parseLifecycleMoveRef,
} from "@shared/asset-detail";
import { watchDayOf, watchScopeText, watchSeriesLabel } from "@shared/watch-windows";
import type { WatchWindowItem } from "@shared/asset-detail";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { SurfaceSpan } from "@shared/surface";
import type { AnnotationItem } from "@shared/annotations";
import { ageMs, formatAge } from "@shared/freshness";
import type { SurfaceAnnotation } from "@shared/surface";
import { AgeBadge } from "@/components/AgeBadge";
import { SectionLabel, eyebrowClass } from "@/components/surface/SectionLabel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// --- the small pieces every tab draws with --------------------------------
// Three shapes several tabs share and none of them owns: the card every
// section sits in, the heading inside one, and the age line a section puts
// beside its own freshest fact.

// --- what a chart marks on its own axis ------------------------------------

/** How much of a sentence a mark on an axis may spend. Past this the label is
 * competing with the chart it is annotating. */
const MARK_LABEL_MAX = 48;

/** The first clause of a note — what it says, without the paragraph after it. */
export function firstClause(text: string, max = MARK_LABEL_MAX): string {
  const clause = (text.split(/[.;—]/)[0] ?? "").trim() || text.trim();
  return clause.length > max ? `${clause.slice(0, max - 1).trimEnd()}…` : clause;
}

/**
 * The recorded changes worth a mark on a chart: what somebody deployed or
 * changed here. The other kinds stay on Activity, because a chart marked at
 * every external event is a chart of marks. The label says what changed, in
 * one clause: the marker's accessible label takes the first clause of the
 * note and its disclosure retains the whole. The kind is never the label. A
 * lifecycle move carries no note: it is a `config` row whose ref encodes the
 * move, and the sentence renders while the ref never does.
 */
export function timelineAnnotations(
  items: readonly AnnotationItem[],
): SurfaceAnnotation[] {
  return items
    .filter((item) => item.kind === "deploy" || item.kind === "config")
    .map((item) => {
      const move = parseLifecycleMoveRef(item.ref);
      const said = move ? lifecycleMoveSentence(move) : item.note;
      return {
        date: item.at.slice(0, 10),
        ...(said ? { detail: said } : {}),
        label: said
          ? firstClause(said)
          : item.kind === "deploy"
            ? "Deploy"
            : "Config change",
      };
    });
}

/**
 * The windows being watched, as spans on the story chart: from the day the
 * watch was registered to its next verdict day. A window with no check left
 * draws to today. Nothing is invented: registration and check dates are the
 * store's.
 */
export function watchSpans(open: readonly WatchWindowItem[], nowMs: number): SurfaceSpan[] {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return open.map((watch) => {
    const start = watchDayOf(watch.registeredAt);
    const end = watch.nextCheckDate ?? today;
    const series = watchSeriesLabel(watch.metricIntegration, watch.metric);
    const scope = watch.scope ? ` ${watchScopeText(watch.scope)}` : "";
    const verdict = watch.nextCheckDate ? ` · verdict ${formatSeriesDate(watch.nextCheckDate)}` : "";
    return { start, end: end < start ? start : end, label: `Watching ${series}${scope}${verdict}` };
  });
}

// --- shared layout helpers -------------------------------------------------
export function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  /** A ReactNode, not a string: the Performance section's caption carries the
   * one ⚠ that says its comparisons straddle a reporting-timezone change. */
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {subtitle ? (
            <span className="text-xs normal-case tracking-normal text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
        {right ? <div className="w-full min-w-0 sm:w-auto sm:shrink-0">{right}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export interface PanelProps {
  /** The eyebrow. One or two words — "Identity", "Data sources", "P&L". */
  title: string;
  /** The quiet count or age beside it. Never a sentence. */
  count?: ReactNode;
  /** The header's right-hand slot: a link out, an owner chip, a composer
   * button. A `ListPanel` takes exactly one link; this takes whatever the
   * section's header genuinely holds, because Sources puts an owner chip AND a
   * link there and Settings puts an owner chip on every card. */
  action?: ReactNode;
  /** The anchor a deep link lands on — `#setup`, `#timeline`, `#integrations`. */
  id?: string;
  children: ReactNode;
  className?: string;
}

/**
 * The block that is this surface's answer. `surface:audit` measures this
 * element's bottom edge against 900px, and a surface that declares no hero
 * fails the first-screen rule by definition. Exactly one per tab, always the
 * first block. A wrapper rather than a prop on each panel: a plain block
 * div's box is exactly its child's box, and one mechanism means one grep
 * finds every declared hero.
 */
export function Hero({ children, id }: { children: ReactNode; id?: string }) {
  // It doubles as the deep-link anchor where the hero IS the linked section —
  // `#timeline` on Activity — because a wrapper that already exists is a better
  // anchor than a second empty div beside it.
  return (
    <div id={id} data-surface-hero="" className={id ? "scroll-mt-4" : undefined}>
      {children}
    </div>
  );
}

/**
 * The card for a section that is not a list of rows: `ListPanel`'s own header,
 * spacing and shell with the row list swapped for whatever the section holds,
 * so the two side by side differ only in content.
 */
export function Panel({ title, count, action, id, children, className }: PanelProps) {
  return (
    <section
      id={id}
      className={cn(
        "flex scroll-mt-4 flex-col rounded-[10px] border border-border bg-card",
        className,
      )}
      aria-label={title}
    >
      {/* The vocabulary's eyebrow. The trailing slot is a node here rather
          than a link: what sits at the end of a Settings or Sources panel's
          header is its owner chip. */}
      <SectionLabel title={title} caption={count} className="px-4 pb-2 pt-3">
        {action}
      </SectionLabel>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

/** The eyebrow on its own, for a heading INSIDE a `Panel` — a strip's label, a
 * sub-table's name. Same type as the panel's own title, so a card with two
 * levels still has one heading style. */
export function Eyebrow({ children }: { children: ReactNode }) {
  // A label, not a heading: a span, because a second `h2` inside a card would
  // claim a level in the outline that this is not.
  return <span className={eyebrowClass}>{children}</span>;
}

export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A section header's age. With a cadence to be stale against it is
 * `AgeBadge`; without one there is nothing to turn amber, so it renders the
 * plain age. Absence is a word, not a dash: this slot sits beside a title, so
 * an em-dash reads as a rendering failure. The two absences are told apart:
 * "never" claims nothing has ever arrived, and a timestamp we were handed but
 * cannot parse is a different thing.
 */
export function LaneAge({
  iso,
  nowMs,
  cadenceHours,
}: {
  iso: string | null;
  nowMs: number;
  cadenceHours?: number;
}) {
  if (cadenceHours != null) {
    return <AgeBadge iso={iso} cadenceHours={cadenceHours} nowMs={nowMs} />;
  }
  const ms = ageMs(nowMs, iso);
  if (ms === null) {
    const unreadable = iso !== null;
    return (
      <span
        className="text-xs text-muted-foreground"
        data-lane-age={unreadable ? "unreadable" : "never"}
        title={
          unreadable
            ? "The stored timestamp for this section could not be read"
            : "Never — nothing has been recorded here yet"
        }
      >
        {unreadable ? "unknown" : "never"}
      </span>
    );
  }
  return (
    <span className="text-xs tabular-nums text-muted-foreground" data-lane-age="aged">
      {formatAge(ms)} ago
    </span>
  );
}

/** Days from now to a calendar date, never below zero (the Overview's and
 * Activity's "verdict in N days"). */
export function daysUntil(date: string, nowMs: number): number {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  return Math.max(0, Math.ceil((target - nowMs) / 86_400_000));
}

/** "verdict in 3 days", "verdict today", or how many are being watched. */
export function betsFact(watches: Pick<AssetDetailFor<"overview">["watches"], "open">, nowMs: number): string {
  const next = watches.open
    .map((watch) => watch.nextCheckDate)
    .filter((date): date is string => date !== null)
    .sort()[0];
  if (next) {
    const days = daysUntil(next, nowMs);
    return days === 0 ? "verdict today" : `verdict in ${days} ${days === 1 ? "day" : "days"}`;
  }
  const open = watches.open.length;
  return open === 0 ? "nothing being watched" : `${open} being watched`;
}

