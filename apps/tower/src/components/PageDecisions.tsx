import { useOwnerToast } from '@/lib/browser-context';
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardCopy,
  EyeOff,
  Quote,
  Search,
  SearchX,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import type {
  AnnotationTimeline,
  AssetInfo,
  HandoffBead,
  SearchPageMover,
  SearchPageTrends,
} from "@shared/asset-detail";
import { foldSerpPanelAio } from "@shared/asset-detail";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import {
  RecommendationReview,
  ValidityChip,
  useRecommendationAssessor,
} from "@/components/AnalysisEvidence";
import {
  pageBasis,
  sharedValidity,
  type RecommendationValidity,
} from "@shared/recommendation-validity";
import { FileTaskButton } from "@/components/TaskComposer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import {
  DECISION_TONE_CLASSES,
  DecisionLaneSummary,
  EvidenceLine,
  MobileCellLabel,
  aioSurfaceLine,
  laneLabel,
  type DecisionLane,
  type DecisionTone,
} from "@/components/decision-lanes";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { formatCalendarDate, formatInt, formatPercent } from "@/lib/format";
import {
  pageDecisionMarkdown,
  pageTaskHandoff,
  type PageDecisionCause,
} from "@/lib/page-decision-markdown";
import { taskHandoffPrefill } from "@/lib/task-handoff";
import { cn } from "@/lib/utils";

const DEFAULT_VISIBLE_PAGES = 8;

const COLLAPSED_VISIBLE_PAGES = 3;

/** Deliberately its own list rather than the query table's: a page is judged
 * on movement in its own clicks, impressions and position. */
type PageDecisionKind =
  | "recover"
  | "harvest"
  | "aio-walled"
  | "aio-champion"
  | "shown-not-taken"
  | "slipping"
  | "growing"
  | "watch";

/** What most likely moved a page's clicks, inferred from the evidence the row
 * carries. It points at the evidence line to read and proves nothing, which
 * is why the row says "likely". */
type PageCause = PageDecisionCause;

interface PageRelease {
  at: string;
  note: string | null;
}

interface PageAssessment {
  lane: DecisionLane;
  kind: PageDecisionKind;
  /** What happened, in two or three words. */
  label: string;
  /** What to do, in one short imperative. */
  action: string;
  cause: PageCause | null;
  /** The newest release inside the window, drawn with a mover's evidence. */
  release: PageRelease | null;
  priority: number;
  icon: LucideIcon;
}

interface PageDecision {
  row: SearchPageMover;
  assessment: PageAssessment;
  validity: RecommendationValidity;
}

/**
 * One page, one decision row: the query decision table's analogue on the
 * grain an operator edits. The evidence is `executive.searchPages` plus the
 * page's leading query and what the tracked SERP panel saw on it. The task
 * hub join is the absolute page URL, never the display path: two assets can
 * share `/recipes`, not a URL.
 */
export function PageDecisions({
  pages,
  asset,
  handoffBeads = null,
  annotations = null,
  collapsed = false,
  statedState = null,
}: {
  pages: SearchPageTrends | null;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  /** What the task hub holds for this asset. `null` means it could not be
   * asked and renders no stronger claim than an empty result can support. */
  handoffBeads?: HandoffBead[] | null;
  /** The asset's change timeline: a release inside the comparison window is
   * the first likely cause of a click move. `null` names no release. */
  annotations?: AnnotationTimeline | null;
  /** The three biggest movers, each closed on its own evidence, with the rest
   * one click away in place. */
  collapsed?: boolean;
  /** The saved analysis's applicability as this screen already states it. The
   * list's chip is drawn only when it says something different. */
  statedState?: RecommendationValidity["state"] | null;
}) {
  const assess = useRecommendationAssessor();
  const filed = new Map(
    (handoffBeads ?? [])
      .filter((entry) => entry.kind === "page")
      .map((entry) => [entry.key, entry]),
  );
  const releases = pages ? releasesInWindow(annotations, pages) : [];
  const decisions: PageDecision[] = (pages?.pages ?? [])
    .map((row) => ({
      row,
      assessment: assessPage(row, releases),
      validity: assess(
        pageBasis(
          row.page,
          pages!,
          row.leadingQuery !== null,
          (row.leadingQuery?.aioDevices.length ?? 0) > 0,
        ),
      ),
    }))
    .sort(
      (left, right) =>
        left.assessment.priority - right.assessment.priority ||
        Number(filed.has(left.row.page)) - Number(filed.has(right.row.page)) ||
        Math.abs(right.row.clickDelta) - Math.abs(left.row.clickDelta) ||
        left.row.path.localeCompare(right.row.path),
    );
  const limit = collapsed ? COLLAPSED_VISIBLE_PAGES : DEFAULT_VISIBLE_PAGES;
  const visible = decisions.slice(0, limit);
  const remaining = decisions.slice(limit);
  // The state every row shares is said once in the header; a row carries a
  // chip only where its own state differs.
  const shared = sharedValidity(decisions.map((decision) => decision.validity));

  return (
    <section
      id="page-decisions"
      aria-labelledby="page-decisions-title"
      className={cn(
        "min-w-0 scroll-mt-16",
        collapsed ? "flex flex-col gap-2" : "border-t border-border pt-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="page-decisions-title"
            className={cn(
              "font-semibold uppercase text-muted-foreground",
              collapsed
                ? "text-[11px] tracking-[0.08em]"
                : "text-wall-label tracking-widest",
            )}
          >
            Page decisions
          </h3>
        </div>
        {pages ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {shared && shared.state !== "unverified" && shared.state !== statedState ? (
              <span data-page-decisions-validity={shared.state}>
                <ValidityChip validity={shared} subject="analysis:saved" />
              </span>
            ) : null}
            <p
              className="text-xs text-muted-foreground"
              title={`Exact periods: ${pages.currentStart}–${pages.currentEnd}, compared with ${pages.previousStart}–${pages.previousEnd}`}
            >
              Google · latest {formatInt(pages.daysPerWindow)} days vs prior{" "}
              {formatInt(pages.daysPerWindow)}
            </p>
          </div>
        ) : null}
      </div>

      {pages === null || decisions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-page-decisions-empty>
          Needs two full weeks of Search Console data
        </p>
      ) : (
        <>
          <DecisionLaneSummary
            counts={decisions.reduce(
              (result, { assessment }) => {
                result[assessment.lane] += 1;
                return result;
              },
              { act: 0, investigate: 0, protect: 0, wait: 0 },
            )}
            total={decisions.length}
            totalLabel="Pages compared"
          />
          <PageDecisionTable
            decisions={visible}
            pages={pages}
            asset={asset}
            filed={filed}
            sharedState={shared?.state ?? null}
            collapsed={collapsed}
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
                    ? `Show all ${formatInt(decisions.length)} pages →`
                    : `Review ${remaining.length} more pages`}
                </span>
                <span className="hidden group-open:inline">
                  {collapsed
                    ? `Show the top ${formatInt(visible.length)} only`
                    : "Hide additional pages"}
                </span>
              </summary>
              <PageDecisionTable
                decisions={remaining}
                pages={pages}
                asset={asset}
                filed={filed}
                sharedState={shared?.state ?? null}
                collapsed={collapsed}
                nested
              />
            </details>
          ) : null}
          {/* Provenance belongs to the list. */}
          {collapsed ? (
            <div className="border-t border-border/60 pt-1">
              <PageSourceNote pages={pages} />
            </div>
          ) : (
            <PageSourceNote pages={pages} />
          )}
        </>
      )}
    </section>
  );
}

const PAGE_DECISION_GRID =
  "lg:grid-cols-[10.5rem_minmax(12rem,0.9fr)_minmax(18rem,1.35fr)_minmax(19rem,1.4fr)]";

function PageDecisionTable({
  decisions,
  pages,
  asset,
  filed,
  sharedState,
  collapsed = false,
  nested = false,
}: {
  decisions: PageDecision[];
  pages: SearchPageTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  filed: ReadonlyMap<string, HandoffBead>;
  sharedState: RecommendationValidity["state"] | null;
  collapsed?: boolean;
  nested?: boolean;
}) {
  // Collapsed it is a list: no `role="table"` promising a grid that is not there.
  if (collapsed) {
    return (
      <ul
        aria-label="Page decisions"
        className={cn(
          "divide-y divide-border/60 border-border/60",
          nested ? "border-t" : "border-y",
        )}
      >
        {decisions.map((decision) => (
          <li key={decision.row.page}>
            <PageDecisionRow
              decision={decision}
              pages={pages}
              asset={asset}
              bead={filed.get(decision.row.page) ?? null}
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
      aria-label="Page decisions"
      className={cn(!nested && "border-b border-border")}
    >
      {!nested ? (
        <div
          role="row"
          className={cn(
            "hidden gap-4 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:grid",
            PAGE_DECISION_GRID,
          )}
        >
          <div role="columnheader">Decision</div>
          <div role="columnheader">Page</div>
          <div role="columnheader">Where we stand</div>
          <div role="columnheader">Next step</div>
        </div>
      ) : null}
      <div role="rowgroup" className="divide-y divide-border">
        {decisions.map((decision) => (
          <PageDecisionRow
            key={decision.row.page}
            decision={decision}
            pages={pages}
            asset={asset}
            bead={filed.get(decision.row.page) ?? null}
            ownState={decision.validity.state !== sharedState}
          />
        ))}
      </div>
    </div>
  );
}

function PageDecisionRow({
  decision,
  pages,
  asset,
  bead,
  ownState,
  collapsed = false,
}: {
  decision: PageDecision;
  pages: SearchPageTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  bead: HandoffBead | null;
  /** The row's applicability differs from its list's, so it wears its own chip. */
  ownState: boolean;
  collapsed?: boolean;
}) {
  const toast = useOwnerToast();
  const [copied, flashCopied] = useCopyFlash();
  const { row, assessment, validity } = decision;
  const Icon = assessment.icon;
  const tone = pageDecisionTone(assessment.kind);
  const colors = DECISION_TONE_CLASSES[tone];
  const prefill = taskHandoffPrefill(pageTaskHandoff({ row, assessment, asset, validity }));

  async function copyMarkdown() {
    try {
      await copyText(
        pageDecisionMarkdown({ row, assessment, pages, asset, validity }),
      );
      flashCopied();
      toast.success(`Copied ${row.path} as Markdown`);
      // The copy records nothing: only a task filed in the hub marks the row.
    } catch {
      toast.error("Copy failed — copy the row details manually");
    }
  }

  // What happened, then what to do: one line the operator acts on without
  // opening the row.
  const verdict = (
    <span className="block text-xs leading-snug" data-page-decision-verdict>
      <span className={cn("font-medium", colors.text)}>{assessment.label}</span>
      <span className="sr-only">: </span>
      <ArrowRight className="mx-1 inline size-3 align-[-2px] text-muted-foreground" aria-hidden />
      <span className="text-foreground">{assessment.action}</span>
    </span>
  );

  // Built once and rendered by whichever shape asked for it.
  const actions = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2"
        onClick={copyMarkdown}
        title={`Copy the complete ${row.path} decision and evidence as Markdown`}
        aria-label={`${copied ? "Copied" : "Copy Markdown"} for ${row.path}`}
      >
        {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
        {copied ? "Copied" : "Copy Markdown"}
      </Button>
      {/* Built from `pageTaskHandoff`, the function the copied Markdown's
          create command is rendered from, so the row cannot offer two
          different tasks for one decision. */}
      {prefill ? (
        <FileTaskButton
          prefill={prefill}
          subject={row.path}
          className="h-7 px-2 text-xs text-muted-foreground"
        />
      ) : null}
      <RecommendationReview validity={validity} subject={`page:${row.page}`} />
    </div>
  );

  if (collapsed) {
    return (
      <details
        // No tone stripe: the glyph and the decision label already carry the tone.
        className="group"
        data-page-decision-kind={assessment.kind}
        data-page-decision-tone={tone}
        data-page-decision-filed={bead?.status ?? undefined}
        data-page-decision-cause={assessment.cause?.kind}
        data-page-decision-collapsed
      >
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-2 py-2">
          <Icon className={cn("size-4 shrink-0", colors.text)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-mono text-[13px] font-semibold text-foreground">
                {row.path}
              </span>
              <HandoffBeadBadge bead={bead} />
              {ownState ? <RecommendationReview validity={validity} subject={`page:${row.page}`} passive /> : null}
            </span>
            {verdict}
          </span>
          <span className="shrink-0 text-right" data-page-decision-value>
            <span className="block text-[13px] font-semibold tabular-nums text-foreground">
              {formatInt(row.currentClicks)}
            </span>
            <span className="block text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
              clicks
            </span>
          </span>
          <DeltaChip
            value={row.clickDeltaPercent ?? row.clickDelta}
            render={(value) =>
              row.clickDeltaPercent === null
                ? formatInt(Math.abs(value))
                : `${formatPercent(value)}%`
            }
            tone={performanceTone(row.clickDeltaPercent ?? row.clickDelta)}
            className="shrink-0 text-[11px]"
          />
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        <div className="grid gap-3 px-2 pb-3 pl-8 lg:grid-cols-[minmax(0,1fr)_auto]">
          <PageEvidence row={row} assessment={assessment} />
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
        PAGE_DECISION_GRID,
      )}
      data-page-decision-kind={assessment.kind}
      data-page-decision-tone={tone}
      data-page-decision-filed={bead?.status ?? undefined}
      data-page-decision-cause={assessment.cause?.kind}
    >
      <div role="cell" className="order-2 min-w-0 lg:order-none">
        <MobileCellLabel>Decision</MobileCellLabel>
        <div className="flex items-start gap-2">
          <Icon className={cn("mt-0.5 size-4 shrink-0", colors.text)} aria-hidden />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={colors.chip}>
                {laneLabel(assessment.lane)}
              </Badge>
              <HandoffBeadBadge bead={bead} />
              {ownState ? <RecommendationReview validity={validity} subject={`page:${row.page}`} passive /> : null}
            </div>
            <div className={cn("mt-1 text-sm font-semibold", colors.text)}>
              {assessment.label}
            </div>
          </div>
        </div>
      </div>

      <div role="cell" className="order-1 min-w-0 lg:order-none">
        <MobileCellLabel>Page</MobileCellLabel>
        <div className="truncate font-mono text-sm font-semibold leading-snug text-foreground">
          {row.path}
        </div>
        {row.leadingQuery ? (
          <p className="mt-1 truncate text-[10px] text-muted-foreground">
            leads on “{row.leadingQuery.query}”
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Leading query unknown
          </p>
        )}
      </div>

      <div role="cell" className="order-3 min-w-0 lg:order-none">
        <MobileCellLabel>Where we stand</MobileCellLabel>
        <PageEvidence row={row} assessment={assessment} />
      </div>

      <div
        role="cell"
        className="order-4 min-w-0 border-l-2 border-border pl-2.5 lg:order-none"
      >
        <MobileCellLabel>Next step</MobileCellLabel>
        <p className="mb-2 text-sm leading-snug text-foreground" data-page-decision-action>
          {assessment.action}
        </p>
        {actions}
      </div>
    </article>
  );
}

/** The one tag that ties a verdict to the evidence line behind it. */
function LikelyCause() {
  return (
    <span
      data-likely-cause
      className="ml-1.5 inline-flex items-center rounded-sm bg-muted px-1 align-[1px] text-[10px] font-medium uppercase tracking-[0.04em] text-foreground"
    >
      Likely cause
    </span>
  );
}

function PageEvidence({
  row,
  assessment,
}: {
  row: SearchPageMover;
  assessment: PageAssessment;
}) {
  const aio = row.leadingQuery ? aioSurfaceLine(row.leadingQuery.aioDevices) : "";
  const cause = assessment.cause?.kind ?? null;
  const release = assessment.release;
  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
      <EvidenceLine label="Clicks">
        <span className="tabular-nums text-foreground">
          {formatInt(row.currentClicks)}
        </span>{" "}
        {/* From a week with no clicks there is no percentage a reader can use,
            so the absolute change is what the chip carries. */}
        <DeltaChip
          value={row.clickDeltaPercent ?? row.clickDelta}
          render={(value) =>
            row.clickDeltaPercent === null
              ? formatInt(Math.abs(value))
              : `${formatPercent(value)}%`
          }
          tone={performanceTone(row.clickDeltaPercent ?? row.clickDelta)}
          className="text-[10px]"
        />{" "}
        · {formatInt(row.previousClicks)} the week before
      </EvidenceLine>
      <EvidenceLine label="Impressions">
        <span className="tabular-nums text-foreground">
          {formatInt(row.currentImpressions)}
        </span>{" "}
        <DeltaChip
          value={row.impressionDeltaPercent}
          render={(value) => `${formatPercent(value)}%`}
          tone={performanceTone(row.impressionDeltaPercent)}
          className="text-[10px]"
        />
        {cause === "demand" ? <LikelyCause /> : null}
      </EvidenceLine>
      <EvidenceLine label="CTR">
        <span className="tabular-nums text-foreground">
          {formatPercent(row.currentCtr * 100)}%
        </span>{" "}
        · {formatPercent(row.previousCtr * 100)}% the week before
        {/* The benchmark the harvest rule compared against, beside the number it judged. */}
        {assessment.kind === "harvest" || assessment.kind === "aio-walled"
          ? ` · typical ${formatPercent(PAGE_HARVEST_MAX_CTR * 100)}%`
          : ""}
        {cause === "result-page" ? <LikelyCause /> : null}
      </EvidenceLine>
      {row.currentPosition !== null ? (
        <EvidenceLine label="Average position">
          <span className="tabular-nums text-foreground">
            {row.currentPosition.toFixed(1)}
          </span>
          {row.positionImprovement !== null ? (
            <>
              {" "}
              <DeltaChip
                value={row.positionImprovement}
                render={(value) => Math.abs(value).toFixed(1)}
                tone={performanceTone(row.positionImprovement * 10)}
                className="text-[10px]"
              />
            </>
          ) : null}
          {cause === "ranking" ? <LikelyCause /> : null}
        </EvidenceLine>
      ) : null}
      {row.leadingQuery ? (
        <EvidenceLine label="Leading query">
          “{row.leadingQuery.query}” ·{" "}
          <span className="tabular-nums text-foreground">
            {formatInt(row.leadingQuery.impressions)}
          </span>{" "}
          impressions ·{" "}
          <span className="tabular-nums text-foreground">
            {formatInt(row.leadingQuery.clicks)}
          </span>{" "}
          clicks
          {row.leadingQuery.position !== null
            ? ` · position ${row.leadingQuery.position.toFixed(1)}`
            : ""}
        </EvidenceLine>
      ) : null}
      {/* Only where the tracked panel read that term. Nothing rendered means
          nobody looked — never "no overview". */}
      {aio ? <EvidenceLine label="AI Overview">{aio}</EvidenceLine> : null}
      {release ? (
        <EvidenceLine label="Release">
          <span className="tabular-nums text-foreground">{shortDay(release.at)}</span>
          {release.note ? ` · ${release.note}` : ""}
          {cause === "release" ? <LikelyCause /> : null}
        </EvidenceLine>
      ) : null}
    </div>
  );
}

/** What the data source states about its own series before ranking it, and
 * the limits of the grain. Both render: a source that quietly drops either is
 * a source nobody can audit. */
function PageSourceNote({ pages }: { pages: SearchPageTrends }) {
  return (
    <details className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-muted-foreground hover:text-foreground">
        Sources and limits · {formatInt(pages.evidence.length + 1)} note
        {pages.evidence.length === 0 ? "" : "s"}
      </summary>
      <p className="mt-1">
        <span className="font-medium text-foreground">
          Google ({pages.source}):
        </span>{" "}
        {pages.caveat}
      </p>
      {pages.evidence.map((entry) => (
        <p key={entry.label} className="mt-1">
          <span className="font-medium text-foreground">{entry.label}:</span>{" "}
          <span className="tabular-nums">{entry.value}</span>
          {entry.detail ? ` — ${entry.detail}` : ""}
        </p>
      ))}
    </details>
  );
}

function pageDecisionTone(kind: PageDecisionKind): DecisionTone {
  if (kind === "recover") return "loss";
  if (kind === "harvest") return "opportunity";
  if (kind === "aio-walled" || kind === "shown-not-taken" || kind === "slipping") {
    return "investigate";
  }
  if (kind === "growing" || kind === "aio-champion") return "positive";
  return "wait";
}

// The evidence floors.
//
// The page-mover rule's own floor (`PAGE_MOVER_MIN_CLICK_DELTA`,
// scripts/signal-insights.mjs); below it, click movement is weather.
const PAGE_MIN_CLICK_MOVE = 10;
// A fifth of the week's clicks, the same magnitude the query lane treats as real.
const PAGE_MATERIAL_DROP_PERCENT = -20;
const PAGE_MATERIAL_RISE_PERCENT = 20;
// The striking-distance impression floor at a seven-date window
// (`Math.max(100, days * 25)`), so a page is not sent for copy work on
// evidence the query rule would refuse.
const PAGE_HARVEST_MIN_IMPRESSIONS = 175;
// The CTR benchmark at a visible position when the AI Overview cites you. A
// page clicking below it is under-converting its own exposure, which is a
// copy question before it is a ranking one.
const PAGE_HARVEST_MAX_CTR = 0.021;
const PAGE_HARVEST_MIN_POSITION = 4;
const PAGE_HARVEST_MAX_POSITION = 12;
// Below one position the weekly average moves with the query mix, not the page.
const PAGE_SLIP_POSITIONS = -1;

/** The deploys recorded inside the current comparison window, newest first.
 * A deploy is asset-wide, so it is a page's likely cause only when nothing
 * page-specific (ranking, demand) explains the move. */
function releasesInWindow(
  annotations: AnnotationTimeline | null,
  pages: SearchPageTrends,
): PageRelease[] {
  return (annotations?.items ?? [])
    .filter((item) => item.kind === "deploy")
    .filter((item) => {
      const day = item.at.slice(0, 10);
      return day >= pages.currentStart && day <= pages.currentEnd;
    })
    .sort((left, right) => right.at.localeCompare(left.at))
    .map((item) => ({ at: item.at, note: item.note }));
}

function shortDay(at: string): string {
  return formatCalendarDate(at.slice(0, 10)).replace(/, \d{4}$/, "");
}

/**
 * Which evidence line explains a click move, most specific first: a ranking
 * move of a full position, then impressions moving by a fifth, then a release
 * inside the window, and otherwise the result page — exposure and ranking held
 * while the click-through moved.
 */
function clickCause(
  row: SearchPageMover,
  direction: 1 | -1,
  releases: PageRelease[],
): PageCause {
  if (
    row.positionImprovement !== null &&
    row.positionImprovement * direction >= -PAGE_SLIP_POSITIONS
  ) {
    return { kind: "ranking" };
  }
  if (row.impressionDeltaPercent * direction >= PAGE_MATERIAL_RISE_PERCENT) {
    return { kind: "demand" };
  }
  const release = releases[0];
  if (release) return { kind: "release", at: release.at, note: release.note };
  return { kind: "result-page" };
}

const LOSS_ACTION: Record<PageCause["kind"], (cause: PageCause) => string> = {
  ranking: () => "Find what now outranks this page",
  demand: () => "Fewer searches; compare with last year before editing",
  release: (cause) =>
    `Check what the ${cause.kind === "release" ? shortDay(cause.at) : ""} release changed here`,
  "result-page": () => "Search it live; a new result is taking the clicks",
};

const GAIN_ACTION: Record<PageCause["kind"], (cause: PageCause) => string> = {
  ranking: () => "Ranking rose; repeat the change on a similar page",
  demand: () => "More searches; keep the page as it is",
  release: (cause) =>
    `The ${cause.kind === "release" ? shortDay(cause.at) : ""} release likely helped; repeat it`,
  "result-page": () => "Record what changed so the gain can be repeated",
};

/**
 * The panel's two rules, layered over the page's own movement, as the query
 * table applies them. Both read `=== true` rather than truthiness: the panel
 * is additive evidence, and an unknown changes nothing.
 */
function assessPage(
  row: SearchPageMover,
  releases: PageRelease[] = [],
): PageAssessment {
  const aio = row.leadingQuery
    ? foldSerpPanelAio(row.leadingQuery.aioDevices)
    : null;
  if (aio?.aioCitesUs === true) return pageAioChampion(row);
  const base = basePageAssessment(row, releases);
  if (aio?.aioPresent === true && base.kind === "harvest") {
    return pageAioWalled(base);
  }
  return base;
}

/** Being cited is what the copy work was chasing. The page leaves the act lane
 * whichever way its clicks moved, because the one edit that reliably loses a
 * citation is rewriting the passage that earned it. A page sliding under its
 * citation defends the citation first. */
function pageAioChampion(row: SearchPageMover): PageAssessment {
  const slipping =
    (row.clickDeltaPercent ?? 0) <= PAGE_MATERIAL_DROP_PERCENT ||
    (row.positionImprovement ?? 0) <= PAGE_SLIP_POSITIONS;
  return {
    lane: "protect",
    kind: "aio-champion",
    label: "AI Overview cites this page",
    action: slipping
      ? "Recheck the citation now; keep the quoted passage"
      : "Keep the quoted passage; add rather than rewrite",
    cause: null,
    release: null,
    priority: 5,
    icon: Quote,
  };
}

/** The impression-harvest gate, applied automatically at page grain: the
 * overview consumes the click, so a sharper title buys churn and no reach. */
function pageAioWalled(base: PageAssessment): PageAssessment {
  return {
    ...base,
    lane: "investigate",
    kind: "aio-walled",
    label: "Walled by AI Overview",
    action: "See who the AI Overview cites before editing the title",
    priority: 3,
    icon: EyeOff,
  };
}

function basePageAssessment(
  row: SearchPageMover,
  releases: PageRelease[],
): PageAssessment {
  const clickPercent = row.clickDeltaPercent;
  if (
    row.clickDelta <= -PAGE_MIN_CLICK_MOVE &&
    (clickPercent === null || clickPercent <= PAGE_MATERIAL_DROP_PERCENT)
  ) {
    const cause = clickCause(row, -1, releases);
    return {
      lane: "act",
      kind: "recover",
      label: "Lost clicks",
      action: LOSS_ACTION[cause.kind](cause),
      cause,
      release: releases[0] ?? null,
      priority: 0,
      icon: TrendingDown,
    };
  }
  if (row.clickDelta >= PAGE_MIN_CLICK_MOVE) {
    const cause = clickCause(row, 1, releases);
    return {
      lane: "protect",
      kind: "growing",
      label: "Gaining clicks",
      action: GAIN_ACTION[cause.kind](cause),
      cause,
      release: releases[0] ?? null,
      priority: 6,
      icon: TrendingUp,
    };
  }
  if (
    row.currentPosition !== null &&
    row.currentPosition >= PAGE_HARVEST_MIN_POSITION &&
    row.currentPosition <= PAGE_HARVEST_MAX_POSITION &&
    row.currentImpressions >= PAGE_HARVEST_MIN_IMPRESSIONS &&
    row.currentCtr < PAGE_HARVEST_MAX_CTR
  ) {
    return {
      lane: "act",
      kind: "harvest",
      label: "Shown, rarely clicked",
      action: row.leadingQuery
        ? `Rewrite the title and opening for “${row.leadingQuery.query}”`
        : "Rewrite the title and opening answer",
      cause: null,
      release: null,
      priority: 1,
      icon: Target,
    };
  }
  if (
    row.impressionDeltaPercent >= PAGE_MATERIAL_RISE_PERCENT &&
    row.clickDelta <= 0
  ) {
    // New impressions at a worse position are not lost clicks.
    const lower =
      row.positionImprovement !== null &&
      row.positionImprovement <= PAGE_SLIP_POSITIONS;
    return {
      lane: "investigate",
      kind: "shown-not-taken",
      label: "Shown more, taken no more",
      action: lower
        ? "Shown lower for new queries; no fix needed yet"
        : "Check which new queries show this page",
      cause: lower ? { kind: "ranking" } : null,
      release: null,
      priority: 2,
      icon: Search,
    };
  }
  if (
    row.positionImprovement !== null &&
    row.positionImprovement <= PAGE_SLIP_POSITIONS &&
    row.currentImpressions >= PAGE_HARVEST_MIN_IMPRESSIONS
  ) {
    return {
      lane: "investigate",
      kind: "slipping",
      label: "Position slipping",
      action: "Search it live and see who moved above it",
      cause: null,
      release: null,
      priority: 4,
      icon: SearchX,
    };
  }
  return {
    lane: "wait",
    kind: "watch",
    label: "No real change",
    action: "Nothing to do",
    cause: null,
    release: null,
    priority: 7,
    icon: Search,
  };
}
