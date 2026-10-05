// The Growth tab's Product section, as arithmetic (beads ro-ghis.2 / ro-ghis.3).
//
// "What do people do once they arrive, and where does it break?" The numbers
// come from the executive snapshot's `product` block; this module decides only
// how they are ORDERED and WORDED, so the component draws and never judges.

import type {
  ProductException,
  ProductExceptions,
  ProductFunnel,
  ProductSnapshot,
  ProductVitalSegment,
  WebVitalRating,
} from "./asset-detail";
import type { IntegrationState } from "./integrations";

/** What the empty section says. `connected` with no product block means the
 * first read has not landed yet; the other three are not a PostHog problem to
 * wait for. */
export type ProductConnection = "connected" | "not-connected" | "off";

/**
 * The asset's PostHog connection, read off its integration rows. A lane the
 * catalog does not list yet is "not connected" — which is exactly what an asset
 * whose PostHog key nobody has added is.
 */
export function productConnection(
  lanes: ReadonlyArray<{ catalog: { id: string }; cell: { effective: IntegrationState } }>,
): ProductConnection {
  const lane = lanes.find((candidate) => candidate.catalog.id === "posthog");
  if (!lane) return "not-connected";
  switch (lane.cell.effective) {
    case "live":
    case "degraded":
      return "connected";
    case "skipped":
    case "not-applicable":
      return "off";
    case "needs-setup":
      return "not-connected";
  }
}

export const RATING_WORDS: Record<WebVitalRating, string> = {
  good: "Good",
  "needs-improvement": "Needs improvement",
  poor: "Poor",
};

const RATING_RANK: Record<WebVitalRating, number> = { good: 0, "needs-improvement": 1, poor: 2 };

/** The worse of a segment's two judged metrics (LCP, INP), or null when
 * neither was measured. CLS is shown but does not decide the row. */
export function segmentRating(segment: ProductVitalSegment): WebVitalRating | null {
  const ratings = [segment.lcpRating, segment.inpRating].filter(
    (rating): rating is WebVitalRating => rating !== null,
  );
  if (ratings.length === 0) return null;
  return ratings.reduce((worst, rating) => (RATING_RANK[rating] > RATING_RANK[worst] ? rating : worst));
}

/** "Chrome OS Desktop", or the page itself when PostHog named no segment. */
export function segmentName(segment: ProductVitalSegment): string {
  return [segment.os, segment.device].filter(Boolean).join(" ") || "Every visitor";
}

/** The metric that misses its good line by more, against that line. */
export function segmentHeadline(
  segment: ProductVitalSegment,
  lines: { lcp: { good: number }; inp: { good: number } },
): { metric: "LCP" | "INP"; value: number } | null {
  const lcp = segment.lcpP75 === null ? null : segment.lcpP75 / lines.lcp.good;
  const inp = segment.inpP75 === null ? null : segment.inpP75 / lines.inp.good;
  if (lcp === null && inp === null) return null;
  if (inp !== null && (lcp === null || inp >= lcp)) return { metric: "INP", value: segment.inpP75! };
  return { metric: "LCP", value: segment.lcpP75! };
}

export function exceptionName(row: ProductException): string {
  const message = row.message ?? "(no message)";
  return row.type && !message.startsWith(row.type) ? `${row.type}: ${message}` : message;
}

/** One place something breaks, in the order the section lists them. */
export type ProductIssue =
  | { kind: "speed"; key: string; severity: "error" | "warn"; segment: ProductVitalSegment }
  | { kind: "rage"; key: string; severity: "warn"; cluster: NonNullable<ProductSnapshot["rageClicks"]>["clusters"][number] }
  | { kind: "error"; key: string; severity: "warn" | "info"; exception: ProductException }
  | { kind: "noise"; key: string; severity: "info"; exception: ProductException & { share: number }; total: number }
  | { kind: "once"; key: string; severity: "warn"; event: ProductSnapshot["onceEvents"][number] };

/** A message reaching this many people is worth fixing; below it, it is
 * listed without an alarm. */
export const ERROR_WARN_PEOPLE = 100;
/** Real errors named in the list; the rest stay in the snapshot. */
const ERROR_LIST_LIMIT = 3;

/**
 * Everything the product block says is broken, ordered for a three-row list.
 *
 * INTERLEAVED BY KIND. The first three rows are the worst slow segment, the
 * worst rage-click cluster and the most widespread real error — one of each —
 * because "where does it break" is answered by the spread of places, and three
 * slow segments of one page would hide a broken form under a second screen of
 * the same fact. The rest follow in the same rotation; probable third-party
 * noise goes last, because it is the one row that is not asking for a fix.
 */
export function productIssues(product: ProductSnapshot): ProductIssue[] {
  const speed: ProductIssue[] = (product.vitals?.segments ?? []).flatMap((segment, index) => {
    const rating = segmentRating(segment);
    if (rating === null || rating === "good") return [];
    return [{ kind: "speed" as const, key: `speed-${index}`, severity: rating === "poor" ? ("error" as const) : ("warn" as const), segment }];
  });
  const rage: ProductIssue[] = (product.rageClicks?.clusters ?? []).map((cluster, index) => ({
    kind: "rage" as const,
    key: `rage-${index}`,
    severity: "warn" as const,
    cluster,
  }));
  const exceptions: ProductExceptions | null = product.exceptions;
  const errors: ProductIssue[] = (exceptions?.top ?? []).slice(0, ERROR_LIST_LIMIT).map((exception, index) => ({
    kind: "error" as const,
    key: `error-${index}`,
    severity: exception.people >= ERROR_WARN_PEOPLE ? ("warn" as const) : ("info" as const),
    exception,
  }));
  const once: ProductIssue[] = product.onceEvents.map((event, index) => ({
    kind: "once" as const,
    key: `once-${index}`,
    severity: "warn" as const,
    event,
  }));

  const lanes = [speed, rage, errors, once];
  const ordered: ProductIssue[] = [];
  for (let round = 0; lanes.some((lane) => round < lane.length); round++) {
    for (const lane of lanes) {
      const issue = lane[round];
      if (issue) ordered.push(issue);
    }
  }
  if (exceptions?.noise) {
    ordered.push({ kind: "noise", key: "noise", severity: "info", exception: exceptions.noise, total: exceptions.total });
  }
  return ordered;
}

/** Where a group of findings lives: one page, the whole site (an event, or an
 * error PostHog could not place), or probable third-party noise. */
export type ProductIssuePlace =
  | { kind: "page"; path: string }
  | { kind: "site" }
  | { kind: "third-party" };

export interface ProductIssueGroup {
  key: string;
  place: ProductIssuePlace;
  /** The worst finding's severity: what ranks the group. */
  severity: ProductIssue["severity"];
  /** Most severe first; ties keep `productIssues`' rank. */
  issues: ProductIssue[];
}

const SEVERITY_RANK: Record<ProductIssue["severity"], number> = { error: 0, warn: 1, info: 2 };

function issuePlace(issue: ProductIssue): ProductIssuePlace {
  switch (issue.kind) {
    case "speed":
      return { kind: "page", path: issue.segment.path };
    case "rage":
      return { kind: "page", path: issue.cluster.path };
    case "error":
      return issue.exception.topPath ? { kind: "page", path: issue.exception.topPath } : { kind: "site" };
    case "once":
      return { kind: "site" };
    case "noise":
      return { kind: "third-party" };
  }
}

/**
 * THE SAME FINDINGS, GROUPED BY WHERE THEY HAPPEN (bead `ro-ujb9.96.6.5`).
 *
 * Five rows starting "/calculator · …" repeat one subject five times; grouped,
 * the page is said once and each row keeps only what differs. Groups are ranked
 * by their worst finding, then by where that page's first finding sits in
 * `productIssues`' interleaved rank — so the closed list, one row per group, is
 * still a spread of places rather than three rows about one page. Probable
 * third-party noise is its own group and always last: it is the one group not
 * asking for a fix.
 */
export function productIssueGroups(product: ProductSnapshot): ProductIssueGroup[] {
  const ranked = productIssues(product);
  const groups = new Map<string, { group: ProductIssueGroup; firstRank: number }>();
  ranked.forEach((issue, rank) => {
    const place = issuePlace(issue);
    const key = place.kind === "page" ? `page:${place.path}` : place.kind;
    const entry = groups.get(key) ?? { group: { key, place, severity: issue.severity, issues: [] }, firstRank: rank };
    entry.group.issues.push(issue);
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.group.severity]) entry.group.severity = issue.severity;
    groups.set(key, entry);
  });
  const rankOf = new Map(ranked.map((issue, rank) => [issue.key, rank]));
  return [...groups.values()]
    .map(({ group, firstRank }) => ({
      firstRank,
      group: {
        ...group,
        issues: [...group.issues].sort(
          (left, right) =>
            SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
            rankOf.get(left.key)! - rankOf.get(right.key)!,
        ),
      },
    }))
    .sort(
      (left, right) =>
        Number(left.group.place.kind === "third-party") - Number(right.group.place.kind === "third-party") ||
        SEVERITY_RANK[left.group.severity] - SEVERITY_RANK[right.group.severity] ||
        left.firstRank - right.firstRank,
    )
    .map(({ group }) => group);
}

/** Mean of the days that carry a value; null under three, the same floor every
 * other headline on the desk keeps. */
export function dailyMean(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 3) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

/** Sum of the days that carry a value; null under three. Page views and
 * sessions are events, so a total is honest; people are not (see `dailyMean`). */
export function dailyTotal(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 3) return null;
  return present.reduce((sum, value) => sum + value, 0);
}

/** The label a funnel step reads as. */
export function funnelStepLabel(step: { event: string; path: string | null }): string {
  if (step.event === "$pageview") return step.path ? `Viewed ${step.path}` : "Viewed a page";
  return step.path ? `${step.event} on ${step.path}` : step.event;
}

/** The movement of the largest-drop step against the same step one window
 * earlier, in percentage points; null when there is nothing to compare. */
export function funnelDropMovement(funnel: ProductFunnel): number | null {
  const now = funnel.largestDrop?.stepConversion ?? null;
  const before = funnel.prior?.stepConversion ?? null;
  return now === null || before === null ? null : (now - before) * 100;
}
