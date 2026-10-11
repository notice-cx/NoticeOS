#!/usr/bin/env node
// One local synthetic replay attempt; no scheduler, restart adoption or repairs.
import * as fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { invokedDirectly } from './invoked-directly.mjs';
import { verifyDemoRelease } from './demo-release.mjs';
import { readDemoViewerInstallation } from './demo-viewer-installation.mjs';
import { demoInspectionEnvironment, verifyDemoResources, verifyDemoStore, verifyDemoClient, prepareDemoViewerRuntime, serveDemoViewer } from './demo-viewer.mjs';
import { DemoVisits, DEMO_LAUNCH_MAX_MS, DEMO_GENERATION_MAX_MS, DEMO_CLEANUP_MAX_MS } from './demo-visit.mjs';
import { createDemoGateway } from './demo-replay-gateway.mjs';
import { runCommand } from './run-command.mjs';
import { findPsql, MINIMUM_MAJOR } from './postgres-tools.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RESERVED = new Set([3306, 3307, 3308, 4747, 5173, 5432, 8791]);
const SELECTORS = ['DATABASE_URL', 'NOTICEOS_HOME', 'OS_UP_HOME', 'NOTICEOS_INSTALLATION_DIR', 'NOTICEOS_DOLT_HOME', 'NOTICEOS_WORKER_CONFIG_ROOT', 'NOTICEOS_DEMO_VIEWER_FILE', 'NOTICEOS_POSTGRES_SECRETS', 'NOTICEOS_POSTGRES_PORT'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (folder, name, value) => {
  const fd = fs.openSync(path.join(folder, name), 'wx', 0o600);
  const identity = fs.fstatSync(fd);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(folder, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  return Object.freeze({ dev: identity.dev, ino: identity.ino });
};
function absent(folder, root) {
  if (!path.isAbsolute(folder) || fs.existsSync(folder)) throw new Error('Name a new canonical private folder.');
  const parent = path.dirname(folder);
  if (fs.realpathSync(parent) !== parent || !fs.lstatSync(parent).isDirectory()) throw new Error('Name a canonical parent folder.');
  for (const relative of ['installation', '.beads', '.local']) {
    const inside = path.relative(path.join(root, relative), folder);
    if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) throw new Error('The replay refuses installation-owned folders.');
  }
}
export function parseDemoReplayArgs(argv) {
  const values = {};
  const flags = ['current-dir', 'next-dir', 'control-dir', 'port', 'current-port', 'next-port', 'seed-port', 'seed', 'cutoff', 'release', 'bd-bin', 'duration-ms'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !flags.includes(key) || Object.hasOwn(values, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Name each replay input once.');
    values[key] = argv[++i];
  }
  const options = { currentHome: values['current-dir'], nextHome: values['next-dir'], control: values['control-dir'], port: Number(values.port),
    currentPort: Number(values['current-port']), nextPort: Number(values['next-port']), seedPort: Number(values['seed-port']),
    seed: values.seed, cutoff: values.cutoff, release: values.release, binary: values['bd-bin'], durationMs: Number(values['duration-ms'] ?? DEMO_LAUNCH_MAX_MS) };
  if (![options.currentHome, options.nextHome, options.control, options.binary].every(value => typeof value === 'string' && path.isAbsolute(value))
    || new Set([options.currentHome, options.nextHome, options.control]).size !== 3 || !/^[a-f0-9]{40}$/u.test(options.release ?? '')
    || typeof options.seed !== 'string' || options.seed.length > 128 || !options.seed.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.cutoff ?? '')
    || !Number.isFinite(Date.parse(options.cutoff)) || !Number.isInteger(options.durationMs) || options.durationMs < 1000 || options.durationMs > DEMO_LAUNCH_MAX_MS) throw new Error('Name exact local replay inputs.');
  const ports = [options.port, options.currentPort, options.currentPort + 1, options.nextPort, options.nextPort + 1, options.seedPort, options.seedPort + 1, options.seedPort + 2, options.seedPort + 3];
  if (new Set(ports).size !== ports.length || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65534 || RESERVED.has(port))) throw new Error('Name distinct unused loopback ports.');
  return Object.freeze(options);
}
function inspection(installation, env) {
  return { ...demoInspectionEnvironment(env), NOTICEOS_POSTGRES_SECRETS: path.join(installation.home, 'postgres/secrets'), NOTICEOS_POSTGRES_PORT: String(installation.postgresPort),
    NOTICEOS_DOLT_SECRETS: installation.dolt.secretsDir, NOTICEOS_DOLT_PORT: String(installation.dolt.port) };
}
export async function qualifyDemoGeneration(home, options, { root, env }) {
  const source = await verifyDemoRelease(root, options.release);
  const installation = readDemoViewerInstallation({ root, home, ...source });
  const occupied = [options.port, options.currentPort, options.currentPort + 1, options.nextPort, options.nextPort + 1];
  if (occupied.includes(installation.postgresPort) || occupied.includes(installation.dolt.port)) throw new Error('Replay ports overlap database services.');
  const resources = await verifyDemoResources(installation, { root, env: inspection(installation, env) });
  await verifyDemoClient(installation, options.binary, { env: { PATH: '/usr/bin:/bin', HOME: path.join(home, 'dolt/client-home'), XDG_CONFIG_HOME: path.join(home, 'dolt/client-home/.config'), BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1' } });
  await verifyDemoStore(installation);
  if ((await verifyDemoRelease(root, options.release)).tree !== source.tree) throw new Error('The replay source changed.');
  const completion = fs.readFileSync(path.join(home, 'demo-generation.json'));
  return Object.freeze({ id: hash(completion), installation, resources, source, completedAt: installation.viewer.generatedAt });
}
// Inspecting a complete generation remains separate from generation authority.
function probe(port, expected, deadline) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/demo-viewer', timeout: Math.max(1, Math.min(1000, deadline - Date.now())) }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', part => { body += part; if (body.length > 65536) request.destroy(); });
      response.on('end', () => {
        try { if (response.statusCode !== 200 || !isDeepStrictEqual(JSON.parse(body), expected)) throw new Error(); resolve(); } catch { reject(new Error('The owned reader descriptor differs.')); }
      });
    });
    request.on('timeout', () => request.destroy()); request.on('error', reject);
  });
}
export async function startDemoReader(generation, port, durationMs, { root, binary }) {
  const prepared = prepareDemoViewerRuntime(generation.installation, { root, port, binary });
  let handle;
  const done = serveDemoViewer({ root, prepared, port, durationMs, base: `/generation/${generation.id}/`, out: { write() {} }, onStarted: value => { handle = value; } });
  const deadline = Date.now() + Math.min(30_000, durationMs);
  try {
    for (;;) {
      try { await Promise.race([probe(port, generation.installation.viewer, deadline), done.then(() => { throw new Error('The owned reader exited.'); })]); break; }
      catch { if (!handle || Date.now() >= deadline) throw new Error('The owned reader did not become ready.'); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  } catch (error) { handle?.stop(); await done; throw error; }
  return Object.freeze({ port, base: `/generation/${generation.id}/`, done, stop: async () => { handle.stop(); await done; } });
}
export function generateNextDemo(options, { root, env, maxMs, spawnChild = spawn, killGroup = (pid, signal) => process.kill(-pid, signal), timer = setTimeout, clearTimer = clearTimeout }) {
  let stop, pid;
  const done = new Promise(resolve => {
    const child = spawnChild(process.execPath, [path.join(root, 'scripts/demo-seed.mjs'), '--dir', options.nextHome, '--port', String(options.seedPort), '--seed', options.seed,
      '--cutoff', options.cutoff, '--release', options.release, '--confirm-synthetic'], { cwd: root, env, detached: true, stdio: 'ignore' });
    pid = child.pid;
    let timedOut = false, killTimer, completed = false;
    stop = () => {
      if (completed || timedOut) return; timedOut = true;
      try { killGroup(child.pid, 'SIGTERM'); } catch {}
      killTimer = timer(() => { if (!completed) { try { killGroup(child.pid, 'SIGKILL'); } catch {} } }, 3000);
    };
    const deadlineTimer = timer(stop, maxMs);
    const ended = code => { if (completed) return; completed = true; if (timedOut) { try { killGroup(child.pid, 'SIGKILL'); } catch {} } clearTimer(deadlineTimer); clearTimer(killTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve({ code, timedOut }); };
    child.once('error', () => ended(1)); child.once('close', code => ended(code));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
  return Object.freeze({ done, stop: () => stop?.(), pid });
}
export async function retireDemoGeneration(generation, { root, env, verify = verifyDemoResources, run = runCommand }) {
  const deadline = performance.now() + DEMO_CLEANUP_MAX_MS;
  const before = await verify(generation.installation, { root, env: inspection(generation.installation, env),
    run: (command, args, options) => run(command, args, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, deadline - performance.now())) }) });
  if (!isDeepStrictEqual([...before.containers].sort(), [...generation.resources.containers].sort())) throw new Error('Retirement resource identity changed.');
  for (const compose of [path.join(root, 'db/postgres/host/compose.yaml'), generation.installation.dolt.composeFile]) {
    const result = await run('docker', ['compose', '-p', before.project, '-f', compose, '--env-file', '/dev/null', 'down', '--volumes'],
      { cwd: root, env: inspection(generation.installation, env), timeoutMs: Math.max(1, deadline - performance.now()) });
    if (result.code !== 0 || result.timedOut || result.error) throw new Error('Retirement stopped; preserve custody for recovery.');
  }
  // Exit zero is not proof of absence. Every query is restricted to this exact
  // owned project or its declared resource names; no host inventory is read.
  for (const args of [
    ['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${before.project}`, '--format', '{{.ID}}'],
    ['network', 'ls', '--filter', `label=com.docker.compose.project=${before.project}`, '--format', '{{.Name}}'],
    ['network', 'ls', '--filter', `name=${before.project}_default`, '--format', '{{.Name}}'],
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${before.project}`, '--format', '{{.Name}}'],
    ['volume', 'ls', '--filter', `name=${before.project}_postgres-data`, '--format', '{{.Name}}'],
    ['volume', 'ls', '--filter', `name=${before.project}_dolt-data`, '--format', '{{.Name}}'],
  ]) {
    if (performance.now() >= deadline) throw new Error('Retirement exceeded its bound.');
    const result = await run('docker', args, { cwd: root, env: inspection(generation.installation, env), timeoutMs: Math.max(1, deadline - performance.now()) });
    if (result.code !== 0 || result.timedOut || result.error || typeof result.stdout !== 'string' || result.stdout.trim() !== '') throw new Error('Retirement absence is unproven; preserve custody.');
  }
}
function publish(control, before, after, identity) {
  const file = path.join(control, 'current.json'), pending = path.join(control, 'next-current.json');
  const expected = JSON.stringify(before, null, 2) + '\n';
  const unchanged = () => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('Publication custody changed.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== identity.dev || opened.ino !== identity.ino || fs.readFileSync(fd, 'utf8') !== expected) throw new Error('Publication custody changed.');
    } finally { fs.closeSync(fd); }
  };
  unchanged(); if (fs.existsSync(pending)) throw new Error('Publication custody changed.');
  write(control, 'publication-intent.json', { version: 1, before, after }); write(control, 'next-current.json', after);
  unchanged();
  fs.renameSync(pending, file); const fd = fs.openSync(control, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** One attempt, two readers at most and a fixed lifetime. Internal adapters let
 * tests exercise interruption without generating or touching any installation. */
export async function launchDemoReplay(options, { root = ROOT, env = process.env, out = process.stdout, qualify = qualifyDemoGeneration, generate = generateNextDemo,
  startReader = startDemoReader, retire = retireDemoGeneration, clientTools = findPsql, now: givenNow, schedule = (ms, work) => { const timer = setTimeout(work, ms); return () => clearTimeout(timer); } } = {}) {
  if (SELECTORS.some(key => env[key] !== undefined)) throw new Error('Replay refuses inherited installation selectors.');
  // Resolve the same client used by fresh setup before acquiring a reader or
  // creating candidate custody. Carry only its directory, not the caller PATH.
  const client = clientTools();
  if (!client || !path.isAbsolute(client.psql ?? '') || !Number.isInteger(client.major) || client.major < MINIMUM_MAJOR) throw new Error('Replay needs a supported PostgreSQL client.');
  const clientDirectory = path.dirname(client.psql);
  absent(options.nextHome, root); absent(options.control, root);
  if ([options.currentHome, options.nextHome, options.control].some((folder, index, all) => all.some((other, otherIndex) => index !== otherIndex && path.relative(folder, other) !== '..' && other.startsWith(folder + path.sep)))) throw new Error('Replay folders must be separate.');
  const current = await qualify(options.currentHome, options, { root, env });
  if ([options.seedPort, options.seedPort + 1, options.seedPort + 2, options.seedPort + 3].some(port => [current.installation.postgresPort, current.installation.dolt.port].includes(port))) throw new Error('Replay generation ports overlap existing services.');
  fs.mkdirSync(options.control, { mode: 0o700 });
  for (const relative of ['client-home', 'client-home/.config', 'tmp']) fs.mkdirSync(path.join(options.control, relative), { recursive: true, mode: 0o700 });
  const startWall = Date.now(), startMono = performance.now();
  const now = givenNow ?? (() => startWall + performance.now() - startMono);
  const visits = new DemoVisits(current.id, now(), options.durationMs, () => randomBytes(16).toString('hex'));
  const context = { root, env, binary: options.binary };
  const first = await startReader(current, options.currentPort, Math.max(1, visits.deadline - now()), context);
  const backends = new Map([[current.id, first]]);
  const readers = new Set([first]);
  const gateway = createDemoGateway({ visits, backends, now });
  let stopped = false, resolveFinished, cancelRetirement, generationProcess, pendingReader;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const stop = async (code = 0) => {
    if (stopped) return finished; stopped = true; cancelEnd?.(); cancelRetirement?.();
    try { generationProcess?.stop(); } catch { code = 1; }
    const cleanup = [gateway.stop()];
    if (generationProcess) cleanup.push(generationProcess.done);
    if (pendingReader) cleanup.push(pendingReader.then(reader => reader.stop(), () => {}));
    cleanup.push(...[...readers].map(reader => reader.stop()));
    const outcomes = await Promise.allSettled(cleanup);
    if (outcomes.some(value => value.status === 'rejected')) code = 1;
    try { write(options.control, 'launcher-stopped.json', { version: 1, stoppedAt: new Date().toISOString(), current: visits.state().current, currentDatabaseRetained: true, completedArchivesRetained: true, code }); }
    catch { code = 1; }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); resolveFinished(Object.freeze({ code }));
  };
  const onSignal = () => { void stop(); };
  let cancelEnd;
  try { await new Promise((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(options.port, '127.0.0.1', resolve); }); }
  catch (error) { await stop(); throw error; }
  const original = { version: 1, generation: current.id, home: current.installation.home, completedAt: current.completedAt, release: options.release, tree: current.source.tree };
  let currentIdentity;
  try {
  currentIdentity = write(options.control, 'current.json', original);
  write(options.control, 'launcher.json', { version: 1, startedAt: startWall, deadline: visits.deadline, port: options.port, release: options.release, tree: current.source.tree });
  cancelEnd = schedule(Math.max(1, visits.deadline - now()), () => { void stop(); });
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  out.write(`Synthetic replay: http://127.0.0.1:${options.port}/\n`);
  } catch (error) { await stop(1); throw error; }
  gateway.server.on('error', () => { void stop(1); });
  first.done.then(() => { if (!stopped && backends.has(current.id)) void stop(1); });
  const attempt = (async () => {
    let second, cancelAttempt;
    const attemptDeadline = Math.min(visits.deadline, now() + DEMO_GENERATION_MAX_MS);
    let attemptExpired = false;
    const available = () => { if (stopped || attemptExpired || now() >= attemptDeadline) throw new Error('The single generation attempt ended.'); };
    try {
      available();
      cancelAttempt = schedule(Math.max(1, attemptDeadline - now()), () => { attemptExpired = true; generationProcess?.stop(); });
      write(options.control, 'generation-attempt.json', { version: 1, home: options.nextHome, startedAt: new Date().toISOString(), current: current.id, maxMs: DEMO_GENERATION_MAX_MS, deadline: attemptDeadline, release: options.release, tree: current.source.tree });
      const seedEnv = { ...demoInspectionEnvironment(env), HOME: path.join(options.control, 'client-home'), XDG_CONFIG_HOME: path.join(options.control, 'client-home/.config'), TMPDIR: path.join(options.control, 'tmp'),
        PATH: `${path.dirname(process.execPath)}:${clientDirectory}:/Applications/OrbStack.app/Contents/MacOS/xbin:/usr/local/bin:/usr/bin:/bin`, BEADS_BD_BIN: options.binary, CI: '1', WRANGLER_SEND_METRICS: 'false' };
      generationProcess = generate(options, { root, env: seedEnv, maxMs: Math.max(1, attemptDeadline - now()) });
      write(options.control, 'generation-process.json', { version: 1, pid: generationProcess.pid ?? null, ownGroup: true });
      const result = await generationProcess.done; generationProcess = null;
      available();
      if (result.code !== 0 || result.timedOut) throw new Error('The single generation attempt stopped.');
      const next = await qualify(options.nextHome, options, context); available();
      if (next.id === current.id || next.source.tree !== current.source.tree || next.installation.postgresProject === current.installation.postgresProject
        || next.installation.postgresPort !== options.seedPort + 2 || next.installation.dolt.port !== options.seedPort + 3 || stopped) throw new Error('The candidate is not a separate complete generation.');
      pendingReader = startReader(next, options.nextPort, Math.max(1, visits.deadline - now()), context);
      second = await pendingReader; pendingReader = null; readers.add(second); available();
      second.done.then(() => { if (!stopped && backends.has(next.id)) void stop(1); });
      available();
      const after = { ...original, generation: next.id, home: next.installation.home, completedAt: next.completedAt };
      publish(options.control, original, after, currentIdentity); backends.set(next.id, second); visits.publish(next.id, now());
      write(options.control, 'publication-complete.json', { version: 1, generation: next.id, previous: current.id, retireAt: visits.state().previous.retireAt });
      cancelRetirement = schedule(Math.max(1, visits.state().previous.retireAt - now()), async () => {
        if (stopped) return;
        try {
          visits.retired(current.id, now()); gateway.retire(current.id); backends.delete(current.id); await first.stop(); readers.delete(first);
          await retire(current, context); write(options.control, 'previous-retired.json', { version: 1, generation: current.id, archivesRetained: true });
        } catch {
          try { write(options.control, 'retirement-refused.json', { version: 1, generation: current.id, custodyRetained: true }); } catch {}
          await stop(1);
        }
      });
      cancelAttempt?.();
      return Object.freeze({ published: true, generation: next.id });
    } catch {
      cancelAttempt?.();
      if (second) { await second.stop(); readers.delete(second); }
      if (fs.existsSync(path.join(options.control, 'publication-intent.json'))) await stop(1);
      try { write(options.control, 'generation-refused.json', { version: 1, current: visits.state().current, candidateCustodyRetained: true, retry: false }); }
      catch { await stop(1); }
      return Object.freeze({ published: false, generation: current.id });
    }
  })();
  return Object.freeze({ visits, attempt, finished, stop, port: options.port });
}
export async function main(argv = process.argv.slice(2)) {
  try { const replay = await launchDemoReplay(parseDemoReplayArgs(argv)); return (await replay.finished).code; }
  catch { process.stderr.write('Demo replay refused. Preserve its folders for explicit recovery.\n'); return 1; }
}
if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
