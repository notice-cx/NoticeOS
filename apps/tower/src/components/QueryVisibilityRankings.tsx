import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Eye,
  EyeOff,
  Quote,
  Scale,
  SearchX,
  ShieldCheck,
  Target,
  Timer,
  TrendingUp,
} from "lucide-react";

import type {
  AssetInfo,
  DataForSeoQueryVisibilityRow,
  ExecutiveEvidence,
  HandoffBead,
  SearchQueryMover,
  SearchQueryProviderTrend,
  SearchQueryTrends,
} from "@shared/asset-detail";
import {
  aiOverviewGlyphState,
  foldSerpPanelAio,
  serpPanelDeviceNoun,
} from "@shared/asset-detail";
import { AiOverviewGlyphs } from "@/components/AiOverviewGlyphs";
import {
  RecommendationReview,
  ValidityChip,
  useRecommendationAssessor,
} from "@/components/AnalysisEvidence";
import {
  queryBasis,
  sharedValidity,
  type RecommendationValidity,
} from "@shared/recommendation-validity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { FileTaskButton } from "@/components/TaskComposer";
// The lane vocabulary both decision tables share; the rules stay here, because
// a query is judged on evidence a page is not.
import {
  AIO_SURFACE_PHRASE,
  DECISION_TONE_CLASSES,
  DecisionLaneSummary,
  EvidenceLine,
  MobileCellLabel,
  laneLabel,
  type DecisionLane,
  type DecisionTone,
} from "@/components/decision-lanes";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import {
  formatCalendarDate,
  formatInt,
  formatPercent,
} from "@/lib/format";
import {
  queryDecisionMarkdown,
  queryTaskHandoff,
} from "@/lib/query-decision-markdown";
import { taskHandoffPrefill } from "@/lib/task-handoff";
import { cn } from "@/lib/utils";
import { WATCH_SERIES, type WatchSeries } from "@noticeos/contract/create-watch-window";
import type { WatchSeed } from "@shared/watch-windows";

const DEFAULT_VISIBLE_QUERIES = 8;

const COLLAPSED_VISIBLE_QUERIES = 3;

type DecisionKind =
  | "recover"
  | "near-win"
  | "ranking-opportunity"
  | "organic-gap"
  | "aio-walled"
  | "mixed"
  | "weak"
  | "aio-champion"
  | "strong"
  | "growing"
  | "watch";

interface UnifiedQueryRow {
  key: string;
  query: string;
  google: SearchQueryMover | null;
  bing: SearchQueryMover | null;
  dataforseo: DataForSeoQueryVisibilityRow | null;
}

interface QueryAssessment {
  lane: DecisionLane;
  kind: DecisionKind;
  /** What the evidence says, in two or three words. */
  label: string;
  /** What to do about it: one short imperative. The evidence lines are the why. */
  action: string;
  priority: number;
  icon: LucideIcon;
}

interface QueryDecision {
  row: UnifiedQueryRow;
  assessment: QueryAssessment;
  /** How far the saved analysis behind this row can still be trusted. */
  validity: RecommendationValidity;
}

/** One query, one decision row. Provider evidence stays separate: Search
 * Console and Bing impressions are observed exposure, DataForSEO volume is
 * modelled demand. A row the task hub holds a task for keeps its evidence but
 * sinks below unfiled rows in its priority band. */
export function QueryVisibilityRankings({
  trends,
  asset,
  handoffBeads = null,
  onWatch,
  collapsed = false,
  statedState = null,
}: {
  trends: SearchQueryTrends | null;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  /** What the task hub holds for this asset. `null` means it could not be
   * asked, and renders exactly as "nobody filed anything" does. */
  handoffBeads?: HandoffBead[] | null;
  /** Open the asset page's outcome-check composer, seeded from one row.
   * Absent renders no action at all. */
  onWatch?: (seed: WatchSeed) => void;
  /** Three rows, each closed on its own evidence; opening one gives back the
   * full cells in place with the same actions. */
  collapsed?: boolean;
  /** The saved analysis's applicability as this screen already states it. The
   * list's own chip is drawn only when it says something different. */
  statedState?: RecommendationValidity["state"] | null;
}) {
  // Filtered to `query`: a finding's key is a rule id, and one equal to a
  // query string would otherwise lend that query its task.
  const filed = new Map(
    (handoffBeads ?? [])
      .filter((entry) => entry.kind === "query")
      .map((entry) => [entry.key, entry]),
  );

  const assess = useRecommendationAssessor();
  const decisions: QueryDecision[] = unifiedQueryRows(trends)
    .map((row) => ({
      row,
      assessment: assessQuery(row),
      validity: assess(queryBasis(row.key, trends!, {
        google: row.google !== null, bing: row.bing !== null, dataforseo: row.dataforseo !== null,
        trackedPanel: (row.dataforseo?.aioDevices.length ?? 0) > 0,
      })),
    }))
    .sort((left, right) => compareDecisions(left, right, filed));
  // The state every row shares is said once in the header, and not even there
  // when the screen already said it; a row wears its own chip only where it differs.
  const shared = sharedValidity(decisions.map((decision) => decision.validity));
  const sharedState = shared?.state ?? null;
  const visible = featuredDecisions(
    decisions,
    collapsed ? COLLAPSED_VISIBLE_QUERIES : DEFAULT_VISIBLE_QUERIES,
    filed,
  );
  const visibleKeys = new Set(visible.map(({ row }) => row.key));
  const remaining = decisions.filter(({ row }) => !visibleKeys.has(row.key));

  return (
    <section
      id="query-visibility"
      aria-labelledby="query-visibility-title"
      className={cn(
        "min-w-0 scroll-mt-16",
        collapsed ? "flex flex-col gap-2" : "border-t border-border pt-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="query-visibility-title"
            className={cn(
              "font-semibold uppercase text-muted-foreground",
              collapsed
                ? "text-[11px] tracking-[0.08em]"
                : "text-wall-label tracking-widest",
            )}
          >
            Query decisions
          </h3>
        </div>
        {trends ? (
          <div className="flex max-w-full flex-wrap items-center justify-start gap-1.5 sm:justify-end">
            {shared && shared.state !== "unverified" && shared.state !== statedState ? (
              <span data-query-decisions-validity={shared.state}>
                <ValidityChip validity={shared} subject="analysis:saved" />
              </span>
            ) : null}
            <SourceWindows trends={trends} />
          </div>
        ) : null}
      </div>

      {trends === null || decisions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-query-decisions-empty>
          Needs two Search Console weeks or a DataForSEO snapshot
        </p>
      ) : (
        <>
          <DecisionSummary decisions={decisions} />
          <DecisionTable
            decisions={visible}
            trends={trends}
            asset={asset}
            filed={filed}
            onWatch={onWatch}
            collapsed={collapsed}
            sharedState={sharedState}
          />
          {remaining.length > 0 ? (
            <details className="group border-b border-border">
              <summary
                className={cn(
                  "flex cursor-pointer list-none items-center font-medium hover:text-muted-foreground",
                  collapsed
                    ? "min-h-[44px] text-xs text-muted-foreground hover:text-foreground"
                    : "py-3 text-sm text-foreground",
                )}
              >
                <span className="group-open:hidden">
                  {collapsed
                    ? `Show all ${formatInt(decisions.length)} queries →`
                    : `Review ${remaining.length} more queries`}
                </span>
                <span className="hidden group-open:inline">
                  {collapsed
                    ? `Show the top ${formatInt(visible.length)} only`
                    : "Hide additional queries"}
                </span>
              </summary>
              <DecisionTable
                decisions={remaining}
                trends={trends}
                asset={asset}
                filed={filed}
                onWatch={onWatch}
                collapsed={collapsed}
                sharedState={sharedState}
                nested
              />
            </details>
          ) : null}
          {/* Provenance belongs to the list, whether or not there is a "Show all". */}
          {collapsed ? (
            <div className="border-t border-border/60 pt-1">
              <SourceNotes trends={trends} />
            </div>
          ) : null}
        </>
      )}

      {trends && !collapsed ? <SourceNotes trends={trends} /> : null}
    </section>
  );
}

/** Two providers comparing the same two windows are one comparison, said once
 * with both names. */
function sameWindows(left: SearchQueryProviderTrend, right: SearchQueryProviderTrend): boolean {
  return (
    left.currentStart === right.currentStart &&
    left.currentEnd === right.currentEnd &&
    left.previousStart === right.previousStart &&
    left.previousEnd === right.previousEnd &&
    left.daysPerWindow === right.daysPerWindow
  );
}

function SourceWindows({ trends }: { trends: SearchQueryTrends }) {
  const grouped = trends.google !== null && trends.bing !== null && sameWindows(trends.google, trends.bing);
  return (
    <div className="flex max-w-full flex-wrap justify-start gap-1.5 text-[11px] tabular-nums sm:justify-end">
      {grouped ? (
        <SourceWindow trend={trends.google!} label="Google + Bing" />
      ) : null}
      {trends.google && !grouped ? (
        <SourceWindow trend={trends.google} label="Google" />
      ) : null}
      {trends.bing && !grouped ? (
        <SourceWindow trend={trends.bing} label="Bing" />
      ) : null}
      {trends.dataforseo ? (
        <Badge variant="outline" title={trends.dataforseo.source}>
          DataForSEO · {formatCalendarDate(trends.dataforseo.observedAt)}
        </Badge>
      ) : null}
    </div>
  );
}

function SourceWindow({
  trend,
  label,
}: {
  trend: SearchQueryProviderTrend;
  label: "Google" | "Bing" | "Google + Bing";
}) {
  const comparisonLabel = queryWindowComparisonLabel(trend);
  const exactWindows = `${trend.currentStart}–${trend.currentEnd}, compared with ${trend.previousStart}–${trend.previousEnd}`;
  return (
    <Badge
      variant="outline"
      className={cn(label === "Bing" && "text-search-bing")}
      title={`Exact periods: ${exactWindows}`}
      aria-label={`${label}: ${comparisonLabel}. Exact periods: ${exactWindows}`}
      data-query-window={label}
    >
      {label === "Google + Bing" ? (
        <>
          Google + <span className="text-search-bing">Bing</span>
        </>
      ) : (
        label
      )}{" "}
      · {comparisonLabel}
    </Badge>
  );
}

function DecisionSummary({ decisions }: { decisions: QueryDecision[] }) {
  const counts = decisions.reduce(
    (result, { assessment }) => {
      result[assessment.lane] += 1;
      return result;
    },
    { act: 0, investigate: 0, protect: 0, wait: 0 },
  );
  return (
    <DecisionLaneSummary
      counts={counts}
      total={decisions.length}
      totalLabel="Current review set"
    />
  );
}

const DECISION_GRID =
  "lg:grid-cols-[10.5rem_minmax(12rem,0.9fr)_minmax(18rem,1.35fr)_minmax(19rem,1.4fr)]";

function DecisionTable({
  decisions,
  trends,
  asset,
  filed,
  onWatch,
  collapsed = false,
  sharedState,
  nested = false,
}: {
  decisions: QueryDecision[];
  trends: SearchQueryTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  filed: ReadonlyMap<string, HandoffBead>;
  onWatch?: (seed: WatchSeed) => void;
  collapsed?: boolean;
  sharedState: RecommendationValidity["state"] | null;
  nested?: boolean;
}) {
  // Collapsed it is a list, not a table: a `role="table"` over one-line rows
  // would promise a grid a screen reader could navigate and not have one.
  if (collapsed) {
    return (
      <ul
        aria-label="Query decisions"
        className={cn(
          "divide-y divide-border/60 border-border/60",
          nested ? "border-t" : "border-y",
        )}
      >
        {decisions.map((decision) => (
          <li key={decision.row.key}>
            <DecisionRow
              decision={decision}
              trends={trends}
              asset={asset}
              bead={filed.get(decision.row.key) ?? null}
              onWatch={onWatch}
              ownState={decision.validity.state !== sharedState}
              collapsed
            />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div
      role="table"
      aria-label="Query visibility decisions"
      className={cn(!nested && "border-b border-border")}
    >
      {!nested ? (
        <div
          role="row"
          className={cn(
            "hidden gap-4 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:grid",
            DECISION_GRID,
          )}
        >
          <div role="columnheader">Decision</div>
          <div role="columnheader">Query</div>
          <div role="columnheader">Where we stand</div>
          <div role="columnheader">Next step</div>
        </div>
      ) : null}
      <div role="rowgroup" className="divide-y divide-border">
        {decisions.map((decision) => (
          <DecisionRow
            key={decision.row.key}
            decision={decision}
            trends={trends}
            asset={asset}
            bead={filed.get(decision.row.key) ?? null}
            onWatch={onWatch}
            ownState={decision.validity.state !== sharedState}
          />
        ))}
      </div>
    </div>
  );
}

function DecisionRow({
  decision,
  trends,
  asset,
  bead,
  onWatch,
  ownState,
  collapsed = false,
}: {
  decision: QueryDecision;
  trends: SearchQueryTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  /** The task filed from this row's handoff, or null, which renders nothing. */
  bead: HandoffBead | null;
  onWatch?: (seed: WatchSeed) => void;
  /** The row's applicability differs from its list's, so it wears its own chip. */
  ownState: boolean;
  /** A decision, a term and a number, closed over the same evidence and actions. */
  collapsed?: boolean;
}) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const [copied, flashCopied] = useCopyFlash();
  const { row, assessment, validity } = decision;
  const Icon = assessment.icon;
  const tone = decisionTone(assessment.kind);
  const colors = DECISION_TONE_CLASSES[tone];
  const prefill = taskHandoffPrefill(queryTaskHandoff({ row, assessment, asset, validity }));

  async function copyMarkdown() {
    try {
      await copyText(
        queryDecisionMarkdown({
          row,
          assessment,
          trends,
          asset,
          validity,
        }),
      );
      flashCopied();
      toast.success(`Copied “${row.query}” as Markdown`);
      // The copy records nothing: only a task filed in the hub marks the row.
    } catch {
      toast.error("Copy failed — copy the row details manually");
    }
  }

  // What the evidence says, then what to do: one line the operator acts on
  // without opening the row.
  const verdict = (
    <span className="block text-xs leading-snug" data-query-decision-verdict>
      <span className={cn("font-medium", colors.text)}>{assessment.label}</span>
      <span className="sr-only">: </span>
      <ArrowRight className="mx-1 inline size-3 align-[-2px] text-muted-foreground" aria-hidden />
      <span className="text-foreground">{assessment.action}</span>
    </span>
  );

  // Built once and rendered by whichever shape is asked for.
  const actions = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2"
        onClick={copyMarkdown}
        title={`Copy the complete ${row.query} decision, evidence, source windows, and limitations as Markdown`}
        aria-label={`${copied ? "Copied" : "Copy Markdown"} for ${row.query}`}
      >
        {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
        {copied ? "Copied" : "Copy Markdown"}
      </Button>
      {/* The create command at the bottom of the copied Markdown, as a button,
          from the same `queryTaskHandoff`. */}
      {prefill ? (
        <FileTaskButton
          prefill={prefill}
          subject={row.query}
          className="h-7 px-2 text-xs text-muted-foreground"
        />
      ) : null}
      {/* Pre-registers how the work will be judged, before the numbers exist. */}
      {onWatch && !demoReadonly ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() =>
            onWatch({
              subject: `“${row.query}” — ${assessment.label.toLocaleLowerCase("en-US")}`,
              series: watchSeriesForDecision(assessment.kind),
              query: row.query,
              // The window's ref becomes the task that caused it.
              beadId: bead?.beadId ?? null,
            })
          }
          title={`Pre-register how the ${row.query} work will be judged, before doing it`}
          aria-label={`Watch the outcome for ${row.query}`}
        >
          <Timer aria-hidden /> Watch the outcome
        </Button>
      ) : null}
      <RecommendationReview validity={validity} subject={`query:${row.key}`} />
    </div>
  );

  if (collapsed) {
    return (
      <details
        // No tone stripe: the glyph and the decision label already carry the tone.
        className="group"
        data-decision-kind={assessment.kind}
        data-decision-tone={tone}
        data-decision-filed={bead?.status ?? undefined}
        data-decision-collapsed
      >
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-2 py-2">
          <Icon className={cn("size-4 shrink-0", colors.text)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {row.query}
              </span>
              {/* The two marks that decide whether the row is opened at all. */}
              <AiOverviewGlyphs
                readings={row.dataforseo?.aioDevices ?? []}
                unknownSurface="omit"
              />
              <HandoffBeadBadge bead={bead} />
              {ownState ? <RecommendationReview validity={validity} subject={`query:${row.key}`} passive /> : null}
            </span>
            {verdict}
          </span>
          <QueryRowValue row={row} />
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        <div className="grid gap-3 px-2 pb-3 pl-8 lg:grid-cols-[minmax(0,1fr)_auto]">
          <QueryEvidence row={row} />
          <div className="min-w-0 lg:border-l-2 lg:border-border lg:pl-2.5">
            {actions}
          </div>
        </div>
      </details>
    );
  }

  return (
    <article
      role="row"
      className={cn(
        "grid gap-3 border-l-2 px-2 py-3 lg:gap-4 lg:px-3",
        colors.row,
        DECISION_GRID,
      )}
      data-decision-kind={assessment.kind}
      data-decision-tone={tone}
      data-decision-filed={bead?.status ?? undefined}
    >
      <div role="cell" className="order-2 min-w-0 lg:order-none">
        <MobileCellLabel>Decision</MobileCellLabel>
        <div className="flex items-start gap-2">
          <Icon
            className={cn("mt-0.5 size-4 shrink-0", colors.text)}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={colors.chip}>
                {laneLabel(assessment.lane)}
              </Badge>
              {/* An unchecked surface draws nothing here: the pair sits inline
                  with no column to align to, and the evidence line spells it. */}
              <AiOverviewGlyphs
                readings={row.dataforseo?.aioDevices ?? []}
                unknownSurface="omit"
              />
              <HandoffBeadBadge bead={bead} />
              {ownState ? <RecommendationReview validity={validity} subject={`query:${row.key}`} passive /> : null}
            </div>
            <div className={cn("mt-1 text-sm font-semibold", colors.text)}>
              {assessment.label}
            </div>
          </div>
        </div>
      </div>

      <div role="cell" className="order-1 min-w-0 lg:order-none">
        <MobileCellLabel>Query</MobileCellLabel>
        <div className="text-sm font-semibold leading-snug text-foreground">
          {row.query}
          {row.dataforseo?.intent ? (
            // Lowercase and unboxed: a chip here would compete with the decision chip.
            <span
              className="ml-1.5 text-[10px] font-normal lowercase tracking-wide text-muted-foreground"
              title={`DataForSEO classifies this search as ${row.dataforseo.intent} intent`}
            >
              {row.dataforseo.intent}
            </span>
          ) : null}
        </div>
        {row.dataforseo?.page &&
        row.dataforseo.page !== "(not set)" ? (
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {row.dataforseo.page}
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Ranking page unknown
          </p>
        )}
      </div>

      <div role="cell" className="order-3 min-w-0 lg:order-none">
        <MobileCellLabel>Where we stand</MobileCellLabel>
        <QueryEvidence row={row} />
      </div>

      <div
        role="cell"
        className="order-4 min-w-0 border-l-2 border-border pl-2.5 lg:order-none"
      >
        <MobileCellLabel>Next step</MobileCellLabel>
        <p className="mb-2 text-sm leading-snug text-foreground" data-query-decision-action>
          {assessment.action}
        </p>
        {actions}
      </div>
    </article>
  );

}

/** The one number a collapsed row is about: observed impressions where there
 * is a pair, otherwise the modelled organic position. Never both. */
function QueryRowValue({ row }: { row: UnifiedQueryRow }) {
  const observed = row.google ?? row.bing;
  if (observed) {
    return (
      <span className="shrink-0 text-right" data-decision-value="impressions">
        <span className="block text-[13px] font-semibold tabular-nums text-foreground">
          {formatInt(observed.currentImpressions)}
        </span>
        <span className="block text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
          impressions
        </span>
      </span>
    );
  }
  if (row.dataforseo?.organicPosition !== null && row.dataforseo !== null) {
    return (
      <span className="shrink-0 text-right" data-decision-value="position">
        <span className="block text-[13px] font-semibold tabular-nums text-foreground">
          {organicPositionLabel(row.dataforseo.organicPosition)}
        </span>
        <span className="block text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
          position
        </span>
      </span>
    );
  }
  return null;
}

/**
 * The series a row's decision is about: Google position for a claim about
 * where the asset ranks, Google clicks for a claim about the traffic that
 * ranking produces. Never Bing: no lane is ever about Bing.
 */
function watchSeriesForDecision(kind: DecisionKind): WatchSeries {
  const rankLanes = new Set<DecisionKind>([
    "near-win",
    "ranking-opportunity",
    "organic-gap",
    "weak",
    "strong",
  ]);
  const metric = rankLanes.has(kind) ? "position" : "clicks";
  return WATCH_SERIES.find(
    (series) => series.integration === "gsc" && series.metric === metric,
  )!;
}

function QueryEvidence({ row }: { row: UnifiedQueryRow }) {
  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
      {row.dataforseo ? (
        <>
          <EvidenceLine label="Google organic">
            {organicPositionLabel(row.dataforseo.organicPosition)}
            {row.dataforseo.positionImprovement !== null ? (
              <>
                {" "}
                <DeltaChip
                  value={row.dataforseo.positionImprovement}
                  render={(value) => formatInt(Math.abs(value))}
                  tone={performanceTone(row.dataforseo.positionImprovement * 10)}
                  className="text-[10px]"
                />
              </>
            ) : null}
          </EvidenceLine>
          <EvidenceLine label="Market">
            <span className="tabular-nums text-foreground">
              {formatInt(row.dataforseo.monthlySearches)}
            </span>{" "}
            searches/month
            {row.dataforseo.keywordDifficulty !== null
              ? ` · difficulty ${formatInt(row.dataforseo.keywordDifficulty)}`
              : ""}
            {/* Modelled by the provider, so it never joins the observed impressions. */}
            {row.dataforseo.estimatedVisits !== null ? (
              <>
                {" · "}
                <span className="tabular-nums text-foreground">
                  {formatInt(row.dataforseo.estimatedVisits)}
                </span>{" "}
                visits/month at this rank
              </>
            ) : null}
          </EvidenceLine>
          <AiOverviewEvidenceLine row={row.dataforseo} />
        </>
      ) : null}
      {row.google ? (
        <ObservedEvidence label="Google" mover={row.google} />
      ) : null}
      {row.bing ? <ObservedEvidence label="Bing" mover={row.bing} /> : null}
    </div>
  );
}

/** One AI Overview line: the tracked panel's live result page where it read
 * this term, otherwise the weekly inventory's view. Where the surfaces
 * disagree the line names both. */
function AiOverviewEvidenceLine({ row }: { row: DataForSeoQueryVisibilityRow }) {
  const states = row.aioDevices.map((reading) => ({
    device: reading.device,
    state: aiOverviewGlyphState(reading),
  }));
  if (new Set(states.map(({ state }) => state)).size > 1) {
    return (
      <EvidenceLine label="AI Overview">
        {states
          .map(
            ({ device, state }) =>
              `${serpPanelDeviceNoun(device)}: ${AIO_SURFACE_PHRASE[state]}`,
          )
          .join(" · ")}
      </EvidenceLine>
    );
  }
  const aio = foldSerpPanelAio(row.aioDevices);
  if (aio.aioPresent === true) {
    return (
      <EvidenceLine label="AI Overview">
        {aio.aioCitesUs === true
          ? "Cites this site on the tracked panel"
          : "Shown on the tracked panel; not cited"}
      </EvidenceLine>
    );
  }
  if (aio.aioPresent === false) {
    return (
      <EvidenceLine label="AI Overview">Not shown on the tracked panel</EvidenceLine>
    );
  }
  if (row.aiOverview === "cited") {
    return (
      <EvidenceLine label="AI Overview">
        Cited source{" "}
        {row.aiCitationPosition !== null ? (
          <span className="tabular-nums text-foreground">
            #{formatInt(row.aiCitationPosition)}
          </span>
        ) : null}
      </EvidenceLine>
    );
  }
  if (row.aiOverview === "present") {
    return <EvidenceLine label="AI Overview">Shown, not cited</EvidenceLine>;
  }
  return null;
}

function ObservedEvidence({
  label,
  mover,
}: {
  label: "Google" | "Bing";
  mover: SearchQueryMover;
}) {
  return (
    <EvidenceLine label={label}>
      <span className="tabular-nums text-foreground">
        {formatInt(mover.currentImpressions)}
      </span>{" "}
      impressions{" "}
      <DeltaChip
        value={mover.impressionDeltaPercent}
        render={(value) => `${formatPercent(value)}%`}
        tone={performanceTone(mover.impressionDeltaPercent)}
        className="text-[10px]"
      />{" "}
      · avg position{" "}
      <span className="tabular-nums text-foreground">
        {mover.currentPosition.toFixed(1)}
      </span>{" "}
      <DeltaChip
        value={mover.positionImprovement}
        render={(value) => Math.abs(value).toFixed(1)}
        tone={performanceTone(mover.positionImprovement * 10)}
        className="text-[10px]"
      />
    </EvidenceLine>
  );
}

function organicPositionLabel(position: number | null): string {
  if (position === null) return "No result in snapshot";
  if (position <= 3) return `Top 3 · #${formatInt(position)}`;
  if (position <= 10) return `Positions 4–10 · #${formatInt(position)}`;
  if (position <= 20) return `Positions 11–20 · #${formatInt(position)}`;
  return `Position 21+ · #${formatInt(position)}`;
}

function decisionTone(kind: DecisionKind): DecisionTone {
  if (kind === "recover") return "loss";
  if (
    kind === "near-win" ||
    kind === "ranking-opportunity" ||
    kind === "organic-gap"
  ) {
    return "opportunity";
  }
  if (kind === "mixed" || kind === "weak" || kind === "aio-walled") {
    return "investigate";
  }
  if (kind === "strong" || kind === "growing" || kind === "aio-champion") {
    return "positive";
  }
  return "wait";
}

/** The act-lane decisions that ask for copy work, which an AI Overview turns
 * into churn without reach. `recover` is deliberately absent: a real
 * visibility loss must not be quieted because an overview sits on the query. */
const COPY_SURGERY_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "near-win",
  "ranking-opportunity",
  "organic-gap",
]);

/**
 * The tracked panel's two rules, layered over the positional ones. Both read
 * `=== true` rather than truthiness: the panel is additive evidence, and an
 * unknown changes nothing.
 */
function assessQuery(row: UnifiedQueryRow): QueryAssessment {
  const data = row.dataforseo;
  // Any surface the panel read: a citation on the phone is a citation to
  // protect, whatever the desktop showed.
  const aio = data ? foldSerpPanelAio(data.aioDevices) : null;
  if (aio?.aioCitesUs === true) return aioChampion(row);
  const base = baseAssessment(row);
  // An overview that fires and leaves us out of it.
  if (aio?.aioPresent === true && COPY_SURGERY_KINDS.has(base.kind)) {
    return aioWalled();
  }
  return base;
}

/** Being cited is the outcome the copy work was chasing, so the query leaves
 * the act lane: the one change that reliably loses a citation is rewriting
 * the passage that earned it. */
function aioChampion(row: UnifiedQueryRow): QueryAssessment {
  // A citation under a sliding position is the one to defend first.
  const slipping = observedMovers(row).find(
    ({ mover }) =>
      mover.impressionDeltaPercent <= -20 || mover.positionImprovement <= -1,
  );
  return {
    lane: "protect",
    kind: "aio-champion",
    label: "AI Overview cites us",
    action: slipping
      ? `Recheck the citation now; keep the quoted passage on ${targetPage(row)}`
      : `Keep the quoted passage on ${targetPage(row)}; add, don't rewrite`,
    priority: 7,
    icon: Quote,
  };
}

/** An overview consumes the click, so a sharper title buys churn and no reach;
 * the honest next move is a citation play. */
function aioWalled(): QueryAssessment {
  return {
    lane: "investigate",
    kind: "aio-walled",
    label: "Walled by AI Overview",
    action: "See who the AI Overview cites before editing the title",
    priority: 4,
    icon: EyeOff,
  };
}

function baseAssessment(row: UnifiedQueryRow): QueryAssessment {
  const declining = observedMovers(row)
    .filter(
      ({ mover }) =>
        mover.impressionDeltaPercent <= -20 ||
        (mover.positionImprovement <= -1 &&
          mover.impressionDeltaPercent <= 0),
    )
    .sort(
      (left, right) =>
        declineMagnitude(right.mover) - declineMagnitude(left.mover),
    )[0];
  const data = row.dataforseo;
  const target = targetPage(row);

  if (declining) {
    return {
      lane: "act",
      kind: "recover",
      label: "Recover visibility",
      action: `Check ${target}'s query match, indexing and recent edits`,
      priority: 0,
      icon: CircleAlert,
    };
  }

  if (data?.organicPosition !== null && data?.organicPosition !== undefined) {
    if (data.organicPosition <= 3) {
      return {
        lane: "protect",
        kind: "strong",
        label: "Strong organic",
        action: "Protect it: no broad rewrites",
        priority: 8,
        icon: ShieldCheck,
      };
    }
    if (data.organicPosition <= 10) {
      return {
        lane: "act",
        kind: "near-win",
        label: "Near win",
        action: `Sharpen the title and opening answer on ${target}`,
        priority: 1,
        icon: Target,
      };
    }
    if (data.organicPosition <= 20) {
      return {
        lane: "act",
        kind: "ranking-opportunity",
        label: "Ranking opportunity",
        action: `Expand the direct answer on ${target}; add internal links`,
        priority: 2,
        icon: Target,
      };
    }
    if (data.aiOverview === "cited") {
      return {
        lane: "act",
        kind: "organic-gap",
        label: "Organic gap",
        action: `Answer this query more directly on ${target}`,
        priority: 3,
        icon: SearchX,
      };
    }
    const strongObserved = observedMovers(row).find(
      ({ mover }) => mover.currentPosition <= 10,
    );
    if (strongObserved) {
      return {
        lane: "investigate",
        kind: "mixed",
        label: "Mixed visibility",
        action: `Compare Google and ${strongObserved.label} before editing ${target}`,
        priority: 5,
        icon: Scale,
      };
    }
    return {
      lane: "investigate",
      kind: "weak",
      label: "Weak organic",
      action: `Check the query fits ${target} before investing`,
      priority: 6,
      icon: Eye,
    };
  }

  if (data?.aiOverview === "cited") {
    return {
      lane: "act",
      kind: "organic-gap",
      label: "Organic gap",
      action: `Confirm ${target} is the right page, then answer directly`,
      priority: 3,
      icon: SearchX,
    };
  }

  const growing = observedMovers(row)
    .filter(
      ({ mover }) =>
        mover.impressionDeltaPercent >= 20 ||
        mover.positionImprovement >= 1,
    )
    .sort(
      (left, right) =>
        growthMagnitude(right.mover) - growthMagnitude(left.mover),
    )[0];
  const strong = observedMovers(row).find(
    ({ mover }) => mover.currentPosition <= 3,
  );
  if (strong) {
    return {
      lane: "protect",
      kind: "strong",
      label: `Strong on ${strong.label}`,
      action: "Protect it: no broad rewrites",
      priority: 8,
      icon: ShieldCheck,
    };
  }
  if (growing) {
    return {
      lane: "protect",
      kind: "growing",
      label: `Growing on ${growing.label}`,
      action: "Confirm it in the other sources before spending effort",
      priority: 9,
      icon: TrendingUp,
    };
  }
  return {
    lane: "wait",
    kind: "watch",
    label: "Wait for evidence",
    action: "Wait for another comparable window",
    priority: 10,
    icon: Eye,
  };
}

function observedMovers(
  row: UnifiedQueryRow,
): Array<{ label: "Google" | "Bing"; mover: SearchQueryMover }> {
  return [
    ...(row.google ? [{ label: "Google" as const, mover: row.google }] : []),
    ...(row.bing ? [{ label: "Bing" as const, mover: row.bing }] : []),
  ];
}

function declineMagnitude(mover: SearchQueryMover): number {
  return Math.max(
    -mover.impressionDeltaPercent,
    -mover.positionImprovement * 10,
  );
}

function growthMagnitude(mover: SearchQueryMover): number {
  return Math.max(
    mover.impressionDeltaPercent,
    mover.positionImprovement * 10,
  );
}

function targetPage(row: UnifiedQueryRow): string {
  const page = row.dataforseo?.page;
  return page && page !== "(not set)" ? page : "the ranking page";
}

/** Priority band first, then unfiled before filed, then magnitude. Open and
 * closed tasks sink alike: closure records a decision, not proof, but somebody
 * has demonstrably been here. */
function compareDecisions(
  left: QueryDecision,
  right: QueryDecision,
  filed: ReadonlyMap<string, HandoffBead>,
): number {
  return (
    left.assessment.priority - right.assessment.priority ||
    Number(filed.has(left.row.key)) - Number(filed.has(right.row.key)) ||
    (right.row.dataforseo?.monthlySearches ?? 0) -
      (left.row.dataforseo?.monthlySearches ?? 0) ||
    observedMagnitude(right.row) - observedMagnitude(left.row) ||
    left.row.query.localeCompare(right.row.query)
  );
}

const PREFERRED_KINDS: DecisionKind[] = [
  "recover",
  "near-win",
  "ranking-opportunity",
  "organic-gap",
  "aio-walled",
  "mixed",
  "weak",
  "aio-champion",
  "strong",
  "growing",
  "watch",
];

/** One exemplar per decision kind (an unfiled one where there is one), then
 * the strongest rows remaining. */
function featuredDecisions(
  decisions: QueryDecision[],
  limit: number,
  filed: ReadonlyMap<string, HandoffBead>,
): QueryDecision[] {
  const selected: QueryDecision[] = [];
  const selectedKeys = new Set<string>();
  const unfiled = ({ row }: QueryDecision) => !filed.has(row.key);
  const append = (decision: QueryDecision | undefined) => {
    if (!decision || selectedKeys.has(decision.row.key)) return;
    selectedKeys.add(decision.row.key);
    selected.push(decision);
  };
  for (const kind of PREFERRED_KINDS) {
    const ofKind = decisions.filter(
      ({ assessment }) => assessment.kind === kind,
    );
    append(ofKind.find(unfiled) ?? ofKind[0]);
    if (selected.length >= limit) break;
  }
  for (const decision of [
    ...decisions.filter(unfiled),
    ...decisions.filter((item) => !unfiled(item)),
  ]) {
    if (selected.length >= limit) break;
    append(decision);
  }
  return selected.sort((left, right) => compareDecisions(left, right, filed));
}

function unifiedQueryRows(
  trends: SearchQueryTrends | null,
): UnifiedQueryRow[] {
  if (!trends) return [];
  const rows = new Map<string, UnifiedQueryRow>();
  const ensure = (query: string) => {
    const key = query.trim().toLocaleLowerCase("en-US");
    const existing = rows.get(key);
    if (existing) return existing;
    const created: UnifiedQueryRow = {
      key,
      query: query.trim(),
      google: null,
      bing: null,
      dataforseo: null,
    };
    rows.set(key, created);
    return created;
  };

  for (const mover of trends.google?.movers ?? []) {
    ensure(mover.query).google = mover;
  }
  for (const mover of trends.bing?.movers ?? []) {
    ensure(mover.query).bing = mover;
  }
  for (const query of trends.dataforseo?.queries ?? []) {
    ensure(query.query).dataforseo = query;
  }
  return [...rows.values()];
}

function observedMagnitude(row: UnifiedQueryRow): number {
  return Math.max(
    Math.abs(row.google?.impressionDelta ?? 0),
    Math.abs(row.bing?.impressionDelta ?? 0),
  );
}

interface SourceNote {
  key: string;
  label: string;
  source: string;
  caveat: string;
  /** A row present at zero proves the check ran; an empty list means the lane
   * ran no such check. The two must not collapse. */
  evidence: ExecutiveEvidence[];
}

function sourceNotes(trends: SearchQueryTrends): SourceNote[] {
  return [
    trends.google
      ? {
          key: "google",
          label: "Google",
          source: trends.google.source,
          caveat: trends.google.caveat,
          evidence: trends.google.evidence,
        }
      : null,
    trends.bing
      ? {
          key: "bing",
          label: "Bing",
          source: trends.bing.source,
          caveat: trends.bing.caveat,
          evidence: trends.bing.evidence,
        }
      : null,
    trends.dataforseo
      ? {
          key: "dataforseo",
          label: "DataForSEO",
          source: trends.dataforseo.source,
          caveat: trends.dataforseo.caveat,
          // A market-demand baseline states no pre-ranking check.
          evidence: [],
        }
      : null,
  ].filter((note): note is SourceNote => note !== null);
}

/**
 * Provenance for the lanes feeding this section, and the one place their
 * proof rows land. A zero row renders: it is the check reporting clean, and
 * hiding it would leave a lane that never says whether anyone looked.
 */
function SourceNotes({ trends }: { trends: SearchQueryTrends }) {
  const notes = sourceNotes(trends);
  if (notes.length === 0) return null;
  const checks = notes.reduce((total, note) => total + note.evidence.length, 0);
  return (
    <details className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-muted-foreground hover:text-foreground">
        Sources and limits
        {checks > 0
          ? ` · ${formatInt(checks)} check${checks === 1 ? "" : "s"} run`
          : ""}
      </summary>
      <ul className="mt-2 space-y-1.5 pl-4">
        {notes.map((note) => (
          <li key={note.key} className="list-disc" data-source-note={note.key}>
            {note.label} ({note.source}): {note.caveat}
            {note.evidence.length > 0 ? (
              <dl className="mt-1 space-y-1" data-lane-evidence={note.key}>
                {note.evidence.map((row) => (
                  <div
                    key={`${row.label}-${row.value}`}
                    className="flex flex-wrap items-baseline gap-x-1.5"
                  >
                    <dt className="uppercase tracking-wider">{row.label}</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                      {row.value}
                    </dd>
                    {row.detail ? (
                      <dd className="basis-full">{row.detail}</dd>
                    ) : null}
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function queryWindowComparisonLabel(
  trend: SearchQueryProviderTrend,
): string {
  const reports = trend.daysPerWindow;
  const cadence = queryWindowCadence(trend);
  if (cadence === "daily") {
    return `Latest ${reports} days vs prior ${reports}`;
  }
  if (cadence === "weekly") {
    return `Latest ${reports} weeks vs prior ${reports}`;
  }
  return `Latest ${reports} reports vs prior ${reports}`;
}

function queryWindowCadence(
  trend: SearchQueryProviderTrend,
): "daily" | "weekly" | "reported" {
  if (trend.daysPerWindow < 2) return "reported";
  const intervals = [
    averageIntervalDays(
      trend.currentStart,
      trend.currentEnd,
      trend.daysPerWindow,
    ),
    averageIntervalDays(
      trend.previousStart,
      trend.previousEnd,
      trend.daysPerWindow,
    ),
  ];
  if (intervals.every((days) => days <= 2)) return "daily";
  if (intervals.every((days) => days >= 5 && days <= 9)) return "weekly";
  return "reported";
}

function averageIntervalDays(
  start: string,
  end: string,
  reports: number,
): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return Infinity;
  return (endMs - startMs) / 86_400_000 / (reports - 1);
}
