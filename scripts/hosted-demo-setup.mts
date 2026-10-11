/** One-shot fresh synthetic setup. Runtime never imports this operator entry. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import { createRequire } from 'node:module';
import type { TaskProjectMapping } from '../packages/postgres/src/task-directory.mjs';
import type { HostedTaskTarget } from './hosted-task-executor.mjs';
import { checkedSession } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace, frozenMigrationProblems, readMigrations, ROLES } from './postgres-migrate.mjs';
import { EMPTY_INSTALLATION_SQL } from './postgres-empty.mjs';
import { runCommand } from './run-command.mjs';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { fillDemo } from './demo-store.mjs';
import { buildDemoWorkerHelpers, demoStoreCapability } from './demo-evaluator.mjs';
import { evaluateDemoWatch, demoFlagJoins, recordDemoOsObservation } from './demo-seed.mjs';
import { seedDemoTaskHistory, configureDemoTasks, writeDemoTaskReceipt } from './demo-tasks.mjs';
import { seedDemoDisplay } from './demo-display.mjs';
import { generateDemoWorkflows, writeDemoWorkflowHistory } from './demo-workflows.mjs';
import { taskClientEnvironment, type TaskClient } from './task-client.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { openTaskCatalogSetup } from '../packages/postgres/src/task-catalog.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { readDemoArtifact, type HostedDemoServerOptions } from './hosted-demo-server.mjs';
import { invokedDirectly } from './invoked-directly.mjs';

type Tool = { path: string; sha256: string };
export interface HostedDemoSetupRequest {
  version: 1;
  stateRoot: string;
  sourceRoot: string;
  artifactRoot: string;
  workerStateRoot: string;
  publicOrigin: string;
  listen: { host: '127.0.0.1' | '0.0.0.0'; port: number };
  seed: string;
  cutoff: string;
  release: string;
  serviceExpiresAt: string;
  postgres: { adminUrl: string };
  dolt: { host: string; port: number; adminUser: string; adminPassword: string; tls: false };
  binary: Tool;
  doltBinary: Tool;
}
interface AdminPool {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: () => void): void;
  end(): Promise<void>;
}
const require = createRequire(new URL('../packages/postgres/package.json', import.meta.url));
const { Pool } = require('pg') as { Pool: new (options: Record<string, unknown>) => AdminPool };
const nativeCommand = runCommand as unknown as (command: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; error: unknown }>;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const password = () => randomBytes(32).toString('hex');
type SetupPhase = 'preflight' | 'artifact' | 'tools' | 'fresh_databases' | 'schema' | 'signal_seed' | 'task_provision'
  | 'task_seed' | 'display' | 'os_observation' | 'workflow_history' | 'catalog' | 'service_grant' | 'completion' | 'cleanup';
class SetupRefused extends Error {
  constructor(readonly phase: SetupPhase) {
    super(`Fresh hosted demo setup refused (${phase}); preserve partial state for explicit recovery.`);
  }
}
function refuse(phase: SetupPhase = 'preflight'): never { throw new SetupRefused(phase); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) refuse();
  if (keys.some(key => !('value' in Object.getOwnPropertyDescriptor(row, key)!))) refuse();
  return row;
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/u.test(value)) refuse();
  return value;
}
function canonical(value: string): string {
  if (fs.existsSync(value)) return fs.realpathSync(value);
  const parent = path.dirname(value);
  return parent === value ? value : path.join(canonical(parent), path.basename(value));
}
function privateRead(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || st.mode & 0o077 || st.size > 2 * 1024 * 1024) refuse();
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function write(file: string, value: unknown): void {
  fs.writeFileSync(file, json(value), { flag: 'wx', mode: 0o600 });
}
/** No selectors from process.env, inherited providers or installed profiles. */
export function captureHostedDemoSetupRequest(value: unknown): HostedDemoSetupRequest {
  const row = exact(value, ['version','stateRoot','sourceRoot','artifactRoot','workerStateRoot','publicOrigin','listen','seed','cutoff','release','serviceExpiresAt','postgres','dolt','binary','doltBinary']);
  if (row.version !== 1) refuse();
  for (const key of ['stateRoot','sourceRoot','artifactRoot','workerStateRoot']) absolute(row[key]);
  if (row.stateRoot === row.sourceRoot || !String(row.workerStateRoot).startsWith(String(row.stateRoot) + '/')) refuse();
  if (typeof row.publicOrigin !== 'string' || new URL(row.publicOrigin).origin !== row.publicOrigin || !row.publicOrigin.startsWith('https://')) refuse();
  const listen = exact(row.listen, ['host','port']);
  if (!['127.0.0.1','0.0.0.0'].includes(String(listen.host)) || !Number.isInteger(listen.port) || Number(listen.port) < 1024 || Number(listen.port) > 65535) refuse();
  const pg = exact(row.postgres, ['adminUrl']);
  if (typeof pg.adminUrl !== 'string') refuse();
  const url = new URL(pg.adminUrl);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','postgres'].includes(url.hostname)
    || !['postgres','noticeos_owner'].includes(decodeURIComponent(url.username)) || !/^\/[a-z][a-z0-9_]{0,62}$/u.test(url.pathname)
    || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.get('sslmode') !== 'disable') refuse();
  const dolt = exact(row.dolt, ['host','port','adminUser','adminPassword','tls']);
  if (dolt.host !== '127.0.0.1' || !Number.isInteger(dolt.port) || Number(dolt.port) < 1024 || Number(dolt.port) > 65535
    || dolt.adminUser !== 'noticeos_owner' || typeof dolt.adminPassword !== 'string' || !/^[a-f0-9]{64}$/u.test(dolt.adminPassword) || dolt.tls !== false) refuse();
  for (const key of ['binary','doltBinary']) {
    const tool = exact(row[key], ['path','sha256']); absolute(tool.path);
    if (typeof tool.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(tool.sha256)) refuse();
  }
  generateDemoScenario({ seed: row.seed as string, cutoff: row.cutoff as string, release: row.release as string });
  if (Date.parse(row.cutoff as string) > Date.now() || typeof row.serviceExpiresAt !== 'string'
    || new Date(row.serviceExpiresAt).toISOString() !== row.serviceExpiresAt || Date.parse(row.serviceExpiresAt) <= Date.now() || Date.parse(row.serviceExpiresAt) > Date.now() + 366 * 86400000) refuse();
  return structuredClone(row) as unknown as HostedDemoSetupRequest;
}
export function readHostedDemoSetupRequest(file: string): HostedDemoSetupRequest {
  return captureHostedDemoSetupRequest(JSON.parse(privateRead(absolute(file))));
}

/** Never resumes a partial operation. Repeat setup adopts only its completed,
 * hash-bound configuration. Seed provenance is independent of later releases. */
export async function setupHostedDemo(input: HostedDemoSetupRequest): Promise<{ created: boolean; runtimeFile: string; workspaceId: string; scenarioHash: string }> {
  const request = captureHostedDemoSetupRequest(input);
  const { stateRoot: home, sourceRoot: root } = request;
  if (canonical(home) !== home || canonical(root) !== root) refuse();
  for (const name of ['installation','.beads','.local/runtime']) {
    const relative = path.relative(path.join(root, name), home);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) refuse();
  }
  // Validate the exact readable compiled release before any pool or state write.
  try { readDemoArtifact(request.artifactRoot); } catch { refuse('artifact'); }
  const runtimeFile = path.join(home, 'runtime/runtime.json'), receiptFile = path.join(home, 'setup.json');
  const migrationRoot = path.join(root, 'db/postgres/migrations');
  const frozen = fs.readFileSync(path.join(root, 'db/postgres/frozen-migrations.sha256'), 'utf8');
  if (frozenMigrationProblems(frozen, { dir: migrationRoot }).length || readMigrations(migrationRoot).length !== frozen.trim().split('\n').length) refuse();
  const schemaHash = hash(frozen);
  const target = new URL(request.postgres.adminUrl);
  const binding = hash(json({ stateRoot: home, sourceRoot: root, publicOrigin: request.publicOrigin, listen: request.listen, artifactRoot: request.artifactRoot, workerStateRoot: request.workerStateRoot, binary: request.binary, doltBinary: request.doltBinary, serviceExpiresAt: request.serviceExpiresAt, postgres: { host: target.hostname, port: target.port, database: target.pathname },
    dolt: { host: request.dolt.host, port: request.dolt.port }, seed: request.seed, cutoff: request.cutoff }));
  const existing = fs.lstatSync(home, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || (process.getuid && existing.uid !== process.getuid()) || existing.mode & 0o077) refuse();
    if (fs.readdirSync(home).length) {
      if (fs.existsSync(path.join(home, '.setup-pending.json'))) refuse();
      const receipt = JSON.parse(privateRead(receiptFile)) as Record<string, unknown>;
      if (receipt.format !== 'noticeos-hosted-demo-setup/1' || receipt.binding !== binding || receipt.schemaHash !== schemaHash
        || receipt.runtimeHash !== hash(privateRead(runtimeFile)) || typeof receipt.workspaceId !== 'string' || typeof receipt.scenarioHash !== 'string') refuse();
      return { created: false, runtimeFile, workspaceId: receipt.workspaceId, scenarioHash: receipt.scenarioHash };
    }
  } else fs.mkdirSync(home, { mode: 0o700 });
  // This exclusive marker remains after any failure. No partial state is reused.
  write(path.join(home, '.setup-pending.json'), { format: 'noticeos-hosted-demo-pending/1', binding });
  const deadline = Date.now() + 12 * 60 * 1000;
  const checkpoint = () => { if (Date.now() >= deadline) refuse(); };
  for (const name of ['runtime','tasks','scratch','setup-home','setup-tmp']) fs.mkdirSync(path.join(home, name), { mode: 0o700 });
  const admin = new Pool({ connectionString: request.postgres.adminUrl, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 30000, query_timeout: 31000 });
  admin.on('error', () => undefined);
  let store: ReturnType<typeof openStore> | undefined, directory: ReturnType<typeof openTaskDirectory> | undefined;
  let catalog: ReturnType<typeof openTaskCatalogSetup> | undefined;
  let phase: SetupPhase = 'tools';
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([catalog?.close(), directory?.close(), store?.close(), admin.end()]);
    if (outcomes.some(result => result.status === 'rejected')) refuse('cleanup');
  };
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(home, 'setup-home'), TMPDIR: path.join(home, 'setup-tmp'),
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1',
    BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1' };
  const run = async (binary: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number }) => {
    checkpoint(); const reply = await nativeCommand(binary, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, deadline - Date.now()) });
    if (reply.code !== 0 || reply.timedOut || reply.error) refuse(); checkpoint(); return reply;
  };
  const ownerSql = async (sql: string): Promise<Record<string, string>[]> => {
    const result = await run(request.doltBinary.path, ['--host=127.0.0.1', `--port=${request.dolt.port}`, '--user=noticeos_owner', '--no-tls',
      'sql', '--result-format=json', '--batch'], { cwd: home, env: { ...env, DOLT_CLI_PASSWORD: request.dolt.adminPassword }, stdin: sql + '\n' });
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{"rows":[]}').rows as Record<string, string>[];
  };
  try {
    for (const tool of [request.binary, request.doltBinary]) {
      const file = fs.lstatSync(tool.path);
      if (!file.isFile() || file.isSymbolicLink() || canonical(tool.path) !== tool.path || hash(fs.readFileSync(tool.path)) !== tool.sha256) refuse();
    }
    if (canonical(request.artifactRoot) !== request.artifactRoot) refuse();
    const bdVersion = await run(request.binary.path, ['--version'], { cwd: home, env });
    if (!/^bd version 1\.3\.1(?:\s|$)/u.test(bdVersion.stdout.trim())) refuse();
    await run(request.doltBinary.path, ['config','--global','--add','versioncheck.disabled','true'], { cwd: home, env });
    const version = await run(request.doltBinary.path, ['version'], { cwd: home, env });
    if (version.stdout.trim() !== 'dolt version 2.4.0') refuse();
    phase = 'fresh_databases';
    const session = checkedSession({ host: target.hostname, port: target.port || '5432', dbname: target.pathname.slice(1),
      user: decodeURIComponent(target.username), sslmode: 'disable' }, { where: 'explicit fresh synthetic demo', password: decodeURIComponent(target.password) || null });
    if (session.script(EMPTY_INSTALLATION_SQL)[0]?.empty !== 't') refuse();
    const roles = await admin.query('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])', [ROLES]);
    const versionNumber = Number((await admin.query("SELECT current_setting('server_version_num')::int AS version")).rows[0]?.version);
    if (roles.rows.length || !Number.isSafeInteger(versionNumber) || versionNumber < 180000) refuse();
    const databases = await ownerSql('SHOW DATABASES;');
    if (databases.some(row => !['information_schema','mysql','performance_schema'].includes(row.Database!))) refuse();
    phase = 'schema';
    const schema = applyMigrations(session, { dir: migrationRoot });
    if (schema.applied.length !== readMigrations(migrationRoot).length) refuse();
    const scenario = generateDemoScenario({ seed: request.seed, cutoff: request.cutoff, release: request.release });
    const workspaceId = scenario.manifest.workspaceId, serviceId = randomUUID();
    const boot = bootstrapWorkspace(session, { workspaceId, slug: 'demo', displayName: 'Synthetic demo', dir: migrationRoot });
    if (!boot.created || boot.workspaceId !== workspaceId) refuse();
    await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$3,now())', [workspaceId, 'Synthetic demo', 'demo']);
    const urls: Record<string, string> = {};
    for (const role of ['noticeos_app','noticeos_identity','noticeos_task_directory','noticeos_service_grant','noticeos_platform']) {
      const secret = password(); await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${secret}'`);
      const url = new URL(target.href); url.username = role; url.password = secret; urls[role] = url.href;
    }
    phase = 'signal_seed';
    store = openStore(urls.noticeos_app!);
    const helpers = await buildDemoWorkerHelpers(root, { activity: true });
    if (typeof helpers.evaluatePulse !== 'function') refuse();
    const counts = await store.inWorkspace(workspaceId, async tx => {
      await tx.query("SELECT set_config('noticeos.synthetic_setup','demo',true)");
      return fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, developmentProfile: { setting: 'noticeos.synthetic_setup', value: 'demo' } });
    });
    const watch = await evaluateDemoWatch(store, scenario, helpers.runWatchWindows);
    const joins = await demoFlagJoins(watch.capability, scenario);
    phase = 'task_provision';
    const inspectorSecret = password();
    await ownerSql(`CREATE USER 'grant_inspector'@'%' IDENTIFIED BY '${inspectorSecret}'; GRANT SELECT ON mysql.* TO 'grant_inspector'@'%';`);
    const inspectorHome = path.join(home, 'runtime/inspector-home'); fs.mkdirSync(inspectorHome, { mode: 0o700 });
    const inspectorCredentials = path.join(home, 'runtime/inspector.credentials');
    fs.writeFileSync(inspectorCredentials, `[127.0.0.1:${request.dolt.port}]\npassword=${inspectorSecret}\n`, { flag: 'wx', mode: 0o600 });
    const inspectorProfile = path.join(home, 'runtime/inspector.json');
    write(inspectorProfile, { host: '127.0.0.1', port: request.dolt.port, user: 'grant_inspector', credentialsFile: inspectorCredentials, clientHome: inspectorHome });
    const allocations: { mapping: TaskProjectMapping; target: HostedTaskTarget }[] = [];
    const projects: { asset: string; prefix: string; database: string; repo: string }[] = [];
    const clients = new Map<string, TaskClient>();
    for (const project of scenario.manifest.taskProjects) {
      const projectId = randomUUID(), executorRef = randomUUID(), credentialRef = randomUUID();
      const databaseKey = 'n_' + randomUUID().replaceAll('-', ''), user = 't_' + projectId.replaceAll('-', '').slice(0, 24), secret = password();
      const cwd = path.join(home, 'tasks', project.prefix), clientHome = path.join(home, 'runtime', project.prefix + '-home');
      fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(clientHome, { mode: 0o700 });
      await ownerSql(`CREATE DATABASE ${databaseKey}; CREATE USER '${user}'@'%' IDENTIFIED BY '${secret}';`);
      // Only initialization uses the bootstrap login; subsequent imports/readers
      // use the same restricted task identity that the running simulator receives.
      await run(request.binary.path, ['init','--server','--external','--server-host','127.0.0.1','--server-port',String(request.dolt.port),
        '--server-user','noticeos_owner','--database',databaseKey,'--prefix',project.prefix,'--non-interactive','--skip-hooks','--skip-agents'],
        { cwd, env: { ...env, BEADS_DOLT_PASSWORD: request.dolt.adminPassword } });
      fs.appendFileSync(path.join(cwd, '.beads/config.yaml'), '\nno-git-ops: true\nimport.auto: false\n');
      for (const name of ['metadata.json','config.yaml']) {
        const file = path.join(cwd, '.beads', name);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('noticeos_owner', user), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      }
      const beadsProjectId = (await ownerSql(`SELECT value AS project_id FROM ${databaseKey}.metadata WHERE \`key\`='_project_id';`))[0]?.project_id;
      if (!beadsProjectId) refuse();
      await ownerSql(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${databaseKey}.* TO '${user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${databaseKey}.dolt_add TO '${user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${databaseKey}.dolt_commit TO '${user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${databaseKey}.dolt_checkout TO '${user}'@'%';`);
      const credentialsFile = path.join(home, 'runtime', project.prefix + '.credentials'), clientProfile = path.join(home, 'runtime', project.prefix + '.json');
      fs.writeFileSync(credentialsFile, `[127.0.0.1:${request.dolt.port}]\npassword=${secret}\n`, { flag: 'wx', mode: 0o600 });
      const client = { host: '127.0.0.1', port: request.dolt.port, user, credentialsFile, clientHome }; write(clientProfile, client); clients.set(project.asset, client);
      const mapping = { workspaceId, projectId, executorRef, credentialRef, databaseKey };
      allocations.push({ mapping, target: { cwd, clientProfile, grantVerifierProfile: inspectorProfile, beadsProjectId, tls: false } });
      projects.push({ ...project, repo: cwd });
      await admin.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
    }
    await ownerSql(`USE ${allocations[0]!.mapping.databaseKey}; DELETE FROM dolt_branch_control; INSERT INTO dolt_branch_control VALUES
      ('%','%','noticeos_owner','localhost','admin'),${allocations.map(row => `('${row.mapping.databaseKey}','main','${clients.get(projects.find(p => p.repo === row.target.cwd)!.asset)!.user}','%','write')`).join(',')};`);
    phase = 'task_seed';
    const seeded = await seedDemoTaskHistory({ scenario, projects, tasksDir: path.join(home, 'tasks'), capability: watch.capability,
      writeSnapshot: helpers.writeBeadsSnapshot, joins }, (project: { asset: string; repo: string }, args: string[]) => {
      const client = clients.get(project.asset); if (!client) refuse();
      return run(request.binary.path, ['--sandbox','-C',project.repo,...args,'--json','--actor','synthetic-demo-seeder'],
        { cwd: home, env: { ...taskClientEnvironment(client, env), BEADS_DOLT_DATABASE: allocations.find(row => row.target.cwd === project.repo)!.mapping.databaseKey }, timeoutMs: 90000 });
    });
    const taskReceipt = { version: 1, synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId,
      release: scenario.manifest.release, projects, tasks: scenario.tasks.length, snapshots: seeded.snapshots, commands: seeded.commands };
    writeDemoTaskReceipt(home, taskReceipt);
    phase = 'display';
    const plan = { root, home, installation: path.join(home, 'installation') };
    await configureDemoTasks({ plan, scenario, receipt: taskReceipt, capability: watch.capability, helpers });
    await seedDemoDisplay({ ...plan, scenario, capability: watch.capability, helpers });
    phase = 'os_observation';
    const osReport = await recordDemoOsObservation(watch.capability, scenario, helpers.runAssetZeroPulse);
    phase = 'workflow_history';
    await writeDemoWorkflowHistory({ home, history: generateDemoWorkflows({ scenario, watch, tasks: taskReceipt }),
      writeRuns: (rows, now) => helpers.writeJobRuns(watch.capability, rows, now) });
    phase = 'catalog';
    directory = openTaskDirectory({ connectionString: urls.noticeos_task_directory! });
    const admission = createWorkspaceAdmission({ kind: 'demo', profile: Symbol('setup verifier'), workspaceId, workspaceStatus: async () => 'active' });
    const executor = createHostedTaskExecutor({ admission, directory, binary: request.binary, doltBinary: request.doltBinary, scratchRoot: path.join(home, 'scratch'),
      resolveTarget: async mapping => allocations.find(row => JSON.stringify(row.mapping) === JSON.stringify(mapping))?.target ?? null });
    catalog = openTaskCatalogSetup({ connectionString: urls.noticeos_platform!, verifyProject: async (mapping, controls) => {
      const result = await executor.verifyProject(mapping, controls); executor.assertVerifiedProject(result, mapping);
    } });
    for (const row of allocations) {
      const project = projects.find(p => p.repo === row.target.cwd)!;
      await catalog.configure({ workspaceId, projectId: row.mapping.projectId, logicalKey: project.prefix, displayName: scenario.assets.find(asset => asset.id === project.asset)!.name, prefix: project.prefix });
    }
    phase = 'service_grant';
    await admin.query('INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4)',
      [serviceId, workspaceId, ['workflows.run','tasks.read','tasks.write'], request.serviceExpiresAt]);
    phase = 'completion';
    const runtime: HostedDemoServerOptions = { version: 1, publicOrigin: request.publicOrigin, listen: request.listen,
      artifactRoot: request.artifactRoot, workerStateRoot: request.workerStateRoot, workspaceDatabaseUrl: urls.noticeos_app!,
      tasks: { profile: 'demo', trustedOrigin: request.publicOrigin, demoWorkspaceId: workspaceId,
        identity: { connectionString: urls.noticeos_identity!, trustedOrigin: request.publicOrigin, sessionSecret: password() },
        directoryConnectionString: urls.noticeos_task_directory!, targets: allocations, binary: request.binary, doltBinary: request.doltBinary, scratchRoot: path.join(home, 'scratch') },
      activity: { sourceRoot: root, scenario, workspaceId, serviceId, connectionString: urls.noticeos_app!,
        grantConnectionString: urls.noticeos_service_grant!, directoryConnectionString: urls.noticeos_task_directory!,
        projects: allocations.filter(row => !scenario.assets.find(asset => projects.find(p => p.repo === row.target.cwd)!.asset === asset.id)!.isOs)
          .map(row => ({ asset: projects.find(p => p.repo === row.target.cwd)!.asset, prefix: projects.find(p => p.repo === row.target.cwd)!.prefix, ...row })),
        binary: request.binary, doltBinary: request.doltBinary, scratchRoot: path.join(home, 'scratch') } };
    const serialized = json(runtime);
    if ([request.dolt.adminPassword, target.password, decodeURIComponent(target.password)].filter(Boolean).some(secret => serialized.includes(secret)) || serialized.includes(urls.noticeos_platform!)) refuse();
    // Bootstrap passwords cannot survive in task metadata, imported receipts,
    // generated configuration or any other retained state file.
    const assertNoBootstrap = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) refuse();
        if (entry.isDirectory()) assertNoBootstrap(file);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(file);
          for (const secret of [request.dolt.adminPassword, decodeURIComponent(target.password)].filter(Boolean)) {
            if (bytes.includes(Buffer.from(secret))) refuse();
          }
        }
      }
    };
    assertNoBootstrap(home);
    // Completion is published only after every acquired database handle closes.
    phase = 'cleanup';
    await close();
    phase = 'completion';
    checkpoint(); write(runtimeFile, runtime);
    const finalReceipt = { format: 'noticeos-hosted-demo-setup/1', binding, schemaHash, workspaceId, scenarioHash: demoScenarioHash(scenario),
      firstSeedRelease: scenario.manifest.release, completedAt: new Date().toISOString(), runtimeHash: hash(serialized), counts, osReport,
      tools: { binary: request.binary.sha256, dolt: request.doltBinary.sha256 }, projectCount: allocations.length };
    const ready = path.join(home, '.setup-ready.json'), pending = path.join(home, '.setup-pending.json');
    write(ready, finalReceipt); fs.renameSync(ready, pending); fs.renameSync(pending, receiptFile);
    return { created: true, runtimeFile, workspaceId, scenarioHash: demoScenarioHash(scenario) };
  } catch { return refuse(phase); }
  finally { await close(); }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length !== 2 || argv[0] !== '--request') refuse();
    const result = await setupHostedDemo(readHostedDemoSetupRequest(argv[1]!));
    process.stdout.write(json({ ok: true, created: result.created, workspaceId: result.workspaceId, scenarioHash: result.scenarioHash })); return 0;
  } catch (error) {
    const phase = error instanceof SetupRefused ? error.phase : 'preflight';
    process.stderr.write(`Fresh hosted demo setup refused (${phase}); preserve partial state for explicit recovery.\n`); return 1;
  }
}
if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
