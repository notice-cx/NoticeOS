import type {
  AssetInfo,
  DataForSeoQueryVisibilityRow,
  SearchQueryMover,
  SearchQueryProviderTrend,
  SearchQueryTrends,
} from "@shared/asset-detail";
import { formatInt, formatPercent } from "@/lib/format";
import { taskHandoffSection } from "@/lib/task-handoff";
import { recommendationHandoffCaveat, type RecommendationValidity } from "@shared/recommendation-validity";

type QueryDecisionLane = "act" | "investigate" | "protect" | "wait";

export interface QueryDecisionMarkdownRow {
  query: string;
  /** The normalized query — `decisions.key` for kind `query`, and the label
   * that joins the filed bead back to the operator's recorded decision. */
  key?: string;
  google: SearchQueryMover | null;
  bing: SearchQueryMover | null;
  dataforseo: DataForSeoQueryVisibilityRow | null;
}

export interface QueryDecisionMarkdownAssessment {
  lane: QueryDecisionLane;
  /** The decision kind — the rule id the filed bead carries. */
  kind?: string;
  /** What the evidence says. */
  label: string;
  /** What to do: one short imperative (bead `ro-ujb9.96.6.5`). The evidence
   * section below is the why; there is no rationale paragraph. */
  action: string;
}

export function queryDecisionMarkdown({
  row,
  assessment,
  trends,
  asset,
  validity,
}: {
  row: QueryDecisionMarkdownRow;
  assessment: QueryDecisionMarkdownAssessment;
  trends: SearchQueryTrends;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  validity?: RecommendationValidity;
}): string {
  const propertyIdentity = asset.domain
    ? `${asset.displayName} (\`${asset.domain}\`)`
    : `${asset.displayName} (\`${asset.id}\`)`;
  const evidence = [
    ...(row.dataforseo && trends.dataforseo
      ? dataForSeoMarkdown(row.dataforseo, trends.dataforseo)
      : []),
    ...(row.google && trends.google
      ? providerEvidenceMarkdown("Google", row.google, trends.google)
      : []),
    ...(row.bing && trends.bing
      ? providerEvidenceMarkdown("Bing", row.bing, trends.bing)
      : []),
  ];
  const sourceLimits = [
    ...(row.dataforseo && trends.dataforseo
      ? [
          `- **DataForSEO (\`${trends.dataforseo.source}\`):** ${trends.dataforseo.caveat}`,
        ]
      : []),
    ...(row.google && trends.google
      ? [
          `- **Google (\`${trends.google.source}\`):** ${trends.google.caveat}`,
        ]
      : []),
    ...(row.bing && trends.bing
      ? [`- **Bing (\`${trends.bing.source}\`):** ${trends.bing.caveat}`]
      : []),
  ];

  return [
    `# Query decision: ${row.query}`,
    "",
    `- **Site:** ${propertyIdentity}`,
    `- **What to do:** ${laneLabel(assessment.lane)}`,
    `- **Decision:** ${assessment.label}`,
    `- **Ranking page:** ${rankingPageLabel(row)}`,
    `- **Applicability review:** ${recommendationHandoffCaveat(validity)}`,
    "",
    "## Suggested next step",
    "",
    assessment.action,
    "",
    "## Evidence",
    "",
    ...evidence,
    "## Source context and limitations",
    "",
    "- **Do not combine the units:** Google/Bing impressions are observed site exposure; DataForSEO searches/month are modelled market demand.",
    ...sourceLimits,
    "- **Decision limit:** This is deterministic triage, not a guaranteed SEO outcome. Inspect the current page, index state, and live search results before editing.",
    "",
    ...taskHandoffSection(queryTaskHandoff({ row, assessment, asset, validity })),
  ].join("\n");
}

/**
 * The bead this decision becomes in the asset's own repo. `null` when the row
 * carries no usable key — an unkeyed row still hands off its evidence, it just
 * cannot name the task the work files under.
 *
 * EXPORTED since bead `ro-l1ed.4`, because two things now file this bead: the
 * copied `bd create` an agent runs, and the row's **File task** button. One
 * description of the bead, read twice — a second literal in the component would
 * be free to drift from the command sitting under it in the same Markdown.
 */
export function queryTaskHandoff({
  row,
  assessment,
  asset,
  validity,
}: {
  row: QueryDecisionMarkdownRow;
  assessment: QueryDecisionMarkdownAssessment;
  asset: Pick<AssetInfo, "id" | "displayName" | "domain">;
  validity?: RecommendationValidity;
}) {
  const key = (row.key ?? row.query).trim().toLocaleLowerCase("en-US");
  if (!key) return null;
  return {
    asset: asset.id,
    kind: "query" as const,
    key,
    rule: assessment.kind || assessment.lane,
    // Typographic quotes, as the copy toast uses: a query containing its own
    // straight quotes would otherwise read as three nested pairs.
    title: `${LANE_IMPERATIVE[assessment.lane]} “${row.query.trim()}”`,
    summary: `From the NoticeOS saved query decision for ${asset.id}: ${assessment.label}. Original suggested step: ${assessment.action}`,
    applicabilityReview: recommendationHandoffCaveat(validity),
    priority: LANE_PRIORITY[assessment.lane],
  };
}

/** The lane as an order, not a category — a task title is a thing to do. */
const LANE_IMPERATIVE: Record<QueryDecisionLane, string> = {
  act: "Act on",
  investigate: "Investigate",
  protect: "Protect",
  wait: "Hold",
};

/** `bd` priority, 0 highest. Acting and protecting are both time-sensitive:
 * one is losable ground, the other is holdable ground. */
const LANE_PRIORITY: Record<QueryDecisionLane, number> = {
  act: 1,
  protect: 1,
  investigate: 2,
  wait: 3,
};

function dataForSeoMarkdown(
  row: DataForSeoQueryVisibilityRow,
  snapshot: NonNullable<SearchQueryTrends["dataforseo"]>,
): string[] {
  return [
    `### DataForSEO snapshot · ${snapshot.observedAt}`,
    "",
    `- **Estimated searches/month:** ${formatInt(row.monthlySearches)}`,
    `- **Current Google organic position:** ${
      row.organicPosition === null
        ? "No result in snapshot"
        : `#${formatInt(row.organicPosition)}`
    }`,
    ...(row.previousOrganicPosition !== null
      ? [
          `- **Previous locally stored position:** #${formatInt(row.previousOrganicPosition)}`,
        ]
      : []),
    ...(row.positionImprovement !== null
      ? [
          `- **Stored-snapshot position change:** ${positionMovementLabel(row.positionImprovement)}`,
        ]
      : []),
    `- **Keyword difficulty:** ${
      row.keywordDifficulty === null
        ? "Unavailable"
        : formatInt(row.keywordDifficulty)
    }`,
    ...(row.estimatedVisits !== null
      ? [`- **Estimated visits:** ${formatInt(row.estimatedVisits)}`]
      : []),
    `- **Ranking page:** ${row.page || "(not set)"}`,
    ...(row.intent ? [`- **Provider intent:** ${row.intent}`] : []),
    `- **AI Overview (weekly ranking inventory):** ${aiOverviewLabel(row)}`,
    // Only where the tracked panel actually read a result page for this term.
    // An untracked query says nothing here rather than saying "no overview" —
    // the whole point of the distinction is that it survives the handoff.
    ...(row.aioDevices.length > 0 ? [`- **Tracked SERP panel:** ${trackedPanelLabel(row)}`] : []),
    "",
  ];
}

/** Per device, because the surfaces are the finding (bead `ro-14d.1`): an
 * overview can consume the click on the phone and be absent on the desktop, and
 * a handoff that folded them would hand someone one page's worth of a two-page
 * observation.
 *
 * The surface is NAMED only where the panel read more than one — a device
 * column that never varies is noise, and a single-device panel's line reads
 * exactly as it did before the split. */
function trackedPanelLabel(row: DataForSeoQueryVisibilityRow): string {
  const named = row.aioDevices.length > 1;
  return row.aioDevices
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

/** The surface as the operator names it (doc 17): never the lane's `mobile`. */
function deviceNoun(device: string): string {
  if (device === "mobile") return "Phone";
  if (device === "desktop") return "Desktop";
  return device.charAt(0).toUpperCase() + device.slice(1);
}

function providerEvidenceMarkdown(
  label: "Google" | "Bing",
  mover: SearchQueryMover,
  trend: SearchQueryProviderTrend,
): string[] {
  return [
    `### ${label} observed comparison`,
    "",
    `- **Current window:** ${trend.currentStart} to ${trend.currentEnd}`,
    `- **Previous window:** ${trend.previousStart} to ${trend.previousEnd}`,
    `- **Reports per window:** ${formatInt(trend.daysPerWindow)}`,
    `- **Current impressions:** ${formatInt(mover.currentImpressions)}`,
    `- **Previous impressions:** ${formatInt(mover.previousImpressions)}`,
    `- **Impression change:** ${signedPercent(mover.impressionDeltaPercent)} (${signedInt(mover.impressionDelta)})`,
    `- **Current average position:** ${mover.currentPosition.toFixed(1)}`,
    `- **Previous average position:** ${mover.previousPosition.toFixed(1)}`,
    `- **Average-position change:** ${positionMovementLabel(mover.positionImprovement)}`,
    // What the lane states about its own series before it ranked anything. It
    // travels with the copy for the same reason it renders on the page: the
    // bead this Markdown becomes must be able to show that the
    // grounding-exclusion check ran, including when it excluded nothing.
    ...trend.evidence.map(
      (row) =>
        `- **${row.label}:** ${row.value}${row.detail ? ` — ${row.detail}` : ""}`,
    ),
    "",
  ];
}

function rankingPageLabel(row: QueryDecisionMarkdownRow): string {
  const page = row.dataforseo?.page;
  return page && page !== "(not set)" ? page : "Unknown from current evidence";
}

function aiOverviewLabel(row: DataForSeoQueryVisibilityRow): string {
  if (row.aiOverview === "cited") {
    return row.aiCitationPosition === null
      ? "Site cited"
      : `Site cited at source position #${formatInt(row.aiCitationPosition)}`;
  }
  if (row.aiOverview === "present") {
    return "Overview present; site not cited";
  }
  return "No AI Overview in snapshot";
}

function positionMovementLabel(improvement: number): string {
  if (improvement > 0) return `${improvement.toFixed(1)} positions better`;
  if (improvement < 0) {
    return `${Math.abs(improvement).toFixed(1)} positions worse`;
  }
  return "Unchanged";
}

function signedPercent(value: number): string {
  if (value > 0) return `+${formatPercent(value)}%`;
  return `${formatPercent(value)}%`;
}

function signedInt(value: number): string {
  if (value > 0) return `+${formatInt(value)}`;
  return formatInt(value);
}

function laneLabel(lane: QueryDecisionLane): string {
  if (lane === "act") return "Act next";
  if (lane === "investigate") return "Investigate";
  if (lane === "protect") return "Protect";
  return "Wait";
}
