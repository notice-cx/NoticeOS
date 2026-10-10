// Where the live OS's code runs from, and where its state stays. The managed
// service runs from a runtime copy of the code, a git worktree under
// `<home>/.local/runtime/` that merges never touch and only `pnpm os:deploy`
// moves, so a merge to main never hot-reloads production. Everything that is
// not code stays in the home checkout: the local R2 archive (`.wrangler/`),
// logs, heartbeat, schedules, backups and signal dumps (`.local/`), the
// legacy secret source and its generated bindings, and the host-only task
// inventory, whose relative paths mean "beside the home folder".
//
// Two mechanisms, both needed: `NOTICEOS_HOME` (set by the launchd plist;
// scripts/product-env.mts) names the home checkout for the runner and the
// Tower's local lanes, and inside each runtime copy `.wrangler`, `.local` and
// the two secret files are symbolic links to the home paths, because plenty
// of code finds its state relative to its own file and wrangler reads
// `.dev.vars` from beside the Worker config. Nothing here ever opens a secret
// file, and the store is never copied, moved or re-created.
//
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TASK_HOST_FILE, readablePath } from './installation.mjs';
import { stripJsonc } from './jsonc.mjs';
import { PRODUCT_ENV, readProductEnv } from './product-env.mjs';

/** The environment variable that names the home checkout
 * (scripts/product-env.mts also reads its legacy name). */
export const HOME_ENV = PRODUCT_ENV.home.name;

/** Where the runtime copies live, relative to the home checkout. */
export const RUNTIME_DIR = path.join('.local', 'runtime');

/**
 * Two copies, used alternately. A deploy prepares the idle one while the live
 * one keeps serving, then points `current` at it and restarts once; the
 * previous copy stays ready for `pnpm os:deploy -- --rollback`.
 */
export const RUNTIME_SLOTS = Object.freeze(['runtime-a', 'runtime-b']);

/** The link the launchd plist runs through: `<home>/.local/runtime/current`. */
export const CURRENT_LINK = 'current';

/** A commit without this file predates the runtime copy and cannot run from one. */
export const RUNTIME_MARKER = 'scripts/os-runtime.mjs';

/** Why the runtime worktrees are locked (shown by `git worktree list`). */
export const RUNTIME_LOCK_REASON =
  'NoticeOS live runtime: moved only by pnpm os:deploy, never remove by hand';

export function runtimeLayout(homeRoot) {
  const dir = path.join(homeRoot, RUNTIME_DIR);
  return {
    dir,
    current: path.join(dir, CURRENT_LINK),
    slots: RUNTIME_SLOTS.map((name) => ({ name, root: path.join(dir, name) })),
  };
}

/**
 * The home checkout of a runtime copy, when `codeRoot` IS one
 * (`<home>/.local/runtime/runtime-a`), else null. Lets a runner started from a
 * runtime copy by hand, without the plist's environment, still find home.
 */
export function homeOfRuntimeSlot(codeRoot) {
  const slot = path.basename(codeRoot);
  const runtimeDir = path.dirname(codeRoot);
  const localDir = path.dirname(runtimeDir);
  if (!RUNTIME_SLOTS.includes(slot)) return null;
  if (path.basename(runtimeDir) !== path.basename(RUNTIME_DIR)) return null;
  if (path.basename(localDir) !== path.dirname(RUNTIME_DIR)) return null;
  return path.dirname(localDir);
}

/** The home checkout: the environment's word first, then the layout, else the code's own root. */
export function resolveHomeRoot(codeRoot, env = process.env) {
  const explicit = readProductEnv(env, 'home');
  if (explicit) return path.resolve(explicit);
  return homeOfRuntimeSlot(codeRoot) ?? codeRoot;
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
 * Every shared path a runtime copy links back to home, relative to a checkout
 * root. The order is the order they are created and reported.
 */
export const SHARED_STATE = Object.freeze([
  Object.freeze({ path: '.wrangler', what: 'the local R2 archive' }),
  Object.freeze({ path: '.local', what: 'logs, heartbeat, schedules, backups and signal dumps' }),
  Object.freeze({ path: path.join('workers', 'ingest', '.dev.secrets.json'), what: 'the legacy local secret source' }),
  Object.freeze({ path: path.join('workers', 'ingest', '.dev.vars'), what: 'the bindings generated from it' }),
]);

/** Every state path the runner and the deploy use, from the home checkout. */
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
    deploysFile: path.join(logsDir, 'deploys.jsonl'),
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
 * Make every SHARED_STATE path inside a runtime copy a link to the home path.
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

/** Whether one Worker config can run on the sole operational backend.
 * Missing, malformed and legacy bindings refuse before any database contact. */
export function postgresConfigRefusal(text, label = 'Worker config') {
  let config;
  try {
    config = JSON.parse(stripJsonc(String(text ?? '')));
  } catch {
    return `${label} is unreadable; a Postgres runtime cannot be verified.`;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return `${label} is invalid; a Postgres runtime cannot be verified.`;
  }
  if (config.d1_databases !== undefined
    && (!Array.isArray(config.d1_databases) || config.d1_databases.length > 0)) {
    return `${label} declares D1; only Postgres runtime releases are supported.`;
  }
  if (!Array.isArray(config.hyperdrive)
    || !config.hyperdrive.some((binding) => binding?.binding === 'POSTGRES')) {
    return `${label} has no POSTGRES binding; only Postgres runtime releases are supported.`;
  }
  return null;
}

// ─── The installed service ──────────────────────────────────────────────────

/**
 * What the installed launchd plist runs: `runtime` (the runtime copy's
 * `current` link), `checkout` (the home checkout itself), `missing`, or
 * `other`.
 */
export function plistRunsFrom(plistText, homeRoot) {
  if (plistText === null || plistText === undefined) return 'missing';
  const strings = [...String(plistText).matchAll(/<string>([^<]*)<\/string>/gu)].map((m) =>
    m[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'"),
  );
  const runner = strings.find((value) => value.endsWith(`${path.sep}scripts${path.sep}os-up.mjs`));
  if (!runner) return 'other';
  if (runner === path.join(runtimeLayout(homeRoot).current, 'scripts', 'os-up.mjs')) return 'runtime';
  if (runner === path.join(homeRoot, 'scripts', 'os-up.mjs')) return 'checkout';
  return 'other';
}
