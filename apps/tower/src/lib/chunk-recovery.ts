/** Recognize missing route code without hiding application errors. */
const CHUNK_FAILURE_MESSAGES = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

/**
 * Is this the "the code for this screen is gone" failure, as opposed to a bug
 * in the screen? Only this one is fixed by reloading; anything else is left to
 * fail exactly as it did before the split.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return CHUNK_FAILURE_MESSAGES.some((pattern) => pattern.test(message));
}
