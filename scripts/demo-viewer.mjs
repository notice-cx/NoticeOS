#!/usr/bin/env node
// Dedicated synthetic reader. This module never imports fresh setup or jobs.
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../packages/postgres/src/store.mjs';
import { PROFILE_SETTING, DEVELOPMENT } from './postgres-profile.mjs';
import { runCommand } from './run-command.mjs';
import { configDocumentKey } from './config-documents.mjs';
import { isDeepStrictEqual } from 'node:util';
import { readDemoViewerInstallation } from './demo-viewer-installation.mjs';
import { verifyDemoRelease } from './demo-release.mjs';
import { doltEnvironment } from './dolt-profile.mjs';
import { WORKER_CONFIGS, relocatedWorkerConfig } from './worker-config-folder.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { redactLogText } from './os-log.mjs';
import { PRODUCT_ENV } from './product-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED_PORTS = [3306, 3307, 3308, 4747, 5173, 5432, 8791];
const TARGET_ENV = [PRODUCT_ENV.home.name, PRODUCT_ENV.installationDir.name, 'NOTICEOS_DOLT_HOME', PRODUCT_ENV.workerConfigRoot.name,
  'NOTICEOS_DEMO_VIEWER_FILE', 'NOTICEOS_POSTGRES_SECRETS', 'NOTICEOS_POSTGRES_PORT', 'DATABASE_URL',
  PRODUCT_ENV.home.legacy, PRODUCT_ENV.installationDir.legacy, PRODUCT_ENV.workerConfigRoot.legacy];

const INSPECT = '{"id":{{json .Id}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"state":{{json .State}}}';
const refuse = () => { throw new Error('The demo resources differ from their declared local profile.'); };

/** Positively identify only the declared project's two existing services.
 * Resource inspection precedes application SQL and never creates or repairs. */
export async function verifyDemoResources(installation, { root, env, run = runCommand }) {
  const execute = async args => {
    const result = await run('docker', args, { cwd: root, env, timeoutMs: 10_000 });
    if (result.code !== 0 || result.timedOut || result.error || result.stdout.length > 2 * 1024 * 1024) refuse();
    return result.stdout;
  };
  const project = installation.postgresProject;
  const definitions = new Map();
  for (const [service, compose] of [['postgres', path.join(root, 'db/postgres/host/compose.yaml')], ['dolt', installation.dolt.composeFile]]) {
    const definition = JSON.parse(await execute(['compose', '-p', project, '-f', compose, '--env-file', '/dev/null', 'config', '--format', 'json']));
    if (definition.name !== project || Object.keys(definition.services ?? {}).join() !== service) refuse();
    definitions.set(service, definition);
  }
  const ids = (await execute(['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'])).trim().split(/\s+/u);
  if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !/^[a-f0-9]{64}$/u.test(id))) refuse();
  const seen = new Set();
  for (const id of ids) {
    const container = JSON.parse(await execute(['container', 'inspect', id, '--format', INSPECT]));
    const service = container.labels?.['com.docker.compose.service'];
    const definition = definitions.get(service), expected = definition?.services?.[service];
    if (!expected || seen.has(service) || container.id !== id || container.image !== expected.image
      || container.labels['com.docker.compose.project'] !== project || container.labels['com.docker.compose.oneoff'] !== 'False'
      || container.state?.Running !== true || container.state?.Health?.Status !== 'healthy') refuse();
    seen.add(service);
    const port = service === 'postgres' ? installation.postgresPort : installation.dolt.port;
    const target = service === 'postgres' ? '5432/tcp' : '3306/tcp';
    const ports = container.ports;
    if (!ports || typeof ports !== 'object' || Array.isArray(ports)) refuse();
    // Docker includes the image's unbound EXPOSE ports as null entries.
    // Only actual host bindings are listeners; every extra listener refuses.
    const published = Object.entries(ports).filter(([, bindings]) => {
      if (bindings === null) return false;
      if (!Array.isArray(bindings)) refuse();
      return bindings.length > 0;
    });
    if (published.length !== 1 || published[0][0] !== target || published[0][1].length !== 1
      || published[0][1][0].HostIp !== '127.0.0.1' || published[0][1][0].HostPort !== String(port)) refuse();
    const volumeKey = `${service}-data`, volumeName = `${project}_${volumeKey}`;
    if (definition.volumes?.[volumeKey]?.name !== volumeName) refuse();
    const volumes = container.mounts?.filter(mount => mount.Type === 'volume');
    if (volumes?.length !== 1 || volumes[0].Name !== volumeName || volumes[0].RW !== true
      || volumes[0].Destination !== (service === 'postgres' ? '/var/lib/postgresql' : '/var/lib/dolt')) refuse();
    const expectedBindings = (expected.volumes ?? []).filter(mount => mount.type === 'bind').map(mount => ({ source: mount.source, target: mount.target }));
    const secretsDir = service === 'postgres' ? path.join(installation.home, 'postgres/secrets') : installation.dolt.secretsDir;
    for (const secret of expected.secrets ?? []) {
      const source = definition.secrets?.[secret.source]?.file;
      if (typeof source !== 'string' || path.dirname(source) !== secretsDir || fs.realpathSync(source) !== source) refuse();
      const target = secret.target ?? secret.source;
      expectedBindings.push({ source, target: target.startsWith('/') ? target : `/run/secrets/${target}` });
    }
    const bindings = container.mounts.filter(mount => mount.Type === 'bind');
    if (container.mounts.length !== volumes.length + bindings.length || bindings.length !== expectedBindings.length
      || bindings.some(mount => mount.RW !== false || !expectedBindings.some(binding => binding.source === mount.Source && binding.target === mount.Destination))) refuse();
    const volume = JSON.parse(await execute(['volume', 'inspect', volumeName, '--format', '{{json .}}']));
    if (volume.Name !== volumeName || volume.Labels?.['com.docker.compose.project'] !== project || volume.Labels?.['com.docker.compose.volume'] !== volumeKey) refuse();
  }
  return Object.freeze({ project, services: Object.freeze([...seen].sort()), containers: Object.freeze(ids) });
}

/** The application role proves the same workspace and synthetic-only roster.
 * All reads share a read-only transaction; the short-lived pool always closes. */
export async function verifyDemoStore(installation, { open = openStore } = {}) {
  const store = open(fs.readFileSync(installation.databaseFile, 'utf8').trim());
  try {
    const workspace = await store.onlyWorkspace();
    if (workspace !== installation.viewer.workspaceId) throw new Error('The demo workspace differs from its completed generation.');
    await store.inWorkspace(workspace, async tx => {
      const identity = await tx.query(`SELECT current_setting($1, true) AS profile,
        (SELECT count(*)::text FROM noticeos.integration_connections) AS connections`, [PROFILE_SETTING]);
      const assets = await tx.query('SELECT asset_id FROM noticeos.assets ORDER BY asset_id');
      const beadsKey = configDocumentKey('config/beads.json'), integrationsKey = configDocumentKey('config/integrations.json');
      const displayKeys = Object.keys(installation.display).map(configDocumentKey);
      const documents = await tx.query('SELECT document_key, body FROM noticeos.config_documents WHERE document_key = ANY($1::text[]) ORDER BY document_key', [[beadsKey, integrationsKey, ...displayKeys]]);
      if (identity.length !== 1 || identity[0].profile !== DEVELOPMENT || identity[0].connections !== '0'
        || JSON.stringify(assets.map(row => row.asset_id)) !== JSON.stringify([...installation.assetIds].sort())
        || documents.length !== 2 + displayKeys.length) throw new Error('The demo store no longer matches its synthetic-only generation.');
      const beads = JSON.parse(documents.find(row => row.document_key === beadsKey)?.body ?? 'null');
      const integrations = JSON.parse(documents.find(row => row.document_key === integrationsKey)?.body ?? 'null');
      if (!isDeepStrictEqual(beads?.spokes, installation.projects.map(({ repo, ...project }) => project))
        || JSON.stringify(Object.keys(integrations?.assets ?? {}).sort()) !== JSON.stringify([...installation.assetIds].sort())
        || !isDeepStrictEqual(integrations?.assets, installation.integrations)) {
        throw new Error('The demo stored task or provider roster changed.');
      }
      for (const [file, body] of Object.entries(installation.display)) {
        const stored = JSON.parse(documents.find(row => row.document_key === configDocumentKey(file))?.body ?? 'null');
        if (!isDeepStrictEqual(stored, body)) throw new Error('The demo stored display settings changed.');
      }
    }, { readOnly: true });
  } finally { await store.close(); }
}

export function parseDemoViewerArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--dir', '--port', '--release', '--bd-bin', '--duration-ms'].includes(name) || Object.hasOwn(values, name)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Name the demo folder, release, local port and task executable.');
    values[name] = argv[++index];
  }
  const home = values['--dir'], port = Number(values['--port']), release = values['--release'], binary = values['--bd-bin'];
  const durationMs = Number(values['--duration-ms'] ?? 12 * 60 * 60 * 1000);
  if (!home || !path.isAbsolute(home) || !binary || !path.isAbsolute(binary) || !/^[a-f0-9]{40}$/u.test(release ?? '')
    || !Number.isInteger(port) || port < 1024 || port > 65534 || RESERVED_PORTS.some(reserved => reserved === port || reserved === port + 1)
    || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 12 * 60 * 60 * 1000) {
    throw new Error('Name an exact release, owned local paths and unused local ports.');
  }
  return { home, port, doorPort: port + 1, release, binary, durationMs };
}

/** No caller credentials, cloud switches, Node injection or database selectors
 * survive into the viewer process. The task CLI gets only its owned profile. */
export function demoViewerEnvironment(installation, { runtime, port, node = process.execPath }) {
  const env = doltEnvironment(installation.dolt, { PATH: `${path.join(runtime, 'bin')}:/usr/bin:/bin`, TMPDIR: path.join(runtime, 'tmp') });
  delete env.DOCKER_CONFIG;
  return { ...env, HOME: path.join(runtime, 'client-home'), XDG_CONFIG_HOME: path.join(runtime, 'client-home/.config'),
    NOTICEOS_HOME: installation.home, NOTICEOS_INSTALLATION_DIR: path.join(installation.home, 'installation'),
    NOTICEOS_DOLT_HOME: installation.home, NOTICEOS_WORKER_CONFIG_ROOT: runtime,
    NOTICEOS_DEMO_VIEWER_FILE: path.join(runtime, 'viewer.json'), NOTICEOS_VITE_CACHE_DIR: path.join(runtime, 'vite-cache'), OS_UP_PERSIST_STATE: path.join(runtime, 'state'),
    OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: String(port + 1),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES: fs.readFileSync(installation.databaseFile, 'utf8').trim(),
    WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', BROWSER: 'none', NODE: node };
}

function ownedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || (stat.mode & 0o077)) {
    throw new Error('The demo runtime needs its own private folder.');
  }
}
function bootstrap(installation) {
  const folder = path.join(installation.home, 'workers/ingest'); ownedDirectory(folder);
  const file = path.join(folder, '.dev.secrets.json');
  const database = fs.readFileSync(installation.databaseFile, 'utf8').trim();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ DATABASE_URL: database, OPERATOR_TOKEN: randomBytes(32).toString('base64url'),
      CREDENTIALS_KEY: randomBytes(32).toString('base64') }), { flag: 'wx', mode: 0o600 });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096 || fs.realpathSync(file) !== file) {
    throw new Error('The demo bootstrap custody is invalid.');
  }
  const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(secrets).sort().join() !== 'CREDENTIALS_KEY,DATABASE_URL,OPERATOR_TOKEN' || secrets.DATABASE_URL !== database
    || !/^[a-zA-Z0-9_-]{43}$/u.test(secrets.OPERATOR_TOKEN ?? '') || !/^[a-zA-Z0-9+/]{43}=$/u.test(secrets.CREDENTIALS_KEY ?? '')) {
    throw new Error('The demo bootstrap differs from its owned application profile.');
  }
  return secrets;
}

/** Only local configs and ephemeral viewer state are prepared. No scheduled
 * trigger, remote binding, task target creation or configuration apply occurs. */
export function prepareDemoViewerRuntime(installation, { root, port, binary, node = process.execPath }) {
  const viewers = path.join(installation.home, 'viewers'); ownedDirectory(viewers);
  const runtime = fs.mkdtempSync(path.join(viewers, 'viewer-'));
  const secrets = bootstrap(installation);
  for (const relative of WORKER_CONFIGS) {
    const source = path.join(root, relative), target = path.join(runtime, relative);
    const config = relocatedWorkerConfig(fs.readFileSync(source, 'utf8'), source);
    // Bindings use local development implementations. A future remote-only
    // binding must be reviewed instead of silently becoming a demo dependency.
    const rejectRemote = value => {
      if (!value || typeof value !== 'object') return;
      if (value.remote === true) throw new Error('The synthetic viewer refuses remote bindings.');
      for (const child of Object.values(value)) rejectRemote(child);
    };
    rejectRemote(config);
    config.triggers = { crons: [] }; delete config.env;
    ownedDirectory(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(path.dirname(target), '.dev.vars'), `OPERATOR_TOKEN=${secrets.OPERATOR_TOKEN}\nCREDENTIALS_KEY=${secrets.CREDENTIALS_KEY}\n`, { flag: 'wx', mode: 0o600 });
  }
  for (const directory of ['bin', 'tmp', 'client-home', 'client-home/.config', 'state', 'vite-cache']) ownedDirectory(path.join(runtime, directory));
  fs.symlinkSync(binary, path.join(runtime, 'bin/bd')); fs.symlinkSync(node, path.join(runtime, 'bin/node'));
  const env = demoViewerEnvironment(installation, { runtime, port, node });
  fs.writeFileSync(env.NOTICEOS_DEMO_VIEWER_FILE, JSON.stringify({ version: 1, root, home: installation.home, tree: installation.tree,
    viewer: installation.viewer, runtime, towerPort: port, doorPort: port + 1 }), { flag: 'wx', mode: 0o600 });
  return { runtime, env, secrets };
}

export async function verifyDemoClient(installation, binary, { env, run = runCommand }) {
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(binary) !== binary || stat.size > 256 * 1024 * 1024
    || !(stat.mode & 0o111) || createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== installation.client.sha256) {
    throw new Error('The task executable differs from the completed demo.');
  }
  const checked = await run(binary, ['--version'], { cwd: path.dirname(binary), env, timeoutMs: 5000 });
  if (checked.code !== 0 || checked.timedOut || checked.error
    || !checked.stdout.includes(`bd version ${installation.client.version} `)) throw new Error('The demo task executable version could not be verified.');
}

export function demoInspectionEnvironment(env) {
  if (env.DOCKER_HOST !== undefined && !/^unix:\/\/\//u.test(env.DOCKER_HOST)) throw new Error('The demo viewer requires a local container endpoint.');
  const selected = { PATH: '/Applications/OrbStack.app/Contents/MacOS/xbin:/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME, TMPDIR: env.TMPDIR, DOCKER_CONTEXT: 'default' };
  if (env.DOCKER_HOST !== undefined) { selected.DOCKER_HOST = env.DOCKER_HOST; delete selected.DOCKER_CONTEXT; }
  if (env.DOCKER_CONFIG !== undefined) selected.DOCKER_CONFIG = env.DOCKER_CONFIG;
  else if (env.HOME) selected.DOCKER_CONFIG = path.join(env.HOME, '.docker');
  return selected;
}

/** A single installed Vite child, one owned process group and bounded private
 * diagnostics. No runner/scheduler is created, and shutdown cannot discover PIDs. */
export function serveDemoViewer({ root, prepared, durationMs, port, out = process.stdout, spawnChild = spawn,
  base = null, onStarted = null }) {
  if (base !== null && !/^\/generation\/[a-f0-9]{64}\/$/u.test(base)) throw new Error('The demo reader base is invalid.');
  const logFile = path.join(prepared.runtime, 'viewer.log');
  fs.writeFileSync(logFile, '', { flag: 'wx', mode: 0o600 });
  const knownSecrets = Object.values(prepared.secrets);
  let bytes = 0;
  const log = line => {
    let safe = String(line);
    for (const secret of knownSecrets) safe = safe.split(secret).join('[REDACTED]');
    safe = `${redactLogText(safe).slice(0, 64 * 1024)}\n`;
    const count = Buffer.byteLength(safe);
    if (bytes + count > 1024 * 1024) { fs.renameSync(logFile, logFile + '.1'); fs.writeFileSync(logFile, '', { mode: 0o600 }); bytes = 0; }
    fs.appendFileSync(logFile, safe); bytes += count;
  };
  return new Promise(resolve => {
    let child, timer, forceTimer, stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    };
    const finish = code => {
      clearTimeout(timer); clearTimeout(forceTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      fs.writeFileSync(path.join(prepared.runtime, 'viewer-result.json'), JSON.stringify({ version: 1, synthetic: true,
        stoppedAt: new Date().toISOString(), stoppedByLauncher: stopping, code }), { flag: 'wx', mode: 0o600 });
      resolve(stopping ? 0 : code);
    };
    try {
      child = spawnChild(process.execPath, [path.join(root, 'apps/tower/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort',
        ...(base === null ? [] : ['--base', base])],
        { cwd: path.join(root, 'apps/tower'), env: prepared.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { finish(1); return; }
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''; stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) { log(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (pending.length > 64 * 1024) { pending = ''; log('[Oversized diagnostic omitted]'); }
      });
      stream.on('end', () => { if (pending) log(pending); });
    }
    child.on('error', () => log('The synthetic viewer process could not start.'));
    child.on('close', code => finish(Number.isInteger(code) ? code : 1));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    timer = setTimeout(stop, durationMs);
    onStarted?.(Object.freeze({ stop, pid: child.pid }));
    out.write(`Synthetic viewer: http://127.0.0.1:${port}/\n`);
  });
}

export async function main(argv = process.argv.slice(2), { root = ROOT, env = process.env, out = process.stdout, err = process.stderr,
  verifySource = verifyDemoRelease, readInstallation = readDemoViewerInstallation, verifyResources = verifyDemoResources,
  verifyStore = verifyDemoStore, verifyClient = verifyDemoClient, prepareRuntime = prepareDemoViewerRuntime, serve = serveDemoViewer } = {}) {
  let phase = 'arguments';
  try {
    const options = parseDemoViewerArgs(argv);
    if (TARGET_ENV.some(key => env[key] !== undefined)) throw new Error('The demo viewer refuses inherited installation selectors.');
    phase = 'source release'; const source = await verifySource(root, options.release);
    phase = 'completed generation';
    const installation = readInstallation({ root, home: options.home, ...source });
    if ([options.port, options.doorPort].some(port => port === installation.postgresPort || port === installation.dolt.port)) throw new Error('The viewer ports overlap its database services.');
    const inspection = { ...demoInspectionEnvironment(env), NOTICEOS_POSTGRES_SECRETS: path.join(installation.home, 'postgres/secrets'),
      NOTICEOS_POSTGRES_PORT: String(installation.postgresPort), NOTICEOS_DOLT_SECRETS: installation.dolt.secretsDir,
      NOTICEOS_DOLT_PORT: String(installation.dolt.port) };
    phase = 'local resources'; await verifyResources(installation, { root, env: inspection });
    phase = 'task executable';
    await verifyClient(installation, options.binary, { env: { PATH: '/usr/bin:/bin', HOME: path.join(installation.home, 'dolt/client-home'),
      XDG_CONFIG_HOME: path.join(installation.home, 'dolt/client-home/.config'), BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1' } });
    phase = 'synthetic store'; await verifyStore(installation);
    phase = 'source recheck'; const after = await verifySource(root, options.release);
    if (after.tree !== source.tree) throw new Error('The demo source changed during verification.');
    phase = 'runtime files'; const prepared = prepareRuntime(installation, { root, port: options.port, binary: options.binary });
    phase = 'viewer process';
    return await serve({ root, prepared, ...options, out });
  } catch {
    err.write(`The synthetic viewer could not verify its ${phase}.\n`);
    return 1;
  }
}
if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
