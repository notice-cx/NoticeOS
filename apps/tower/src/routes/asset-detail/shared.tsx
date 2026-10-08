import { type ReactNode } from "react";
import {
  lifecycleMoveSentence,
  parseLifecycleMoveRef,
} from "@shared/asset-detail";
import { watchDayOf, watchScopeText, watchSeriesLabel } from "@shared/watch-windows";
import type { WatchWindowItem } from "@shared/asset-detail";
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
// Lifted out of AssetDetailRoute.tsx unchanged when the page became one file per
// tab (bead `ro-78qo.2`). Three shapes several tabs share and none of them owns:
// the card every section sits in, the heading inside one, and the age line a
// section puts beside its own freshest fact.

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
 * THE RECORDED CHANGES WORTH A MARK ON A CHART, on any tab that draws one
 * (`ro-78qo.3`, shared by `ro-78qo.4`).
 *
 * What somebody deployed or changed here. The other kinds stay on Activity — a
 * chart marked at every external event is a chart of marks.
 *
 * THE LABEL SAYS WHAT CHANGED, IN ONE CLAUSE. "Sep 1 · Change" costs a line and
 * answers nothing; "Sep 1 · GA4 reporting timezone changed" is the reason the
 * operator is looking at the dip beside it. The note is free prose and routinely
 * runs to two sentences, so the marker's accessible label takes the FIRST
 * CLAUSE and its on-demand disclosure retains the full original note. The
 * KIND is never the label: "config" names the
 * row's type rather than what happened, which is the one thing a mark is for.
 *
 * A lifecycle move carries no note at all: it is a `config` row whose ref
 * encodes the move, and doc 17 says the sentence renders and the ref never does.
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
 * THE WINDOWS BEING WATCHED, as spans on the story chart (D44): from the day
 * the watch was registered to its next verdict day, labelled with what is
 * measured and when the verdict lands. A window with no check left draws to
 * today. Nothing is invented: registration and check dates are the store's.
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
 * THE BLOCK THAT IS THIS SURFACE'S ANSWER (doc 21; `scripts/README.md`'s table
 * of the marks the audit reads).
 *
 * `surface:audit` measures this element's bottom edge against 900px, and a
 * surface that declares no hero fails the first-screen rule by definition — "the
 * audit will not certify a first screen nobody named". Exactly one per tab, and
 * it is always the FIRST block, because a tab whose answer is halfway down is a
 * tab that has not decided what it is for.
 *
 * A wrapper rather than a prop on each panel: `ListPanel` is the vocabulary's
 * component and is not this bead's to change, and a plain block div's box is
 * exactly its child's box, so the measurement is identical. One mechanism means
 * one grep finds every declared hero on the page.
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
 * DOC 21'S CARD, for a section that is not a list of rows.
 *
 * `ListPanel` is the vocabulary's answer for "things that need something", and
 * five of these tabs also hold sections that are a form, a table or a strip.
 * Drawn with `SectionCard` those sat beside a `ListPanel` in a different radius,
 * a different heading weight and a drop shadow — the "one card style" rule
 * broken on the very screens doc 21 was written for. So this is deliberately
 * `ListPanel`'s own header, spacing and shell with the row list swapped for
 * whatever the section holds: put the two side by side and the only difference
 * is the content.
 *
 * It is not a second `SectionCard`. `SectionCard` keeps its `subtitle` — a
 * paragraph under every heading — which is the exact thing doc 21 moves behind
 * `About`, and it stays only until the Overview and Growth rebuilds retire their
 * last callers.
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
      {/* The vocabulary's eyebrow, not a third copy of it (bead `ro-78qo.39`).
          The trailing slot is a NODE here rather than a link: what sits at the
          end of a Settings or Sources panel's header is its owner chip. */}
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
  // A LABEL, not a heading: it names a strip or a sub-table INSIDE a panel that
  // already has one. The type is the vocabulary's own (bead `ro-78qo.39`); the
  // element is a span, because a second `h2` inside a card would claim a level
  // in the outline that this is not.
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
 * A section header's age. With a cadence to be stale against it IS `AgeBadge`;
 * without one there is nothing to turn amber, so it renders the plain age.
 *
 * ABSENCE IS A WORD, NOT A DASH (bead `ro-kukv.12`, doc 17 rule 6). This slot
 * sits in a section header beside its own title — a labelled value slot, not a
 * dense table cell — so the em-dash it used to print read as a rendering
 * failure rather than as "nothing has been recorded here". `formatAge` keeps
 * its dash, because fifteen call sites interpolate it as "{age} ago" and a word
 * there would read "never ago"; the word belongs where the fact is known, which
 * is the component that was handed no timestamp at all. This is the fix
 * `AgeBadge` got in 42bed39, on the two headers that do not compose it.
 *
 * The two absences are told apart for the reason rule 6 names: **never** claims
 * nothing has ever arrived, and a timestamp we were handed but cannot parse is
 * a different and untrue thing to tell an operator.
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
