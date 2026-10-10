// `pnpm os:deploy`: move the live OS to a verified main commit.
//
// The managed service runs from a runtime copy under `<home>/.local/runtime/`
// (scripts/os-runtime.mjs), so a merge changes nothing live; this is the one
// step that does.
//
//   pnpm os:deploy                 main's HEAD → the live OS, one restart, health wait
//   pnpm os:deploy -- <commit>     a commit main already contains
//   pnpm os:deploy -- --check      verify only; changes nothing
//   pnpm os:deploy -- --rollback   back to the previous runtime copy, one restart
//
// Verified, before anything is written: the commit is on main; it is a
// fast-forward from the commit the OS runs now; it carries the runtime-copy
// support; both runtime copies are clean; both Worker configs use Postgres
// alone; and every Postgres migration it carries is one the installation's
// database records applying with the same SHA-256, read in a READ ONLY
// transaction through the address the runner starts with, never printed. A
// migration the database records and the commit does not carry (a rollback
// past a migration) is named and allowed. CI results are not visible here,
// so "verified" does not claim them.
//
// Two runtime copies are used alternately: the idle one is prepared while the
// live one keeps serving, then `current` is pointed at it and the service
// restarts once, and the new runner must report the deployed commit. When
// that restart does not come back healthy the deploy rolls back by itself, at
// most once; nothing ever loops between the two copies.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RESOURCE_NAMES_FILE, checkoutRelative, installationPath } from './installation.mjs';
import { MIGRATION_FILE, migrationStates } from './postgres-migration-states.mjs';
import { applyResourceNames, readResourceNames } from './resource-names.mjs';
import {
  RUNTIME_LOCK_REASON,
  RUNTIME_MARKER,
  ensureSharedStateLinks,
  homeOfRuntimeSlot,
  linkConflictLines,
  plistRunsFrom,
  postgresConfigRefusal,
  runtimeLayout,
  samePath,
  statePaths,
} from './os-runtime.mjs';
import { stripJsonc } from './jsonc.mjs';

/** A fresh runtime copy's first start may pre-bundle dependencies, so a deploy
 * waits longer for health than a plain restart of warm code does. */
export const DEPLOY_HEALTH_WAIT_MS = 90_000;

/** The operator's sequence for a Postgres migration. The database and how its owner logs in
 * are the operator's to name: the deploy knows neither, and prints no address. */
export const POSTGRES_MIGRATION_SEQUENCE = [
  'pnpm os:stop',
  'pnpm postgres:migrate apply --database <name> [<connection>] --confirm <name>',
  'pnpm os:start',
];

/** How a refusal names Postgres migrations and points to the operator sequence. */
export const POSTGRES_MIGRATIONS = Object.freeze({
  kind: 'Postgres migration',
  database: "the installation's database",
  sequence: POSTGRES_MIGRATION_SEQUENCE,
  written: `db/postgres/README.md, "Applying it to an installation's own database"`,
});

/** What a person runs when the OS is down and nothing more will be tried by itself. */
export const NEXT_STEP = 'Next: pnpm os:doctor';

export const DEPLOY_USAGE =
  'pnpm os:deploy [-- <commit>]   move the live OS to main (or a commit on main): one restart, health wait\n' +
  'pnpm os:deploy -- --check      verify what a deploy would do; changes nothing\n' +
  'pnpm os:deploy -- --rollback   return to the previous runtime copy: one restart, health wait\n';

const short = (commit) => (commit ? String(commit).slice(0, 8) : 'none');

/** Where miniflare keeps each local R2 bucket beside its object index. */
const R2_INDEX_DIR = 'miniflare-R2BucketObject';

/**
 * The raw-signal bucket a commit opens on this installation: its ingest
 * Worker config's RAW_SIGNALS bucket, with the installation's resource names
 * applied exactly as the Tower's dev server applies them. Null when the
 * config binds no such bucket.
 */
export function openedRawSignalsBucket(configText, names) {
  const config = JSON.parse(stripJsonc(String(configText ?? '')));
  applyResourceNames(config, names);
  return (config.r2_buckets ?? []).find((bucket) => bucket.binding === 'RAW_SIGNALS')?.bucket_name ?? null;
}

/** The buckets this installation's local store holds objects under: miniflare
 * keeps each one's blobs in a folder named for it. */
export async function localBuckets(homeRoot, fsp = fs) {
  try {
    const entries = await fsp.readdir(path.join(statePaths(homeRoot).persistState, 'v3', 'r2'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name !== R2_INDEX_DIR).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function compact(value) {
  return String(value ?? '').replace(/[\r\n\t ]+/gu, ' ').trim();
}

export function parseDeployArgs(argv) {
  const options = { check: false, rollback: false, target: 'main' };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--check') options.check = true;
    else if (arg === '--rollback') options.rollback = true;
    else if (arg.startsWith('-')) throw new Error(`os:deploy does not know ${arg}\n\n${DEPLOY_USAGE}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`os:deploy takes at most one commit\n\n${DEPLOY_USAGE}`);
  if (positional.length === 1) {
    if (options.rollback) throw new Error('--rollback returns to the previous runtime copy; it takes no commit');
    options.target = positional[0];
  }
  return options;
}

// ─── Reading the repository ──────────────────────────────────────────────────

function gitRunner(deps) {
  return (cwd, args) => deps.run('git', args, { cwd, timeoutMs: 60_000 });
}

async function resolveCommit(git, cwd, rev) {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const commit = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null;
}

/** true / false, or null when git could not answer. */
async function isAncestor(git, cwd, ancestor, descendant) {
  const result = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return null;
}

async function exists(fsp, file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** The slot `current` points at, null before the first deploy, or a problem. */
export async function readLiveSlot(layout, fsp = fs) {
  let stat;
  try {
    stat = await fsp.lstat(layout.current);
  } catch (error) {
    if (error?.code === 'ENOENT') return { slot: null };
    return { problem: `could not inspect ${layout.current} (${error.message})` };
  }
  if (!stat.isSymbolicLink()) {
    return { problem: `${layout.current} is a real ${stat.isDirectory() ? 'directory' : 'file'}, not the link a deploy moves. Nothing was changed.` };
  }
  const name = path.basename(await fsp.readlink(layout.current));
  const slot = layout.slots.find((candidate) => candidate.name === name);
  if (!slot) return { problem: `${layout.current} points at ${name}, which is not a runtime copy (${layout.slots.map((s) => s.name).join(' or ')}).` };
  return { slot };
}

/** A runtime copy's commit and cleanliness, or why it is not a usable copy. */
async function inspectSlot(git, homeRoot, slot, fsp) {
  if (!(await exists(fsp, slot.root))) return { exists: false };
  const top = await git(slot.root, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  const home = await git(homeRoot, ['rev-parse', '--git-common-dir']);
  const [toplevel, common] = top.stdout.trim().split('\n');
  const resolveCommon = (dir, value) => path.resolve(dir, String(value ?? '').trim());
  if (
    top.code !== 0 ||
    home.code !== 0 ||
    !samePath(toplevel ?? '', slot.root) ||
    !samePath(resolveCommon(slot.root, common), resolveCommon(homeRoot, home.stdout))
  ) {
    return { exists: true, problem: `${slot.root} exists but is not a runtime copy of this repository. Nothing was changed; move it aside by hand.` };
  }
  const commit = await resolveCommit(git, slot.root, 'HEAD');
  const status = await git(slot.root, ['status', '--porcelain', '--untracked-files=normal']);
  if (status.code !== 0) return { exists: true, commit, problem: `could not read ${slot.root}'s status (${compact(status.stderr)})` };
  const dirty = status.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { exists: true, commit, dirty };
}

function dirtyRefusal(slot, dirty, role) {
  const shown = dirty.slice(0, 5).join(', ');
  const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : '';
  return (
    `the ${role} runtime copy (${slot.root}) has local changes: ${shown}${more}. ` +
    'Production was edited by hand; land the change on main instead. Nothing was changed.'
  );
}

async function fileAt(git, homeRoot, commit, file) {
  const shown = await git(homeRoot, ['show', `${commit}:${file}`]);
  return shown.code === 0 ? shown.stdout : null;
}

async function hasFile(git, homeRoot, commit, file) {
  return (await git(homeRoot, ['cat-file', '-e', `${commit}:${file}`])).code === 0;
}

/** The Postgres migration files a commit carries, each with the SHA-256 of its
 * bytes as the runner records it; null when git cannot list or show them. */
export async function postgresMigrationFiles(git, homeRoot, commit) {
  const listed = await git(homeRoot, ['ls-tree', '--name-only', `${commit}:db/postgres/migrations`]);
  if (listed.code !== 0) return null;
  const files = [];
  for (const file of listed.stdout.split('\n').map((line) => line.trim()).filter((name) => MIGRATION_FILE.test(name)).sort()) {
    // The blob exactly as committed; it arrives as UTF-8 text, which a
    // migration is, so encoding it again gives back the file's bytes.
    const blob = await git(homeRoot, ['cat-file', 'blob', `${commit}:db/postgres/migrations/${file}`]);
    if (blob.code !== 0) return null;
    files.push({
      version: Number(MIGRATION_FILE.exec(file)[1]),
      name: file.replace(/\.sql$/u, ''),
      sha256: createHash('sha256').update(Buffer.from(blob.stdout, 'utf8')).digest('hex'),
    });
  }
  return files;
}

export function migrationRefusal(pending, commit, store = POSTGRES_MIGRATIONS) {
  return [
    `${short(commit)} carries ${pending.length} ${store.kind}${pending.length === 1 ? '' : 's'} ${store.database} has not applied: ${pending.join(', ')}.`,
    `A deploy never applies migrations — they are operator-only (${store.written}). Once approved:`,
    ...store.sequence.map((step) => `    ${step}`),
    '  then run pnpm os:deploy again.',
  ].join('\n');
}

const listed = (migrations) => migrations.map((m) => m.name).join(', ');

/**
 * Hold a commit's Postgres migrations against the database's record: each
 * sentence that stops the deploy, and each check it passes. Applying helps a
 * pending migration only; a changed or out-of-order one needs another commit.
 */
export function postgresVerdict(files, records, commit) {
  const { migrations, pending } = migrationStates(files, records);
  const of = (state) => migrations.filter((m) => m.state === state);
  const [changed, outOfOrder, missing] = [of('changed'), of('out-of-order'), of('missing')];
  const refusals = [];
  const checks = [];
  if (changed.length > 0) {
    refusals.push(
      `${short(commit)}'s ${listed(changed)} differ${changed.length === 1 ? 's' : ''} from what the installation's database applied under the same number ` +
        '(another name or SHA-256). A recorded migration is never edited, so this commit expects a schema the database does not have: ' +
        'deploy a commit whose files match, with the change as the next migration (db/postgres/README.md, "Changing the schema").',
    );
  }
  if (outOfOrder.length > 0) {
    refusals.push(
      `${short(commit)} carries ${listed(outOfOrder)}, older than a migration the installation's database has already applied; ` +
        'pnpm postgres:migrate apply refuses that too. pnpm postgres:migrate status shows what the database has.',
    );
  }
  if (pending.length > 0) {
    refusals.push(migrationRefusal(pending.map((m) => m.name), commit, POSTGRES_MIGRATIONS));
  }
  if (refusals.length === 0) {
    checks.push(`the installation's database has all ${files.length} of its Postgres migrations applied (read-only check)`);
  }
  if (missing.length > 0) {
    checks.push(
      `the installation's database also has ${listed(missing)}, which ${short(commit)} does not carry (a rollback past a migration); ` +
        'allowed: a migration keeps the code before it working (db/postgres/README.md, "Changing the schema")',
    );
  }
  return { migrations, refusals, checks };
}

// ─── Planning ───────────────────────────────────────────────────────────────

/**
 * Everything a deploy (or rollback) needs to know, and every reason it must
 * not happen. Reads only: git, the runtime links, each store's migration
 * record (`deps.readPostgresMigrations` reads the Postgres one, for a commit
 * that opens it).
 */
export async function planDeploy({ homeRoot, target = 'main', rollback = false, deps }) {
  const fsp = deps.fsp ?? fs;
  const git = gitRunner(deps);
  const layout = runtimeLayout(homeRoot);
  const refusals = [];
  const checks = [];
  const plan = { homeRoot, layout, rollback, noop: false, main: null, target: null, live: null, into: null };
  const done = () => ({ ok: refusals.length === 0, refusals, checks, plan });

  if (homeOfRuntimeSlot(homeRoot)) {
    refusals.push(`${homeRoot} is a runtime copy. Run pnpm os:deploy from the main folder it belongs to.`);
    return done();
  }
  plan.main = await resolveCommit(git, homeRoot, 'main');
  if (!plan.main) {
    refusals.push(`${homeRoot} has no main branch to deploy from.`);
    return done();
  }

  const live = await readLiveSlot(layout, fsp);
  if (live.problem) {
    refusals.push(live.problem);
    return done();
  }
  if (live.slot) {
    const state = await inspectSlot(git, homeRoot, live.slot, fsp);
    if (!state.exists || state.problem || !state.commit) {
      refusals.push(state.problem ?? `the live runtime copy ${live.slot.root} is missing. Nothing was changed.`);
      return done();
    }
    plan.live = { ...live.slot, commit: state.commit };
    if (state.dirty.length === 0) checks.push(`the live runtime copy (${live.slot.name}) is clean`);
    // A rollback leaves the live copy as it is, so a hand edit there does not
    // block getting back to working code.
    else if (!rollback) refusals.push(dirtyRefusal(live.slot, state.dirty, 'live'));
  }

  const idle = plan.live
    ? layout.slots.find((slot) => slot.name !== plan.live.name)
    : layout.slots[0];
  const idleState = await inspectSlot(git, homeRoot, idle, fsp);

  if (rollback) {
    if (!plan.live) {
      refusals.push('nothing to roll back: no runtime copy is live yet.');
      return done();
    }
    if (!idleState.exists || idleState.problem || !idleState.commit) {
      refusals.push(idleState.problem ?? `there is no previous runtime copy at ${idle.root} to return to.`);
      return done();
    }
    plan.target = { ref: `the previous runtime copy (${idle.name})`, commit: idleState.commit };
  } else {
    const commit = await resolveCommit(git, homeRoot, target);
    if (!commit) {
      refusals.push(`${target} is not a commit in this repository.`);
      return done();
    }
    plan.target = { ref: target, commit };
  }
  plan.into = { ...idle, exists: idleState.exists };
  const { commit } = plan.target;

  const onMain = await isAncestor(git, homeRoot, commit, plan.main);
  if (onMain === true) checks.push(`${short(commit)} is on main`);
  else if (onMain === false) refusals.push(`${short(commit)} is not on main. Only a commit main already contains can be deployed.`);
  else refusals.push(`git could not tell whether ${short(commit)} is on main.`);

  if (!(await hasFile(git, homeRoot, commit, RUNTIME_MARKER))) {
    refusals.push(`${short(commit)} predates the runtime copy (it has no ${RUNTIME_MARKER}), so it cannot run from one.`);
  }

  if (plan.live && !rollback) {
    if (plan.live.commit === commit) {
      plan.noop = true;
      checks.push(`the live OS already runs ${short(commit)}`);
    } else {
      const forward = await isAncestor(git, homeRoot, plan.live.commit, commit);
      if (forward === true) checks.push(`fast-forward from the running ${short(plan.live.commit)}`);
      else {
        refusals.push(
          `${short(commit)} is not a fast-forward from the running ${short(plan.live.commit)}. ` +
            'Going back is pnpm os:deploy -- --rollback.',
        );
      }
    }
  }

  if (!plan.noop) {
    if (idleState.problem) refusals.push(idleState.problem);
    else if (idleState.exists && idleState.dirty.length > 0) refusals.push(dirtyRefusal(idle, idleState.dirty, 'idle'));
  }

  // Both Workers must use Postgres. Refuse an old D1 release, including
  // rollback, before opening any store or changing the runtime link.
  for (const file of ['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc']) {
    const refusal = postgresConfigRefusal(await fileAt(git, homeRoot, commit, file), file);
    if (refusal) {
      refusals.push(`${short(commit)}: ${refusal}`);
      return done();
    }
  }
  const ingestConfig = await fileAt(git, homeRoot, commit, 'workers/ingest/wrangler.jsonc');
  {
    // The runner's own reader (scripts/runner/database.mjs).
    if (typeof deps.readPostgresMigrations !== 'function') {
      throw new TypeError('planDeploy needs deps.readPostgresMigrations: this commit opens the Postgres store');
    }
    const files = await postgresMigrationFiles(git, homeRoot, commit);
    if (files === null) refusals.push(`could not list ${short(commit)}'s db/postgres/migrations.`);
    else {
      const recorded = await deps.readPostgresMigrations();
      if (!recorded.ok) {
        refusals.push(`${short(commit)} opens the Postgres store, but which migrations its database has applied is unknown: ${recorded.line}`);
      } else {
        const verdict = postgresVerdict(files, recorded.records, commit);
        plan.postgres = { migrations: verdict.migrations };
        refusals.push(...verdict.refusals);
        checks.push(...verdict.checks);
      }
    }
  }

  // miniflare keeps local R2 objects under the bucket's name, so a commit
  // whose configs name another bucket would start on an empty one.
  const namesFile = checkoutRelative(installationPath(RESOURCE_NAMES_FILE, { root: homeRoot }), { root: homeRoot });
  let names;
  try {
    names = (deps.readResourceNames ?? readResourceNames)({ root: homeRoot });
  } catch (error) {
    refusals.push(`${namesFile} could not be read (${error.message}), so which raw-signal archive this commit opens is unknown.`);
    return done();
  }
  const bucket = openedRawSignalsBucket(ingestConfig, names);
  const held = await localBuckets(homeRoot, fsp);
  if (bucket !== null && held.length > 0) {
    if (held.includes(bucket)) checks.push(`its raw-signal archive stays under ${bucket}`);
    else {
      refusals.push(
        `${short(commit)} would open the raw-signal archive "${bucket}", but this installation's archives are under ` +
          `${held.map((name) => `"${name}"`).join(', ')}. Name the bucket in ${namesFile} (config/resource-names.README.md).`,
      );
    }
  }

  return done();
}

// ─── Doing it ───────────────────────────────────────────────────────────────

/** Point `current` at a runtime copy in one atomic rename. */
export async function pointCurrentAt(layout, slotName, fsp = fs) {
  const temporary = `${layout.current}.tmp-${process.pid}`;
  await fsp.rm(temporary, { force: true });
  await fsp.symlink(slotName, temporary);
  await fsp.rename(temporary, layout.current);
}

async function record(homeRoot, entry, fsp, now) {
  const file = statePaths(homeRoot).deploysFile;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`);
  } catch {
    // A failed append must not turn a finished deploy into a reported failure.
  }
}

function tail(text, lines = 20) {
  return String(text ?? '').split('\n').filter(Boolean).slice(-lines).join('\n');
}

/**
 * Carry out a plan that has no refusals. Returns `{ code, lines }`. A forward
 * deploy whose restart fails goes back to the previous copy by itself and
 * returns code 1 if that came back healthy. It throws when the OS is left
 * unhealthy with nothing more to try: the message carries the status and the
 * recent redacted log (the same failure `pnpm os:restart` prints) and NEXT_STEP.
 */
export async function executeDeploy(planned, deps) {
  const fsp = deps.fsp ?? fs;
  const now = deps.now ?? Date.now;
  const git = gitRunner(deps);
  const { plan } = planned;
  const { homeRoot, layout, into } = plan;
  const { commit } = plan.target;
  const action = plan.rollback ? 'rollback' : 'deploy';
  const from = plan.live?.commit ?? null;
  const say = deps.out ?? (() => {});
  const failure = (text) => ({ code: 1, lines: [`os:deploy stopped — the live OS was not changed: ${text}`] });

  if (!plan.rollback) {
    say(`… preparing ${into.name} at ${short(commit)} (the live OS keeps running)`);
    const moved = into.exists
      ? await git(into.root, ['checkout', '--detach', '--quiet', commit])
      : await git(homeRoot, ['worktree', 'add', '--detach', '--lock', '--reason', RUNTIME_LOCK_REASON, into.root, commit]);
    if (moved.code !== 0) return failure(`git could not place ${short(commit)} in ${into.root} (${compact(moved.stderr)})`);
  }
  const links = await ensureSharedStateLinks({ codeRoot: into.root, homeRoot, fsp });
  if (links.conflicts.length > 0) return failure(linkConflictLines(links.conflicts, into.root).join('\n  '));
  if (!plan.rollback) {
    say(`… installing dependencies in ${into.name} (pnpm install --frozen-lockfile)`);
    const installed = await deps.install({ cwd: into.root });
    if (installed.code !== 0) {
      return failure(`pnpm install --frozen-lockfile failed in ${into.root}:\n${tail(`${installed.stdout}\n${installed.stderr}`)}`);
    }
  }
  const prepared = await inspectSlot(git, homeRoot, into, fsp);
  if (prepared.problem || prepared.commit !== commit || prepared.dirty.length > 0) {
    return failure(
      prepared.problem ??
        (prepared.commit !== commit
          ? `${into.root} is at ${short(prepared.commit)}, not ${short(commit)}`
          : `preparing ${into.root} left changes behind: ${prepared.dirty.slice(0, 5).join(', ')}`),
    );
  }

  await pointCurrentAt(layout, into.name, fsp);
  const base = { action, ...(plan.automatic ? { automatic: true } : {}), from, to: commit, slot: into.name };

  const runsFrom = plistRunsFrom(await deps.readPlist(), homeRoot);
  if (runsFrom !== 'runtime') {
    await record(homeRoot, { ...base, result: 'prepared' }, fsp, now);
    return {
      code: 0,
      lines: [
        `Runtime copy ready: ${layout.current} → ${into.name} at ${short(commit)}.`,
        runsFrom === 'missing'
          ? 'No service is installed yet. pnpm os:install starts it from this copy.'
          : 'The service still runs from this folder, so merges still reload it. Switch it over once: pnpm os:install',
      ],
    };
  }
  const service = await deps.service();
  if (!service.loaded) {
    await record(homeRoot, { ...base, result: 'prepared' }, fsp, now);
    return {
      code: 0,
      lines: [
        `The runtime now points at ${short(commit)} (${into.name}).`,
        'The service is stopped, so nothing restarted. pnpm os:start runs this commit.',
      ],
    };
  }

  say(`… switching the service to ${into.name} and restarting it once`);
  let after;
  try {
    after = await deps.restart({ timeoutMs: DEPLOY_HEALTH_WAIT_MS, action });
  } catch (error) {
    await record(homeRoot, { ...base, result: 'failed' }, fsp, now);
    const failed = String(error?.message ?? error);
    if (plan.rollback) {
      // A rollback never goes anywhere else by itself.
      throw new Error(
        [
          failed,
          plan.automatic
            ? `Deploy of ${short(from)} failed, and going back to ${short(commit)} did not come back healthy either. Nothing more was tried.`
            : `Going back to ${short(commit)} did not come back healthy. Nothing more was tried.`,
          NEXT_STEP,
        ].join('\n'),
      );
    }
    if (!from) {
      throw new Error(
        [failed, 'There is no previous runtime copy to go back to, so the service was left as this restart left it.', NEXT_STEP].join('\n'),
      );
    }
    return rollBackAfterFailedDeploy({ homeRoot, failed, failedCommit: commit, previous: from, deps });
  }
  const reported = after?.heartbeat?.commit ?? null;
  if (reported !== commit) {
    await record(homeRoot, { ...base, result: 'failed' }, fsp, now);
    return {
      code: 1,
      lines: [
        `The OS restarted healthy, but its runner reports ${short(reported)} instead of ${short(commit)}.`,
        'The installed service may not run from the runtime copy: pnpm os:status, then pnpm os:install.',
      ],
    };
  }
  await record(homeRoot, { ...base, result: 'healthy' }, fsp, now);
  let done;
  if (plan.automatic) {
    done = [
      `Deploy of ${short(from)} failed, so the OS went back to ${short(commit)} (${into.name}) by itself.`,
      `✓ ${short(commit)} is healthy again. ${short(from)} is not live; why it failed is in the log above.`,
    ];
  } else if (plan.rollback) done = [`Rolled back to ${short(commit)} (${into.name}).`];
  else done = [`Deployed ${short(commit)}${from ? ` (was ${short(from)})` : ''}. To go back: pnpm os:deploy -- --rollback`];
  return { code: 0, lines: [...(deps.statusLines ? deps.statusLines(after) : []), ...done] };
}

/**
 * A forward deploy's restart did not return healthy and a previous copy exists:
 * go back to it with the very plan and move `--rollback` makes, once. Returns
 * exit code 1 when that worked (the deploy the operator asked for did not
 * happen); throws — with the status, the log and the next command — when it did
 * not, and then tries nothing more.
 */
async function rollBackAfterFailedDeploy({ homeRoot, failed, failedCommit, previous, deps }) {
  const say = deps.out ?? (() => {});
  const stop = (lines) => {
    throw new Error(
      [
        ...lines,
        `Deploy of ${short(failedCommit)} failed, and going back to ${short(previous)} did not finish. Nothing more was tried.`,
        NEXT_STEP,
      ].join('\n'),
    );
  };
  say(`✗ ${short(failedCommit)} did not come back healthy:`);
  say(failed);
  say(`… going back to ${short(previous)} by itself: one more restart`);

  const planned = await planDeploy({ homeRoot, rollback: true, deps });
  if (!planned.ok) stop(['The automatic rollback was refused:', ...planned.refusals.map((line) => `  ✗ ${line}`)]);
  if (planned.plan.target.commit !== previous) {
    stop([`The previous runtime copy is at ${short(planned.plan.target.commit)}, not ${short(previous)}.`]);
  }
  planned.plan.automatic = true;
  // Quiet: the line above already says what this step is doing.
  const result = await executeDeploy(planned, { ...deps, out: () => {} });
  if (result.code !== 0) stop(result.lines);
  return { code: 1, lines: result.lines };
}

/**
 * `pnpm os:deploy`, end to end. Returns the exit code; every line it prints goes
 * through `deps.out`.
 */
export async function runDeploy({ homeRoot, argv = [], deps }) {
  const say = deps.out;
  const options = parseDeployArgs(argv);
  const planned = await planDeploy({ homeRoot, target: options.target, rollback: options.rollback, deps });
  const { plan } = planned;
  if (plan.target) {
    const verb = options.rollback ? 'Rollback' : 'Deploy';
    const running = plan.live ? `the OS runs ${short(plan.live.commit)}` : 'no runtime copy is live yet';
    say(`${verb} target: ${short(plan.target.commit)} (${plan.target.ref}) — ${running}; main is ${short(plan.main)}.`);
  }
  for (const line of planned.checks) say(`  ✓ ${line}`);
  if (!planned.ok) {
    say(`os:deploy refused — nothing was changed:`);
    for (const line of planned.refusals) say(`  ✗ ${line}`);
    return 1;
  }
  if (plan.noop) {
    say('Nothing to deploy.');
    return 0;
  }
  if (options.check) {
    const runsFrom = plistRunsFrom(await deps.readPlist(), homeRoot);
    say(
      runsFrom === 'runtime'
        ? `Ready: ${options.rollback ? 'rolling back' : 'deploying'} would move the OS to ${short(plan.target.commit)} with one restart. Nothing was changed.`
        : `Ready: deploying would prepare the runtime copy at ${short(plan.target.commit)} without touching the running service; ` +
            'pnpm os:install then switches the service to it. Nothing was changed.',
    );
    return 0;
  }
  const result = await executeDeploy(planned, deps);
  for (const line of result.lines) say(line);
  return result.code;
}
