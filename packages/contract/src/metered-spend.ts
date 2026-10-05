// WHAT THE PORTFOLIO HAS SPENT ON METERED DATA — one definition, two Workers.
//
// The number that FAILS THE PORTFOLIO CLOSED and the number the operator READS
// have to be the same number. They were not (bead `ro-ukus`). The collector's
// cap gate summed `signal_dump_runs` PLUS `research_log` — ad-hoc DataForSEO
// research spends the same account, and bead `ro-cda6.3` taught the gate to see
// it. The Tower's reader summed `signal_dump_runs` alone, so `/health`,
// `/settings`' budget meter, the provider card's budget line and the Wall's
// daily pace all UNDER-REPORTED, which is the one direction a budget display
// must not err in: the desk could read comfortably under the cap on a month the
// collector then refused to spend in.
//
// Two copies of a sum are a licence to disagree, so this is the only copy. It
// lives in the contract for the same reason the panel's prices moved here
// (`ro-x5gu.4`): both Workers already depend on it, and neither owns a fact the
// other has to trust.
//
// WHAT COUNTS AS SPEND: money the DataForSEO account was BILLED, not "what the
// OS collected". Those two readings differ by exactly the ad-hoc research, and
// the cap is written against an invoice.
//
// THE TWO HALVES ARE DISJOINT BY CONSTRUCTION. The provider report runs carry
// every call the weekly collector made; the paid lookups the collector wrote
// for itself are excluded by actor, so a collected family is never billed
// twice. Both are on Postgres (`noticeos.archive_runs`, `noticeos.research_log`,
// bead ro-ujb9.76.5.4), read in one transaction, so the two halves are of one
// moment.

/** One read transaction's statements, as this sum needs them. */
export interface MeteredSpendQuery {
  query<R extends Record<string, unknown>>(sql: string, params?: readonly (string | number)[]): Promise<R[]>;
}

/** The store a call reads: `@noticeos/postgres`'s `WorkspaceStore` satisfies
 * it structurally, in both Workers, which is what lets one body run in both. */
export interface MeteredSpendStore {
  read<T>(work: (tx: MeteredSpendQuery) => Promise<T>): Promise<T>;
}

/** The one provider the portfolio pays per call. Written here rather than at
 * each call site so a typo cannot create a spend category the cap gate skips —
 * the same reason `research_log.provider` must name a known integration. */
export const METERED_DATA_PROVIDER = 'dataforseo';

/** The actor the weekly collector records itself as. Its research rows are
 * already counted from its report runs, so summing both would double-bill
 * the portfolio into a cap breach that never happened. */
export const RESEARCH_COLLECTOR_ACTOR = 'collector';

/** How the store keeps a provider cost: US dollars beside a state
 * (`cost_usd`, `cost_state` on archive_runs and research_log). A positive figure
 * is reported. A zero from the metered provider is the price the writer could
 * not read, so it is unknown and stores no figure; a zero elsewhere is reported.
 * An unknown cost contributes nothing to the current sum. Distinguishing a free
 * call from an unpriced one at the writer is tracked by ro-ujb9.75. */
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
   * second aggregate over the same rows. A headline a reader cannot add up
   * to from the split beneath it is the defect bead `ro-4cm` closed. */
  spentUsd: number;
  /** Unpriced calls stay outside the cap's known-dollar subtotal. */
  unknownPrices: number;
  /** Biggest spender first, asset id as the tiebreak. Includes an asset with
   * unknown-priced calls even when its known-dollar subtotal is zero. */
  byAsset: MeteredSpendAsset[];
  /** Research bought about no property — a market scan, a competitor nobody
   * owns yet. `research_log.asset_id` is nullable on purpose (a sentinel
   * asset id would join into every per-property read model as a ghost), so the
   * money is carried here rather than invented onto an asset. */
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
 * Metered data spend over one window, per asset and in total.
 *
 * Reads `requested_at` / `bought_at`, not a completion stamp: a call is billed
 * when it is MADE, and the (integration, requested_at) index makes exactly this
 * the cheap query. Each half's sum is exact in the store (`numeric`) and
 * becomes a number here, where D1 added floats.
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
    // A manifest row always names its asset; a research row need not. Anything
    // without one is portfolio-level money and is stated as such rather than
    // dropped — a total the split cannot reach is the same lie as an undercount.
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
