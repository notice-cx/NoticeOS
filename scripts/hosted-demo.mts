/** One persistent synthetic tenant. This is private deployment composition,
 * never a visitor route. Every date is derived from the captured scenario and
 * server clock; the public handle accepts no workspace, task or input payload.
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceStore, Transaction } from '../packages/postgres/src/store.mjs';
import type { WorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createHostedJobRunner, type HostedJobDefinition, type HostedJobReceipt, type JobInput } from './hosted-job-runner.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import type { HostedTaskExecutor } from './hosted-task-executor.mjs';
import type { HostedTaskOperation } from './hosted-task-command.mjs';
import { createHostedTaskSnapshot } from './hosted-task-snapshot.mjs';
import type { BeadsSnapshotInput } from '../packages/contract/src/task-snapshot.mjs';
import { createDemoActivity, DEMO_ACTIVITY_LIMITS, type DemoActivityCollection, type DemoActivityDay } from './demo-activity.mjs';
import { generateDemoScenario, demoScenarioHash, shiftDemoDay, type DemoScenario } from './demo-scenario.mjs';
import { DEMO_ACTIVITY_DEFINITION, demoActivityPrefix } from './demo-activity-definition.mjs';

const LANE = DEMO_ACTIVITY_DEFINITION.key;
/** Version of the demo's implementations of the release's scheduled jobs. */
const SCHEDULE_VERSION = 'demo-v1';
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export interface DemoActivityWriter {
  write(store: WorkspaceStore, day: DemoActivityDay): Promise<{ written: number; assets: number; date: string }>;
  collect(store: WorkspaceStore, collection: DemoActivityCollection): Promise<{ succeeded: number; written: number; outcomes: unknown[] }>;
  revenue(store: WorkspaceStore, input: { at: string; sites: readonly { asset: string; siteId: string; since: string }[];
    amount(asset: string, date: string): number }): Promise<unknown>;
  snapshot(store: WorkspaceStore, snapshot: BeadsSnapshotInput): Promise<{ written: number }>;
  outcomes(store: WorkspaceStore, at: string): Promise<unknown>;
}
export interface HostedDemoOptions {
  readonly workspaceId: string;
  readonly serviceId: string;
  readonly scenario: DemoScenario;
  readonly store: WorkspaceStore;
  readonly grant: WorkspaceServiceGrant;
  readonly writer: DemoActivityWriter;
  readonly tasks: Pick<HostedTaskExecutor, 'execute'>;
  readonly projects: readonly { readonly asset: string; readonly projectId: string; readonly prefix: string }[];
  /** Server composition may supply a controlled clock in disposable tests. */
  readonly now?: () => number;
}
export interface HostedDemoTick {
  readonly synthetic: true;
  readonly through: string;
  readonly days: readonly { readonly date: string; readonly receipt: HostedJobReceipt }[];
}
export class HostedDemoRefused extends Error {
  override name = 'HostedDemoRefused';
  constructor() { super('Hosted demo activity refused.'); }
}
function refuse(): never { throw new HostedDemoRefused(); }
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 4096 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) refuse();
  return value as Record<string, unknown>[];
}

/** Borrow a journal transaction, never open a second transaction for ordinary
 * writers. The capability expires before the journal commits or rolls back;
 * callback promises are awaited. The helper's read callbacks remain reads,
 * but participate in this same write transaction for atomic checkpointing. */
async function inTransaction<T>(tx: Transaction, signal: AbortSignal, work: (store: WorkspaceStore) => Promise<T>): Promise<T> {
  let active = true;
  const checked = (): void => { if (!active || signal.aborted) refuse(); };
  const run = async <R,>(callback: (transaction: Transaction) => Promise<R>): Promise<R> => {
    checked(); const result = await callback(tx); checked(); return result;
  };
  const store: WorkspaceStore = Object.freeze({ where: `demo-transaction:${randomUUID()}`,
    workspaceId: async () => { checked(); return tx.workspaceId; }, read: run, write: run,
    close: async () => { active = false; },
  });
  try { return await work(store); } finally { active = false; }
}

/** Owns store and grant. Deployment owns and closes the task executor's
 * directory after this handle closes. No filesystem or physical task selector
 * crosses tick(). All task commands still pass through the real hosted service.
 */
export function createHostedDemo(options: HostedDemoOptions): {
  tick(): Promise<HostedDemoTick>;
  /** The demo's lanes for the ordinary hosted scheduler, which owns their timers. */
  readonly schedule: readonly HostedJobDefinition[];
  close(): Promise<void>;
} {
  const { workspaceId, serviceId, store, grant, tasks, writer } = options;
  if (!UUID.test(workspaceId) || !UUID.test(serviceId) || !store || !grant
    || typeof tasks?.execute !== 'function' || typeof writer?.write !== 'function'
    || typeof writer?.collect !== 'function' || typeof writer?.revenue !== 'function'
    || typeof writer?.snapshot !== 'function' || typeof writer?.outcomes !== 'function') refuse();
  const scenario = generateDemoScenario(options.scenario.manifest);
  const hash = demoScenarioHash(scenario);
  if (workspaceId !== scenario.manifest.workspaceId || hash !== demoScenarioHash(options.scenario)) refuse();
  const activity = createDemoActivity(scenario), anchor = scenario.manifest.referenceDate;
  if (!Array.isArray(options.projects) || options.projects.length !== scenario.assets.filter(asset => !asset.isOs).length) refuse();
  const projects = new Map<string, string>();
  for (const project of options.projects) {
    if (!scenario.assets.some(asset => !asset.isOs && asset.id === project.asset)
      || projects.has(project.asset) || !UUID.test(project.projectId)) refuse();
    projects.set(project.asset, project.projectId);
  }
  // Sharing a task database between assets would lose the model's asset join.
  if (new Set(projects.values()).size !== projects.size) refuse();
  const snapshots = createHostedTaskSnapshot({ workspaceId, executor: tasks, projects: options.projects });
  const now = options.now ?? Date.now;
  const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('demo simulator'), authority: async () => {
    const facts = await grant.facts();
    if (!facts || facts.principalId !== serviceId || facts.workspaceId !== workspaceId) refuse();
    return facts;
  } });
  let stopped = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<HostedDemoTick>>();
  const dateOf = (input: unknown): string => {
    if (typeof input !== 'string') refuse(); activity.day(input); return input;
  };
  const runner = createHostedJobRunner({ workspaceId, serviceId, store, grant, definitions: [{
    key: LANE, version: DEMO_ACTIVITY_DEFINITION.version, parseInput: dateOf,
    steps: [{ ...DEMO_ACTIVITY_DEFINITION.steps[0], run: async ({ input, signal }, tx) => {
      const date = dateOf(input), facts = activity.day(date);
      if (date !== anchor) {
        const previous = activity.day(shiftDemoDay(date, -1)).key;
        const found = await tx.query(`SELECT 1 FROM noticeos.hosted_job_occurrences
          WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND state='succeeded'`, [workspaceId, LANE, previous]);
        if (found.length !== 1) refuse();
      }
      return inTransaction(tx, signal, scoped => writer.write(scoped, facts));
    } }, { ...DEMO_ACTIVITY_DEFINITION.steps[1], run: async ({ input, signal }: { input: JobInput; signal: AbortSignal }) => {
      const task = activity.day(dateOf(input)).task;
      if (!task) return { skipped: 1 };
      const projectId = projects.get(task.asset)!;
      const proof = new Request('https://noticeos.internal/demo-task', { method: 'POST', signal });
      const deadline = Date.now() + 29000;
      const execute = (operation: HostedTaskOperation) => tasks.execute(proof, workspaceId, { projectId, operation }, { signal, deadline });
      const active = rows(await execute({ kind: 'active-board', statuses: ['open', 'in_progress', 'blocked', 'deferred'] }));
      const label = `synthetic:${task.key}`;
      const matching = active.filter(row => Array.isArray(row.labels) && row.labels.includes(label));
      if (task.phase === 'create') {
        if (matching.length) refuse();
        const created = await execute({ kind: 'create', title: task.title, description: task.description,
          acceptance: task.acceptance, type: 'task', priority: 2, labels: ['synthetic-demo', label] });
        const row = Array.isArray(created) ? created[0] : created;
        if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') refuse();
        return { filed: 1 };
      }
      if (matching.length !== 1) refuse();
      const found = matching[0]!;
      if (typeof found.id !== 'string' || found.issue_type !== 'task'
        || found.created_by !== serviceId || !Array.isArray(found.labels) || !found.labels.includes('synthetic-demo')
        || found.labels.includes('human')) refuse();
      if (task.phase === 'start') {
        if (found.status !== 'open') refuse();
        await execute({ kind: 'update', taskId: found.id, claim: true });
        return { written: 1 };
      }
      if (found.status !== 'in_progress' || found.assignee !== serviceId) refuse();
      await execute({ kind: 'close', taskId: found.id, reason: task.closeReason });
      return { closed: 1 };
    } }, { ...DEMO_ACTIVITY_DEFINITION.steps[2], run: async ({ signal }, tx) => {
      // This is a bounded read of the actual task service, followed by the
      // ordinary cache writer. A failed read can retry without repeating a
      // completed task mutation; later dates wait for this checkpoint too.
      const snapshot = await snapshots.snapshot(new Request('https://noticeos.internal/demo-snapshot', { method: 'POST', signal }),
        { signal, deadline: Date.now() + 29000 });
      return inTransaction(tx, signal, scoped => writer.snapshot(scoped, snapshot));
    } }],
  }] });
  // The release's own job identities, so the hosted scheduler records each
  // execution in the journal Workflows and System health read: the
  // quarter-hour Google refresh writes today's provisional counts, the outcome
  // check reads the demo's windows, the board refresh reads the real task
  // service. Input is the scheduler's minute, never a payload.
  const minuteOf = (input: unknown): string => {
    const at = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1
      ? (input as { scheduledAt?: unknown }).scheduledAt : input;
    if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/u.test(at)) refuse();
    activity.collection(at); return at;
  };
  const refreshBoard = async (signal: AbortSignal, tx: Transaction) => {
    const snapshot = await snapshots.snapshot(new Request('https://noticeos.internal/demo-snapshot', { method: 'POST', signal }),
      { signal, deadline: Date.now() + 29000 });
    const written = await inTransaction(tx, signal, scoped => writer.snapshot(scoped, snapshot));
    return { ...written, projects: snapshot.projects.map(({ asset, ok, counts }) => ({ asset, ok, counts })) };
  };
  const adSites = Object.freeze(scenario.manifest.adSites.map(site => Object.freeze({ ...site,
    since: scenario.assets.find(asset => asset.id === site.asset)!.createdAt.slice(0, 10) })));
  const schedule: readonly HostedJobDefinition[] = Object.freeze([
    ...(adSites.length ? [{ key: 'mediavine', version: SCHEDULE_VERSION, parseInput: minuteOf, steps: [{ key: 'revenue', kind: 'database' as const, action: 'workflows.run' as const,
      run: async ({ input, signal }: { input: JobInput; signal: AbortSignal }, tx: Transaction) => inTransaction(tx, signal, scoped =>
        writer.revenue(scoped, { at: minuteOf(input), sites: adSites, amount: activity.adRevenue })) }] }] : []),
    { key: 'counters', version: SCHEDULE_VERSION, parseInput: minuteOf, steps: [{ key: 'google', kind: 'database', action: 'workflows.run',
      run: async ({ input, signal }, tx) => inTransaction(tx, signal, scoped => writer.collect(scoped, activity.collection(minuteOf(input)))) }] },
    { key: 'watch-windows', version: SCHEDULE_VERSION, parseInput: minuteOf, steps: [{ key: 'outcomes', kind: 'database', action: 'workflows.run',
      run: async ({ input, signal }, tx) => inTransaction(tx, signal, scoped => writer.outcomes(scoped, minuteOf(input))) }] },
    { key: 'beads-snapshot', version: SCHEDULE_VERSION, parseInput: minuteOf, steps: [{ key: 'execute', kind: 'database', action: 'workflows.run',
      run: async ({ signal }, tx) => refreshBoard(signal, tx) }] },
  ]);
  async function tick(): Promise<HostedDemoTick> {
    if (stopped) refuse();
    const instant = now();
    if (!Number.isSafeInteger(instant) || instant < Date.parse(scenario.manifest.cutoff)) refuse();
    const through = new Date(Math.floor(instant / DAY) * DAY - DAY).toISOString().slice(0, 10);
    if (through >= anchor) activity.day(through);
    const days: { date: string; receipt: HostedJobReceipt }[] = [];
    // At most seven previously owed days, oldest first. A busy/uncertain run
    // stops this batch; no later date can skip past a missing checkpoint.
    for (let i = 0; through >= anchor && i < DEMO_ACTIVITY_LIMITS.daysPerBatch && !stopped; i++) {
      const next = await admission.withAdmission('workflows.run', { requestedWorkspaceId: workspaceId, correlationId: randomUUID() },
        new Request('https://noticeos.internal/demo-tick', { method: 'POST' }), async () => {
          if (stopped || await store.workspaceId() !== workspaceId) refuse();
          const found = await store.read(async tx => {
            // This selection runs before the job runner owns a step. Bound it
            // separately so an owned store can finish shutdown behind a lock.
            await tx.query(`SELECT pg_catalog.set_config('lock_timeout','1000',true),
              pg_catalog.set_config('statement_timeout','5000',true)`);
            return tx.query<{ date: string }>(`SELECT to_char($2::date+n,'YYYY-MM-DD') AS date
            FROM generate_series(0,$3::date-$2::date) AS days(n)
            WHERE NOT EXISTS (SELECT 1 FROM noticeos.hosted_job_occurrences j WHERE j.workspace_id=$1::uuid
              AND j.lane=$4 AND j.occurrence=$5||to_char($2::date+n,'YYYY-MM-DD') AND j.state='succeeded')
            ORDER BY n LIMIT 1`, [workspaceId, anchor, through, LANE, demoActivityPrefix(hash)]);
          });
          return found[0]?.date ?? null;
        });
      if (next === null) break;
      const receipt = await runner.run(LANE, activity.day(next).key, next);
      days.push({ date: next, receipt });
      if (receipt.state !== 'succeeded') break;
    }
    return Object.freeze({ synthetic: true, through, days: Object.freeze(days) });
  }
  return Object.freeze({
    schedule,
    tick() {
      const work = tick(); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    },
    close() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        // The runner aborts admitted task commands and awaits database work.
        // Store shutdown drains any already running selection query too.
        const ended = runner.close();
        const results = await Promise.allSettled([...pending, ended]);
        if (results.at(-1)?.status === 'rejected') refuse();
      })();
      return closing;
    },
  });
}
