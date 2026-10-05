import type {
  AssetInfo,
  SearchPageMover,
  SearchPageTrends,
} from "@shared/asset-detail";
import { formatInt, formatPercent } from "@/lib/format";
import { taskHandoffSection } from "@/lib/task-handoff";
import { recommendationHandoffCaveat, type RecommendationValidity } from "@shared/recommendation-validity";

type PageDecisionLane = "act" | "investigate" | "protect" | "wait";

/** The evidence line a page decision names as the likely cause of its click
 * move (bead `ro-ujb9.96.6.8`). Structured, so the row can tag the line and
 * this brief can name it without either carrying a sentence. */
export type PageDecisionCause =
  | { kind: "release"; at: string; note: string | null }
  | { kind: "ranking" }
  | { kind: "demand" }
  | { kind: "result-page" };

export interface PageDecisionMarkdownAssessment {
  lane: PageDecisionLane;
  /** The decision kind — the rule id the filed bead carries. */
  kind?: string;
  /** What happened. */
  label: string;
  /** What to do. */
  action: string;
  cause: PageDecisionCause | null;
}

/**
 * One page decision as a self-contained brief (`ro-427`) — the page-grain twin
 * of `queryDecisionMarkdown`, and structurally identical on purpose: an agent
 * receiving one of these should not have to learn two documents.
 *
 * The KEY is the page URL, not its path. Two assets can share a path and a
 * decision has to name exactly one page; the URL is also what `gsc-page`
 * reports and what the next comparison joins on.
 */
export function pageDecisionMarkdown({
  row,
  assessment,
  pages,
  asset,
  validity,
}: {
  row: SearchPageMover;
  assessment: PageDecisionMarkdownAssessment;
  pages: SearchPageTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  validity?: RecommendationValidity;
}): string {
  const propertyIdentity = asset.domain
    ? `${asset.displayName} (\`${asset.domain}\`)`
    : `${asset.displayName} (\`${asset.id}\`)`;

  return [
    `# Page decision: ${row.path}`,
    "",
    `- **Site:** ${propertyIdentity}`,
    `- **Page:** ${row.page}`,
    `- **What to do:** ${laneLabel(assessment.lane)}`,
    `- **Decision:** ${assessment.label}`,
    ...(assessment.cause
      ? [`- **Likely cause:** ${causeLine(assessment.cause)}`]
      : []),
    `- **Applicability review:** ${recommendationHandoffCaveat(validity)}`,
    "",
    "## Suggested next step",
    "",
    assessment.action,
    "",
    "## Evidence",
    "",
    `### Google page comparison · ${pages.source}`,
    "",
    `- **Current window:** ${pages.currentStart} to ${pages.currentEnd}`,
    `- **Previous window:** ${pages.previousStart} to ${pages.previousEnd}`,
    `- **Reports per window:** ${formatInt(pages.daysPerWindow)}`,
    `- **Clicks:** ${formatInt(row.previousClicks)} → ${formatInt(row.currentClicks)} (${signedInt(row.clickDelta)}${
      row.clickDeltaPercent === null
        ? ", no percentage from a week with no clicks"
        : `, ${signedPercent(row.clickDeltaPercent)}`
    })`,
    `- **Impressions:** ${formatInt(row.previousImpressions)} → ${formatInt(row.currentImpressions)} (${signedInt(row.impressionDelta)}, ${signedPercent(row.impressionDeltaPercent)})`,
    `- **CTR:** ${formatPercent(row.previousCtr * 100)}% → ${formatPercent(row.currentCtr * 100)}%`,
    `- **Average position:** ${positionPair(row)}`,
    ...(row.leadingQuery
      ? [
          `- **Leading query (largest by impressions):** “${row.leadingQuery.query}” — ${formatInt(row.leadingQuery.impressions)} impressions, ${formatInt(row.leadingQuery.clicks)} clicks${
            row.leadingQuery.position === null
              ? ""
              : `, position ${row.leadingQuery.position.toFixed(1)}`
          }`,
          ...(row.leadingQuery.aioDevices.length > 0
            ? [`- **Tracked SERP panel:** ${trackedPanelLabel(row)}`]
            : []),
        ]
      : [
          "- **Leading query:** not covered by the page/query export in this window — unknown, not “this page ranks for nothing”.",
        ]),
    // What the lane states about its own series before it ranked anything. It
    // travels with the copy for the same reason it renders on the page: the
    // bead this becomes must be able to show which checks ran.
    ...pages.evidence.map(
      (entry) =>
        `- **${entry.label}:** ${entry.value}${entry.detail ? ` — ${entry.detail}` : ""}`,
    ),
    "",
    "## Source context and limitations",
    "",
    `- **Google (\`${pages.source}\`):** ${pages.caveat}`,
    "- **Decision limit:** This is deterministic triage over two stored weeks, not a guaranteed SEO outcome. Open the page and the live result page before editing.",
    "",
    ...taskHandoffSection(pageTaskHandoff({ row, assessment, asset, validity })),
  ].join("\n");
}

/** Per device, because the surfaces are the finding: an overview can consume the
 * click on the phone and be absent on the desktop. Named only where the panel
 * read more than one — a device column that never varies is noise. */
function trackedPanelLabel(row: SearchPageMover): string {
  const readings = row.leadingQuery?.aioDevices ?? [];
  const named = readings.length > 1;
  return readings
    .map((reading) => {
      const prefix = named ? `${deviceNoun(reading.device)}: ` : "";
      if (reading.aioPresent === null) {
        return `${prefix}read, but the overview did not load — unknown, never “no overview”`;
      }
      if (reading.aioPresent === false) {
        return `${prefix}${named ? "n" : "N"}o AI Overview on the live result page`;
      }
      return reading.aioCitesUs === true
        ? `${prefix}AI Overview fires and cites this site — do not wash out the cited content`
        : `${prefix}AI Overview fires and does not cite this site — the click is largely consumed inline`;
    })
    .join("; ");
}

function deviceNoun(device: string): string {
  if (device === "mobile") return "Phone";
  if (device === "desktop") return "Desktop";
  return device.charAt(0).toUpperCase() + device.slice(1);
}

/** The bead this decision becomes in the asset's own repo.
 *
 * `kind: "page"` is one of the four handoff kinds every list now carries — the
 * poller's `HANDOFF_KINDS` (`scripts/runner/task-snapshot.mjs`), the ingest validator's
 * `BEADS_HANDOFF_KINDS`, the Tower's own reader, and the table in
 * `config/beads.README.md` — so a bead filed from here is reported back onto
 * its row within a poll cycle. It was not always: this surface emitted `page`
 * while the poller knew only `query` and `finding`, and the metadata was
 * written correctly throughout, so the markers appeared retroactively rather
 * than needing the beads refiled. Emitting a kind this surface is not would
 * have been the alternative, and it would have put a page's work on a query's
 * row. `scripts/handoff-kinds.test.mjs` now fails `pnpm test:scripts` when
 * those lists disagree, naming the odd one out (`ro-4l0q`).
 *
 * EXPORTED since bead `ro-l1ed.4`: the copied command and the row's **File
 * task** button file the same bead, and one description of it is the only way
 * the two cannot drift. */
export function pageTaskHandoff({
  row,
  assessment,
  asset,
  validity,
}: {
  row: SearchPageMover;
  assessment: PageDecisionMarkdownAssessment;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  validity?: RecommendationValidity;
}) {
  const key = row.page.trim();
  if (!key) return null;
  return {
    asset: asset.id,
    kind: "page" as const,
    key,
    rule: assessment.kind || assessment.lane,
    title: `${LANE_IMPERATIVE[assessment.lane]} ${row.path}`,
    summary: `From the NoticeOS saved page decision for ${asset.id}: ${assessment.label}. Original suggested step: ${assessment.action}`,
    applicabilityReview: recommendationHandoffCaveat(validity),
    priority: LANE_PRIORITY[assessment.lane],
  };
}

/** The cause as the evidence it points at. A cause is where to look first,
 * never proof of what happened. */
function causeLine(cause: PageDecisionCause): string {
  if (cause.kind === "ranking") return "ranking — average position moved by a full position or more";
  if (cause.kind === "demand") return "demand — impressions moved by a fifth or more";
  if (cause.kind === "release") {
    return `the release recorded ${cause.at}${cause.note ? ` (“${cause.note}”)` : ""}; ranking and impressions held`;
  }
  return "the result page — ranking and impressions held while click-through moved";
}

/** The lane as an order, not a category — a task title is a thing to do. */
const LANE_IMPERATIVE: Record<PageDecisionLane, string> = {
  act: "Act on",
  investigate: "Investigate",
  protect: "Protect",
  wait: "Hold",
};

/** `bd` priority, 0 highest. Acting and protecting are both time-sensitive: one
 * is losable ground, the other is holdable ground. */
const LANE_PRIORITY: Record<PageDecisionLane, number> = {
  act: 1,
  protect: 1,
  investigate: 2,
  wait: 3,
};

function positionPair(row: SearchPageMover): string {
  if (row.currentPosition === null) return "not reported";
  const previous =
    row.previousPosition === null
      ? "not reported"
      : row.previousPosition.toFixed(1);
  const movement =
    row.positionImprovement === null
      ? ""
      : row.positionImprovement > 0
        ? ` (${row.positionImprovement.toFixed(1)} positions better)`
        : row.positionImprovement < 0
          ? ` (${Math.abs(row.positionImprovement).toFixed(1)} positions worse)`
          : " (unchanged)";
  return `${previous} → ${row.currentPosition.toFixed(1)}${movement}`;
}

function signedPercent(value: number): string {
  if (value > 0) return `+${formatPercent(value)}%`;
  return `${formatPercent(value)}%`;
}

function signedInt(value: number): string {
  if (value > 0) return `+${formatInt(value)}`;
  return formatInt(value);
}

function laneLabel(lane: PageDecisionLane): string {
  if (lane === "act") return "Act next";
  if (lane === "investigate") return "Investigate";
  if (lane === "protect") return "Protect";
  return "Wait";
}
