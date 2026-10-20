// Each site's newest insight reading and recent code reports, reduced to the
// few facts a Wall card carries: one statement per source across every site.
// A site with nothing stored is absent from the map, never a row of zeros.

import { CODEBASE_COMPARISON_MAX_DAYS, daysBetween, pickComparisonReport } from "@noticeos/contract/codebase-measures";
import type { WorkspaceStore } from "@noticeos/postgres";
import type { ProductFunnel, ProductSnapshot, WebVitalRating } from "../shared/asset-detail";
import { funnelStepLabel, segmentRating } from "../shared/product";
import { parseProductSnapshot } from "../shared/product-snapshot";
import type {
  CardChannelRow,
  CardChannels,
  CardCheckState,
  CardCodebase,
  CardFinding,
  CardFunnelDrop,
  CardProduct,
} from "../shared/wall";
import { parseMeasures } from "./codebase-history";

/** Each site's newest snapshot, by the order the store keeps two by
 * (`noticeos.insight_snapshot_is_kept`), with only the blocks a card reads. */
export const CARD_INSIGHTS_SQL = `SELECT a.asset_id AS asset,
       json_build_object('schemaVersion', p.payload -> 'schemaVersion', 'asset', p.payload -> 'asset',
                         'items', p.payload -> 'items', 'suppressedItems', p.payload -> 'suppressedItems',
                         'product', p.payload -> 'product', 'channels', p.payload -> 'channels')::text AS reading
  FROM noticeos.assets a
 CROSS JOIN LATERAL (
       SELECT q.payload
         FROM noticeos.asset_insight_snapshots q
        WHERE q.workspace_id = a.workspace_id AND q.asset_id = a.asset_id
        ORDER BY q.generated_at DESC, q.created_at DESC, q.snapshot_id DESC
        LIMIT 1) p`;

/** Each site's newest current report and every earlier one it could be
 * compared with, oldest first. `$1` the comparison's widest span in days. */
export const CARD_CODEBASE_SQL = `SELECT r.asset_id AS asset, r.report_date::text AS date, r.commit,
       (r.envelope -> 'measures')::text AS measures
  FROM noticeos.assets a
 CROSS JOIN LATERAL (
       SELECT max(n.report_date) AS newest
         FROM noticeos.codebase_reports n
        WHERE n.workspace_id = a.workspace_id AND n.asset_id = a.asset_id) l
  JOIN noticeos.current_codebase_reports r
    ON r.workspace_id = a.workspace_id AND r.asset_id = a.asset_id
   AND r.report_date >= l.newest - $1::int
 ORDER BY r.asset_id, r.report_date ASC`;

export interface CardInsightReading {
  product: CardProduct | null;
  channels: CardChannels | null;
  findings: CardFinding[];
}

const FINDING_KINDS = ["warning", "recommendation", "discovery", "insight"];
const RATING_ORDER: readonly WebVitalRating[] = ["good", "needs-improvement", "poor"];
/** The most channel rows a card carries; a producer gone wrong cannot widen the payload. */
const CHANNEL_ROW_LIMIT = 20;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function finding(value: unknown): CardFinding | null {
  const raw = obj(value);
  const key = text(raw?.key);
  const kind = text(raw?.kind);
  const title = text(raw?.title);
  return key && kind && title && FINDING_KINDS.includes(kind) ? { key, kind, title } : null;
}

/** The shown findings, then the ones the display cut set aside; one row per key. */
function findingsOf(items: unknown[], suppressed: unknown): CardFinding[] {
  const seen = new Set<string>();
  return [...items, ...(Array.isArray(suppressed) ? suppressed : [])].flatMap((value) => {
    const row = finding(value);
    if (!row || seen.has(row.key)) return [];
    seen.add(row.key);
    return [row];
  });
}

function checkState(product: ProductSnapshot, key: string): CardCheckState {
  return product.checks.find((check) => check.key === key)?.state ?? "not-collected";
}

function worstSpeedOf(product: ProductSnapshot): WebVitalRating | null {
  let worst: WebVitalRating | null = null;
  for (const segment of product.vitals?.segments ?? []) {
    const rating = segmentRating(segment);
    if (rating && (worst === null || RATING_ORDER.indexOf(rating) > RATING_ORDER.indexOf(worst))) worst = rating;
  }
  return worst;
}

/** The block's people count when the producer states one; a window with no
 * exceptions at all is a counted zero; anything else was not counted, since
 * people per message overlap and never add. */
function errorPeopleOf(raw: unknown, product: ProductSnapshot): number | null {
  const people = obj(obj(raw)?.exceptions)?.people;
  if (typeof people === "number" && Number.isSafeInteger(people) && people >= 0) return people;
  const exceptions = product.exceptions;
  return exceptions && exceptions.total === 0 && exceptions.noise === null && exceptions.top.length === 0 ? 0 : null;
}

function dropOf(funnel: ProductFunnel): CardFunnelDrop | null {
  const drop = funnel.largestDrop;
  if (!drop) return null;
  const from = funnel.steps.find((step) => step.step === drop.fromStep);
  const to = funnel.steps.find((step) => step.step === drop.toStep);
  if (!from || !to) return null;
  return {
    fromStep: funnelStepLabel(from),
    toStep: funnelStepLabel(to),
    lostPeople: drop.lostPeople,
    stepConversion: drop.stepConversion,
  };
}

/** The declared funnel losing the most people at one step; a funnel without a
 * readable drop ranks below every one with. */
function funnelOf(product: ProductSnapshot): CardProduct["funnel"] {
  let best: CardProduct["funnel"] = null;
  for (const funnel of product.funnels) {
    const largestDrop = dropOf(funnel);
    const lost = largestDrop?.lostPeople ?? -1;
    if (best === null || lost > (best.largestDrop?.lostPeople ?? -1)) {
      const steps = [...funnel.steps].sort((a, b) => a.step - b.step).map((step) => ({ label: funnelStepLabel(step), people: step.people }));
      best = { name: funnel.name, largestDrop, steps };
    }
  }
  return best;
}

function cardProduct(raw: unknown, findings: readonly CardFinding[]): CardProduct | null {
  const product = parseProductSnapshot(raw);
  if (!product) return null;
  return {
    observedAt: product.observedAt,
    speed: checkState(product, "posthog-slow-segment"),
    worstSpeed: worstSpeedOf(product),
    errors: checkState(product, "posthog-error-concentration"),
    errorPeople: errorPeopleOf(raw, product),
    jsErrorFinding: findings.some((row) => row.key === "javascript-errors"),
    funnel: funnelOf(product),
  };
}

function channelRow(value: unknown): CardChannelRow | null {
  const raw = obj(value);
  const channel = text(raw?.channel);
  const sessions = raw?.sessions;
  const share = raw?.share;
  if (!channel || typeof sessions !== "number" || !Number.isFinite(sessions) || sessions < 0) return null;
  if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) return null;
  return { channel, sessions, share };
}

/** The channel split, or null when the block is absent, has no window, or no
 * row survives; one malformed row costs itself. */
function cardChannels(value: unknown): CardChannels | null {
  const raw = obj(value);
  const windowStart = text(raw?.windowStart);
  const windowEnd = text(raw?.windowEnd);
  if (!raw || !windowStart || !windowEnd || windowStart > windowEnd || !Array.isArray(raw.rows)) return null;
  const rows = raw.rows.flatMap((row) => {
    const parsed = channelRow(row);
    return parsed ? [parsed] : [];
  }).slice(0, CHANNEL_ROW_LIMIT);
  return rows.length ? { windowStart, windowEnd, rows } : null;
}

/** Every site's newest insight reading as its card reads it. A snapshot that
 * fails the executive snapshot's gate (version, owner, findings list) is no
 * reading at all. */
export async function loadCardInsights(store: WorkspaceStore): Promise<Map<string, CardInsightReading>> {
  const rows = await store.read((tx) => tx.query<{ asset: string; reading: string }>(CARD_INSIGHTS_SQL));
  const out = new Map<string, CardInsightReading>();
  for (const row of rows) {
    const reading = obj(parseJson(row.reading));
    if (!reading || reading.schemaVersion !== 1 || reading.asset !== row.asset || !Array.isArray(reading.items)) continue;
    const findings = findingsOf(reading.items, reading.suppressedItems);
    out.set(row.asset, {
      product: cardProduct(reading.product, findings),
      channels: cardChannels(reading.channels),
      findings,
    });
  }
  return out;
}

/** Every site's newest code report against its 30-day comparison. */
export async function loadCardCodebases(store: WorkspaceStore): Promise<Map<string, CardCodebase>> {
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; date: string; commit: string; measures: string | null }>(CARD_CODEBASE_SQL, [
      CODEBASE_COMPARISON_MAX_DAYS,
    ]),
  );
  const bySite = new Map<string, { reportDate: string; commit: string; codeLines: number | null }[]>();
  for (const row of rows) {
    const reports = bySite.get(row.asset) ?? [];
    reports.push({
      reportDate: row.date,
      commit: row.commit.trim(),
      codeLines: parseMeasures(parseJson(row.measures)).code_lines ?? null,
    });
    bySite.set(row.asset, reports);
  }
  const out = new Map<string, CardCodebase>();
  for (const [asset, reports] of bySite) {
    const newest = reports.at(-1)!;
    const comparison = pickComparisonReport(newest.reportDate, reports.slice(0, -1));
    const before = comparison?.codeLines ?? null;
    const growth = newest.codeLines !== null && before !== null && before > 0
      ? Math.round(((newest.codeLines - before) / before) * 1000) / 10
      : null;
    out.set(asset, {
      date: newest.reportDate,
      commit: newest.commit,
      codeLines: newest.codeLines,
      growthPercent30d: growth,
      comparedDays: comparison ? daysBetween(comparison.reportDate, newest.reportDate) : null,
    });
  }
  return out;
}
