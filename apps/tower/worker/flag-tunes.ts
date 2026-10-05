// THE RECORD PER TUNE — writing it and reading it
// (bead `ro-6d1t`, `noticeos.flag_tunes`).
//
// WHAT IT ADDS. `flags.disposition_note` records THAT an alert was tuned and
// WHICH setting last moved (bead `ro-bkcl`); a second tune on the same row
// overwrites the first note, so "the operator has tuned this rule five times
// this quarter" had no answer. `flag_tunes` is one row per tune, which makes
// that a count instead of a guess.
//
// `noticeos.flag_tunes` is written in the same transaction as the disposition
// it records (`flag-actions.ts`), so a tune and its row land together.

import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import type { TunedSetting } from "../shared/tune";

/**
 * Who a tune is recorded as. The Tower is single-operator and unauthenticated
 * on the LAN (docs/10), so there is exactly one honest name — the same value and
 * the same reasoning as `config-route.ts`'s `CONFIG_ACTOR`, and an audit row
 * that invented a more specific one would be fiction.
 */
export const TUNE_ACTOR = "operator";

/**
 * File one tune, inside the transaction that dispositions its alert.
 *
 * ONE ROW PER DECISION. The caller passes the flag the operator acted FROM, not
 * every row the disposition touched: a grouped rule writes its disposition onto
 * every open firing of the same condition at once (`flag-actions.ts`), which is
 * exactly why the false-positive counts are counts of alerts and have to say so.
 * These rows are counts of decisions, and that is the grain the question "how
 * many times" is asked at.
 */
export async function recordFlagTune(
  tx: Transaction,
  entry: {
    /** The alert's identity in the store (the tune references it). */
    flagId: bigint;
    ruleId: string;
    tuned: TunedSetting;
    tunedAt: string;
    actor?: string;
  },
): Promise<void> {
  await tx.execute(
    `INSERT INTO noticeos.flag_tunes (workspace_id, flag_id, rule_id, setting, value_from, value_to, tuned_at, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)`,
    [
      tx.workspaceId,
      entry.flagId,
      entry.ruleId,
      entry.tuned.setting,
      entry.tuned.from,
      entry.tuned.to,
      entry.tunedAt,
      entry.actor ?? TUNE_ACTOR,
    ],
  );
}

/**
 * How many tunes each rule has recorded since `since`.
 *
 * A MAP RATHER THAN A COLUMN ON THE COUNTS QUERY, because the two are different
 * questions over different tables and a LEFT JOIN would have made the tune
 * counts depend on a rule having fired inside the window — a rule tuned in
 * March and quiet since would then read as never tuned, which is the opposite of
 * what a tune record is for.
 *
 * The window is on `tuned_at`: "five times this quarter" is a question about the
 * operator's quarter, where the false-positive rate's window is on `fired_at`
 * and is a question about the rule's.
 */
export async function loadFlagTuneCounts(
  store: WorkspaceStore,
  since: string,
): Promise<Map<string, number>> {
  const rows = await store.read((tx) =>
    tx.query<{ ruleId: string; tunes: number }>(
      `SELECT rule_id AS "ruleId", count(*)::int AS tunes
         FROM noticeos.flag_tunes
        WHERE tuned_at >= $1::timestamptz
        GROUP BY rule_id`,
      [since],
    ),
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.ruleId === "string") counts.set(row.ruleId, Number(row.tunes) || 0);
  }
  return counts;
}
