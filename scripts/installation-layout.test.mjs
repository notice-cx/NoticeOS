import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyStack, installationChoices, installationPaths, installationSelector, readInstallationEnv, renderInstallationEnv, stackFiles, STACK_EXECUTABLES, STACK_SOURCES } from './installation-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = `sha256:${'a'.repeat(64)}`;
const base = { dir: '/srv/one installation', image: IMAGE, uid: 501, gid: 20 };

function tempFile(t, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-layout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'installation.env');
  writeFileSync(file, text);
  return file;
}

test('installation.env holds the choices, and every other path follows from the folder', (t) => {
  const values = readInstallationEnv(tempFile(t, renderInstallationEnv(base)));
  const paths = installationPaths(base.dir);
  assert.equal(values.COMPOSE_PROJECT_NAME, 'noticeos');
  assert.equal(values.NOTICEOS_STATE_DIR, paths.state);
  assert.equal(values.NOTICEOS_SPOKES_DIR, paths.spokes);
  assert.equal(values.NOTICEOS_POSTGRES_SECRETS, paths.postgresSecrets);
  assert.equal(values.NOTICEOS_DOLT_SECRETS, paths.doltSecrets);
  assert.equal(values.NOTICEOS_BACKUP_OFFSITE_PARENT, paths.backupOffsite);
  assert.equal(values.NOTICEOS_POSTGRES_VOLUME, 'noticeos_postgres-data');
  assert.equal(values.NOTICEOS_DOLT_BACKUP_VOLUME, values.NOTICEOS_DOLT_VOLUME);
  assert.equal(values.NOTICEOS_NETWORK, 'noticeos_installation');
  // A folder an installation keeps elsewhere is its own line.
  const kept = readInstallationEnv(tempFile(t, renderInstallationEnv({ ...base, spokes: '/home/me/tasks', backupOffsite: '/mnt/sync' })));
  assert.equal(kept.NOTICEOS_SPOKES_DIR, '/home/me/tasks');
  assert.equal(kept.NOTICEOS_BACKUP_OFFSITE_PARENT, '/mnt/sync');
  assert.equal(kept.NOTICEOS_STATE_DIR, paths.state);
});

test('a choice Compose would read differently is refused before anything is written', () => {
  for (const dir of ['relative/dir', '/has "quote"', '/has $HOME', '/back\\slash', '/line\nbreak', '/trailing/']) {
    assert.throws(() => installationChoices({ ...base, dir }), /absolute folder path/u, dir);
  }
  assert.throws(() => installationChoices({ ...base, project: 'Upper' }), /project name/u);
  assert.equal(installationChoices({ ...base, towerBind: '0.0.0.0' }).towerBind, '0.0.0.0');
  for (const towerBind of ['localhost', '::', '999.1.1.1', '0.0.0.0; rm']) assert.throws(() => installationChoices({ ...base, towerBind }), /Tower's address/u, towerBind);
  assert.throws(() => installationChoices({ ...base, towerPort: 80 }), /port from 1024/u);
  assert.throws(() => installationChoices({ ...base, image: 'bad image' }), /app image/u);
  assert.throws(() => installationChoices({ ...base, allowedHosts: 'a;rm' }), /TOWER_ALLOWED_HOSTS/u);
  assert.throws(() => installationChoices({ ...base, postgresVolume: '../x' }), /volume/u);
});

test('a hand-edited file that is not in the written form is refused by name', (t) => {
  assert.throws(() => readInstallationEnv(tempFile(t, 'NOTICEOS_INSTALLATION=/srv\n')), /NAME="value"/u);
  assert.throws(() => readInstallationEnv(tempFile(t, 'NOTICEOS_STATE_DIR="${NOTICEOS_INSTALLATION}/state"\n')), /before setting it/u);
  assert.throws(() => readInstallationEnv(tempFile(t, 'COMPOSE_PROJECT_NAME="x"\n')), /does not set/u);
  // A file written before the Tower's address was a choice still reads; Compose keeps it on loopback.
  const older = renderInstallationEnv(base).replace(/^NOTICEOS_TOWER_BIND=.*\n/mu, '');
  assert.equal(readInstallationEnv(tempFile(t, older)).NOTICEOS_TOWER_BIND, undefined);
});

test('an installation that runs from its image says how its commands run; one from a checkout does not', (t) => {
  const image = readInstallationEnv(tempFile(t, renderInstallationEnv({ ...base, launcher: true })));
  assert.equal(image.NOTICEOS_COMMANDS, '/srv/one installation/noticeos');
  assert.equal(readInstallationEnv(tempFile(t, renderInstallationEnv(base))).NOTICEOS_COMMANDS, undefined);
});

test('the stack sources Postgres runs as programs are exactly the executable ones in git, and the copy keeps that', (t) => {
  const listed = spawnSync('git', ['ls-files', '-s', '--', ...STACK_SOURCES], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const rows = listed.stdout.trim().split('\n').map((line) => [line.split(/\s+/u)[0], line.split('\t')[1]]);
  assert.deepEqual(rows.map(([, file]) => file).sort(), [...STACK_SOURCES].sort(), 'every stack source is committed');
  assert.deepEqual(rows.filter(([mode]) => mode === '100755').map(([, file]) => file), [...STACK_EXECUTABLES]);
  const target = mkdtempSync(path.join(os.tmpdir(), 'nos-stack-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  copyStack(ROOT, path.join(target, 'stack'));
  for (const file of STACK_SOURCES) assert.equal(statSync(path.join(target, 'stack', file)).mode & 0o111 ? 'x' : '-', STACK_EXECUTABLES.includes(file) ? 'x' : '-', file);
});

test('the selector names the stack definition, the backup layer when there is one, and the folder\'s file', () => {
  const selector = installationSelector({ dir: '/srv/x', project: 'noticeos', dockerHost: 'unix:///var/run/docker.sock', root: ROOT });
  assert.deepEqual(selector.files, stackFiles(ROOT));
  assert.equal(selector.envFile, '/srv/x/installation.env');
  assert.deepEqual(installationSelector({ dir: '/srv/x', project: 'noticeos', dockerHost: 'unix:///d.sock', backup: false, root: ROOT }).files, [path.join(ROOT, 'deploy/compose/stack.yaml')]);
});

const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
test('Compose resolves the stack from installation.env alone: one network it creates, external data volumes, every path in the folder', { skip: compose.status !== 0 && 'no docker compose' }, (t) => {
  const envFile = tempFile(t, renderInstallationEnv({ ...base, dir: '/srv/one-installation', backupOffsite: '/mnt/sync' }));
  const resolve = (files) => {
    const result = spawnSync('docker', ['compose', '--project-name', 'noticeos', ...files.flatMap((file) => ['-f', file]), '--env-file', envFile, 'config', '--format', 'json'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const full = resolve(stackFiles(ROOT));
  assert.deepEqual(Object.keys(full.services).sort(), ['backup', 'dolt', 'noticeos', 'postgres']);
  assert.equal(full.networks.installation.name, 'noticeos_installation');
  assert.notEqual(full.networks.installation.external, true);
  for (const name of ['postgres', 'dolt', 'noticeos', 'backup']) assert.deepEqual(Object.keys(full.services[name].networks), ['installation'], name);
  assert.deepEqual(full.volumes['postgres-data'], { name: 'noticeos_postgres-data', external: true });
  assert.deepEqual(full.volumes['dolt-data'], { name: 'noticeos_dolt-data', external: true });
  const binds = Object.values(full.services).flatMap((service) => service.volumes ?? []).filter((mount) => mount.type === 'bind').map((mount) => mount.source);
  for (const source of binds) {
    assert.ok(source.startsWith('/srv/one-installation/') || source === '/mnt/sync' || source.startsWith(path.join(ROOT, 'db/')), source);
  }
  for (const secret of Object.values(full.secrets)) assert.ok(secret.file.startsWith('/srv/one-installation/'), secret.file);
  assert.deepEqual(full.services.noticeos.ports.map((row) => [row.host_ip, row.published]), [['127.0.0.1', '5173']]);
  assert.equal(full.services.noticeos.user, '501:20');
  assert.deepEqual(Object.keys(resolve(stackFiles(ROOT, { backup: false })).services).sort(), ['dolt', 'noticeos', 'postgres']);
});

test('Compose resolves an image installation\'s stack from its own copy alone: every file it reads is in the folder', { skip: compose.status !== 0 && 'no docker compose' }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-image-installation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyStack(ROOT, path.join(dir, 'stack'));
  const envFile = path.join(dir, 'installation.env');
  writeFileSync(envFile, renderInstallationEnv({ ...base, dir, launcher: true }));
  const result = spawnSync('docker', ['compose', '--project-name', 'noticeos', ...stackFiles(path.join(dir, 'stack')).flatMap((file) => ['-f', file]),
    '--env-file', envFile, 'config', '--format', 'json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.status, 0, result.stderr);
  const model = JSON.parse(result.stdout);
  const sources = Object.values(model.services).flatMap((service) => service.volumes ?? []).filter((mount) => mount.type === 'bind').map((mount) => mount.source);
  const stackFilesRead = sources.filter((source) => source.startsWith(path.join(dir, 'stack') + '/'));
  assert.ok(stackFilesRead.length >= 8, 'the databases read their configuration and scripts from the copy');
  for (const source of stackFilesRead) assert.ok(existsSync(source), `${source} is in the copy`);
  for (const source of sources) assert.ok(source.startsWith(dir + '/'), `${source} is in the installation folder`);
  assert.equal(result.stdout.includes(ROOT + '/'), false, 'nothing is read from the checkout');
});
