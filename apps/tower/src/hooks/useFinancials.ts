import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { FinancialsPayload } from "@shared/financials";
import { FinancialsPeriodError } from "@/lib/api";

/**
 * Polling read for /financials. Slow on purpose: the ledger moves weekly at
 * best. The last-good payload is kept on a failed poll. `period` is part of
 * the key, not only the request: each month is its own cached answer, so
 * stepping forward never leaves one month's figures on screen under a header
 * that has already moved to the next.
 */
export function useFinancials(period?: string | null) {
  const { fetchFinancials } = useTowerApi();
  return useQuery<FinancialsPayload>({
    queryKey: ["financials", period ?? null],
    queryFn: ({ signal }) => fetchFinancials(period, signal),
    refetchInterval: 300_000,
    staleTime: 120_000,
    // A month the ledger does not hold will not start holding one on the third
    // attempt; retrying it only delays the months that do exist.
    retry: (failureCount, error) =>
      !(error instanceof FinancialsPeriodError) && failureCount < 3,
  });
}
