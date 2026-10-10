// GET /api/provider-spend?period=YYYY-MM: what the metered lanes spent, from
// the cost recorded on each call's manifest (`noticeos.archive_runs.cost_usd`),
// per property per month, which `scripts/cost-import.mjs` books as an `api`
// cost row. Read-only: the booking is a separate, idempotent POST.

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
      // Grouped by report date, not by when the run finished: a sweep that
      // lands after midnight spent its money on the day it asked. Unknown
      // prices leave the known-dollar subtotal unchanged and remain visible.
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
