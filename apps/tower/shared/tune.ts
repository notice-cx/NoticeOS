// The tune vocabulary — the disposition that carries its own reason. The
// panel offers the change and the Worker records it, so the browser sends
// which setting moved and the two values, and the note is written here, once,
// from the same field metadata the settings page labels that field with.

/** How one `flag_defaults` setting is named wherever it is rendered: the
 * operator's words, the config key as the jargon suffix, and the line under
 * the field. `worker/portfolio-settings.ts` builds the settings rows from
 * this, and a tune's stored note reads from it. `explain` says what moving it
 * does, in a few words — never the method. */
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
 * What the row says it was tuned with — `flags.disposition_note`. The setting
 * that changed is the reason, so the note is the field's own label with its
 * jargon suffix and the two values, in the shape `KnobEditor` renders the
 * field. It never repeats the word "tuned"; the disposition badge says that.
 */
export function tuneNote(tuned: TunedSetting): string {
  const meta = FLAG_DEFAULT_META[tuned.setting];
  const name = meta ? `${meta.label} (${meta.jargon})` : tuned.setting;
  return `${name} ${tuned.from} → ${tuned.to}`;
}

// --- a tune that survives a later decision ----------------------------------
// `flags.disposition` holds exactly one decision, and a tuned alert stays
// open, so Mark read and Snooze land on rows that say `tune`. The tune is
// kept by carrying it into the note behind a mark: `disposition_note` is
// composed only here and in `worker/flag-actions.ts` from a fixed vocabulary,
// and the disposition slot goes on holding the decision about the event. This
// records that the row was tuned and which setting last moved; a row per tune
// is `flag_tunes`.

/**
 * The mark that says "this row was tuned, whatever disposition it now
 * carries": the note is either `<the decision> · rule tuned: <the setting>`
 * or it is not. It carries no quote character, and `test/flag-actions.test.ts`
 * pins that, because `worker/flag-scope.ts` and `worker/flag-actions.ts`
 * inline it into SQL text.
 */
export const TUNE_CARRIED_MARK = " · rule tuned: ";

/** The note a row gets when a new decision lands on one that was tuned. The
 * decision leads — it is what the operator just did — and the tune follows it,
 * because the rule change is the older fact. */
export function carriedTuneNote(decisionNote: string, tuned: string): string {
  return `${decisionNote}${TUNE_CARRIED_MARK}${tuned}`;
}

/** Was this row ever tuned — the one derived predicate every surface reads;
 * the answer is not the disposition slot. The SQL half is
 * `worker/flag-scope.ts`'s `everTunedSql`, composed from the same mark. */
export function wasTuned(flag: {
  disposition: string | null;
  dispositionNote: string | null;
}): boolean {
  if (flag.disposition === "tune") return true;
  return flag.dispositionNote?.includes(TUNE_CARRIED_MARK) === true;
}

/** The setting that moved, out of whatever note the row now carries — the
 * raw tune note on a still-tuned row, the carried tail on a row since marked
 * read or parked, `null` when there is no tune in it at all. */
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

/** The note without its carried tune — what a surface quotes as the reason;
 * the tuned chip beside it carries the setting. */
export function decisionNoteOnly(note: string | null): string | null {
  if (note === null) return null;
  const at = note.indexOf(TUNE_CARRIED_MARK);
  return at >= 0 ? note.slice(0, at) : note;
}

// This file owns the field labels; `shared/alert-rules.ts` (`RULE_LABELS` /
// `ruleLabel`) owns the rule labels.
