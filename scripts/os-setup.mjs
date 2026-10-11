#!/usr/bin/env node
// Set up a new NoticeOS installation on this Docker host and start it.
//
//   pnpm os:setup                          ~/noticeos, the Tower on http://127.0.0.1:5173/
//   pnpm os:setup -- --dir <folder>        the installation somewhere else
//   pnpm os:setup -- --offsite <folder>    hand finished backups to a folder a sync client carries off the machine
//   pnpm os:setup -- --tower-port <n>      the Tower on another loopback port
//   pnpm os:setup -- --image <id>          use an image already built, instead of building main
//   pnpm os:setup -- --without-backup      no backup worker
//
// It needs Docker, Node and pnpm, nothing else: the steps that need psql and
// Beads run inside a one-off app container (scripts/os-setup-container.mjs).
// In order: it checks that the folder, the Compose project and its volumes
// are all new; builds main into the app image; writes the installation folder
// (scripts/installation-layout.mjs) with new secrets; starts Postgres and
// Dolt; applies the frozen schema and one workspace and makes the OS's task
// project; starts the app and the backup worker; loads the default settings;
// and writes `.local/stack.json`, after which every `pnpm os:*` command acts
// on it.
//
// This is the fresh-install exception (AGENTS.md): nothing here touches an
// existing installation, database or volume. A failed step stops, names
// what was made, and leaves it for inspection.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installationChoices, installationPaths, installationSelector, renderInstallationEnv, DEFAULTS } from './installation-layout.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { writeSecrets } from './postgres-secrets.mjs';
import { runCommand } from './run-command.mjs';
import { composePrefix } from './stack-database.mjs';
import { buildApplicationImage } from './stack-deploy.mjs';
import { frozenBaseline } from './start-postgres.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SELECTOR = path.join(ROOT, '.local', 'stack.json');
export const USAGE = `usage: pnpm os:setup [-- --dir <folder>] [--offsite <folder>] [--tower-port <n>]
                      [--project <name>] [--image <id>] [--without-backup] [--config <stack.json>]`;

class SetupRefused extends Error {}
const refuse = (line) => { throw new SetupRefused(line); };
const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'TMPDIR', 'LANG']
  .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      dir: { type: 'string' }, offsite: { type: 'string' }, 'tower-port': { type: 'string' }, project: { type: 'string' },
      image: { type: 'string' }, 'without-backup': { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const absolute = (value, name) => {
    if (value === undefined) return undefined;
    const resolved = path.resolve(value.replace(/^~(?=$|\/)/u, os.homedir()));
    if (name === '--config' && !path.isAbsolute(value)) refuse(`${name} names an absolute file.`);
    return resolved;
  };
  return {
    help: values.help === true,
    dir: absolute(values.dir) ?? path.join(os.homedir(), 'noticeos'),
    offsite: absolute(values.offsite) ?? null,
    towerPort: values['tower-port'] === undefined ? null : Number(values['tower-port']),
    project: values.project ?? DEFAULTS.project,
    image: values.image ?? null,
    backup: values['without-backup'] !== true,
    selectorFile: absolute(values.config, '--config') ?? DEFAULT_SELECTOR,
  };
}

/** Whether nothing on this machine listens on 127.0.0.1:`port`. */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** The first free port from `start`, or the chosen one if it is free. */
async function freePort(start, { chosen = false, free = portFree, taken = new Set() } = {}) {
  for (let port = start; port < start + 50 && port <= 65535; port++) {
    if (!taken.has(port) && await free(port)) return port;
    if (chosen) refuse(`port ${port} is in use; choose another.`);
  }
  refuse(`no free port near ${start}.`);
}

/** The folder must be new, or empty, and not inside this checkout. */
export function folderRefusal(dir, root = ROOT, io = fs) {
  const inside = path.relative(root, dir);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) return `${dir} is inside this checkout; choose a folder of its own with --dir.`;
  const stat = io.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return `${dir} is not a folder of its own.`;
  if (io.readdirSync(dir).length > 0) return `${dir} is not empty; setup makes a new installation in a new or empty folder.`;
  return null;
}

/** Write the installation folder: the layout, new secrets, the app's state and installation.env. */
export function writeInstallation(choices, { backup, offsite, root = ROOT, random = randomBytes } = {}) {
  const paths = installationPaths(choices.dir);
  const dir = (folder) => fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = (where, text) => fs.writeFileSync(where, text, { flag: 'wx', mode: 0o600 });
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  dir(choices.dir);
  writeSecrets(paths.postgresSecrets, { port: choices.postgresPort });
  const internal = (name) => {
    const url = new URL(fs.readFileSync(path.join(paths.postgresSecrets, name), 'utf8').trim());
    url.hostname = 'postgres';
    url.port = '5432';
    return url.href;
  };
  dir(paths.doltSecrets);
  const taskPassword = random(32).toString('hex');
  file(path.join(paths.doltSecrets, 'root'), `${random(32).toString('hex')}\n`);
  file(path.join(paths.doltSecrets, 'noticeos'), `${taskPassword}\n`);
  for (const folder of ['installation', '.local', '.wrangler', 'workers/ingest', 'dolt/client-home']) dir(path.join(paths.state, folder));
  file(path.join(paths.state, 'workers', 'ingest', '.dev.secrets.json'), json({
    CREDENTIALS_KEY: random(32).toString('base64'),
    OPERATOR_TOKEN: random(32).toString('base64url'),
    DATABASE_URL: internal('database.url'),
  }));
  file(path.join(paths.state, 'task-client.json'), json({ host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: '/state/dolt/credentials', clientHome: '/state/dolt/client-home' }));
  file(path.join(paths.state, 'dolt', 'credentials'), `[dolt:3306]\npassword=${taskPassword}\n`);
  dir(choices.spokes ?? paths.spokes);
  if (backup) {
    for (const folder of [paths.backupProfile, paths.backupStaging, paths.backupTransport, choices.backupAssets ?? paths.backupAssets]) dir(folder);
    if (!offsite) dir(paths.backupOffsite);
    file(path.join(paths.backupProfile, 'profile.json'), json({ format: 'noticeos-backup-worker-v1', retentionDays: 30 }));
    file(path.join(paths.state, 'backup-client.json'), json({ format: 'noticeos-backup-client-v1', transportDir: '/backup-transport' }));
    if (offsite) {
      const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config', 'host-backup.json'), 'utf8'));
      file(path.join(paths.backupProfile, 'host-backup.json'), json({ ...defaults, offsiteBackupDir: '/backup-offsite/backups' }));
    }
  }
  file(paths.env, renderInstallationEnv(choices));
  return { paths, ownerUrl: internal('owner.url') };
}

/** Set up a new installation; returns the exit code. */
export async function setup(options, { run = runCommand, env = process.env, out = process.stdout, root = ROOT,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), build = buildApplicationImage, free = portFree, endpoint = localDockerEndpoint, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000 } = {}) {
  const say = (line) => out.write(`${line}\n`);
  const tools = ownEnv(env);
  const docker = async (args, what, { timeoutMs = 60_000, stdin = null, inherit = false } = {}) => {
    const result = await run('docker', args, { env: tools, timeoutMs, stdin, inherit, cwd: root });
    if (result.code !== 0) refuse(`${what} failed${inherit ? '; Docker\'s output above says why' : ''}.`);
    return result.stdout ?? '';
  };

  // Everything is checked before anything is made.
  if (fs.existsSync(options.selectorFile)) refuse(`${options.selectorFile} already selects an installation; pnpm os:status shows it, and pnpm os:convert-legacy moves a legacy one into the layout.`);
  const folder = folderRefusal(options.dir, root);
  if (folder) refuse(folder);
  if (options.offsite && !fs.lstatSync(options.offsite, { throwIfNoEntry: false })?.isDirectory()) refuse(`the offsite folder ${options.offsite} does not exist; a missing sync folder is never made locally.`);
  if (frozenBaseline(root) === null) refuse('this checkout\'s Postgres baseline is not fully frozen; set up from main.');
  const dockerHost = await endpoint(run, { env: tools, cwd: root });
  if (!dockerHost?.startsWith('unix://')) refuse('setup needs a local Docker engine on a Unix socket; start Docker (or select its local context) and try again.');
  const host = ['--host', dockerHost];
  const arch = (await docker([...host, 'version', '--format', '{{.Server.Arch}}'], 'Asking Docker for its platform')).trim();
  if (!['amd64', 'arm64'].includes(arch)) refuse(`Docker runs on ${arch || 'an unknown platform'}; NoticeOS images are built for amd64 and arm64.`);
  const owned = (await docker([...host, 'ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${options.project}`], 'Listing the project\'s containers')).trim();
  if (owned) refuse(`Docker already has containers for the project ${options.project}; choose another with --project, or pnpm os:convert-legacy moves that installation.`);
  const draft = { project: options.project, dir: options.dir };
  const names = { postgresVolume: `${draft.project}_postgres-data`, doltVolume: `${draft.project}_dolt-data`, network: `${draft.project}_installation` };
  for (const [kind, name] of [['volume', names.postgresVolume], ['volume', names.doltVolume], ['network', names.network]]) {
    const found = await run('docker', [...host, kind, 'inspect', name], { env: tools, timeoutMs: 20_000 });
    if (found.code === 0) refuse(`the ${kind} ${name} already exists; setup never takes over existing data. Choose another --project.`);
  }
  const taken = new Set();
  const pick = async (start, chosen) => { const port = await freePort(start, { chosen, free, taken }); taken.add(port); return port; };
  const ports = {
    towerPort: await pick(options.towerPort ?? DEFAULTS.towerPort, options.towerPort !== null),
    postgresPort: await pick(DEFAULTS.postgresPort, false),
    doltPort: await pick(DEFAULTS.doltPort, false),
  };

  let image = options.image;
  if (image) {
    await docker([...host, 'image', 'inspect', image], `Finding the image ${image}`);
  } else {
    say('Building main into the app image; this takes a few minutes.');
    image = (await build({ root, dockerHost, platform: `linux/${arch}`, run, env, out })).image;
  }
  const choices = installationChoices({ ...draft, image, uid, gid, ...ports, ...names, backupOffsite: options.offsite });
  const selector = installationSelector({ dir: choices.dir, project: choices.project, dockerHost, backup: options.backup, root });
  const compose = (args) => [...composePrefix(selector), ...args];

  const made = [];
  try {
    say(`Writing the installation to ${choices.dir}.`);
    made.push(`the folder ${choices.dir}`);
    const { ownerUrl } = writeInstallation(choices, { backup: options.backup, offsite: options.offsite, root });
    for (const volume of [choices.postgresVolume, choices.doltVolume]) {
      await docker([...host, 'volume', 'create', '--label', `cx.noticeos.installation=${choices.dir}`, volume], `Creating the volume ${volume}`);
      made.push(`the volume ${volume}`);
    }
    say('Starting Postgres and the task server.');
    made.push(`the Compose project ${choices.project}`);
    await docker(compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'postgres', 'dolt']), 'Starting Postgres and the task server', { timeoutMs: 240_000 });
    say('Applying the frozen schema, the workspace and the task project.');
    const prepared = await run('docker', compose(['run', '--rm', '--no-deps', '-T', 'noticeos', 'setup']), { env: tools, timeoutMs: 300_000, stdin: `${ownerUrl}\n` });
    if (prepared.code !== 0) refuse(String(prepared.stderr ?? '').split('\n').find((line) => line.startsWith('setup refused:') || line.startsWith('NoticeOS container refused:')) ?? 'the database and task setup did not finish.');
    say('Starting the app and loading the default settings.');
    await docker(compose(['up', '--detach']), 'Starting the app', { timeoutMs: 120_000 });
    // The app reports healthy only once its schedules, which are settings, are armed.
    let seeded = null;
    for (const deadline = Date.now() + 300_000; Date.now() < deadline;) {
      seeded = await run('docker', compose(['exec', '-T', 'noticeos', 'node', 'deploy/compose/entrypoint.mjs', 'seed-settings']), { env: tools, timeoutMs: 60_000, cwd: root });
      if (seeded.code === 0) break;
      await pause(3000);
    }
    if (seeded?.code !== 0) refuse('the default settings could not be loaded; pnpm os:logs -- noticeos shows why.');
    await docker(compose(['up', '--detach', '--wait', '--wait-timeout', '300']), 'Waiting for the app to become healthy', { timeoutMs: 360_000, inherit: true });
    fs.mkdirSync(path.dirname(options.selectorFile), { recursive: true });
    fs.writeFileSync(options.selectorFile, `${JSON.stringify(selector, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (made.length) error.message += `\nMade so far, left for inspection: ${made.join(', ')}.`;
    throw error;
  }
  say(`NoticeOS is running: http://127.0.0.1:${choices.towerPort}/`);
  say(`Its installation is ${choices.dir}; pnpm os:status shows it.`);
  return 0;
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  try {
    const parsed = parseOptions(argv);
    if (parsed.help) { out.write(`${USAGE}\n`); return 0; }
    return await setup(parsed, { out, ...options });
  } catch (error) {
    err.write(`pnpm os:setup: ${error instanceof SetupRefused ? error.message : error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
