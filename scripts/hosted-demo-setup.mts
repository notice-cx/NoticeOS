/** One-shot fresh synthetic setup. Runtime never imports this operator entry. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkedSession } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace, frozenMigrationProblems, readMigrations, ROLES } from './postgres-migrate.mjs';
import { EMPTY_INSTALLATION_SQL } from './postgres-empty.mjs';
import { runCommand } from './run-command.mjs';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { fillDemo } from './demo-store.mjs';
import { buildDemoWorkerHelpers, demoStoreCapability } from './demo-evaluator.mjs';
import { evaluateDemoWatch, demoFlagJoins, recordDemoFreshness, recordDemoUptime, recordDemoSiteChecks, recordDemoSearchReports, recordDemoOsObservation } from './demo-seed.mjs';
import { configureDemoTasks, writeDemoTaskReceipt } from './demo-tasks.mjs';
import { demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { demoTaskHistory } from './demo-task-history.mjs';
import { DEMO_NTASKS_CREDENTIALS, demoNtasks, demoNtasksOrigin, type DemoNtasksProvision } from './demo-ntasks.mjs';
import { seedDemoDisplay } from './demo-display.mjs';
import { generateDemoWorkflows, writeDemoWorkflowHistory } from './demo-workflows.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { hostedDemoRuntimeFileContent, readDemoArtifact, type HostedDemoServerOptions } from './hosted-demo-server.mjs';
import { invokedDirectly } from './invoked-directly.mjs';

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
  /** The stack's own Ntasks: its address, the provision preparation wrote, and the folder of Ntasks's seed and load tools. */
  ntasks: { origin: string; provisionFile: string; toolRoot: string };
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
type SetupPhase = 'preflight' | 'artifact' | 'tools' | 'fresh_databases' | 'schema' | 'signal_seed'
  | 'task_seed' | 'display' | 'os_observation' | 'workflow_history' | 'service_grant' | 'completion' | 'cleanup';
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
  const row = exact(value, ['version','stateRoot','sourceRoot','artifactRoot','workerStateRoot','publicOrigin','listen','seed','cutoff','release','serviceExpiresAt','postgres','ntasks']);
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
  const ntasks = exact(row.ntasks, ['origin','provisionFile','toolRoot']);
  try { demoNtasksOrigin(ntasks.origin); } catch { refuse(); }
  absolute(ntasks.provisionFile); absolute(ntasks.toolRoot);
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
  const binding = hash(json({ stateRoot: home, sourceRoot: root, publicOrigin: request.publicOrigin, listen: request.listen, artifactRoot: request.artifactRoot, workerStateRoot: request.workerStateRoot, serviceExpiresAt: request.serviceExpiresAt, postgres: { host: target.hostname, port: target.port, database: target.pathname },
    ntasks: request.ntasks, seed: request.seed, cutoff: request.cutoff }));
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
  for (const name of ['runtime','setup-home','setup-tmp']) fs.mkdirSync(path.join(home, name), { mode: 0o700 });
  const admin = new Pool({ connectionString: request.postgres.adminUrl, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 30000, query_timeout: 31000 });
  admin.on('error', () => undefined);
  let store: ReturnType<typeof openStore> | undefined;
  let phase: SetupPhase = 'tools';
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([store?.close(), admin.end()]);
    if (outcomes.some(result => result.status === 'rejected')) refuse('cleanup');
  };
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(home, 'setup-home'), TMPDIR: path.join(home, 'setup-tmp'), DO_NOT_TRACK: '1' };
  const run = async (binary: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number }) => {
    checkpoint(); const reply = await nativeCommand(binary, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, deadline - Date.now()) });
    if (reply.code !== 0 || reply.timedOut || reply.error) refuse(); checkpoint(); return reply;
  };
  // Ntasks's own seed and load commands, from the commit the image built.
  const ntasksTool = (args: string[]) => run(process.execPath, [path.join(request.ntasks.toolRoot, 'tools/migrate/src/cli.ts'), ...args], { cwd: home, env, timeoutMs: 120000 });
  try {
    if (canonical(request.artifactRoot) !== request.artifactRoot || canonical(request.ntasks.toolRoot) !== request.ntasks.toolRoot) refuse();
    const provision = JSON.parse(privateRead(request.ntasks.provisionFile)) as DemoNtasksProvision;
    const seedToken = provision.tokens?.[DEMO_NTASKS_CREDENTIALS.seed], activityToken = provision.tokens?.[DEMO_NTASKS_CREDENTIALS.activity];
    if (provision.format !== 'ntasks-provision-v1' || typeof seedToken !== 'string' || typeof activityToken !== 'string') refuse();
    phase = 'fresh_databases';
    const session = checkedSession({ host: target.hostname, port: target.port || '5432', dbname: target.pathname.slice(1),
      user: decodeURIComponent(target.username), sslmode: 'disable' }, { where: 'explicit fresh synthetic demo', password: decodeURIComponent(target.password) || null });
    if (session.script(EMPTY_INSTALLATION_SQL)[0]?.empty !== 't') refuse();
    const roles = await admin.query('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])', [ROLES]);
    const versionNumber = Number((await admin.query("SELECT current_setting('server_version_num')::int AS version")).rows[0]?.version);
    if (roles.rows.length || !Number.isSafeInteger(versionNumber) || versionNumber < 180000) refuse();
    const scenario = generateDemoScenario({ seed: request.seed, cutoff: request.cutoff, release: request.release });
    const workspaceId = scenario.manifest.workspaceId, serviceId = randomUUID();
    if (provision.workspaceId !== workspaceId) refuse();
    // The stack's Ntasks answers for the demo's workspace and holds no project yet.
    const listed = await demoNtasks({ workspaceId, origin: request.ntasks.origin }).call('GET', '/api/tasks/projects');
    if (listed.status !== 200 || JSON.stringify((listed.body as { projects?: unknown } | null)?.projects) !== '[]') refuse();
    phase = 'schema';
    const schema = applyMigrations(session, { dir: migrationRoot });
    if (schema.applied.length !== readMigrations(migrationRoot).length) refuse();
    const boot = bootstrapWorkspace(session, { workspaceId, slug: 'demo', displayName: 'Synthetic demo', dir: migrationRoot });
    if (!boot.created || boot.workspaceId !== workspaceId) refuse();
    await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$3,now())', [workspaceId, 'Synthetic demo', 'demo']);
    const urls: Record<string, string> = {};
    for (const role of ['noticeos_app','noticeos_identity','noticeos_service_grant']) {
      const secret = password(); await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${secret}'`);
      const url = new URL(target.href); url.username = role; url.password = secret; urls[role] = url.href;
    }
    phase = 'signal_seed';
    store = openStore(urls.noticeos_app!);
    const helpers = await buildDemoWorkerHelpers(root, { activity: true });
    const codebaseRules = helpers.codebaseRules;
    if (typeof helpers.evaluatePulse !== 'function' || !codebaseRules) refuse();
    const counts = await store.inWorkspace(workspaceId, async tx => {
      await tx.query("SELECT set_config('noticeos.synthetic_setup','demo',true)");
      return fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules, developmentProfile: { setting: 'noticeos.synthetic_setup', value: 'demo' } });
    });
    const watch = await evaluateDemoWatch(store, scenario, helpers.runWatchWindows);
    const joins = await demoFlagJoins(watch.capability, scenario);
    await recordDemoFreshness(watch.capability, scenario, helpers.runFreshnessCheck);
    await recordDemoUptime(watch.capability, scenario, helpers.runUptimeChecks);
    await recordDemoSiteChecks(watch.capability, scenario, helpers.runHygieneChecks, helpers.writeReading);
    await recordDemoSearchReports(watch.capability, scenario, helpers.writeInsightSnapshot);
    phase = 'task_seed';
    // The scenario's tasks, with the ones that answer an alert marked so, into
    // the empty store through Ntasks's seed and load commands; the seed
    // credential's token reaches only a file under setup-tmp, removed after.
    const seed = demoNtasksSeed(scenario, joins);
    const seedFile = path.join(home, 'setup-tmp/ntasks-seed.json'), backupFile = path.join(home, 'setup-tmp/ntasks-backup.json');
    const tokenFile = path.join(home, 'setup-tmp/ntasks-seed.token');
    write(seedFile, seed);
    fs.writeFileSync(tokenFile, seedToken + '\n', { flag: 'wx', mode: 0o600 });
    try {
      await ntasksTool(['seed', '--from', seedFile, '--out', backupFile]);
      const loaded = await ntasksTool(['load', '--api', request.ntasks.origin, '--token-file', tokenFile, '--from', backupFile]);
      if (!loaded.stdout.includes('0 differences.')) refuse();
    } finally { fs.rmSync(tokenFile, { force: true }); fs.rmSync(backupFile, { force: true }); fs.rmSync(seedFile, { force: true }); }
    const history = demoTaskHistory(seed, scenario);
    for (const snapshot of history) {
      const written = await helpers.writeTaskSnapshot(watch.capability, snapshot, Date.parse(snapshot.capturedAt));
      if (!written.ok) refuse();
    }
    const projects = scenario.manifest.taskProjects.map(project => ({ ...project, projectId: seed.projects.find(row => row.prefix === project.prefix)!.id }));
    const taskReceipt = { version: 1, synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId,
      release: scenario.manifest.release, projects, tasks: scenario.tasks.length, snapshots: history.length };
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
    phase = 'service_grant';
    await admin.query('INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4)',
      [serviceId, workspaceId, ['workflows.run','tasks.read','tasks.write'], request.serviceExpiresAt]);
    phase = 'completion';
    const runtime: HostedDemoServerOptions = { version: 1, publicOrigin: request.publicOrigin, listen: request.listen,
      artifactRoot: request.artifactRoot, workerStateRoot: request.workerStateRoot, workspaceDatabaseUrl: urls.noticeos_app!,
      tasks: { profile: 'demo', trustedOrigin: request.publicOrigin, demoWorkspaceId: workspaceId,
        identity: { connectionString: urls.noticeos_identity!, trustedOrigin: request.publicOrigin, sessionSecret: password() },
        ntasks: { origin: request.ntasks.origin } },
      activity: { sourceRoot: root, scenario, workspaceId, serviceId, connectionString: urls.noticeos_app!,
        grantConnectionString: urls.noticeos_service_grant!, ntasks: { origin: request.ntasks.origin, token: activityToken },
        projects: projects.filter(project => !scenario.assets.find(asset => asset.id === project.asset)!.isOs)
          .map(({ asset, prefix, projectId }) => ({ asset, prefix, projectId })) } };
    const serialized = hostedDemoRuntimeFileContent(runtime);
    if ([seedToken, target.password, decodeURIComponent(target.password)].filter(Boolean).some(secret => serialized.includes(secret))) refuse();
    // Bootstrap passwords cannot survive in task metadata, imported receipts,
    // generated configuration or any other retained state file.
    const assertNoBootstrap = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) refuse();
        if (entry.isDirectory()) assertNoBootstrap(file);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(file);
          for (const secret of [seedToken, decodeURIComponent(target.password)].filter(Boolean)) {
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
    checkpoint(); fs.writeFileSync(runtimeFile, serialized, { flag: 'wx', mode: 0o600 });
    const finalReceipt = { format: 'noticeos-hosted-demo-setup/1', binding, schemaHash, workspaceId, scenarioHash: demoScenarioHash(scenario),
      firstSeedRelease: scenario.manifest.release, completedAt: new Date().toISOString(), runtimeHash: hash(serialized), counts, osReport,
      ntasks: request.ntasks.origin, projectCount: projects.length };
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
