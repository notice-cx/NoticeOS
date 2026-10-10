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
 * One page of settled alerts. Not polled, unlike every other read on the
 * desk: this one answers "what happened", and a closed alert does not reopen,
 * so a poll would yank the page out from under an operator mid-read. What
 * changes it is the operator: `FlagActions` invalidates
 * {@link ALERT_HISTORY_KEY} after every Mark read, Snooze, Unsnooze and
 * Resolve. `keepPreviousData` holds the rows on screen while the next page
 * loads.
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
      // The refused page param is part of the key: without it `?offset=nonsense`
      // and the plain first page would hash to the same entry, and the cache
      // would hand a 400 URL the 200 answer.
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
