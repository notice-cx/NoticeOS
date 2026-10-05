import { createHash, randomUUID } from 'node:crypto';
import type { Transaction, WorkspaceStore } from '../packages/postgres/src/store.mjs';
import type { WorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createWorkspaceAdmission, type WorkspaceAction, type WorkspaceContext, type WorkspaceAdmission } from './workspace-admission.mjs';
import { captureWorkflowOutput } from './workflow-output.mjs';
import { stepResult } from './workflow-trace.mjs';
import type { WorkflowStepOutput } from '../packages/contract/src/workflows.js';
import { SCHEDULED_JOBS, jobRunName } from './scheduled-jobs.mjs';
import { hostedJobDefinitionHash } from './hosted-job-definition.mjs';

/** The registry is executable deployment code, never a request or saved config.
 * Inputs are validated by that code, kept in memory, and persisted only as a
 * digest. Retrying requires supplying the identical validated input again. */
export type JobInput = null | boolean | number | string | readonly JobInput[] | { readonly [key: string]: JobInput };
interface StepCall {
  readonly context: WorkspaceContext;
  readonly occurrence: string;
  readonly input: JobInput;
  /** Adapters must honor cancellation and await their owned resource cleanup. */
  readonly signal: AbortSignal;
}
export type HostedJobStep = {
  readonly key: string;
  readonly action: WorkspaceAction;
} & (
  | { readonly kind: 'database'; readonly run: (call: StepCall, tx: Transaction) => Promise<unknown> }
  | { readonly kind: 'effect'; readonly run: (call: StepCall) => Promise<unknown> }
);
export interface HostedJobDefinition {
  readonly key: string;
  /** Change when the implementation or its interpretation of input changes. */
  readonly version: string;
  readonly parseInput: (input: unknown) => JobInput;
  readonly steps: readonly HostedJobStep[];
}
type State = 'running' | 'retryable' | 'succeeded' | 'uncertain' | 'blocked' | 'exhausted';
interface Evidence {
  readonly state: 'succeeded' | 'skipped';
  readonly summary: string;
  readonly attempt?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly output?: WorkflowStepOutput;
}
export interface HostedJobReceipt {
  readonly state: State | 'busy';
  readonly attempt: number;
  readonly steps: Readonly<Record<string, Evidence>>;
}
export interface HostedJobRunner {
  run(lane: string, occurrence: string, input: unknown): Promise<HostedJobReceipt>;
  close(): Promise<void>;
}
export class HostedJobRefused extends Error {
  override name = 'HostedJobRefused';
  constructor() { super('Hosted job refused.'); }
}
function refuse(): never { throw new HostedJobRefused(); }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const key = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/u.test(value);
const occurrenceKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const ATTEMPTS = 5;
const EFFECT_MS = 30_000;
const LEASE_SECONDS = 120;

/** Canonical JSON without toJSON/getters/prototypes, depth or allocation bombs. */
function inputCopy(value: unknown): { input: JobInput; hash: string } {
  let entries = 0, bytes = 0;
  const visit = (item: unknown, depth: number): JobInput => {
    if (++entries > 2048 || depth > 12) refuse();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item); if (bytes > 16_384) refuse(); return item;
    }
    if (!item || typeof item !== 'object') refuse();
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)) refuse();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 2049) refuse();
    if (array) {
      const values: JobInput[] = [];
      for (let i = 0; i < item.length; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !('value' in property)) refuse();
        values.push(visit(property.value, depth + 1));
      }
      if (keys.some(name => name !== 'length' && (typeof name !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(name)))) refuse();
      return Object.freeze(values);
    }
    const result: Record<string, JobInput> = Object.create(null) as Record<string, JobInput>;
    for (const name of keys.sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)) {
      if (typeof name !== 'string') refuse();
      bytes += Buffer.byteLength(name); if (bytes > 16_384) refuse();
      const property = Object.getOwnPropertyDescriptor(item, name);
      if (!property || !('value' in property)) refuse();
      result[name] = visit(property.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const input = visit(value, 0), encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > 16_384) refuse();
  return { input, hash: digest(encoded) };
}

interface Stored {
  state: State; attempt: number; lease_id: string; expired: boolean;
  definition_hash: string; input_hash: string; service_id: string;
  effect_step: string | null; steps: Record<string, Evidence>;
}
const SELECT = `SELECT state,attempt,lease_id::text,
  lease_expires_at<=clock_timestamp() AS expired,definition_hash,input_hash,service_id::text,
  effect_step,steps::text FROM noticeos.hosted_job_occurrences
  WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 FOR UPDATE NOWAIT`;
async function locked(tx: Transaction, lane: string, occurrence: string): Promise<Stored | null> {
  const rows = await tx.query(SELECT, [tx.workspaceId, lane, occurrence]);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { ...row, attempt: Number(row.attempt), steps: JSON.parse(String(row.steps)) as Record<string, Evidence> } as unknown as Stored;
}
function receipt(row: Stored, state: HostedJobReceipt['state'] = row.state): HostedJobReceipt {
  return Object.freeze({ state, attempt: row.attempt, steps: Object.freeze(structuredClone(row.steps)) });
}
function observed(value: unknown, startedAt: string): Evidence {
  const result = stepResult(value);
  if (!['succeeded', 'skipped'].includes(result.state) || typeof result.summary !== 'string') refuse();
  const output = captureWorkflowOutput(value);
  const evidence: Evidence = { state: result.state === 'skipped' ? 'skipped' : 'succeeded', summary: result.summary,
    startedAt, finishedAt: new Date().toISOString(), ...(output ? { output } : {}) };
  if (Buffer.byteLength(JSON.stringify(evidence)) > 32_768) refuse();
  return evidence;
}

/** Owns the supplied store/grant, which deployment must bind to this workspace.
 * Only this registry's callbacks receive fresh action contexts. No platform,
 * operator session, filesystem root or bearer proof is accepted by run(). */
export function createHostedJobRunner(options: {
  readonly workspaceId: string;
  readonly serviceId: string;
  readonly grant: WorkspaceServiceGrant;
  readonly store: WorkspaceStore;
  readonly definitions: readonly HostedJobDefinition[];
}): HostedJobRunner {
  const { workspaceId, serviceId, grant, store } = options;
  if (!uuid(workspaceId) || !uuid(serviceId) || !grant || !store
    || !Array.isArray(options.definitions) || options.definitions.length > 64) refuse();
  const definitions = new Map<string, HostedJobDefinition & { hash: string }>();
  for (const source of options.definitions) {
    if (!key(source.key) || !key(source.version) || definitions.has(source.key) || typeof source.parseInput !== 'function'
      || !Array.isArray(source.steps) || source.steps.length === 0 || source.steps.length > 16) refuse();
    const steps: readonly HostedJobStep[] = source.steps.map((step: HostedJobStep) => {
      if (!key(step.key) || !['database', 'effect'].includes(step.kind) || typeof step.run !== 'function' || typeof step.action !== 'string') refuse();
      return Object.freeze({ key: step.key, kind: step.kind, action: step.action, run: step.run }) as HostedJobStep;
    });
    if (new Set(steps.map(step => step.key)).size !== steps.length) refuse();
    const hash = hostedJobDefinitionHash(source.version, steps);
    definitions.set(source.key, Object.freeze({ key: source.key, version: source.version, parseInput: source.parseInput, steps: Object.freeze(steps), hash }));
  }
  const admission: WorkspaceAdmission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('hosted jobs'), authority: async () => {
    const facts = await grant.facts();
    if (!facts || facts.principalId !== serviceId || facts.workspaceId !== workspaceId) refuse();
    return facts;
  } });
  let closed = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<HostedJobReceipt>>();
  const controllers = new Set<AbortController>();
  const write = <T,>(work: (tx: Transaction) => Promise<T>): Promise<T> => store.write(async tx => {
    await tx.query(`SELECT pg_catalog.set_config('lock_timeout','1000',true),
      pg_catalog.set_config('statement_timeout','30000',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout','60000',true)`);
    return work(tx);
  });
  const fresh = <T,>(action: WorkspaceAction, correlationId: string, work: (context: WorkspaceContext) => Promise<T>): Promise<T> =>
    admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId }, new Request('https://noticeos.internal/job', { method: 'POST' }), async context => {
      if (closed || await store.workspaceId() !== workspaceId) refuse();
      admission.assertContext(context, action); return work(context);
    });

  async function execute(lane: string, occurrence: string, raw: unknown): Promise<HostedJobReceipt> {
    if (closed || !key(lane) || !occurrenceKey(occurrence)) refuse();
    const definition = definitions.get(lane); if (!definition) refuse();
    const { input, hash: inputHash } = inputCopy(definition.parseInput(raw));
    const token = randomUUID(), correlation = token;
    const selected = [workspaceId, lane, occurrence] as const;
    const scheduledJob = SCHEDULED_JOBS.find(job => job.id === lane);
    const publishAttempts = async (tx: Transaction, row: Stored): Promise<void> => {
      if (!scheduledJob) return;
      // Same transaction as terminal attempt evidence: retrying delivery cannot
      // turn one firing into two feed entries or lose its operational outcome.
      const skipped = Object.values(row.steps).length > 0 && Object.values(row.steps).every(step => step.state === 'skipped');
      await tx.execute(`INSERT INTO noticeos.job_runs
        (workspace_id,job,scheduled_at,started_at,finished_at,outcome,detail,recorded_at)
        SELECT workspace_id,$4,NULL,started_at,finished_at,
          CASE WHEN state='succeeded' THEN CASE WHEN $5::boolean THEN 'skipped' ELSE 'ran' END
            WHEN state='blocked' THEN 'skipped' ELSE 'failed' END,
          'hosted:'||state,clock_timestamp()
        FROM noticeos.hosted_job_attempts
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND finished_at IS NOT NULL
        ON CONFLICT(workspace_id,job,started_at) DO NOTHING`, [...selected, jobRunName(scheduledJob), skipped]);
    };
    const same = (row: Stored): void => {
      if (row.service_id !== serviceId || row.definition_hash !== definition.hash || row.input_hash !== inputHash) refuse();
    };
    const owns = (row: Stored | null): Stored => {
      if (!row || row.lease_id !== token || row.state !== 'running') refuse(); same(row); return row;
    };
    const finish = async (state: State): Promise<HostedJobReceipt> => write(async tx => {
      const row = owns(await locked(tx, lane, occurrence));
      await tx.execute(`UPDATE noticeos.hosted_job_occurrences SET state=$4,updated_at=clock_timestamp()
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3`, [...selected, state]);
      await tx.execute(`UPDATE noticeos.hosted_job_attempts SET state=$4,finished_at=clock_timestamp()
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND lease_id=$5::uuid`, [...selected, state, token]);
      await publishAttempts(tx, row);
      return receipt({ ...row, state });
    });
    const start = await fresh('workflows.run', correlation, async () => write(async tx => {
      // A conflicting insert may wait for another tiny claim transaction. Its
      // ownership is checked again under the row lock before any effect starts.
      await tx.execute(`INSERT INTO noticeos.hosted_job_occurrences
        (workspace_id,lane,occurrence,service_id,definition_hash,input_hash,state,attempt,lease_id,lease_expires_at)
        VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,'retryable',0,$7::uuid,clock_timestamp())
        ON CONFLICT(workspace_id,lane,occurrence) DO NOTHING`, [...selected, serviceId, definition.hash, inputHash, token]);
      const row = await locked(tx, lane, occurrence); if (!row) refuse(); same(row);
      if (['succeeded', 'uncertain', 'exhausted'].includes(row.state)) return receipt(row);
      if (row.state === 'running' && !row.expired) return receipt(row, 'busy');
      if (row.effect_step !== null || row.attempt >= ATTEMPTS) {
        const state = row.effect_step !== null ? 'uncertain' : 'exhausted';
        await tx.execute(`UPDATE noticeos.hosted_job_occurrences SET state=$4,updated_at=clock_timestamp()
          WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3`, [...selected, state]);
        await tx.execute(`UPDATE noticeos.hosted_job_attempts SET state=$4,finished_at=clock_timestamp()
          WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND finished_at IS NULL`, [...selected, state]);
        await publishAttempts(tx, row);
        return receipt({ ...row, state });
      }
      await tx.execute(`UPDATE noticeos.hosted_job_attempts SET state='retryable',finished_at=clock_timestamp()
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3 AND finished_at IS NULL`, selected);
      await publishAttempts(tx, row);
      await tx.execute(`UPDATE noticeos.hosted_job_occurrences SET state='running',attempt=attempt+1,
        lease_id=$4::uuid,lease_expires_at=clock_timestamp()+$5::int*interval '1 second',updated_at=clock_timestamp()
        WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3`, [...selected, token, LEASE_SECONDS]);
      await tx.execute(`INSERT INTO noticeos.hosted_job_attempts(workspace_id,lane,occurrence,attempt,lease_id,state)
        VALUES($1::uuid,$2,$3,$4,$5::uuid,'running')`, [...selected, row.attempt + 1, token]);
      return null;
    }));
    if (start) return start;
    for (const step of definition.steps) {
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), EFFECT_MS);
      const startedAt = new Date().toISOString();
      let effectStarted = false, startAttempted = false, admitted = false;
      try {
        await fresh(step.action, correlation, async context => {
          admitted = true;
          const call: StepCall = { context, occurrence, input, signal: controller.signal };
          const mark = async (tx: Transaction, row: Stored, evidence: Evidence): Promise<void> => {
            await tx.execute(`UPDATE noticeos.hosted_job_occurrences SET steps=$4::jsonb,effect_step=NULL,
              lease_expires_at=clock_timestamp()+$5::int*interval '1 second',updated_at=clock_timestamp()
              WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3`, [...selected, JSON.stringify({ ...row.steps, [step.key]: { ...evidence, attempt: row.attempt } }), LEASE_SECONDS]);
          };
          if (step.kind === 'database') {
            await write(async tx => {
              const row = owns(await locked(tx, lane, occurrence));
              if (Object.hasOwn(row.steps, step.key)) return;
              if (row.effect_step !== null) refuse();
              if (controller.signal.aborted) refuse();
              const value = await step.run(call, tx);
              if (controller.signal.aborted) refuse();
              await mark(tx, row, observed(value, startedAt));
            });
          } else {
            const shouldRun = await write(async tx => {
              const row = owns(await locked(tx, lane, occurrence));
              if (Object.hasOwn(row.steps, step.key)) return false;
              if (row.effect_step !== null) refuse();
              // A lost COMMIT acknowledgement must not be called retryable.
              startAttempted = true;
              await tx.execute(`UPDATE noticeos.hosted_job_occurrences SET effect_step=$4,
                lease_expires_at=clock_timestamp()+$5::int*interval '1 second',updated_at=clock_timestamp()
                WHERE workspace_id=$1::uuid AND lane=$2 AND occurrence=$3`, [...selected, step.key, LEASE_SECONDS]);
              return true;
            });
            if (!shouldRun) return;
            effectStarted = true;
            if (controller.signal.aborted) refuse();
            const value = await step.run(call);
            if (controller.signal.aborted) refuse();
            const evidence = observed(value, startedAt);
            await write(async tx => {
              const row = owns(await locked(tx, lane, occurrence));
              if (row.effect_step !== step.key) refuse();
              await mark(tx, row, evidence);
            });
          }
        });
      } catch {
        // Never persist the exception: providers may include credentials or
        // private bodies. Failure after an outside start cannot prove no effect.
        return finish(effectStarted || startAttempted ? 'uncertain' : admitted ? 'retryable' : 'blocked');
      } finally { clearTimeout(timer); controllers.delete(controller); }
    }
    return finish('succeeded');
  }
  return Object.freeze({
    run(lane: string, occurrence: string, input: unknown) {
      const work = execute(lane, occurrence, input).catch(() => refuse()); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    close() {
      if (closing) return closing;
      closed = true; for (const controller of controllers) controller.abort();
      closing = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => store.close()), Promise.resolve().then(() => grant.close()),
        ]);
        if (results.some(result => result.status === 'rejected')) refuse();
      })();
      return closing;
    },
  });
}
