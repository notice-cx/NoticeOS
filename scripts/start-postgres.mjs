// First-run Postgres for pnpm start and explicit synthetic demo setup: frozen
// schema and one workspace, only in a proven new/empty installation and its
// own new local Compose project.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { devNull } from 'node:os';
import { doorIsHeld, MANAGED_DOOR } from './ingest-door.mjs';
import { runCommand } from './run-command.mjs';
import { localDocker } from './postgres-compose.mjs';
import { EMPTY_INSTALLATION_SQL } from './postgres-empty.mjs';
import { ADDRESS_FILE, DATABASE, DEFAULT_PORT as POSTGRES_PORT, SECRETS_DIR_VARIABLE, writeSecrets } from './postgres-secrets.mjs';
import { checkTarget, installationPlan, openInstallationDatabase, readFrozenMarker } from './postgres-apply.mjs';
import { applyMigrations, bootstrapWorkspace, frozenMigrationProblems, readMigrations } from './postgres-migrate.mjs';

const OWNER_URL_VARIABLE = 'NOTICEOS_FIRST_START_OWNER_URL';
export const MANAGED_START_PORTS = Object.freeze([5173, Number(new URL(MANAGED_DOOR).port), 3308, POSTGRES_PORT]);
const refusal = (line) => ({ ok: false, line });
const RESERVATION = '.noticeos-first-start';

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function canonical(file) {
  if (existsSync(file)) return realpathSync(file);
  const parent = path.dirname(file);
  return parent === file ? file : path.join(canonical(parent), path.basename(file));
}

/** Stable identity for this installation, including across later starts. */
export function startPostgresPlan(plan) {
  const home = canonical(plan.home);
  return {
    project: `noticeos-start-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`,
    secrets: path.join(plan.home, 'postgres', 'secrets'),
    port: plan.port + 2,
    compose: path.join(plan.root, 'db', 'postgres', 'host', 'compose.yaml'),
  };
}

/** Empty means no user schema, relation, function or type, even outside
 * NoticeOS. Only the extension objects created by this profile are allowed. */
export function databaseEmpty(own) {
  const target = checkTarget({ database: DATABASE, urlFrom: OWNER_URL_VARIABLE }, {
    [OWNER_URL_VARIABLE]: readFileSync(path.join(own.secrets, 'owner.url'), 'utf8').trim(),
  });
  const db = openInstallationDatabase(target);
  const [row] = db.script(EMPTY_INSTALLATION_SQL);
  return row?.empty === 't';
}

function freshWorkspace(value) {
  if (value === undefined) return Object.freeze({ slug: 'main', displayName: 'My sites' });
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== 'displayName,slug,workspaceId' ||
      typeof value.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.slug) ||
      typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.displayName) ||
      typeof value.workspaceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.workspaceId)) {
    throw new Error('invalid fresh workspace declaration');
  }
  return Object.freeze({ ...value });
}

function applyFreshSchema(own, { workspace, dir, frozen }) {
  const target = checkTarget({ database: DATABASE, urlFrom: OWNER_URL_VARIABLE }, {
    [OWNER_URL_VARIABLE]: readFileSync(path.join(own.secrets, 'owner.url'), 'utf8').trim(),
  });
  const db = openInstallationDatabase(target);
  if (installationPlan(db, { dir, frozen }).stops.length) return false;
  applyMigrations(db, { dir });
  const checked = installationPlan(db, { dir, frozen });
  if (checked.stops.length || checked.pending.length) return false;
  const result = bootstrapWorkspace(db, { ...workspace, dir });
  return result.created && (workspace.workspaceId === undefined || result.workspaceId === workspace.workspaceId);
}

/** Prepare Postgres once, before startup creates any folder state. Existing
 * installations never enter setup. Effects are injected by the safety tests;
 * setup uses the same target checks, migration plan and bootstrap as the CLI.
 * A declared workspace changes only the new bootstrap identity; it is validated
 * before effects. Schema provenance is returned only after new setup succeeds. */
export async function prepareFreshPostgres(plan, {
  env = process.env,
  run = runCommand,
  held = doorIsHeld,
  empty = databaseEmpty,
  apply = applyFreshSchema,
  freeze = null,
  alive = processAlive,
  requireTasks = false,
  workspace: declaredWorkspace,
} = {}) {
  let active = null;
  try {
    const workspace = freshWorkspace(declaredWorkspace);
    if (lstatSync(plan.home, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return refusal('the installation folder is a symbolic link; choose its own empty folder with --dir.');
    }
    const own = startPostgresPlan(plan);
    const reservation = path.join(plan.home, RESERVATION);
    const pidFile = path.join(reservation, 'active.json');
    if (existsSync(pidFile)) {
      const pid = JSON.parse(readFileSync(pidFile, 'utf8')).pid;
      if (Number.isInteger(pid) && alive(pid)) return refusal('another first startup is preparing this installation; let it finish before starting again.');
    }
    const configured = ['DATABASE_URL', SECRETS_DIR_VARIABLE, 'NOTICEOS_POSTGRES_PORT'].some(name => env[name] !== undefined);
    const entries = existsSync(plan.home) ? readdirSync(plan.home) : [];
    if (configured || entries.length) {
      // A successful first run keeps its own address; old/manual installations
      // still take the explicitly configured profile or the historical default.
      const ownAddress = !env[SECRETS_DIR_VARIABLE] && existsSync(path.join(own.secrets, ADDRESS_FILE));
      return { ok: true, created: false, env: ownAddress ? { [SECRETS_DIR_VARIABLE]: own.secrets } : {} };
    }

    const dir = path.join(plan.root, 'db', 'postgres', 'migrations');
    const marker = freeze ?? readFrozenMarker(path.join(plan.root, 'db', 'postgres', 'frozen-migrations.sha256'));
    const migrations = readMigrations(dir);
    if (!migrations.length || frozenMigrationProblems(marker, { dir }).length || marker.split('\n').filter(line => line.trim()).length !== migrations.length) {
      return refusal('the Postgres baseline is not fully frozen; freeze and commit db/postgres/frozen-migrations.sha256 before first startup.');
    }
    if (!Number.isInteger(own.port) || own.port < 1024 || own.port > 65535 || MANAGED_START_PORTS.includes(own.port)) {
      return refusal('the derived Postgres port (--port + 2) is invalid or belongs to the NoticeOS stack; choose another --port.');
    }
    if (await held(`http://127.0.0.1:${own.port}`)) {
      return refusal('the derived Postgres port (--port + 2) is in use; choose another --port.');
    }
    const composeEnv = { ...env, [SECRETS_DIR_VARIABLE]: own.secrets, NOTICEOS_POSTGRES_PORT: String(own.port) };
    const execute = (args, timeoutMs = 30_000) => run('docker', args, { cwd: plan.root, env: composeEnv, timeoutMs });
    // Context configuration is local metadata; refuse remote endpoints before
    // any resource request. Never inspect a host-wide container/volume list.
    if (!await localDocker(run, { cwd: plan.root, env: composeEnv })) {
      return refusal('first startup needs a local Docker Compose container app; select its local context and try again.');
    }
    const args = ['compose', '-p', own.project, '-f', own.compose, '--env-file', devNull];
    const project = await execute([...args, 'ps', '--all', '--quiet']);
    if (project.code !== 0) return refusal('Docker Compose could not check this new project; start the container app and try again.');
    if (project.stdout.trim()) return refusal('this installation’s Compose project already exists; automatic setup is only for a new, empty installation.');
    const volume = await execute(['volume', 'inspect', `${own.project}_postgres-data`]);
    if (volume.code === 0) return refusal('this installation’s Postgres volume already exists; automatic setup is only for a new, empty installation.');
    if (!/no such volume/iu.test(volume.stderr)) return refusal('Docker Compose could not prove this installation’s Postgres volume is new; nothing was set up.');

    mkdirSync(plan.home, { recursive: true, mode: 0o700 });
    if (lstatSync(plan.home).isSymbolicLink()) return refusal('the installation folder became a symbolic link; nothing was set up.');
    // An exclusive reservation also prevents two first starts from both
    // generating secrets. A failed setup is preserved for operator recovery.
    mkdirSync(reservation, { mode: 0o700 });
    if (readdirSync(plan.home).some(name => name !== RESERVATION)) {
      return refusal('the installation folder gained files while first startup was checked; nothing was set up.');
    }
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    active = pidFile;
    if (requireTasks) writeFileSync(path.join(reservation, 'tasks-required'), 'Core task setup is required for this new installation.\n', { flag: 'wx', mode: 0o600 });
    // Provenance permits ordinary startup after an explicit operator repair.
    // The active record above keeps concurrent starts out during preparation.
    writeFileSync(plan.mark, 'NoticeOS runtime files; operational data lives in this installation’s Postgres.\n', { flag: 'wx' });
    writeSecrets(own.secrets, { port: own.port });
    writeFileSync(path.join(plan.home, 'postgres', 'profile.json'), `${JSON.stringify({ project: own.project, composeFile: own.compose, secretsDir: own.secrets, port: own.port }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const started = await execute([...args, 'up', '--detach', '--wait', '--wait-timeout', '180', 'postgres'], 240_000);
    if (started.code !== 0) return refusal('this installation’s Postgres could not start; its files were preserved for operator recovery (db/postgres/host/README.md).');
    if (!await empty(own)) return refusal('the database is not empty; automatic setup applied nothing. Use the operator commands in db/postgres/host/README.md.');
    if (!await apply(own, { workspace, dir, frozen: marker })) return refusal('the frozen Postgres setup did not finish; its files were preserved for operator recovery (db/postgres/host/README.md).');
    return { ok: true, created: true, env: { [SECRETS_DIR_VARIABLE]: own.secrets }, schema: {
      frozenSha256: createHash('sha256').update(marker).digest('hex'),
      migrations: migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
    } };
  } catch {
    // Driver/Docker errors can repeat a connection string. Keep every raw
    // response behind this interface and never retry an uncertain setup.
    return refusal('first startup could not finish; any files were preserved for operator recovery (db/postgres/host/README.md).');
  } finally {
    if (active !== null) {
      try { rmSync(active, { force: true }); } catch { /* preserved; a later process can detect a stale pid */ }
    }
  }
}
