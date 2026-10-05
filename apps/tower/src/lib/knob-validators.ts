import { isIanaTimeZone } from "@noticeos/contract/time-zone-setting";
import type { JsonValue } from "@shared/changeset";
import {
  fieldFromDraft,
  fieldRefusal,
  type RegisterField,
} from "@shared/config-registers";
import { isCountdownEmoji } from "@shared/dashboard";

// Knob validators — pure, UI-side input validation that runs BEFORE a value is
// written (the brief: "inputs validate locally — enum, number ranges, URL
// shape"). A value the field knows is wrong never becomes a request, let alone
// a commit. Each returns a discriminated result so an editor can show the exact
// reason inline and refuse the Save until it is valid.

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function parseNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** An http/https URL — the pull.json scrape endpoint. */
export function validateUrl(raw: string): Validated<string> {
  const t = raw.trim();
  if (t === "") return { ok: false, error: "Enter a URL." };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "URL must be http or https." };
  }
  return { ok: true, value: t };
}

/** A Poisson tail probability (alpha): strictly between 0 and 1. */
export function validateProbability(raw: string): Validated<number> {
  const n = parseNumber(raw);
  if (n === null) return { ok: false, error: "Enter a number." };
  if (n <= 0 || n >= 1) return { ok: false, error: "Must be between 0 and 1 (exclusive)." };
  return { ok: true, value: n };
}

/** A positive whole number (min baseline/day, low-volume window hours). */
export function validatePositiveInt(raw: string): Validated<number> {
  const n = parseNumber(raw);
  if (n === null) return { ok: false, error: "Enter a number." };
  if (!Number.isInteger(n)) return { ok: false, error: "Must be a whole number." };
  if (n < 1) return { ok: false, error: "Must be at least 1." };
  return { ok: true, value: n };
}

/** A non-negative dollar amount (spend caps, operator rate). */
export function validateUsd(raw: string): Validated<number> {
  const n = parseNumber(raw);
  if (n === null) return { ok: false, error: "Enter a number." };
  if (n < 0) return { ok: false, error: "Must be zero or more." };
  return { ok: true, value: n };
}

/**
 * Which validator guards each `flag_defaults` knob, keyed by the file's own
 * snake_case name.
 *
 * It lives beside the validators rather than in a route because TWO surfaces
 * edit these three numbers: `/settings#alert-rules`, where they belong (bead
 * `ro-pbzu.2`), and the asset page's rules card, which still renders them until
 * the tabs slice removes it. One map means the same value cannot be accepted on
 * one page and refused on the other.
 */
export const FLAG_DEFAULT_VALIDATOR: Record<string, (raw: string) => Validated<number>> = {
  alpha: validateProbability,
  min_baseline_per_day: validatePositiveInt,
  low_volume_window_hours: validatePositiveInt,
};

/**
 * An IANA timezone name (`config/constants.json` `os_time_zone`, bead
 * `ro-py40`).
 *
 * The runtime's own tz database is the authority — `isIanaTimeZone` asks
 * `Intl` rather than checking a hand-written list that would go stale the next
 * time a country moves its clocks. It is the SAME predicate the contract
 * validates the committed value with at the build boundary, so the field cannot
 * accept a zone the build would reject.
 */
export function validateTimeZone(raw: string): Validated<string> {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "Enter a timezone." };
  if (!isIanaTimeZone(value)) {
    return {
      ok: false,
      error: `Not a timezone this machine knows. Use an IANA name like ${localZoneExample()}.`,
    };
  }
  return { ok: true, value };
}

/** The example a refusal offers: the zone this browser runs in, so the hint is
 * one the reader recognises and no installation's zone is written into the
 * product (bead `ro-ujb9.118`). UTC when the runtime cannot say. */
function localZoneExample(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The validator a DECLARED FIELD already is (bead `ro-x5gu.8`).
 *
 * Every validator above is hand-written because the value it guards has no
 * declaration — a timezone, an emoji, a probability. A field of a config
 * register or a scalar knob is the opposite: its rule is written down once, in
 * `scripts/config-registers.mjs`, and `fieldRefusal` is what both the write lane
 * and the CLI judge it with. So a knob does not get a validator beside it — it
 * gets this, which parses the draft the way the field's own type says and hands
 * the result to that one judge.
 *
 * The consequence is the one worth having: the sentence under the input is
 * character-for-character the sentence a 422 would have carried, because it is
 * the same sentence. And it names the field by the label beside the input
 * (`Panel history window must be at least 1`, bead ro-ujb9.154), never by the
 * key the file holds.
 */
export function validateRegisterField(
  field: RegisterField,
): (raw: string) => Validated<JsonValue> {
  return (raw) => {
    const value = fieldFromDraft(field, raw);
    const refusal = fieldRefusal(field, value);
    return refusal === null ? { ok: true, value } : { ok: false, error: refusal };
  };
}

/** A concise display label for the countdown card header. */
export function validateDisplayLabel(raw: string): Validated<string> {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "Enter a label." };
  if (value.length > 80) {
    return { ok: false, error: "Keep the label to 80 characters or fewer." };
  }
  return { ok: true, value };
}

/** One visible grapheme for the countdown's large visual landmark. */
export function validateCountdownEmoji(raw: string): Validated<string> {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "Choose an emoji." };
  if (!isCountdownEmoji(value)) {
    return { ok: false, error: "Use one emoji." };
  }
  return { ok: true, value };
}

/**
 * A browser-local datetime converted into a portable ISO instant. Native
 * datetime-local controls intentionally omit a timezone; Date supplies the
 * display's local zone before this value enters shared config.
 */
export function validateFutureDateTime(
  raw: string,
  nowMs = Date.now(),
): Validated<string> {
  const target = new Date(raw);
  const targetMs = target.getTime();
  if (!raw || Number.isNaN(targetMs)) {
    return { ok: false, error: "Choose a valid date and time." };
  }
  if (targetMs <= nowMs) {
    return { ok: false, error: "Choose a time in the future." };
  }
  return { ok: true, value: target.toISOString() };
}
