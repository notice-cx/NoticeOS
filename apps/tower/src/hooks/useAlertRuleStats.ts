import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { AlertRuleStatsPayload } from "@shared/alert-rules";


/**
 * What each alert rule has cost over the last quarter.
 *
 * Not polled, for the same reason `useAlertHistory` is not: this is a record of
 * what already happened, over ninety days, and a count that moves once a week
 * does not repay a sixty-second poll on a page the operator is typing into.
 * `useConfigSave` already invalidates what a save changes; a tune recorded from
 * the panel invalidates this key the same way.
 *
 * One query key for both surfaces. `/settings#alert-rules` and every open Tune
 * panel read the same cached payload, so the figure cannot differ between the
 * page that edits the rule and the alert the rule fired on.
 */
export function useAlertRuleStats() {
  const { fetchAlertRuleStats } = useTowerApi();
  return useQuery<AlertRuleStatsPayload>({
    queryKey: ["alert-rule-stats"],
    queryFn: ({ signal }) => fetchAlertRuleStats(signal),
    staleTime: 60_000,
  });
}
