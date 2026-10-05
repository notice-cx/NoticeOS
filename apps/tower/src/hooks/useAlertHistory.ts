import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  AlertHistoryPayload,
  AlertHistoryQuery,
} from "@shared/alert-history";
import { AlertHistoryPageError } from "@/lib/api";

/** Every page of the settled archive shares this key prefix, so one
 * invalidation re-reads them all — the strip's page and History's. */
export const ALERT_HISTORY_KEY = ["alert-history"] as const;

/**
 * One page of settled alerts (bead `ro-ju7f`).
 *
 * NOT POLLED, unlike every other read on the desk. The other payloads answer
 * "what is true now" and go stale by the second; this one answers "what
 * happened", and a closed alert does not reopen. A 60-second poll here would
 * re-fetch an archive nobody is watching change, and would yank the page out
 * from under an operator mid-read the moment a row settles.
 *
 * WHAT CHANGES IT IS THE OPERATOR, so the operator's own actions re-read it:
 * `FlagActions` invalidates {@link ALERT_HISTORY_KEY} after every Mark read,
 * Snooze, Unsnooze and Resolve (bead `ro-ujb9.195`), and "Settled · 7d" moves
 * the moment the row it counts leaves the Open list.
 *
 * `keepPreviousData` is the paging half: turning a page holds the rows on
 * screen while the next ones load, so the list does not blink to "Loading…"
 * and back on every Older click.
 */
export function useAlertHistory(query: AlertHistoryQuery) {
  const { fetchAlertHistory } = useTowerApi();
  return useQuery<AlertHistoryPayload>({
    queryKey: [
      ...ALERT_HISTORY_KEY,
      query.asset,
      query.severity,
      query.offset,
      query.limit,
      // The REFUSED page param is part of the key (bead `ro-oefa`). Without it
      // `?offset=nonsense` and the plain first page hash to the same entry —
      // `offset`/`limit` both hold their defaults on a refusal — and the cache
      // would hand a 400 URL the 200 answer that made this bug invisible.
      query.malformed,
    ],
    queryFn: ({ signal }) => fetchAlertHistory(query, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    // A URL that is not a page will not become one on the third attempt — the
    // same reason `useFinancials` does not retry a month the ledger refuses.
    retry: (failureCount, error) =>
      !(error instanceof AlertHistoryPageError) && failureCount < 3,
  });
}
