import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectDoltMigration, main } from './dolt-migration-inspect.mjs';

const SECRET = 'synthetic-secret-never-output';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-migration-metadata-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'os'); const installation = path.join(root, 'installation');
  const repo = path.join(base, 'asset');
  fs.mkdirSync(installation, { recursive: true }); fs.mkdirSync(path.join(repo, '.beads'), { recursive: true });
  const project = { asset: 'example', prefix: 'ex', database: 'example_tasks' };
  const hub = { host: '127.0.0.1', port: 3308, user: 'root', dataDir: '/fixture/old-hub', password: SECRET };
  const host = { repositories: [{ ...project, repo: '../asset', credential: SECRET }], secret: SECRET };
  const map = { hub, spokes: [{ ...project, repo: '/ignored/legacy/path', task: { body: SECRET } }] };
  const metadata = { dolt_mode: 'server', dolt_database: project.database, dolt_server_host: hub.host,
    dolt_server_port: hub.port, dolt_server_user: hub.user, project_id: 'fixture-project-id',
    password: SECRET, task_body: SECRET, database: '/never/open/private-db' };
  const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  writeJson(path.join(installation, 'task-host.json'), host); writeJson(path.join(installation, 'beads.json'), map);
  fs.writeFileSync(path.join(installation, 'dolt-server.yaml'), `listener:\n  host: "127.0.0.1" # explicit\n  port: 3308\ndata_dir: '/fixture/old-hub'\ncfg_dir: /fixture/old-hub/.doltcfg\nuser:\n  name: root\n  password: ${SECRET}\n`);
  writeJson(path.join(repo, '.beads', 'metadata.json'), metadata);
  fs.writeFileSync(path.join(repo, '.beads', 'config.yaml'), `issue-prefix: ex\nno-git-ops: true\nimport.auto: false\nsync.remote: 'https://user:${SECRET}@example.invalid/hub'\npassword: ${SECRET}\n`);
  const reads = []; const stats = [];
  const io = { ...fs, openSync(file, ...args) { reads.push(file); return fs.openSync(file, ...args); },
    lstatSync(file, ...args) { stats.push(file); return fs.lstatSync(file, ...args); } };
  return { base, root, installation, repo, project, hub, host, map, metadata, writeJson, reads, stats, io,
    options: { repoRoot: root, installation, spokes: [repo] } };
}

function refused(action) {
  assert.throws(action, error => error.message === 'Task migration metadata refused; check explicit paths and file formats.');
}

test('maps-only reads exactly three declared files and never opens or stats a spoke or data path', t => {
  const f = fixture(t);
  const result = inspectDoltMigration({ ...f.options, spokes: [], mapsOnly: true }, { fs: f.io });
  assert.deepEqual(f.reads, result.reads);
  assert.equal(result.reads.length, 3); assert.equal(result.storedMembershipVerified, false);
  assert.equal(result.projects[0].repo, f.repo);
  assert.equal(result.projects[0].metadata, undefined);
  assert.ok(f.stats.every(file => !file.startsWith(f.repo) && !file.startsWith('/fixture')));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('full mode reads only exact approved declared spoke files and outputs allowlisted metadata', t => {
  const f = fixture(t);
  const result = inspectDoltMigration(f.options, { fs: f.io });
  assert.deepEqual(f.reads, result.reads); assert.equal(result.reads.length, 5);
  assert.deepEqual(result.projects[0].metadata, { mode: 'server', database: 'example_tasks', host: '127.0.0.1',
    port: 3308, user: 'root', projectId: 'fixture-project-id', config: { prefix: 'ex', noGitOps: true, importAuto: false, syncRemotePresent: true } });
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('/ignored/legacy/path'));
  assert.ok(!f.stats.some(file => file.startsWith('/fixture')));
});

test('source-shaped maps allow domain asset ids and preserve raw plus repository-resolved hub paths', t => {
  const f = fixture(t);
  const map = JSON.parse(fs.readFileSync(new URL('./fixture-config/beads.json', import.meta.url), 'utf8'));
  f.writeJson(path.join(f.installation, 'beads.json'), map);
  f.writeJson(path.join(f.installation, 'task-host.json'), { repositories: map.spokes });
  const data = path.join(f.root, '.local', 'beads-dolt');
  fs.writeFileSync(path.join(f.installation, 'dolt-server.yaml'), `listener:\n  host: 127.0.0.1\n  port: 3308\ndata_dir: ${data}\n`);
  const result = inspectDoltMigration({ ...f.options, mapsOnly: true, spokes: [] }, { fs: f.io });
  assert.equal(result.hub.dataDir, '.local/beads-dolt');
  assert.equal(result.hub.dataDirResolved, data);
  assert.equal(result.projects.length, map.spokes.length);
  assert.equal(result.projects[1].asset, 'meals.example');
  assert.equal(result.server.user, undefined);
  assert.deepEqual(result.server.pathResolution.data_dir, { resolved: data, basis: 'absolute' });
  assert.deepEqual(f.reads, result.reads);
  assert.ok(!f.stats.some(file => file.startsWith(data)));
});

test('relative native-server paths retain unknown working-directory resolution without guesses or data reads', t => {
  const f = fixture(t);
  f.writeJson(path.join(f.installation, 'beads.json'), { ...f.map, hub: { ...f.hub, dataDir: '.local/beads-dolt' } });
  fs.writeFileSync(path.join(f.installation, 'dolt-server.yaml'), 'listener:\n  host: 127.0.0.1\n  port: 3308\ndata_dir: .local/beads-dolt\ncfg_dir: .doltcfg\nprivilege_file: .doltcfg/privileges.db\nbranch_control_file: .doltcfg/branch_control.db\n');
  const result = inspectDoltMigration({ ...f.options, mapsOnly: true, spokes: [] }, { fs: f.io });
  assert.equal(result.hub.dataDirResolved, path.join(f.root, '.local', 'beads-dolt'));
  for (const key of ['data_dir', 'cfg_dir', 'privilege_file', 'branch_control_file']) {
    assert.deepEqual(result.server.pathResolution[key], { resolved: null, basis: 'unknown-server-working-directory' });
  }
  assert.deepEqual(f.reads, result.reads);
  assert.ok(f.stats.every(file => !file.includes('.local') && !file.includes('.doltcfg')));
});

test('omitted spoke selectors and project identity are unknown rather than invented defaults', t => {
  const f = fixture(t);
  f.writeJson(path.join(f.repo, '.beads', 'metadata.json'), { dolt_database: f.project.database, database: '/never/open/private-db' });
  fs.writeFileSync(path.join(f.repo, '.beads', 'config.yaml'), '# Defaults may live elsewhere.\n');
  const result = inspectDoltMigration(f.options, { fs: f.io });
  assert.deepEqual(result.projects[0].metadata, { projectId: null, mode: null, database: f.project.database,
    host: null, port: null, user: null, config: { prefix: null, noGitOps: null, importAuto: null, syncRemotePresent: false } });
  assert.deepEqual(f.reads, result.reads);
});

test('all unapproved/extra/duplicate spokes refuse before any spoke filesystem access', t => {
  const f = fixture(t);
  for (const spokes of [[], [path.join(f.base, 'wrong')], [f.repo, path.join(f.base, 'extra')], [f.repo, f.repo]]) {
    refused(() => inspectDoltMigration({ ...f.options, spokes }, { fs: f.io }));
  }
  assert.ok(f.reads.every(file => file.startsWith(f.installation)));
  assert.ok(f.stats.every(file => !file.startsWith(f.repo)));
});

test('malformed or contradictory installation maps and listener refuse without raw input diagnostics', t => {
  const f = fixture(t);
  const hostFile = path.join(f.installation, 'task-host.json');
  for (const bad of [{ repositories: [] }, { repositories: [f.host.repositories[0], f.host.repositories[0]] },
    { repositories: [{ ...f.host.repositories[0], database: 'wrong' }] }]) {
    f.writeJson(hostFile, bad); refused(() => inspectDoltMigration(f.options));
  }
  f.writeJson(hostFile, f.host);
  fs.writeFileSync(path.join(f.installation, 'dolt-server.yaml'), `listener:\n  host: 0.0.0.0\n  port: 3308\ndata_dir: /fixture/old-hub\npassword: ${SECRET}`);
  refused(() => inspectDoltMigration(f.options));
  fs.writeFileSync(hostFile, `{malformed ${SECRET}`); refused(() => inspectDoltMigration(f.options));
});

test('metadata cannot silently redirect source endpoint, database, prefix or account', t => {
  const f = fixture(t); const file = path.join(f.repo, '.beads', 'metadata.json');
  for (const [key, value] of [['dolt_server_host', 'remote.invalid'], ['dolt_database', 'wrong'], ['dolt_server_port', 3306], ['dolt_server_user', 'wrong'], ['dolt_mode', 'embedded']]) {
    f.writeJson(file, { ...f.metadata, [key]: value }); refused(() => inspectDoltMigration(f.options));
  }
  f.writeJson(file, f.metadata);
  fs.writeFileSync(path.join(f.repo, '.beads', 'config.yaml'), 'issue-prefix: wrong\n');
  refused(() => inspectDoltMigration(f.options));
});

test('missing, oversized, symlink and linked ancestor files fail closed', t => {
  const f = fixture(t); const file = path.join(f.installation, 'task-host.json');
  fs.rmSync(file); refused(() => inspectDoltMigration(f.options));
  fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1)); refused(() => inspectDoltMigration(f.options));
  fs.rmSync(file); const other = path.join(f.base, 'outside.json'); f.writeJson(other, f.host);
  fs.symlinkSync(other, file); refused(() => inspectDoltMigration(f.options));
  fs.rmSync(file); f.writeJson(file, f.host);
  const linked = path.join(f.base, 'linked-installation'); fs.symlinkSync(f.installation, linked);
  refused(() => inspectDoltMigration({ ...f.options, installation: linked }));
  fs.renameSync(path.join(f.repo, '.beads'), path.join(f.base, 'other-beads'));
  fs.symlinkSync(path.join(f.base, 'other-beads'), path.join(f.repo, '.beads'));
  refused(() => inspectDoltMigration(f.options));
});

test('selected YAML syntax is explicit: quoting/comments supported, aliases/duplicates/complex forms refuse', t => {
  const f = fixture(t); const file = path.join(f.installation, 'dolt-server.yaml');
  for (const value of ['*elsewhere', '&anchor /fixture/old-hub', '["/fixture/old-hub"]', '|', '"unterminated']) {
    fs.writeFileSync(file, `listener:\n  host: 127.0.0.1\n  port: 3308\ndata_dir: ${value}\n`);
    refused(() => inspectDoltMigration(f.options));
  }
  fs.writeFileSync(file, 'listener:\n  host: 127.0.0.1\n  port: 3308\ndata_dir: /fixture/old-hub\ndata_dir: /other\n');
  refused(() => inspectDoltMigration(f.options));
});

test('retired physical projects remain in inspection even outside exported membership', t => {
  const f = fixture(t); const retired = { asset: 'retired', prefix: 'rt', database: 'retired_tasks', repo: '../retired' };
  f.writeJson(path.join(f.installation, 'task-host.json'), { repositories: [...f.host.repositories, retired] });
  const result = inspectDoltMigration({ ...f.options, mapsOnly: true, spokes: [] }, { fs: f.io });
  assert.equal(result.projects.length, 2); assert.equal(result.projects[1].active, false);
  assert.equal(result.projects[1].database, 'retired_tasks');
  assert.ok(f.stats.every(file => !file.startsWith(path.join(f.base, 'retired'))));
});

test('CLI requires explicit paths, supports a no-I/O help, and never emits secret/raw failure text', t => {
  const f = fixture(t); let output = ''; let error = '';
  const sinks = { stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } } };
  assert.equal(main([], sinks), 1); assert.equal(output, '');
  assert.equal(main(['--help'], { ...sinks, inspect() { assert.fail('help must not inspect'); } }), 0);
  output = ''; error = '';
  assert.equal(main(['--repo-root', f.root, '--installation', f.installation, '--spoke', f.repo], sinks), 0);
  assert.equal(JSON.parse(output).scope, 'maps-and-spokes'); assert.ok(!output.includes(SECRET));
  output = ''; error = '';
  assert.equal(main(['--repo-root', f.root, '--repo-root', f.root], sinks), 1);
  assert.equal(main(['--unknown', SECRET], sinks), 1); assert.equal(output, ''); assert.ok(!error.includes(SECRET));
  assert.equal(main(['--repo-root', f.root, '--installation', f.installation, '--maps-only'], { ...sinks, inspect() { throw Error(SECRET); } }), 1);
  assert.ok(!error.includes(SECRET));
});

test('real maps-only CLI ignores poisoned host selectors and leaves synthetic files unchanged', t => {
  const f = fixture(t);
  function snapshot(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(folder, entry.name);
      return entry.isDirectory() ? [{ file, directory: true }, ...snapshot(file)] : [{ file, mode: fs.statSync(file).mode, bytes: fs.readFileSync(file).toString('base64') }];
    });
  }
  const before = snapshot(f.base);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./dolt-migration-inspect.mjs', import.meta.url)),
    '--repo-root', f.root, '--installation', f.installation, '--maps-only'], {
    encoding: 'utf8', env: { HOME: '/never/use/inherited-home', NOTICEOS_INSTALLATION_DIR: '/never/use/inherited-installation',
      BEADS_DIR: '/never/use/inherited-beads', BEADS_DB: '/never/use/inherited-db', BEADS_CREDENTIALS_FILE: '/never/use/inherited-credentials',
      BEADS_DOLT_SERVER_HOST: 'remote.invalid', BEADS_DOLT_SERVER_PORT: '65535', BEADS_DOLT_SERVER_PASSWORD: SECRET,
      DOLT_SERVER_HOST: 'remote.invalid', DOLT_SERVER_PASSWORD: SECRET, MYSQL_HOST: 'remote.invalid', MYSQL_PWD: SECRET,
      DOCKER_HOST: 'tcp://remote.invalid:2375', NOTICEOS_DOLT_HOME: '/never/use/inherited-dolt' }
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), inspectDoltMigration({ ...f.options, mapsOnly: true, spokes: [] }));
  assert.ok(!result.stdout.includes(SECRET));
  assert.deepEqual(snapshot(f.base), before);
});
