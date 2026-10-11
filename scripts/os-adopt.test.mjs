import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adopt, adoptedChoices, compareStacks, copyTree, parseOptions, readInstallation } from './os-adopt.mjs';

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
  const choices = adoptedChoices(found, '/srv/noticeos');
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
  const base = mkdtempSync(path.join(os.tmpdir(), 'nos-adopt-copy-'));
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

test('without the typed word nothing is stopped, copied or written', async (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nos-adopt-plan-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const old = path.join(base, 'old');
  for (const folder of ['state', 'pg-secrets', 'dolt-secrets', 'worker', 'staging', 'transport', 'assets']) mkdirSync(path.join(old, folder), { recursive: true });
  writeFileSync(path.join(old, 'compose.json'), '{}');
  writeFileSync(path.join(old, 'compose.env'), '');
  const selectorFile = path.join(base, 'stack.json');
  const selector = { project: 'noticeos', files: [path.join(old, 'compose.json')], envFile: path.join(old, 'compose.env'), dockerHost: 'unix:///var/run/docker.sock' };
  writeFileSync(selectorFile, JSON.stringify(selector));
  const model = legacyModel(old, '/mnt/tasks');
  model.services.noticeos.volumes[0].source = path.join(old, 'state');
  const calls = [];
  let health = 'healthy';
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git') return { code: 1, stdout: '' };
    if (args.includes('ps')) {
      return { code: 0, stdout: ['noticeos', 'postgres', 'dolt', 'backup'].map((service, index) => JSON.stringify({ Project: 'noticeos', Service: service,
        ID: String(index + 1).repeat(12), State: 'running', Health: service === 'noticeos' ? health : 'healthy' })).join('\n') };
    }
    if (args.includes('config')) {
      const envFile = args[args.indexOf('--env-file') + 1];
      if (envFile === selector.envFile) return { code: 0, stdout: JSON.stringify(model) };
      const after = structuredClone(model);
      after.networks = { installation: { name: 'noticeos_installation' } };
      return { code: 0, stdout: JSON.stringify(after) };
    }
    if (args.includes('image')) return { code: 0, stdout: `${IMAGE}\n` };
    if (args.includes('network')) return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  let shown = '';
  const dir = path.join(base, 'noticeos');
  const code = await adopt(parseOptions(['--dir', dir, '--config', selectorFile]), { run, out: { write: (text) => { shown += text; } }, interactive: false });
  assert.equal(code, 0);
  assert.match(shown, /Nothing has changed yet/u);
  assert.match(shown, /To adopt it: pnpm os:adopt -- --confirm adopt/u);
  assert.ok(!calls.some((line) => / (stop|up|down|rm|create)\b/u.test(line)), calls.join('\n'));
  assert.equal(JSON.parse(readFileSync(selectorFile, 'utf8')).envFile, selector.envFile);
  assert.throws(() => statSync(dir), /ENOENT/u);

  // A stack that is not healthy now is refused before anything is read further.
  health = 'unhealthy';
  calls.length = 0;
  await assert.rejects(adopt(parseOptions(['--dir', dir, '--config', selectorFile, '--confirm', 'adopt']), { run, out: { write() {} }, interactive: false }),
    /noticeos \(running, unhealthy\) is not healthy; adopt moves a healthy stack/u);
  assert.ok(!calls.some((line) => / (stop|up|config)\b/u.test(line)), calls.join('\n'));
});
