import { useRef } from 'react';
import type { AnalysisWorkflow } from '@shared/analysis-workflows';

export const ANALYSIS_QUERY = ['analysis-workflows'] as const;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function analysisWorkflowHref(workflow: string, run?: string) {
  const params = new URLSearchParams({ workflow });
  if (run) params.set('run', run);
  return `/workflows?${params}`;
}

export function triggerLabel(trigger: AnalysisWorkflow['trigger']): string {
  if (trigger.kind === 'manual') return 'Manual';
  const hour = String(trigger.hour).padStart(2, '0');
  const minute = String(trigger.minute).padStart(2, '0');
  return `${WEEKDAYS[trigger.weekday]} · ${hour}:${minute} ${trigger.timeZone}`;
}

/** Keep a retry on the same server receipt until the submitted inputs change. */
export function useAnalysisRequestKey() {
  const last = useRef<{ input: string; key: string } | null>(null);
  return {
    for(input: object) {
      const serialized = JSON.stringify(input);
      if (last.current?.input === serialized) return last.current.key;
      // getRandomValues is also available on the private HTTP installation.
      const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      last.current = { input: serialized, key };
      return key;
    },
    confirmed() { last.current = null; },
  };
}
