// The research log: what the OS has already paid a provider to answer, so a
// question is not bought twice and ad-hoc research counts toward the one
// metered spend sum (`loadMeteredDataSpend` in `@noticeos/contract`). The grain
// is the question and it points at the answer; it never stores one.

import { storedProviderCost } from '@noticeos/contract';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';

export const RESEARCH_PROVIDERS = ['dataforseo'] as const;
export type ResearchProvider = (typeof RESEARCH_PROVIDERS)[number];

/**
 * How long a bought answer stays reusable: the shortest window spanning a full
 * refresh cycle of the provider's keyword and SERP datasets, so a re-ask inside
 * it would be answered from the same snapshot and charged again. A default: a
 * caller with a more volatile question passes a shorter window.
 */
export const RESEARCH_REUSE_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface ResearchPurchase {
  asset: string | null;
  provider: ResearchProvider;
  /** Provider path without the API base. */
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
 * request hash the same. Arrays are not sorted: order is meaning in a provider
 * request body.
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
 * The newest row inside the window, or null. It never decides anything: the
 * caller reuses or re-buys, and either way says which out loud.
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
 * Re-exported rather than declared: the exclusion it drives lives beside the
 * one metered-spend sum in `@noticeos/contract`.
 */
export { RESEARCH_COLLECTOR_ACTOR as COLLECTOR_ACTOR } from '@noticeos/contract';
