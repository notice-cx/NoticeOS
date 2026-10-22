import type { Row, WorkspaceStore } from '@noticeos/postgres';
import { MANUAL_RUN_DETAIL, type WorkflowRun, type WorkflowStepRun } from '@noticeos/contract';
import { WORKFLOW_DEFINITIONS } from '../../../scripts/workflow-definitions.mjs';
import { summarizeWorkflowHistory } from '../../../scripts/workflow-history-view.mjs';
import { isWorkflowStepOutput } from '../../../scripts/workflow-output.mjs';
import { jobRunName, schedulesRefusal, type ScheduleStatus, type ScheduleOverrides } from '../../../scripts/scheduled-jobs.mjs';
import { JSON_HEADERS } from './http';

const HOUR = 3_600_000;
const id = (row: Row): string => `${String(row.lane)}@${String(row.occurrence)}/${String(row.attempt)}`;
function refused(): never { throw new Error('Hosted workflow evidence unavailable'); }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function status(value: unknown): ScheduleStatus & { overrides: ScheduleOverrides | null } {
  if (!object(value) || value.onlyListedJobs !== true || !Array.isArray(value.jobs) || value.jobs.length > 64
    || !Array.isArray(value.registeredJobs) || value.registeredJobs.length > 64
    || new Set(value.registeredJobs).size !== value.registeredJobs.length
    || value.registeredJobs.some(id => typeof id !== 'string' || !WORKFLOW_DEFINITIONS.some(definition => definition.id === id))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || ![null, 'held', 'waiting'].includes(value.error as null | string)
    || schedulesRefusal(value.overrides ?? {})) refused();
  const seen = new Set<string>();
  const jobs: ScheduleStatus['jobs'] = [];
  for (const job of value.jobs) {
    if (!object(job) || typeof job.id !== 'string' || seen.has(job.id)
      || !value.registeredJobs.includes(job.id)
      || schedulesRefusal({ [job.id]: { enabled: job.enabled, cron: job.cron,
        ...(job.timezone === undefined ? {} : { timezone: job.timezone }) } })
      || (job.nextRun !== null && (typeof job.nextRun !== 'string' || !Number.isFinite(Date.parse(job.nextRun))))) refused();
    seen.add(job.id);
    jobs.push({ id: job.id, enabled: job.enabled as boolean, cron: job.cron as string,
      ...(typeof job.timezone === 'string' ? { timezone: job.timezone } : {}),
      nextRun: job.nextRun as string | null });
  }
  // Return the public schedule fields, never arbitrary stored status metadata.
  return { updatedAt: value.updatedAt, error: value.error as null | 'held' | 'waiting', jobs,
    hostLanes: false, onlyListedJobs: true, registeredJobs: [...value.registeredJobs] as string[],
    overrides: (value.overrides ?? null) as ScheduleOverrides | null };
}
const state = (row: Row, fresh: boolean): WorkflowRun['state'] => {
  if (row.state === 'running') return row.expired || !fresh ? 'unknown' : 'running';
  if (row.state === 'uncertain') return 'unknown';
  if (row.state === 'blocked' || row.skipped === true) return 'skipped';
  if (row.state === 'succeeded') return 'succeeded';
  return 'failed';
};
function trace(row: Row, fresh: boolean): WorkflowRun {
  return { id: id(row), workflowId: String(row.lane), definitionVersion: null,
    startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    state: state(row, fresh), trigger: { kind: 'schedule', reference: String(row.occurrence) }, steps: null };
}
function steps(value: unknown, attempt: number): WorkflowStepRun[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!object(parsed) || Object.keys(parsed).length > 16) refused();
  return Object.entries(parsed).flatMap(([key, step]) => {
    if (!object(step) || !['succeeded', 'skipped'].includes(String(step.state))
      || typeof step.attempt !== 'number' || !Number.isInteger(step.attempt) || step.attempt < 1 || step.attempt > attempt
      || typeof step.startedAt !== 'string' || typeof step.finishedAt !== 'string'
      || !Number.isFinite(Date.parse(step.startedAt)) || !Number.isFinite(Date.parse(step.finishedAt))) return [];
    return [{ id: key, attempt: step.attempt, state: step.state as 'succeeded' | 'skipped', startedAt: step.startedAt,
      finishedAt: step.finishedAt, ...(typeof step.summary === 'string' ? { summary: step.summary.slice(0, 500) } : {}),
      ...(isWorkflowStepOutput(step.output) ? { output: step.output } : {}) }];
  });
}

/** Stored evidence only. The caller has already admitted workflows.read and
 * bound this store; no file, service secret or executable registry is read. */
export async function handleHostedWorkflowRead(request: Request, store: WorkspaceStore, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/api/workflows', '/api/scheduled-jobs'].includes(url.pathname)) return null;
  const selected = url.searchParams.get('run') ?? undefined;
  if (request.method !== 'GET' || request.body !== null || url.hash
    || [...url.searchParams].some(([key]) => key !== 'run' || url.pathname !== '/api/workflows')
    || url.searchParams.getAll('run').length > 1 || (selected !== undefined && (!selected || selected.length > 240))) {
    return Response.json({ error: 'invalid_workflow_read' }, { status: 400, headers: JSON_HEADERS });
  }
  const payload = await store.read(async tx => {
    const observations = await tx.query(`SELECT observed_at,running,payload::text FROM noticeos.hosted_scheduler_status
      WHERE workspace_id=$1::uuid`, [tx.workspaceId]);
    const observed = observations[0];
    const runtime = observed ? status(JSON.parse(String(observed.payload))) : null;
    const age = observed ? now - Date.parse(String(observed.observed_at)) : NaN;
    const fresh = observed?.running === true && age >= 0 && age < 45_000;
    const summary = { overrides: runtime?.overrides ?? null, runtime, runtimeFresh: fresh };
    if (url.pathname === '/api/scheduled-jobs') return summary;
    // A manual collection can exist before any scheduler is configured. Keep
    // that recorded work visible without inventing timer registration/health.
    const bounds = [new Date(now - 30 * 24 * HOUR).toISOString(), new Date(now).toISOString()];
    const manual = await tx.query(`WITH ranked AS (
      SELECT job_run_id,job,started_at,finished_at,outcome,row_number() OVER(PARTITION BY job ORDER BY started_at DESC,job_run_id DESC) AS position
      FROM noticeos.job_runs WHERE workspace_id=$1::uuid AND detail=$2 AND job=ANY($3::text[])
        AND started_at>=$4::timestamptz AND started_at<=$5::timestamptz AND finished_at>=started_at)
      SELECT job_run_id::text,job,started_at,finished_at,outcome FROM ranked WHERE position<=30 OR ($6::text IS NOT NULL AND job_run_id::text=$6) ORDER BY started_at DESC,job_run_id DESC`,
    [tx.workspaceId, MANUAL_RUN_DETAIL, WORKFLOW_DEFINITIONS.map(jobRunName), ...bounds, selected?.split('@manual/')[1] ?? null]);
    const definitions = WORKFLOW_DEFINITIONS.filter(definition => runtime?.registeredJobs?.includes(definition.id)
      || manual.some(row => row.job === jobRunName(definition)));
    const lanes = definitions.map(definition => definition.id);
    // Bound rich detail separately from complete hourly counts. No arbitrary
    // job payload or all-history JSON is transferred to the Worker/browser.
    const rows = await tx.query(`WITH ranked AS (
      SELECT a.*,row_number() OVER(PARTITION BY lane ORDER BY started_at DESC,attempt DESC) AS position
      FROM noticeos.hosted_job_attempts a
      WHERE workspace_id=$1::uuid AND lane=ANY($2::text[]) AND started_at>=$3::timestamptz AND started_at<=$4::timestamptz)
      SELECT a.lane,a.occurrence,a.attempt,a.state,a.started_at,a.finished_at,
        j.lease_expires_at<=clock_timestamp() AS expired,
        a.state='succeeded' AND j.steps<>'{}'::jsonb AND NOT EXISTS
          (SELECT 1 FROM jsonb_each(j.steps) s WHERE s.value->>'state'<>'skipped') AS skipped
      FROM ranked a JOIN noticeos.hosted_job_occurrences j USING(workspace_id,lane,occurrence)
      WHERE a.position<=30 OR ($5::text IS NOT NULL AND a.lane || '@' || a.occurrence || '/' || a.attempt::text=$5) ORDER BY a.started_at DESC,a.attempt DESC`,
    [tx.workspaceId, lanes, ...bounds, selected ?? null]);
    const manualRuns: WorkflowRun[] = manual.map(row => {
      const workflowId = definitions.find(definition => jobRunName(definition) === row.job)!.id;
      return { id: `${workflowId}@manual/${String(row.job_run_id)}`, workflowId, definitionVersion: null,
        startedAt: String(row.started_at), finishedAt: String(row.finished_at),
        state: row.outcome === 'ran' ? 'succeeded' : row.outcome === 'failed' ? 'failed' : 'skipped',
        trigger: { kind: 'manual' }, steps: null };
    });
    const all = [...rows.map(row => trace(row, fresh)), ...manualRuns];
    const finished = all.filter(run => run.state !== 'running');
    const active = all.filter(run => run.state === 'running');
    const view = summarizeWorkflowHistory(finished, active, now, selected, definitions);
    const row = selected ? rows.find(candidate => id(candidate) === selected) : undefined;
    if (row && view.selectedRun) {
      // Earlier attempts do not inherit checkpoints subsequently committed by
      // a retry. Only the journal's current attempt has a rich step snapshot.
      const detail = await tx.query(`SELECT steps::text FROM noticeos.hosted_job_occurrences
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND attempt=$4`,
      [tx.workspaceId, String(row.lane), String(row.occurrence), Number(row.attempt)]);
      if (detail[0]) view.selectedRun.steps = steps(detail[0].steps, Number(row.attempt));
    }
    const historyFrom = new Date(now - 30 * 24 * HOUR).toISOString();
    const buckets = await tx.query(`SELECT a.lane,
      min(a.started_at) AS first_run_at,
      count(*) FILTER(WHERE a.state IN ('running','uncertain'))::int AS unknown,
      coalesce(max(a.lane || '@' || a.occurrence || '/' || a.attempt::text) FILTER(WHERE a.state IN ('retryable','exhausted')),
        max(a.lane || '@' || a.occurrence || '/' || a.attempt::text)) AS run_id,(date_trunc('hour',a.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS hour,
      count(*) FILTER(WHERE a.state='succeeded' AND NOT
        (j.steps<>'{}'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.steps) s WHERE s.value->>'state'<>'skipped')))::int AS succeeded,
      count(*) FILTER(WHERE a.state IN ('retryable','exhausted'))::int AS failed,
      count(*) FILTER(WHERE a.state='blocked' OR (a.state='succeeded' AND j.steps<>'{}'::jsonb
        AND NOT EXISTS(SELECT 1 FROM jsonb_each(j.steps) s WHERE s.value->>'state'<>'skipped')))::int AS skipped
      FROM noticeos.hosted_job_attempts a JOIN noticeos.hosted_job_occurrences j USING(workspace_id,lane,occurrence)
      WHERE a.workspace_id=$1::uuid AND a.lane=ANY($2::text[]) AND a.started_at>=$3::timestamptz
        AND a.started_at<=$4::timestamptz GROUP BY a.lane,(date_trunc('hour',a.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    [tx.workspaceId, lanes, historyFrom, new Date(now).toISOString()]);
    const manualBuckets = await tx.query(`SELECT job,
      min(started_at) AS first_run_at,
      coalesce(max(job_run_id::text) FILTER(WHERE outcome='failed'),max(job_run_id::text)) AS run_id,(date_trunc('hour',started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS hour,
      count(*) FILTER(WHERE outcome='ran')::int AS succeeded,
      count(*) FILTER(WHERE outcome='failed')::int AS failed,
      count(*) FILTER(WHERE outcome='skipped')::int AS skipped
      FROM noticeos.job_runs WHERE workspace_id=$1::uuid AND detail=$2 AND job=ANY($3::text[])
        AND started_at>=$4::timestamptz AND started_at<=$5::timestamptz AND finished_at>=started_at
      GROUP BY job,(date_trunc('hour',started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    [tx.workspaceId, MANUAL_RUN_DETAIL, definitions.map(jobRunName), historyFrom, new Date(now).toISOString()]);
    for (const workflow of view.workflows) {
      const daily = workflow.dailyHistory!;
      // Rich detail cannot establish the first execution or an older failure.
      daily.firstRunAt = null;
      for (const bucket of daily.buckets) Object.assign(bucket, { succeeded: 0, failed: 0, skipped: 0, unknown: 0, runId: null });
      const job = jobRunName(definitions.find(definition => definition.id === workflow.id)!);
      const aggregates: Row[] = [
        ...buckets.filter(row => row.lane === workflow.id),
        ...manualBuckets.filter(row => row.job === job).map(row => ({ ...row, run_id: `${workflow.id}@manual/${String(row.run_id)}` })),
      ];
      for (const full of aggregates) {
        const first = String(full.first_run_at);
        if (daily.firstRunAt === null || Date.parse(first) < Date.parse(daily.firstRunAt)) daily.firstRunAt = first;
        const dayAt = new Date(String(full.hour)).toISOString().slice(0, 10);
        const bucket = daily.buckets.find(bucket => bucket.at.startsWith(dayAt));
        if (!bucket) continue;
        if (bucket.runId === null || Number(full.failed) > 0 && bucket.failed === 0) bucket.runId = String(full.run_id);
        for (const outcome of ['succeeded', 'failed', 'skipped', 'unknown'] as const) bucket[outcome] += Number(full[outcome] ?? 0);
      }
      for (const bucket of workflow.history) {
        const own = aggregates.filter(row => Date.parse(String(row.hour)) === Date.parse(bucket.at));
        bucket.succeeded = own.reduce((sum, row) => sum + Number(row.succeeded), 0);
        bucket.failed = own.reduce((sum, row) => sum + Number(row.failed), 0);
        bucket.skipped = own.reduce((sum, row) => sum + Number(row.skipped), 0);
        bucket.runId = String(own.find(row => Number(row.failed) > 0)?.run_id ?? own[0]?.run_id ?? '') || null;
      }
    }
    return { ...summary, ...view, historyAvailable: true, observationsFresh: fresh, generatedAt: new Date(now).toISOString() };
  });
  return Response.json(payload, { headers: JSON_HEADERS });
}
