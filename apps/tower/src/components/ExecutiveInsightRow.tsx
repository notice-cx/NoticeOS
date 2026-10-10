import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import {
  AlertTriangle,
  Bookmark,
  Check,
  ChevronDown,
  ClipboardCopy,
  Compass,
  Lightbulb,
  RotateCcw,
  Search,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type {
  ExecutiveInsight,
  ExecutiveInsightKind,
  HandoffBead,
} from "@shared/asset-detail";
import { WATCH_SERIES } from "@noticeos/contract/create-watch-window";
import { watchSeriesForSources, type WatchSeed } from "@shared/watch-windows";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { RecommendationReview, useRecommendationValidity } from "@/components/AnalysisEvidence";
import { findingBasis, recommendationHandoffCaveat, type RecommendationValidity } from "@shared/recommendation-validity";
import { FileTaskButton } from "@/components/TaskComposer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ListRowTone } from "@/components/surface/ListPanel";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { formatCalendarRange } from "@/lib/format";
import {
  findingEvidenceUrl,
  taskHandoffPrefill,
  taskHandoffSection,
  type TaskHandoff,
} from "@/lib/task-handoff";
import { cn } from "@/lib/utils";

export const EXECUTIVE_INSIGHT_META: Record<
  ExecutiveInsightKind,
  {
    label: string;
    icon: LucideIcon;
    tone: ListRowTone;
    row: string;
    text: string;
    chip: string;
    dot: string;
  }
> = {
  warning: {
    label: "Warning sign",
    icon: AlertTriangle,
    tone: "error",
    row: "border-l-error bg-error/5",
    text: "text-error",
    chip: "border-error/40 bg-error-soft text-error",
    dot: "bg-error",
  },
  recommendation: {
    label: "Recommendation",
    icon: Compass,
    tone: "warn",
    row: "border-l-warn bg-warn/5",
    text: "text-warn",
    chip: "border-warn/40 bg-warn/10 text-warn",
    dot: "bg-warn",
  },
  discovery: {
    label: "Discovery",
    icon: Search,
    tone: "info",
    row: "border-l-info bg-info/5",
    text: "text-info",
    chip: "border-info/40 bg-info/10 text-info",
    dot: "bg-info",
  },
  insight: {
    label: "Insight",
    icon: Lightbulb,
    tone: "info",
    row: "border-l-muted-foreground bg-muted/15",
    text: "text-muted-foreground",
    chip: "border-border bg-muted text-foreground",
    dot: "bg-muted-foreground",
  },
};

export interface ExecutiveInsightRowProps {
  insight: ExecutiveInsight;
  asset?: string;
  rank?: number;
  /** The task filed from this finding's handoff, or null when none has been
   * filed or the register could not be asked. Both render nothing: the row
   * shows work that exists, never asserts that none does. */
  bead?: HandoffBead | null;
  /** Open the asset page's outcome-check composer, seeded from this finding.
   * Absent renders no action. */
  onWatch?: (seed: WatchSeed) => void;
  marked?: boolean;
  dismissed?: boolean;
  onToggleMarked?: () => void;
  onDismiss?: () => void;
  onRestore?: () => void;
  /** The one decision this scan starts on. Other rows stay compact until the
   * operator asks for their prose and controls. */
  initiallyExpanded?: boolean;
  /** Native `<details name>` groups the list into one open decision at a time,
   * without a second accordion primitive or custom keyboard behavior. */
  disclosureGroup?: string;
  /** The row sits under a heading that already names its kind, so the eyebrow
   * omits it; the kind glyph and rail still carry it. */
  grouped?: boolean;
  className?: string;
}

/** A decision-facing interpretation with its evidence and limitation. The
 * closed face answers the glance questions (kind, priority, what happened, how
 * large, whether work exists); one expanded row answers why and what next. */
export function ExecutiveInsightRow({
  insight,
  asset,
  rank,
  bead = null,
  onWatch,
  marked = false,
  dismissed = false,
  onToggleMarked,
  onDismiss,
  onRestore,
  initiallyExpanded = false,
  disclosureGroup,
  grouped = false,
  className,
}: ExecutiveInsightRowProps) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const [copied, flashCopied] = useCopyFlash();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const meta = EXECUTIVE_INSIGHT_META[insight.kind];
  const Icon = meta.icon;
  const validity = useRecommendationValidity(findingBasis(insight));
  const prefill = taskHandoffPrefill(
    findingTaskHandoff(insight, asset, validity, asset ? findingEvidenceUrl(asset) : undefined),
  );
  // Until filed, File task sits beside the figure, two presses from any row;
  // once filed the row carries the task's badge there instead.
  const fileOnRow = prefill !== null && bead === null;

  async function copyMarkdown() {
    try {
      await copyText(
        executiveInsightMarkdown(insight, asset, validity),
      );
      flashCopied();
      toast.success("Copied complete finding as Markdown");
    } catch {
      toast.error("Copy failed — expand the evidence and copy manually");
    }
  }

  return (
    <article
      className={cn(
        "min-w-0 overflow-hidden border-l-2",
        meta.row,
        marked && "ring-1 ring-inset ring-info/50",
        dismissed && "opacity-65",
        className,
      )}
      data-insight-kind={insight.kind}
      data-insight-tone={insight.kind}
      data-insight-marked={marked || undefined}
      data-insight-dismissed={dismissed || undefined}
      data-insight-filed={bead?.status ?? undefined}
    >
      <details
        className="group/finding"
        name={disclosureGroup}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        data-insight-disclosure
      >
        <summary
          className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,auto)_auto] sm:px-4 [&::-webkit-details-marker]:hidden"
          data-insight-summary
        >
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full border bg-background/60",
              meta.chip,
            )}
            title={`${meta.label}, priority ${rank ?? "not ranked"}`}
          >
            <Icon
              className={cn("size-4", meta.text)}
              aria-hidden
            />
          </span>

          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {grouped ? null : (
                <span className={cn("font-semibold", meta.text)}>{meta.label}</span>
              )}
              {rank !== undefined ? (
                <span className="tabular-nums">Priority {rank}</span>
              ) : null}
              <span>Original analysis: {insight.confidence} confidence</span>
              {marked && !grouped ? (
                <Badge variant="secondary" className="gap-1 py-0 text-[10px] normal-case tracking-normal">
                  <Bookmark className="size-3 fill-current" aria-hidden />
                  Marked
                </Badge>
              ) : null}
            </span>
            <span className="mt-1 block text-sm font-semibold leading-snug text-foreground sm:text-base">
              {insight.title}
            </span>
            <RecommendationReview validity={validity} subject={`finding:${insight.key}`} passive />
          </span>

          <span className="col-span-2 flex min-w-0 items-center gap-2 pl-12 sm:col-span-1 sm:justify-end sm:pl-0">
            <span className="min-w-0 text-left sm:text-right">
              <span className="block text-lg font-semibold leading-none tabular-nums text-foreground sm:text-xl">
                {insight.primary.value}
              </span>
              <span className="mt-1 block max-w-40 text-[9px] uppercase leading-tight tracking-wider text-muted-foreground">
                {savedEvidenceLabel(insight.primary.label)}
              </span>
            </span>
            <HandoffBeadBadge bead={bead} />
            {fileOnRow ? (
              // Pressing it must not also toggle the row. A click inside the
              // composer's portal bubbles here through React too; only this
              // button's own DOM is held back.
              <span
                className="contents"
                onClickCapture={(event) => {
                  if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
                }}
              >
                <FileTaskButton
                  prefill={prefill}
                  subject={insight.title}
                  variant="outline"
                  className="h-8 px-2 text-xs"
                />
              </span>
            ) : null}
          </span>

          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open/finding:rotate-180"
            aria-hidden
          />
        </summary>

        <div
          className="grid gap-4 border-t border-border px-3 py-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_13rem]"
          data-insight-detail
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Original suggested move · review before acting
            </div>
            <p className="mt-1 text-sm leading-relaxed text-foreground">
              {insight.summary}
            </p>
            <RecommendationReview validity={validity} subject={`finding:${insight.key}`} />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Why it matters:</span>{" "}
              {insight.whyItMatters}
            </p>
            <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
              Evidence {formatCalendarRange(insight.windowStart, insight.windowEnd)}
            </p>
          </div>

          <div className="min-w-0 border-t border-border pt-3 lg:border-t-0 lg:border-l-2 lg:pl-3 lg:pt-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Handoff
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 px-2"
              onClick={copyMarkdown}
              title="Copy this finding, its evidence, sources, and limitation as Markdown"
            >
              {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
              {copied ? "Copied" : "Copy Markdown"}
            </Button>
            {/* Files the task the Markdown brief describes, from the same
                prefill, without a terminal. Ghost-quiet so the finding stays
                the row's loudest thing. */}
            {prefill && !fileOnRow ? (
              <FileTaskButton
                prefill={prefill}
                subject={insight.title}
                className="mt-1 h-7 px-2 text-xs text-muted-foreground"
              />
            ) : null}
            {onWatch && !demoReadonly ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-2 text-xs text-muted-foreground"
                onClick={() =>
                  onWatch({
                    subject: insight.title,
                    series:
                      watchSeriesForSources(insight.sources) ??
                      WATCH_SERIES[0]!,
                    query: null,
                    beadId: bead?.beadId ?? null,
                  })
                }
                title="Pre-register how this finding's fix will be judged, before doing it"
                aria-label={`Watch the outcome for ${insight.title}`}
              >
                <Timer aria-hidden /> Watch outcome
              </Button>
            ) : null}
            {!demoReadonly ? <div className="mt-1 flex items-center gap-1">
              {dismissed ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  onClick={onRestore}
                  title="Restore this finding to the active list"
                >
                  <RotateCcw aria-hidden /> Restore
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant={marked ? "default" : "ghost"}
                    size="icon"
                    className="size-8"
                    aria-pressed={marked}
                    onClick={onToggleMarked}
                    title={marked ? "Remove mark" : "Mark and move to the top"}
                  >
                    <Bookmark
                      className={cn(marked && "fill-current")}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {marked ? "Remove mark" : "Mark"}
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={onDismiss}
                    title="Dismiss from the active findings list"
                  >
                    <X aria-hidden />
                    <span className="sr-only">Dismiss</span>
                  </Button>
                </>
              )}
            </div> : null}
          </div>
        </div>

        <details className="group/evidence border-t border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground marker:content-none sm:px-4">
            <span>
              Evidence &amp; limits ·{" "}
              {formatCount(insight.evidence.length, "fact")} ·{" "}
              {formatCount(insight.sources.length, "source")}
            </span>
            <span className="text-[10px] uppercase tracking-wider group-open/evidence:hidden">
              Expand
            </span>
            <span className="hidden text-[10px] uppercase tracking-wider group-open/evidence:inline">
              Collapse
            </span>
          </summary>
          <div className="grid gap-4 border-t border-border bg-muted/20 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sources
              </span>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {insight.sources.map((source) => {
                  const sourceInfo = sourceMeta(source);
                  return (
                    <Badge
                      key={source}
                      variant={sourceInfo.bing ? "outline" : "secondary"}
                      className={cn(
                        "font-mono",
                        sourceInfo.bing && "border-search-bing/45 text-search-bing",
                      )}
                      title={source}
                    >
                      {sourceInfo.label}
                    </Badge>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Limitation:</span>{" "}
                {insight.caveat}
              </p>
            </div>
            <div>
              <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {insight.evidence.map((row) => (
                  <div key={`${row.label}-${row.value}`} className="min-w-0">
                    <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {savedEvidenceLabel(row.label)}
                    </dt>
                    <dd
                      className="mt-0.5 break-words text-sm font-medium tabular-nums text-foreground"
                      title={row.detail}
                    >
                      {row.value}
                    </dd>
                    {row.detail ? (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {row.detail}
                      </p>
                    ) : null}
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </details>
      </details>
    </article>
  );
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Stored labels retain their meaning without claiming a live measurement. */
export function savedEvidenceLabel(label: string): string {
  return label === "Current organic rank" ? "Rank at analysis" : label;
}

export function executiveInsightMarkdown(
  insight: ExecutiveInsight,
  asset?: string,
  validity?: RecommendationValidity,
): string {
  const meta = EXECUTIVE_INSIGHT_META[insight.kind];
  const evidence = insight.evidence.flatMap((row) => [
    `- **${savedEvidenceLabel(row.label)}:** ${row.value}`,
    ...(row.detail ? [`  - ${row.detail}`] : []),
  ]);
  return [
    `# ${meta.label}: ${insight.title}`,
    "",
    ...(asset ? [`- **Site:** \`${asset}\``, ""] : []),
    "## Meaning / next move",
    "",
    insight.summary,
    "",
    "## Why it matters",
    "",
    insight.whyItMatters,
    "",
    "## Primary metric",
    "",
    `- **${savedEvidenceLabel(insight.primary.label)}:** ${insight.primary.value}`,
    "",
    "## Evidence recorded in this analysis",
    "",
    ...evidence,
    "",
    "## Context",
    "",
    `- **Evidence window:** ${insight.windowStart} to ${insight.windowEnd}`,
    `- **Original analysis confidence:** ${insight.confidence}`,
    `- **Applicability review:** ${recommendationHandoffCaveat(validity)}`,
    `- **Sources:** ${insight.sources.map((source) => `\`${source}\``).join(", ")}`,
    "",
    "## Limitation",
    "",
    insight.caveat,
    "",
    ...taskHandoffSection(findingTaskHandoff(insight, asset, validity)),
  ].join("\n");
}

/**
 * The task this finding becomes, in the asset's own repo: the one description
 * both the copied Markdown (as a `bd create`) and the File task composer read.
 * `null` when the row cannot name a real repo or key (an older snapshot, or the
 * gallery), so neither surface files against nothing.
 *
 * Built from the finding's fields, never its prose: the subject, the primary
 * figure and evidence rows, the window and sources, then the page. The
 * producer's `summary` and `whyItMatters` stay in the Markdown, since a task
 * body quoting them would restate a recommendation as a commitment.
 */
export function findingTaskHandoff(
  insight: ExecutiveInsight,
  asset?: string,
  validity?: RecommendationValidity,
  evidenceUrl?: string,
): TaskHandoff | null {
  if (!asset || !insight.key) return null;
  const measured = [insight.primary, ...insight.evidence]
    .filter((row, index, rows) => rows.findIndex((other) => other.label === row.label && other.value === row.value) === index)
    .map((row) => `${savedEvidenceLabel(row.label)}: ${row.value}`);
  return {
    asset,
    kind: "finding",
    // A finding's card key is both its rule id and its decision key —
    // `decisions.key` for kind `finding` is this exact string.
    key: insight.key,
    rule: insight.key,
    title: insight.title,
    summary: `${EXECUTIVE_INSIGHT_META[insight.kind].label} on ${asset}. ${measured.join(". ")}.`,
    applicabilityReview: `Window: ${insight.windowStart} to ${insight.windowEnd}. Sources: ${insight.sources.join(", ") || "not named"}. Original analysis confidence: ${insight.confidence}. ${recommendationHandoffCaveat(validity)}`,
    ...(evidenceUrl ? { evidenceUrl } : {}),
    priority: FINDING_PRIORITY[insight.kind],
  };
}

/** `bd` priority, 0 highest. A warning is ground already being lost; an insight
 * is context that earns a slot only once the louder kinds are clear. */
const FINDING_PRIORITY: Record<ExecutiveInsightKind, number> = {
  warning: 1,
  recommendation: 2,
  discovery: 2,
  insight: 3,
};

function sourceMeta(source: string): { label: string; bing: boolean } {
  const [integration, ...reportParts] = source.split("/");
  const report = reportParts
    .join("/")
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  if (integration === "bing-webmaster") {
    return { label: `Bing · ${report}`, bing: true };
  }
  if (integration === "gsc") {
    return { label: `GSC · ${report}`, bing: false };
  }
  if (integration === "ga4") {
    return { label: `GA4 · ${report}`, bing: false };
  }
  if (integration === "dataforseo") {
    return { label: `DataForSEO · ${report}`, bing: false };
  }
  if (integration === "posthog") {
    return { label: `PostHog · ${report}`, bing: false };
  }
  return { label: source, bing: false };
}
