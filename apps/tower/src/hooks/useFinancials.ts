import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { FinancialsPayload } from "@shared/financials";
import { FinancialsPeriodError } from "@/lib/api";

/**
 * Polling read for /financials. SLOW on purpose — the ledger moves when the
 * operator imports an export or a Monday sweep books its metered spend, which
 * is weekly at best, so a fast poll would be work nobody asked for against a
 * figure that cannot have changed. The last-good payload is kept on a failed
 * poll: an accounting page that blanks is worse than one that ages.
 *
 * `period` is part of the KEY, not only the request (bead `ro-69vb`): each
 * month is its own cached answer, so stepping back to one already read is
 * instant, and stepping forward never leaves August's figures on screen under
 * a header that has already moved to September.
 */
export function useFinancials(period?: string | null) {
  const { fetchFinancials } = useTowerApi();
  return useQuery<FinancialsPayload>({
    queryKey: ["financials", period ?? null],
    queryFn: ({ signal }) => fetchFinancials(period, signal),
    refetchInterval: 300_000,
    staleTime: 120_000,
    // A month the ledger does not hold will not start holding one on the third
    // attempt (bead `ro-dm67`). Retrying it spends seconds before the page can
    // offer the months that DO exist, which is the whole point of the answer.
    retry: (failureCount, error) =>
      !(error instanceof FinancialsPeriodError) && failureCount < 3,
  });
}
