/** Actual Node hosting composition. No installation discovery, CLI request
 * flags, customer paths or remote credentials are accepted from HTTP callers.
 * The server supplies an immutable physical registry and qualified tool pins.
 */
import { openIdentity, type IdentityOptions } from '../packages/postgres/src/identity.mjs';
import { openTaskDirectory, type TaskProjectMapping } from '../packages/postgres/src/task-directory.mjs';
import { createWorkspaceAdmission, type WorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor, type HostedTaskTarget, type HostedTaskExecutorOptions } from './hosted-task-executor.mjs';
import { createHostedTasksApi } from './hosted-tasks-api.mjs';
import { createBrowserRequestPolicy } from './browser-request-policy.mjs';

export interface HostedTaskRuntimeOptions {
  readonly profile: 'hosted' | 'demo';
  readonly trustedOrigin: string;
  readonly demoWorkspaceId?: string;
  readonly identity: IdentityOptions;
  readonly directoryConnectionString: string;
  readonly targets: readonly { readonly mapping: TaskProjectMapping; readonly target: HostedTaskTarget }[];
  readonly binary: HostedTaskExecutorOptions['binary'];
  readonly doltBinary: HostedTaskExecutorOptions['doltBinary'];
  readonly scratchRoot: string;
}
export interface HostedTaskRuntime {
  readonly profile: 'hosted' | 'demo';
  readonly origin: string;
  handle(original: Request): Promise<Response>;
  close(): Promise<void>;
}
function invalid(): never { throw new Error('Hosted Tasks server configuration refused'); }
function data(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function exact(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function mapping(input: unknown): TaskProjectMapping {
  const row = data(input); exact(row, ['workspaceId', 'projectId', 'executorRef', 'credentialRef', 'databaseKey']);
  for (const key of ['workspaceId', 'projectId', 'executorRef', 'credentialRef']) {
    if (typeof row[key] !== 'string' || !UUID.test(row[key])) invalid();
  }
  if (typeof row.databaseKey !== 'string' || !/^n_[0-9a-f]{32}$/u.test(row.databaseKey)) invalid();
  return Object.freeze(row) as unknown as TaskProjectMapping;
}
function target(input: unknown): HostedTaskTarget {
  const row = data(input); exact(row, ['cwd', 'clientProfile', 'grantVerifierProfile', 'beadsProjectId', 'tls']);
  for (const key of ['cwd', 'clientProfile', 'grantVerifierProfile']) {
    if (typeof row[key] !== 'string' || !row[key].startsWith('/') || /[\r\n\0]/u.test(row[key])) invalid();
  }
  if (typeof row.beadsProjectId !== 'string' || !UUID.test(row.beadsProjectId) || typeof row.tls !== 'boolean') invalid();
  return Object.freeze(row) as unknown as HostedTaskTarget;
}
function tool(input: unknown): HostedTaskExecutorOptions['binary'] {
  const row = data(input); exact(row, ['path', 'sha256']);
  if (typeof row.path !== 'string' || !row.path.startsWith('/') || /[\r\n\0]/u.test(row.path)
    || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.sha256)) invalid();
  return Object.freeze({ path: row.path, sha256: row.sha256 });
}
/** Capture structural server configuration before an asynchronous preflight.
 * This is not authentication; HTTP callers never supply this configuration. */
export function captureHostedTaskRuntimeOptions(input: HostedTaskRuntimeOptions): HostedTaskRuntimeOptions {
  const row = data(input); exact(row, ['profile', 'trustedOrigin', 'identity', 'directoryConnectionString', 'targets', 'binary', 'doltBinary', 'scratchRoot'], ['demoWorkspaceId']);
  if (!['hosted', 'demo'].includes(row.profile as string) || typeof row.trustedOrigin !== 'string') invalid();
  const origin = createBrowserRequestPolicy(row.trustedOrigin).origin;
  const profile = row.profile as 'hosted' | 'demo';
  const demo = row.demoWorkspaceId;
  if (profile === 'demo' && (typeof demo !== 'string' || !UUID.test(demo))
    || profile === 'hosted' && demo !== undefined) invalid();
  const identityOptions = data(row.identity); exact(identityOptions, ['connectionString', 'trustedOrigin', 'sessionSecret']);
  if (identityOptions.trustedOrigin !== origin || typeof identityOptions.connectionString !== 'string'
    || typeof identityOptions.sessionSecret !== 'string') invalid();
  if (!Array.isArray(row.targets) || row.targets.length > 4096) invalid();
  const targets = new Map<string, { readonly mapping: TaskProjectMapping; readonly target: HostedTaskTarget }>();
  for (let index = 0; index < row.targets.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(row.targets, String(index));
    if (!descriptor || !('value' in descriptor)) invalid();
    const allocation = data(descriptor.value); exact(allocation, ['mapping', 'target']);
    const selected = mapping(allocation.mapping), physical = target(allocation.target);
    const key = `${selected.workspaceId}/${selected.projectId}`;
    if (targets.has(key)) invalid(); targets.set(key, Object.freeze({ mapping: selected, target: physical }));
  }
  if (Reflect.ownKeys(row.targets).length !== row.targets.length + 1) invalid();
  const binary = tool(row.binary), doltBinary = tool(row.doltBinary);
  if (typeof row.scratchRoot !== 'string' || !row.scratchRoot.startsWith('/') || /[\r\n\0]/u.test(row.scratchRoot)) invalid();
  const scratchRoot = row.scratchRoot;
  if (typeof row.directoryConnectionString !== 'string') invalid();
  return Object.freeze({ profile, trustedOrigin: origin,
    ...(profile === 'demo' ? { demoWorkspaceId: demo as string } : {}),
    identity: Object.freeze({ connectionString: identityOptions.connectionString, trustedOrigin: origin, sessionSecret: identityOptions.sessionSecret }),
    directoryConnectionString: row.directoryConnectionString,
    targets: Object.freeze([...targets.values()]), binary, doltBinary, scratchRoot });
}
export async function openHostedTaskRuntime(input: HostedTaskRuntimeOptions): Promise<HostedTaskRuntime> {
  const configuration = captureHostedTaskRuntimeOptions(input);
  const { profile, trustedOrigin: origin, demoWorkspaceId: demo, identity: identityOptions, binary, doltBinary, scratchRoot } = configuration;
  const targets = new Map(configuration.targets.map(allocation => [`${allocation.mapping.workspaceId}/${allocation.mapping.projectId}`, allocation]));
  // No pool opens for malformed composition above. Directory construction is
  // lazy; the supported identity factory validates its separate role/schema.
  const directory = openTaskDirectory({ connectionString: configuration.directoryConnectionString });
  let identity: Awaited<ReturnType<typeof openIdentity>> | undefined;
  try {
    identity = await openIdentity(Object.freeze({ connectionString: identityOptions.connectionString,
      trustedOrigin: origin, sessionSecret: identityOptions.sessionSecret }));
    const facts = identity;
    const admission: WorkspaceAdmission = profile === 'hosted'
      ? createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
        membership: (headers, workspaceId) => facts.admissionMembership(headers, workspaceId) })
      : createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: demo as string,
        workspaceStatus: async () => (await facts.workspaceSummary(demo as string))?.status ?? null });
    const executor = createHostedTaskExecutor({ admission, directory, binary, doltBinary, scratchRoot,
      resolveTarget: async selected => {
        const found = targets.get(`${selected.workspaceId}/${selected.projectId}`);
        if (!found || Object.keys(found.mapping).some(key => found.mapping[key as keyof TaskProjectMapping] !== selected[key as keyof TaskProjectMapping])) return null;
        return found.target;
      } });
    const api = createHostedTasksApi({ profile, trustedOrigin: origin, ...(profile === 'demo' ? { demoWorkspaceId: demo as string } : {}), admission, directory, executor,
      workspaceActors: workspaceId => facts.workspaceActors(workspaceId) });
    let closed = false, closing: Promise<void> | undefined;
    const pending = new Set<Promise<Response>>();
    return Object.freeze({ profile, origin,
      handle(original: Request) {
        if (closed) return Promise.resolve(Response.json({ error: 'hosted_task_unavailable' }, { status: 503 }));
        const work = api(original); pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
      },
      close() {
        if (closing) return closing; closed = true;
        closing = (async () => {
          await Promise.allSettled([...pending]);
          const results = await Promise.allSettled([directory.close(), facts.close()]);
          for (const result of results) if (result.status === 'rejected') throw result.reason;
        })();
        return closing;
      },
    });
  } catch {
    await Promise.allSettled([directory.close(), identity?.close()]); invalid();
  }
}
