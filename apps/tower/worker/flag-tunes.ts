// One row per tune in `noticeos.flag_tunes` (a disposition note keeps only the
// last), written in the same transaction as the disposition it records.

import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import type { TunedSetting } from "../shared/tune";

/** The standalone Tower has one unauthenticated operator, so one honest name. */
export const TUNE_ACTOR = "operator";

/** One row per decision: the caller passes the flag the operator acted from,
 * not every firing a grouped disposition touched. */
export async function recordFlagTune(
  tx: Transaction,
  entry: {
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

/** Tunes per rule since `since`, windowed on `tuned_at` and kept apart from
 * the firing counts so a rule tuned but quiet since still reads as tuned. */
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
