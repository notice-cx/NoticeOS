export const LOCAL_MODEL_OUTPUT_TOKENS = 'LOCAL_MODEL_OUTPUT_TOKENS';
export const DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS = 8192;
export const MIN_LOCAL_MODEL_OUTPUT_TOKENS = 1024;
export const MAX_LOCAL_MODEL_OUTPUT_TOKENS = 32768;

/** Blank saved settings use the default; decimals, exponents and signs are not token counts. */
export function parseLocalModelOutputTokens(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS;
  if (!/^\d+$/u.test(trimmed)) return null;
  const tokens = Number(trimmed);
  return Number.isSafeInteger(tokens) && tokens >= MIN_LOCAL_MODEL_OUTPUT_TOKENS && tokens <= MAX_LOCAL_MODEL_OUTPUT_TOKENS ? tokens : null;
}
