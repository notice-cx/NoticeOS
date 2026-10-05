// WHAT "OPEN" MEANS, in one place (`ro-c7qq`).
//
// Six queries across four modules decided for themselves that an open alert is
// `resolved_at IS NULL AND disposition IS NULL`. That was true while every
// disposition was permanent. Snooze is not: it is a disposition with an END,
// and the moment one of those six copies had learned about it and the others
// had not, the Home card, the `/alerts` page, the asset hero and the Wall's
// rail would have been counting different portfolios.
//
// So the predicate is written once, here, and every reader composes it. The
// alerts are on Postgres (`noticeos.current_flags`, bead ro-ujb9.76.5.2): a
// helper that asks about time takes the caller's placeholder for its clock
// (`$2::timestamptz`), and the caller binds its ISO `now` there.
//
// `now` is a bound parameter rather than the store's own `now()` on purpose:
// every payload builder already takes the clock as an argument, and a test
// that cannot move time cannot prove that a snooze expires.

// The three states — open, snoozed, settled — live in `@noticeos/contract`
// (beads `ro-78qo.36`, `ro-ujb9.194`): the ingest Worker's nightly alert rollup
// counts open flags too, and it is a separate build that cannot import this
// module. Re-exported here so every caller keeps importing the alert
// vocabulary from the module that owns it.
import { openFlagsSql, settledAtSql, settledFlagsSql, snoozedFlagsSql } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { TUNE_CARRIED_MARK } from "../shared/tune";

export { openFlagsSql, settledAtSql, settledFlagsSql, snoozedFlagsSql };

function prefix(alias: string): string {
  return alias ? `${alias}.` : "";
}

/**
 * WAS THIS ROW EVER TUNED — in SQL, and here for the same reason the open
 * predicate is (bead `ro-bkcl`).
 *
 * It is not a second open-ness predicate and it does not compose with one: a
 * tuned row can be open, parked, read or resolved. It is here because this is
 * the module that turns the alert vocabulary into alert predicates, and the
 * false-positive rate's numerator is now this rather than `disposition =
 * 'tune'` — a tune the operator later marks read is still a tune.
 *
 * The browser-side half is `shared/tune.ts`'s `wasTuned`, and both are composed
 * from the same `TUNE_CARRIED_MARK`, so the count and the chip cannot disagree
 * about which rows were tuned. The mark carries no quote character (pinned in
 * `test/flag-actions.test.ts`), which is what makes inlining it into SQL text
 * safe; it is a module constant and never operator input.
 *
 * Takes no `now`, unlike its neighbours — it asks nothing about time.
 */
export function everTunedSql(alias = ""): string {
  const p = prefix(alias);
  return `(${p}disposition = 'tune'
           OR (${p}disposition_note IS NOT NULL
               AND strpos(${p}disposition_note, '${TUNE_CARRIED_MARK}') > 0))`;
}

// --- what the operator has already been told (bead `ro-vu8d.23`) ------------

/**
 * WHEN EACH OF THESE ALERTS WAS SENT TO THE OPERATOR'S CHANNEL, or nothing.
 *
 * A SEPARATE READ, deliberately, rather than a column on `FLAG_COLUMNS`: it is
 * what the notifier recorded (`noticeos.notifications`, bead ro-ujb9.76.5.2),
 * keyed by each alert's workspace number, and the same shape
 * `GET /api/alerts/rules` takes for the false-positive rate.
 *
 * An empty map is what "nobody has been told" looks like, and that is correct:
 * the row means a message ACTUALLY LANDED, so its absence never claims
 * anything either way.
 */
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
