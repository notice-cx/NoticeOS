import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readInstallationEnv, STACK_SOURCES } from './installation-layout.mjs';
import { folderRefusal, main, parseOptions, setup } from './os-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = `sha256:${'b'.repeat(64)}`;

/** A checkout with the frozen migrations and a synthetic backup default, never the real config. */
function sandbox(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nos-setup-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout');
  cpSync(path.join(ROOT, 'db/postgres/migrations'), path.join(root, 'db/postgres/migrations'), { recursive: true });
  cpSync(path.join(ROOT, 'db/postgres/frozen-migrations.sha256'), path.join(root, 'db/postgres/frozen-migrations.sha256'));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/host-backup.json'), JSON.stringify({ offsiteBackupDir: null, retention: { daily: 2, weekly: 2 }, analyticalHistoryDirectory: null, assetBackups: [] }));
  return { base, root, dir: path.join(base, 'noticeos'), selectorFile: path.join(base, 'local', 'stack.json') };
}

/** A Docker that answers like a new, empty host, recording every call. */
function fakeDocker({ existing = [], seedFailures = 0 } = {}) {
  const calls = [];
  let seeds = 0;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, stdin: options.stdin ?? null });
    const words = args.join(' ');
    if (words.includes('version --format')) return { code: 0, stdout: 'arm64\n' };
    if (args.includes('ps') && args.includes('--filter')) return { code: 0, stdout: '' };
    if ((args.includes('volume') || args.includes('network')) && args.includes('inspect')) {
      return existing.includes(args.at(-1)) ? { code: 0, stdout: '[]' } : { code: 1, stdout: '', stderr: 'no such' };
    }
    if (words.includes('seed-settings')) return { code: ++seeds > seedFailures ? 0 : 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  return { calls, run };
}

const options = (box, extra = {}) => ({ ...parseOptions(['--dir', box.dir, '--image', IMAGE, '--config', box.selectorFile]), ...extra });
const deps = (docker, root, out = { write() {} }) => ({ run: docker.run, out, root, free: async () => true, endpoint: async () => 'unix:///var/run/docker.sock', pause: async () => {}, uid: 501, gid: 20 });

test('a new installation is written in the layout, private, with the app reaching its databases inside the stack', async (t) => {
  const box = sandbox(t);
  const docker = fakeDocker({ seedFailures: 2 });
  let shown = '';
  assert.equal(await setup(options(box, { offsite: box.base }), deps(docker, box.root, { write: (text) => { shown += text; } })), 0);

  for (const folder of ['', 'state', 'state/dolt', 'state/dolt/client-home', 'state/installation', 'spokes', 'postgres-secrets', 'dolt-secrets', 'backup/profile', 'backup/transport']) {
    assert.equal(statSync(path.join(box.dir, folder)).mode & 0o777, 0o700, folder);
  }
  for (const file of ['state/workers/ingest/.dev.secrets.json', 'state/task-client.json', 'state/dolt/credentials', 'dolt-secrets/root', 'dolt-secrets/noticeos', 'postgres-secrets/owner.url', 'installation.env']) {
    assert.equal(statSync(path.join(box.dir, file)).mode & 0o777, 0o600, file);
  }
  const bindings = JSON.parse(readFileSync(path.join(box.dir, 'state/workers/ingest/.dev.secrets.json'), 'utf8'));
  const address = new URL(bindings.DATABASE_URL);
  assert.deepEqual([address.username, address.hostname, address.port], ['noticeos_app', 'postgres', '5432']);
  assert.ok(bindings.CREDENTIALS_KEY && bindings.OPERATOR_TOKEN);
  const password = readFileSync(path.join(box.dir, 'dolt-secrets/noticeos'), 'utf8').trim();
  assert.match(password, /^[0-9a-f]{64}$/u);
  assert.equal(readFileSync(path.join(box.dir, 'state/dolt/credentials'), 'utf8'), `[dolt:3306]\npassword=${password}\n`);
  assert.deepEqual(JSON.parse(readFileSync(path.join(box.dir, 'backup/profile/host-backup.json'), 'utf8')).offsiteBackupDir, '/backup-offsite/backups');
  const values = readInstallationEnv(path.join(box.dir, 'installation.env'));
  assert.equal(values.NOTICEOS_APP_IMAGE, IMAGE);
  assert.equal(values.NOTICEOS_BACKUP_OFFSITE_PARENT, box.base);
  assert.equal(values.NOTICEOS_APP_UID, '501');

  // Volumes first, databases, the one-off setup, the app, its settings, then health.
  const steps = docker.calls.map(({ args }) => args.join(' '));
  const at = (pattern) => steps.findIndex((line) => pattern.test(line));
  const order = [/volume create .*postgres-data/u, /volume create .*dolt-data/u, /up --detach --wait .* postgres dolt$/u, /run --rm --no-deps -T noticeos setup$/u, /up --detach$/u, /seed-settings$/u, /up --detach --wait --wait-timeout 300$/u];
  const positions = order.map(at);
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), steps.join('\n'));
  assert.equal(steps.filter((line) => /seed-settings$/u.test(line)).length, 3, 'loading the settings waits for the app');
  // The owner's address goes to the container on stdin only, and names the stack's own host.
  const handed = docker.calls.find(({ args }) => args.at(-1) === 'setup');
  const owner = new URL(handed.stdin.trim());
  assert.deepEqual([owner.username, owner.hostname, owner.port], ['noticeos_owner', 'postgres', '5432']);
  assert.ok(docker.calls.every(({ args }) => !args.join(' ').includes(owner.password)));
  assert.ok(!shown.includes(owner.password) && !shown.includes(password));

  const selector = JSON.parse(readFileSync(box.selectorFile, 'utf8'));
  assert.deepEqual(selector, { project: 'noticeos', files: [path.join(box.root, 'deploy/compose/stack.yaml'), path.join(box.root, 'deploy/compose/backup.compose.yaml')],
    envFile: path.join(box.dir, 'installation.env'), dockerHost: 'unix:///var/run/docker.sock' });
  assert.match(shown, /NoticeOS is running: http:\/\/127\.0\.0\.1:5173\//u);
});

test('from its image, with no checkout, setup runs that image and leaves the folder its stack, selector and launcher', async (t) => {
  const box = sandbox(t);
  // The image carries the stack definition and the launcher where a checkout has them.
  for (const file of [...STACK_SOURCES, 'deploy/compose/noticeos']) cpSync(path.join(ROOT, file), path.join(box.root, file));
  const docker = fakeDocker();
  const probes = [];
  const run = async (command, args, options) => {
    if (args.includes('image') && args.includes('inspect')) return { code: args.at(-1) === 'ghcr.io/example/noticeos:main' ? 0 : 1, stdout: `${IMAGE}\n` };
    const published = args[args.indexOf('--publish') + 1];
    if (args.includes('--publish')) {
      probes.push(published);
      return published === '127.0.0.1:5173:9' ? { code: 125, stderr: 'Bind for 127.0.0.1:5173 failed: port is already allocated' } : { code: 0, stdout: '' };
    }
    return docker.run(command, args, options);
  };
  const selectorFile = path.join(box.dir, 'stack.json');
  const env = { PATH: process.env.PATH, NOTICEOS_CLI_IMAGE: 'ghcr.io/example/noticeos:main', NOTICEOS_DIR: box.dir };
  let shown = '';
  const own = { ...deps(docker, box.root, { write: (text) => { shown += text; } }), run, env, free: async () => assert.fail('the container tested its own ports') };
  assert.equal(await setup(parseOptions(['--dir', box.dir, '--config', selectorFile]), own), 0);

  assert.deepEqual(probes.slice(0, 3), ['127.0.0.1:5173:9', '127.0.0.1:5174:9', '127.0.0.1:5432:9'], 'Docker tests the host\'s ports');
  const values = readInstallationEnv(path.join(box.dir, 'installation.env'));
  assert.equal(values.NOTICEOS_APP_IMAGE, IMAGE, 'the app runs the image setup ran from, by ID');
  assert.equal(values.NOTICEOS_TOWER_PORT, '5174');
  assert.equal(values.NOTICEOS_COMMANDS, path.join(box.dir, 'noticeos'));
  for (const file of STACK_SOURCES) assert.ok(existsSync(path.join(box.dir, 'stack', file)), file);
  assert.equal(statSync(path.join(box.dir, 'noticeos')).mode & 0o777, 0o755);
  const selector = JSON.parse(readFileSync(selectorFile, 'utf8'));
  assert.deepEqual(selector.files, [path.join(box.dir, 'stack/deploy/compose/stack.yaml'), path.join(box.dir, 'stack/deploy/compose/backup.compose.yaml')]);
  assert.ok(docker.calls.filter(({ args }) => args.includes('compose')).every(({ args }) => args.includes(path.join(box.dir, 'stack/deploy/compose/stack.yaml'))));
  assert.ok(existsSync(path.join(box.dir, 'stack-apply', 'applied.env')), 'the first settings are recorded for apply and update');
  assert.match(shown, /NoticeOS is running: http:\/\/127\.0\.0\.1:5174\//u);

  // From the image there is no checkout to move a legacy stack in with, so no refusal offers it.
  const taken = sandbox(t);
  for (const file of [...STACK_SOURCES, 'deploy/compose/noticeos']) cpSync(path.join(ROOT, file), path.join(taken.root, file));
  const occupied = async (command, args, options) => args.includes('ps') && args.includes('--filter') ? { code: 0, stdout: 'abc123\n' } : run(command, args, options);
  await assert.rejects(setup(parseOptions(['--dir', taken.dir, '--config', path.join(taken.dir, 'stack.json')]), { ...own, root: taken.root, run: occupied }),
    (error) => /already has containers for the project noticeos; choose another with --project\.$/u.test(error.message));

  const again = sandbox(t);
  for (const file of [...STACK_SOURCES, 'deploy/compose/noticeos']) cpSync(path.join(ROOT, file), path.join(again.root, file));
  await assert.rejects(setup(parseOptions(['--dir', again.dir, '--image', IMAGE, '--config', path.join(again.dir, 'stack.json')]), { ...own, root: again.root }),
    /--image and --build need a checkout/u);
});

test('anything that is not new refuses before a file, volume or container is made', async (t) => {
  const refused = async (box, opts, docker, pattern) => {
    let error = '';
    const code = await main(['--dir', opts.dir ?? box.dir, '--image', IMAGE, '--config', box.selectorFile, ...(opts.args ?? [])],
      { ...deps(docker, box.root), err: { write: (text) => { error += text; } }, endpoint: opts.endpoint ?? (async () => 'unix:///var/run/docker.sock') });
    assert.equal(code, 1);
    assert.match(error, pattern);
    assert.ok(!docker.calls.some(({ args }) => args.includes('create') || args.includes('up') || args.includes('run')), 'nothing was made');
  };
  const selected = sandbox(t);
  mkdirSync(path.dirname(selected.selectorFile));
  writeFileSync(selected.selectorFile, '{}');
  await refused(selected, {}, fakeDocker(), /already selects an installation/u);
  const used = sandbox(t);
  mkdirSync(used.dir);
  writeFileSync(path.join(used.dir, 'notes.txt'), 'x');
  await refused(used, {}, fakeDocker(), /not empty/u);
  const volume = sandbox(t);
  await refused(volume, {}, fakeDocker({ existing: ['noticeos_postgres-data'] }), /noticeos_postgres-data already exists/u);
  assert.equal(existsSync(volume.dir), false);
  await refused(sandbox(t), { endpoint: async () => 'tcp://203.0.113.9:2376' }, fakeDocker(), /local Docker engine/u);
  await refused(sandbox(t), { args: ['--offsite', '/no/such/sync/folder'] }, fakeDocker(), /does not exist/u);
});

test('the folder is its own: never inside the checkout', () => {
  assert.match(folderRefusal(path.join(ROOT, '.local', 'noticeos'), ROOT), /inside this checkout/u);
  assert.equal(folderRefusal(path.join(os.tmpdir(), 'nos-setup-absent-folder'), ROOT), null);
});
