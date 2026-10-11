import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareStacks, convertLegacy, convertedChoices, copyTree, parseOptions, readInstallation } from './os-convert-legacy.mjs';

const IMAGE = `sha256:${'d'.repeat(64)}`;
const bind = (source, target, extra = {}) => ({ type: 'bind', source, target, ...extra });

/** A resolved legacy stack: folders inside an old checkout, one kept outside, an extra mount. */
function legacyModel(old, outside) {
  return {
    services: {
      noticeos: { image: 'noticeos-local:old', user: '501:20', environment: { TOWER_ALLOWED_HOSTS: 'tower.example.com' },
        ports: [{ host_ip: '127.0.0.1', published: '5180', target: 5173 }],
        volumes: [bind(`${old}/state`, '/state'), bind(outside, '/spokes'), bind(`${old}/transport`, '/backup-transport')] },
      postgres: { ports: [{ host_ip: '127.0.0.1', published: '5440', target: 5432 }],
        volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }, bind(`${old}/pg_hba.conf`, '/etc/noticeos/pg_hba.conf', { read_only: true }),
          { type: 'volume', source: 'pg-backup-socket', target: '/var/run/postgresql' }] },
      dolt: { ports: [{ host_ip: '127.0.0.1', published: '3310', target: 3306 }], volumes: [{ type: 'volume', source: 'dolt-data', target: '/var/lib/dolt' }] },
      backup: { volumes: [bind(`${old}/worker`, '/run/backup-worker'), bind(`${old}/staging`, '/backup-staging'), bind(`${old}/transport`, '/backup-transport'),
        bind(`${old}/assets`, '/backup-assets'), bind('/mnt/sync', '/backup-offsite'), bind(`${old}/auth`, '/backup-exporter-auth', { read_only: true })] },
    },
    volumes: { 'postgres-data': { name: 'office_postgres' }, 'dolt-data': { name: 'office_dolt' }, 'pg-backup-socket': { name: 'office_socket' } },
    secrets: { noticeos_owner: { file: `${old}/pg-secrets/noticeos_owner` }, dolt_root: { file: `${old}/dolt-secrets/root` } },
  };
}

test('the running stack is read in the layout\'s terms: its choices, what is copied and what stays', () => {
  const found = readInstallation(legacyModel('/old/checkout/.local', '/home/me/tasks'), { project: 'noticeos', imageId: IMAGE, legacyRoot: '/old/checkout' });
  assert.deepEqual(found.copies.map(({ key, from }) => [key, from]), [
    ['state', '/old/checkout/.local/state'], ['postgresSecrets', '/old/checkout/.local/pg-secrets'], ['doltSecrets', '/old/checkout/.local/dolt-secrets'],
    ['backupProfile', '/old/checkout/.local/worker'], ['backupAssets', '/old/checkout/.local/assets']]);
  assert.deepEqual(found.kept, { spokes: '/home/me/tasks', backupOffsite: '/mnt/sync' });
  const choices = convertedChoices(found, '/srv/noticeos');
  assert.deepEqual([choices.towerPort, choices.postgresPort, choices.doltPort, choices.uid, choices.gid], [5180, 5440, 3310, 501, 20]);
  assert.deepEqual([choices.postgresVolume, choices.doltVolume, choices.image, choices.allowedHosts], ['office_postgres', 'office_dolt', IMAGE, 'tower.example.com']);
  assert.deepEqual([choices.spokes, choices.backupOffsite, choices.backupAssets], ['/home/me/tasks', '/mnt/sync', null]);
});

test('a stack the layout cannot hold is refused by name', () => {
  const model = legacyModel('/old', '/tasks');
  assert.throws(() => readInstallation({ ...model, services: { ...model.services, cache: {} } }, { project: 'x', imageId: IMAGE }), /services the layout does not: cache/u);
  const live = structuredClone(model);
  live.services.noticeos.environment.NOTICEOS_CONTAINER_MODE = 'development';
  assert.throws(() => readInstallation(live, { project: 'x', imageId: IMAGE }), /os:prod first/u);
  const { postgres: _postgres, ...rest } = model.services;
  assert.throws(() => readInstallation({ ...model, services: rest }, { project: 'x', imageId: IMAGE }), /no postgres service/u);
});

test('only differences beyond the move are listed: a changed file, a dropped mount, a changed binding', () => {
  const before = legacyModel('/old', '/tasks');
  const found = readInstallation(before, { project: 'noticeos', imageId: IMAGE, legacyRoot: '/old' });
  const after = structuredClone(before);
  const moved = (source) => source.replace('/old/state', '/srv/n/state').replace('/old/worker', '/srv/n/backup/profile').replace('/old/staging', '/srv/n/backup/staging')
    .replace('/old/transport', '/srv/n/backup/transport').replace('/old/assets', '/srv/n/backup/assets');
  for (const service of Object.values(after.services)) for (const mount of service.volumes ?? []) mount.source = moved(mount.source);
  after.services.postgres.volumes[1].source = '/checkout/db/postgres/host/pg_hba.conf';
  after.services.backup.volumes = after.services.backup.volumes.filter((mount) => mount.target !== '/backup-exporter-auth');
  after.services.noticeos.ports = [{ host_ip: '0.0.0.0', published: '5180', target: 5173 }];
  after.volumes['pg-backup-socket'] = { name: 'noticeos_pg-backup-socket' };
  after.secrets = { noticeos_owner: { file: '/srv/n/postgres-secrets/noticeos_owner' }, dolt_root: { file: '/srv/n/dolt-secrets/root' } };
  const hash = (file) => (file.includes('checkout') ? 'new rules' : 'old rules');
  const { moved: count, changes } = compareStacks(before, after, { copies: found.copies, fresh: found.fresh, dir: '/srv/n', hash });
  assert.deepEqual(changes, [
    'backup: /backup-exporter-auth is no longer mounted (it was /old/auth)',
    'noticeos: published ports change',
    'postgres: /etc/noticeos/pg_hba.conf comes from /checkout/db/postgres/host/pg_hba.conf, which differs from /old/pg_hba.conf',
  ]);
  assert.equal(count, 7);
  const same = compareStacks(before, after, { copies: found.copies, fresh: found.fresh, dir: '/srv/n', hash: () => 'same' });
  assert.ok(!same.changes.some((line) => line.includes('pg_hba')));
});

test('a copy keeps every folder\'s and file\'s mode, and links stay links', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nos-convert-copy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const from = path.join(base, 'from');
  mkdirSync(path.join(from, 'dolt', 'client-home'), { recursive: true });
  chmodSync(from, 0o700); chmodSync(path.join(from, 'dolt'), 0o700); chmodSync(path.join(from, 'dolt', 'client-home'), 0o750);
  writeFileSync(path.join(from, 'dolt', 'credentials'), 'secret', { mode: 0o600 });
  symlinkSync('../elsewhere', path.join(from, 'link'));
  const to = path.join(base, 'to');
  copyTree(from, to);
  for (const [relative, mode] of [['', 0o700], ['dolt', 0o700], ['dolt/client-home', 0o750], ['dolt/credentials', 0o600]]) {
    assert.equal(statSync(path.join(to, relative)).mode & 0o777, mode, relative);
  }
  assert.equal(readFileSync(path.join(to, 'dolt', 'credentials'), 'utf8'), 'secret');
  assert.ok(lstatSync(path.join(to, 'link')).isSymbolicLink());
  assert.equal(readlinkSync(path.join(to, 'link')), '../elsewhere');
  assert.throws(() => copyTree(from, to), /EEXIST/u);
});

/**
 * A legacy stack in a temporary checkout: its folders, its selector and a
 * Docker that answers for it. `live` puts the app on os:dev's live source,
 * with os:dev's record of the prepared stack beside the selector.
 */
function legacyFixture(t, { live = false } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nos-convert-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const old = path.join(base, 'old');
  for (const folder of ['state', 'pg-secrets', 'dolt-secrets', 'worker', 'staging', 'transport', 'assets']) mkdirSync(path.join(old, folder), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(old, 'pg-secrets', 'noticeos_owner'), 'verifier\n');
  writeFileSync(path.join(old, 'dolt-secrets', 'root'), 'password\n', { mode: 0o600 });
  writeFileSync(path.join(old, 'compose.json'), '{}');
  writeFileSync(path.join(old, 'compose.env'), '');
  const local = path.join(base, 'local');
  mkdirSync(path.join(local, 'stack-development'), { recursive: true });
  const selectorFile = path.join(local, 'stack.json');
  const prepared = { project: 'noticeos', files: [path.join(old, 'compose.json')], envFile: path.join(old, 'compose.env'), dockerHost: 'unix:///var/run/docker.sock' };
  const override = path.join(local, 'stack-development', 'source.json');
  const selector = live ? { ...prepared, files: [...prepared.files, override] } : prepared;
  writeFileSync(selectorFile, JSON.stringify(selector));
  if (live) {
    writeFileSync(override, '{}');
    writeFileSync(path.join(local, 'stack-development', 'previous.json'), JSON.stringify({ schema: 'noticeos-stack-development/1', selectorFile, selector: prepared, image: IMAGE }));
  }
  const model = legacyModel(old, '/mnt/tasks');
  const developing = structuredClone(model);
  developing.services.noticeos.environment.NOTICEOS_CONTAINER_MODE = 'development';
  const calls = [];
  const health = { noticeos: 'healthy' };
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git') return { code: 1, stdout: '' };
    if (args.includes('ps')) {
      return { code: 0, stdout: ['noticeos', 'postgres', 'dolt', 'backup'].map((service, index) => JSON.stringify({ Project: 'noticeos', Service: service,
        ID: String(index + 1).repeat(12), State: 'running', Health: health[service] ?? 'healthy' })).join('\n') };
    }
    if (args.includes('config')) {
      const files = args.filter((_arg, index) => args[index - 1] === '-f');
      const envFile = args[args.indexOf('--env-file') + 1];
      if (envFile === prepared.envFile) return { code: 0, stdout: JSON.stringify(files.includes(override) ? developing : model) };
      const after = structuredClone(model);
      after.networks = { installation: { name: 'noticeos_installation' } };
      return { code: 0, stdout: JSON.stringify(after) };
    }
    if (args.includes('image')) return { code: 0, stdout: `${IMAGE}\n` };
    if (args.includes('network')) return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  /** os:dev and os:prod, as the conversion calls them: os:prod puts the prepared selector back. */
  const develop = async ({ disable }) => {
    calls.push(disable ? 'os:prod' : 'os:dev');
    if (disable) writeFileSync(selectorFile, JSON.stringify(prepared));
  };
  return { base, dir: path.join(base, 'noticeos'), selectorFile, selector, prepared, calls, health, run, develop };
}

test('without the typed word nothing is stopped, copied or written', async (t) => {
  const box = legacyFixture(t);
  let shown = '';
  const code = await convertLegacy(parseOptions(['--dir', box.dir, '--config', box.selectorFile]),
    { run: box.run, develop: box.develop, out: { write: (text) => { shown += text; } }, interactive: false });
  assert.equal(code, 0);
  assert.match(shown, /Nothing has changed yet/u);
  assert.match(shown, /To convert it: pnpm os:convert-legacy -- --confirm convert/u);
  assert.ok(!box.calls.some((line) => / (stop|up|down|rm|create)\b|os:(dev|prod)/u.test(line)), box.calls.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(box.selectorFile, 'utf8')), box.selector);
  assert.equal(existsSync(box.dir), false);

  // A stack that is not healthy now is refused before anything is read further.
  box.health.noticeos = 'unhealthy';
  box.calls.length = 0;
  await assert.rejects(convertLegacy(parseOptions(['--dir', box.dir, '--config', box.selectorFile, '--confirm', 'convert']), { run: box.run, develop: box.develop, out: { write() {} }, interactive: false }),
    /noticeos \(running, unhealthy\) is not healthy; a conversion moves a healthy stack/u);
  assert.ok(!box.calls.some((line) => / (stop|up|config)\b/u.test(line)), box.calls.join('\n'));
});

test('a stack on live source is planned from its prepared stack, even while the development app is broken', async (t) => {
  const box = legacyFixture(t, { live: true });
  box.health.noticeos = 'unhealthy';
  let shown = '';
  assert.equal(await convertLegacy(parseOptions(['--dir', box.dir, '--config', box.selectorFile]),
    { run: box.run, develop: box.develop, out: { write: (text) => { shown += text; } }, interactive: false }), 0);
  assert.match(shown, /returns to its prepared image for the move, then follows the checkout again/u);
  assert.ok(!box.calls.some((line) => /os:(dev|prod)| (stop|up)\b/u.test(line)), box.calls.join('\n'));
  // The plan reads the prepared declaration, without os:dev's own file.
  const configs = box.calls.filter((line) => line.includes(' config '));
  assert.ok(configs.length >= 1 && !configs[0].includes('source.json'), configs.join('\n'));

  // Without os:dev's record of the prepared stack, there is nothing to plan from.
  rmSync(path.join(path.dirname(box.selectorFile), 'stack-development', 'previous.json'));
  await assert.rejects(convertLegacy(parseOptions(['--dir', box.dir, '--config', box.selectorFile]), { run: box.run, develop: box.develop, out: { write() {} }, interactive: false }),
    /record of its prepared image is missing; pnpm os:prod first/u);
});

test('converting a stack on live source returns it to its image, moves it, then follows the checkout again', async (t) => {
  const box = legacyFixture(t, { live: true });
  let shown = '';
  assert.equal(await convertLegacy(parseOptions(['--dir', box.dir, '--config', box.selectorFile, '--confirm', 'convert']),
    { run: box.run, develop: box.develop, out: { write: (text) => { shown += text; } }, interactive: false, root: process.cwd() }), 0);
  const order = box.calls.filter((line) => /^os:|compose .* (stop|up)\b/u.test(line)).map((line) => line.startsWith('os:') ? line : line.includes(' stop') ? 'stop' : 'up');
  assert.deepEqual(order, ['os:prod', 'stop', 'up', 'os:dev']);
  const selector = JSON.parse(readFileSync(box.selectorFile, 'utf8'));
  assert.equal(selector.envFile, path.join(box.dir, 'installation.env'));
  // What --undo returns to is the prepared stack, not os:dev's live one.
  assert.deepEqual(JSON.parse(readFileSync(box.selectorFile.replace(/\.json$/u, '.before-convert.json'), 'utf8')), box.prepared);
  assert.equal(statSync(path.join(box.dir, 'state')).mode & 0o777, 0o700);
  assert.match(shown, /Converted: the stack runs from/u);

  // A development app that does not come back leaves the conversion standing.
  const again = legacyFixture(t, { live: true });
  const failing = async (options) => { await again.develop(options); if (!options.disable) throw new Error('The development app did not become healthy.'); };
  shown = '';
  assert.equal(await convertLegacy(parseOptions(['--dir', again.dir, '--config', again.selectorFile, '--confirm', 'convert']),
    { run: again.run, develop: failing, out: { write: (text) => { shown += text; } }, interactive: false, root: process.cwd() }), 0);
  assert.match(shown, /The conversion stands, with the app on its prepared image: The development app did not become healthy\. pnpm os:dev tries again\./u);
  assert.equal(JSON.parse(readFileSync(again.selectorFile, 'utf8')).envFile, path.join(again.dir, 'installation.env'));
});
