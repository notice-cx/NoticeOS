#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.mjs';

const ACTIONS = ['status', 'start', 'stop', 'restart'];
const SERVICES = ['postgres', 'dolt', 'backup', 'noticeos'];
const HELP = 'Usage: stack-control.mjs status|start|stop|restart [--config /absolute/stack.json]';
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
export async function stackControl(action, input, { run = runCommand, out = process.stdout, env = process.env,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  if (!ACTIONS.includes(action)) refuse(HELP);
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
  const inventory = () => call(['ps','--all','--format','json'], 'Stack inspection', 20000).then(text => parseServices(text, selector.project));
  const original = await inventory();
  if (action === 'status') {
    for (const service of SERVICES.filter(name => original.has(name))) {
      const row = original.get(service); out.write(`${service}: ${row.state}${row.health ? ', ' + row.health : ''}\n`);
    }
    let running = null; let main = null;
    try {
      const inspected = await run('docker', ['--host',selector.dockerHost,'inspect','--format','{{json .Config.Labels}}',original.get('noticeos').id], { env: ownEnv, timeoutMs: 20000 });
      if (inspected.code !== 0) refuse('Application revision inspection failed.');
      const labels = JSON.parse(inspected.stdout);
      if (labels?.['com.docker.compose.project'] !== selector.project || labels?.['com.docker.compose.service'] !== 'noticeos') refuse('Application revision identity changed.');
      const revision = labels['org.opencontainers.image.revision'];
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision ?? '')) running = revision;
      const source = await run('git', ['rev-parse','--verify','main^{commit}'], { cwd: root, env: ownEnv, timeoutMs: 20000 });
      if (source.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.stdout.trim())) main = source.stdout.trim();
    } catch { refuse('Application revision inspection failed; raw output is withheld.'); }
    out.write(`app source: ${running ?? 'unknown (image predates revision labels)'}\n`);
    out.write(`main: ${main ?? 'unavailable'}\n`);
    out.write(`update: ${!running || !main ? 'unknown' : running === main ? 'current' : 'main differs; prepare stack:deploy'}\n`);
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
    await call(step, `Stack ${step[0]}`, 130000);
  }
  out.write(`Stack ${action} complete.\n`);
}
export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help','-h'].includes(argv[0])) { out.write(HELP + '\n'); return 0; }
  try {
    const action = argv[0]; const args = argv.slice(1).filter(word => word !== '--');
    if (!ACTIONS.includes(action) || (args.length && (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])))) refuse(HELP);
    const file = args[1] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local/stack.json');
    await stackControl(action, readSelector(file, options.io), { ...options, out }); return 0;
  } catch (error) { err.write(`${error.message}\n`); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
