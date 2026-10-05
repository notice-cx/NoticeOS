import type { SqlValue, WorkspaceStore } from "@noticeos/postgres";
import { recordMutation, type MutationActor } from "@noticeos/postgres/mutation-audit";
import { TUNE_CARRIED_MARK, tuneNote, type TunedSetting } from "../shared/tune";
import { RECURRING_CONDITION_RULES } from "../shared/wall";
import { openFlagsSql, snoozedFlagsSql } from "./flag-scope";
import { recordFlagTune } from "./flag-tunes";

export type FlagAction = "acknowledge" | "resolve" | "snooze" | "unsnooze" | "tune";

/**
 * A NEW DECISION NEVER ERASES THE TUNE UNDER IT (bead `ro-bkcl`).
 *
 * `disposition` is one slot and a tuned alert deliberately stays OPEN
 * (`worker/flag-scope.ts`), so Mark read and Snooze were both landing on rows
 * that already said `tune` and overwriting the only record that a rule had been
 * noisy enough to change. Resolve never did — it writes `resolved_at` and
 * leaves the disposition alone — which is why the leak only ever showed on the
 * operator who both quietened the rule and cleared the alert.
 *
 * Migrations are operator-only and forever-forbidden here (AGENTS.md), so the
 * tune is carried in the note the row already has, behind
 * `shared/tune.ts`'s mark. The disposition slot keeps meaning what it always
 * meant: the operator's decision about the EVENT.
 *
 * IT IS EVALUATED PER ROW, not composed from the clicked one. A recurring
 * condition dispositions every open firing at once, and a group can hold a
 * tuned row beside one that fired last night and was never tuned — composing
 * the note in TypeScript from the target would stamp the untuned sibling as
 * tuned and inflate the very rate this fixes.
 *
 * Three cases, and the third is the one a hand-written `CASE` forgets: a row
 * already CARRYING a mark (tuned, then parked) keeps its tail when the snooze
 * ends, so unsnooze does not become the second way to lose a tune.
 */
function keepingTune(decisionNote: string): string {
  return `('${decisionNote}' || CASE
      WHEN disposition = 'tune' AND disposition_note IS NOT NULL
        THEN '${TUNE_CARRIED_MARK}' || disposition_note
      WHEN disposition_note IS NOT NULL
           AND strpos(disposition_note, '${TUNE_CARRIED_MARK}') > 0
        THEN substr(disposition_note, strpos(disposition_note, '${TUNE_CARRIED_MARK}'))
      ELSE ''
    END)`;
}

export interface FlagActionResult {
  id: number;
  asset: string;
  action: FlagAction;
  changedAt: string;
  /** When a snoozed condition comes back. Present for `snooze` and `unsnooze`
   * (which ends the snooze NOW, so it echoes `changedAt`), null otherwise. */
  snoozeUntil: string | null;
}

/**
 * Apply the operator actions that move a CONDITION in or out of the open
 * attention queue. The flag's evidence is never rewritten or deleted:
 *
 * - acknowledge = "I read this"; a later recurrence creates a new event.
 * - resolve = "the underlying issue is no longer active."
 * - snooze = "not now — bring it back on this date" (docs/15 flow E).
 * - unsnooze = "bring it back now."
 * - tune = "the rule that produced this was too loud, and here is what I
 *   changed" — the one disposition that does NOT move the row out of the
 *   attention queue (bead `ro-van6`). See `worker/flag-scope.ts`.
 *
 * A decision landing on a row that was already tuned KEEPS THE TUNE, carried in
 * the note (`keepingTune` below, bead `ro-bkcl`) — the alert's record of what
 * the operator did to the rule outlives what they then did with the firing.
 *
 * SNOOZE IS THE ONLY DISPOSITION THAT EXPIRES, and the whole design follows
 * from that. It writes `disposition='snooze'` plus the date, so the row leaves
 * every open list; when the date passes, `worker/flag-scope`'s one predicate
 * hands the SAME row back — same id, same evidence, same headline — rather than
 * the rule firing a new one. Unsnooze does not erase the disposition, it moves
 * the end date to now: one mechanism serves both "the clock ran out" and "I
 * changed my mind", and the row still records that it was quiet and until when.
 * Erasing it would make an operator's own decision the one event the store
 * forgets.
 *
 * ACTS ON THE WHOLE CONDITION, not one firing (`ro-kukv.1`). The band now shows
 * one row per condition, so the button under that row has to mean what the row
 * says. When the target's rule is one of `RECURRING_CONDITION_RULES`, every open
 * flag sharing its (asset, rule_id, metric) is dispositioned with it — otherwise
 * resolving one asset's 16-firing condition would clear one row and leave fifteen
 * identical ones behind, which is the failure the grouping exists to end.
 *
 * Undeclared rules are unaffected: their group is themselves, and the SQL below
 * still matches exactly one row. `watch-window-closed` fires twice on one
 * asset with one metric and asks two different questions — dispositioning
 * both from one click would answer a question the operator never read.
 */
export async function applyFlagAction(
  store: WorkspaceStore,
  /** The alert's workspace number — what the Tower shows and acts on
   * (bead ro-ujb9.76.5.2). */
  id: number,
  action: FlagAction,
  nowIso: string,
  /** Required for `snooze` — a validated ISO instant (see shared/snooze). */
  snoozeUntil: string | null = null,
  /** Required for `tune` — the setting that moved (see shared/tune). */
  tuned: TunedSetting | null = null,
  actor: MutationActor | null = null,
): Promise<FlagActionResult | null> {
  if (action === "snooze" && !snoozeUntil) return null;
  if (action === "tune" && !tuned) return null;

  // Which rows this action may touch at all. Every action but `unsnooze` needs
  // an OPEN condition; unsnooze needs the opposite — a live snooze — so the two
  // read their eligibility from the same module that defines the words.
  //
  // `tune` needs an open row that has NOT already been dispositioned something
  // else. It writes into the same one-decision-per-row slot ack and snooze use,
  // so without that arm a Save from a row that came back from a snooze would
  // erase the record of the silence — and the operator's own decision would be
  // the one event the store forgets. A row already tuned may be tuned again:
  // the panel holds three settings, and the second Save is the same decision
  // continued, not a different one.
  const eligible = (now: string) =>
    action === "unsnooze"
      ? snoozedFlagsSql("", now)
      : action === "tune"
        ? `(${openFlagsSql("", now)}) AND (disposition IS NULL OR disposition = 'tune')`
        : openFlagsSql("", now);

  // One transaction (bead ro-ujb9.76.5.2): the eligibility read, the
  // disposition and the tune's own row land together or not at all. An alert a
  // same-day report retry replaced is no alert (`current_flags`), so it is
  // never acted on.
  return store.write(async (tx) => {
    const [target] = await tx.query<{ flagId: bigint; id: number; asset: string; ruleId: string; metric: string | null }>(
      `SELECT flag_id AS "flagId", flag_number::int AS id, asset_id AS asset, rule_id AS "ruleId", metric
         FROM noticeos.current_flags
        WHERE flag_number = $1 AND ${eligible("$2::timestamptz")}`,
      [id, nowIso],
    );
    if (!target) return null;

    const grouped = RECURRING_CONDITION_RULES.has(target.ruleId);
    // The statement's parameters, numbered in the order they are bound.
    const values: SqlValue[] = [];
    const bind = (value: SqlValue, cast = ""): string => {
      values.push(value);
      return `$${values.length}${cast}`;
    };

    // The end of a snooze IS a date, so unsnooze stores one rather than a null:
    // "quiet until now" reads as "back", and needs no second column to say so.
    const endsAt = action === "unsnooze" ? nowIso : snoozeUntil;

    const setSql =
      action === "acknowledge"
        ? `SET disposition = 'ack',
               disposition_at = ${bind(nowIso, "::timestamptz")},
               disposition_note = ${keepingTune("Marked read by operator")},
               snooze_until = NULL,
               ack_expiry = NULL`
        : action === "resolve"
          ? `SET resolved_at = ${bind(nowIso, "::timestamptz")}`
          : action === "snooze"
            ? `SET disposition = 'snooze',
                   disposition_at = ${bind(nowIso, "::timestamptz")},
                   disposition_note = ${keepingTune("Snoozed by operator")},
                   snooze_until = ${bind(endsAt, "::timestamptz")},
                   ack_expiry = NULL`
            : action === "tune"
              ? // The changed setting IS the reason, so the note is composed from
                // it rather than typed — nothing free-text reaches the store, and
                // the words are the ones the field itself wears (`shared/tune`).
                `SET disposition = 'tune',
                     disposition_at = ${bind(nowIso, "::timestamptz")},
                     disposition_note = ${bind(tuneNote(tuned!))}`
              : `SET disposition_at = ${bind(nowIso, "::timestamptz")},
                   disposition_note = ${keepingTune("Snooze ended by operator")},
                   snooze_until = ${bind(endsAt, "::timestamptz")}`;

    // NULL never equals NULL in SQL, so a metric-less rule needs an IS NULL arm
    // rather than `metric = $n`; without it a grouped rule that stores no metric
    // would silently match nothing and disposition only the clicked row.
    const scope = grouped
      ? `asset_id = ${bind(target.asset)} AND rule_id = ${bind(target.ruleId)} AND ${
          target.metric === null ? "metric IS NULL" : `metric = ${bind(target.metric)}`
        }`
      : `flag_id = ${bind(target.flagId)}`;

    // The point of the grouped arm is that it updates SEVERAL rows, so the
    // statement returns every one it changed — a result that read as "one flag
    // changed" when sixteen did would be the failure the grouping ends.
    const changed = await tx.query<{ id: number }>(
      `UPDATE noticeos.flags
          ${setSql}
        WHERE ${scope} AND replaced_by_pulse_id IS NULL AND ${eligible(bind(nowIso, "::timestamptz"))}
        RETURNING flag_number::int AS id`,
      values,
    );
    if (changed.length === 0) return null;

    // AND THE TUNE IS ALSO ITS OWN ROW (bead `ro-6d1t`). The note above records
    // THAT this alert was tuned and which setting last moved; a second tune
    // overwrites it, so "tuned five times this quarter" was unanswerable.
    // `flag_tunes` is one row per tune, in the same transaction.
    //
    // ONE ROW, against the flag the operator acted FROM. A grouped rule writes
    // its disposition onto every open firing of the same condition at once,
    // which is why the false-positive counts are counts of ALERTS; a count of
    // TUNES has to be a count of decisions, and there was exactly one.
    if (action === "tune") {
      await recordFlagTune(tx, {
        flagId: target.flagId,
        ruleId: target.ruleId,
        tuned: tuned!,
        tunedAt: nowIso,
      });
    }

    await recordMutation(tx, actor, { event: `flag.${action}`, assetId: target.asset,
      subject: { flagNumber: target.id, changedCount: changed.length } });

    return {
      id: target.id,
      asset: target.asset,
      action,
      changedAt: nowIso,
      snoozeUntil: endsAt,
    };
  });
}
