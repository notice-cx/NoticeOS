// Foreground-owned development database for pnpm start.
// Never adopts a server or reads an installation/Compose database address.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openThrowaway } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace, frozenMigrationProblems, readMigrations } from './postgres-migrate.mjs';
import { readFrozenMarker } from './postgres-apply.mjs';
import { MANAGED_START_PORTS } from './start-postgres.mjs';

export const DEVELOPMENT_MARK = '.noticeos-development';
const MARK = 'Foreground-only NoticeOS development runtime. Database resets on stop.\n';
const RESERVATION = '.development-start-active';

/** Refuse mixed/adopted folders before any secret, config or server operation. */
export function developmentRefusal(plan, enabled) {
  const mark = path.join(plan.home, DEVELOPMENT_MARK);
  const stat = lstatSync(plan.home, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) return 'the runtime folder must be its own directory.';
  if (!enabled) return existsSync(mark) ? 'this is a development folder; restart it with --development.' : null;
  if (!stat || readdirSync(plan.home).length === 0) return null;
  const recorded = lstatSync(mark, { throwIfNoEntry: false });
  if (!recorded?.isFile() || recorded.isSymbolicLink() || readFileSync(mark, 'utf8') !== MARK) {
    return '--development requires an empty folder or a folder made by this development mode.';
  }
  const allowed = new Set([DEVELOPMENT_MARK, RESERVATION, path.basename(plan.mark), '.local', '.wrangler', 'apps', 'workers', 'installation']);
  if (readdirSync(plan.home).some(name => !allowed.has(name))) return 'the development folder contains unrelated files.';
  for (const name of ['.local', '.wrangler', 'apps', 'apps/tower', 'workers', 'workers/ingest', 'installation']) {
    const item = lstatSync(path.join(plan.home, name), { throwIfNoEntry: false });
    if (item && (!item.isDirectory() || item.isSymbolicLink())) return 'development state must use its own directories.';
  }
  if (existsSync(path.join(plan.home, RESERVATION)) || existsSync(path.join(plan.home, '.local', 'development-postgres'))) {
    return 'a prior development runtime still owns this folder; stop it or choose a new empty folder.';
  }
  // Runtime secret files may only be ordinary files in this owned folder.
  for (const file of [plan.secrets, plan.devVars, plan.mark]) {
    const item = lstatSync(file, { throwIfNoEntry: false });
    if (item && (!item.isFile() || item.isSymbolicLink())) return 'development runtime files must be owned regular files.';
  }
  return null;
}

/** A fresh cluster per foreground start. close() stops it before retiring data. */
export function openDevelopmentStart(plan) {
  const refusal = developmentRefusal(plan, true);
  if (refusal) throw new Error(refusal);
  const port = plan.port + 2;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || MANAGED_START_PORTS.includes(port)) {
    throw new Error('the development Postgres port (--port + 2) is invalid or reserved.');
  }
  const dir = path.join(plan.root, 'db', 'postgres', 'migrations');
  const frozen = readFrozenMarker(path.join(plan.root, 'db', 'postgres', 'frozen-migrations.sha256'));
  if (frozenMigrationProblems(frozen, { dir }).length || frozen.split('\n').filter(line => line.trim()).length !== readMigrations(dir).length) {
    throw new Error('development startup requires the complete committed frozen migration set.');
  }
  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  if (lstatSync(plan.home).isSymbolicLink()) throw new Error('the development folder changed during setup.');
  const reservation = path.join(plan.home, RESERVATION);
  writeFileSync(reservation, String(process.pid), { flag: 'wx', mode: 0o600 });
  const clusterRoot = path.join(plan.home, '.local', 'development-postgres');
  let cluster = null;
  let ownsClusterRoot = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    cluster?.close();
    const pidFile = path.join(clusterRoot, 'data', 'postmaster.pid');
    if (ownsClusterRoot && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
      try { process.kill(pid, 0); throw new Error('development Postgres is still running; its files were preserved.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (ownsClusterRoot) rmSync(clusterRoot, { recursive: true, force: true });
    rmSync(reservation);
    closed = true;
  };
  try {
    writeFileSync(path.join(plan.home, DEVELOPMENT_MARK), MARK, { mode: 0o600 });
    writeFileSync(plan.mark, 'Local runtime files for a development-only NoticeOS instance.\n');
    mkdirSync(path.dirname(clusterRoot), { recursive: true, mode: 0o700 });
    if (lstatSync(path.dirname(clusterRoot)).isSymbolicLink()) throw new Error('development state changed during setup.');
    mkdirSync(clusterRoot, { mode: 0o700 });
    ownsClusterRoot = true;
    cluster = openThrowaway(clusterRoot, undefined, { loopbackPort: port });
    applyMigrations(cluster, { dir });
    const workspace = bootstrapWorkspace(cluster, { slug: 'development', displayName: 'Development sites', dir });
    return { address: cluster.applicationLogin().url(), workspaceId: workspace.workspaceId, close };
  } catch (error) {
    close();
    throw error;
  }
}
