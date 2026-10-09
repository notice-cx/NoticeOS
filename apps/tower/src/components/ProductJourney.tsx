import { useState } from "react";
import { ArrowRight, CircleHelp, FileCode2, FileX2 } from "lucide-react";
import type {
  ProductCheck,
  ProductFunnel,
  ProductSnapshot,
  ProductVitalLine,
  ProductVitalSegment,
  WebVitalRating,
} from "@shared/asset-detail";
import type { SeriesPointOrGap } from "@shared/surface";
import {
  RATING_WORDS,
  dailyMean,
  dailyTotal,
  exceptionName,
  funnelDropMovement,
  funnelStepLabel,
  productIssueGroups,
  segmentHeadline,
  segmentName,
  segmentRating,
  type ProductConnection,
  type ProductIssue,
  type ProductIssueGroup,
} from "@shared/product";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Meter } from "@/components/Meter";
import { StateChip, type StateTone, type StatusSubject } from "@/components/StateChip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { SmallMultiple, SmallMultipleStrip } from "@/components/surface/SmallMultiple";
import { pillControlClass } from "@/components/ui/pill";
import { formatCalendarDate, formatCalendarRange, formatCompact, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ProductJourneyProps {
  /** The executive snapshot's product block; null when nothing was collected. */
  product: ProductSnapshot | null;
  /** What an empty section says: waiting for a first read, or not connected. */
  connection: ProductConnection;
  className?: string;
}

/** Funnels drawn open before the expander. */
const FUNNELS_SHOWN = 1;

function percent(value: number, digits = 1): string {
  const scaled = value * 100;
  return `${scaled >= 10 || digits === 0 ? Math.round(scaled) : scaled.toFixed(digits)}%`;
}

/**
 * THE PRODUCT SECTION — what people do once they arrive, and where it breaks
 * (beads `ro-ghis.2`, `ro-ghis.3`; doc 14).
 *
 * *Registry justification:* nothing drew PostHog's product families. The
 * Growth tab's `ProductUse` strip is GA4 event totals with no series, no funnel
 * and no breakage; `ExecutiveFindingsList` renders findings, not the funnel
 * shape or the speed ratings a finding is picked from. This section composes
 * the vocabulary — a `SmallMultipleStrip` of daily use with sparklines, the
 * funnel as `Meter` bars, a three-row `ListPanel` of where it breaks with the
 * ratings as `StateChip`s — and adds no new primitive. PostHog's caveats (bots,
 * consent, blocked browsers) are documented in docs/20-signal-panels.md, not
 * restated on the screen (bead `ro-ujb9.96.6.5`).
 *
 * ONE QUESTION, TWO HALVES, READ LEFT TO RIGHT: the strip says how many people
 * use the site and how many make it through the main journey; the funnel says
 * where they stop; the list says what is broken where they stop. Each part
 * prints its own window, because the families measure different spans (28, 14
 * and 7 days) and a single caption would claim one period for all of them.
 *
 * NOTHING IS A ZERO. A part PostHog did not collect is a dash with its reason; a
 * rule with too little data says so in the checks line, rather than the list
 * reading as a clean bill of health.
 */
export function ProductJourney({ product, connection, className }: ProductJourneyProps) {
  const daily = product?.webDaily ?? null;
  return (
    <section id="product" data-product-journey className={cn("scroll-mt-4 flex flex-col gap-2", className)}>
      {/* The caption carries the DAILY window, once: it is what the strip
          directly under it measures. The funnel and the list state their own,
          shorter windows where they are drawn (doc 14, time belongs to the fact
          it qualifies). */}
      {/* NO EXPLAINER (bead `ro-ujb9.96.6.5`): the section's title, source and
          dates are its whole description. The read date is stated only where
          it differs from the daily window's last day: the same date twice is
          one too many (doc 14). */}
      <SectionLabel
        title="Product"
        caption={[
          "PostHog",
          daily ? `daily ${formatCalendarRange(daily.windowStart, daily.windowEnd)}` : null,
          product && product.observedAt !== daily?.windowEnd ? `read ${formatCalendarDate(product.observedAt)}` : null,
        ].filter(Boolean).join(" · ")}
      />
      {product ? <ProductBody product={product} /> : <ProductEmpty connection={connection} />}
    </section>
  );
}

function ProductEmpty({ connection }: { connection: ProductConnection }) {
  const line =
    connection === "connected"
      ? "Connected · the first product read has not been collected yet."
      : connection === "off"
        ? "Product data is not collected for this site."
        : "Product data is not connected for this site.";
  return (
    <p className="m-0 flex items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-3 text-xs text-muted-foreground" data-product-empty={connection}>
      <span aria-hidden className="font-semibold">—</span>
      {line}
    </p>
  );
}

/** The span the breakage reads cover — speed, rage clicks and errors are all
 * 14-day reads on the daily run, but a manual read can differ, so the list
 * states the widest span it draws from rather than assuming one. */
function breakageWindow(product: ProductSnapshot): string | null {
  const parts = [product.vitals, product.rageClicks, product.exceptions].filter(
    (part): part is NonNullable<typeof part> => part !== null,
  );
  if (parts.length === 0) return null;
  const start = parts.map((part) => part.windowStart).sort()[0]!;
  const end = parts.map((part) => part.windowEnd).sort().at(-1)!;
  return formatCalendarRange(start, end);
}

function ProductBody({ product }: { product: ProductSnapshot }) {
  // GROUPED BY PAGE (bead `ro-ujb9.96.6.5`): the page is said once, as the
  // group's heading, and each finding keeps its one line and its number.
  // Closed, the panel shows the worst finding of each of the three worst
  // places; the expander opens every finding in place.
  const groups = productIssueGroups(product);
  const found = groups.reduce((total, group) => total + group.issues.length, 0);
  const quietChecks = product.checks.filter((check) => check.state !== "fired");
  const window = breakageWindow(product);
  return (
    <>
      <UseStrip product={product} />
      <div className="grid min-w-0 gap-3.5 lg:grid-cols-2">
        <FunnelPanel funnels={product.funnels} />
        <ListPanel
          title="Where it breaks"
          count={[found === 0 ? null : `${formatInt(found)} found`, window].filter(Boolean).join(" · ") || undefined}
          empty={
            quietChecks.every((check) => check.state === "clear")
              ? "Nothing broke in these days."
              : quietChecks.some((check) => check.state === "clear")
                ? "Nothing broke in what could be checked — see below."
                : "Nothing to judge yet — see the checks below."
          }
          groups={groups.map((group) => ({
            key: group.key,
            title: groupTitle(group),
            count: `${formatInt(group.issues.length)} found`,
            marks: { "data-product-group": group.place.kind === "page" ? group.place.path : group.place.kind },
            rows: group.issues.map((issue) => <IssueRow key={issue.key} issue={issue} product={product} />),
          }))}
        />
      </div>
      {quietChecks.length > 0 ? <ChecksLine checks={quietChecks} /> : null}
    </>
  );
}

// --- daily use and the main journey, as one strip ---------------------------

/**
 * Daily use as three measures and their lines. The lines are the ACTUAL days —
 * a seven-day average would open on a warm-up dip no visitor produced — and the
 * window is the section caption's, stated once rather than under each cell.
 */
function UseStrip({ product }: { product: ProductSnapshot }) {
  const days = product.webDaily?.days ?? [];
  const series = (pick: (day: (typeof days)[number]) => number | null): SeriesPointOrGap[] =>
    days.map((day) => ({ t: day.date, v: pick(day) }));
  const people = dailyMean(days.map((day) => day.people));
  const pageviews = dailyTotal(days.map((day) => day.pageviews));
  const sessions = dailyTotal(days.map((day) => day.sessions));
  const missing = product.webDaily ? "fewer than 3 days" : "not collected";

  return (
    <SmallMultipleStrip columns={3}>
      <SmallMultiple
        label="People a day"
        value={people === null ? "—" : formatInt(Math.round(people))}
        secondary={people === null ? missing : `daily average, ${formatInt(days.length)} days`}
        secondaryBelow
        spark={product.webDaily ? series((day) => day.people) : undefined}
        sparkAverage={false}
        format={formatInt}
      />
      <SmallMultiple
        label="Page views"
        value={pageviews === null ? "—" : formatCompact(pageviews)}
        secondary={pageviews === null ? missing : `total, ${formatInt(days.length)} days`}
        secondaryBelow
        spark={product.webDaily ? series((day) => day.pageviews) : undefined}
        sparkAverage={false}
        format={formatInt}
      />
      <SmallMultiple
        label="Sessions"
        value={sessions === null ? "—" : formatCompact(sessions)}
        secondary={sessions === null ? missing : `total, ${formatInt(days.length)} days`}
        secondaryBelow
        spark={product.webDaily ? series((day) => day.sessions) : undefined}
        sparkAverage={false}
        format={formatInt}
        // Three cells in a phone's two columns would leave a hole in the strip.
        className="col-span-2 sm:col-span-1"
      />
    </SmallMultipleStrip>
  );
}

// --- the funnel ---------------------------------------------------------------

function FunnelPanel({ funnels }: { funnels: ProductFunnel[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? funnels : funnels.slice(0, FUNNELS_SHOWN);
  const hidden = funnels.length - FUNNELS_SHOWN;
  return (
    <section
      className="flex min-w-0 flex-col rounded-[10px] border border-border bg-card"
      aria-label="Funnels"
      data-product-funnels
    >
      <SectionLabel
        title="Funnels"
        caption={funnels.length === 0 ? undefined : `${formatInt(funnels.length)} tracked`}
        className="px-4 pb-2 pt-3"
      />
      {funnels.length === 0 ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground">No funnel has been collected yet.</div>
      ) : (
        <div className="flex flex-col gap-4 px-4 pb-4">
          {visible.map((funnel) => (
            <FunnelBlock key={funnel.id} funnel={funnel} />
          ))}
        </div>
      )}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
          className={cn(
            "mt-auto border-t border-border/60 px-4 py-2 text-start text-xs text-muted-foreground hover:text-foreground",
            pillControlClass,
            "motion-safe:transition-colors",
          )}
        >
          {showAll ? "Show fewer" : `Show ${formatInt(hidden)} more funnel${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </section>
  );
}

/**
 * One funnel as bars against its first step. The bar is the shape — where the
 * people go — and the figures ride it: people at the step, and the share of the
 * step before, which is the number a fix moves. The largest drop carries a
 * glyph and its words, never a colour alone: losing people at a step is where
 * to look, not an alarm.
 */
function FunnelBlock({ funnel }: { funnel: ProductFunnel }) {
  const start = funnel.steps[0]?.people ?? 0;
  const movement = funnelDropMovement(funnel);
  const drop = funnel.largestDrop;
  return (
    <div className="grid gap-2" data-product-funnel={funnel.id}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 className="m-0 text-[13px] font-semibold">{funnel.name}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatCalendarRange(funnel.windowStart, funnel.windowEnd)}
        </span>
        {funnel.conversion === null ? null : (
          <span className="ms-auto text-xs tabular-nums text-muted-foreground" data-funnel-conversion>
            <span className="text-xl font-semibold text-foreground">{percent(funnel.conversion)}</span> finish
            {funnel.prior?.conversion == null
              ? " · no earlier week yet"
              : ` · ${percent(funnel.prior.conversion)} the week before`}
          </span>
        )}
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground sm:text-end">
        People · share of the step before
      </div>
      <ol className="m-0 grid list-none gap-1.5 p-0">
        {funnel.steps.map((step, index) => {
          const previous = index === 0 ? null : (funnel.steps[index - 1]?.people ?? null);
          const isDrop = drop !== null && step.step === drop.toStep;
          return (
            <li
              key={step.step}
              // A FIXED number column: every row is its own grid, and an `auto`
              // column would end each bar at a different x — bars that do not
              // share a right edge cannot be compared by length.
              className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_7.5rem]"
              data-funnel-step={step.step}
              {...(isDrop ? { "data-largest-drop": "" } : {})}
            >
              <span
                className={cn("min-w-0 truncate text-xs text-foreground", isDrop && "font-semibold")}
                title={funnelStepLabel(step)}
              >
                {isDrop ? <span aria-label="Largest drop: ">▼ </span> : null}
                {funnelStepLabel(step)}
              </span>
              <Meter
                value={step.people}
                max={start}
                ariaLabel={`${funnelStepLabel(step)}: ${formatInt(step.people)} of ${formatInt(start)} people who started`}
                className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"
              />
              <span className="col-start-2 row-start-1 text-end text-xs tabular-nums sm:col-start-auto sm:row-start-auto">
                <span className="font-semibold text-foreground">{formatInt(step.people)}</span>
                {previous !== null && previous > 0 ? (
                  <span className={cn("ms-1.5", isDrop ? "font-semibold text-foreground" : "text-muted-foreground")}>
                    {percent(step.people / previous, 0)}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {drop ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <span>
            <span aria-hidden>▼ </span>Largest drop: {formatInt(drop.lostPeople)} people stop before{" "}
            {funnelStepLabel(funnel.steps.find((step) => step.step === drop.toStep) ?? { event: "the next step", path: null })}
          </span>
          {movement === null ? (
            <span>No earlier week to compare.</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <DeltaChip
                value={movement}
                render={(value) => `${value.toFixed(1)} pts`}
                tone={funnel.prior?.stepConversion ? performanceTone((drop.stepConversion / funnel.prior.stepConversion - 1) * 100) : "neutral"}
                meaning={`At the largest drop, ${percent(drop.stepConversion)} continued ${formatCalendarRange(funnel.windowStart, funnel.windowEnd)} against ${percent(funnel.prior!.stepConversion!)} ${formatCalendarRange(funnel.prior!.windowStart, funnel.prior!.windowEnd)}.`}
                className="text-xs"
              />
              <span>vs the week before</span>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- where it breaks ------------------------------------------------------------

const RATING_TONE: Record<WebVitalRating, StateTone> = {
  good: "affirmative",
  "needs-improvement": "caution",
  poor: "critical",
};

const RATING_GLYPH: Record<WebVitalRating, string> = {
  good: "✓",
  "needs-improvement": "!",
  poor: "✕",
};

/**
 * One Core Web Vitals reading against Google's lines: the value, the verdict in
 * words and a glyph, in the attention tone the verdict earns (doc 14). A metric
 * with no measurements says so rather than borrowing "good".
 */
function VitalReading({
  metric,
  value,
  rating,
  unit,
  line,
  subject,
}: {
  metric: "LCP" | "INP" | "CLS";
  /** The traffic segment this is a reading of, `vitals:<segment>`. */
  subject: StatusSubject;
  value: number | null;
  rating: WebVitalRating | null;
  unit: string;
  line: ProductVitalLine;
}) {
  if (value === null || rating === null) {
    return <StateChip tone="na" label={`${metric} not measured`} dot="hollow" subject={subject} />;
  }
  const shown = metric === "CLS" ? value.toFixed(2) : formatInt(value);
  const good = metric === "CLS" ? line.good.toFixed(2) : formatInt(line.good);
  const poor = metric === "CLS" ? line.poor.toFixed(2) : formatInt(line.poor);
  return (
    <StateChip
      tone={RATING_TONE[rating]}
      glyph={RATING_GLYPH[rating]}
      subject={subject}
      label={
        <span className="tabular-nums">
          {metric} {shown}
          {unit} · {RATING_WORDS[rating]}
        </span>
      }
      title={`${metric} p75 · good ≤ ${good}${unit} · poor > ${poor}${unit}`}
    />
  );
}

/** A group's heading: the page, or where a finding with no page belongs. */
function groupTitle(group: ProductIssueGroup): string {
  if (group.place.kind === "page") return group.place.path;
  return group.place.kind === "site" ? "Whole site" : "Probably third-party";
}

function IssueRow({ issue, product }: { issue: ProductIssue; product: ProductSnapshot }) {
  switch (issue.kind) {
    case "speed":
      return <SpeedRow segment={issue.segment} severity={issue.severity} product={product} />;
    case "rage": {
      const { cluster } = issue;
      const rage = product.rageClicks!;
      return (
        <ListRow
          tone="warn"
          glyph="△"
          title={cluster.element}
          captionWrap
          caption={`Rage clicks · ${formatInt(cluster.people)} of ${formatInt(cluster.pagePeople)} visitors`}
          value={percent(cluster.share)}
          valueLabel="of visitors"
          marks={{ "data-product-issue": "rage" }}
        >
          <Facts
            facts={[
              ["Repeat clicks", formatInt(cluster.clicks)],
              ["On desktop", cluster.desktopShare === null ? "—" : percent(cluster.desktopShare, 0)],
              ["Flag line", `${percent(rage.shareLine, 0)} of visitors`],
            ]}
          />
        </ListRow>
      );
    }
    case "error": {
      const { exception } = issue;
      return (
        <ListRow
          tone={issue.severity}
          glyph={issue.severity === "info" ? "◦" : "△"}
          title={exceptionName(exception)}
          captionWrap
          caption={`Error · ${formatInt(exception.count)} times`}
          value={formatInt(exception.people)}
          valueLabel="people"
          marks={{ "data-product-issue": "error" }}
        >
          <ErrorOrigin hasSourceFile={exception.hasSourceFile} subject={`error:${exceptionName(exception)}`} />
          <Facts
            facts={[
              ["Sessions", exception.sessions === null ? "—" : formatInt(exception.sessions)],
              ["Most in one session", exception.maxPerSession === null ? "—" : formatInt(exception.maxPerSession)],
              ["Browser", exception.topBrowser ?? "—"],
            ]}
          />
        </ListRow>
      );
    }
    case "noise":
      return (
        <ListRow
          tone="info"
          glyph="◦"
          title={exceptionName(issue.exception)}
          captionWrap
          caption={`${formatInt(issue.exception.count)} of ${formatInt(issue.total)} errors`}
          value={percent(issue.exception.share, 0)}
          valueLabel="of errors"
          marks={{ "data-product-issue": "noise" }}
        >
          <ErrorOrigin hasSourceFile={issue.exception.hasSourceFile} subject={`error:${exceptionName(issue.exception)}`} />
          <Facts
            facts={[
              ["People", formatInt(issue.exception.people)],
              ["Most in one session", issue.exception.maxPerSession === null ? "—" : formatInt(issue.exception.maxPerSession)],
            ]}
          />
        </ListRow>
      );
    case "once":
      return (
        <ListRow
          tone="warn"
          glyph="△"
          title={`${issue.event.event} fires ${issue.event.perPerson.toFixed(1)}× per person`}
          captionWrap
          caption={`Named to happen once · ${formatInt(issue.event.count)} times by ${formatInt(issue.event.people)} people`}
          value={`${issue.event.perPerson.toFixed(1)}×`}
          valueLabel="per person"
          marks={{ "data-product-issue": "once" }}
        >
          <Facts facts={[["Counts built on it", `${issue.event.perPerson.toFixed(1)}× too high`]]} />
          <NextStep>Check where the site sends it</NextStep>
        </ListRow>
      );
  }
}

function SpeedRow({
  segment,
  severity,
  product,
}: {
  segment: ProductVitalSegment;
  severity: "error" | "warn";
  product: ProductSnapshot;
}) {
  const vitals = product.vitals!;
  const headline = segmentHeadline(segment, vitals.lines);
  const rating = segmentRating(segment);
  return (
    <ListRow
      tone={severity}
      glyph="△"
      title={segmentName(segment)}
      captionWrap
      caption={`Speed · ${rating ? RATING_WORDS[rating].toLowerCase() : "not measured"} · ${formatInt(segment.measurements)} measurements`}
      value={headline ? `${formatInt(headline.value)} ms` : "—"}
      valueLabel={headline ? `${headline.metric} p75` : undefined}
      marks={{ "data-product-issue": "speed" }}
    >
      <span className="flex flex-wrap gap-1.5">
        <VitalReading metric="LCP" value={segment.lcpP75} rating={segment.lcpRating} unit=" ms" line={vitals.lines.lcp} subject={`vitals:${segmentName(segment)}`} />
        <VitalReading metric="INP" value={segment.inpP75} rating={segment.inpRating} unit=" ms" line={vitals.lines.inp} subject={`vitals:${segmentName(segment)}`} />
        <VitalReading metric="CLS" value={segment.clsP75} rating={segment.clsRating} unit="" line={vitals.lines.cls} subject={`vitals:${segmentName(segment)}`} />
      </span>
    </ListRow>
  );
}

// --- what was checked and found nothing, or could not be judged ----------------

const CHECK_GLYPH: Record<ProductCheck["state"], string> = {
  fired: "△",
  clear: "✓",
  "not-enough-data": "○",
  "not-collected": "–",
};

const CHECK_WORDS: Record<ProductCheck["state"], string> = {
  fired: "found",
  clear: "clear",
  "not-enough-data": "not enough data",
  "not-collected": "not collected",
};

/**
 * The rules that did NOT find anything, and why — so a short list reads as
 * "checked, clear" or "too thin to judge" rather than as silence. Words and a
 * glyph carry the state; the reasons are one tooltip away.
 */
function ChecksLine({ checks }: { checks: ProductCheck[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-product-checks>
      {checks.map((check) => (
        <span key={check.key} className="inline-flex items-center gap-1" data-product-check={check.state}>
          <span aria-hidden className="font-semibold">
            {CHECK_GLYPH[check.state]}
          </span>
          {check.label}: {CHECK_WORDS[check.state]}
        </span>
      ))}
      <InfoTooltip label="Why these checks found nothing">
        {checks.map((check) => (
          <span key={check.key} className="block">
            {check.label}: {check.detail}
          </span>
        ))}
      </InfoTooltip>
    </div>
  );
}

// --- an opened row's evidence, as facts --------------------------------------

/**
 * AN OPENED ROW STATES FACTS, NOT A PARAGRAPH (bead `ro-ujb9.96.6.5`). The
 * rows used to open onto a sentence each — "1,493 people, 62% of them on
 * desktop, against the 18,826 who viewed…" — which the reader had to parse to
 * find the three numbers in it. PostHog's own issue pages lead with the same
 * figures as labelled counts. The window is the list header's, stated once.
 */
function Facts({ facts }: { facts: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-x-4 gap-y-1.5" data-product-facts>
      {facts.map(([label, value]) => (
        <div key={label} className="grid gap-0.5">
          <dt className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">{label}</dt>
          <dd className="m-0 text-xs font-medium tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where an error comes from, as a state rather than a sentence: code the site
 * serves (a stack frame names a source file), none of it, or unknown. Neutral
 * tones: an origin is a fact about the error, not a second severity.
 */
function ErrorOrigin({ hasSourceFile, subject }: { hasSourceFile: boolean | null; subject: StatusSubject }) {
  const face =
    hasSourceFile === null
      ? { label: "Source unknown", Icon: CircleHelp, tone: "na" as const }
      : hasSourceFile
        ? { label: "Site code", Icon: FileCode2, tone: "neutral" as const }
        : { label: "No source file", Icon: FileX2, tone: "na" as const };
  return (
    <span className="flex" data-error-origin={hasSourceFile === null ? "unknown" : hasSourceFile ? "site" : "none"}>
      <StateChip tone={face.tone} label={face.label} glyph={<face.Icon className="size-3" aria-hidden />} subject={subject} />
    </span>
  );
}

/** The one thing to do about a row, as an imperative behind an arrow. */
function NextStep({ children }: { children: string }) {
  return (
    <span className="flex items-center gap-1.5 text-foreground" data-product-next-step>
      <ArrowRight className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}
