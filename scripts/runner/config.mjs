// runner/config.mjs — where the local runner's code and state are, and its
// knobs: the port map, the host lanes' schedules and the supervision limits.
//
// This is the runner's own constants block, not the config store: a setting an
// operator saves lives in the store (scripts/config-documents.mts). Every
// runner module reads these, and scripts/os-up.mjs re-exports `CONFIG`,
// `runnerPaths` and `osCheckoutName` so their importers keep working.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEDULE_STATUS_FILE } from '../scheduled-jobs.mjs';
import { resolveHomeRoot, runtimeChildEnv, statePaths } from '../os-runtime.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — the knobs. Ports are PINNED here so the port map is one source of
// truth (os:up and os:cron both read these constants, so a tick always targets
// the same ingest the supervisor started).
// ─────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Where this runner's CODE is: the home checkout for a foreground `pnpm os:up`,
// a runtime copy under `.local/runtime/` for the managed service.
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Where its STATE is, always: the home checkout. The store,
// `.local/`, the secret files, the task inventory and the relative checkout
// paths in it are all resolved from here, so a runner started from a runtime
// copy reads and writes exactly what a runner started from home always has.
export const HOME_ROOT = resolveHomeRoot(REPO_ROOT, process.env);
export const STATE = statePaths(HOME_ROOT);

/**
 * Every path this runner reads or writes that is not code, for a runner whose
 * code is at `codeRoot`. Exported so a test can prove a runtime-copy runner
 * resolves exactly the paths a runner started from home does.
 */
export function runnerPaths(codeRoot, env = process.env) {
  const homeRoot = resolveHomeRoot(codeRoot, env);
  const state = statePaths(homeRoot);
  return {
    homeRoot,
    localDir: state.localDir,
    logsDir: state.logsDir,
    logFile: state.logFile,
    jobRunsFile: state.jobRunsFile,
    runnerStateFile: state.runnerStateFile,
    backupsDir: state.backupsDir,
    beadsDoltDir: state.beadsDoltDir,
    scheduleStatusFile: path.join(homeRoot, SCHEDULE_STATUS_FILE),
    devSecrets: state.devSecrets,
    devVars: state.devVars,
    taskHost: state.taskHost,
    backupRoot: homeRoot,
    osCheckout: osCheckoutName(homeRoot),
    towerEnv: runtimeChildEnv(homeRoot, env),
  };
}

/**
 * How a bead this runner files into a SITE's tracker names the OS's own
 * checkout, so every path in it is qualified — none of those files are the
 * reader's. The home checkout's folder name (the site repositories sit beside
 * it), never a name written into the runner. A runtime copy resolves home, so
 * it never names its own `runtime-a` slot.
 */
export function osCheckoutName(homeRoot) {
  return path.basename(homeRoot);
}
export const OS_CHECKOUT = osCheckoutName(HOME_ROOT);

export const CONFIG = {
  // The ingest's address: the "ingest door", a second listener the tower's
  // vite dev server binds to loopback only (apps/tower/vite/runner-door.ts),
  // serving the ingest's routes and its cron fires. `os:cron`,
  // scripts/pulse-relay.mjs and the single-instance guard below all read it.
  // Not 8787, which other tools commonly take.
  ingestHost: '127.0.0.1',
  ingestPort: 8791,
  towerLanHost: '0.0.0.0',
  towerPort: 5173,
  // Legacy native task-hub fallback only. A declared task client (including
  // NOTICEOS_DOLT_HOME's Compose profile) supplies its own endpoint to health
  // checks and backups. The hub's service lifecycle is independent of os:up;
  // never start the retired native service to recover a declared Compose hub.
  // Existing native installations keep these coordinates in sync with their
  // saved task map and dolt-server.yaml until an approved cutover.
  beadsHubHost: '127.0.0.1',
  beadsHubPort: 3308,
  // How often to re-check the hub. Only state *changes* are logged, so this
  // cadence costs one line when the hub goes down and one when it comes back.
  beadsHubCheckCron: '*/15 * * * *',
  // How often the hub is photographed into the central store for the Tower's
  // work board. Every minute: a minute-old answer is current and a
  // ten-minute-old one is a lie about what an agent is doing right now.
  beadsPollCron: '* * * * *',
  // How often the runner asks whether a weekly DataForSEO collection has landed
  // with no review bead against it. Hourly, off the top of the hour so it does
  // not share a tick with the wrangler crons.
  panelFilerCron: '25 * * * *',
  // How often every spoke's push state is reconciled against its remote, and
  // its gates evaluated. Hourly at :40 — off :00/:15/:30/:45 (the ingest crons
  // and the hub check) and off :25 (the panel filer), so no tick ever carries
  // two lanes' worth of subprocesses. Hourly is the cadence the bead needs:
  // the window in which a push bead names work that is already live is what
  // this number sets.
  pushStateCron: '40 * * * *',
  // How often closed bets are carried to the beads that own their readings.
  // Hourly at :50 — off every other lane's tick. Verdicts only appear when the
  // 03:30 sweep closes something, so it stays silent on ticks with nothing to
  // carry.
  watchReadbackCron: '50 * * * *',
  // How often each project's declared task database is reconciled against what
  // the hub actually holds. Hourly at :05 — off every other lane's tick, and
  // the cheapest pass here: one `SHOW DATABASES` for the whole portfolio, then
  // a `bd list` only when something has drifted. Hourly rather than nightly
  // because the value is edited on /settings and by hand, and otherwise only
  // the nightly backup reads it.
  beadsMapCheckCron: '5 * * * *',
  // How long unpushed commits may sit before the runner files a bead about
  // them: the gap between "the operator is mid-session" and "the operator
  // moved on and forgot". Filing at the first tick would file against every
  // commit anybody makes.
  pushStaleHours: 24,
  // How often every rostered property's local signal panels are rebuilt
  // (config/signal-panels.json). 13:10 UTC: after both archive crons have
  // landed — the daily GA4/GSC/BWT lane at 12:15 and the weekly DataForSEO
  // lane at 12:45 — and off the top of the hour. Daily, because a pass makes
  // zero provider calls; the cadence is chosen for the freshness bar a
  // property agent reads against (`freshnessMaxAgeDays`).
  panelRefreshCron: '10 13 * * *',
  // Nightly Postgres host backup. UTC (matches the crons). Hosts can override this
  // legacy age policy with daily/weekly retention in host-backup.json.
  backupCron: '0 4 * * *',
  backupRetentionDays: 30,
  // The off-machine copy of each night's finished backup dir goes to the
  // folder this host names in its installation's host-backup.json
  // (config/host-backup.README.md) — a folder a sync client carries offsite. A
  // host setting, read at each backup, never a path written here.
  // Supervision: if a child dies within RAPID_WINDOW_MS of starting it counts
  // as a rapid failure; after MAX_RAPID_RESTARTS of those in a row we give up
  // on that child. A run longer than the window resets the counter.
  rapidWindowMs: 10_000,
  maxRapidRestarts: 5,
  // A child is treated as "ready to receive cron fires" once we see its ready
  // banner, or — as a fallback if the banner format ever drifts — after it has
  // stayed alive this long.
  readyGraceMs: 15_000,
};

// Derived paths — state from HOME_ROOT, code from REPO_ROOT.
export const LOGS_DIR = STATE.logsDir;
export const LOG_FILE = STATE.logFile;
export const RUNNER_STATE_FILE = STATE.runnerStateFile;
export const BACKUPS_DIR = STATE.backupsDir;
// Code: the cron list ships with the code it schedules.
export const INGEST_WRANGLER = path.join(REPO_ROOT, 'workers', 'ingest', 'wrangler.jsonc');
// The task hub's data directory. The `brew services` dolt server owns its
// contents (the installation's dolt-server.yaml points at this path); we only
// guarantee the directory exists, so a fresh clone does not leave the service
// crash-looping on a missing data_dir. Under .local/ (gitignored).
export const BEADS_DOLT_DIR = STATE.beadsDoltDir;
// The secret files, always home's: a runtime copy links to them, but the sync
// below WRITES .dev.vars, and an atomic write through a link would replace the
// link with a copy of the secrets inside the runtime copy.
export const SECRET_FILES = { secretsFile: STATE.devSecrets, varsFile: STATE.devVars };
