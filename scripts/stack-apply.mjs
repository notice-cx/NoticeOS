#!/usr/bin/env node
// Apply your edits to installation.env to the running stack, after you confirm the plan.
//
//   pnpm os:apply                        what changes and which services are recreated; type `apply` to do it
//   pnpm os:apply -- --confirm apply     the same, without a terminal
//
// Only the services whose declaration changed are recreated (scripts/stack-drift.mjs):
// the databases first, with the app and backup worker stopped while they
// return, then the backup worker, then the app, each waiting for health. A
// database is never pointed at other data, and the project's name never
// changes. The settings of each successful apply, setup or conversion are
// kept beside the selector (.local/stack-apply/applied.env); when a service
// does not become healthy, the stack returns to them. installation.env itself
// is never rewritten: your edit stays for you to fix. No image is built or
// pulled, and no migration is applied.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { doorIsHeld } from './ingest-door.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { runCommand } from './run-command.mjs';
import { readSelector, validateSelector } from './stack-control.mjs';
import { composePrefix } from './stack-database.mjs';
import { DeclarationUnreadable, serviceDrift } from './stack-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SELECTOR = path.join(ROOT, '.local', 'stack.json');
export const USAGE = 'usage: pnpm os:apply [-- --confirm apply] [--config <stack.json>]';
/** The order services return in: what the others depend on first. */
const LAYERS = [['postgres', 'dolt'], ['backup'], ['noticeos']];
/** Where each database keeps its data. */
const DATA = { postgres: '/var/lib/postgresql', dolt: '/var/lib/dolt' };

class ApplyRefused extends Error {}
const refuse = (line) => { throw new ApplyRefused(line); };
const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = (selectorFile) => path.join(path.dirname(selectorFile), 'stack-apply');

/**
 * Keep the selector's installation.env as the last settings the stack ran
 * healthy with. Called by setup, the conversion and every successful apply.
 */
export function recordApplied(selectorFile, selector) {
  const dir = records(selectorFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bytes = fs.readFileSync(selector.envFile);
  const file = path.join(dir, 'applied.env');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.writeFileSync(path.join(dir, 'applied.json'), `${JSON.stringify({ envFile: selector.envFile, sha256: sha(bytes) }, null, 2)}\n`, { mode: 0o600 });
}

/** The last applied settings for this selector's installation, or null when none are recorded for it. */
export function appliedEnv(selectorFile, selector) {
  try {
    const dir = records(selectorFile);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8'));
    const file = path.join(dir, 'applied.env');
    if (record.envFile !== selector.envFile || sha(fs.readFileSync(file)) !== record.sha256) return null;
    return file;
  } catch {
    return null;
  }
}

/** One line per difference a person set, between a running container (`docker inspect`) and its service as declared. */
export function describeChange(name, container, service, volumes = {}) {
  const lines = [];
  const declaredPorts = (service.ports ?? []).map((row) => `${row.host_ip ?? '0.0.0.0'}:${row.published}->${row.target}`).sort();
  const runningPorts = Object.entries(container.HostConfig?.PortBindings ?? {})
    .flatMap(([target, bindings]) => (bindings ?? []).map((binding) => `${binding.HostIp || '0.0.0.0'}:${binding.HostPort}->${Number.parseInt(target, 10)}`)).sort();
  if (declaredPorts.join() !== runningPorts.join()) lines.push(`${name}: port ${runningPorts.join(', ') || 'none'} becomes ${declaredPorts.join(', ') || 'none'}`);
  const env = Object.fromEntries((container.Config?.Env ?? []).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  for (const [key, value] of Object.entries(service.environment ?? {})) {
    if ((env[key] ?? null) !== (value ?? null)) lines.push(`${name}: ${key} ${JSON.stringify(env[key] ?? '')} becomes ${JSON.stringify(value ?? '')}`);
  }
  if (service.user !== undefined && (container.Config?.User ?? '') !== service.user) lines.push(`${name}: runs as ${service.user} instead of ${container.Config?.User || 'the image\'s user'}`);
  const mounts = new Map((container.Mounts ?? []).map((mount) => [mount.Destination, mount.Type === 'volume' ? mount.Name : mount.Source]));
  for (const mount of service.volumes ?? []) {
    const wanted = mount.type === 'volume' ? volumes[mount.source]?.name ?? mount.source : mount.source;
    const now = mounts.get(mount.target);
    if (mount.type !== 'tmpfs' && now !== wanted) lines.push(`${name}: ${mount.target} comes from ${wanted} instead of ${now ?? 'nothing'}`);
  }
  return lines;
}

const ask = async (question) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
};

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { confirm: { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.config !== undefined && !path.isAbsolute(values.config)) refuse('--config names an absolute file.');
  return { help: values.help === true, confirm: values.confirm ?? null, selectorFile: values.config ?? DEFAULT_SELECTOR };
}

export async function applyStack(options, { run = runCommand, env = process.env, out = process.stdout,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), question = ask, held = doorIsHeld } = {}) {
  const say = (line) => out.write(`${line}\n`);
  const tools = ownEnv(env);
  const docker = async (args, what, { timeoutMs = 60_000, inherit = false } = {}) => {
    let result;
    try { result = await run('docker', args, { env: tools, timeoutMs, inherit }); } catch { result = { code: 1 }; }
    if (result.code !== 0) refuse(`${what} failed${inherit ? '; Docker\'s output above says why' : ''}.`);
    return result.stdout ?? '';
  };
  const selector = readSelector(options.selectorFile);
  let drift;
  try { drift = await serviceDrift(selector, { run, env }); } catch (error) {
    if (error instanceof DeclarationUnreadable) refuse(error.message);
    throw error;
  }
  const baseline = appliedEnv(options.selectorFile, selector);
  if (drift.missing.length) refuse(`${drift.missing.join(', ')} ${drift.missing.length === 1 ? 'has' : 'have'} no container; apply changes running services only.`);
  if (drift.changed.length === 0) {
    recordApplied(options.selectorFile, selector);
    say('Nothing to apply: every service runs as installation.env declares it.');
    return 0;
  }

  const model = JSON.parse(await docker([...composePrefix(selector), 'config', '--format', 'json'], 'Reading the stack\'s declaration'));
  if (model.name !== selector.project) refuse(`installation.env names the project ${model.name}, but the stack is ${selector.project}; a project's name does not change.`);
  const lines = [];
  const ports = [];
  for (const name of drift.changed) {
    const [container] = JSON.parse(await docker(['--host', selector.dockerHost, 'inspect', drift.running.get(name).id], `Reading the ${name} container`));
    const service = model.services[name];
    if (DATA[name]) {
      const now = (container.Mounts ?? []).find((mount) => mount.Destination === DATA[name])?.Name;
      const mount = (service.volumes ?? []).find((row) => row.target === DATA[name]);
      const wanted = model.volumes?.[mount?.source]?.name ?? mount?.source;
      if (now !== wanted) refuse(`${name}'s data would come from ${wanted} instead of ${now}; apply never points a database at other data.`);
    }
    const own = describeChange(name, container, service, model.volumes);
    lines.push(...(own.length ? own : [`${name}: its declaration in this checkout changes`]));
    const published = new Set(Object.values(container.HostConfig?.PortBindings ?? {}).flat().map((binding) => Number(binding?.HostPort)));
    for (const row of service.ports ?? []) if (!published.has(Number(row.published))) ports.push(Number(row.published));
  }
  for (const port of ports) if (await held(`http://127.0.0.1:${port}`)) refuse(`port ${port} is in use; choose another in installation.env.`);

  const databases = drift.changed.some((name) => DATA[name]);
  const open = drift.changed.includes('noticeos') && (model.services.noticeos.ports ?? []).some((row) => (row.host_ip ?? '0.0.0.0') !== '127.0.0.1');
  say(`Applying installation.env to ${selector.project}. Nothing has changed yet.`);
  for (const line of lines) say(`  ${line}`);
  if (open) say('The Tower will answer other devices on your network. It has no login: anyone who reaches it can read and change your data.');
  say(`Recreated: ${drift.changed.join(', ')}${databases ? '; the app and backup worker stop while the databases return' : ''}.`);
  say(baseline ? 'If a service does not become healthy, the stack returns to the settings it last ran with.'
    : 'No earlier settings are recorded; if a service does not become healthy, undo your edit and run pnpm os:apply again.');
  const confirmed = options.confirm ?? (interactive ? await question('Type apply to recreate them, or press Enter to stop: ') : null);
  if (confirmed !== 'apply') {
    say(interactive ? 'Nothing was changed.' : 'Nothing was changed. To apply it: pnpm os:apply -- --confirm apply');
    return 0;
  }

  const lock = path.join(path.dirname(options.selectorFile), 'stack-deploy', 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); } catch { refuse('Another app operation holds the stack lock.'); }
  const present = (names) => names.filter((name) => drift.declared.has(name));
  const layers = LAYERS.map(present).filter((layer) => layer.length && (databases || layer.some((name) => drift.changed.includes(name))));
  const bring = (chosen, layer) => docker([...composePrefix(chosen), 'up', '--detach', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '180', ...layer],
    `Starting ${layer.join(', ')}`, { timeoutMs: 240_000, inherit: true });
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, operation: 'os:apply' }));
    if (databases) await docker([...composePrefix(selector), 'stop', ...present(['noticeos', 'backup'])], 'Stopping the app and backup worker', { timeoutMs: 180_000 });
    try {
      for (const layer of layers) {
        say(`Starting ${layer.join(', ')}.`);
        await bring(selector, layer);
      }
    } catch (error) {
      if (!baseline) {
        error.message += ' installation.env stays as you edited it; undo the edit and run pnpm os:apply again.';
        throw error;
      }
      say('Returning to the settings the stack last ran with.');
      const previous = validateSelector({ ...selector, envFile: baseline });
      try {
        for (const layer of LAYERS.map(present)) await bring(previous, layer);
      } catch {
        error.message += ' The earlier settings did not come back either; pnpm os:status and pnpm os:logs show where it stands.';
        throw error;
      }
      error.message += ' The stack runs with its earlier settings again; installation.env stays as you edited it.';
      throw error;
    }
    recordApplied(options.selectorFile, selector);
  } finally { fs.closeSync(handle); fs.rmSync(lock, { force: true }); }
  say(`Applied: ${drift.changed.join(', ')} ${drift.changed.length === 1 ? 'runs' : 'run'} as installation.env declares.`);
  return 0;
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  try {
    const parsed = parseOptions(argv);
    if (parsed.help) { out.write(`${USAGE}\n`); return 0; }
    return await applyStack(parsed, { out, ...options });
  } catch (error) {
    err.write(`pnpm os:apply: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
