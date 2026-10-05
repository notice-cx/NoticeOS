/** Server-composed task photograph. Reuses the ordinary poller's summary;
 * neither project labels nor a snapshot carry task or workspace authority. */
import type { BeadsProjectInput, BeadsSnapshotInput } from '../packages/contract/src/task-snapshot.mjs';
import type { HostedTaskExecutor, TaskVerificationControls } from './hosted-task-executor.mjs';
import { beadsClosedSince, summarizeBeadsProject } from './task-snapshot-summary.mjs';

export interface HostedTaskSnapshotProject {
  readonly projectId: string;
  readonly asset: string;
  readonly prefix: string;
}
export interface HostedTaskSnapshotOptions {
  readonly workspaceId: string;
  readonly projects: readonly HostedTaskSnapshotProject[];
  readonly executor: Pick<HostedTaskExecutor, 'execute'>;
}
export type HostedBeadsSnapshot = BeadsSnapshotInput & { capturedAt: string };
export interface HostedTaskSnapshotReader {
  snapshot(original: Request, controls?: Omit<TaskVerificationControls, 'expectedPrefix'>): Promise<HostedBeadsSnapshot>;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function refused(): never { throw new Error('Scoped task snapshot unavailable.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refused();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refused();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field || !('value' in field)) refused();
    result[key] = field.value as unknown;
  }
  return result;
}

export function createHostedTaskSnapshot(options: HostedTaskSnapshotOptions): HostedTaskSnapshotReader {
  const workspaceId = options.workspaceId, executor = options.executor;
  if (!UUID.test(workspaceId) || typeof executor?.execute !== 'function'
    || !Array.isArray(options.projects) || options.projects.length > 64) refused();
  const projects = options.projects.map(value => {
    const row = record(value);
    if (Object.keys(row).length !== 3 || !['projectId', 'asset', 'prefix'].every(key => Object.hasOwn(row, key))
      || typeof row.projectId !== 'string' || !UUID.test(row.projectId)
      || typeof row.asset !== 'string' || !row.asset.trim() || row.asset.length > 255 || /[\u0000-\u001f\u007f]/u.test(row.asset)
      || typeof row.prefix !== 'string' || !/^[a-z0-9]{1,32}$/u.test(row.prefix)) refused();
    return Object.freeze({ projectId: row.projectId, asset: row.asset, prefix: row.prefix });
  });
  if (new Set(projects.map(row => row.projectId)).size !== projects.length
    || new Set(projects.map(row => row.asset)).size !== projects.length) refused();
  const execute = executor.execute.bind(executor);
  return Object.freeze({
    async snapshot(original: Request, controls?: Omit<TaskVerificationControls, 'expectedPrefix'>): Promise<HostedBeadsSnapshot> {
      if (!(original instanceof Request)) refused();
      const now = Date.now(), supplied = controls === undefined ? {} : record(controls);
      if (Object.keys(supplied).some(key => !['signal', 'deadline'].includes(key))
        || supplied.signal !== undefined && !(supplied.signal instanceof AbortSignal)
        || supplied.deadline !== undefined && (typeof supplied.deadline !== 'number' || !Number.isFinite(supplied.deadline))) refused();
      const deadline = Math.min(now + 30_000, supplied.deadline as number | undefined ?? Infinity);
      const signal = supplied.signal === undefined ? original.signal : AbortSignal.any([original.signal, supplied.signal as AbortSignal]);
      if (!Number.isFinite(now) || deadline <= now || signal.aborted) refused();
      // Snapshot original trusted request evidence synchronously, without
      // retaining an unused body tee or manufacturing browser headers.
      const proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal });
      const closedSince = beadsClosedSince(now), entries: BeadsProjectInput[] = [];
      for (const project of projects) {
        if (signal.aborted || Date.now() >= deadline) refused();
        const results = await execute(proof, workspaceId,
          { projectId: project.projectId, operation: { kind: 'snapshot', closedSince } },
          { signal, deadline, expectedPrefix: project.prefix });
        if (signal.aborted || Date.now() >= deadline) refused();
        entries.push(summarizeBeadsProject(project, results));
      }
      return { capturedAt: new Date(now).toISOString(), projects: entries };
    },
  });
}
