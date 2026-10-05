// GET /api/provider-spend?period=YYYY-MM — what the metered lanes actually spent.
//
// The OS records the cost of every provider call on the manifest of the call
// that spent it (`noticeos.archive_runs.cost_usd`), per (property, family).
// That is the one cost in this portfolio nobody has to state: it is measured.
//
// WHAT IT WAS MISSING. The budget gate read those rows to fail closed before the
// monthly cap, and nothing else ever did — so the ROI ledger, which exists to
// answer "did this property earn more than it cost", was missing the only cost
// the OS measures precisely (ro-kukv.4). This route is the rollup that closes
// it: one read, per property, per month, which `scripts/cost-import.mjs` books
// as an `api` cost row.
//
// READ-ONLY. It derives nothing and writes nothing — the booking is a separate,
// idempotent POST, so a rollup can be inspected before it becomes accounting.

import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';

type SpendRow = {
  asset: string;
  integration: string;
  /** Exact, as the store sums it. */
  costUsd: string;
  runs: number;
  unknownPrices: number;
};

const PERIOD = /^\d{4}-\d{2}$/;

export async function handleProviderSpend(
  request: Request,
  env: IngestEnv,
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const period = new URL(request.url).searchParams.get('period');
  if (period === null || !PERIOD.test(period)) {
    return json(
      { error: 'invalid_request', detail: 'period must be YYYY-MM' },
      422,
    );
  }

  const rows = await env.STORE.read((tx) =>
    tx.query<SpendRow>(
      // Grouped by REPORT DATE, not by when the run finished: a Monday sweep
      // that starts at 23:58 and lands after midnight spent its money on the
      // day it asked, and the manifest's report_date is that day. Billing a
      // call to the month its HTTP response arrived in would move spend across
      // a month boundary twice a year for no reason anybody could reconstruct.
      // Unknown prices leave the known-dollar subtotal unchanged and remain visible.
      `SELECT asset_id AS asset,
              integration,
              COALESCE(SUM(cost_usd), 0)::text AS "costUsd",
              count(*) FILTER (WHERE cost_usd > 0)::int AS runs,
              count(*) FILTER (WHERE cost_state = 'unknown')::int AS "unknownPrices"
         FROM noticeos.archive_runs
        WHERE to_char(report_date, 'YYYY-MM') = $1
          AND (cost_usd > 0 OR cost_state = 'unknown')
        GROUP BY asset_id, integration
        ORDER BY asset_id COLLATE "C", integration COLLATE "C"`,
      [period],
    ),
  );

  const total = rows.reduce((sum, row) => sum + (Number(row.costUsd) || 0), 0);
  return json({
    period,
    // Rounded to cents for the caller that books it; the raw sum stays available
    // because a provider's own invoice is the thing this is reconciled against.
    totalUsd: Math.round(total * 100) / 100,
    unknownPrices: rows.reduce((sum, row) => sum + row.unknownPrices, 0),
    byAsset: rows.map((row) => ({
      asset: row.asset,
      integration: row.integration,
      costUsd: Math.round((Number(row.costUsd) || 0) * 100) / 100,
      runs: row.runs,
      unknownPrices: row.unknownPrices,
    })),
  });
}
