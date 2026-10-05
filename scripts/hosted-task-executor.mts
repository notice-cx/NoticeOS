/** Node-only fixed-command task executor. No HTTP/RPC entry is activated here.
 * Server composition owns admission, directory, physical targets and tools.
 * A typed operation does not prove that an HTTP body was bound to that operation;
 * the eventual entry must derive it from the actual incoming request.
 */
import fs from 'node:fs/promises';
import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { TaskDirectory, TaskProjectMapping } from '../packages/postgres/src/task-directory.mjs';
import type { WorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskPlanner, hostedTaskAction, type HostedTaskRequest } from './hosted-task-command.mjs';
import { beadsClosedSince, beadsPollArgs } from './task-snapshot-summary.mjs';
import { readDeclaredTaskClient, taskClientEnvironment } from './task-client.mjs';

export interface HostedTaskTarget {
  /** Fixed server-owned initialized project folder, never a request path. */
  readonly cwd: string;
  readonly clientProfile: string;
  /** Separate server-owned inspection identity: exactly USAGE + SELECT mysql.*.
   * It can read privilege metadata, including credential hashes, but cannot
   * modify grants/data or read tenant tasks. Only fixed SHOW GRANTS queries are
   * exposed here; its credential never enters the Beads process/profile. */
  readonly grantVerifierProfile: string;
  /** Beads' initialized project identity, independent of the directory UUID. */
  readonly beadsProjectId: string;
  /** Same transport selection is enforced for both pinned clients. */
  readonly tls: boolean;
}
export interface HostedTaskExecutorOptions {
  readonly admission: WorkspaceAdmission;
  readonly directory: Pick<TaskDirectory, 'project'> & Partial<Pick<TaskDirectory, 'withProjectMutation'>>;
  readonly resolveTarget: (mapping: TaskProjectMapping) => Promise<HostedTaskTarget | null>;
  readonly binary: { readonly path: string; readonly sha256: string };
  readonly doltBinary: { readonly path: string; readonly sha256: string };
  /** Existing private, server-owned scratch directory; no ambient HOME/PATH. */
  readonly scratchRoot: string;
}
/** Server-only controls; never forwarded from an HTTP command. */
export interface TaskVerificationControls {
  readonly signal?: AbortSignal;
  /** Absolute milliseconds since epoch; may only shorten the fixed budget. */
  readonly deadline?: number;
  /** Platform catalog setup only; exact actual initialized Beads prefix. */
  readonly expectedPrefix?: string;
}
export interface VerifiedTaskProject {
  readonly mapping: TaskProjectMapping;
}
export interface HostedTaskExecutor {
  execute(proof: Request, serverSelectedWorkspaceId: string, request: HostedTaskRequest,
    controls?: TaskVerificationControls): Promise<unknown>;
  /** Platform-only initialization check. Caller must hold the canonical mapping
   * against rebinding/revocation through verification and activation COMMIT.
   * Neither this result nor a directory row authenticates a tenant request. */
  verifyProject(mapping: TaskProjectMapping, controls?: TaskVerificationControls): Promise<VerifiedTaskProject>;
  assertVerifiedProject(result: unknown, mapping: TaskProjectMapping): void;
}
export class HostedTaskRefused extends Error {
  override name = 'HostedTaskRefused';
  constructor() { super('Hosted task operation refused.'); }
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const BUDGET_MS = 30_000;
const OUTPUT_BYTES = 8 * 1024 ** 2;
function fail(): never { throw new HostedTaskRefused(); }
interface Lifetime { readonly deadline: number; readonly signal?: AbortSignal; readonly expectedPrefix?: string }
function lifetime(input?: TaskVerificationControls): Lifetime {
  const now = Date.now();
  if (!Number.isFinite(now)) fail();
  if (input === undefined) return Object.freeze({ deadline: now + BUDGET_MS });
  const row = record(input);
  if (Object.keys(row).some(key => !['signal', 'deadline', 'expectedPrefix'].includes(key))
    || row.signal !== undefined && !(row.signal instanceof AbortSignal)
    || row.deadline !== undefined && (typeof row.deadline !== 'number' || !Number.isFinite(row.deadline))
    || row.expectedPrefix !== undefined && (typeof row.expectedPrefix !== 'string' || !/^[a-z0-9]{1,32}$/u.test(row.expectedPrefix))) fail();
  const result = Object.freeze({ deadline: Math.min(now + BUDGET_MS, row.deadline as number | undefined ?? Infinity),
    ...(row.signal === undefined ? {} : { signal: row.signal as AbortSignal }),
    ...(row.expectedPrefix === undefined ? {} : { expectedPrefix: row.expectedPrefix as string }) });
  checkpoint(result); return result;
}
function checkpoint(life: Lifetime): void {
  const now = Date.now();
  if (!Number.isFinite(now) || now >= life.deadline || life.signal?.aborted) fail();
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const proto = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) fail();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !field || !('value' in field)) fail();
    result[key] = field.value as unknown;
  }
  return result;
}
function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail();
}
function uuid(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) fail();
  return input;
}
function mapping(input: unknown): TaskProjectMapping {
  const row = record(input);
  exact(row, ['workspaceId', 'projectId', 'executorRef', 'credentialRef', 'databaseKey']);
  if (typeof row.databaseKey !== 'string' || !/^n_[0-9a-f]{32}$/u.test(row.databaseKey)) fail();
  return Object.freeze({ workspaceId: uuid(row.workspaceId), projectId: uuid(row.projectId),
    executorRef: uuid(row.executorRef), credentialRef: uuid(row.credentialRef), databaseKey: row.databaseKey });
}
function sameMapping(a: TaskProjectMapping, b: TaskProjectMapping): boolean {
  return a.workspaceId === b.workspaceId && a.projectId === b.projectId && a.executorRef === b.executorRef
    && a.credentialRef === b.credentialRef && a.databaseKey === b.databaseKey;
}
function snapshotRequest(input: unknown, workspaceId: string): HostedTaskRequest {
  const row = record(input); exact(row, ['projectId', 'operation']);
  const projectId = uuid(row.projectId), operation = record(row.operation);
  // Reuse the strict planner before any authority or operational I/O. Its
  // deep command validation rejects unknown keys, getters and raw selectors.
  createHostedTaskPlanner([{ workspaceId, projectId, capability: Symbol() }])
    (workspaceId, { projectId, operation } as unknown as HostedTaskRequest);
  // New labels/metadata are data too. Copy them synchronously so a caller
  // cannot change the planned payload while fresh authority is being read.
  for (const [key, value] of Object.entries(operation)) {
    if (Array.isArray(value)) operation[key] = Object.freeze([...value]);
    else if (value !== null && typeof value === 'object') operation[key] = Object.freeze(record(value));
  }
  return Object.freeze({ projectId, operation: Object.freeze(operation) }) as unknown as HostedTaskRequest;
}
async function privateDirectory(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\r\n\0]/u.test(input)) fail();
  const canonical = await fs.realpath(input), stat = await fs.lstat(input);
  if (canonical !== path.resolve(input) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail();
  return canonical;
}
function captureClient(profilePath: unknown) {
  if (typeof profilePath !== 'string') fail();
  const client = Object.freeze(readDeclaredTaskClient(profilePath));
  const fd = openSync(client.credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384) fail();
    const text = readFileSync(fd, 'utf8'), prefix = `[${client.host}:${client.port}]\npassword=`;
    if (!text.startsWith(prefix) || !/^[^\r\n\0]+\n?$/u.test(text.slice(prefix.length))) fail();
    return Object.freeze({ client, password: text.slice(prefix.length).replace(/\n$/u, '') });
  } finally { closeSync(fd); }
}
function grantStrings(input: unknown): string[] {
  return rows(input).map(row => {
    const values = Object.values(row); if (values.length !== 1 || typeof values[0] !== 'string') fail(); return values[0];
  }).sort();
}
function rows(input: unknown): Record<string, unknown>[] {
  const value = Array.isArray(input) ? input : record(input).rows;
  if (!Array.isArray(value) || value.length > 4096) fail();
  return value.map(record);
}
const METADATA_SQL = `SELECT DATABASE() AS database_key,DOLT_VERSION() AS dolt_version,ACTIVE_BRANCH() AS branch,
  (SELECT MAX(version) FROM schema_migrations) AS schema_version,
  (SELECT value FROM metadata WHERE \`key\`='_project_id') AS project_id`;
const TABLES_SQL = `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('issues','comments','events','schema_migrations','metadata','config') ORDER BY TABLE_NAME`;
const BRANCH_SQL = `SELECT \`database\`,branch,user,host,permissions FROM dolt_branch_control
  WHERE user=SUBSTRING_INDEX(CURRENT_USER(),'@',1) ORDER BY \`database\`,branch,host`;

/** All subprocess work is direct, output-bounded and awaited through close.
 * Killing the owned process group prevents descendants retaining its profile. */
async function command(binary: string, argv: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv, life: Lifetime): Promise<string> {
  checkpoint(life);
  const remaining = life.deadline - Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...argv], { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, refused = false;
    const stop = () => {
      refused = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* close/error still owns settlement */ } }
    };
    const timer = setTimeout(stop, remaining);
    life.signal?.addEventListener('abort', stop, { once: true });
    if (life.signal?.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > OUTPUT_BYTES) stop(); else output += data;
    });
    // Never expose raw stderr, including credentials or connection details.
    child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > OUTPUT_BYTES) stop(); });
    child.once('error', () => { refused = true; });
    child.once('close', code => { clearTimeout(timer); life.signal?.removeEventListener('abort', stop); if (refused || code !== 0) reject(new HostedTaskRefused()); else resolve(output); });
  });
}

export function createHostedTaskExecutor(options: HostedTaskExecutorOptions): HostedTaskExecutor {
  const input = record(options); exact(input, ['admission', 'directory', 'resolveTarget', 'binary', 'doltBinary', 'scratchRoot']);
  if (!input.admission || typeof options.admission.withAdmission !== 'function'
    || typeof options.admission.assertContext !== 'function' || !input.directory
    || typeof options.directory.project !== 'function' || typeof input.resolveTarget !== 'function') fail();
  const tool = record(input.binary), sqlTool = record(input.doltBinary);
  exact(tool, ['path', 'sha256']); exact(sqlTool, ['path', 'sha256']);
  if (typeof tool.path !== 'string' || !path.isAbsolute(tool.path)
    || typeof tool.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(tool.sha256)
    || typeof sqlTool.path !== 'string' || !path.isAbsolute(sqlTool.path)
    || typeof sqlTool.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sqlTool.sha256)
    || typeof input.scratchRoot !== 'string' || !path.isAbsolute(input.scratchRoot)) fail();
  const binary = tool.path, binarySha = tool.sha256, doltBinary = sqlTool.path, doltSha = sqlTool.sha256, scratchRoot = input.scratchRoot;
  const admission: WorkspaceAdmission = options.admission;
  const directory = options.directory, resolveTarget = options.resolveTarget;
  const verified = new WeakMap<object, TaskProjectMapping>();
  async function current(expected: TaskProjectMapping, life: Lifetime, read = () => directory.project(expected.workspaceId, expected.projectId)): Promise<TaskProjectMapping> {
    checkpoint(life);
    const fresh = mapping(await read());
    checkpoint(life);
    if (!sameMapping(expected, fresh)) fail();
    return fresh;
  }
  async function ownedRun<T>(selected: TaskProjectMapping, life: Lifetime,
    work: (run: (args: readonly string[], plainSuccess?: boolean) => Promise<unknown>) => Promise<T>): Promise<T> {
    checkpoint(life);
    const supplied = record(await resolveTarget(selected));
    checkpoint(life); exact(supplied, ['cwd', 'clientProfile', 'grantVerifierProfile', 'beadsProjectId', 'tls']);
    if (typeof supplied.tls !== 'boolean') fail();
    // Capture both credentials synchronously before the next await. Rotation or
    // mutation cannot switch identities halfway through this operation.
    const taskCredential = captureClient(supplied.clientProfile), inspection = captureClient(supplied.grantVerifierProfile);
    const client = taskCredential.client, inspector = inspection.client;
    if (inspector.user === client.user || inspector.host !== client.host || inspector.port !== client.port
      || ['root', 'noticeos_owner'].includes(inspector.user)
      || !supplied.tls && !['127.0.0.1', 'localhost'].includes(client.host)) fail();
    const cwd = await privateDirectory(supplied.cwd), beadsProjectId = uuid(supplied.beadsProjectId);
    checkpoint(life);
    for (const [file, sha] of [[binary, binarySha], [doltBinary, doltSha]]) {
      checkpoint(life);
      const stat = await fs.lstat(file!);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)
        || await fs.realpath(file!) !== path.resolve(file!)
        || createHash('sha256').update(await fs.readFile(file!)).digest('hex') !== sha) fail();
    }
    const scratch = await privateDirectory(scratchRoot);
    const free = await fs.statfs(scratch);
    if (free.bavail * free.bsize < 8 * 1024 ** 3 + 64 * 1024 ** 2) fail();
    checkpoint(life);
    const home = await fs.mkdtemp(path.join(scratch, 'task-'));
    try {
      const ownCredentials = path.join(home, 'task-credentials');
      await fs.writeFile(ownCredentials, `[${client.host}:${client.port}]\npassword=${taskCredential.password}\n`, { mode: 0o600, flag: 'wx' });
      const env = taskClientEnvironment({ ...client, credentialsFile: ownCredentials, clientHome: home }, { PATH: '/usr/bin:/bin', TMPDIR: home, LANG: 'C.UTF-8' });
      Object.assign(env, { BEADS_DOLT_SERVER_TLS: supplied.tls ? 'true' : 'false', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
      const version = await command(binary, ['--version'], cwd, env, life);
      if (!/^bd version 1\.3\.1(?:\s|$)/u.test(version.trim())) fail();
      const run = async (args: readonly string[], plainSuccess = false) => {
        const output = await command(binary, args, cwd, env, life);
        // The pinned human/gate verbs emit text even with --json. Only our
        // fixed decision dispatch discards that bounded successful output;
        // it requires a same-target authoritative JSON readback afterwards.
        if (plainSuccess) return undefined;
        try { return JSON.parse(output) as unknown; } catch { fail(); }
      };
      const read = (sql: string) => run(['--sandbox', '--readonly', '--json', 'sql', sql]);
      const meta = rows(await read(METADATA_SQL));
      if (meta.length !== 1 || meta[0]!.database_key !== selected.databaseKey || meta[0]!.dolt_version !== '2.4.0'
        || meta[0]!.branch !== 'main' || Number(meta[0]!.schema_version) !== 66 || meta[0]!.project_id !== beadsProjectId) fail();
      if (life.expectedPrefix !== undefined) {
        const prefix = rows(await read("SELECT value AS issue_prefix FROM config WHERE `key`='issue_prefix'"));
        if (prefix.length !== 1 || prefix[0]!.issue_prefix !== life.expectedPrefix) fail();
      }
      const tables = rows(await read(TABLES_SQL)).map(row => row.table_name);
      if (JSON.stringify(tables) !== JSON.stringify(['comments', 'config', 'events', 'issues', 'metadata', 'schema_migrations'])) fail();
      checkpoint(life);
      // The second client has no Beads startup path. Its only SQL is fixed here;
      // the same declared endpoint, user and private credential are selected.
      const sqlEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, '.config'), DOLT_CLI_PASSWORD: inspection.password,
        DOLT_DISABLE_EVENT_FLUSH: '1', DO_NOT_TRACK: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
      // Pinned Dolt's supported setting prevents its version probe from querying
      // GitHub. This fixed local config command touches only our fresh HOME.
      await command(doltBinary, ['config', '--global', '--add', 'versioncheck.disabled', 'true'], home, sqlEnv, life);
      const sqlVersion = await command(doltBinary, ['version'], home, sqlEnv, life);
      const versionLines = sqlVersion.trim().split(/\r?\n/u);
      if (versionLines[0] !== 'dolt version 2.4.0' || versionLines.slice(1).some(line =>
        line !== 'Warning: unable to query latest released Dolt version')) fail();
      const inspect = async (query: string) => {
        const output = await command(doltBinary, [`--host=${inspector.host}`, `--port=${inspector.port}`, `--user=${inspector.user}`,
          '--use-db=mysql', ...(supplied.tls ? [] : ['--no-tls']), 'sql', '--result-format=json', `--query=${query}`], home, sqlEnv, life);
        let parsed: unknown; try { parsed = JSON.parse(output) as unknown; } catch { fail(); }
        return grantStrings(parsed);
      };
      const inspectionPrincipal = '`' + inspector.user + '`@`%`';
      const ownGrants = await inspect('SHOW GRANTS');
      if (JSON.stringify(ownGrants) !== JSON.stringify([
        `GRANT USAGE ON *.* TO ${inspectionPrincipal}`,
        `GRANT SELECT ON \`mysql\`.* TO ${inspectionPrincipal}`,
      ].sort())) fail();
      // Username grammar is validated by readDeclaredTaskClient; no caller SQL.
      const grants = await inspect('SHOW GRANTS FOR `' + client.user + '`@`%`');
      const principal = '`' + client.user + '`@`%`';
      const expected = [`GRANT USAGE ON *.* TO ${principal}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${selected.databaseKey}\`.* TO ${principal}`,
        ...['dolt_add', 'dolt_checkout', 'dolt_commit'].map(proc => `GRANT EXECUTE ON PROCEDURE \`${selected.databaseKey}\`.\`${proc}\` TO ${principal}`)];
      if (JSON.stringify(grants.sort()) !== JSON.stringify(expected.sort())) fail();
      // Dolt 2.4 parses the incoming database name as a match expression too.
      // Its underscore is therefore a single-character wildcard. The only
      // allowed directory keys are n_<32hex>; exact database SQL grants are an
      // independent required restriction, not inferred from this branch row.
      const branch = rows(await read(BRANCH_SQL));
      if (branch.length !== 1 || branch[0]!.database !== selected.databaseKey
        || branch[0]!.branch !== 'main' || branch[0]!.user !== client.user || branch[0]!.host !== '%' || branch[0]!.permissions !== 'write') fail();
      checkpoint(life);
      const result = await work(run);
      checkpoint(life); return result;
    } finally { await fs.rm(home, { recursive: true, force: false }); }
  }
  return Object.freeze({
    async execute(original: Request, serverSelectedWorkspaceId: string, request: HostedTaskRequest,
      controls?: TaskVerificationControls): Promise<unknown> {
      try {
        const workspaceId = uuid(serverSelectedWorkspaceId), snapshot = snapshotRequest(request, workspaceId);
        if (!(original instanceof Request)) fail();
        // Admission uses truthful request metadata, not a second unused body
        // branch. The eventual HTTP entry owns bounded original-body parsing.
        const supplied = lifetime(controls);
        const life: Lifetime = Object.freeze({ ...supplied,
          signal: supplied.signal ? AbortSignal.any([original.signal, supplied.signal]) : original.signal });
        checkpoint(life);
        const proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: life.signal });
        const capability = Symbol(), plan = createHostedTaskPlanner([{ workspaceId, projectId: snapshot.projectId, capability }])(workspaceId, snapshot);
        const action = hostedTaskAction(snapshot.operation);
        return await admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: 'task-executor' }, proof, async first => {
          checkpoint(life);
          if (snapshot.operation.kind === 'snapshot' && (first.principalKind !== 'workspace-service'
            || ![beadsClosedSince(Date.now()), beadsClosedSince(Date.now() - 30_000)].includes(snapshot.operation.closedSince))) fail();
          const execute = async (readMapping: () => Promise<TaskProjectMapping | null>, life: Lifetime) => {
            const selected = mapping(await readMapping());
            checkpoint(life);
            if (selected.workspaceId !== workspaceId || selected.projectId !== snapshot.projectId) fail();
            return ownedRun(selected, life, async run => {
              return admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: first.correlationId }, proof, async last => {
                if (last.principalId !== first.principalId || last.sessionId !== first.sessionId
                  || last.principalKind !== first.principalKind || last.profile !== first.profile) fail();
                await current(selected, life, readMapping);
                admission.assertContext(last, action);
                const operation = snapshot.operation;
                const target = async () => {
                  if (!('taskId' in operation)) fail();
                  const found = await run(['--sandbox', '--readonly', '--json', 'show', '--', operation.taskId]);
                  const row = record(Array.isArray(found) && found.length === 1 ? found[0] : found);
                  if (row.id !== operation.taskId || typeof row.issue_type !== 'string'
                    || typeof row.status !== 'string' || !['open', 'in_progress', 'blocked', 'deferred', 'closed'].includes(row.status)
                    || row.labels !== undefined && (!Array.isArray(row.labels) || row.labels.some(label => typeof label !== 'string'))) fail();
                  return row;
                };
                if (action === 'tasks.decide') {
                  const before = await target();
                  if (before.status === 'closed') fail();
                  if (operation.kind === 'resolve-gate') {
                    if (before.issue_type !== 'gate' || before.await_type !== 'human') fail();
                  } else if (before.issue_type === 'gate' || !Array.isArray(before.labels) || !before.labels.includes('human')) fail();
                } else if (operation.kind === 'update' && operation.status === 'closed' && operation.addLabels?.includes('human')) {
                  fail();
                } else if (operation.kind === 'close' || operation.kind === 'update'
                  && (operation.status === 'closed' || operation.removeLabels?.includes('human'))) {
                  const before = await target();
                  // No ordinary close or marker removal substitutes for a human
                  // decision, even for an operator. Use its exact named verb.
                  if (before.issue_type === 'gate' || Array.isArray(before.labels) && before.labels.includes('human')) fail();
                }
                checkpoint(life);
                return admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: last.correlationId }, proof, async effect => {
                  if (effect.principalId !== first.principalId || effect.sessionId !== first.sessionId
                    || effect.principalKind !== first.principalKind || effect.profile !== first.profile) fail();
                  await current(selected, life, readMapping);
                  admission.assertContext(effect, action);
                  checkpoint(life);
                  if (operation.kind === 'snapshot') {
                    const results: Record<string, { code: number; stdout: string; stderr: string }> = Object.create(null) as Record<string, { code: number; stdout: string; stderr: string }>;
                    // These are the ordinary poller's fixed reads. Cwd/profile
                    // remain executor-owned; no physical path is an argument.
                    for (const [key, read] of Object.entries(beadsPollArgs('.', operation.closedSince))) {
                      checkpoint(life);
                      const argv = read as string[];
                      if (argv[0] !== '-C' || argv[1] !== '.' || argv.length < 3) fail();
                      await admission.withAdmission('tasks.read', { requestedWorkspaceId: workspaceId, correlationId: effect.correlationId }, proof, async currentFacts => {
                        if (currentFacts.principalId !== first.principalId || currentFacts.sessionId !== first.sessionId
                          || currentFacts.principalKind !== first.principalKind || currentFacts.profile !== first.profile) fail();
                        await current(selected, life, readMapping);
                        admission.assertContext(currentFacts, 'tasks.read');
                        checkpoint(life);
                        try {
                          const value = await run(['--sandbox', '--readonly', '--json', `--actor=${currentFacts.principalId}`, ...argv.slice(2)]);
                          results[key] = { code: 0, stdout: JSON.stringify(value), stderr: '' };
                        } catch {
                          // A failed optional read stays unknown; a required
                          // failure makes the ordinary summarizer mark this
                          // project unavailable. Never invent an empty result.
                          checkpoint(life);
                          results[key] = { code: 1, stdout: '', stderr: 'Scoped task read unavailable.' };
                        }
                      });
                    }
                    checkpoint(life);
                    return Object.freeze(results);
                  }
                  // Server actor is inserted before all command tokens/terminal --.
                  const argv = [plan.argv[0]!, plan.argv[1]!, `--actor=${effect.principalId}`, ...plan.argv.slice(2)];
                  if (action !== 'tasks.decide') return run(argv);
                  await run(argv, true);
                  const after = await target();
                  if (after.status !== 'closed') fail();
                  if (operation.kind === 'respond') {
                    if (after.close_reason !== 'Responded') fail();
                    const comments = await run(['--sandbox', '--readonly', '--json', 'comments', '--', operation.taskId]);
                    if (!Array.isArray(comments) || !comments.some(value => {
                      const row = record(value);
                      return row.issue_id === operation.taskId && row.author === effect.principalId && row.text === `Response: ${operation.response}`;
                    })) fail();
                  } else if (operation.kind === 'dismiss') {
                    if (after.close_reason !== (operation.reason === undefined ? 'Dismissed' : `Dismissed: ${operation.reason}`)) fail();
                  } else if (operation.kind === 'resolve-gate' && operation.reason !== undefined && after.close_reason !== operation.reason) fail();
                  return Object.freeze({ id: after.id, status: after.status });
                });
              });
            });
          };
          if (action === 'tasks.read') return execute(() => directory.project(workspaceId, snapshot.projectId), life);
          if (typeof directory.withProjectMutation !== 'function') fail();
          return directory.withProjectMutation(workspaceId, snapshot.projectId,
            { deadline: life.deadline, signal: life.signal }, async lease => {
              const lockedLife = Object.freeze({ ...life, signal: AbortSignal.any([life.signal!, lease.signal]) });
              checkpoint(lockedLife);
              return admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: first.correlationId }, proof, async acquired => {
                if (acquired.principalId !== first.principalId || acquired.sessionId !== first.sessionId
                  || acquired.principalKind !== first.principalKind || acquired.profile !== first.profile) fail();
                checkpoint(lockedLife);
                return execute(lease.project, lockedLife);
              });
            });
        });
      } catch { fail(); }
    },
    async verifyProject(input: TaskProjectMapping, controls?: TaskVerificationControls): Promise<VerifiedTaskProject> {
      try {
        const selected = mapping(input), life = lifetime(controls);
        await current(selected, life);
        await ownedRun(selected, life, async () => { await current(selected, life); });
        checkpoint(life);
        const result = Object.freeze({ mapping: selected }); verified.set(result, selected); return result;
      } catch { fail(); }
    },
    assertVerifiedProject(result: unknown, expected: TaskProjectMapping): void {
      if (!result || typeof result !== 'object') fail();
      const selected = verified.get(result);
      if (!selected || !sameMapping(selected, mapping(expected))) fail();
      verified.delete(result);
    },
  });
}
