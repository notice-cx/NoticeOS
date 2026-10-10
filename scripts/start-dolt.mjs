// The task project of a proven new pnpm start installation.
// Existing folders never initialize or migrate a task database here.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { openStore } from '../packages/postgres/src/store.mjs';
import { doltEnvironment, preflightDolt, prepareFreshDolt, readDoltProfile, startDoltPlan } from './dolt-host.mjs';
import { BEADS_VERSION, checkBeadsCli, initDoltProject } from './dolt-project.mjs';
import { runCommand } from './run-command.mjs';

export { BEADS_VERSION, checkBeadsCli };
const PREFIX = 'no';
const DATABASE = 'noticeos_tasks';
const refusal = (line) => ({ ok: false, line });
const coreFile = plan => path.join(plan.home, 'dolt', 'core.json');
const ownRepo = plan => path.join(plan.home, 'tasks', 'noticeos');
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
function ownDirectory(file, required = false) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if ((!stat && required) || (stat && (!stat.isDirectory() || stat.isSymbolicLink()))) throw new Error('Task paths must be own directories.');
}

export function scrubTaskEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:BD_|BEADS_|DOLT_|MYSQL_)/u.test(key)));
}

export function readStartedTaskCore(plan) {
  for (const dir of [plan.home, path.join(plan.home, 'dolt'), path.join(plan.home, 'tasks'), ownRepo(plan), path.join(ownRepo(plan), '.beads')]) ownDirectory(dir, true);
  const file = coreFile(plan);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid task setup record.');
  const core = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (core.version !== 1 || core.beadsVersion !== BEADS_VERSION || !/^os-[0-9a-f]{16}$/u.test(core.asset) ||
    core.repo !== ownRepo(plan) || core.prefix !== PREFIX || core.database !== DATABASE) throw new Error('Invalid task setup record.');
  const metadataFile = path.join(core.repo, '.beads', 'metadata.json');
  const metaStat = fs.lstatSync(metadataFile);
  if (!metaStat.isFile() || metaStat.isSymbolicLink()) throw new Error('Invalid task project metadata.');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.dolt_mode !== 'server' || metadata.dolt_database !== DATABASE || metadata.dolt_server_host !== '127.0.0.1'
    || Number(metadata.dolt_server_port) !== plan.port + 3 || metadata.dolt_server_user !== 'noticeos') throw new Error('Task project is not bound to its declared hub.');
  return core;
}

/** Legacy/manual Postgres installations are never adopted. A declared task
 * profile requires a completed core record before any service is restarted. */
export async function preflightStartedTasks(plan, { env = process.env, run = runCommand, held, binary, flight = preflightDolt } = {}) {
  try {
    const profile = readDoltProfile(plan.home);
    const entries = fs.existsSync(plan.home) ? fs.readdirSync(plan.home) : [];
    const configured = ['DATABASE_URL', 'NOTICEOS_POSTGRES_SECRETS', 'NOTICEOS_POSTGRES_PORT'].some(key => env[key] !== undefined);
    if (!profile && (entries.length || configured)) {
      if (fs.lstatSync(path.join(plan.home, 'dolt'), { throwIfNoEntry: false }) || fs.lstatSync(path.join(plan.home, '.noticeos-first-start', 'tasks-required'), { throwIfNoEntry: false })) {
        return refusal('Task setup is incomplete; explicit recovery is required before startup.');
      }
      return { ok: true, enabled: false };
    }
    if (profile) {
      const expected = startDoltPlan(plan);
      if (Object.keys(expected).some(key => profile[key] !== expected[key])) return refusal('The task profile is not this installation’s own profile.');
      readStartedTaskCore(plan);
    }
    const cli = await checkBeadsCli({ env, run, binary });
    if (!cli.ok) return cli;
    const checked = await flight(plan, { env, run, ...(held ? { held } : {}) });
    return checked.ok ? { ...checked, enabled: true, fresh: !profile, binary: cli.binary } : checked;
  } catch { return refusal('Task setup is incomplete or invalid; explicit recovery is required before startup.'); }
}

export async function createFreshOsAsset(address, { store = openStore, id = `os-${randomBytes(8).toString('hex')}` } = {}) {
  const db = store(address);
  try {
    const workspace = await db.onlyWorkspace();
    await db.inWorkspace(workspace, async tx => {
      if ((await tx.query('SELECT asset_id FROM noticeos.assets')).length) throw new Error('Fresh installation already has assets.');
      await tx.execute(`INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, is_os)
        VALUES ($1, $2, NULL, 'NoticeOS', 'live', true)`, [workspace, id]);
    });
    return id;
  } finally { await db.close(); }
}

/** Only called after Postgres has proved/created the new empty installation.
 * Any uncertain init is preserved and refused on the next ordinary start. */
export async function prepareStartedTasks(plan, checked, { fresh = false, address, env = process.env, run = runCommand, asset = createFreshOsAsset, host = prepareFreshDolt, init = initDoltProject } = {}) {
  if (!checked.enabled) return { ok: true, env: {}, run: null };
  if (checked.fresh && !fresh) return refusal('Automatic task setup requires the proven new Postgres installation.');
  try {
    const hosted = await host(plan, { fresh, env, run });
    if (!hosted.ok) return hosted;
    const ownEnv = { ...doltEnvironment(hosted.profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
    const repo = ownRepo(plan);
    if (checked.fresh) {
      for (const dir of [plan.home, path.join(plan.home, 'tasks'), plan.installation]) ownDirectory(dir);
      // No existing project, host mapping or saved document may be overwritten.
      const taskConfig = path.join(plan.installation, 'beads.json');
      const hostConfig = path.join(plan.installation, 'task-host.json');
      const integrationsFile = path.join(plan.installation, 'integrations.json');
      const panelsFile = path.join(plan.installation, 'signal-panels.json');
      if ([repo, coreFile(plan), taskConfig, hostConfig, integrationsFile, panelsFile].some(file => fs.lstatSync(file, { throwIfNoEntry: false }))) throw new Error('Unexpected task files.');
      // The document-side roster must also know the real is_os asset, so a
      // later task-project Save remains valid after the first site is added.
      // Read only the product default, never the host's installation exports.
      const integrations = JSON.parse(fs.readFileSync(path.join(plan.root, 'config', 'integrations.json'), 'utf8'));
      const panels = JSON.parse(fs.readFileSync(path.join(plan.root, 'config', 'signal-panels.json'), 'utf8'));
      for (const doc of [integrations, panels]) if (!doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets) || Object.keys(doc.assets).length) throw new Error('Fresh product roster is not empty.');
      fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
      const git = await run('git', ['init', '--quiet', repo], { cwd: plan.home, env: ownEnv });
      if (git.code !== 0) throw new Error('Could not initialize own task repository.');
      for (const [key, value] of [['user.name', 'NoticeOS'], ['user.email', 'noticeos@example.invalid']]) {
        if ((await run('git', ['-C', repo, 'config', '--local', key, value], { cwd: repo, env: ownEnv })).code !== 0) throw new Error('Could not configure own repository identity.');
      }
      const initialized = await init({ home: plan.home, repo, prefix: PREFIX, database: DATABASE }, { env, run, binary: checked.binary });
      if (!initialized.ok) return initialized;
      const osAsset = await asset(address);
      const core = { version: 1, beadsVersion: BEADS_VERSION, asset: osAsset, prefix: PREFIX, database: DATABASE, repo };
      fs.mkdirSync(plan.installation, { recursive: true, mode: 0o700 });
      writeJson(integrationsFile, { ...integrations, assets: { [osAsset]: {} } });
      writeJson(panelsFile, { ...panels, assets: { [osAsset]: { enabled: false, reason: 'no-lane-yet', since: new Date().toISOString().slice(0, 10) } } });
      writeJson(taskConfig, { version: 1, hub: { host: '127.0.0.1', port: hosted.profile.port, user: 'noticeos', dataDir: path.join(plan.home, 'dolt') },
        spokes: [{ asset: osAsset, prefix: PREFIX, database: DATABASE }] });
      writeJson(hostConfig, { version: 1, repositories: [{ asset: osAsset, prefix: PREFIX, database: DATABASE, repo }] });
      writeJson(coreFile(plan), core);
    }
    readStartedTaskCore(plan);
    return { ok: true, env: ownEnv, profile: hosted.profile,
      run: (args, { timeoutMs = 30_000 } = {}) => run(checked.binary, args, { cwd: plan.home, env: ownEnv, timeoutMs }) };
  } catch { return refusal('Task project setup did not finish; its files were preserved for explicit recovery.'); }
}
