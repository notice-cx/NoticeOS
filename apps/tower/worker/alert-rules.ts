// GET /api/alerts/rules — what each alert rule has actually cost, per rule_id
// over the last quarter (bead `ro-ayxy`, docs/15 flow E).
//
// WHY IT IS ITS OWN READ AND NOT A FIELD ON `/api/settings`. The settings
// payload is a PURE builder over the injected config and says so at the top of
// its own file: nothing on that page is evidence, so an empty database — or a
// down one — must not be able to blank the page an operator opens to fix
// things. Folding a store read into it would trade that guarantee for one
// section's figures. It would also be the wrong shape for the second consumer:
// the Tune panel opens from an alert row on the Wall and the asset page, where
// `/settings` is not loaded, and it needs ONE rule's figure rather than the
// whole portfolio-wide settings payload.
//
// SO THE SPLIT IS: config on `/api/settings`, evidence here, and the settings
// page reads both. A section that cannot reach this read still renders its
// editable fields, which is the behaviour the pure builder was protecting.
//
// READ-ONLY, like every other `/api/alerts/*` read. Dispositions are written by
// `flag-actions.ts` and stay there.

import {
  ALERT_RULE_WINDOW_DAYS,
  type AlertRuleStat,
  type AlertRuleStatsPayload,
} from "../shared/alert-rules";
import type { WorkspaceStore } from "@noticeos/postgres";
import { everTunedSql, settledFlagsSql } from "./flag-scope";
import { loadFlagTuneCounts } from "./flag-tunes";
import { JSON_HEADERS, jsonError } from "./http";

/**
 * SETTLED, composed from the one module that defines the three alert states
 * (`@noticeos/contract`'s `flag-open.ts`) rather than spelled out again here.
 *
 * It matters more here than anywhere: this read is the denominator of a number
 * the OS will eventually propose rule changes from, and a second hand-written
 * opinion about what "finished with" means would put the false-positive rate and
 * the alert queue on different books. A snoozed alert is not in it (bead
 * `ro-ujb9.194`): nobody has answered it yet, only put it off.
 */
const SETTLED = settledFlagsSql();

/**
 * THE NUMERATOR IS "was ever tuned", not "says tune right now" (bead
 * `ro-bkcl`).
 *
 * `disposition` is one slot, so an alert the operator tuned AND then marked
 * read used to count as read and nothing else — the tune vanished from the very
 * measurement it exists to feed, and it vanished specifically for the operator
 * who did both halves of the job. The record now survives in the note behind
 * `shared/tune.ts`'s mark, and this is the predicate that reads it, composed
 * from `worker/flag-scope.ts` so the count and the row's chip cannot disagree.
 *
 * ONE CONSEQUENCE, ON PURPOSE: `tuned` and `acknowledged` no longer partition
 * the settled rows. A row that was tuned and then marked read is in both, and
 * has to be — it is one alert that carries two true facts. Nothing sums these
 * four fields, and `tuneShare` divides `tuned` by `settled`, never by a total
 * of the buckets.
 */
const EVER_TUNED = everTunedSql();

const DAY_MS = 86_400_000;

/**
 * The counts, in ONE round trip.
 *
 * The settled predicate is evaluated ONCE in a subquery and reduced to a 1/0
 * column the outer aggregate reads five different ways. Repeating it in each
 * `SUM(CASE …)` would be five copies of the same clause to keep in step.
 *
 * One bind: the window's start. Settled needs no clock — no date moves an
 * alert into or out of it (`flag-open.ts`). On Postgres (bead ro-ujb9.76.5.2),
 * over `current_flags`: an alert a same-day report retry replaced is none, as
 * D1 had deleted it.
 *
 * The window is on `fired_at` — WHEN THE RULE FIRED, not when the alert was
 * closed. A rule judged on the alerts it produced this quarter is the question;
 * an alert from six months ago that the operator only got round to yesterday
 * would otherwise land in a quarter it says nothing about.
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

  // HOW MANY TIMES, from its own table (bead `ro-6d1t`). Separate from the
  // counts above because it is a different question over different rows: those
  // count ALERTS this rule produced inside the window, this counts DECISIONS the
  // operator made about the rule inside it. `null` is the store saying it cannot
  // answer — `flag_tunes` is an operator-applied migration — and it travels as
  // null all the way to the surface rather than collapsing into a zero.
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

/**
 * The route. GET only, and unauthenticated for the same reason every other
 * `/api/*` read here is: identical evidence, one trust boundary
 * (`worker/index.ts`).
 */
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
