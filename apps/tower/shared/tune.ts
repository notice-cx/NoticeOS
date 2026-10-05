// The TUNE vocabulary — the sixth disposition, and the one that carries its own
// reason (docs/15 flow E, bead `ro-van6`).
//
// `flags.disposition` has accepted `'tune'` since db/0001 and nothing ever wrote
// it, so a rule the operator quietened by hand looked, in the store, exactly
// like a rule nobody had ever complained about. That is why flow E's
// false-positive rate could not be measured: one of the six labels was
// unwritable.
//
// IT LIVES IN `shared/` for the reason `shared/snooze.ts` does. The panel offers
// the change and the Worker records it; a note composed on one side and a note
// composed on the other are two vocabularies for one fact, and only one of them
// is in the store. So the browser sends WHICH SETTING MOVED and the two values,
// and the note is written here, once, from the same field metadata the settings
// page labels that field with.

/** How one `flag_defaults` setting is named wherever it is rendered: the
 * operator's words, the config key as the jargon suffix, and the line under
 * the field. `worker/portfolio-settings.ts` builds the settings rows from
 * this, and a tune's stored note reads from it, so a field cannot be called one
 * thing on `/settings` and another in the alert's history.
 *
 * `explain` is WHAT MOVING IT DOES, in a few words — never the method (bead
 * `ro-ujb9.96.6.7`). The replay beside the field shows the effect of a value on
 * real days, which is the explanation a threshold field actually needs
 * (Datadog draws the threshold on the preview graph for the same reason); the
 * line only says which way is quieter, so the operator knows which way to type.
 */
export interface FlagDefaultMeta {
  label: string;
  jargon: string;
  explain: string;
}

export const FLAG_DEFAULT_META: Record<string, FlagDefaultMeta> = {
  alpha: {
    label: "Anomaly sensitivity",
    jargon: "alpha",
    explain: "Lower means fewer, surer alerts",
  },
  min_baseline_per_day: {
    label: "Minimum daily volume to test",
    jargon: "min_baseline_per_day",
    explain: "Quieter metrics are tested over several days",
  },
  low_volume_window_hours: {
    label: "Low-volume window",
    jargon: "low_volume_window_hours",
    explain: "Hours pooled together for quieter metrics",
  },
};

/** The settings a tune may name. Exactly the three the anomaly rules read — a
 * `tune` disposition claiming some other key would be a record of a change that
 * cannot have altered what fires. */
export const TUNABLE_SETTINGS: readonly string[] = Object.keys(FLAG_DEFAULT_META);

/** One recorded tune: the setting that moved, and what it moved between. */
export interface TunedSetting {
  /** A `config/constants.json` `flag_defaults` key. */
  setting: string;
  /** The saved value the operator replaced. */
  from: number;
  /** The value they saved. */
  to: number;
}

/** Why a tune was refused. Returned verbatim as the API's `{ error }`, like
 * every other refusal on this lane. */
export type TuneRejection =
  | "tune_setting_unknown"
  | "tune_values_invalid"
  | "tune_changed_nothing";

export type TuneCheck =
  | { ok: true; tuned: TunedSetting }
  | { ok: false; reason: TuneRejection };

/**
 * Is this a tune the store may record?
 *
 * `tune_changed_nothing` is a refusal and not a shrug: a disposition means the
 * operator DID something, and a Save that wrote the value already there would
 * otherwise mark an alert tuned on the strength of nothing having happened —
 * which is exactly the false-positive count this record exists to feed.
 */
export function checkTunedSetting(input: unknown): TuneCheck {
  const fields = (input ?? {}) as Partial<TunedSetting>;
  if (
    typeof fields.setting !== "string" ||
    !TUNABLE_SETTINGS.includes(fields.setting)
  ) {
    return { ok: false, reason: "tune_setting_unknown" };
  }
  if (
    typeof fields.from !== "number" ||
    !Number.isFinite(fields.from) ||
    typeof fields.to !== "number" ||
    !Number.isFinite(fields.to)
  ) {
    return { ok: false, reason: "tune_values_invalid" };
  }
  if (fields.from === fields.to) return { ok: false, reason: "tune_changed_nothing" };
  return {
    ok: true,
    tuned: { setting: fields.setting, from: fields.from, to: fields.to },
  };
}

/**
 * What the row says it was tuned WITH — `flags.disposition_note`, which docs/15's
 * "muting without a reason doesn't exist" points at.
 *
 * The setting that changed IS the reason, so the note is the field's own label
 * with its jargon suffix and the two values, in the shape `KnobEditor` renders
 * the field itself (docs/17 rule 4: the config key is evidence and may ride as a
 * suffix, never as the headline). It never repeats the word "tuned" — the
 * disposition badge beside it already says that (doc 14, one representation per
 * fact).
 */
export function tuneNote(tuned: TunedSetting): string {
  const meta = FLAG_DEFAULT_META[tuned.setting];
  const name = meta ? `${meta.label} (${meta.jargon})` : tuned.setting;
  return `${name} ${tuned.from} → ${tuned.to}`;
}

// --- A TUNE THAT SURVIVES A LATER DECISION (bead `ro-bkcl`) ----------------
//
// THE BUG. `flags.disposition` holds exactly ONE decision, and since `ro-van6`
// a tuned alert stays OPEN — the firing was never answered, only the rule
// changed — so Mark read and Snooze are still on the row. Taking either
// replaced `disposition='tune'` and the note naming the setting that moved. The
// tune was then gone from the store, and it is the only evidence a rule was
// noisy enough for the operator to act on it: the operator who is most
// diligent, who tunes the rule AND clears the alert, was the one whose tune the
// false-positive rate forgot.
//
// WHAT WAS CHOSEN, AND WHY, out of the three options the bead listed.
// (a) leave it and state the limit is what shipped, and it made the diligent
// operator invisible. (b) a `flag_tunes` table and (c) a `tuned_at` column are
// both MIGRATIONS, and migrations here are operator-only and forever-forbidden
// to an agent (AGENTS.md HARD INVARIANTS) — a schema answer cannot land in the
// same change as the fix it is for.
//
// So the fact is DERIVED FROM THE ROW THAT ALREADY EXISTS. `disposition_note`
// is the flag's reason field and nothing free-text ever reaches it — every note
// in the store is composed here or in `worker/flag-actions.ts` from a fixed
// vocabulary — so a decision landing on a tuned row keeps the tune by carrying
// it into the note behind a mark, and the disposition slot goes on holding the
// operator's decision about the EVENT. That is arguably the truer model
// anyway: a tune is a statement about the RULE, and it was only ever borrowing
// the event's one slot.
//
// WHAT IT STILL CANNOT DO, stated rather than hidden: it records THAT the row
// was tuned and WHICH setting last moved, not a row per tune. "This rule was
// tuned five times this quarter" needs the table, and that is bead `ro-6d1t`.

/**
 * The mark that says "this row was tuned, whatever disposition it now carries".
 *
 * It is a literal rather than a column because there is no column, and it is
 * EXACT rather than a pattern so nothing has to guess: the note is either
 * `<the decision> · rule tuned: <the setting that moved>` or it is not.
 *
 * It carries no quote character, and `test/flag-actions.test.ts` pins that,
 * because `worker/flag-scope.ts` and `worker/flag-actions.ts` inline it into
 * SQL text.
 */
export const TUNE_CARRIED_MARK = " · rule tuned: ";

/** The note a row gets when a new decision lands on one that was tuned. The
 * decision leads — it is what the operator just did — and the tune follows it,
 * because the rule change is the older fact. */
export function carriedTuneNote(decisionNote: string, tuned: string): string {
  return `${decisionNote}${TUNE_CARRIED_MARK}${tuned}`;
}

/**
 * WAS THIS ROW EVER TUNED — the one derived predicate every surface reads.
 *
 * Written once here rather than as `disposition === 'tune'` in each of the four
 * places that ask, because the whole point of the fix is that the answer is no
 * longer the disposition slot. The SQL half is `worker/flag-scope.ts`'s
 * `everTunedSql`, composed from the same mark.
 */
export function wasTuned(flag: {
  disposition: string | null;
  dispositionNote: string | null;
}): boolean {
  if (flag.disposition === "tune") return true;
  return flag.dispositionNote?.includes(TUNE_CARRIED_MARK) === true;
}

/**
 * The setting that moved, out of whatever note the row now carries — the raw
 * tune note on a still-tuned row, the carried tail on a row that has since been
 * marked read or parked, `null` when there is no tune in it at all.
 *
 * The chip's hover reads this, so "which setting" survives the decision exactly
 * as the fact that a tune happened does.
 */
export function tunedSettingNote(flag: {
  disposition: string | null;
  dispositionNote: string | null;
}): string | null {
  const note = flag.dispositionNote;
  if (note === null) return null;
  const at = note.indexOf(TUNE_CARRIED_MARK);
  if (at >= 0) return note.slice(at + TUNE_CARRIED_MARK.length);
  return flag.disposition === "tune" ? note : null;
}

/**
 * The note WITHOUT its carried tune — what a surface quotes as the reason.
 *
 * The tuned chip beside it already says the row was tuned and carries the
 * setting in its hover, so quoting the whole composed string would be the same
 * fact twice on one line (doc 14, one representation per fact).
 */
export function decisionNoteOnly(note: string | null): string | null {
  if (note === null) return null;
  const at = note.indexOf(TUNE_CARRIED_MARK);
  return at >= 0 ? note.slice(0, at) : note;
}

// HOW A RULE IS NAMED lives in `shared/alert-rules.ts` (`RULE_LABELS` /
// `ruleLabel`, bead `ro-ayxy`), beside the per-rule false-positive counts both
// surfaces read — not here. Doc 17's tune row settled that `flow-poisson-low`
// is a name for the code and not for the operator, and ONE map is what keeps
// `/settings#alert-rules` and the Tune panel on an alert row from calling one
// rule two things (bead `ro-ui73`). This file owns the FIELD labels; that one
// owns the RULE labels.
