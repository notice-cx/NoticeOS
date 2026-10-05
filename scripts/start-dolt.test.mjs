import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkBeadsCli, createFreshOsAsset, preflightStartedTasks, prepareStartedTasks, scrubTaskEnvironment } from './start-dolt.mjs';
import { startDoltPlan } from './dolt-host.mjs';
import { resolveTaskProjects } from './task-project-config.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { initDoltProject } from './dolt-project.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-start-tasks-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'installation-home');
  const plan = { root: base, home, port: 5450, installation: path.join(home, 'installation') };
  fs.mkdirSync(path.join(base, 'config'));
  fs.writeFileSync(path.join(base, 'config', 'integrations.json'), JSON.stringify({ version: 1, assets: {}, catalog: [{ id: 'fixture-source' }] }));
  fs.writeFileSync(path.join(base, 'config', 'signal-panels.json'), JSON.stringify({ version: 1, assets: {}, maxRows: 10 }));
  const binary = path.join(base, 'bd');
  fs.writeFileSync(binary, '', { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: base, BEADS_DOLT_PASSWORD: 'discard', BD_DOLT_SERVER_SOCKET: 'discard', BEADS_CREDENTIALS_FILE: 'discard' };
  const calls = [];
  const run = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === 'init' && bin === binary) {
      fs.mkdirSync(path.join(options.cwd, '.beads'));
      fs.writeFileSync(path.join(options.cwd, '.beads', 'config.yaml'), 'sync.remote: bad\nimport.auto: true\nno-git-ops: false\n');
      fs.writeFileSync(path.join(options.cwd, '.beads', 'metadata.json'), JSON.stringify({ dolt_mode: 'server', dolt_database: 'noticeos_tasks', dolt_server_host: '127.0.0.1', dolt_server_port: 5453, dolt_server_user: 'noticeos' }));
    }
    return { code: 0, stdout: args[0] === 'version' ? 'bd version 1.3.1 (synthetic)' : args.includes('rev-parse') ? fs.realpathSync(options.cwd) : '', stderr: '' };
  };
  const flight = async () => ({ ok: true, profile: startDoltPlan(plan) });
  const host = async () => {
    const profile = startDoltPlan(plan);
    fs.mkdirSync(path.join(home, 'dolt'), { recursive: true });
    fs.mkdirSync(profile.secretsDir, { recursive: true });
    fs.writeFileSync(path.join(profile.secretsDir, 'root'), `${'c'.repeat(64)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(profile.secretsDir, 'noticeos'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
    fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${'a'.repeat(64)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'dolt', 'profile.json'), JSON.stringify(profile));
    return { ok: true, profile };
  };
  const init = (args, options) => initDoltProject(args, { ...options, executor: async () => async () => ({ code: 0, stdout: JSON.stringify({ rows: [{ Database: 'information_schema' }] }) }) });
  return { plan, binary, env, calls, run, flight, host, init };
}

test('CLI prerequisite rejects unavailable/wrong versions before any install state or Docker work', async t => {
  const f = fixture(t);
  const unavailable = await checkBeadsCli({ env: {}, binary: path.join(f.plan.root, 'absent') });
  assert.equal(unavailable.ok, false);
  let docker = 0;
  const rejected = await preflightStartedTasks(f.plan, { ...f, run: async () => ({ code: 0, stdout: 'bd version 1.2.0' }), flight: async () => { docker++; } });
  assert.equal(rejected.ok, false);
  assert.equal(docker, 0);
  assert.equal(fs.existsSync(f.plan.home), false);
});

test('preflight CLI cannot read inherited credentials or project/global config', async t => {
  const f = fixture(t);
  const result = await preflightStartedTasks(f.plan, f);
  assert.equal(result.ok, true);
  const version = f.calls[0];
  assert.equal(version.args[0], 'version');
  assert.notEqual(version.options.cwd, f.plan.root);
  assert.deepEqual(Object.keys(version.options.env).filter(key => /^(BD_|BEADS_|DOLT_|MYSQL_)/u.test(key)), ['BD_DISABLE_METRICS']);
  assert.equal(fs.existsSync(f.plan.home), false);
});

test('old/manual installations never create a hub; partial task files refuse before CLI', async t => {
  const f = fixture(t);
  assert.equal((await preflightStartedTasks(f.plan, { ...f, env: { DATABASE_URL: 'synthetic' } })).enabled, false);
  fs.mkdirSync(f.plan.home);
  fs.writeFileSync(path.join(f.plan.home, 'kept'), 'unchanged');
  assert.equal((await preflightStartedTasks(f.plan, f)).enabled, false);
  fs.mkdirSync(path.join(f.plan.home, 'dolt'));
  assert.equal((await preflightStartedTasks(f.plan, f)).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.plan.home, 'kept'), 'utf8'), 'unchanged');
});

test('interrupted required first setup cannot fall through to legacy startup without tasks', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.plan.home, '.noticeos-first-start'), { recursive: true });
  fs.writeFileSync(path.join(f.plan.home, '.noticeos-first-start', 'tasks-required'), 'required');
  assert.equal((await preflightStartedTasks(f.plan, f)).ok, false);
  assert.equal(f.calls.length, 0);
});

test('fresh task bootstrap saves one valid core project and repeats without init or asset writes', async t => {
  const f = fixture(t);
  const checked = await preflightStartedTasks(f.plan, f);
  fs.mkdirSync(f.plan.home);
  let assets = 0;
  const result = await prepareStartedTasks(f.plan, checked, { ...f, fresh: true, address: 'synthetic-only', asset: async () => { assets++; return 'os-0123456789abcdef'; } });
  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(f.plan.installation, 'beads.json')));
  const local = JSON.parse(fs.readFileSync(path.join(f.plan.installation, 'task-host.json')));
  assert.equal(resolveTaskProjects(saved, local)[0].repo, path.join(f.plan.home, 'tasks', 'noticeos'));
  assert.equal(saved.spokes.length, 1);
  const roster = JSON.parse(fs.readFileSync(path.join(f.plan.installation, 'integrations.json')));
  assert.deepEqual(Object.keys(roster.assets), ['os-0123456789abcdef']);
  assert.deepEqual(roster.catalog, [{ id: 'fixture-source' }]);
  const panels = JSON.parse(fs.readFileSync(path.join(f.plan.installation, 'signal-panels.json')));
  assert.deepEqual(Object.keys(panels.assets), Object.keys(roster.assets));
  assert.equal(panels.assets['os-0123456789abcdef'].enabled, false);
  assert.equal(panels.maxRows, 10);
  assert.equal(saved.hub.port, 5453);
  const init = f.calls.find(row => row.args[0] === 'init' && row.bin === f.binary);
  assert.equal(init.args.includes('--server-port'), true);
  assert.equal(init.args.includes('--external'), true);
  assert.equal(init.options.env.BEADS_CREDENTIALS_FILE, path.join(f.plan.home, 'dolt', 'credentials'));
  assert.equal(init.options.env.BEADS_DOLT_PASSWORD === 'a'.repeat(64), true);
  assert.equal(JSON.stringify(init.args).includes('a'.repeat(64)), false);
  assert.equal(result.env.BEADS_DOLT_PASSWORD, undefined);
  const yaml = fs.readFileSync(path.join(f.plan.home, 'tasks', 'noticeos', '.beads', 'config.yaml'), 'utf8');
  assert.equal(yaml.includes('sync.remote:'), false);
  assert.equal(yaml.includes('no-git-ops: true\nimport.auto: false'), true);
  const before = JSON.stringify(saved);
  const repeated = await preflightStartedTasks(f.plan, f);
  assert.equal(repeated.fresh, false);
  assert.equal((await prepareStartedTasks(f.plan, repeated, { ...f, asset: async () => { throw new Error('must not write'); } })).ok, true);
  assert.equal(assets, 1);
  assert.equal(f.calls.filter(row => row.bin === f.binary && row.args[0] === 'init').length, 1);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(f.plan.installation, 'beads.json')))), before);
  fs.writeFileSync(path.join(f.plan.home, 'tasks', 'noticeos', '.beads', 'metadata.json'), JSON.stringify({ dolt_mode: 'embedded' }));
  assert.equal((await preflightStartedTasks(f.plan, f)).ok, false, 'a changed or redirected core project cannot restart');
});

test('fresh provenance required; failed init preserves partial files and blocks next startup', async t => {
  const f = fixture(t);
  const checked = await preflightStartedTasks(f.plan, f);
  assert.equal((await prepareStartedTasks(f.plan, checked, f)).ok, false);
  assert.equal(fs.existsSync(f.plan.home), false);
  fs.mkdirSync(f.plan.home);
  const failed = await prepareStartedTasks(f.plan, checked, { ...f, fresh: true, run: async () => ({ code: 1, stderr: 'private synthetic diagnostic' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.line.includes('private synthetic'), false);
  assert.equal(fs.existsSync(path.join(f.plan.home, 'dolt')), true);
  assert.equal((await preflightStartedTasks(f.plan, f)).ok, false);
});

test('OS bootstrap is workspace scoped, creates no user site, and refuses all existing assets', async () => {
  const calls = [];
  const store = () => ({ onlyWorkspace: async () => 'own-workspace', close: async () => calls.push('close'),
    inWorkspace: async (workspace, work) => work({ query: async () => [], execute: async (sql, values) => calls.push({ workspace, sql, values }) }) });
  assert.equal(await createFreshOsAsset('synthetic', { store, id: 'os-0123456789abcdef' }), 'os-0123456789abcdef');
  assert.equal(calls[0].workspace, 'own-workspace');
  assert.equal(calls[0].sql.includes("NULL, 'NoticeOS', 'live', true"), true);
  assert.equal(calls[0].sql.includes('list_position'), false);
  let wrote = false;
  await assert.rejects(createFreshOsAsset('synthetic', { store: () => ({ onlyWorkspace: async () => 'own', close: async () => {},
    inWorkspace: async (_, work) => work({ query: async () => [{ asset_id: 'kept' }], execute: async () => { wrote = true; } }) }) }));
  assert.equal(wrote, false);
});

test('Tower task selectors and credentials are scrubbed without changing toolchain HOME', () => {
  assert.deepEqual(scrubTaskEnvironment({ HOME: '/synthetic', PATH: '/bin', BD_ACTOR: 'old', BEADS_DOLT_PASSWORD: 'old', DOLT_ROOT_PATH: 'old', MYSQL_PWD: 'old' }), { HOME: '/synthetic', PATH: '/bin' });
});

test('actual application-role OS bootstrap uses numbering trigger and leaves the next position for a user site', { timeout: 60_000 }, async t => {
  let cluster;
  try { cluster = await startTestCluster(); }
  catch (error) { const reason = unavailableReason(error); if (reason === null || postgresRequired()) throw error; return t.skip(reason); }
  t.after(() => cluster.close());
  const database = await cluster.createDatabase();
  const address = cluster.url(database);
  const osAsset = await createFreshOsAsset(address);
  const db = openStore(address, { maxConnections: 1 });
  try {
    const workspace = await db.onlyWorkspace();
    await db.inWorkspace(workspace, async tx => {
      const initial = await tx.query('SELECT asset_id, is_os, domain, display_name, list_position FROM noticeos.assets ORDER BY list_position');
      assert.equal(initial.length, 1);
      assert.deepEqual(initial[0], { asset_id: osAsset, is_os: true, domain: null, display_name: 'NoticeOS', list_position: 1n });
      await tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1, 'fixture-site', 'example.com', 'Fixture', 'live')", [workspace]);
      const positions = await tx.query('SELECT is_os, list_position FROM noticeos.assets ORDER BY list_position');
      assert.deepEqual(positions, [{ is_os: true, list_position: 1n }, { is_os: false, list_position: 2n }]);
    });
    await assert.rejects(createFreshOsAsset(address));
  } finally { await db.close(); }
});
