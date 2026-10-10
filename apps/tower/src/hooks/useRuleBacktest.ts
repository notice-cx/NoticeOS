import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RuleBacktest, RuleBacktestInput } from "@noticeos/contract";


/** How long the operator has to stop typing before the store is asked again.
 * Long enough that a three-keystroke edit is one replay, short enough that the
 * strip still reads as an answer to what was just typed. */
const SETTLE_MS = 350;

/**
 * "How often would this rule have fired in the last 30 days with these
 * settings?" Debounced, because each keystroke of a number field would be a
 * full 30-day replay; `keepPreviousData` holds the last strip meanwhile. Not
 * polled and never retried: stored pulses do not change, and a refusal judges
 * the typed value.
 */
export function useRuleBacktest(input: RuleBacktestInput | null, settleMs = SETTLE_MS) {
  const { fetchRuleBacktest } = useTowerApi();
  // The whole request is the identity of the question, so it is serialized once
  // and used both as the debounce trigger and as the cache key.
  const asked = input === null ? null : JSON.stringify(input);
  const [settled, setSettled] = useState<string | null>(asked);

  useEffect(() => {
    if (asked === null) {
      setSettled(null);
      return;
    }
    const timer = globalThis.setTimeout(() => setSettled(asked), settleMs);
    return () => globalThis.clearTimeout(timer);
  }, [asked, settleMs]);

  return useQuery<RuleBacktest>({
    queryKey: ["rule-backtest", settled],
    queryFn: ({ signal }) =>
      fetchRuleBacktest(JSON.parse(settled!) as RuleBacktestInput, signal),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
