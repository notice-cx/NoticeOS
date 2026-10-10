import type { SqlValue, WorkspaceStore } from "@noticeos/postgres";
import { recordMutation, type MutationActor } from "@noticeos/postgres/mutation-audit";
import { TUNE_CARRIED_MARK, tuneNote, type TunedSetting } from "../shared/tune";
import { RECURRING_CONDITION_RULES } from "../shared/wall";
import { openFlagsSql, snoozedFlagsSql } from "./flag-scope";
import { recordFlagTune } from "./flag-tunes";

export type FlagAction = "acknowledge" | "resolve" | "snooze" | "unsnooze" | "tune";

/**
 * A new decision never erases the tune under it. `disposition` is one slot
 * and a tuned alert stays open (`worker/flag-scope.ts`), so the tune is
 * carried in the note behind `shared/tune.ts`'s mark, and the disposition
 * slot keeps holding the decision about the event. Evaluated per row, not
 * composed from the clicked one: a recurring condition dispositions every
 * open firing at once, and a group can hold a tuned row beside an untuned
 * one. Three cases, and the third is the one a hand-written `CASE` forgets:
 * a row already carrying a mark keeps its tail when the snooze ends.
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
 * Apply the operator actions that move a condition in or out of the open
 * attention queue. The flag's evidence is never rewritten or deleted:
 *
 * - acknowledge = "I read this"; a later recurrence creates a new event.
 * - resolve = "the underlying issue is no longer active."
 * - snooze = "not now — bring it back on this date."
 * - unsnooze = "bring it back now."
 * - tune = "the rule that produced this was too loud, and here is what I
 *   changed" — the one disposition that does not move the row out of the
 *   attention queue. See `worker/flag-scope.ts`.
 *
 * A decision landing on a row that was already tuned keeps the tune, carried
 * in the note (`keepingTune`). Snooze is the only disposition that expires:
 * it writes `disposition='snooze'` plus the date, and when the date passes
 * `worker/flag-scope`'s one predicate hands the same row back. Unsnooze moves
 * the end date to now rather than erasing the disposition.
 *
 * Acts on the whole condition, not one firing: when the target's rule is one
 * of `RECURRING_CONDITION_RULES`, every open flag sharing its (asset,
 * rule_id, metric) is dispositioned with it. Undeclared rules are unaffected;
 * their group is themselves.
 */
export async function applyFlagAction(
  store: WorkspaceStore,
  /** The alert's workspace number — what the Tower shows and acts on. */
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

  // Which rows this action may touch. Every action but `unsnooze` needs an
  // open condition; unsnooze needs a live snooze. `tune` needs an open row not
  // already dispositioned something else, since it writes into the same
  // one-decision-per-row slot; a row already tuned may be tuned again.
  const eligible = (now: string) =>
    action === "unsnooze"
      ? snoozedFlagsSql("", now)
      : action === "tune"
        ? `(${openFlagsSql("", now)}) AND (disposition IS NULL OR disposition = 'tune')`
        : openFlagsSql("", now);

  // One transaction: the eligibility read, the disposition and the tune's own
  // row land together or not at all. An alert a same-day report retry
  // replaced is no alert (`current_flags`), so it is never acted on.
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

    // The end of a snooze is a date, so unsnooze stores one rather than a null.
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

    // NULL never equals NULL in SQL, so a metric-less rule needs an IS NULL arm.
    const scope = grouped
      ? `asset_id = ${bind(target.asset)} AND rule_id = ${bind(target.ruleId)} AND ${
          target.metric === null ? "metric IS NULL" : `metric = ${bind(target.metric)}`
        }`
      : `flag_id = ${bind(target.flagId)}`;

    // The grouped arm updates several rows, so the statement returns every one it changed.
    const changed = await tx.query<{ id: number }>(
      `UPDATE noticeos.flags
          ${setSql}
        WHERE ${scope} AND replaced_by_pulse_id IS NULL AND ${eligible(bind(nowIso, "::timestamptz"))}
        RETURNING flag_number::int AS id`,
      values,
    );
    if (changed.length === 0) return null;

    // The tune is also its own row: `flag_tunes` is one row per tune, in the
    // same transaction, against the flag the operator acted from — a count of
    // tunes is a count of decisions, and there was exactly one.
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
