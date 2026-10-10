// What the portfolio has spent on metered data: one definition, read by the
// collector's cap gate and by every operator surface, so the number that fails
// the portfolio closed is the number the operator reads.
//
// Spend is money the provider account was billed, not what the OS collected:
// ad-hoc research spends the same account. The two halves are disjoint: the
// report runs carry every call the weekly collector made, and the collector's
// own research rows are excluded by actor, so a collected family is never
// billed twice. Both are read in one transaction.

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
  const since = meteredSpendSince(now, window);

  type Spent = { asset: string | null; spent: string; unknown: number };
  const [collected, research] = await store.read(async (tx) => [
    await tx.query<Spent>(
      `SELECT asset_id AS asset, COALESCE(SUM(cost_usd), 0)::text AS spent,
              count(*) FILTER (WHERE cost_state = 'unknown')::int AS unknown
         FROM noticeos.archive_runs
        WHERE integration = $1 AND requested_at >= $2::timestamptz
        GROUP BY asset_id`,
      [METERED_DATA_PROVIDER, since],
    ),
    await tx.query<Spent>(
      `SELECT asset_id AS asset, COALESCE(SUM(cost_usd), 0)::text AS spent,
              count(*) FILTER (WHERE cost_state = 'unknown')::int AS unknown
         FROM noticeos.research_log
        WHERE provider = $1 AND bought_at >= $2::timestamptz AND actor <> $3
        GROUP BY asset_id`,
      [METERED_DATA_PROVIDER, since, RESEARCH_COLLECTOR_ACTOR],
    ),
  ]);

  const perAsset = new Map<string, MeteredSpendAsset>();
  let unattributedUsd = 0;
  let unattributedUnknownPrices = 0;
  for (const row of [...collected, ...research]) {
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
