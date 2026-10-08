import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from '../packages/postgres/src/store.mjs';
import type { WorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createHostedJobRunner, type HostedJobDefinition, type HostedJobRunner } from './hosted-job-runner.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createScheduledJobRunner, type ScheduledTimer, type ScheduledJobRunner } from './scheduled-job-runner.mjs';
import { SCHEDULED_JOBS, schedulesRefusal, type ScheduleOverrides, type ScheduleStatus } from './scheduled-jobs.mjs';

/** Deployment code supplies executable lanes. Neither settings nor a request
 * can add code, a workspace, service identity, or a maintenance operation. */
export interface HostedScheduleBinding {
  readonly workspaceId: string;
  readonly serviceId: string;
  readonly store: WorkspaceStore;
  readonly grant: WorkspaceServiceGrant;
  readonly definitions: readonly HostedJobDefinition[];
}
const TENANT_JOBS = new Set(['mediavine', 'freshness', 'notifications', 'pull', 'hygiene', 'watch-windows',
  'clarity', 'signal-dumps', 'posthog', 'dataforseo', 'counters', 'beads-snapshot', 'panel-review']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export class HostedScheduleRefused extends Error {
  override name = 'HostedScheduleRefused';
  constructor() { super('Hosted schedule refused.'); }
}
function refuse(): never { throw new HostedScheduleRefused(); }

/** One deployment owns these timers and resources. The journal, not timer
 * overlap or a heartbeat, arbitrates each occurrence. close waits for both
 * refreshes and admitted work before retiring the connections. */
export async function startHostedScheduler(bindings: readonly HostedScheduleBinding[], adapters: {
  readonly now?: () => number;
  readonly createTimer?: (cron: string, callback: () => Promise<void>, timezone: string) => ScheduledTimer;
  readonly refreshEveryMs?: number;
} = {}): Promise<{ refresh(): Promise<void>; close(): Promise<void> }> {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 64) refuse();
  const seen = new Set<string>();
  // Capture the complete composition before asynchronous work or resource use.
  const captured: HostedScheduleBinding[] = bindings.map((binding: HostedScheduleBinding) => {
    if (!binding || !UUID.test(binding.workspaceId) || !UUID.test(binding.serviceId)
      || seen.has(binding.workspaceId) || !binding.store || !binding.grant
      || !Array.isArray(binding.definitions) || binding.definitions.length === 0) refuse();
    seen.add(binding.workspaceId);
    const definitions = binding.definitions.map((definition: HostedJobDefinition) => {
      if (!TENANT_JOBS.has(definition.key)) refuse();
      return { ...definition, steps: definition.steps.map(step => ({ ...step })) };
    });
    return { workspaceId: binding.workspaceId, serviceId: binding.serviceId,
      store: binding.store, grant: binding.grant, definitions };
  });
  const now = adapters.now ?? Date.now;
  const every = adapters.refreshEveryMs ?? 15_000;
  if (!Number.isInteger(every) || every < 1000 || every > 15_000) refuse();
  const entries: { binding: HostedScheduleBinding; sessionId: string;
    runner: HostedJobRunner; schedule: ScheduledJobRunner }[] = [];
  const pending = new Set<Promise<unknown>>();
  const dispatches = new Set<Promise<void>>();
  let stopped = false, closing: Promise<void> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const own = <T,>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  async function refresh(): Promise<void> {
    if (stopped) refuse();
    await own(Promise.all(entries.map(entry => entry.schedule.refresh())));
  }
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    for (const entry of entries) entry.schedule.stop();
    closing = (async () => {
      // runner.close aborts admitted effects and awaits their adapter cleanup.
      // Hold its resources until the refresh/publish path has finished first.
      await Promise.allSettled([...pending]);
      const published = await Promise.allSettled(entries.map(async ({ binding, sessionId }) => {
        await binding.store.write(tx => tx.execute(`UPDATE noticeos.hosted_scheduler_status
          SET running=false,observed_at=clock_timestamp()
          WHERE workspace_id=$1::uuid AND session_id=$2::uuid`, [binding.workspaceId, sessionId]));
      }));
      const ended = await Promise.allSettled([...dispatches,
        ...entries.map(entry => Promise.resolve().then(() => entry.runner.close()))]);
      if ([...published, ...ended].some(result => result.status === 'rejected')) refuse();
    })();
    return closing;
  }
  try {
    for (const binding of captured) {
      const { workspaceId, serviceId, store, grant, definitions } = binding;
      const sessionId = randomUUID();
      const runner = createHostedJobRunner(binding);
      const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('hosted schedule'),
        authority: async () => {
          const facts = await grant.facts();
          if (!facts || facts.principalId !== serviceId || facts.workspaceId !== workspaceId) refuse();
          return facts;
        } });
      const admitted = <T,>(work: () => Promise<T>): Promise<T> => admission.withAdmission('workflows.run',
        { requestedWorkspaceId: workspaceId, correlationId: randomUUID() },
        new Request('https://noticeos.internal/schedule', { method: 'POST' }), async () => {
          if (stopped || await store.workspaceId() !== workspaceId) refuse();
          return work();
        });
      const jobs = definitions.map(definition => SCHEDULED_JOBS.find(job => job.id === definition.key)!);
      let overrides: ScheduleOverrides | null = null;
      const publish = async (status: ScheduleStatus) => admitted(async () => {
        const body = JSON.stringify({ ...status, sessionId, hostLanes: false, onlyListedJobs: true,
          registeredJobs: definitions.map(definition => definition.key), overrides });
        if (Buffer.byteLength(body) > 65536) refuse();
        const wrote = await store.write(tx => tx.execute(`INSERT INTO noticeos.hosted_scheduler_status
          (workspace_id,service_id,session_id,observed_at,running,payload)
          VALUES($1::uuid,$2::uuid,$3::uuid,clock_timestamp(),true,$4::jsonb)
          ON CONFLICT(workspace_id) DO UPDATE SET service_id=excluded.service_id,
          session_id=excluded.session_id,observed_at=excluded.observed_at,running=true,payload=excluded.payload
          WHERE noticeos.hosted_scheduler_status.session_id=excluded.session_id
            OR NOT noticeos.hosted_scheduler_status.running
            OR noticeos.hosted_scheduler_status.observed_at<clock_timestamp()-interval '45 seconds'`,
        [workspaceId, serviceId, sessionId, body]));
        if (wrote !== 1) refuse();
      });
      const schedule = createScheduledJobRunner({ jobs,
        now: () => new Date(now()), ...(adapters.createTimer ? { createTimer: adapters.createTimer } : {}),
        read: async () => admitted(async () => {
          const rows = await store.read(tx => tx.query(`SELECT body::text FROM noticeos.config_documents
            WHERE workspace_id=$1::uuid AND document_key='constants'`, [workspaceId]));
          if (rows.length !== 1) refuse();
          const body = JSON.parse(String(rows[0]!.body)) as { schedules?: unknown };
          const selected = body?.schedules ?? {};
          if (schedulesRefusal(selected)) refuse();
          overrides = selected as ScheduleOverrides;
          return overrides;
        }), publish,
        run: async job => {
          if (stopped) return;
          const scheduledAt = new Date(Math.floor(now() / 60_000) * 60_000).toISOString();
          // Input is generated here, never copied from an HTTP/job payload.
          const work = admitted(async () => {
            const owned = await store.read(tx => tx.query(`SELECT 1 FROM noticeos.hosted_scheduler_status
              WHERE workspace_id=$1::uuid AND session_id=$2::uuid AND running
                AND observed_at>=clock_timestamp()-interval '45 seconds'`, [workspaceId, sessionId]));
            if (owned.length !== 1) refuse();
            await runner.run(job.id, scheduledAt, { scheduledAt });
          });
          dispatches.add(work);
          try { await work; } catch { /* The journal/status carries bounded evidence, never provider errors. */ }
          finally { dispatches.delete(work); }
        },
      });
      entries.push({ binding, sessionId, runner, schedule });
      // Claim publication before any timer is armed. A competing scheduler
      // cannot take an active workspace even with a different registry.
      await publish(schedule.snapshot());
    }
    await refresh();
    refreshTimer = setInterval(() => { void refresh().catch(() => undefined); }, every);
    refreshTimer.unref();
    return Object.freeze({ refresh, close });
  } catch {
    await close().catch(() => undefined);
    // Bindings not yet composed still transferred ownership to this call.
    const acquired = new Set(entries.map(entry => entry.binding.workspaceId));
    await Promise.allSettled(captured.filter(binding => !acquired.has(binding.workspaceId)).flatMap(binding =>
      [() => binding.store.close(), () => binding.grant.close()].map(stop => Promise.resolve().then(stop))));
    refuse();
  }
}
