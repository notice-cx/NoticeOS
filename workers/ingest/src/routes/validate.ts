// Field validation for the operator JSON routes.
//
// The pulse and revenue lanes validate through the contract package's Zod
// schemas. These routes describe rows the contract package does not model (a
// timeline annotation, a pre-registered watch), and zod is not a dependency of
// this Worker — so validation is hand-rolled here and emits the SAME
// `{ path, code, message }` issue shape `zodIssues` produces, because the 422
// body is the operator-facing contract and it must not vary per route.

export interface Issue {
  path: string;
  code: string;
  message: string;
}

/** Asset ids are domains or short slugs ('example.com', 'home-os'). */
import { ASSET_ID_MAX } from '@noticeos/contract/configuration';
import { fieldRefusal, type RegisterField } from '../../../../scripts/config-registers.mjs';
export { ASSET_ID_MAX } from '@noticeos/contract/configuration';
export { SITE_ROW_FIELDS } from '../../../../scripts/config-registers.mjs';
/** Tolerance for a caller's clock running ahead of ours; not a scheduling window. */
export const FUTURE_SKEW_MS = 60_000;

/** Accumulates issues so one request reports every problem, not just the first. */
export class Issues {
  readonly list: Issue[] = [];

  add(path: string, code: string, message: string): void {
    this.list.push({ path, code, message });
  }

  get ok(): boolean {
    return this.list.length === 0;
  }
}

/** A JSON object body, or null when the body is anything else. */
export function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export function requiredString(
  issues: Issues,
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be a string`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.add(path, 'too_small', `${path} must not be empty`);
    return null;
  }
  if (trimmed.length > maxLength) {
    issues.add(path, 'too_big', `${path} must be at most ${maxLength} characters`);
    return null;
  }
  return trimmed;
}

/**
 * One value checked against a DECLARED field (`SITE_ROW_FIELDS` — a site's row,
 * bead `ro-ujb9.183`): the refusal is `fieldRefusal`'s sentence, the one every
 * register's refusal is worded by, so it names the field by the label beside
 * its input ("Domain must be a hostname such as example.com") and the issue's
 * `path` keeps the key the body sent. A string is trimmed first, as
 * `requiredString` trims. Returns the value, or null when it was refused or,
 * for an optional field, absent — `issues.ok` tells the two apart.
 */
function declared(issues: Issues, value: unknown, path: string, field: RegisterField): unknown {
  const candidate = typeof value === 'string' ? value.trim() : value;
  const refusal = fieldRefusal(field, candidate);
  if (refusal !== null) {
    issues.add(path, 'invalid_value', refusal);
    return null;
  }
  return candidate ?? null;
}

/** A declared text field (a site id, a name, a domain, a stage). */
export function declaredString(issues: Issues, value: unknown, path: string, field: RegisterField): string | null {
  const checked = declared(issues, value, path, field);
  return typeof checked === 'string' ? checked : null;
}

/** A declared number field (a site's 0/1 automation flag). */
export function declaredNumber(issues: Issues, value: unknown, path: string, field: RegisterField): number | null {
  const checked = declared(issues, value, path, field);
  return typeof checked === 'number' ? checked : null;
}

/** `undefined`/`null` are both "absent" — a caller omitting a field and a caller
 * sending an explicit null mean the same thing on these routes. */
export function optionalString(
  issues: Issues,
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(issues, value, path, maxLength);
}

export function enumValue<T extends string>(
  issues: Issues,
  value: unknown,
  path: string,
  allowed: readonly T[],
): T | null {
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be a string`);
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    issues.add(path, 'invalid_value', `${path} must be one of: ${allowed.join(', ')}`);
    return null;
  }
  return value as T;
}

/**
 * A wall-clock instant, normalized to ISO-8601 UTC.
 *
 * Backdating is deliberately allowed — an annotation for a batch that shipped
 * three weeks ago is the whole point of the route. A *future* timestamp is
 * rejected: it would let a change claim to have happened after outcomes that
 * are already recorded. `skewMs` tolerates a client clock running slightly
 * ahead of ours; it is not a window for scheduling.
 */
export function pastInstant(
  issues: Issues,
  value: unknown,
  path: string,
  nowMs: number,
  skewMs: number,
): string | null {
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be an ISO-8601 datetime string`);
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issues.add(path, 'invalid_format', `${path} must be an ISO-8601 datetime`);
    return null;
  }
  if (parsed > nowMs + skewMs) {
    issues.add(path, 'custom', `${path} must not be in the future`);
    return null;
  }
  return new Date(parsed).toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, 'YYYY-MM-DD' — the grain `signal_observations` is keyed on. */
export function isoDate(issues: Issues, value: unknown, path: string): string | null {
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be a string`);
    return null;
  }
  if (!DATE_RE.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    issues.add(path, 'invalid_format', `${path} must be a YYYY-MM-DD date`);
    return null;
  }
  return value;
}

/** A whole count — rows, items, beads. Rejects fractions and negatives, which a
 * count can only be if the producer computed it wrong. */
export function nonNegativeInteger(
  issues: Issues,
  value: unknown,
  path: string,
  max?: number,
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.add(path, 'invalid_type', `${path} must be a whole number`);
    return null;
  }
  if (value < 0) {
    issues.add(path, 'too_small', `${path} must not be negative`);
    return null;
  }
  if (max !== undefined && value > max) {
    issues.add(path, 'too_big', `${path} must be at most ${max}`);
    return null;
  }
  return value;
}

export function finiteNumber(
  issues: Issues,
  value: unknown,
  path: string,
  { min, max }: { min?: number; max?: number } = {},
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.add(path, 'invalid_type', `${path} must be a finite number`);
    return null;
  }
  if (min !== undefined && value < min) {
    issues.add(path, 'too_small', `${path} must be at least ${min}`);
    return null;
  }
  if (max !== undefined && value > max) {
    issues.add(path, 'too_big', `${path} must be at most ${max}`);
    return null;
  }
  return value;
}
