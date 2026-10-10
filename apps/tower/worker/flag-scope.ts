// What "open" means for an alert, written once so every count agrees (a snooze
// is a disposition that ends). A helper that asks about time takes the caller's
// placeholder for its clock (`$2::timestamptz`) rather than the store's `now()`,
// so a test can move time and prove a snooze expires.

// The three states live in `@noticeos/contract` because ingest's nightly alert
// rollup counts open flags too.
import { openFlagsSql, settledAtSql, settledFlagsSql, snoozedFlagsSql } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { TUNE_CARRIED_MARK } from "../shared/tune";

export { openFlagsSql, settledAtSql, settledFlagsSql, snoozedFlagsSql };

function prefix(alias: string): string {
  return alias ? `${alias}.` : "";
}

/**
 * Was this row ever tuned, whatever its state now: the false-positive rate's
 * numerator (a tune later marked read is still a tune). Composed from the same
 * `TUNE_CARRIED_MARK` as `shared/tune.ts`'s `wasTuned`, so the count and the
 * chip agree. Inlining the mark into SQL is safe only because it holds no quote
 * character (pinned in `test/flag-actions.test.ts`).
 */
export function everTunedSql(alias = ""): string {
  const p = prefix(alias);
  return `(${p}disposition = 'tune'
           OR (${p}disposition_note IS NOT NULL
               AND strpos(${p}disposition_note, '${TUNE_CARRIED_MARK}') > 0))`;
}

/** When each alert was first sent to the operator's channel, keyed by workspace
 * number. A row means a message landed; absence claims nothing either way. */
export async function loadNotifiedAt(
  store: WorkspaceStore,
  flagIds: readonly number[],
): Promise<Map<number, string>> {
  if (flagIds.length === 0) return new Map();
  const rows = await store.read((tx) =>
    tx.query<{ subjectRef: string; sentAt: string }>(
      `SELECT subject_ref AS "subjectRef", min(sent_at) AS "sentAt"
         FROM noticeos.notifications
        WHERE subject = 'alert'
          AND subject_ref = ANY($1::text[])
        GROUP BY subject_ref`,
      [flagIds.map((id) => String(id))],
    ),
  );
  return new Map(rows.map((row) => [Number(row.subjectRef), javascriptInstant(row.sentAt)]));
}
