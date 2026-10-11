#!/usr/bin/env node
// Run the installation's Docker Compose stack: status, logs, start, stop, restart, and one-off jobs in the app.
//
// The one-off jobs run inside the app container with the runner's own
// environment (deploy/compose/entrypoint.mjs): one backup, one schedule, the
// capacity report.
//
//   pnpm os:status      What runs, its health, the database's migrations, and whether main is ahead.
//   pnpm os:logs        Recent logs; `-- --follow`, `-- --lines N` or `-- <service>` narrow them.
//   pnpm os:start       Start the stack: databases, then backup, then the app, each healthy first.
//   pnpm os:stop        Stop the app, then backup, then the databases.
//   pnpm os:restart     Restart the stack in the same order, waiting for each layer's health.
//   pnpm os:backup      Run one backup now, inside the app container.
//   pnpm os:run-job -- "<cron>"  Fire the jobs scheduled on one cron expression now.
//   pnpm os:capacity    The store's size and growth per table; `-- --json` for the raw inventory.
//
// The stack is the one `.local/stack.json` (or --config) selects.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.mjs';
import { stackDatabaseCurrent } from './stack-database.mjs';

const ACTIONS = ['status', 'start', 'stop', 'restart', 'logs', 'backup', 'run-job', 'capacity'];
const SERVICES = ['postgres', 'dolt', 'backup', 'noticeos'];
/** How long a job run inside the app container may take. */
const JOB_TIMEOUT_MS = { backup: 3_600_000, 'run-job': 600_000, capacity: 180_000 };
const HELP = `Usage: stack-control.mjs status|start|stop|restart [--config /absolute/stack.json]
       stack-control.mjs logs [--follow] [--lines N] [postgres|dolt|backup|noticeos]
       stack-control.mjs backup | run-job "<cron>" | capacity [--json]`;
function refuse(message) { throw new Error(message); }
export function validateSelector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'dockerHost,envFile,files,project') refuse('Invalid stack selector fields.');
  if (typeof value.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value.project)) refuse('Invalid stack project.');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 8 ||
    value.files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n\0]/u.test(file)) ||
    new Set(value.files).size !== value.files.length) refuse('Compose files must be unique absolute paths.');
  if (typeof value.envFile !== 'string' || !path.isAbsolute(value.envFile) || /[\r\n\0]/u.test(value.envFile)) refuse('The environment file must be an absolute path.');
  let endpoint;
  try { endpoint = new URL(value.dockerHost); } catch { refuse('Docker must use an explicit local Unix socket.'); }
  if (endpoint.protocol !== 'unix:' || endpoint.host || endpoint.search || endpoint.hash ||
    !path.isAbsolute(endpoint.pathname) || endpoint.pathname === '/' || /[\r\n\0]/u.test(value.dockerHost)) refuse('Docker must use an explicit local Unix socket.');
  return { ...value, files: [...value.files] };
}
export function readSelector(file, io = fs) {
  try {
    const own = io.lstatSync(file);
    if (!own.isFile() || own.isSymbolicLink() || own.size > 16384) refuse('Invalid selector file.');
    const value = validateSelector(JSON.parse(io.readFileSync(file, 'utf8')));
    for (const input of [...value.files, value.envFile]) {
      const stat = io.lstatSync(input);
      if (!stat.isFile() || stat.isSymbolicLink()) refuse('Invalid stack input.');
    }
    return value;
  } catch { refuse('Stack selector or declared files are invalid or missing.'); }
}
export function parseServices(stdout, project) {
  if (typeof stdout !== 'string' || stdout.length > 262144) refuse('Stack inventory is invalid.');
  let rows;
  try {
    const raw = stdout.trim();
    rows = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch { refuse('Stack inventory is invalid.'); }
  if (!Array.isArray(rows) || rows.length < 3 || rows.length > 4) refuse('Stack must contain the declared existing services.');
  const seen = new Map();
  for (const row of rows) {
    if (!row || row.Project !== project || !SERVICES.includes(row.Service) || seen.has(row.Service) ||
      typeof row.ID !== 'string' || !/^[a-f0-9]{12,64}$/u.test(row.ID) || row.OneOff === true) refuse('Stack contains an unexpected or mismatched service.');
    seen.set(row.Service, { id: row.ID, state: ['running','exited','created','restarting','paused','dead','removing'].includes(row.State) ? row.State : 'unknown',
      health: ['healthy','unhealthy','starting'].includes(row.Health) ? row.Health : null });
  }
  for (const service of ['noticeos', 'postgres', 'dolt']) if (!seen.has(service)) refuse('Stack is missing a required existing service.');
  return seen;
}
/**
 * Which of `names` did not become healthy, what each is doing, and where to
 * look. When the app is one, the database's migration state is named too: an
 * app whose database lacks this code's migrations refuses to start.
 */
export async function notHealthy(names, inventory, database) {
  let rows = null;
  try { rows = await inventory(); } catch { /* the sentence below still names the step */ }
  const failed = names.filter(name => !rows || rows.get(name)?.health !== 'healthy');
  const shown = (failed.length ? failed : names).map(name => {
    const row = rows?.get(name);
    return row ? `${name} (${row.state}${row.health ? ', ' + row.health : ''})` : name;
  });
  const lines = [`${shown.join(', ')} did not become healthy; nothing after it was started. pnpm os:logs -- ${(failed[0] ?? names[0])} shows why.`];
  if ((failed.length ? failed : names).includes('noticeos')) {
    const current = await database().catch(() => null);
    if (current && !current.ok) lines.push(`The database: ${current.line}`);
  }
  return lines.join('\n');
}

/** The action's own arguments, checked before Docker is asked anything. */
export function actionArgs(action, args) {
  if (action === 'logs') {
    const parsed = { follow: false, lines: 200, service: null };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['--follow', '-f'].includes(arg) && !parsed.follow) parsed.follow = true;
      else if (arg === '--lines' && /^[1-9][0-9]{0,4}$/u.test(args[i + 1] ?? '')) parsed.lines = Number(args[++i]);
      else if (SERVICES.includes(arg) && parsed.service === null) parsed.service = arg;
      else refuse(HELP);
    }
    return parsed;
  }
  if (action === 'run-job') {
    if (args.length !== 1 || !/^[0-9*/,\- ]{9,64}$/u.test(args[0])) refuse('Name one cron expression: pnpm os:run-job -- "0 6 * * *"');
    return { job: ['run-job', args[0]] };
  }
  if (action === 'capacity') {
    if (args.length > 1 || args.length === 1 && args[0] !== '--json') refuse(HELP);
    return { job: ['capacity', ...args] };
  }
  if (args.length) refuse(HELP);
  return action === 'backup' ? { job: ['backup'] } : {};
}

export async function stackControl(action, input, { run = runCommand, out = process.stdout, env = process.env, args = [],
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), database = stackDatabaseCurrent } = {}) {
  if (!ACTIONS.includes(action)) refuse(HELP);
  const own = actionArgs(action, args);
  const selector = validateSelector(input);
  const prefix = ['--host', selector.dockerHost, 'compose', '--project-name', selector.project,
    ...selector.files.flatMap(file => ['-f', file]), '--env-file', selector.envFile];
  const ownEnv = Object.fromEntries(['PATH','HOME','DOCKER_CONFIG','XDG_CONFIG_HOME'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const call = async (args, label, timeoutMs) => {
    let result;
    try { result = await run('docker', [...prefix, ...args], { env: ownEnv, timeoutMs }); }
    catch { refuse(`${label} did not complete; stack state may have changed.`); }
    if (result.code !== 0) refuse(`${label} failed; no later stack steps ran.`);
    return result.stdout;
  };
  // Logs and jobs write straight to this terminal; nothing is collected here.
  const attached = async (args, label, timeoutMs) => {
    let result;
    try { result = await run('docker', [...prefix, ...args], { env: ownEnv, timeoutMs, inherit: true }); }
    catch { refuse(`${label} did not complete.`); }
    if (result.code !== 0) refuse(`${label} failed (exit ${result.code}).`);
  };
  const inventory = () => call(['ps','--all','--format','json'], 'Stack inspection', 20000).then(text => parseServices(text, selector.project));
  const original = await inventory();
  if (action === 'logs') {
    await attached(['logs', '--tail', String(own.lines), ...(own.follow ? ['--follow'] : []), ...(own.service ? [own.service] : [])], 'Reading the logs', own.follow ? Infinity : 60000);
    return;
  }
  if (own.job) {
    const app = original.get('noticeos');
    if (app.state !== 'running') refuse('The app is not running; start it first: pnpm os:start');
    await attached(['exec', '-T', 'noticeos', 'node', 'deploy/compose/entrypoint.mjs', ...own.job], `The ${action} job`, JOB_TIMEOUT_MS[action]);
    return;
  }
  if (action === 'status') {
    for (const service of SERVICES.filter(name => original.has(name))) {
      const row = original.get(service); out.write(`${service}: ${row.state}${row.health ? ', ' + row.health : ''}\n`);
    }
    const current = await database(selector, { root });
    out.write(`database: ${current.ok ? 'has every migration in this checkout' : current.line}\n`);
    let running = null; let main = null;
    try {
      const inspected = await run('docker', ['--host',selector.dockerHost,'inspect','--format','{{json .Config.Labels}}',original.get('noticeos').id], { env: ownEnv, timeoutMs: 20000 });
      if (inspected.code !== 0) refuse('Application revision inspection failed.');
      const labels = JSON.parse(inspected.stdout);
      if (labels?.['com.docker.compose.project'] !== selector.project || labels?.['com.docker.compose.service'] !== 'noticeos') refuse('Application revision identity changed.');
      const development = labels['cx.noticeos.runtime'] === 'development';
      const revision = labels['org.opencontainers.image.revision'];
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision ?? '')) running = revision;
      if (development) {
        if (labels['cx.noticeos.checkout'] !== root) refuse('Run status from the development checkout.');
        const head = await run('git', ['rev-parse','--verify','HEAD^{commit}'], { cwd:root,env:ownEnv,timeoutMs:20000 });
        const commit = head.stdout?.trim();
        if (head.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) refuse('Development source inspection failed.');
        out.write(`mode: development (mounted checkout)\napp source: ${commit}\nupdate: live source; pnpm os:prod returns to the image\n`);
        return;
      }
      const source = await run('git', ['rev-parse','--verify','main^{commit}'], { cwd: root, env: ownEnv, timeoutMs: 20000 });
      if (source.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.stdout.trim())) main = source.stdout.trim();
    } catch { refuse('Application revision inspection failed; raw output is withheld.'); }
    out.write(`app source: ${running ?? 'unknown (image predates revision labels)'}\n`);
    out.write(`main: ${main ?? 'unavailable'}\n`);
    out.write(`update: ${!running || !main ? 'unknown' : running === main ? 'current' : 'main differs; pnpm os:update moves the app to it'}\n`);
    return;
  }
  const backup = original.has('backup') ? ['backup'] : [];
  const wait = services => ['start','--wait','--wait-timeout','90',...services];
  const steps = action === 'stop' ? [['stop','noticeos'], ...(backup.length ? [['stop',...backup]] : []), ['stop','postgres','dolt']] :
    action === 'start' ? [wait(['postgres','dolt']), ...(backup.length ? [wait(backup)] : []), wait(['noticeos'])] :
    [['stop','noticeos',...backup], ['restart','--no-deps','postgres','dolt'], wait(['postgres','dolt']),
      ...(backup.length ? [['restart','--no-deps',...backup],wait(backup)] : []), ['restart','--no-deps','noticeos'],wait(['noticeos'])];
  for (const step of steps) {
    const current = await inventory();
    if (current.size !== original.size || [...original].some(([service, row]) => current.get(service)?.id !== row.id)) refuse('Stack containers changed; no next step ran.');
    const names = step.filter(word => SERVICES.includes(word));
    out.write(`${step[0]} ${names.join(', ')}\n`);
    try {
      await call(step, `Stack ${step[0]}`, 130000);
    } catch (error) {
      if (!step.includes('--wait')) throw error;
      refuse(await notHealthy(names, inventory, () => database(selector, { root })));
    }
  }
  out.write(`Stack ${action} complete.\n`);
}
export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help','-h'].includes(argv[0])) { out.write(HELP + '\n'); return 0; }
  try {
    const action = argv[0]; const args = argv.slice(1).filter(word => word !== '--');
    if (!ACTIONS.includes(action)) refuse(HELP);
    const at = args.indexOf('--config');
    if (at !== -1 && !path.isAbsolute(args[at + 1] ?? '')) refuse(HELP);
    const file = at === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local/stack.json') : args[at + 1];
    const own = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
    actionArgs(action, own);
    await stackControl(action, readSelector(file, options.io), { ...options, out, args: own }); return 0;
  } catch (error) { err.write(`${error.message}\n`); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
