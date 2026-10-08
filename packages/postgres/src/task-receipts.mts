// Retry-safe hosted task writes (epic ro-cvl9; migration 0012).
//
// A receipt binds one idempotency key, scoped to a workspace, principal and
// operation, to the exact request it first carried and to a server-generated
// operation identity. The caller authorizes first and opens the workspace
// transaction; this module grants nothing and runs no task command.
//
// States: `pending` (an attempt that may still be running), `interrupted` (an
// attempt that ended with an unknown outcome) and `succeeded` (the recorded
// outcome). Every transition is a compare-and-set on the attempt number, so two
// callers holding the same receipt cannot both start an effect.
import { javascriptInstant, type PostgresStore, type Transaction } from './store.mjs';

export type TaskReceiptOperation = 'create' | 'update' | 'comment' | 'close';
export type TaskReceiptState = 'pending' | 'interrupted' | 'succeeded';
export interface TaskReceiptIdentity {
  /** The authenticated principal from current admission, never a client label. */
  readonly principalId: string;
  readonly operation: TaskReceiptOperation;
  readonly idempotencyKey: string;
}
export interface TaskReceiptRequest extends TaskReceiptIdentity {
  readonly projectId: string;
  /** SHA-256 of the canonical request the key is bound to. */
  readonly requestHash: string;
}
export interface TaskReceipt {
  readonly operationId: string;
  readonly state: TaskReceiptState;
  readonly attempt: number;
  /** The recorded outcome; null until the receipt succeeds. */
  readonly result: unknown;
  /** When the key was first used; fixed across attempts. */
  readonly createdAt: string;
  /** When the current attempt started. */
  readonly startedAt: string;
  readonly finishedAt: string | null;
}
export type TaskReceiptStart =
  | { readonly kind: 'started'; readonly receipt: TaskReceipt }
  | { readonly kind: 'existing'; readonly receipt: TaskReceipt }
  /** The key was first used for another project or request content. */
  | { readonly kind: 'conflict' };
export interface TaskReceiptAttempt {
  readonly operationId: string;
  readonly attempt: number;
}

export const TASK_RECEIPT_ATTEMPTS = 5;
/** Days a receipt is kept after its last attempt. Migration 0013's trigger
 * refuses removing one sooner; a retry after that runs as a new change. */
export const TASK_RECEIPT_KEEP_DAYS = 7;
export const TASK_RECEIPT_RESULT_BYTES = 65536;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const OPERATIONS: readonly string[] = ['create', 'update', 'comment', 'close'];
const COLUMNS = `operation_id AS "operationId", state, attempt, result::text AS result,
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;
const KEY = 'workspace_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key=$4';

export class TaskReceiptRefused extends Error {
  override name = 'TaskReceiptRefused';
  constructor() { super('Task operation receipt refused.'); }
}
function refused(): never { throw new TaskReceiptRefused(); }
function matches(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) refused();
  return value;
}
function identity(tx: Transaction, input: TaskReceiptIdentity): string[] {
  if (!input || typeof input !== 'object') refused();
  if (typeof input.operation !== 'string' || !OPERATIONS.includes(input.operation)) refused();
  return [matches(tx.workspaceId, UUID), matches(input.principalId, PRINCIPAL), input.operation,
    matches(input.idempotencyKey, IDEMPOTENCY_KEY)];
}
function attemptOf(input: TaskReceiptAttempt): [string, number] {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1 || input.attempt > TASK_RECEIPT_ATTEMPTS) refused();
  return [matches(input.operationId, UUID), input.attempt];
}
function receipt(row: Record<string, unknown> | undefined): TaskReceipt {
  if (!row || typeof row.operationId !== 'string' || !UUID.test(row.operationId)
    || !['pending', 'interrupted', 'succeeded'].includes(row.state as string)
    || typeof row.attempt !== 'number' || typeof row.createdAt !== 'string' || typeof row.startedAt !== 'string'
    || row.finishedAt !== null && typeof row.finishedAt !== 'string'
    || row.result !== null && typeof row.result !== 'string') refused();
  return Object.freeze({
    operationId: row.operationId, state: row.state as TaskReceiptState, attempt: row.attempt,
    result: row.result === null ? null : JSON.parse(row.result) as unknown,
    createdAt: javascriptInstant(row.createdAt), startedAt: javascriptInstant(row.startedAt),
    finishedAt: row.finishedAt === null ? null : javascriptInstant(row.finishedAt as string),
  });
}

/** Insert a new pending receipt, or return the existing one when the same key
 * already carries the same project and request. The workspace's expired
 * receipts go first, so an expired key starts afresh. */
export async function startTaskReceipt(tx: Transaction, request: TaskReceiptRequest,
  operationId: string): Promise<TaskReceiptStart> {
  const key = identity(tx, request);
  const project = matches(request.projectId, UUID), hash = matches(request.requestHash, /^[0-9a-f]{64}$/u);
  const id = matches(operationId, UUID);
  await tx.execute(
    `DELETE FROM noticeos.task_operation_receipts WHERE workspace_id=$1::uuid
        AND COALESCE(finished_at, started_at) < pg_catalog.now() - interval '${TASK_RECEIPT_KEEP_DAYS} days'`, [key[0]!]);
  const [inserted] = await tx.query(
    `INSERT INTO noticeos.task_operation_receipts (workspace_id,principal_id,operation,idempotency_key,
       project_id,request_hash,operation_id,state,attempt)
     VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7::uuid,'pending',1)
     ON CONFLICT (workspace_id,principal_id,operation,idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`, [...key, project, hash, id]);
  if (inserted) return Object.freeze({ kind: 'started', receipt: receipt(inserted) });
  const [found] = await tx.query(
    `SELECT project_id::text AS "projectId", request_hash AS "requestHash", ${COLUMNS}
       FROM noticeos.task_operation_receipts WHERE ${KEY}`, key);
  if (!found) refused();
  if (found.projectId !== project || found.requestHash !== hash) return Object.freeze({ kind: 'conflict' });
  return Object.freeze({ kind: 'existing', receipt: receipt(found) });
}

/** Record the outcome of the named attempt. False when another caller moved
 * the receipt on first. */
export async function finishTaskReceipt(tx: Transaction, identityInput: TaskReceiptIdentity,
  attempt: TaskReceiptAttempt, result: unknown): Promise<boolean> {
  const key = identity(tx, identityInput), [id, number] = attemptOf(attempt);
  let text: string;
  try { text = JSON.stringify(result); } catch { refused(); }
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > TASK_RECEIPT_RESULT_BYTES) refused();
  return await tx.execute(
    `UPDATE noticeos.task_operation_receipts
        SET state='succeeded', result=$7::jsonb, finished_at=pg_catalog.clock_timestamp()
      WHERE ${KEY} AND operation_id=$5::uuid AND attempt=$6 AND state IN ('pending','interrupted')`,
    [...key, id, number, text]) === 1;
}

/** The attempt ended without a known outcome. */
export async function interruptTaskReceipt(tx: Transaction, identityInput: TaskReceiptIdentity,
  attempt: TaskReceiptAttempt): Promise<boolean> {
  const key = identity(tx, identityInput), [id, number] = attemptOf(attempt);
  return await tx.execute(
    `UPDATE noticeos.task_operation_receipts SET state='interrupted', finished_at=pg_catalog.clock_timestamp()
      WHERE ${KEY} AND operation_id=$5::uuid AND attempt=$6 AND state='pending'`,
    [...key, id, number]) === 1;
}

/** Start the next attempt of an interrupted or abandoned receipt. Null when
 * another caller started it first or the attempts are spent. */
export async function retryTaskReceipt(tx: Transaction, identityInput: TaskReceiptIdentity,
  attempt: TaskReceiptAttempt & { readonly state: 'pending' | 'interrupted' }): Promise<TaskReceipt | null> {
  const key = identity(tx, identityInput), [id, number] = attemptOf(attempt);
  if (attempt.state !== 'pending' && attempt.state !== 'interrupted') refused();
  const [row] = await tx.query(
    `UPDATE noticeos.task_operation_receipts
        SET state='pending', attempt=attempt+1, started_at=pg_catalog.clock_timestamp(), finished_at=NULL
      WHERE ${KEY} AND operation_id=$5::uuid AND attempt=$6 AND state=$7 AND attempt<${TASK_RECEIPT_ATTEMPTS}
      RETURNING ${COLUMNS}`, [...key, id, number, attempt.state]);
  return row ? receipt(row) : null;
}

/** The same transitions, each in its own transaction in the named workspace. */
export interface TaskReceipts {
  start(workspaceId: string, request: TaskReceiptRequest, operationId: string): Promise<TaskReceiptStart>;
  finish(workspaceId: string, identity: TaskReceiptIdentity, attempt: TaskReceiptAttempt, result: unknown): Promise<boolean>;
  interrupt(workspaceId: string, identity: TaskReceiptIdentity, attempt: TaskReceiptAttempt): Promise<boolean>;
  retry(workspaceId: string, identity: TaskReceiptIdentity,
    attempt: TaskReceiptAttempt & { readonly state: 'pending' | 'interrupted' }): Promise<TaskReceipt | null>;
}
export function taskReceipts(store: Pick<PostgresStore, 'inWorkspace'>): TaskReceipts {
  if (!store || typeof store.inWorkspace !== 'function') refused();
  const scoped = (workspaceId: string) => matches(workspaceId, UUID);
  return Object.freeze({
    start: (workspaceId, request, operationId) => store.inWorkspace(scoped(workspaceId), tx => startTaskReceipt(tx, request, operationId)),
    finish: (workspaceId, identity, attempt, result) => store.inWorkspace(scoped(workspaceId), tx => finishTaskReceipt(tx, identity, attempt, result)),
    interrupt: (workspaceId, identity, attempt) => store.inWorkspace(scoped(workspaceId), tx => interruptTaskReceipt(tx, identity, attempt)),
    retry: (workspaceId, identity, attempt) => store.inWorkspace(scoped(workspaceId), tx => retryTaskReceipt(tx, identity, attempt)),
  } satisfies TaskReceipts);
}
