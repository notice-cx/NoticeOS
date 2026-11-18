// What the portfolio has spent on metered data: one definition, read by the
// collector's cap gate and by every operator surface, so the number that fails
// the portfolio closed is the number the operator reads.
//
// Spend is money the provider account was billed, not what the OS collected:
// ad-hoc research spends the same account. Earlier report runs keep their
// archived prices. New provider bills are dated per request, and the covered
// portion of a report is excluded from the archive subtotal.

/** One read transaction's statements, as this sum needs them. */
export interface MeteredSpendQuery {
  query<R extends Record<string, unknown>>(sql: string, params?: readonly (string | number)[]): Promise<R[]>;
}

/** The store a call reads: `@noticeos/postgres`'s `WorkspaceStore` satisfies
 * it structurally. */
export interface MeteredSpendStore {
  read<T>(work: (tx: MeteredSpendQuery) => Promise<T>): Promise<T>;
}

/** The one provider the portfolio pays per call. Named once so a typo cannot
 * create a spend category the cap gate skips. */
export const METERED_DATA_PROVIDER = 'dataforseo';

/** The actor the weekly collector records itself as. Its research rows are
 * already counted from its report runs, so summing both would double-bill. */
export const RESEARCH_COLLECTOR_ACTOR = 'collector';

/** How the store keeps a provider cost: US dollars beside a state
 * (`cost_usd`, `cost_state` on archive_runs and research_log). A positive
 * figure is reported. A zero from the metered provider is a price the writer
 * could not read, so it is unknown and stores no figure; a zero elsewhere is
 * reported. An unknown cost contributes nothing to the sum. */
export function storedProviderCost(
  integration: string,
  usd: number,
): { usd: number | null; state: 'reported' | 'unknown' } {
  if (Number.isFinite(usd) && usd > 0) return { usd, state: 'reported' };
  return integration === METERED_DATA_PROVIDER ? { usd: null, state: 'unknown' } : { usd: 0, state: 'reported' };
}

/** The accounting periods the sum can be asked for: the UTC calendar month the
 * cap is written in, or the UTC calendar day a pace is stated against. */
export type MeteredSpendWindow = 'month' | 'day';

/** One asset's share of the window. */
export interface MeteredSpendAsset {
  asset: string;
  spentUsd: number;
  unknownPrices: number;
}

export interface MeteredDataSpend {
  /** The billed total: the sum of `byAsset` plus `unattributedUsd`, never a
   * second aggregate over the same rows. */
  spentUsd: number;
  /** Unpriced calls stay outside the cap's known-dollar subtotal. */
  unknownPrices: number;
  /** Biggest spender first, asset id as the tiebreak. Includes an asset with
   * unknown-priced calls even when its known-dollar subtotal is zero. */
  byAsset: MeteredSpendAsset[];
  /** Research bought about no property — a market scan. `research_log.asset_id`
   * is nullable (a sentinel asset id would join into every per-property read
   * model), so the money is carried here rather than invented onto an asset. */
  unattributedUsd: number;
  unattributedUnknownPrices: number;
}
export interface MeteredBudgetAvailability {
  /** Held by requests whose provider price is still unconfirmed. */
  heldUsd: number;
  /** The portion of the monthly cap available for additional purchases. */
  availableUsd: number;
}
export type MeteredSpendRow = { asset: string | null; spent: string; unknown: number | string };

/** The instant the window opens, ISO UTC — the same string both tables compare
 * their timestamp column against, so one call cannot window two ways. */
export function meteredSpendSince(
  now: Date | string,
  window: MeteredSpendWindow = 'month',
): string {
  const iso = typeof now === 'string' ? now : now.toISOString();
  return window === 'day'
    ? `${iso.slice(0, 10)}T00:00:00.000Z`
    : `${iso.slice(0, 7)}-01T00:00:00.000Z`;
}

export function meteredSpendBounds(now: Date | string, window: MeteredSpendWindow = 'month'): [string, string] {
  const since = meteredSpendSince(now, window);
  const next = new Date(since);
  if (window === 'day') next.setUTCDate(next.getUTCDate() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return [since, next.toISOString()];
}

/** Only the portion of a report's cost without an individual receipt. */
export const METERED_ARCHIVE_COST = 'cost_usd - dataforseo_cost_accounted_usd';

// Archive and log totals exclude charges counted directly from request rows.
// Keep money in Postgres numeric through the comparison and the subtraction.
const METERED_COSTS_SQL = `
  SELECT asset_id AS asset, sum(${METERED_ARCHIVE_COST}) AS spent, 0::numeric AS held,
         count(*) FILTER (WHERE cost_state = 'unknown') AS unknown
    FROM noticeos.archive_runs
   WHERE integration=$1 AND requested_at >= $2::timestamptz AND requested_at < $3::timestamptz
   GROUP BY asset_id
  UNION ALL
  SELECT asset_id, sum(provider_cost_usd), sum(reserve_usd) FILTER (WHERE provider_cost_usd IS NULL), 0
    FROM noticeos.dataforseo_request_charges
   WHERE reserved_at >= $2::timestamptz AND reserved_at < $3::timestamptz
   GROUP BY asset_id
  UNION ALL
  SELECT asset_id, sum(cost_usd), 0::numeric, count(*) FILTER (WHERE cost_state = 'unknown')
    FROM noticeos.research_log
   WHERE provider=$1 AND bought_at >= $2::timestamptz AND bought_at < $3::timestamptz AND actor <> $4
   GROUP BY asset_id`;

/** The balance used by both the collector and the Tower. Append a projection
 * from `budget` using {@link meteredBudgetParams} as the first six arguments. */
export const METERED_BUDGET_SQL = `WITH costs AS (${METERED_COSTS_SQL}), saved AS (
  SELECT CASE WHEN jsonb_typeof(body::jsonb #> '{monthly_caps,data_usd}') = 'number'
    THEN (body::jsonb #>> '{monthly_caps,data_usd}')::numeric END AS cap
  FROM noticeos.config_documents WHERE document_key='constants'
), budget AS (
  SELECT coalesce(sum(spent), 0) AS spent, coalesce(sum(held), 0) AS held,
    least($5::numeric, CASE WHEN $6::boolean THEN coalesce((SELECT cap FROM saved), 0)
      ELSE (SELECT cap FROM saved) END) AS cap
  FROM costs
)`;

function meteredCostParams(now: Date | string, window: MeteredSpendWindow = 'month') {
  return [METERED_DATA_PROVIDER, ...meteredSpendBounds(now, window), RESEARCH_COLLECTOR_ACTOR];
}

export function meteredBudgetParams(now: Date | string, capUsd: number, requireSavedCap: boolean) {
  return [...meteredCostParams(now), capUsd, String(requireSavedCap)];
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Metered data spend over one window, per asset and in total. Reads
 * `requested_at` / `bought_at`, not a completion stamp: a call is billed when
 * it is made. Each half's sum is exact in the store (`numeric`) and becomes a
 * number here.
 */
export async function loadMeteredDataSpend(
  store: MeteredSpendStore,
  now: Date | string,
  window: MeteredSpendWindow = 'month',
): Promise<MeteredDataSpend> {
  const rows = await store.read(tx => tx.query<MeteredSpendRow>(
    `SELECT asset, coalesce(spent, 0)::text AS spent, unknown::text FROM (${METERED_COSTS_SQL}) costs`, meteredCostParams(now, window),
  ));
  return summarizeMeteredDataSpend(rows);
}

export async function loadMeteredDataBudget(store: MeteredSpendStore, now: Date | string, capUsd: number, requireSavedCap = false) {
  const [balance] = await store.read(tx => tx.query<{
    spent: string; held: string; available: string; cap: string; rows: string;
  }>(`${METERED_BUDGET_SQL}
    SELECT spent::text, held::text, greatest(0, cap-spent-held)::text AS available, cap::text,
           coalesce((SELECT json_agg(items) FROM (
             SELECT asset, coalesce(spent, 0)::text AS spent, unknown::text FROM costs
           ) items), '[]'::json)::text AS rows
    FROM budget`, meteredBudgetParams(now, capUsd, requireSavedCap)));
  if (!balance) throw new Error('The data budget is unavailable.');
  const rows = JSON.parse(balance.rows) as MeteredSpendRow[];
  return { ...summarizeMeteredDataSpend(rows), spentUsd: Number(balance.spent), capUsd: Number(balance.cap),
    budget: { heldUsd: Number(balance.held), availableUsd: Number(balance.available) } satisfies MeteredBudgetAvailability };
}

export function summarizeMeteredDataSpend(rows: readonly MeteredSpendRow[]): MeteredDataSpend {
  const perAsset = new Map<string, MeteredSpendAsset>();
  let unattributedUsd = 0;
  let unattributedUnknownPrices = 0;
  for (const row of rows) {
    const spent = finite(row.spent);
    const unknownPrices = finite(row.unknown);
    if (spent === 0 && unknownPrices === 0) continue;
    // A manifest row always names its asset; a research row need not. Money
    // without one is portfolio-level and is stated as such rather than dropped.
    if (row.asset) {
      const asset = perAsset.get(row.asset) ?? { asset: row.asset, spentUsd: 0, unknownPrices: 0 };
      asset.spentUsd += spent;
      asset.unknownPrices += unknownPrices;
      perAsset.set(row.asset, asset);
    } else {
      unattributedUsd += spent;
      unattributedUnknownPrices += unknownPrices;
    }
  }

  const byAsset = [...perAsset.values()]
    .sort((a, b) => b.spentUsd - a.spentUsd || a.asset.localeCompare(b.asset));

  return {
    spentUsd: byAsset.reduce((total, row) => total + row.spentUsd, 0) + unattributedUsd,
    unknownPrices: byAsset.reduce((total, row) => total + row.unknownPrices, 0) + unattributedUnknownPrices,
    byAsset,
    unattributedUsd,
    unattributedUnknownPrices,
  };
}
