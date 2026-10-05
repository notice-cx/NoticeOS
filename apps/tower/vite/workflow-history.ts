import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WORKFLOW_ACTIVE_FILE, WORKFLOW_HISTORY_FILE, readJsonLines } from '../../../scripts/workflow-history.mjs';
import { manualRecords, buildWorkflowHistory } from '../../../scripts/workflow-history-view.mjs';
export { manualRecords, buildWorkflowHistory } from '../../../scripts/workflow-history-view.mjs';

/** The manual firings, or none: a read that fails leaves the runner's own
 * history exactly as it was (bead `ro-ujb9.96.7.19`). */
export type ManualRunsReader = () => Promise<unknown>;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

export function createWorkflowHistoryReader(repoRoot: string, readManual: ManualRunsReader = async () => []) {
  let cache: { key: string; records: unknown[]; traces: unknown[] } | undefined;
  return async (now: number, selectedId?: string, sessionId?: string) => {
    const manual = manualRecords(await readManual().catch(() => []));
    const jobsFile = path.join(repoRoot, '.local/logs/job-runs.jsonl');
    const traceFile = path.join(repoRoot, WORKFLOW_HISTORY_FILE);
    try {
      const [jobsStat, traceStat, activeText] = await Promise.all([stat(jobsFile), stat(traceFile).catch(() => null), readFile(path.join(repoRoot, WORKFLOW_ACTIVE_FILE), 'utf8').catch(() => '{}')]);
      const key = `${jobsStat.mtimeMs}:${traceStat?.mtimeMs}`;
      if (cache?.key !== key) cache = { key, records: await readJsonLines(jobsFile), traces: traceStat ? await readJsonLines(traceFile) : [] };
      let active: unknown[] = [];
      let observationsFresh = !sessionId;
      try {
        const value: unknown = JSON.parse(activeText);
        if (sessionId && isObject(value) && value.sessionId === sessionId && typeof value.updatedAt === 'string' &&
          now - Date.parse(value.updatedAt) >= 0 && now - Date.parse(value.updatedAt) < 45_000 && Array.isArray(value.runs)) {
          active = value.runs;
          observationsFresh = true;
        }
      } catch { /* torn snapshot */ }
      return { historyAvailable: true, observationsFresh, ...buildWorkflowHistory([...cache.records, ...manual], cache.traces, active, now, selectedId) };
    } catch {
      return { historyAvailable: false, observationsFresh: false, ...buildWorkflowHistory([], [], [], now, selectedId) };
    }
  };
}
