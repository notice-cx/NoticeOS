// Small readers, a hash and UTC-day arithmetic every module may need. No
// imports: the demo release bundles some of its importers on their own.

/** How long one provider call may take while a person watches a spinner. */
export const WATCHED_REQUEST_TIMEOUT_MS = 10_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A JSON object, or null for anything else (an array included). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A non-empty string field, or null. */
export function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function arrayField(record: Record<string, unknown> | null, field: string): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes, or of the bytes given. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : ownedCopy(input);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** WebCrypto takes only ArrayBuffer-backed views. */
function ownedCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned;
}

const DAY_MS = 86_400_000;

/** The UTC calendar day ('YYYY-MM-DD') of an instant. */
export function utcDay(instant: Date | number | string): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Midnight UTC of a 'YYYY-MM-DD' day in epoch ms; NaN when it is not one. */
export function utcDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** `day` moved by whole days. Throws a RangeError when `day` is not a day;
 * callers with a gentler rule check `utcDayStartMs` first. */
export function shiftUtcDay(day: string, days: number): string {
  return utcDay(utcDayStartMs(day) + days * DAY_MS);
}

/** Whole UTC days from `from` to `to`. An unreadable day reads as infinitely
 * old, so a history the run cannot understand causes a collection rather than
 * a silent, permanent skip. */
export function wholeUtcDaysBetween(from: string, to: string): number {
  const start = utcDayStartMs(from);
  const end = utcDayStartMs(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((end - start) / DAY_MS);
}
