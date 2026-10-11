import { beadsText, beadsFailure } from '../task-snapshot-values.mjs';
export { BEADS_ERROR_MAX, beadsText, beadsInstant, beadsFailure, beadsLabelListArgs } from '../task-snapshot-values.mjs';
// runner/task-hub.mjs — the local runner's side of the beads task hub: its
// health line (the hub is hosted by `brew services`, never by the runner), the
// one way to run `bd`, the saved task projects as the lanes read them, and the
// list, file, close and read-back steps every filing lane shares.

import { runCommand } from '../run-command.mjs';
import { beadsDatabaseName } from '../task-project-config.mjs';
import { BEADS_DOLT_DIR, CONFIG, REPO_ROOT } from './config.mjs';
import { bdBin, probeTcp } from './host-tools.mjs';
import { log } from './log.mjs';
import { declaredTaskClient, taskChildEnvironment } from '../task-client.mjs';

// Beads task hub — the shared Dolt SQL server every portfolio repo files its
// tasks against (config/beads.json holds the asset ↔ prefix ↔ database map).
// We do not run it: `brew services` does, as a login service reading the
// installation's dolt-server.yaml, so agents keep filing tasks while the
// runner is stopped, restarting or mid-update. The runner only observes it — a
// health line, and the nightly backup.

/** What to say about the hub. A down hub is not a runner failure — it is one
 * brew command away — so the WARN carries the fix rather than a bare symptom. */
export function beadsHubHealthLine(reachable, config) {
  const where = `${config.beadsHubHost}:${config.beadsHubPort}`;
  if (reachable) {
    return { level: 'INFO', text: `beads task hub reachable at ${where}` };
  }
  return {
    level: 'WARN',
    text:
      `beads task hub DOWN at ${where} — bd commands will fail in every portfolio repo. ` +
      `Start it with:  brew services start dolt`,
  };
}

/**
 * Every `dolt sql-server` currently running, from `pgrep -fl`'s
 * `<pid> <full command>` lines.
 *
 * A TCP probe alone cannot tell the hub service from a stray `dolt sql-server`
 * somebody left running, because BOTH answer — which is how a crash-looping
 * service hides behind a green "hub reachable" line. Counting the processes is
 * what turns that ambiguity into a diagnosis.
 */
export function parseDoltServers(stdout) {
  const servers = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const command = match[2].trim();
    // Only processes whose binary is dolt count: `pgrep -f` matches the
    // pattern anywhere in an argv, which includes a concurrent twin of this
    // very search — pgrep excludes itself but not a twin.
    if (!/(^|\/)dolt\s/.test(command)) continue;
    servers.push({ pid: Number(match[1]), command });
  }
  return servers;
}

/** Resolves to the running servers, or null when we could not find out —
 * `pgrep` missing is not worth a scary line, it just means no diagnosis. */
async function listDoltServers() {
  const { code, stdout } = await runCommand('/usr/bin/pgrep', ['-fl', 'dolt sql-server'], {
    cwd: REPO_ROOT,
    timeoutMs: 5_000,
  });
  // pgrep exits 1 when nothing matched — that is an answer (none), not a
  // failure. Anything else means we could not look.
  return code === 0 || code === 1 ? parseDoltServers(stdout) : null;
}

/**
 * What the hub's state actually is, in one operator-actionable line. Dolt
 * takes an exclusive write lock per database, so two servers over one data
 * directory is never a survivable state. The two failure shapes it names:
 *
 *   reachable + more than one server → a stray is up; whichever server lost
 *     the race is the one crash-looping, and the port being open proves nothing.
 *   unreachable + at least one server → the crash-loop signature itself: a
 *     dolt process exists but nothing answers, because it dies before it can
 *     serve.
 *
 * `servers === null` means we could not enumerate; fall back to the plain
 * reachable/down line rather than guessing.
 */
export function beadsHubDiagnosis({ reachable, servers, dataDir }, config) {
  const where = `${config.beadsHubHost}:${config.beadsHubPort}`;
  const find = `lsof -nP -iTCP:${config.beadsHubPort} -sTCP:LISTEN`;

  if (Array.isArray(servers) && reachable && servers.length > 1) {
    const pids = servers.map((s) => s.pid).join(', ');
    return {
      key: 'contended',
      level: 'WARN',
      text:
        `beads task hub CONTENDED at ${where} — ${servers.length} dolt sql-server processes are running ` +
        `(pids ${pids}) but only one may own ${dataDir}: Dolt takes an exclusive write lock per database, ` +
        `so the loser crash-loops on "database is locked by another dolt process". ` +
        `Find the stray with:  ${find}  — stop it, then:  brew services restart dolt`,
    };
  }

  if (Array.isArray(servers) && !reachable && servers.length > 0) {
    const pids = servers.map((s) => s.pid).join(', ');
    return {
      key: 'crash-looping',
      level: 'WARN',
      text:
        `beads task hub DOWN at ${where} but ${servers.length} dolt sql-server process(es) exist ` +
        `(pids ${pids}) — that is the crash-loop signature: the server dies on a database lock before it can ` +
        `serve, and keep_alive restarts it forever. Check:  brew services info dolt  — stop the stray ` +
        `(${find}), then:  brew services restart dolt`,
    };
  }

  return { key: reachable ? 'up' : 'down', ...beadsHubHealthLine(reachable, config) };
}

// Only transitions are logged after the first line, so a hub that stays down
// does not paper the log every 15 minutes. null = nothing reported yet. The
// state is the diagnosis KEY, not a boolean, so healthy → contended is a
// transition worth a line even though the port stayed reachable throughout.
let beadsHubState = null;

export function taskHubPortDescription(env = process.env, config = CONFIG) {
  const client = declaredTaskClient(env);
  if (client) {
    return `${client.host}:${client.port} (separately hosted declared service)`;
  }
  return `${config.beadsHubHost}:${config.beadsHubPort} (loopback only, hosted by brew services — not us)`;
}

export async function checkBeadsHub({ force = false } = {}) {
  const client = declaredTaskClient();
  if (client) {
    const reachable = await probeTcp(client.host, client.port);
    const key = reachable ? 'up' : 'down';
    if (force || key !== beadsHubState) {
      beadsHubState = key;
      log(reachable ? 'INFO' : 'WARN', `declared task hub ${reachable ? 'reachable' : 'unavailable'} at ${client.host}:${client.port}`);
    }
    return reachable;
  }
  const reachable = await probeTcp(CONFIG.beadsHubHost, CONFIG.beadsHubPort);
  const servers = await listDoltServers();
  const diagnosis = beadsHubDiagnosis(
    { reachable, servers, dataDir: BEADS_DOLT_DIR },
    CONFIG,
  );
  if (force || diagnosis.key !== beadsHubState) {
    beadsHubState = diagnosis.key;
    log(diagnosis.level, diagnosis.text);
  }
  return reachable;
}

/** A hung `bd` must not stall the tick into the next one. */
const BEADS_CALL_TIMEOUT_MS = 20_000;

/**
 * The saved task projects (config/beads.json's `spokes`), as every lane reads
 * them. A missing or malformed document is []. A spoke missing `asset`,
 * `prefix` or `repo` is dropped rather than half-polled.
 *
 * `database` is carried rather than required: the poll never uses it (`bd`
 * resolves the database from the repo's own `.beads/config.yaml`), so a
 * project's board is not dropped over a field only the drift check reads. It
 * travels as `null` when it is not usable, and `beadsDatabaseName` is the
 * single answer to what that means.
 *
 * There is no charset guard on `repo`: it only ever becomes one element of a
 * spawn argv array with no shell. If it is ever moved into a shell string or a
 * query, it needs its own guard first.
 */
export function parseBeadsProjects(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(cfg?.spokes)) return [];
  const seen = new Set();
  const projects = [];
  for (const spoke of cfg.spokes) {
    const asset = spoke?.asset;
    const prefix = spoke?.prefix;
    const repo = spoke?.repo;
    const database = spoke?.database;
    if (typeof asset !== 'string' || asset.trim() === '') continue;
    if (typeof prefix !== 'string' || prefix.trim() === '') continue;
    if (typeof repo !== 'string' || (repo.trim() === '' && !spoke.unavailableReason)) continue;
    if (seen.has(asset)) continue;
    seen.add(asset);
    projects.push({
      asset: asset.trim(),
      prefix: prefix.trim(),
      repo: repo.trim(),
      ...(typeof spoke.unavailableReason === 'string' ? { unavailableReason: spoke.unavailableReason } : {}),
      // "the backup would use this" and "this is a usable name" are one
      // question with one answer, and it is spelled out in exactly one place.
      database: beadsDatabaseName(database),
    });
  }
  return projects;
}

/** Spawn one `bd` invocation and collect it. Never rejects on a non-zero exit —
 * that is data the summary reports, not an exception. The timeout is a
 * parameter because not every caller is a poll read: `bd gate check` evaluates
 * gates rather than printing a list, and gets its own bound. */
export async function runBd(argv, timeoutMs = BEADS_CALL_TIMEOUT_MS) {
  const result = await runCommand(bdBin(), argv, { cwd: REPO_ROOT, timeoutMs, env: taskChildEnvironment() });
  if (result.error) throw result.error;
  return result;
}

/** The saved projects, or the skip reason a lane logs when the store could not
 * be read. An empty list is an answer, not a failure: each lane names it. */
export async function readBeadsProjects(readConfig) {
  try {
    return { projects: parseBeadsProjects(await readConfig()) };
  } catch (err) {
    return { unreadable: `the task map is unreadable (${err.message})` };
  }
}

// ── How the filing lanes (push-state, task-map, panel-review) list, file,
// close and read back their tasks ───────────────────────────────────────────

/** What puts a task in `bd human list`, the operator's inbox. */
export const HUMAN_LABEL = 'human';

/**
 * A lane's task as `bd create` argv. Type and priority are always stated: a
 * default that changes upstream must not quietly re-grade every task a lane
 * has filed.
 */
export function beadsCreateArgs(
  repoDir,
  { actor, title, type, priority, labels, due = null, metadata, description, acceptance },
) {
  return [
    '-C',
    repoDir,
    '--actor',
    actor,
    'create',
    title,
    '--type',
    type,
    '--priority',
    String(priority),
    '--labels',
    labels.join(','),
    ...(due === null ? [] : ['--due', due]),
    '--metadata',
    JSON.stringify(metadata),
    '--description',
    description,
    '--acceptance',
    acceptance,
    '--json',
  ];
}

export function beadsCloseArgs(repoDir, actor, beadId, reason) {
  return ['-C', repoDir, '--actor', actor, 'close', beadId, '-r', reason];
}

/** The open rows of a `bd list` answer, each with its id; null when the
 * answer is not a list, which forbids both filing and closing. Closed rows
 * are dropped again here whatever the query asked for. */
export function beadsOpenRows(rows) {
  if (!Array.isArray(rows)) return null;
  const open = [];
  for (const row of rows) {
    const beadId = beadsText(row?.id);
    if (beadId === '' || beadsText(row?.status) === 'closed') continue;
    open.push({ beadId, row });
  }
  return open;
}

/**
 * Run one `bd` step of a filing lane. `{ result }` on exit 0; otherwise
 * `{ failure }`, the one line the lane logs: `bd <verb> could not run` when no
 * process started (no `result`), `beadsFailure(key, …)` when it exited
 * non-zero.
 */
export async function runBeadsStep(run, argv, verb, key) {
  let result;
  try {
    result = await run(argv);
  } catch (err) {
    return { failure: `bd ${verb} could not run: ${err.message}` };
  }
  if (result.code !== 0) return { failure: beadsFailure(key, result), result };
  return { result };
}

/** A `bd list` step: `runBeadsStep`, then its JSON as `rows`, or
 * `unparseable` with the result when the exit was 0 and the output was not
 * JSON. */
export async function readBeadsList(run, argv, key) {
  const step = await runBeadsStep(run, argv, 'list', key);
  if (step.failure) return step;
  try {
    return { rows: JSON.parse(step.result.stdout), result: step.result };
  } catch {
    return { unparseable: true, result: step.result };
  }
}

/** The id `bd create` reports back, for the log line. Null is not a failure —
 * the bead exists either way, and the exit code already said so: `bd create
 * --json` answers the same shape whatever was filed. */
export function beadsCreatedId(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    return null;
  }
}
