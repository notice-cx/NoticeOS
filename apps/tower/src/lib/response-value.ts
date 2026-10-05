/** JSON response checks only. These facts never authorize a request. */
export const responseRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const responseString = (value: unknown): value is string => typeof value === 'string';
export const responseNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const responseInteger = (value: unknown): value is number => responseNumber(value) && Number.isSafeInteger(value) && value >= 0;
export const responseBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const responseNullable = (check: (value: unknown) => boolean) => (value: unknown): boolean => value === null || check(value);
export const responseList = (check: (value: unknown) => boolean) => (value: unknown): boolean => Array.isArray(value) && value.every(item => check(item));
export const responseEnum = (values: readonly string[]) => (value: unknown): boolean => responseString(value) && values.includes(value);

/** Reject JS date normalization (February 30, hour 24), not just parse errors. */
export function responseDay(value: unknown): value is string {
  if (!responseString(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function responseInstant(value: unknown): value is string {
  if (!responseString(value) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) return false;
  return responseDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
export const responseMonth = (value: unknown): value is string => responseString(value) && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value);
export function responseZone(value: unknown): value is string {
  if (!responseString(value) || !value) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
export function responseFields(value: unknown, required: Record<string, (value: unknown) => boolean>,
  optional: Record<string, (value: unknown) => boolean> = {}): value is Record<string, unknown> {
  return responseRecord(value) && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
    && Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
}
export function invalidResponse(label: string): never { throw new Error(`${label} returned an invalid response.`); }

/** A malformed JSON diagnostic can contain response excerpts; don't echo them. */
export async function responseJson(response: Response, label: string): Promise<unknown> {
  try { return await response.json(); }
  catch (error) { if (error instanceof SyntaxError) invalidResponse(label); throw error; }
}
