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
 * settings?" (bead `ro-u072`).
 *
 * DEBOUNCED, because the question is asked while a number field is being typed
 * into: `0.05` passes through `0`, `0.`, `0.0` on the way, and each of those is
 * a full replay of thirty days of pulses in the ingest Worker. The query key is
 * the settled request, so React Query still dedupes and caches per exact
 * question, and `keepPreviousData` holds the last strip on screen while the next
 * one is computed rather than blinking the panel empty between keystrokes.
 *
 * NOT POLLED and never retried. Stored pulses do not change under the panel, and
 * a refusal here is a judgement about the value the operator typed — retrying it
 * would just ask the same rejected question again.
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
