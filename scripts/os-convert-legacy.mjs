#!/usr/bin/env node
// Convert a legacy installation, one that runs from Compose files of its own, into the installation folder layout, after you confirm the plan.
//
//   pnpm os:convert-legacy                       the plan for the stack .local/stack.json selects, into ~/noticeos
//   pnpm os:convert-legacy -- --dir <folder>     into another new folder
//   pnpm os:convert-legacy -- --undo             back to the stack as it was before the conversion
//
// It reads the stack as Compose resolves it today and plans the same stack
// from deploy/compose/stack.yaml and a new installation folder
// (scripts/installation-layout.mjs): the same project, images, ports, data
// volumes, secrets and mounted folders. The plan names every difference that
// remains: a file from this checkout that differs from the one mounted now, a
// mount the layout has no place for, a changed port binding. Nothing changes
// until you type `convert` (or pass `--confirm convert` without a terminal).
//
// Then it stops the stack, copies the installation's own folders (its state,
// both secrets folders, the backup worker's declaration) into the new folder,
// checks every copied secret, starts the stack from the new folder and only
// then points .local/stack.json at it. Folders the operator keeps elsewhere
// (task repositories, exporter checkouts, the offsite folder) stay where they
// are unless they live inside the checkout the old stack's files came from.
// The old files are never changed or removed; a failed start returns the old
// stack, and `--undo` does the same later. No migration is ever applied.
//
// An app that runs this checkout's live source (pnpm os:dev) is planned from
// the prepared stack os:dev recorded; the conversion returns it to that image
// first (os:prod's own step), and follows the checkout again from the new
// folder last (os:dev's).

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installationChoices, installationPaths, installationSelector, renderInstallationEnv } from './installation-layout.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { runCommand } from './run-command.mjs';
import { parseServices, readSelector, validateSelector } from './stack-control.mjs';
import { composePrefix } from './stack-database.mjs';
import { folderRefusal } from './os-setup.mjs';
import { developStack } from './stack-development.mjs';
import { recordApplied } from './stack-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SELECTOR = path.join(ROOT, '.local', 'stack.json');
/** Where the selector the conversion replaced is kept, beside the selector. */
export const BEFORE = '.before-convert.json';
export const USAGE = `usage: pnpm os:convert-legacy [-- --dir <folder>] [--confirm convert] [--config <stack.json>]
       pnpm os:convert-legacy -- --undo [--config <stack.json>]`;

class ConvertRefused extends Error {}
const refuse = (line) => { throw new ConvertRefused(line); };
const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'TMPDIR', 'LANG']
  .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

/** Each mount of a resolved service, by its target. */
const mountsOf = (service) => new Map((service?.volumes ?? []).map((mount) => [mount.target, mount]));

/** Where each folder the layout owns is mounted, in a resolved stack. */
const OWN_FOLDERS = [
  ['noticeos', '/state', 'state'],
  ['backup', '/run/backup-worker', 'backupProfile'],
];
const KEPT_FOLDERS = [
  ['noticeos', '/spokes', 'spokes'],
  ['backup', '/backup-assets', 'backupAssets'],
  ['backup', '/backup-offsite', 'backupOffsite'],
];
/** The volume that only carries Postgres's socket to the backup worker. */
const SOCKET_VOLUME = 'pg-backup-socket';
/** Working folders the layout makes new, empty. */
const NEW_FOLDERS = [
  ['backup', '/backup-staging', 'backupStaging'],
  ['backup', '/backup-transport', 'backupTransport'],
];

/**
 * What the stack resolved as `model` has, in the terms of the layout: its
 * choices and the folders to copy, keep or make. `legacyRoot` is the checkout
 * the old declaration came from: a kept folder inside it is copied instead.
 */
export function readInstallation(model, { project, imageId, legacyRoot }) {
  const services = model?.services ?? {};
  for (const name of ['noticeos', 'postgres', 'dolt']) if (!services[name]) refuse(`the stack has no ${name} service.`);
  const unknown = Object.keys(services).filter((name) => !['noticeos', 'postgres', 'dolt', 'backup'].includes(name));
  if (unknown.length) refuse(`the stack has services the layout does not: ${unknown.join(', ')}.`);
  if (services.noticeos.environment?.NOTICEOS_CONTAINER_MODE === 'development') refuse('the app runs from live source that pnpm os:dev does not own; pnpm os:prod first, then convert.');
  const backup = Boolean(services.backup);
  const bind = (service, target) => {
    const mount = mountsOf(services[service]).get(target);
    if (!mount || mount.type !== 'bind' || !path.isAbsolute(mount.source)) refuse(`${service} has no folder mounted at ${target}.`);
    return mount.source;
  };
  const volume = (service, target) => {
    const mount = mountsOf(services[service]).get(target);
    const name = mount?.type === 'volume' ? model.volumes?.[mount.source]?.name ?? mount.source : null;
    if (!name) refuse(`${service} keeps no data volume at ${target}.`);
    return name;
  };
  const secretsDir = (secret) => {
    const file = model.secrets?.[secret]?.file;
    if (typeof file !== 'string' || !path.isAbsolute(file)) refuse(`the stack declares no ${secret} secret file.`);
    return path.dirname(file);
  };
  const port = (service, target) => {
    const row = (services[service].ports ?? []).find((item) => Number(item.target) === target);
    if (!row?.published) refuse(`${service} publishes no port for ${target}.`);
    return { port: Number(row.published), hostIp: row.host_ip ?? null };
  };
  const [uid, gid] = String(services.noticeos.user ?? '1000:1000').split(':').map(Number);
  const tower = port('noticeos', 5173);
  const copies = [
    { what: 'state', from: bind('noticeos', '/state'), key: 'state' },
    { what: 'Postgres secrets', from: secretsDir('noticeos_owner'), key: 'postgresSecrets' },
    { what: 'task server secrets', from: secretsDir('dolt_root'), key: 'doltSecrets' },
    ...(backup ? [{ what: 'backup worker declaration', from: bind('backup', '/run/backup-worker'), key: 'backupProfile' }] : []),
  ];
  const fresh = backup ? NEW_FOLDERS.map(([service, target, key]) => ({ what: target.slice(1), from: bind(service, target), key })) : [];
  const kept = {};
  for (const [service, target, key] of KEPT_FOLDERS) {
    if (service === 'backup' && !backup) continue;
    const from = bind(service, target);
    if (legacyRoot && inside(from, legacyRoot)) copies.push({ what: target.slice(1), from, key });
    else kept[key] = from;
  }
  return {
    project,
    backup,
    imageId,
    uid, gid,
    towerPort: tower.port,
    towerHostIp: tower.hostIp,
    allowedHosts: services.noticeos.environment?.TOWER_ALLOWED_HOSTS ?? '',
    postgresPort: port('postgres', 5432).port,
    doltPort: port('dolt', 3306).port,
    postgresVolume: volume('postgres', '/var/lib/postgresql'),
    doltVolume: volume('dolt', '/var/lib/dolt'),
    copies,
    fresh,
    kept,
  };
}

/** The choices for installation.env, for the installation read from the old stack into `dir`. */
export function convertedChoices(found, dir) {
  return installationChoices({
    dir, project: found.project, image: found.imageId, uid: found.uid, gid: found.gid,
    // A published port with no address listens on every interface.
    towerBind: found.towerHostIp === null ? '0.0.0.0' : /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(found.towerHostIp) ? found.towerHostIp : undefined,
    towerPort: found.towerPort, allowedHosts: found.allowedHosts, postgresPort: found.postgresPort, doltPort: found.doltPort,
    postgresVolume: found.postgresVolume, doltVolume: found.doltVolume,
    spokes: found.kept.spokes ?? null, backupAssets: found.kept.backupAssets ?? null, backupOffsite: found.kept.backupOffsite ?? null,
  });
}

/**
 * Every difference between the stack as it runs (`before`) and as it will run
 * from the layout (`after`), once the copies are in place: `moved` counts what
 * only changes folder, `changes` lists the rest in one line each. A file is
 * compared by its content (`hash`).
 */
export function compareStacks(before, after, { copies, fresh = [], dir, hash = sha }) {
  const destination = (source) => {
    for (const copy of [...copies, ...fresh]) {
      if (inside(source, copy.from)) return path.join(installationPaths(dir)[copy.key], path.relative(copy.from, source));
    }
    return source;
  };
  const changes = [];
  let moved = 0;
  const names = new Set([...Object.keys(before.services ?? {}), ...Object.keys(after.services ?? {})]);
  for (const name of [...names].sort()) {
    const old = before.services?.[name];
    const next = after.services?.[name];
    if (!old || !next) { changes.push(`${name}: ${old ? 'not in the new stack' : 'added'}`); continue; }
    for (const key of ['image', 'user', 'command', 'entrypoint', 'healthcheck', 'environment', 'read_only', 'cap_add', 'cap_drop', 'security_opt', 'tmpfs', 'shm_size', 'stop_grace_period', 'init', 'restart']) {
      if (key === 'image') continue;
      // The host's facts the layout tells the app (compose.yaml) describe it; they change nothing it does.
      const own = (service) => key === 'environment' && service.environment
        ? Object.fromEntries(Object.entries(service.environment).filter(([variable]) => !variable.startsWith('NOTICEOS_HOST_'))) : service[key];
      if (json(own(old) ?? null) !== json(own(next) ?? null)) changes.push(`${name}: ${key} changes`);
    }
    const ports = (service) => json((service.ports ?? []).map((row) => [row.host_ip ?? '0.0.0.0', String(row.published), Number(row.target)]).sort());
    if (ports(old) !== ports(next)) changes.push(`${name}: published ports change`);
    const oldMounts = mountsOf(old);
    const newMounts = mountsOf(next);
    for (const target of [...new Set([...oldMounts.keys(), ...newMounts.keys()])].sort()) {
      const a = oldMounts.get(target);
      const b = newMounts.get(target);
      if (!b) { changes.push(`${name}: ${target} is no longer mounted (it was ${a.source})`); continue; }
      if (!a) { changes.push(`${name}: ${target} is newly mounted from ${b.source}`); continue; }
      if (a.type !== b.type || Boolean(a.read_only) !== Boolean(b.read_only)) { changes.push(`${name}: ${target} changes how it is mounted`); continue; }
      if (a.type === 'volume') {
        const volumeName = (model, mount) => model.volumes?.[mount.source]?.name ?? mount.source;
        if (volumeName(before, a) === volumeName(after, b)) continue;
        // The backup socket's volume holds only a socket; a new one is made at start.
        if (a.source === SOCKET_VOLUME && b.source === SOCKET_VOLUME) { moved += 1; continue; }
        changes.push(`${name}: ${target} uses the volume ${volumeName(after, b)} instead of ${volumeName(before, a)}`);
        continue;
      }
      if (a.type !== 'bind') continue;
      if (destination(a.source) === b.source) { if (a.source !== b.source) moved += 1; continue; }
      let hashes = null;
      try { hashes = [hash(a.source), hash(b.source)]; } catch { /* a folder, or one that is gone */ }
      if (hashes && hashes[0] === hashes[1]) continue;
      changes.push(hashes ? `${name}: ${target} comes from ${b.source}, which differs from ${a.source}` : `${name}: ${target} comes from ${b.source} instead of ${a.source}`);
    }
  }
  for (const secret of [...new Set([...Object.keys(before.secrets ?? {}), ...Object.keys(after.secrets ?? {})])].sort()) {
    const a = before.secrets?.[secret]?.file;
    const b = after.secrets?.[secret]?.file;
    if (!a || !b) changes.push(`secret ${secret}: ${a ? 'not in the new stack' : 'added'}`);
    else if (destination(a) !== b) changes.push(`secret ${secret}: comes from ${b} instead of ${a}`);
  }
  return { moved, changes };
}

/**
 * Copy one folder exactly: every folder's and file's mode and times, links as
 * links. fs.cpSync gives new folders the process's default mode, which would
 * open the private ones.
 */
export function copyTree(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { mode: 0o700 });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  } else {
    refuse(`${from} is neither a file, a folder nor a link; nothing was started.`);
  }
  fs.chmodSync(to, stat.mode & 0o7777);
  fs.utimesSync(to, stat.atime, stat.mtime);
}

/** The size of everything under `dir`, in bytes. */
function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.lstatSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

const ask = async (question) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
};

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { dir: { type: 'string' }, confirm: { type: 'string' }, undo: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.config !== undefined && !path.isAbsolute(values.config)) refuse('--config names an absolute file.');
  if (values.undo && (values.dir || values.confirm)) refuse(USAGE);
  return {
    help: values.help === true,
    undo: values.undo === true,
    dir: path.resolve((values.dir ?? path.join(os.homedir(), 'noticeos')).replace(/^~(?=$|\/)/u, os.homedir())),
    confirm: values.confirm ?? null,
    selectorFile: values.config ?? DEFAULT_SELECTOR,
  };
}

export async function convertLegacy(options, { run = runCommand, env = process.env, out = process.stdout, root = ROOT,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), question = ask, develop = developStack } = {}) {
  const say = (line) => out.write(`${line}\n`);
  const tools = ownEnv(env);
  const docker = async (args, what, { timeoutMs = 60_000, inherit = false } = {}) => {
    let result;
    try { result = await run('docker', args, { env: tools, timeoutMs, inherit, cwd: root }); } catch { result = { code: 1 }; }
    if (result.code !== 0) refuse(`${what} failed${inherit ? '; Docker\'s output above says why' : ''}.`);
    return result.stdout ?? '';
  };
  const resolved = async (selector) => JSON.parse(await docker([...composePrefix(selector), 'config', '--format', 'json'], 'Reading the stack\'s declaration'));
  const beforeFile = options.selectorFile.replace(/\.json$/u, '') + BEFORE;

  if (options.undo) {
    if (!fs.existsSync(beforeFile)) refuse(`there is no conversion to undo (${beforeFile} is missing).`);
    const converted = readSelector(options.selectorFile);
    const previous = readSelector(beforeFile);
    say(`Stopping ${converted.project} as the layout runs it.`);
    await docker([...composePrefix(converted), 'stop'], 'Stopping the stack', { timeoutMs: 180_000 });
    say('Starting the stack from its old declaration.');
    await docker([...composePrefix(previous), 'up', '--detach', '--wait', '--wait-timeout', '300'], 'Starting the old stack', { timeoutMs: 360_000, inherit: true });
    fs.copyFileSync(beforeFile, options.selectorFile);
    fs.rmSync(beforeFile);
    say(`The stack runs from its old declaration again; ${converted.envFile.replace(/\/[^/]+$/u, '')} was left as it is. pnpm os:dev follows the checkout again if you worked that way.`);
    return 0;
  }

  const old = readSelector(options.selectorFile);
  const ownFiles = installationSelector({ dir: '/', project: old.project, dockerHost: old.dockerHost, root }).files;
  if (old.files.some((file) => ownFiles.includes(file))) refuse('the stack already runs from the layout; nothing to convert.');
  const folder = folderRefusal(options.dir, root);
  if (folder) refuse(folder);
  if (fs.existsSync(beforeFile)) refuse(`${beforeFile} exists from an earlier conversion; pnpm os:convert-legacy -- --undo returns to it, or remove it.`);
  // In development, the plan starts from the prepared stack os:dev recorded.
  const developmentDir = path.join(path.dirname(options.selectorFile), 'stack-development');
  const developmentOverride = path.join(developmentDir, 'source.json');
  const live = old.files.includes(developmentOverride);
  let declared = old;
  let preparedImage = null;
  if (live) {
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(path.join(developmentDir, 'previous.json'), 'utf8')); } catch { /* refused below */ }
    if (prior?.schema !== 'noticeos-stack-development/1' || prior.selectorFile !== options.selectorFile || !/^sha256:[a-f0-9]{64}$/u.test(prior.image ?? '')) {
      refuse('the app runs from live source and the record of its prepared image is missing; pnpm os:prod first, then convert.');
    }
    declared = validateSelector(prior.selector);
    if (json(declared.files) !== json(old.files.filter((file) => file !== developmentOverride)) || declared.envFile !== old.envFile || declared.project !== old.project) {
      refuse('the stack changed since pnpm os:dev recorded it; pnpm os:prod first, then convert.');
    }
    preparedImage = prior.image;
  }
  // A stack that is not healthy now could never prove the move; it is fixed
  // first. A development app may be broken: the prepared image is what moves.
  const running = parseServices(await docker([...composePrefix(old), 'ps', '--all', '--format', 'json'], 'Listing the stack\'s services'), old.project);
  const unwell = [...running].filter(([name, row]) => row.health !== 'healthy' && !(live && name === 'noticeos'))
    .map(([name, row]) => `${name} (${row.state}${row.health ? `, ${row.health}` : ''})`);
  if (unwell.length) refuse(`${unwell.join(', ')} ${unwell.length === 1 ? 'is' : 'are'} not healthy; a conversion moves a healthy stack. pnpm os:status and pnpm os:logs show why.`);
  const before = await resolved(declared);
  const imageRef = preparedImage ?? before.services?.noticeos?.image;
  if (typeof imageRef !== 'string') refuse('the app declares no image.');
  const imageId = (await docker(['--host', old.dockerHost, 'image', 'inspect', '--format', '{{.Id}}', imageRef], `Finding the app image ${imageRef}`)).trim();
  const top = await run('git', ['-C', path.dirname(declared.files[0]), 'rev-parse', '--show-toplevel'], { env: tools, timeoutMs: 20_000 });
  const legacyRoot = top.code === 0 && top.stdout.trim() && path.resolve(top.stdout.trim()) !== root ? path.resolve(top.stdout.trim()) : path.dirname(declared.files[0]);
  const found = readInstallation(before, { project: old.project, imageId, legacyRoot });
  const choices = convertedChoices(found, options.dir);
  const selector = validateSelector(installationSelector({ dir: options.dir, project: old.project, dockerHost: old.dockerHost, backup: found.backup, root }));

  // The new declaration, rendered from an environment file outside the new folder.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-convert-'));
  let after;
  try {
    const draft = path.join(scratch, 'installation.env');
    fs.writeFileSync(draft, renderInstallationEnv(choices), { mode: 0o600 });
    after = await resolved({ ...selector, envFile: draft });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  for (const [kind, name] of [['volume', choices.postgresVolume], ['volume', choices.doltVolume]]) {
    if ((await run('docker', ['--host', old.dockerHost, kind, 'inspect', name], { env: tools, timeoutMs: 20_000 })).code !== 0) refuse(`the ${kind} ${name} the stack uses does not exist.`);
  }
  const network = after.networks?.installation?.name;
  const existing = await run('docker', ['--host', old.dockerHost, 'network', 'inspect', '--format', '{{json .Labels}}', network], { env: tools, timeoutMs: 20_000 });
  if (existing.code === 0) {
    const labels = JSON.parse(existing.stdout || 'null') ?? {};
    if (labels['com.docker.compose.project'] !== old.project || labels['com.docker.compose.network'] !== 'installation') refuse(`a network named ${network} exists that this stack did not create; remove it or choose another project.`);
  }
  const { moved, changes } = compareStacks(before, after, { copies: found.copies, fresh: found.fresh, dir: options.dir });
  const bytes = found.copies.reduce((sum, copy) => sum + folderSize(copy.from), 0);
  const free = (() => { let at = options.dir; while (!fs.existsSync(at)) at = path.dirname(at); const stats = fs.statfsSync(at); return stats.bavail * stats.bsize; })();
  if (bytes + 1024 ** 3 > free) refuse(`copying needs ${Math.ceil(bytes / 1024 ** 2)} MB and 1 GB to spare; ${Math.floor(free / 1024 ** 2)} MB are free.`);

  say(`Converting ${old.project} into ${options.dir}. Nothing has changed yet.`);
  if (live) say('The app runs this checkout\'s live source: it returns to its prepared image for the move, then follows the checkout again from the new folder.');
  say('Copied into the folder:');
  for (const copy of found.copies) say(`  ${copy.what}: ${copy.from}`);
  const keptRows = Object.entries(found.kept);
  if (keptRows.length) {
    say('Kept where they are:');
    for (const [key, from] of keptRows) say(`  ${key}: ${from}`);
  }
  say(`Data volumes stay: ${choices.postgresVolume}, ${choices.doltVolume}. Image stays: ${imageId.slice(0, 19)}.`);
  say(`${moved} mount${moved === 1 ? '' : 's'} only change folder.`);
  if (changes.length) {
    say('Also changes:');
    for (const line of changes) say(`  ${line}`);
  } else say('Nothing else changes.');
  say(`The stack stops while its folders are copied; ${declared.files.concat(declared.envFile).join(', ')} stay as they are.`);
  const confirmed = options.confirm ?? (interactive ? await question('Type convert to stop the stack, copy and start it from the new folder, or press Enter to stop: ') : null);
  if (confirmed !== 'convert') {
    say(interactive ? 'Nothing was changed.' : 'Nothing was changed. To convert it: pnpm os:convert-legacy -- --confirm convert');
    return 0;
  }

  if (live) {
    say('Returning the app to its prepared image.');
    await develop({ root, selectorFile: options.selectorFile, disable: true, run, env, out });
    const now = readSelector(options.selectorFile);
    if (json(now) !== json(declared) || json(await resolved(now)) !== json(before)) {
      refuse('the prepared stack is not the one this plan was made from; the app runs its prepared image now. Run pnpm os:convert-legacy again.');
    }
  }
  say('Stopping the stack.');
  await docker([...composePrefix(declared), 'stop'], 'Stopping the stack', { timeoutMs: 180_000 });
  let started = false;
  try {
    const paths = installationPaths(options.dir);
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    for (const copy of found.copies) {
      say(`Copying ${copy.what}.`);
      fs.mkdirSync(path.dirname(paths[copy.key]), { recursive: true, mode: 0o700 });
      copyTree(copy.from, paths[copy.key]);
    }
    if (found.backup) for (const [, , key] of NEW_FOLDERS) fs.mkdirSync(paths[key], { recursive: true, mode: 0o700 });
    for (const secret of Object.values(before.secrets ?? {})) {
      const target = found.copies.map((copy) => inside(secret.file, copy.from) ? path.join(paths[copy.key], path.relative(copy.from, secret.file)) : null).find(Boolean);
      if (!target || sha(target) !== sha(secret.file)) refuse(`the copy of ${secret.file} does not match it.`);
    }
    fs.writeFileSync(paths.env, renderInstallationEnv(choices), { flag: 'wx', mode: 0o600 });
    say('Starting the stack from the new folder.');
    started = true;
    await docker([...composePrefix(selector), 'up', '--detach', '--wait', '--wait-timeout', '300'], 'Starting the stack from the new folder', { timeoutMs: 360_000, inherit: true });
  } catch (error) {
    say('Returning to the stack as it was.');
    try {
      if (started) await docker([...composePrefix(selector), 'stop'], 'Stopping the new stack', { timeoutMs: 180_000 });
      await docker([...composePrefix(declared), 'up', '--detach', '--wait', '--wait-timeout', '300'], 'Starting the old stack', { timeoutMs: 360_000, inherit: true });
    } catch {
      error.message += ' The old stack did not come back either; pnpm os:status and pnpm os:logs show where it stands.';
      throw error;
    }
    error.message += ` The old stack runs again${live ? ' on its prepared image (pnpm os:dev follows the checkout again)' : ''}; ${options.dir} was left for inspection.`;
    throw error;
  }
  fs.copyFileSync(options.selectorFile, beforeFile);
  fs.writeFileSync(options.selectorFile, `${JSON.stringify(selector, null, 2)}\n`, { mode: 0o600 });
  recordApplied(options.selectorFile, selector);
  say(`Converted: the stack runs from ${options.dir}. pnpm os:status shows it; pnpm os:convert-legacy -- --undo returns to the old declaration.`);
  if (live) {
    say('Following this checkout again.');
    try {
      await develop({ root, selectorFile: options.selectorFile, run, env, out });
    } catch (error) {
      say(`The conversion stands, with the app on its prepared image: ${error?.message ?? error} pnpm os:dev tries again.`);
    }
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  try {
    const parsed = parseOptions(argv);
    if (parsed.help) { out.write(`${USAGE}\n`); return 0; }
    return await convertLegacy(parsed, { out, ...options });
  } catch (error) {
    err.write(`pnpm os:convert-legacy: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
