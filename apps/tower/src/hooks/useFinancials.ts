import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { FinancialsPayload } from "@shared/financials";
import { FinancialsPeriodError } from "@/lib/api";

/**
 * Polling read for /financials. Slow on purpose: the ledger moves weekly at
 * best. The last-good payload is kept on a failed poll. `period` is part of
 * the key, not only the request: each month is its own cached answer. While
 * the next month loads, the shown month stays whole, figures and header
 * together (`isPlaceholderData`), and the page marks the month it is loading.
 */
export function useFinancials(period?: string | null) {
  const { fetchFinancials } = useTowerApi();
  return useQuery<FinancialsPayload>({
    queryKey: ["financials", period ?? null],
    queryFn: ({ signal }) => fetchFinancials(period, signal),
    refetchInterval: 300_000,
    staleTime: 120_000,
    placeholderData: keepPreviousData,
    // A month the ledger does not hold will not start holding one on the third
    // attempt; retrying it only delays the months that do exist.
    retry: (failureCount, error) =>
      !(error instanceof FinancialsPeriodError) && failureCount < 3,
  });
}
