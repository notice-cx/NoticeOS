// Where the OS's code runs from, and where its state stays. The container
// image keeps its code in one folder and the installation's state in another
// (deploy/compose/Dockerfile): the local R2 archive (`.wrangler/`), logs,
// heartbeat, schedules, backups and signal dumps (`.local/`), the bootstrap
// secrets file and its generated bindings, and the host-only task inventory,
// whose relative paths mean "beside the home folder".
//
// Two mechanisms, both needed: `NOTICEOS_HOME` (scripts/product-env.mts)
// names the home folder for the runner and the Tower's local lanes, and inside
// the code folder `.wrangler`, `.local` and the two secret files are symbolic
// links to the home paths, because plenty of code finds its state relative to
// its own file and wrangler reads `.dev.vars` from beside the Worker config.
// Nothing here ever opens a secret file, and the store is never copied, moved
// or re-created.
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TASK_HOST_FILE, readablePath } from './installation.mjs';
import { stripJsonc } from './jsonc.mjs';
import { PRODUCT_ENV, readProductEnv } from './product-env.mjs';

/** The environment variable that names the home checkout
 * (scripts/product-env.mts also reads its legacy name). */
export const HOME_ENV = PRODUCT_ENV.home.name;

/** The home folder: the environment's word, else the code's own root. */
export function resolveHomeRoot(codeRoot, env = process.env) {
  const explicit = readProductEnv(env, 'home');
  return explicit ? path.resolve(explicit) : codeRoot;
}

export { invokedDirectly } from './invoked-directly.mjs';

/** Same place on disk? Compared through realpath, so `/tmp` vs `/private/tmp` agree. */
export function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Every shared path the code folder links back to home, relative to a checkout
 * root. The order is the order they are created and reported.
 */
export const SHARED_STATE = Object.freeze([
  Object.freeze({ path: '.wrangler', what: 'the local R2 archive' }),
  Object.freeze({ path: '.local', what: 'logs, heartbeat, schedules, backups and signal dumps' }),
  Object.freeze({ path: path.join('workers', 'ingest', '.dev.secrets.json'), what: 'the bootstrap secrets file' }),
  Object.freeze({ path: path.join('workers', 'ingest', '.dev.vars'), what: 'the bindings generated from it' }),
]);

/** Every state path the runner uses, from the home folder. */
export function statePaths(homeRoot) {
  const localDir = path.join(homeRoot, '.local');
  const logsDir = path.join(localDir, 'logs');
  const persistState = path.join(homeRoot, '.wrangler', 'state');
  const ingestDir = path.join(homeRoot, 'workers', 'ingest');
  return {
    homeRoot,
    persistState,
    localDir,
    logsDir,
    logFile: path.join(logsDir, 'os-up.log'),
    jobRunsFile: path.join(logsDir, 'job-runs.jsonl'),
    runnerStateFile: path.join(localDir, 'runner-state.json'),
    backupsDir: path.join(localDir, 'backups'),
    beadsDoltDir: path.join(localDir, 'beads-dolt'),
    devSecrets: path.join(ingestDir, '.dev.secrets.json'),
    devVars: path.join(ingestDir, '.dev.vars'),
    taskHost: readablePath(TASK_HOST_FILE, { root: homeRoot }),
  };
}

/**
 * The environment the runner hands its Tower child, so the dev server opens
 * the home store (`OS_UP_PERSIST_STATE`, apps/tower/vite.config.ts) and its
 * local lanes read and commit in the home checkout (`NOTICEOS_HOME`,
 * apps/tower/vite/lane.ts). An explicit persist override already in the
 * environment is a test harness's, and is kept.
 */
export function runtimeChildEnv(homeRoot, env = process.env) {
  const override = typeof env?.OS_UP_PERSIST_STATE === 'string' ? env.OS_UP_PERSIST_STATE.trim() : '';
  return {
    [HOME_ENV]: homeRoot,
    OS_UP_PERSIST_STATE: override || statePaths(homeRoot).persistState,
  };
}

/**
 * Make every SHARED_STATE path inside the code folder a link to the home path.
 * Idempotent, and it never deletes or replaces anything: a real file or
 * directory where a link belongs, or a link pointing elsewhere, is reported
 * as a conflict and left as found. It never opens a target.
 */
export async function ensureSharedStateLinks({ codeRoot, homeRoot, fsp = fs } = {}) {
  const result = { created: [], linked: [], conflicts: [] };
  if (samePath(codeRoot, homeRoot)) return result;
  for (const { path: relative, what } of SHARED_STATE) {
    const link = path.join(codeRoot, relative);
    const target = path.join(homeRoot, relative);
    let stat = null;
    try {
      stat = await fsp.lstat(link);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        result.conflicts.push({ path: relative, what, reason: `could not inspect it (${error.message})` });
        continue;
      }
    }
    if (stat === null) {
      await fsp.mkdir(path.dirname(link), { recursive: true });
      await fsp.symlink(target, link);
      result.created.push(relative);
      continue;
    }
    if (!stat.isSymbolicLink()) {
      result.conflicts.push({
        path: relative,
        what,
        reason: `is a real ${stat.isDirectory() ? 'directory' : 'file'}, not a link to ${target}`,
      });
      continue;
    }
    const points = path.resolve(path.dirname(link), await fsp.readlink(link));
    if (points !== target && !samePath(points, target)) {
      result.conflicts.push({ path: relative, what, reason: `links to ${points}, not ${target}` });
      continue;
    }
    result.linked.push(relative);
  }
  return result;
}

/** One line per conflict, for a refusal. */
export function linkConflictLines(conflicts, codeRoot) {
  return conflicts.map(
    (conflict) =>
      `${path.join(codeRoot, conflict.path)} ${conflict.reason} (${conflict.what}). ` +
      'Nothing was changed; move it aside by hand once you know what it holds.',
  );
}

/**
 * The cron expressions a Worker config schedules (`triggers.crons`), in order;
 * [] when it names none. Throws when the text is not JSON(C), so a caller can
 * say which file was unreadable.
 */
export function workerCrons(wranglerJsonc) {
  const config = JSON.parse(stripJsonc(String(wranglerJsonc ?? '')));
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons)) return [];
  return crons.filter((c) => typeof c === 'string' && c.trim().length > 0);
}
