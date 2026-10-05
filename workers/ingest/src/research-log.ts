// The research log — what the OS has already paid a provider to answer.
//
// The weekly collector cannot buy the same answer twice: every family carries a
// cadence and the freshness filter proves the last landing from durable
// manifests before it spends. Ad-hoc research had no such memory. The
// `dataforseo` skill's callers, scratchpad copies of them, and anything an agent
// runs against the same credentials all spend from one account, and until this
// module the QUESTION was recorded nowhere — so the same read could be bought in
// three sessions across three weeks and nothing noticed.
//
// Not even the cap gate, which is the sharper half. Month-to-date spend summed
// the collector's report runs alone, so it was an UNDERCOUNT of real DataForSEO
// spend by exactly the ad-hoc research nobody recorded — a gate that fails the
// portfolio closed before $25 reading a number it had no right to trust. This
// log is now the second half of that sum, and the sum itself lives in one place
// both the gate and the desk's meters read: `loadMeteredDataSpend` in
// `@noticeos/contract` (bead `ro-ukus`).
//
// The grain is the QUESTION and it points at the ANSWER; it never stores one.
// See db/migrations/0025_research_log.sql for why. On Postgres
// (`noticeos.research_log`, bead ro-ujb9.76.5.4) a purchase is numbered in its
// workspace, and its price is kept with its state (`storedProviderCost`).

import { storedProviderCost } from '@noticeos/contract';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';

export const RESEARCH_PROVIDERS = ['dataforseo'] as const;
export type ResearchProvider = (typeof RESEARCH_PROVIDERS)[number];

/**
 * How long a bought answer stays reusable.
 *
 * Thirty days is open-seo's number, and it is right for the reason they do not
 * state: it is the shortest window that spans a full monthly cycle of the data
 * underneath. DataForSEO's keyword and SERP-competitor datasets refresh on a
 * roughly monthly cadence, so a question re-asked inside it is answered from the
 * same underlying snapshot the first call paid for — the provider would hand
 * back the same rows and charge again.
 *
 * It is a DEFAULT, not a rule. A caller that knows its question is more volatile
 * (a live SERP, which changes hourly) passes a shorter window; the log answers
 * whatever it is asked. What it must never do is pick a window on the caller's
 * behalf and stay quiet about it.
 */
export const RESEARCH_REUSE_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface ResearchPurchase {
  asset: string | null;
  provider: ResearchProvider;
  /** Provider path without the API base — see the migration for why. */
  endpoint: string;
  /** The request body as sent. Hashed here; never stored. */
  params: unknown;
  question: string;
  costUsd: number;
  /** R2 key of the archived response, when the caller archived one. */
  objectKey?: string | null;
  /** 'collector', or the agent/operator handle that spent the money. */
  actor: string;
}

export interface PriorResearch {
  asset: string | null;
  endpoint: string;
  question: string;
  costUsd: number;
  objectKey: string | null;
  actor: string;
  boughtAt: string;
  /** Whole days since it was bought — what a caller states when it reuses. */
  ageDays: number;
}

/**
 * Canonical JSON: object keys sorted at every depth, so two spellings of one
 * request hash the same.
 *
 * ARRAYS ARE NOT SORTED, deliberately. `["volume,desc"]` and `["volume,asc"]`
 * are different questions, and so are two different keyword lists — order is
 * meaning in a provider request body, and a canonicaliser that sorted arrays
 * would collide questions that genuinely differ. Only KEY order is noise.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absence, and JSON.stringify drops it. Dropping it here too
    // keeps `{a:1}` and `{a:1,b:undefined}` the same question.
    .filter(([, v]) => v !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

export async function researchParamsHash(params: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(params));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Has this exact question been bought recently, and where is the answer?
 *
 * Returns the newest row inside the window, or null. It never decides anything:
 * the caller reuses or re-buys, and either way says which out loud. A hit that
 * silently suppressed a call would be indistinguishable from a caller that
 * forgot to make one.
 */
export async function findPriorResearch(
  store: WorkspaceStore,
  query: {
    provider: ResearchProvider;
    endpoint: string;
    params: unknown;
    nowMs?: number;
    windowDays?: number;
  },
): Promise<PriorResearch | null> {
  const nowMs = query.nowMs ?? Date.now();
  const windowDays = query.windowDays ?? RESEARCH_REUSE_WINDOW_DAYS;
  const cutoff = new Date(nowMs - windowDays * MS_PER_DAY).toISOString();
  const hash = await researchParamsHash(query.params);
  // The newest purchase inside the window; of two at one instant, the one
  // written last. An unknown price reads as the 0 it was recorded as.
  const [found] = await store.read((tx) =>
    tx.query<{
      asset: string | null;
      endpoint: string;
      question: string;
      costUsd: string;
      objectKey: string | null;
      actor: string;
      boughtAt: string;
    }>(
      `SELECT asset_id AS asset, endpoint, question, COALESCE(cost_usd, 0)::text AS "costUsd",
              object_key AS "objectKey", actor, bought_at AS "boughtAt"
         FROM noticeos.research_log
        WHERE provider = $1 AND endpoint = $2 AND params_sha256 = $3
          AND bought_at >= $4::timestamptz
        ORDER BY bought_at DESC, research_id DESC
        LIMIT 1`,
      [query.provider, query.endpoint, hash, cutoff],
    ),
  );
  if (!found) return null;
  const row = { ...found, costUsd: Number(found.costUsd), boughtAt: javascriptInstant(found.boughtAt) };
  const boughtMs = Date.parse(row.boughtAt);
  return {
    ...row,
    // An unparseable stamp must not read as "bought today" and win a reuse it
    // did not earn. NaN floors to 0 through Math.max, so it is clamped to the
    // other end: treated as ancient, and the caller re-buys.
    ageDays: Number.isFinite(boughtMs)
      ? Math.floor((nowMs - boughtMs) / MS_PER_DAY)
      : windowDays,
  };
}

/** Record a paid call. Every path that spends provider money writes one. */
export async function recordResearch(
  store: WorkspaceStore,
  purchase: ResearchPurchase,
  nowMs: number = Date.now(),
): Promise<void> {
  const hash = await researchParamsHash(purchase.params);
  // A negative, zero or unreadable cost is recorded as an unknown price rather
  // than rejected: the purchase HAPPENED, and losing the row to keep the number
  // tidy would lose the spend evidence too.
  const cost = storedProviderCost(purchase.provider, purchase.costUsd);
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.research_log
         (workspace_id, asset_id, provider, endpoint, params_sha256, question,
          cost_usd, cost_state, object_key, actor, bought_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11::timestamptz)`,
      [
        tx.workspaceId,
        purchase.asset,
        purchase.provider,
        purchase.endpoint,
        hash,
        purchase.question,
        cost.usd,
        cost.state,
        purchase.objectKey ?? null,
        purchase.actor,
        new Date(nowMs).toISOString(),
      ],
    ),
  );
}

/**
 * The actor the collector records itself as.
 *
 * Re-exported rather than declared: the exclusion it drives lives beside the
 * one metered-spend sum in `@noticeos/contract` (`loadMeteredDataSpend`),
 * which is what the cap gate and every desk meter read. A copy here would be a
 * second spelling of the word that decides whether a dollar is billed twice.
 */
export { RESEARCH_COLLECTOR_ACTOR as COLLECTOR_ACTOR } from '@noticeos/contract';
