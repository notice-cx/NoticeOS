// runner/task-map.mjs — the hourly task-map lane: every saved project's
// declared task database is checked against what the hub actually holds
// (`SHOW DATABASES`). A drifting project gets one operator bead in the OS's own
// tracker; a project that agrees again has it closed with the evidence. A hub
// that will not answer decides nothing.

import path from 'node:path';
import { TASK_METADATA, taskMetadataValue } from '../../packages/contract/src/task-metadata.mjs';
import { beadsDatabaseName, readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { laneSkips, log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import {
  HUMAN_LABEL,
  beadsCloseArgs,
  beadsCreateArgs,
  beadsCreatedId,
  beadsFailure,
  beadsLabelListArgs,
  beadsOpenRows,
  beadsText,
  readBeadsList,
  readBeadsProjects,
  runBd,
  runBeadsStep,
} from './task-hub.mjs';

// Task-map reconciliation — is each project's declared database one the hub
// actually holds? Saved workspace database names are checked against the
// physical hub; task execution additionally requires an exact
// asset/prefix/database host link. Backups use the host inventory
// independently: removing workspace membership must not silently remove a
// physical database from backup coverage. Drift is filed in NoticeOS, where an
// operator can correct the mapping even if the affected project's own task
// database is unavailable.
//
// Unknown is not drift. Every decision comes from a `SHOW DATABASES` this pass
// just made; a hub that would not answer skips the pass entirely.

/** The label every drift bead carries — how this lane finds its own work, and
 * how a bead filed by hand is adopted (and auto-closed) by it. */
export const TASK_MAP_LABEL = 'task-map-drift';
/** Filed for the operator: the fix is `bd init` or a settings edit. */
export const TASK_MAP_HUMAN_LABEL = HUMAN_LABEL;
/** Who the audit trail names. Nobody chose to file this; a reconciliation did. */
export const TASK_MAP_ACTOR = 'os-up-task-map';
/** Which project a drift bead is about. Prefixed for the same reason the
 * other filers' keys are: these keys travel with the bead
 * (`reindex_task_map_asset` before the rename, still read). */
export const TASK_MAP_ASSET_KEY = TASK_METADATA.taskMapAsset.name;
/** Databases the hub always holds and no spoke ever declares. Listed so the
 * reconciliation reads as "the portfolio's databases", not "everything MySQL
 * happens to expose". */
export const TASK_MAP_SYSTEM_DATABASES = ['information_schema', 'mysql'];
/**
 * The OS's own asset id as the store names it (`assets.is_os`), never an id
 * written into the runner. Null when there is no token, the store cannot
 * answer, or it holds no OS row; a caller then files nothing about the OS.
 * Never throws.
 */
export async function readOsAsset({ url, readToken, get = fetch }) {
  const token = await readToken().catch(() => null);
  if (!token) return null;
  try {
    const res = await get(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.asset === 'string' && body.asset !== '' ? body.asset : null;
  } catch {
    return null;
  }
}

/** Whose tracker the drift beads land in — the OS's own project, because the
 * file that is wrong is this repo's and the lane that breaks is this repo's
 * backup. Which project that is: the spoke whose asset the store marks as the
 * OS (`GET /api/os-asset`, `assets.is_os`), never an id written here and never
 * assumed to be the first spoke. */
export function taskMapHomeAsset() {
  return readOsAsset({ url: `http://${CONFIG.ingestHost}:${CONFIG.ingestPort}/api/os-asset`, readToken: operatorToken });
}

/** Ask the hub what it actually holds. `--format json` so the answer is parsed
 * rather than scraped off a box-drawn table whose padding is presentation. */
export function beadsShowDatabasesArgs(repoDir) {
  return ['-C', repoDir, '--quiet', 'sql', 'SHOW DATABASES', '--format', 'json'];
}

/**
 * The database names in a `SHOW DATABASES --format json` answer, or null when
 * the answer cannot be read.
 *
 * NULL AND EMPTY ARE DIFFERENT and the difference decides a write: an empty hub
 * would mean every project has drifted, which is a conclusion only a hub that
 * genuinely answered may license. Unparseable output is null, and null skips.
 *
 * The column name is `Database` on Dolt as on MySQL; the fallback to the row's
 * single value keeps a client that labels it differently readable rather than
 * silently empty.
 */
export function parseBeadsDatabases(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const names = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const values = Object.values(row);
    const name = typeof row.Database === 'string' ? row.Database : values[0];
    if (typeof name !== 'string' || name.trim() === '') continue;
    names.add(name.trim());
  }
  return names;
}

/**
 * Which projects declare a database the hub does not hold.
 *
 * Pure, so the whole judgement is testable without a Dolt server. Takes the
 * spokes as the poller resolves them (`parseBeadsProjects`) and the set the
 * hub answered with; returns one entry per drifting project, in file order.
 *
 * A project with no usable database is drift too. It cannot match a host
 * link and therefore cannot run local task actions. It travels as null.
 */
export function beadsDatabaseDrift(spokes, hubDatabases) {
  if (!(hubDatabases instanceof Set)) return [];
  const drifting = [];
  for (const spoke of spokes) {
    // Compare valid SQL identifiers only.
    const declared = beadsDatabaseName(spoke?.database);
    if (declared === null) {
      drifting.push({ asset: spoke.asset, declared: null });
      continue;
    }
    if (!hubDatabases.has(declared)) drifting.push({ asset: spoke.asset, declared });
  }
  return drifting;
}

/** The title. It names the project and the ask, and deliberately not the wrong
 * VALUE: the value is what the operator is about to change, and a title that
 * pins it is false the moment they change it to a second wrong one. */
export function taskMapTitle(asset) {
  return `Point ${asset}'s task database at one the hub holds`;
}

/** What the operator reads in the inbox: what disagrees, both ways to fix it,
 * and what it costs to leave. */
export function taskMapDescription({ asset, declared, repo, held, checkedAt }) {
  const names = [...held].filter((db) => !TASK_MAP_SYSTEM_DATABASES.includes(db)).sort();
  return [
    declared === null
      ? `WHAT: The saved task mapping declares no usable database for ${asset}.`
      : `WHAT: The saved task mapping says ${asset}'s database is "${declared}", and the hub does not have that database.`,
    `AS OF ${checkedAt} the hub holds: ${names.join(', ') || '(none)'}.`,
    `WHY IT MATTERS: task actions require the saved asset, prefix and database to match a local checkout link. A mismatched project is unavailable. Physical backups use the separate host inventory.`,
    `FIX: Set Database for ${asset} on /settings#task-hub to the intended existing database, or provision that database from the project checkout. Then make its asset, prefix and database agree in installation/task-host.json and the checkout's .beads/config.yaml.`,
    `Local checkout: ${repo || 'not linked on this host'}.`,
    `CLOSING: nobody has to. The OS runner (scripts/os-up.mjs, the task-map lane) ` +
      `re-reads \`SHOW DATABASES\` hourly and the first pass that sees the two agree closes ` +
      `this bead with that evidence. A later drift files a FRESH bead rather than reopening ` +
      `this one.`,
  ].join('\n\n');
}

/** What "done" means — provable the same day, and provable by the runner. */
export const TASK_MAP_ACCEPTANCE =
  '`bd --quiet sql "SHOW DATABASES"` against the hub lists the database `config/beads.json` ' +
  'declares for this project.';

/** What is open against NoticeOS for this lane. Drift recurs, so closed is
 * not asked for. */
export function taskMapListArgs(repoDir) {
  return beadsLabelListArgs(repoDir, TASK_MAP_LABEL);
}

/** Which project an open drift bead is about. Metadata first, title as the
 * fallback for a `bd` that hands back a row without it — the same two-source
 * rule the panel filer applies, and for the same reason: reading a thinner
 * client's bead beats filing a duplicate beside it. */
export function taskMapBeadAsset(row) {
  const tagged = taskMetadataValue(row?.metadata, 'taskMapAsset');
  if (typeof tagged === 'string' && tagged.trim() !== '') return tagged.trim();
  const match = /^Point (\S+)'s task database at one the hub holds$/.exec(
    beadsText(row?.title),
  );
  return match ? match[1] : null;
}

/** Every open drift bead, keyed by the project it is about. Null when the list
 * could not be read — which forbids both filing and closing this pass. */
export function taskMapOpenBeads(rows) {
  const rowsOpen = beadsOpenRows(rows);
  if (rowsOpen === null) return null;
  const byAsset = new Map();
  for (const { beadId, row } of rowsOpen) {
    const asset = taskMapBeadAsset(row);
    if (asset !== null && !byAsset.has(asset)) byAsset.set(asset, beadId);
  }
  return byAsset;
}

/** The bead, as argv. P1 and `human` for the push filer's reason: only the
 * operator can run `bd init` or change the value, and `bd human list` is the
 * operator's inbox. */
export function taskMapCreateArgs(repoDir, filing) {
  return beadsCreateArgs(repoDir, {
    actor: TASK_MAP_ACTOR,
    title: taskMapTitle(filing.asset),
    type: 'bug',
    priority: 1,
    labels: [TASK_MAP_LABEL, TASK_MAP_HUMAN_LABEL],
    metadata: { [TASK_MAP_ASSET_KEY]: filing.asset },
    description: taskMapDescription(filing),
    acceptance: TASK_MAP_ACCEPTANCE,
  });
}

/** The evidence, in the close reason. A bead a machine closes has to say what
 * the machine saw and when. */
export function taskMapCloseReason({ asset, declared, checkedAt }) {
  return (
    `The hub holds "${declared}", the database config/beads.json declares for ${asset}: ` +
    '`bd --quiet sql "SHOW DATABASES"` listed it at ' +
    `${checkedAt}. Closed automatically by the OS runner's task-map lane ` +
    '(scripts/os-up.mjs). Recurrence: a later disagreement files a fresh bead rather than ' +
    'reopening this one.'
  );
}

export function taskMapCloseArgs(repoDir, beadId, reason) {
  return beadsCloseArgs(repoDir, TASK_MAP_ACTOR, beadId, reason);
}

const taskMapState = { skipping: null };

/**
 * One pass: ask the hub what it holds, file what drifted, close what agrees.
 * Every dependency that touches the world is injectable.
 */
export async function runTaskMapCheck(deps = {}) {
  const {
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    run = runBd,
    now = () => new Date(),
    state = taskMapState,
    emit = log,
    stopped = () => isShuttingDown(),
    homeAsset = taskMapHomeAsset,
  } = deps;

  const { skip, resume } = laneSkips('task map check', state, emit);

  if (stopped()) return null;

  const { projects: spokes, unreadable } = await readBeadsProjects(readConfig);
  if (unreadable) return skip(unreadable);
  if (spokes.length === 0) return skip('no projects are configured');
  const home = await homeAsset();
  if (!home) return skip('the store names no OS asset to file into');
  const self = spokes.find((spoke) => spoke.asset === home);
  if (!self || self.unavailableReason) return skip(`config/beads.json has no "${home}" project to file into`);

  const selfRepo = path.resolve(HOME_ROOT, self.repo);
  let answer;
  try {
    answer = await run(beadsShowDatabasesArgs(selfRepo));
  } catch (err) {
    return skip(`the hub could not be asked what it holds (${err.message})`);
  }
  if (answer.code !== 0) return skip(beadsFailure('show databases', answer));
  const held = parseBeadsDatabases(answer.stdout);
  if (held === null) return skip('the hub returned unreadable SHOW DATABASES output');
  resume();

  const listed = await readBeadsList(run, taskMapListArgs(selfRepo), 'task map list');
  if (listed.failure) {
    emit('ERROR', `task map: ${listed.failure}`);
    return null;
  }
  if (listed.unparseable) {
    emit('ERROR', 'task map: bd returned unparseable JSON; filing and closing nothing');
    return null;
  }
  const open = taskMapOpenBeads(listed.rows);
  if (open === null) {
    emit('ERROR', 'task map: bd returned a list that is not a list; filing nothing');
    return null;
  }

  const checkedAt = now().toISOString();
  const drift = beadsDatabaseDrift(spokes, held);
  const drifting = new Set(drift.map((entry) => entry.asset));
  const filed = [];
  const closed = [];

  for (const entry of drift) {
    if (open.has(entry.asset)) continue;
    const spoke = spokes.find((s) => s.asset === entry.asset);
    const created = await runBeadsStep(
      run,
      taskMapCreateArgs(selfRepo, {
        asset: entry.asset,
        declared: entry.declared,
        repo: spoke?.repo ?? '(unknown repo)',
        held,
        checkedAt,
      }),
      'create',
      'task map create',
    );
    if (created.failure) {
      emit('ERROR', `task map: ${entry.asset} — ${created.failure}`);
      continue;
    }
    const beadId = beadsCreatedId(created.result.stdout);
    filed.push({ asset: entry.asset, declared: entry.declared, beadId });
    emit(
      'ERROR',
      `task map: ${entry.asset} declares database ` +
        `${entry.declared === null ? '(none)' : `"${entry.declared}"`} which the hub does not ` +
        `hold — filed ${beadId ?? '(id unread)'}: "${taskMapTitle(entry.asset)}"`,
    );
  }

  for (const [asset, beadId] of open) {
    if (drifting.has(asset)) continue;
    const declared = spokes.find((s) => s.asset === asset)?.database ?? '(unknown)';
    const done = await runBeadsStep(
      run,
      taskMapCloseArgs(selfRepo, beadId, taskMapCloseReason({ asset, declared, checkedAt })),
      'close',
      'task map close',
    );
    if (done.failure) {
      emit('ERROR', `task map: ${asset} — ${done.failure}`);
      continue;
    }
    closed.push({ asset, beadId });
    emit('INFO', `task map: ${asset} agrees with the hub again — closed ${beadId}`);
  }

  return { checked: spokes.length, drift, filed, closed };
}
