import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changedServices, main, moveVersion, parseOptions, retiredMoves, withImage } from './image-update.mjs';
import { STACK_SOURCES } from './installation-layout.mjs';

const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;
const SCHEMA = 'c'.repeat(64);
const quiet = { write() {} };

test('the image line is the only line a move rewrites', () => {
  const text = `COMPOSE_PROJECT_NAME="noticeos"\nNOTICEOS_APP_IMAGE="${OLD}"\nNOTICEOS_TOWER_PORT="5173"\n# a note\n`;
  assert.equal(withImage(text, NEW), text.replace(OLD, NEW));
  assert.throws(() => withImage('COMPOSE_PROJECT_NAME="noticeos"\n', NEW), /names no NOTICEOS_APP_IMAGE/u);
});

test('a staged definition is compared where it will be, so only real declaration changes count', () => {
  const now = { services: { noticeos: { image: OLD }, postgres: { volumes: [{ source: '/i/stack/db/postgres/host/pg_hba.conf' }] }, dolt: { image: 'dolt:1' } } };
  const same = { services: { noticeos: { image: NEW }, postgres: { volumes: [{ source: '/i/stack.next/db/postgres/host/pg_hba.conf' }] }, dolt: { image: 'dolt:1' } } };
  assert.deepEqual(changedServices(now, same, { from: '/i/stack.next', to: '/i/stack' }), ['noticeos']);
  const bumped = { services: { ...same.services, dolt: { image: 'dolt:2' } } };
  assert.deepEqual(changedServices(now, bumped, { from: '/i/stack.next', to: '/i/stack' }), ['dolt', 'noticeos']);
  assert.throws(() => changedServices(now, { services: { ...same.services, extra: {} } }, { from: '/i/stack.next', to: '/i/stack' }), /not something update does/u);
});

test('a version that stops running the retired task server, or runs it again, can be moved to; any other difference is refused', () => {
  const at = { from: '/i/stack.next', to: '/i/stack' };
  const withTasks = { services: { noticeos: { image: OLD }, postgres: {}, dolt: { image: 'dolt:1' } } };
  const without = { services: { noticeos: { image: NEW }, postgres: {} } };
  assert.deepEqual(changedServices(withTasks, without, at), ['noticeos']);
  assert.deepEqual(retiredMoves(withTasks, without), { leaving: ['dolt'], returning: [] });
  assert.deepEqual(changedServices(without, withTasks, at), ['noticeos']);
  assert.deepEqual(retiredMoves(without, withTasks), { leaving: [], returning: ['dolt'] });
  assert.deepEqual(retiredMoves(withTasks, withTasks), { leaving: [], returning: [] });
  assert.throws(() => changedServices(withTasks, { services: { ...without.services, extra: {} } }, at), /not something update does/u);
});

test('options need the installation\'s own stack.json', () => {
  assert.deepEqual(parseOptions(['--rollback', '--config', '/i/stack.json', '--confirm', 'rollback']), { help: false, rollback: true, confirm: 'rollback', selectorFile: '/i/stack.json' });
  assert.throws(() => parseOptions([]), /--config/u);
  assert.throws(() => parseOptions(['--config', 'relative.json']), /--config/u);
});

/** An image installation's folder and a Docker whose stack runs `app` and knows the images in `images`. */
function installation(t, { app = OLD, images = {}, drift = false, roles = 'roles v1', taskServerLeaves = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-image-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stack = path.join(dir, 'stack');
  mkdirSync(path.join(stack, 'deploy/compose'), { recursive: true });
  mkdirSync(path.join(stack, 'db/postgres'), { recursive: true });
  // With taskServerLeaves the installation's own definition runs the task server and the image's does not.
  for (const file of ['stack.yaml', 'backup.compose.yaml']) writeFileSync(path.join(stack, 'deploy/compose', file), `services: {}\n${taskServerLeaves ? '# dolt\n' : ''}`);
  writeFileSync(path.join(stack, 'db/postgres/roles.sql'), roles);
  writeFileSync(path.join(dir, 'installation.env'), `COMPOSE_PROJECT_NAME="noticeos"\nNOTICEOS_APP_IMAGE="${app}"\n`);
  const selectorFile = path.join(dir, 'stack.json');
  writeFileSync(selectorFile, JSON.stringify({ project: 'noticeos', files: [path.join(stack, 'deploy/compose/stack.yaml'), path.join(stack, 'deploy/compose/backup.compose.yaml')],
    envFile: path.join(dir, 'installation.env'), dockerHost: 'unix:///var/run/docker.sock' }));
  const id = (name) => createHash('sha256').update(name).digest('hex');
  const services = ['noticeos', 'postgres', 'dolt', 'backup'];
  const calls = [];
  // The image the app's container was made from, and whether the task server runs: what `up` and `stop` change.
  const state = { image: app, taskServer: 'running' };
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const envImage = (args) => /NOTICEOS_APP_IMAGE="([^"]+)"/u.exec(readFileSync(flag(args, '--env-file'), 'utf8'))?.[1];
  // A container's config hash follows the app image it was made with, as Compose's does.
  const appHash = (image) => taskServerLeaves ? createHash('sha256').update(image ?? '').digest('hex') : (drift ? '2' : '1').repeat(64);
  const run = async (command, args) => {
    calls.push(args);
    const words = args.join(' ');
    if (args.includes('compose') && words.includes('ps --all --format json')) {
      return { code: 0, stdout: JSON.stringify(services.map((Service) => ({ Project: 'noticeos', Service, ID: id(Service),
        State: Service === 'dolt' ? state.taskServer : 'running', Health: Service === 'dolt' && state.taskServer !== 'running' ? '' : 'healthy',
        Labels: `com.docker.compose.config-hash=${Service === 'noticeos' && taskServerLeaves ? appHash(state.image) : '1'.repeat(64)}` }))) };
    }
    if (args.includes('compose') && words.includes('config --hash')) {
      return { code: 0, stdout: services.map((name) => `${name} ${name === 'noticeos' ? appHash(envImage(args)) : '1'.repeat(64)}`).join('\n') };
    }
    if (args.includes('compose') && words.includes('config --format json')) {
      const runsTaskServer = readFileSync(flag(args, '-f'), 'utf8').includes('# dolt') || !taskServerLeaves;
      return { code: 0, stdout: JSON.stringify({ name: 'noticeos', services: Object.fromEntries(services.filter((name) => runsTaskServer || name !== 'dolt')
        .map((name) => [name, name === 'noticeos' && taskServerLeaves ? { image: envImage(args) } : {}])) }) };
    }
    if (args.includes('compose') && args.includes('up') && args.at(-1) === 'noticeos') state.image = envImage(args);
    if (args.includes('compose') && args.includes('up') && args.at(-1) === 'dolt') state.taskServer = 'running';
    if (args[2] === 'stop' && args.includes(id('dolt'))) state.taskServer = 'exited';
    if (args.includes('ps') && args.includes('--quiet') && words.includes('com.docker.compose.service=dolt')) return { code: 0, stdout: state.taskServer === 'running' ? `${id('dolt')}\n` : '' };
    if (args[2] === 'inspect' && args.length === 4) {
      const service = services.find((name) => id(name) === args[3]);
      return { code: 0, stdout: JSON.stringify([{ Id: args[3], Image: service === 'noticeos' ? state.image : `sha256:${'d'.repeat(64)}`, State: { Status: 'running', Health: { Status: 'healthy' } },
        Config: { Labels: { 'com.docker.compose.project': 'noticeos', 'com.docker.compose.service': service } }, Mounts: [] }]) };
    }
    if (args[2] === 'image' && args[3] === 'inspect' && args[4] === '--format') return images[args.at(-1)] ? { code: 0, stdout: `${images[args.at(-1)].id}\n` } : { code: 1 };
    if (args[2] === 'image' && args[3] === 'inspect') {
      const known = Object.values(images).find((image) => image.id === args[4]) ?? (args[4] === app ? { id: app, revision: 'e'.repeat(40), schema: SCHEMA } : null);
      return known ? { code: 0, stdout: JSON.stringify([{ Id: known.id, Os: 'linux', Architecture: 'amd64',
        Config: { Labels: { 'org.opencontainers.image.revision': known.revision, 'cx.noticeos.schema': known.schema } } }]) } : { code: 1 };
    }
    return { code: 0, stdout: '' };
  };
  const root = path.join(dir, 'image');
  // The image's own stack definition and launcher, which an update copies into the folder.
  for (const file of [...STACK_SOURCES, 'deploy/compose/noticeos']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), file.endsWith('.yaml') ? 'services: {}\n' : '');
  }
  writeFileSync(path.join(root, 'db/postgres/roles.sql'), 'roles v1');
  const env = { PATH: process.env.PATH, NOTICEOS_CLI_IMAGE: 'ghcr.io/example/noticeos:main', NOTICEOS_DIR: dir };
  return { dir, root, selectorFile, run, calls, env, state };
}

const move = (own, extra = {}, deps = {}) => moveVersion({ rollback: false, confirm: null, selectorFile: own.selectorFile, ...extra },
  { run: own.run, env: own.env, out: quiet, root: own.root, interactive: false, ...deps });

test('an app already on the newest image has nothing to update, and nothing is touched', async (t) => {
  const own = installation(t, { images: { 'ghcr.io/example/noticeos:main': { id: OLD, revision: 'e'.repeat(40), schema: SCHEMA } } });
  let said = '';
  assert.equal(await move(own, {}, { out: { write: (text) => { said += text; } } }), 0);
  assert.match(said, /Nothing to update: the app runs eeeeeeeeeeee, the newest published version\./u);
  assert.ok(own.calls.every((args) => !args.includes('up') && !args.includes('stop')));
});

test('an edit to installation.env that is not applied yet stops a move before anything changes', async (t) => {
  const own = installation(t, { drift: true, images: { 'ghcr.io/example/noticeos:main': { id: NEW, revision: 'f'.repeat(40), schema: SCHEMA } } });
  await assert.rejects(move(own), /an edit that is not applied yet/u);
});

test('a new schema waits for its migrations, and changed Postgres roles are left to the operator', async (t) => {
  const images = { 'ghcr.io/example/noticeos:main': { id: NEW, revision: 'f'.repeat(40), schema: '9'.repeat(64) } };
  const behind = installation(t, { images });
  await assert.rejects(move(behind, {}, { database: async () => ({ ok: false, line: 'it is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date' }) }),
    /carries database changes the database does not have yet: it is 1 migration behind this code.*applies no migrations/u);
  const roles = installation(t, { images, roles: 'roles v0' });
  await assert.rejects(move(roles, {}, { database: async () => assert.fail('roles are checked first') }), /changes the Postgres roles; that is operator maintenance/u);
});

test('an image that is not a published release, a rollback with nothing before it, and a checkout are refused', async (t) => {
  const unlabelled = installation(t, { images: { 'ghcr.io/example/noticeos:main': { id: NEW, revision: undefined, schema: undefined } } });
  await assert.rejects(move(unlabelled), /carries no commit or schema/u);
  await assert.rejects(move(installation(t), { rollback: true }), /no version before this one is recorded/u);
  const checkout = installation(t);
  await assert.rejects(move(checkout, {}, { env: { PATH: process.env.PATH } }), /from a checkout, pnpm os:update and pnpm os:rollback move the app/u);
  let said = '';
  assert.equal(await main(['--config', checkout.selectorFile], { env: { PATH: process.env.PATH }, out: quiet, err: { write: (text) => { said += text; } } }), 1);
  assert.match(said, /^noticeos update: /u);
});

test('an update past the task server recreates the app first, then stops the task server and keeps it; a rollback runs it again before the earlier app', async (t) => {
  const own = installation(t, { taskServerLeaves: true, images: { 'ghcr.io/example/noticeos:main': { id: NEW, revision: 'f'.repeat(40), schema: SCHEMA } } });
  const dolt = createHash('sha256').update('dolt').digest('hex');
  const at = (pattern, from = 0) => own.calls.findIndex((args, index) => index >= from && pattern(args));
  let said = '';
  assert.equal(await move(own, { confirm: 'update' }, { out: { write: (text) => { said += text; } } }), 0, said);
  assert.match(said, /dolt: the new version does not run it; it stops, and its container and data volume stay for a rollback\./u);
  const appUp = at((args) => args.includes('up') && args.at(-1) === 'noticeos');
  const stopped = at((args) => args[2] === 'stop' && args.includes(dolt));
  assert.ok(appUp >= 0 && stopped > appUp, 'the new app is up before the task server stops');
  assert.deepEqual(own.state, { image: NEW, taskServer: 'exited' });
  assert.ok(own.calls.every((args) => !args.includes('rm') && !args.includes('down')), 'nothing is removed');

  const updated = own.calls.length;
  said = '';
  assert.equal(await move(own, { rollback: true, confirm: 'rollback' }, { out: { write: (text) => { said += text; } } }), 0, said);
  assert.match(said, /dolt: the earlier version runs it again, from its kept container and data volume\./u);
  const taskServerUp = at((args) => args.includes('up') && args.at(-1) === 'dolt', updated);
  const earlierAppUp = at((args) => args.includes('up') && args.at(-1) === 'noticeos', updated);
  assert.ok(taskServerUp >= 0 && earlierAppUp > taskServerUp, 'the task server runs before the earlier app starts');
  assert.deepEqual(own.state, { image: OLD, taskServer: 'running' });
});
