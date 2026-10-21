import { formatInt } from "@/lib/format";

/** A measured count, or the known lower bound when some input is unread. */
export function countLabel(count: number, partial = false): string {
  return partial ? `at least ${formatInt(count)}` : formatInt(count);
}

/** No measured input stays unknown; a measured zero can still be a lower bound. */
export function boundedCount(complete: number | null, observed: number | null, anyRead: boolean): string | null {
  return complete !== null ? countLabel(complete) : observed === null || !anyRead ? null : countLabel(observed, true);
}
