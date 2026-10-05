import { BEADS_ERROR_MAX, beadsText, beadsInstant, beadsFailure } from '../task-snapshot-values.mjs';
export { BEADS_ERROR_MAX, beadsText, beadsInstant, beadsFailure } from '../task-snapshot-values.mjs';
// runner/task-hub.mjs — the local runner's side of the beads task hub: its
// health line (the hub is hosted by `brew services`, never by the runner), the
// one way to run `bd`, the saved task projects as the lanes read them, and the
// small readers every bead lane shares for `bd`'s JSON and failures.

import { skipIsNew } from '../job-runs.mjs';
import { runCommand } from '../run-command.mjs';
import { beadsDatabaseName } from '../task-project-config.mjs';
import { BEADS_DOLT_DIR, CONFIG, REPO_ROOT } from './config.mjs';
import { bdBin, probeTcp } from './host-tools.mjs';
import { log } from './log.mjs';
import { declaredTaskClient, taskChildEnvironment } from '../task-client.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Beads task hub — the shared Dolt SQL server every portfolio repo files its
// tasks against (config/beads.json holds the asset ↔ prefix ↔ database map).
//
// We do NOT run it. `brew services` does, as a login-scoped launchd service
// reading the installation's dolt-server.yaml, which is the point: agents in six repos keep
// filing tasks while os:up is stopped, restarting, or mid-deploy. Supervising it
// here would have tied every repo's task tracker to this process's lifecycle.
// So os:up only *observes* it — a health line, and the nightly backup.
// ─────────────────────────────────────────────────────────────────────────────

/** What to say about the hub. A down hub is not an os:up failure — it is one
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
    // Only processes whose BINARY is dolt count. `pgrep -f` matches the
    // pattern anywhere in an argv, which includes another pgrep running this
    // very search — pgrep excludes itself but not a concurrent twin. The
    // 15-minute cron check and the per-poll check coincide at :00/:15/:30/:45,
    // so each tick briefly ran two of these probes, and each counted the
    // other as a "dolt sql-server": 175 phantom CONTENDED warnings between
    // 2026-08-01 and 2026-08-03 with never a real second server (ro-4q9).
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
 * What the hub's state actually is, in one operator-actionable line.
 *
 * Born from a real incident (2026-08-01): a hand-run `dolt sql-server` was left
 * holding 3308 and the per-database write locks, the supervised hub then died
 * five times on `database "ac" is locked by another dolt process`, and the
 * runner gave up — after five blind restarts that never named the cause. Under
 * brew's `keep_alive true` the same collision has no give-up at all; it
 * restarts forever, in a log nobody is tailing.
 *
 * Dolt takes an EXCLUSIVE WRITE LOCK PER DATABASE, so two servers over one data
 * directory is never a survivable state — which is what makes this diagnosable
 * rather than merely reportable. The two failure shapes it names:
 *
 *   reachable + more than one server → a stray is up; whichever server lost the
 *     race is the one crash-looping, and the port being open proves nothing.
 *   unreachable + at least one server → the crash-loop signature itself: a dolt
 *     process exists but nothing answers, because it dies before it can serve.
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

/** Databases worth backing up. A missing or malformed config degrades to [] —
 * a broken task map must never cost us the operational backup. Which names are usable is
 * `beadsDatabaseName`'s to say, and only its. */
export function parseBeadsSpokes(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(cfg?.spokes)) return [];
  const seen = new Set();
  const databases = [];
  for (const spoke of cfg.spokes) {
    const db = beadsDatabaseName(spoke?.database);
    if (db === null) continue;
    if (seen.has(db)) continue;
    seen.add(db);
    databases.push(db);
  }
  return databases;
}

/** A hung `bd` must not stall the tick into the next one. */
const BEADS_CALL_TIMEOUT_MS = 20_000;

/**
 * The spokes, fully resolved. `parseBeadsSpokes` above answers a narrower
 * question (which databases to back up); this one keeps the asset id and repo
 * path, which are exactly what the backup does not need and the poller cannot
 * work without.
 *
 * A spoke missing `asset`, `prefix` or `repo` is dropped rather than
 * half-polled — config/beads.README.md calls them load-bearing, and the poll
 * cannot run without any of them.
 *
 * `database` is CARRIED RATHER THAN REQUIRED (bead `ro-237o`). The poll itself
 * never uses it — `bd` runs inside the repo and resolves the database from that
 * repo's own `.beads/config.yaml` — so dropping a whole project's board over a
 * field only the backup reads would trade a real outage for a config typo. But
 * it used to be dropped on the floor here entirely, which is how a wrong value
 * stayed invisible until a restore. It travels as `null` when it is not usable,
 * and `beadsDatabaseName` is the single answer to what that means (bead
 * `ro-pb2u`), so the task-map lane sees exactly what the backup lane skips.
 *
 * There is deliberately no charset guard on `repo`: `beadsDatabaseName`
 * interpolates database names into SQL, whereas `repo` only ever becomes one
 * element of a spawn argv array with no shell. If anything here is ever moved
 * into a shell string or a query, it needs its own guard first.
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

/**
 * A skip is worth a line only when it is NEW. Pure so the no-spam rule is a
 * test rather than a hope: the same reason twice logs once, and a different
 * reason always logs.
 */
export function beadsSkipDecision(state, reason) {
  return skipIsNew(state, reason);
}

/** The id `bd create` reports back, for the log line. Null is not a failure —
 * the bead exists either way, and the exit code already said so. Shared by both
 * filing lanes: `bd create --json` answers the same shape whatever was filed. */
export function beadsCreatedId(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    return null;
  }
}
