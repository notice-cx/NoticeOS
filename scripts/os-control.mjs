#!/usr/bin/env node
// Stable operator/agent control surface for the local NoticeOS service.
//
// Raw launchctl commands, process archaeology, and filesystem log locations are
// implementation details. Agents get these repo-owned commands instead:
//   pnpm os:status [-- --json]
//   pnpm os:logs [-- --lines 200] [--follow]
//   pnpm os:restart
//   pnpm os:deploy [-- <commit> | --check | --rollback]
//   pnpm os:doctor
//   pnpm os:capacity [-- --json]
//   pnpm os:stop / pnpm os:start
//   pnpm os:install / pnpm os:uninstall

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorIsHeld, operatorToken } from './ingest-door.mjs';
import { capacitySection, readCapacity } from './os-capacity.mjs';
import { DEPLOY_HEALTH_WAIT_MS, POSTGRES_MIGRATION_SEQUENCE, postgresMigrationFiles, postgresVerdict, readLiveSlot, runDeploy } from './os-deploy.mjs';
import { redactLogText } from './os-log.mjs';
import { LEGACY_RESOURCE_NAMES, serviceLabel } from './resource-names.mjs';
import {
  homeOfRuntimeSlot,
  invokedDirectly,
  plistRunsFrom,
  postgresConfigRefusal,
  resolveHomeRoot,
  runtimeLayout,
  statePaths,
} from './os-runtime.mjs';
import { runCommand } from './run-command.mjs';
import { runnerRecordedMigrations } from './runner/database.mjs';
import { inspectDependencies } from './os-readiness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The checkout whose state this controls. Always the folder these commands are
// run from — unless they are run inside a runtime copy, whose home is the folder
// it belongs to (scripts/os-runtime.mjs).
const HOME_ROOT = resolveHomeRoot(REPO_ROOT, process.env);
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
/** The managed service's launchd label: the label a service installed before
 * the NoticeOS rename keeps (reinstalling it is operator-only), else
 * `com.noticeos.local` for a Mac that has none (scripts/resource-names.mts). */
export const LABEL = serviceLabel(
  existsSync(path.join(LAUNCH_AGENTS_DIR, `${LEGACY_RESOURCE_NAMES.serviceLabel}.plist`)),
);
const UID = typeof process.getuid === 'function' ? process.getuid() : '';
const DOMAIN = `gui/${UID}`;
const USER_DOMAIN = `user/${UID}`;
const SERVICE = `${DOMAIN}/${LABEL}`;
// launchd keeps a disabled override per domain: the plist bootstraps into the
// gui domain, but a `launchctl disable` against the user domain is the same
// trap, so every power-up clears both.
export const ENABLE_TARGETS = Object.freeze([SERVICE, `${USER_DOMAIN}/${LABEL}`]);
const STATE = statePaths(HOME_ROOT);
const LOGS_DIR = STATE.logsDir;
const LOG_FILE = STATE.logFile;
const JOB_RUNS_FILE = STATE.jobRunsFile;
const RUNNER_STATE_FILE = STATE.runnerStateFile;
const TEMPLATE_FILE = path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist');
const INSTALLED_PLIST = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const LAUNCHCTL = '/bin/launchctl';
const HEARTBEAT_STALE_MS = 90_000;
const START_WAIT_MS = 45_000;

function compactWhitespace(value) {
  return String(value ?? '').replace(/[\r\n\t ]+/gu, ' ').trim();
}

export function parseLaunchctlPrint(text) {
  const value = String(text ?? '');
  const field = (name) => value.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'mu'))?.[1] ?? null;
  const integer = (name) => {
    const raw = field(name);
    return raw !== null && /^-?\d+$/u.test(raw) ? Number(raw) : null;
  };
  return {
    loaded: value.trim() !== '',
    state: field('state'),
    pid: integer('pid'),
    runs: integer('runs'),
    lastExitCode: integer('last exit code'),
  };
}

function classifyLiveness({ service, ingest, tower, heartbeat, nowMs = Date.now() }) {
  const runtimeUp = ingest.ok && tower.ok;
  if (!service.loaded) {
    return runtimeUp
      ? {
          state: 'unhealthy',
          reason: 'runtime answers, but the launchd supervisor is not installed or loaded',
        }
      : { state: 'stopped', reason: 'no launchd service is loaded and the runtime does not answer' };
  }

  if (service.state === 'running') {
    const ageMs = heartbeat?.updatedAt ? nowMs - Date.parse(heartbeat.updatedAt) : null;
    if (heartbeat?.status === 'starting') {
      return {
        state: 'starting',
        reason: runtimeUp
          ? 'runtime answers; the supervisor is still arming its scheduler'
          : 'launchd is running the service; the runtime is not ready yet',
      };
    }
    if (runtimeUp && Number.isFinite(ageMs) && ageMs > HEARTBEAT_STALE_MS) {
      return {
        state: 'stale',
        reason: `runtime answers, but its supervisor heartbeat is ${Math.round(ageMs / 1000)}s old`,
      };
    }
    if (runtimeUp && heartbeat?.status === 'healthy') {
      return { state: 'healthy', reason: 'launchd, runner heartbeat, ingest, and Tower all answer' };
    }
    if (runtimeUp && !heartbeat) {
      return {
        state: 'unhealthy',
        reason: 'runtime answers, but no supervisor heartbeat exists; restart through the managed service',
      };
    }
    return {
      state: 'unhealthy',
      reason: `launchd says running, but ${!ingest.ok ? 'ingest' : 'Tower'} does not answer`,
    };
  }

  return {
    state: 'unhealthy',
    reason:
      service.lastExitCode === null
        ? `launchd service is loaded with state ${service.state ?? 'unknown'}, not running`
        : `launchd service exited with code ${service.lastExitCode}`,
  };
}

export function classifyRunnerState(input) {
  const liveness = classifyLiveness(input);
  if (liveness.state !== 'healthy') return liveness;
  const unavailable = [['postgres', 'PostgreSQL'], ['dolt', 'task database']]
    .filter(([key]) => input.dependencies?.[key]?.state !== 'ready')
    .map(([, label]) => label);
  return unavailable.length
    ? { state: 'unhealthy', reason: `runtime answers, but ${unavailable.join(' and ')} readiness is not confirmed` }
    : { state: 'healthy', reason: 'supervisor, heartbeat, HTTP endpoints, and both database reads are ready' };
}

function runLaunchctl(args) {
  return runCommand(LAUNCHCTL, args, { cwd: REPO_ROOT, timeoutMs: 10_000 });
}

/**
 * Clear the label's disabled override in every domain, then bootstrap or
 * kickstart it. Enable comes before the load: a disabled label refuses the
 * bootstrap, so an enable that waits on a successful bootstrap can never run
 * in the one case it exists for. Enabling a clean, unknown or already-loaded
 * label is harmless, so no enable result is fatal; the results are evidence
 * for the failure hint if the load fails too. `launchctl(args)` resolves
 * `{ code, stdout, stderr }`.
 */
export async function powerUp(action, launchctl) {
  const enable = [];
  for (const target of ENABLE_TARGETS) enable.push({ target, ...(await launchctl(['enable', target])) });
  const result = await launchctl(
    action === 'kickstart' ? ['kickstart', SERVICE] : ['bootstrap', DOMAIN, INSTALLED_PLIST],
  );
  return { enable, launchctl: result };
}

async function probe(url, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: compactWhitespace(error?.message ?? error) };
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function serviceSnapshot() {
  if (process.platform !== 'darwin') {
    return { loaded: false, state: null, pid: null, runs: null, lastExitCode: null, unsupported: true };
  }
  const result = await runLaunchctl(['print', SERVICE]);
  if (result.code !== 0) {
    return { loaded: false, state: null, pid: null, runs: null, lastExitCode: null };
  }
  return parseLaunchctlPrint(result.stdout);
}

export async function inspectRunner(nowMs = Date.now(), {
  readService = serviceSnapshot,
  probeHttp = probe,
  readHeartbeat = () => readJson(RUNNER_STATE_FILE),
  readDependencies = () => inspectDependencies({ dolt: { plistFile: INSTALLED_PLIST } }),
} = {}) {
  const [service, ingest, tower, heartbeat, dependencies] = await Promise.all([
    readService(),
    probeHttp('http://127.0.0.1:8791/healthz'),
    probeHttp('http://127.0.0.1:5173/'),
    readHeartbeat(),
    readDependencies(),
  ]);
  const input = { service, ingest, tower, heartbeat, dependencies, nowMs };
  const verdict = classifyRunnerState(input);
  return {
    ...verdict,
    checkedAt: new Date(nowMs).toISOString(),
    service: { label: LABEL, ...service },
    ingest,
    tower,
    heartbeat,
    liveness: classifyLiveness(input),
    dependencies,
  };
}

function stateGlyph(state) {
  return { healthy: '●', starting: '◐', stale: '◷', unhealthy: '!', stopped: '○' }[state] ?? '?';
}

// Which code the OS runs. Merging is not deploying: the managed service runs
// a runtime copy that only `pnpm os:deploy` moves, so status answers "is main
// ahead of what is live?" in one line.

async function readInstalledPlist() {
  try {
    return await fs.readFile(INSTALLED_PLIST, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function gitOut(cwd, args, { trim = true } = {}) {
  const result = await runCommand('git', args, { cwd, timeoutMs: 10_000 });
  return result.code === 0 ? (trim ? result.stdout.trim() : result.stdout) : null;
}

/**
 * What code the OS runs and how it relates to main. The runner's own heartbeat
 * is the truth when it carries one (`codeRoot`, `commit`); a runner from before
 * the runtime copy does not, and then the installed plist says where it runs.
 */
export async function inspectCode({
  homeRoot = HOME_ROOT,
  heartbeat = null,
  git = gitOut,
  readPlist = readInstalledPlist,
} = {}) {
  const main = await git(homeRoot, ['rev-parse', '--verify', '--quiet', 'main^{commit}']);
  let mode;
  let commit = null;
  if (typeof heartbeat?.codeRoot === 'string' && heartbeat.codeRoot !== '') {
    mode = homeOfRuntimeSlot(heartbeat.codeRoot) ? 'runtime' : 'checkout';
    commit = typeof heartbeat.commit === 'string' ? heartbeat.commit : null;
  } else if (plistRunsFrom(await readPlist(), homeRoot) === 'runtime') {
    mode = 'runtime';
    commit = await git(runtimeLayout(homeRoot).current, ['rev-parse', 'HEAD']);
  } else {
    mode = 'checkout';
  }
  let behind = null;
  let onMain = null;
  if (mode === 'runtime' && commit && main) {
    const ancestor = await runCommand('git', ['merge-base', '--is-ancestor', commit, main], { cwd: homeRoot, timeoutMs: 10_000 });
    onMain = ancestor.code === 0 ? true : ancestor.code === 1 ? false : null;
    const count = onMain ? await git(homeRoot, ['rev-list', '--count', `${commit}..${main}`]) : null;
    behind = count !== null && /^\d+$/u.test(count) ? Number(count) : null;
  }
  return { mode, commit, main, behind, onMain };
}

/** The one plain-words line about which code runs. */
export function codeLine(code) {
  const label = '  code        ';
  if (!code) return `${label}unknown`;
  if (code.mode === 'checkout') {
    return `${label}runs from this folder, so every merge reloads it — pnpm os:deploy, then pnpm os:install`;
  }
  const at = code.commit ? code.commit.slice(0, 8) : 'unknown commit';
  if (!code.commit || code.onMain === null) return `${label}${at} · could not compare with main`;
  if (code.onMain === false) return `${label}${at} · not on main`;
  if (code.behind === 0) return `${label}${at} · same as main`;
  if (code.behind === null) return `${label}${at} · on main`;
  return `${label}${at} · main is ${code.behind} commit${code.behind === 1 ? '' : 's'} ahead — pnpm os:deploy`;
}

export function statusLines(status) {
  const heartbeatAge = status.heartbeat?.updatedAt
    ? `${Math.max(0, Math.round((Date.parse(status.checkedAt) - Date.parse(status.heartbeat.updatedAt)) / 1000))}s ago`
    : 'none';
  return [
    `${stateGlyph(status.state)} NoticeOS ${status.state.toUpperCase()} — ${status.reason}`,
    `  supervisor  ${status.service.loaded ? status.service.state ?? 'loaded' : 'not loaded'}${status.service.pid ? ` · pid ${status.service.pid}` : ''}`,
    `  ingest      ${status.ingest.ok ? `HTTP ${status.ingest.status}` : 'down'}`,
    `  Tower       ${status.tower.ok ? `HTTP ${status.tower.status}` : 'down'}`,
    `  heartbeat   ${heartbeatAge}`,
    ...(status.dependencies ? [
      `  PostgreSQL  ${status.dependencies.postgres?.state ?? 'unknown'}`,
      `  tasks       ${status.dependencies.dolt?.state ?? 'unknown'}`,
    ] : []),
    ...(status.code ? [codeLine(status.code)] : []),
  ];
}

async function inspectWithCode() {
  const status = await inspectRunner();
  return { ...status, code: await inspectCode({ heartbeat: status.heartbeat }) };
}

async function printStatus({ json = false } = {}) {
  const status = await inspectWithCode();
  process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : `${statusLines(status).join('\n')}\n`);
  return status;
}

/**
 * The live store's migrations against main's, read-only (the same read a deploy
 * makes before it will move the OS). One line for the diagnostic report.
 */
export async function storeLine({
  homeRoot = HOME_ROOT,
  code,
  git = gitOut,
  readPostgresMigrations = runnerRecordedMigrations,
  fsp = fs,
} = {}) {
  const label = '  store       ';
  const source = code?.mode === 'runtime' ? runtimeLayout(homeRoot).current : homeRoot;
  for (const file of ['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc']) {
    let text = null;
    try {
      text = await fsp.readFile(path.join(source, file), 'utf8');
    } catch {
      // An unreadable config never permits a database read.
    }
    const refusal = postgresConfigRefusal(text, file);
    if (refusal) return `${label}unknown — ${refusal}`;
  }
  {
    const recorded = await readPostgresMigrations();
    if (!recorded.ok) return `${label}Postgres migrations unknown — ${recorded.line}`;
    // The deploy helper takes a command result; hash raw blobs, including
    // their trailing newline, exactly as deploy does.
    const files = await postgresMigrationFiles(async (...args) => {
      const stdout = await git(...args, { trim: false });
      return { code: stdout === null ? 1 : 0, stdout: stdout ?? '' };
    }, homeRoot, 'main');
    const summary = `${label}${recorded.records.length} Postgres migration${recorded.records.length === 1 ? '' : 's'} recorded`;
    if (files === null) return `${summary} · could not list main's Postgres migrations`;
    const { migrations } = postgresVerdict(files, recorded.records, 'main');
    const details = [
      ['pending', 'not applied'],
      ['changed', 'changed since apply'],
      ['out-of-order', 'out of order'],
      ['missing', 'recorded but absent from main'],
    ].flatMap(([state, description]) => {
      const matching = migrations.filter((migration) => migration.state === state);
      if (matching.length === 0) return [];
      const names = matching.map((migration) => `${migration.name}.sql`).join(', ');
      const next = state === 'pending' ? ` (operator-only: ${POSTGRES_MIGRATION_SEQUENCE.join(', ')})` : '';
      return [`${matching.length} ${description}: ${names}${next}`];
    });
    return `${summary} · ${details.length === 0 ? 'none pending on main' : `main: ${details.join(' · ')}`}`;
  }

}

function parseLineCount(argv, fallback = 200) {
  const index = argv.indexOf('--lines');
  if (index < 0) return fallback;
  const count = Number(argv[index + 1]);
  if (!Number.isInteger(count) || count < 1 || count > 2_000) {
    throw new Error('--lines must be an integer from 1 to 2000');
  }
  return count;
}

async function recentLines(file, count) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/u).filter(Boolean).slice(-count).map(redactLogText);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function showLogs(argv) {
  const lines = parseLineCount(argv);
  if (!argv.includes('--follow')) {
    const recent = await recentLines(LOG_FILE, lines);
    if (recent.length === 0) process.stdout.write(`No runner log exists yet at ${LOG_FILE}\n`);
    else process.stdout.write(`${recent.join('\n')}\n`);
    return;
  }

  await fs.mkdir(LOGS_DIR, { recursive: true });
  const tail = spawn('/usr/bin/tail', ['-n', String(lines), '-F', LOG_FILE], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pending = '';
  tail.stdout.setEncoding('utf8');
  tail.stdout.on('data', (chunk) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) process.stdout.write(`${redactLogText(line)}\n`);
  });
  tail.stderr.pipe(process.stderr);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => tail.kill(signal));
  }
  // 'close': the lines still in the pipe when tail stops are printed too
  // (scripts/run-command.mjs says why 'exit' is too early).
  await new Promise((resolve) => tail.once('close', resolve));
}

async function doctor() {
  const status = await inspectWithCode();
  const [logs, jobs, store, capacityReport] = await Promise.all([
    recentLines(LOG_FILE, 200),
    recentLines(JOB_RUNS_FILE, 100),
    storeLine({ code: status.code }).catch((error) => `  store       could not be read (${error?.message ?? error})`),
    // Asked of the runtime over its door, never by opening the store file.
    capacitySection({ backupsDir: STATE.backupsDir }),
  ]);
  const report = [
    '# NoticeOS bounded diagnostic report',
    `generated_at=${status.checkedAt}`,
    `repo=${HOME_ROOT}`,
    '',
    '## Status',
    ...statusLines(status),
    store,
    '',
    ...capacityReport,
    '',
    `## Runner log (last ${logs.length} lines; redacted)`,
    ...(logs.length ? logs : ['No runner log exists.']),
    '',
    `## Job-run record (last ${jobs.length} lines; redacted)`,
    ...(jobs.length ? jobs : ['No job-run record exists.']),
  ];
  process.stdout.write(`${redactLogText(report.join('\n'))}\n`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * The plist for this install. launchd runs the runtime copy's `current` link,
 * so a deploy moves the service by moving that link and never rewrites this
 * file; `NOTICEOS_HOME` tells the runner where its state stays.
 */
export function renderLaunchAgent(template, { label = LABEL, nodePath, nodeBinDir, runtimeRoot, homeRoot, doltHome }) {
  if (doltHome !== undefined && (typeof doltHome !== 'string' || !path.isAbsolute(doltHome) || /[\u0000-\u001f]/u.test(doltHome))) {
    throw new Error('NOTICEOS_DOLT_HOME must be an absolute installation folder.');
  }
  const replacements = {
    __LABEL__: label,
    __NODE_PATH__: nodePath,
    __NODE_BIN_DIR__: nodeBinDir,
    __RUNTIME_ROOT__: runtimeRoot,
    __HOME_ROOT__: homeRoot,
  };
  let rendered = String(template);
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, () => xmlEscape(value));
  }
  rendered = rendered.replaceAll('__DOLT_HOME_ENV__', () => doltHome === undefined ? '' :
    `    <key>NOTICEOS_DOLT_HOME</key>\n    <string>${xmlEscape(doltHome)}</string>`);
  const remaining = rendered.match(/__[A-Z0-9_]+__/gu);
  if (remaining) throw new Error(`launchd template still has placeholder(s): ${remaining.join(', ')}`);
  return rendered;
}

/**
 * Why install cannot point the service at a runtime copy yet, or null when it
 * can. `live` is os-deploy's readLiveSlot answer; `runnerPresent` whether the
 * copy it names holds scripts/os-up.mjs.
 */
export function installRuntimeRefusal({ insideRuntime = false, live, runnerPresent }) {
  if (insideRuntime) {
    return 'this is a runtime copy. Run pnpm os:install from the main folder it belongs to.';
  }
  if (live?.problem) return live.problem;
  if (!live?.slot || !runnerPresent) {
    return (
      'there is no runtime copy to run yet. pnpm os:deploy prepares one from main without touching ' +
      'the running service; then run pnpm os:install again.'
    );
  }
  return null;
}

export function reinstallTaskStoreRefusal(installedPlist, doltHome) {
  if (doltHome === undefined && String(installedPlist ?? '').includes('NOTICEOS_DOLT_HOME')) {
    return 'The installed service declares a task-store home. Reinstall with its approved NOTICEOS_DOLT_HOME; nothing was changed.';
  }
  return null;
}

async function installService() {
  if (process.platform !== 'darwin') throw new Error('the local runner service requires macOS launchd');
  const layout = runtimeLayout(HOME_ROOT);
  const live = await readLiveSlot(layout);
  let runnerPresent = false;
  try {
    await fs.access(path.join(layout.current, 'scripts', 'os-up.mjs'));
    runnerPresent = true;
  } catch {
    // reported by installRuntimeRefusal
  }
  const refusal = installRuntimeRefusal({ insideRuntime: homeOfRuntimeSlot(REPO_ROOT) !== null, live, runnerPresent });
  if (refusal) throw new Error(refusal);
  const doltHome = process.env.NOTICEOS_DOLT_HOME;
  const taskStoreRefusal = reinstallTaskStoreRefusal(await readInstalledPlist(), doltHome);
  if (taskStoreRefusal) throw new Error(taskStoreRefusal);

  const before = await inspectRunner();
  if (!before.service.loaded && (before.ingest.ok || before.tower.ok)) {
    throw new Error(
      'an unmanaged/manual NoticeOS runtime is already answering. Stop its pnpm os:up terminal first; ' +
        'the installer will not guess which process tree is safe to kill.',
    );
  }

  const template = await fs.readFile(TEMPLATE_FILE, 'utf8');
  const rendered = renderLaunchAgent(template, {
    nodePath: process.execPath,
    nodeBinDir: path.dirname(process.execPath),
    runtimeRoot: layout.current,
    homeRoot: HOME_ROOT,
    doltHome,
  });
  await fs.mkdir(path.dirname(INSTALLED_PLIST), { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });

  // Out of launchd (and waited out of it), then the new plist, then loaded.
  const replaced = await replaceService({
    launchctl: runLaunchctl,
    loaded: before.service.loaded,
    writePlist: async () => {
      const temporary = `${INSTALLED_PLIST}.tmp`;
      await fs.writeFile(temporary, rendered, { mode: 0o600 });
      await fs.rename(temporary, INSTALLED_PLIST);
    },
  });
  if (replaced.code !== 0) throw new Error(replaced.message);
  // The deploy's budget: the first start from a fresh runtime copy may
  // pre-bundle dependencies, and this is the cut-over's one restart.
  await waitForHealthy('install', { timeoutMs: DEPLOY_HEALTH_WAIT_MS });
  process.stdout.write(`Installed and started ${LABEL} from ${INSTALLED_PLIST}\n`);
}

async function uninstallService() {
  if (process.platform !== 'darwin') throw new Error('the local runner service requires macOS launchd');
  const service = await serviceSnapshot();
  if (service.loaded) {
    const stopped = await runLaunchctl(['bootout', SERVICE]);
    if (stopped.code !== 0) throw new Error(`launchctl bootout failed: ${compactWhitespace(stopped.stderr)}`);
  }
  try {
    await fs.unlink(INSTALLED_PLIST);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  process.stdout.write(`Stopped ${LABEL} and removed ${INSTALLED_PLIST}\n`);
}

// stop / start: the same plist, powered down and back up. Neither writes or
// deletes the plist. Stop proves the door is free before declaring
// maintenance safe: launchctl bootout only releases the label, and an
// answering orphan could still accept application writes.

const { host: DOOR_HOST, port: DOOR_PORT } = new URL(DEFAULT_DOOR);
// Longer than the runner's own shutdown budget (5s then 2s for its vite group,
// scripts/os-up.mjs `shutdown`), or a healthy stop is reported as an orphan.
export const STOP_WAIT_MS = 12_000;
const STOP_POLL_MS = 250;

async function plistIsInstalled() {
  try {
    await fs.access(INSTALLED_PLIST);
    return true;
  } catch {
    return false;
  }
}

/** Is the service out of the domain after a bootout? Code 3 / "No such
 * process" means launchd had already dropped it between the `print` snapshot
 * and this call: the outcome asked for. */
export function bootoutLeftServiceOut({ code, stderr = '' } = {}) {
  return code === 0 || code === 3 || /no such process|could not find service/iu.test(stderr);
}

/** Was a bootstrap refused because the label is already loaded (EALREADY,
 * "Bootstrap failed: 37: Operation already in progress")? The same race in
 * the other direction, and "already running" is what was wanted anyway. */
export function bootstrapFoundServiceLoaded({ code, stderr = '' } = {}) {
  return code === 37 || /already in progress|already loaded|already bootstrapped/iu.test(stderr);
}

/** Did `launchctl enable` leave the label un-disabled? A label launchd has
 * never loaded answers "no such process" / "could not find service" on some
 * releases, which is the same outcome. A domain or permission failure is not,
 * and is worth telling the operator about if the bootstrap then fails too. */
export function enableLeftServiceEnabled({ code, stderr = '' } = {}) {
  return code === 0 || code === 3 || code === 113 || /no such process|could not find service/iu.test(stderr);
}

/**
 * Does a `launchctl print-disabled <domain>` listing hold LABEL disabled? Recent
 * macOS prints `"label" => disabled` / `=> enabled`, older releases `=> true`
 * (disabled) / `=> false`. A label the listing does not name is not disabled.
 */
export function listingShowsLabelDisabled(text, label = LABEL) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const value = String(text ?? '').match(new RegExp(`"${escaped}"\\s*=>\\s*(\\w+)`, 'u'))?.[1];
  return value !== undefined && /^(disabled|true)$/iu.test(value);
}

/**
 * The domains (gui/<uid>, user/<uid>) whose print-disabled listing actually holds
 * LABEL disabled, or null when neither listing could be read — the evidence the
 * disabled-label hint needs before it may say anything.
 */
export async function labelDisabledIn(launchctl) {
  const disabledIn = [];
  let read = 0;
  for (const domain of [DOMAIN, USER_DOMAIN]) {
    const listing = await launchctl(['print-disabled', domain]);
    if (listing.code !== 0) continue;
    read += 1;
    if (listingShowsLabelDisabled(listing.stdout)) disabledIn.push(domain);
  }
  return read === 0 ? null : disabledIn;
}

/**
 * The extra operator line when launchd really holds the label disabled.
 * launchd prints a disabled label as a bare `Bootstrap failed: 5:
 * Input/output error`, the same thing it prints for a plist it cannot load
 * and for a label still leaving the domain, so the error is no evidence: the
 * hint appears only when `disabledIn` (labelDisabledIn's answer) is
 * non-empty. `enable` is the list `powerUp` returns, named if it failed.
 */
export function disabledLabelHint({ enable = null, disabledIn = null } = {}) {
  if (!Array.isArray(disabledIn) || disabledIn.length === 0) return null;
  const failed = [].concat(enable ?? []).find((result) => !enableLeftServiceEnabled(result));
  return (
    `launchctl print-disabled shows ${LABEL} disabled in ${disabledIn.join(' and ')}, and a disabled ` +
    'label refuses every bootstrap.' +
    (failed
      ? ` The \`launchctl enable ${failed.target ?? SERVICE}\` this ran first failed ` +
        `(${compactWhitespace(failed.stderr) || `exit ${failed.code}`}).`
      : '')
  );
}

export function stopNotInstalledMessage() {
  return (
    `no plist for ${LABEL} at ${INSTALLED_PLIST}, so there is no managed service to stop. ` +
    'Ctrl-C the terminal if a foreground pnpm os:up is what is running; pnpm os:install ' +
    'installs the login service.'
  );
}

export function startNotInstalledMessage() {
  return (
    `no plist for ${LABEL} at ${INSTALLED_PLIST}, so there is nothing to start. ` +
    'pnpm os:install writes the plist and starts it; pnpm os:start only powers up a service ' +
    'that is already installed.'
  );
}

/** Something other than the managed service holds the door; maintenance must
 * not proceed while that runtime can still accept writes. */
export function doorStillHeldMessage({ bootedOut = false } = {}) {
  return [
    bootedOut
      ? `booted ${LABEL} out of launchd, but something still answers on ${DOOR_HOST}.`
      : `${LABEL} is installed and not loaded, yet something still answers on ${DOOR_HOST}.`,
    '  That is not the managed service: it is a foreground `pnpm os:up` (Ctrl-C that terminal)',
    '  or a vite/workerd orphaned by a runner that crashed. Find the owner:',
    `    lsof -nP -iTCP:${DOOR_PORT} -sTCP:LISTEN`,
    '  — kill it, then run pnpm os:stop again to confirm the port is free.',
  ].join('\n');
}

/**
 * What `stop` does before it touches launchctl. `doorHeld` is a TCP connect
 * (ingest-door's doorIsHeld), not the /healthz probe: a bound runtime that is
 * not yet serving still prevents a safe maintenance window.
 */
export function resolveStopAction({ plistExists, serviceLoaded, doorHeld }) {
  if (!plistExists) return { action: 'refuse', code: 1, message: stopNotInstalledMessage() };
  if (serviceLoaded) return { action: 'bootout', code: 0 };
  if (doorHeld) {
    return { action: 'refuse-orphan', code: 1, message: doorStillHeldMessage({ bootedOut: false }) };
  }
  return {
    action: 'already-stopped',
    code: 0,
    message:
      `${LABEL} is already stopped and ${DOOR_HOST} is free. Its plist stays installed — ` +
      'pnpm os:start powers it back up.',
  };
}

/**
 * What `stop` reports once launchctl has answered. `doorHeld` is the state
 * after the bounded wait and is only read when the service is actually out.
 */
export function resolveStopResult({ bootout, doorHeld }) {
  if (!bootoutLeftServiceOut(bootout)) {
    return {
      code: 1,
      message:
        `launchctl bootout failed, so ${LABEL} is still loaded: ` +
        `${compactWhitespace(bootout?.stderr) || `exit ${bootout?.code}`}`,
    };
  }
  if (doorHeld) return { code: 1, message: doorStillHeldMessage({ bootedOut: true }) };
  return {
    code: 0,
    message:
      `Stopped ${LABEL}; ${DOOR_HOST} is free. Its plist stays installed — pnpm os:start powers it back up.`,
  };
}

// install: out of the domain before back in. `launchctl bootout` returns
// before a KeepAlive service with children has actually left the domain, and
// a bootstrap in that window is refused with a bare "Bootstrap failed: 5:
// Input/output error". So an install waits for launchd to let go of the label
// (STOP_WAIT_MS), and a bootstrap still refused with EIO waits once more and
// is retried once, never more.

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `launchctl print` until launchd no longer knows the label, bounded.
 * Returns whether it is gone. */
export async function waitForLabelGone({
  launchctl,
  timeoutMs = STOP_WAIT_MS,
  pollMs = STOP_POLL_MS,
  now = Date.now,
  sleep = sleepFor,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if ((await launchctl(['print', SERVICE])).code !== 0) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** What an install that could not load its service says: the OS is stopped, why,
 * and the one command that brings it back. */
export function installLoadFailedMessage({ launchctl, enable = null, disabledIn = null, bootedOut, attempts }) {
  const hint = disabledLabelHint({ enable, disabledIn });
  return [
    bootedOut
      ? 'the old service was removed and the new one did not load, so the OS is STOPPED.'
      : 'the service did not load, so the OS is STOPPED.',
    `  launchctl bootstrap failed${attempts > 1 ? ` ${attempts} times` : ''}: ` +
      `${compactWhitespace(launchctl?.stderr) || `exit ${launchctl?.code}`}`,
    ...(hint ? [`  ${hint}`] : []),
    '  Recover: pnpm os:start',
  ].join('\n');
}

/**
 * The launchd half of `pnpm os:install`: take the loaded service out, wait
 * until it has left the domain, write the new plist, load it through
 * `powerUp`. `launchctl(args)` resolves `{ code, stdout, stderr }`.
 */
export async function replaceService({ launchctl, loaded, writePlist, timeoutMs, pollMs, now, sleep }) {
  const wait = () => waitForLabelGone({ launchctl, timeoutMs, pollMs, now, sleep });
  if (loaded) {
    const bootout = await launchctl(['bootout', SERVICE]);
    if (!bootoutLeftServiceOut(bootout)) {
      return {
        code: 1,
        message: `${resolveStopResult({ bootout, doorHeld: false }).message}. The new plist was not written; nothing changed.`,
      };
    }
    await wait();
  }
  await writePlist();
  let attempts = 1;
  let power = await powerUp('bootstrap', launchctl);
  if (power.launchctl.code === 5) {
    // EIO: most often the old label still on its way out.
    await wait();
    attempts += 1;
    power = await powerUp('bootstrap', launchctl);
  }
  if (power.launchctl.code === 0) return { code: 0, attempts };
  return {
    code: 1,
    attempts,
    message: installLoadFailedMessage({
      launchctl: power.launchctl,
      enable: power.enable,
      disabledIn: await labelDisabledIn(launchctl),
      bootedOut: loaded,
      attempts,
    }),
  };
}

export function resolveStartAction({ plistExists, serviceLoaded, serviceState }) {
  if (!plistExists) return { action: 'refuse', code: 1, message: startNotInstalledMessage() };
  if (!serviceLoaded) return { action: 'bootstrap', code: 0 };
  if (serviceState === 'running') {
    return {
      action: 'already-running',
      code: 0,
      message:
        `${LABEL} is already loaded and running. pnpm os:status is the health check; ` +
        'pnpm os:restart is the restart.',
    };
  }
  // Loaded but not running: launchd still owns the label, so a bootstrap
  // would only answer EALREADY; kickstart powers this state up.
  return { action: 'kickstart', code: 0 };
}

export function resolveStartResult({ action, launchctl, enable = null, disabledIn = null }) {
  const health =
    'vite takes a few seconds to answer, so this does not wait for health — pnpm os:status is ' +
    'the health check.';
  if (launchctl?.code === 0) {
    return {
      code: 0,
      message:
        action === 'kickstart'
          ? `Started the already-loaded ${LABEL}. ${health}`
          : `Loaded ${LABEL} from ${INSTALLED_PLIST}. ${health}`,
    };
  }
  if (action === 'bootstrap' && bootstrapFoundServiceLoaded(launchctl)) {
    return { code: 0, message: `${LABEL} was already loaded, so nothing changed. ${health}` };
  }
  const hint = disabledLabelHint({ enable, disabledIn });
  return {
    code: 1,
    message:
      `launchctl ${action} failed: ` +
      `${compactWhitespace(launchctl?.stderr) || `exit ${launchctl?.code}`}` +
      (hint ? `\n  ${hint}` : ''),
  };
}

/** Poll the ingest door until nothing answers, bounded. Returns whether it
 * is still held. */
async function waitForDoorRelease({ held = doorIsHeld, timeoutMs = STOP_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await held(DEFAULT_DOOR))) return false;
    if (Date.now() >= deadline) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
}

async function stopService() {
  if (process.platform !== 'darwin') throw new Error('the local runner service requires macOS launchd');
  const [plistExists, service, doorHeld] = await Promise.all([
    plistIsInstalled(),
    serviceSnapshot(),
    doorIsHeld(DEFAULT_DOOR),
  ]);
  const decision = resolveStopAction({ plistExists, serviceLoaded: service.loaded, doorHeld });
  if (decision.action !== 'bootout') {
    if (decision.code !== 0) throw new Error(decision.message);
    process.stdout.write(`${decision.message}\n`);
    return;
  }

  process.stdout.write(`Stopping ${LABEL} (state: ${service.state ?? 'loaded'})…\n`);
  const bootout = await runLaunchctl(['bootout', SERVICE]);
  // Only measured when the service is actually out; null means "not asked".
  const stillHeld = bootoutLeftServiceOut(bootout) ? await waitForDoorRelease() : null;
  const result = resolveStopResult({ bootout, doorHeld: stillHeld });
  if (result.code !== 0) throw new Error(result.message);
  process.stdout.write(`${result.message}\n`);
}

async function startService() {
  if (process.platform !== 'darwin') throw new Error('the local runner service requires macOS launchd');
  const [plistExists, service] = await Promise.all([plistIsInstalled(), serviceSnapshot()]);
  const decision = resolveStartAction({
    plistExists,
    serviceLoaded: service.loaded,
    serviceState: service.state,
  });
  if (decision.action === 'refuse') throw new Error(decision.message);
  if (decision.action === 'already-running') {
    process.stdout.write(`${decision.message}\n`);
    return;
  }

  // Enable (every domain) before either action — see powerUp.
  const { enable, launchctl } = await powerUp(decision.action, runLaunchctl);
  const refused =
    launchctl.code !== 0 && !(decision.action === 'bootstrap' && bootstrapFoundServiceLoaded(launchctl));
  // Only a refusal needs the evidence the disabled-label hint rests on.
  const disabledIn = refused ? await labelDisabledIn(runLaunchctl) : null;
  const result = resolveStartResult({ action: decision.action, launchctl, enable, disabledIn });
  if (result.code !== 0) throw new Error(result.message);
  process.stdout.write(`${result.message}\n`);
}

/**
 * Poll classified status until a new runner (not `previousPid`) is healthy,
 * or fail with the status and the recent redacted runner log.
 */
export async function waitForHealthy(
  action,
  {
    previousPid = null,
    inspect = inspectRunner,
    timeoutMs = START_WAIT_MS,
    pollMs = 500,
    readLog = () => recentLines(LOG_FILE, 80),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspect();
    if (last.state === 'healthy' && (previousPid === null || last.heartbeat?.pid !== previousPid)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const tail = await readLog();
  throw new Error(
    `${action} did not return NoticeOS to healthy within ${Math.round(timeoutMs / 1000)}s\n` +
      `${last ? statusLines(last).join('\n') : 'status unavailable'}\n` +
      `--- recent redacted runner log ---\n${tail.join('\n')}`,
  );
}

/**
 * One restart of the loaded managed service, then the health wait above. The
 * only restart `pnpm os:deploy` makes too, so a deploy reports a failed start
 * exactly the way a restart does.
 */
export async function restartAndWait({
  action = 'restart',
  launchctl = runLaunchctl,
  inspect = inspectRunner,
  timeoutMs = START_WAIT_MS,
  pollMs = 500,
  readLog = () => recentLines(LOG_FILE, 80),
  announce = null,
} = {}) {
  const before = await inspect();
  if (!before.service.loaded) {
    throw new Error(
      'the managed service is not loaded; restart refuses to kill a manual or unknown process. ' +
        'Run pnpm os:install after stopping any manual pnpm os:up terminal.',
    );
  }
  announce?.(before);
  const result =
    before.service.state === 'running'
      ? await launchctl(['kill', 'SIGTERM', SERVICE])
      : await launchctl(['kickstart', SERVICE]);
  if (result.code !== 0) {
    throw new Error(`launchctl restart failed: ${compactWhitespace(result.stderr)}`);
  }
  return waitForHealthy(action, {
    previousPid: before.heartbeat?.pid ?? null,
    inspect,
    timeoutMs,
    pollMs,
    readLog,
  });
}

async function restartService() {
  if (process.platform !== 'darwin') throw new Error('the local runner service requires macOS launchd');
  const after = await restartAndWait({
    announce: (before) => process.stdout.write(`Restarting ${LABEL} (previous state: ${before.state})…\n`),
  });
  process.stdout.write(`${statusLines(after).join('\n')}\n`);
}

/** `pnpm os:deploy` — scripts/os-deploy.mjs holds the rules; this wires the machine. */
async function deployService(argv) {
  process.exitCode = await runDeploy({
    homeRoot: HOME_ROOT,
    argv,
    deps: {
      run: runCommand,
      // Niced: the live OS keeps serving while the idle copy installs. Never
      // asks to purge node_modules, since there is no terminal.
      install: ({ cwd }) =>
        runCommand('/usr/bin/nice', ['-n', '10', 'pnpm', 'install', '--frozen-lockfile', '--config.confirmModulesPurge=false'], {
          cwd,
          timeoutMs: 15 * 60_000,
        }),
      readPlist: readInstalledPlist,
      readPostgresMigrations: () => runnerRecordedMigrations(),
      service: serviceSnapshot,
      // 'deploy' or 'rollback' — the word a failed health wait leads with.
      restart: ({ timeoutMs, action = 'deploy' }) => restartAndWait({ action, timeoutMs }),
      statusLines,
      out: (line) => process.stdout.write(`${redactLogText(line)}\n`),
    },
  });
}

/** The capacity inventory on its own: the doctor's section, or `--json` for
 * the raw answer a sizing readback records. */
async function capacity(argv) {
  if (argv.includes('--json')) {
    const inventory = await readCapacity({ token: await operatorToken() });
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  const lines = await capacitySection({ backupsDir: STATE.backupsDir });
  process.stdout.write(`${redactLogText(lines.join('\n'))}\n`);
}

function usage() {
  return `NoticeOS local service control\n\n` +
    `  pnpm os:status [-- --json]       classified health (stopped/starting/healthy/unhealthy/stale)\n` +
    `  pnpm os:logs [-- --lines N]      recent redacted combined runner log (default 200)\n` +
    `  pnpm os:logs -- --follow         follow the redacted combined runner log\n` +
    `  pnpm os:restart                  restart the managed service and wait for health\n` +
    `  pnpm os:deploy [-- <commit>]     move the live OS to main (merging never does): one restart, health wait\n` +
    `  pnpm os:deploy -- --check        verify a deploy without changing anything\n` +
    `  pnpm os:deploy -- --rollback     return to the previous runtime copy: one restart, health wait\n` +
    `  pnpm os:doctor                   bounded status + recent logs + scheduled-lane evidence + capacity\n` +
    `  pnpm os:capacity [-- --json]     the store's size and growth per table, read-only, through the ingest door\n` +
    `  pnpm os:stop                     stop it for maintenance, keeping its plist, and prove ${DOOR_HOST} free\n` +
    `  pnpm os:start                    power the installed service back up (os:status is the health check)\n` +
    `  pnpm os:install                  idempotently install/start the launchd user agent\n` +
    `  pnpm os:uninstall                stop it and remove only its installed plist\n`;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2).filter((arg) => arg !== '--');
  switch (command) {
    case 'status': {
      const status = await printStatus({ json: argv.includes('--json') });
      process.exitCode = status.state === 'healthy' ? 0 : status.state === 'starting' ? 3 : 1;
      return;
    }
    case 'logs':
      await showLogs(argv);
      return;
    case 'restart':
      await restartService();
      return;
    case 'deploy':
      await deployService(argv);
      return;
    case 'doctor':
      await doctor();
      return;
    case 'capacity':
      await capacity(argv);
      return;
    case 'stop':
      await stopService();
      return;
    case 'start':
      await startService();
      return;
    case 'install':
      await installService();
      return;
    case 'uninstall':
      await uninstallService();
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(usage());
      return;
    default:
      throw new Error(`unknown command ${command}\n\n${usage()}`);
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`os-control: ${redactLogText(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
