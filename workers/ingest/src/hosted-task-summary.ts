import { javascriptInstant } from '@noticeos/postgres';
import { isolateState } from './isolate-state.js';
import { assertHostedTaskReadAccess, hostedTaskChanges, readHostedTaskBoards } from '../../../scripts/hosted-task-summary.mjs';
import { TaskServiceUnavailable } from '../../../scripts/task-records.mjs';
import { callNtasks, TaskServiceError } from './ntasks.js';
import { readHostedTaskConnection } from './routes/hosted-task-service.js';
import { isRecord } from './shared.js';
import { writeTaskSnapshot, type HostedTaskSnapshotSource } from './task-snapshots.js';

const CHECK_INTERVAL_MS = 60_000;
const BOARD_MAX_AGE_MS = 15 * 60_000;
const REFRESH_DEADLINE_MS = 5_000;
const RECENT_ATTEMPTS = 256;
const attempts = new Map<string, number>();
isolateState('Ntasks summary checks', { forget: () => attempts.clear(), held: () => attempts.size > 0 });

function sourceOf(raw: string | null | undefined): HostedTaskSnapshotSource | null {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; } catch { return null; }
  if (!isRecord(value) || typeof value.mapping !== 'string' || typeof value.checkedAt !== 'string'
    || typeof value.boardReadAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))
    || !Number.isFinite(Date.parse(value.boardReadAt)) || typeof value.cursor !== 'number'
    || !Number.isSafeInteger(value.cursor) || value.cursor < 0) return null;
  return { mapping: value.mapping, checkedAt: value.checkedAt, boardReadAt: value.boardReadAt, cursor: value.cursor };
}

/** Only a Wall or Work read can request this refresh. A weak network keeps
 * the last published summary and its date. Timing covers an entire attempt. */
export async function refreshHostedTaskSummary(env: IngestEnv, { fetchImpl = fetch, now = Date.now } = {}): Promise<boolean> {
  if (!env.NOTICEOS_NTASKS_ORIGIN) return false;
  const workspace = await env.STORE.workspaceId();
  const started = now();
  if (started - (attempts.get(workspace) ?? -Infinity) < CHECK_INTERVAL_MS) return false;
  attempts.delete(workspace);
  if (attempts.size >= RECENT_ATTEMPTS) attempts.delete(attempts.keys().next().value!);
  attempts.set(workspace, started);
  const [latest] = await env.STORE.read(tx => tx.query<{ snapshot_id: bigint; captured_at: string; source: string | null }>(
    `SELECT snapshot_id, captured_at, (payload -> 'ntasks')::text AS source FROM noticeos.task_snapshots
      ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1`));
  const prior = sourceOf(latest?.source);
  if (prior && started - Date.parse(prior.checkedAt) < CHECK_INTERVAL_MS) return false;

  const deadline = started + REFRESH_DEADLINE_MS;
  const boundedFetch: typeof fetch = (input, init) => {
    const remaining = deadline - now();
    if (remaining <= 0) return Promise.reject(new Error('Task summary deadline reached.'));
    const signal = AbortSignal.timeout(remaining);
    return fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  };
  // An authoritative loss of access retires the current summary. History
  // stays dated, and a transport failure leaves the current summary intact.
  const retire = async () => {
    if (!prior || prior.mapping === 'unavailable') return;
    const at = new Date(started).toISOString();
    await writeTaskSnapshot(env, { capturedAt: at, projects: [] }, now(),
      { mapping: 'unavailable', cursor: 0, checkedAt: at, boardReadAt: at });
  };
  try {
    const connection = await readHostedTaskConnection(env, boundedFetch);
    if (connection === null) { await retire(); return false; }
    const { credential, workspaceId } = connection;
    const mapping = JSON.stringify([credential.connectionId, credential.secretVersion, workspaceId,
      connection.projects.map(project => [project.asset, project.prefix, project.project?.projectId ?? null])]);
    const previous = prior?.mapping === mapping ? prior : null;
    const service = { async call({ method, path }: { method: 'GET'; path: string }) {
      const statusOnly = path.startsWith('/api/changes?') ? [400, 410] : undefined;
      const reply = await callNtasks(credential.fields, { method, path, workspaceId, statusOnly }, boundedFetch).catch(error => {
        if (error instanceof TaskServiceError) assertHostedTaskReadAccess(error.failure.status);
        throw error;
      });
      assertHostedTaskReadAccess(reply.status);
      return reply;
    } };
    const feed = await hostedTaskChanges(service, previous?.cursor ?? 0);
    const checkedAt = new Date(now()).toISOString();
    if (!await connection.stillCurrent()) return false;
    if (latest && previous && feed.complete && !feed.reset && started - Date.parse(previous.boardReadAt) < BOARD_MAX_AGE_MS
      && ![...feed.changed].some(project => connection.selectedIds.has(project))) {
      // An interrupted or concurrent capture cannot move a newer row's cursor.
      await env.STORE.write(async tx => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('noticeos.task_snapshots:' || $1, 0))`, [tx.workspaceId]);
        await tx.execute(`UPDATE noticeos.task_snapshots SET captured_at = $1::timestamptz,
              payload = jsonb_set(payload, '{ntasks}', $2::jsonb)
            WHERE snapshot_id = (SELECT snapshot_id FROM noticeos.task_snapshots ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1)
              AND snapshot_id = $3 AND captured_at = $4::timestamptz`,
          [checkedAt, JSON.stringify({ ...previous, cursor: feed.cursor, checkedAt }), latest.snapshot_id, javascriptInstant(latest.captured_at)]);
      });
      return false;
    }
    const projects = await readHostedTaskBoards(service, connection.projects, now());
    const boardReadAt = new Date(now()).toISOString();
    // If a connection was replaced while the reads were in flight, do not
    // publish the old credential's data as the new connection's summary.
    if (!(await connection.stillCurrent())) return false;
    return (await writeTaskSnapshot(env, { capturedAt: boardReadAt, projects }, now(), { mapping, cursor: feed.cursor, checkedAt, boardReadAt })).ok;
  } catch (error) {
    if (error instanceof TaskServiceUnavailable && error.reason === 'refused'
      || error instanceof TaskServiceError && ['access', 'configuration'].includes(error.failure.kind)) await retire();
    return false;
  }
}
