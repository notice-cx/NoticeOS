import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WORKFLOW_ACTIVE_FILE, WORKFLOW_HISTORY_FILE, readJsonLines } from '../../../scripts/workflow-history.mjs';
import { manualRecords, buildWorkflowHistory, WORKFLOW_RECENT_RUN_LIMIT } from '../../../scripts/workflow-history-view.mjs';
import { backupEvidenceFromReport, isBackupRunEvidence, type BackupRunEvidence } from '../../../packages/contract/src/backup-evidence.mjs';
import type { ManualJobRunHistory } from '@noticeos/contract';
import { jobRunName } from '../../../scripts/scheduled-jobs.mjs';
import { WORKFLOW_DEFINITIONS } from '../../../scripts/workflow-definitions.mjs';
import type { WorkflowRun } from '@noticeos/contract';
export { manualRecords, buildWorkflowHistory } from '../../../scripts/workflow-history-view.mjs';

/** The manual firings, or none: a failed read leaves the runner's own history as it was. */
export type ManualRunsReader = (selectedId?: string) => Promise<unknown>;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** An older report can describe only the execution whose time range contains it. */
export function backupForRun(run: WorkflowRun | null, report?: unknown, candidates: readonly WorkflowRun[] = []): { runId: string; evidence: BackupRunEvidence; source: 'execution' | 'report' } | null {
  if (!run || run.workflowId !== 'backup' || !run.finishedAt) return null;
  const belongs = (evidence: BackupRunEvidence) => Date.parse(evidence.startedAt) >= Date.parse(run.startedAt)
    && Date.parse(evidence.finishedAt) <= Date.parse(run.finishedAt!);
  const captured = run.steps?.flatMap(step => step.output?.backup ? [step.output.backup] : []).find(value => isBackupRunEvidence(value) && belongs(value));
  if (captured) return { runId: run.id, evidence: captured, source: 'execution' };
  const evidence = backupEvidenceFromReport(report);
  const ambiguous = evidence && candidates.some(other => other.id !== run.id && other.workflowId === 'backup'
    && Date.parse(other.startedAt) <= Date.parse(evidence.finishedAt)
    && (!other.finishedAt || Date.parse(other.finishedAt) >= Date.parse(evidence.startedAt)));
  return evidence && belongs(evidence) && !ambiguous ? { runId: run.id, evidence, source: 'report' } : null;
}

/** Scan the coarse ledger without the rich trace tail's byte cap. Only the
 * retained thirty-day window enters the projection; the browser still receives
 * fixed aggregates and thirty details. A busy week cannot fall off a tail. */
async function readJobRecords(file: string, now: number): Promise<unknown[]> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records: unknown[] = [];
  try {
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (isObject(value) && typeof value.at === 'string' && Date.parse(value.at) >= now - 30 * 86_400_000) records.push(value);
      } catch { /* A torn ledger line is not an observed run. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  return records;
}

export function createWorkflowHistoryReader(repoRoot: string, readManual: ManualRunsReader = async () => []) {
  let cache: { key: string; records: unknown[]; traces: unknown[] } | undefined;
  return async (now: number, selectedId?: string, sessionId?: string) => {
    let manualAvailable = true;
    const manualRead: unknown = await readManual(selectedId).catch(() => { manualAvailable = false; return []; });
    const manual = manualRecords(isObject(manualRead) ? manualRead.runs : manualRead);
    const manualDaily = isObject(manualRead) ? manualRead.dailyHistory as ManualJobRunHistory | undefined : undefined;
    const jobsFile = path.join(repoRoot, '.local/logs/job-runs.jsonl');
    const traceFile = path.join(repoRoot, WORKFLOW_HISTORY_FILE);
    try {
      const [jobsStat, traceStat, activeText] = await Promise.all([stat(jobsFile), stat(traceFile).catch(() => null), readFile(path.join(repoRoot, WORKFLOW_ACTIVE_FILE), 'utf8').catch(() => '{}')]);
      const key = `${jobsStat.mtimeMs}:${traceStat?.mtimeMs}`;
      if (cache?.key !== key) cache = { key, records: await readJobRecords(jobsFile, now), traces: traceStat ? await readJsonLines(traceFile) : [] };
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
      const history = buildWorkflowHistory([...cache.records, ...manual], cache.traces, active, now, selectedId);
      if (manualDaily) {
        const scheduled = buildWorkflowHistory(cache.records, cache.traces, active, now);
        for (const workflow of history.workflows) {
          const daily = scheduled.workflows.find(entry => entry.id === workflow.id)!.dailyHistory!;
          workflow.dailyHistory = daily;
          daily.from = new Date(Math.max(Date.parse(daily.from), Date.parse(manualDaily.from))).toISOString();
          daily.through = new Date(Math.min(Date.parse(daily.through), Date.parse(manualDaily.through))).toISOString();
          for (const full of manualDaily.buckets.filter(bucket => bucket.job === jobRunName(WORKFLOW_DEFINITIONS.find(definition => definition.id === workflow.id)!))) {
            const bucket = daily.buckets.find(bucket => Date.parse(bucket.at) === Date.parse(full.at));
            if (!bucket) continue;
            if (!bucket.runId || full.failed > 0 && bucket.failed === 0) bucket.runId = `${workflow.id}@manual/${full.runAt}`;
            bucket.succeeded += full.succeeded; bucket.failed += full.failed; bucket.skipped += full.skipped;
            if (!daily.firstRunAt || full.firstRunAt < daily.firstRunAt) daily.firstRunAt = full.firstRunAt;
          }
        }
      }
      if (!manualAvailable) for (const workflow of history.workflows) workflow.dailyHistory!.from = workflow.dailyHistory!.through;
      let backup = backupForRun(history.selectedRun);
      if (!backup && history.selectedRun?.workflowId === 'backup' && history.selectedRun.finishedAt) {
        try {
          const reportFile = path.join(repoRoot, '.local/backup-report.json');
          const summary = history.workflows.find(workflow => workflow.id === 'backup');
          // A bounded run list cannot establish uniqueness once it is full.
          if (summary && summary.runs.length < WORKFLOW_RECENT_RUN_LIMIT && (await stat(reportFile)).size <= 256 * 1024) {
            backup = backupForRun(history.selectedRun, JSON.parse(await readFile(reportFile, 'utf8')), [...summary.runs, ...(summary.active ? [summary.active] : [])]);
          }
        } catch { /* Missing or unrelated metadata cannot describe this execution. */ }
      }
      return { historyAvailable: true, observationsFresh, ...history, backup };
    } catch {
      return { historyAvailable: false, observationsFresh: false, ...buildWorkflowHistory([], [], [], now, selectedId), backup: null };
    }
  };
}
