// GET /api/alerts/rules — what each alert rule has actually cost over the last
// quarter. Read-only, and separate from `/api/settings` so a down store cannot
// blank the settings page, and so the Tune panel can ask for one rule.

import {
  ALERT_RULE_WINDOW_DAYS,
  type AlertRuleStat,
  type AlertRuleStatsPayload,
} from "../shared/alert-rules";
import type { WorkspaceStore } from "@noticeos/postgres";
import { everTunedSql, settledFlagsSql } from "./flag-scope";
import { loadFlagTuneCounts } from "./flag-tunes";
import { JSON_HEADERS, jsonError } from "./http";

/** Settled, from the one module that defines the alert states, so the
 * false-positive rate and the alert queue agree. A snoozed alert is not
 * settled. */
const SETTLED = settledFlagsSql();

/**
 * The numerator is "was ever tuned", not "says tune right now". So `tuned` and
 * `acknowledged` do not partition the settled rows: a row tuned then marked
 * read is in both. Nothing sums the buckets; `tuneShare` divides `tuned` by
 * `settled`.
 */
const EVER_TUNED = everTunedSql();

const DAY_MS = 86_400_000;

/**
 * The counts in one round trip; the settled predicate is evaluated once and
 * reduced to a 1/0 column. One bind, the window's start: settled needs no
 * clock. Over `current_flags`, so an alert a same-day report retry replaced is
 * not counted. The window is on `fired_at`: a rule is judged on the alerts it
 * produced this quarter, not on when they were closed.
 */
const COUNTS_SQL = `
  SELECT rule_id AS "ruleId",
         COUNT(*)::int AS fired,
         SUM(settled)::int AS settled,
         SUM(CASE WHEN settled = 1 AND ever_tuned = 1 THEN 1 ELSE 0 END)::int AS tuned,
         SUM(CASE WHEN settled = 0 AND ever_tuned = 1 THEN 1 ELSE 0 END)::int AS "tunedOpen",
         SUM(CASE WHEN settled = 1 AND disposition = 'ack' THEN 1 ELSE 0 END)::int AS acknowledged,
         SUM(CASE WHEN settled = 1 AND disposition IS NULL AND resolved_at IS NOT NULL
                  THEN 1 ELSE 0 END)::int AS resolved
    FROM (SELECT rule_id,
                 disposition,
                 resolved_at,
                 CASE WHEN ${SETTLED} THEN 1 ELSE 0 END AS settled,
                 CASE WHEN ${EVER_TUNED} THEN 1 ELSE 0 END AS ever_tuned
            FROM noticeos.current_flags
           WHERE fired_at >= $1::timestamptz) AS alerts
   GROUP BY rule_id
   ORDER BY fired DESC, rule_id COLLATE "C" ASC`;

type CountsRow = {
  ruleId: string;
  fired: number;
  settled: number;
  tuned: number;
  tunedOpen: number;
  acknowledged: number;
  resolved: number;
};

export interface AlertRuleStatsDeps {
  now: Date;
}

export async function buildAlertRuleStatsPayload(
  store: WorkspaceStore,
  deps: AlertRuleStatsDeps,
): Promise<AlertRuleStatsPayload> {
  const windowDays = ALERT_RULE_WINDOW_DAYS;
  const since = new Date(deps.now.getTime() - windowDays * DAY_MS).toISOString();

  const rows = await store.read((tx) => tx.query<CountsRow>(COUNTS_SQL, [since]));

  // Tune decisions, from their own table: those above count alerts, these
  // count decisions. `null` means the store cannot answer and stays null to the
  // surface rather than becoming a zero.
  const tunes = await loadFlagTuneCounts(store, since);

  return {
    generatedAt: deps.now.toISOString(),
    windowDays,
    since,
    // The store hands back whatever the SUMs produced; the contract says
    // integers, and a NULL from an empty group would render as an empty cell
    // rather than the zero it means.
    rules: rows.map(
      (row): AlertRuleStat => ({
        ruleId: row.ruleId,
        fired: count(row.fired),
        settled: count(row.settled),
        tuned: count(row.tuned),
        tunedOpen: count(row.tunedOpen),
        acknowledged: count(row.acknowledged),
        resolved: count(row.resolved),
        tunes: tunes.get(row.ruleId) ?? 0,
      }),
    ),
  };
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** GET only; admitted like every other `/api/*` read (`worker/index.ts`). */
export async function handleAlertRuleStatsRequest(
  request: Request,
  store: WorkspaceStore,
  deps: AlertRuleStatsDeps,
): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  try {
    const payload = await buildAlertRuleStatsPayload(store, deps);
    return Response.json(payload, { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: "alert_rule_stats_failed", message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
