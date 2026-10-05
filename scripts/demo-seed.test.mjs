import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoInstallation, demoTargetRefusal, evaluateDemoWatch, fillDemo, main, markDemoDevelopment, recordDemoOsObservation, REQUIRED_DEMO_ENTRIES, verifyDemoRelease } from './demo-seed.mjs';
import { runCommand } from './run-command.mjs';
import { generateDemoScenario } from './demo-scenario.mjs';

const root = path.resolve(import.meta.dirname, '..');
const scenario = () => generateDemoScenario({ seed: 'refusal-proof', cutoff: '2025-10-16T12:00:00.000Z', release: '1'.repeat(40) });

test('synthetic OS reporting uses the released store observer before workflow history and refuses invented scheduler evidence', async () => {
  const facts = scenario(), os = facts.assets.find(asset => asset.isOs);
  const observed = ['pulsesReceived', 'ledgerRows', 'openFlagsError', 'openFlagsWarn', 'openFlagsInfo'];
  for (const defect of [null, 'held-jobs', 'unknown-jobs', 'no-os', 'missing-report', 'scheduler', 'heartbeat']) {
    let called = false;
    const report = { asset: os.id, generatedAt: facts.manifest.cutoff, capabilities: [...observed], metrics: Object.fromEntries(observed.map(metric => [metric, { last24h: 0, avg7d: 0, total: 0 }])) };
    if (defect === 'scheduler') { report.capabilities.push('cronRunSuccess'); report.metrics.cronRunSuccess = { last24h: 1, avg7d: 1, total: 1 }; }
    if (defect === 'heartbeat') report.capabilities.push('runnerHeartbeat');
    const capability = { STORE: { read: work => work({ query: async (sql, args) => {
      if (sql.includes('job_runs')) return defect === 'unknown-jobs' ? [] : [{ jobs: defect === 'held-jobs' ? 1 : 0 }];
      assert.deepEqual(args, [os.id, facts.manifest.cutoff]);
      return defect === 'missing-report' ? [] : [{ envelope: JSON.stringify(report) }];
    } }) } };
    const released = async (received, at) => { called = true; assert.equal(received, capability); assert.equal(at, Date.parse(facts.manifest.cutoff)); return defect === 'no-os' ? null : { pulseId: 1 }; };
    if (defect) await assert.rejects(recordDemoOsObservation(capability, facts, released));
    else assert.deepEqual(await recordDemoOsObservation(capability, facts, released), { synthetic: true, ...report });
    assert.equal(called, !['held-jobs', 'unknown-jobs'].includes(defect));
  }
});

test('the unchanged demo watch reads only its own store, records before task closure and cannot change ledger rows', async () => {
  const facts = scenario();
  for (const defect of [null, 'late', 'ledger', 'binding', 'failed']) {
    let ledgerReads = 0; let evaluated = false;
    const expected = facts.manifest.stories.repair.checkAt;
    const store = { inWorkspace: async (workspace, work, options) => {
      assert.equal(workspace, facts.manifest.workspaceId);
      assert.deepEqual(options, { readOnly: true });
      return work({ query: async (sql, args) => {
        if (sql.includes('ledger_entries')) return [{ row: JSON.stringify({ amount: defect === 'ledger' && ledgerReads++ ? 101 : 100 }) }];
        assert.deepEqual(args, [facts.manifest.stories.repair.watchId]);
        return [{ status: 'closed', outcome: 'ship_confirmed', closed_at: defect === 'late' ? facts.manifest.cutoff : expected, checked_at: expected, baseline: '{"days":28}', post: '{"days":28}' }];
      } });
    } };
    const run = async (env, now) => {
      evaluated = true; assert.equal(now, Date.parse(expected));
      if (defect === 'binding') return env.SIGNAL_RAW;
      return { failed: defect === 'failed' ? [{ id: 'failed' }] : [], overdue: [], closed: [{ id: facts.manifest.stories.repair.watchId, outcome: 'ship_confirmed' }] };
    };
    if (defect) await assert.rejects(evaluateDemoWatch(store, facts, run));
    else { const receipt = await evaluateDemoWatch(store, facts, run); assert.equal(receipt.evaluatedAt, expected); assert.match(receipt.ledgerSha256, /^[a-f0-9]{64}$/u); }
    assert.equal(evaluated, true);
  }
});
function folder(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'noticeos-demo-refusal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const plan = home => ({ root, home, port: 6020, doorPort: 6021, mark: path.join(home, '.made-by-pnpm-start') });

test('existing folders, private targets and inherited installation selectors refuse before preparation', async t => {
  const dir = folder(t);
  const held = path.join(dir, 'held'); mkdirSync(held); writeFileSync(path.join(held, 'keep'), 'unchanged');
  const link = path.join(dir, 'link'); symlinkSync(held, link);
  const fixtureRoot = path.join(dir, 'public-source'); mkdirSync(fixtureRoot);
  const calls = [];
  const options = { prepare: async () => { calls.push('prepare'); throw new Error('unexpected'); }, open: () => { calls.push('open'); throw new Error('unexpected'); }, loadEvaluator: async () => { calls.push('evaluator'); throw new Error('unexpected'); } };
  for (const home of [held, link, fixtureRoot, path.join(fixtureRoot, 'installation', 'new-demo'), path.join(fixtureRoot, '.local/runtime', 'new-demo')]) {
    await assert.rejects(createDemoInstallation({ home, root: fixtureRoot, port: 6020, scenario: scenario(), env: {} }, options));
  }
  for (const key of ['DATABASE_URL', 'NOTICEOS_POSTGRES_SECRETS', 'NOTICEOS_POSTGRES_PORT', 'NOTICEOS_HOME', 'NOTICEOS_INSTALLATION_DIR', 'NOTICEOS_DOLT_HOME']) {
    await assert.rejects(createDemoInstallation({ home: path.join(dir, 'new'), port: 6020, scenario: scenario(), env: { [key]: 'private-target' } }, options));
  }
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(path.join(held, 'keep'), 'utf8'), 'unchanged');
});

test('a setup that cannot prove it created the database never opens its store', async t => {
  const dir = folder(t);
  for (const result of [{ ok: false, line: 'uncertain' }, { ok: true, created: false, env: {} }]) {
    let opened = false;
    await assert.rejects(createDemoInstallation({ home: path.join(dir, 'new'), port: 6020, scenario: scenario(), env: {} }, {
      prepare: async () => result,
      open: () => { opened = true; throw new Error('unexpected store'); },
      loadEvaluator: async () => ({ evaluatePulse: () => [], provenance: null }),
    }), /did not prove a new database/u);
    assert.equal(opened, false);
  }
});

async function committedSource(t) {
  const dir = folder(t);
  const entries = REQUIRED_DEMO_ENTRIES;
  for (const entry of entries) { mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true }); writeFileSync(path.join(dir, entry), 'export {};\n'); }
  const git = async args => { const result = await runCommand('git', ['-C', dir, ...args], { timeoutMs: 5000 }); assert.equal(result.code, 0); return result.stdout.trim(); };
  await git(['init']); await git(['add', '--', ...entries]);
  await git(['-c', 'user.name=Demo fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Own synthetic release']);
  return { dir, release: await git(['rev-parse', 'HEAD']) };
}

test('dirty, untracked or uncommitted public inputs cannot claim exact release provenance', async t => {
  const { dir, release } = await committedSource(t);
  assert.equal((await verifyDemoRelease(dir, release)).release, release);
  writeFileSync(path.join(dir, 'packages/contract/src/rules.ts'), 'export const changed = true;\n');
  await assert.rejects(verifyDemoRelease(dir, release), /clean, committed/u);
  writeFileSync(path.join(dir, 'packages/contract/src/rules.ts'), 'export {};\n');
  writeFileSync(path.join(dir, 'scripts/untracked.mjs'), 'export {};\n');
  await assert.rejects(verifyDemoRelease(dir, release), /clean, committed/u);
  rmSync(path.join(dir, 'scripts/untracked.mjs'));
  rmSync(path.join(dir, 'scripts/demo-store.mjs'));
  await assert.rejects(verifyDemoRelease(dir, release), /clean, committed/u);
});

test('release checks ignore planted Git selectors and cannot run caller filesystem monitors', async t => {
  const own = await committedSource(t);
  const redirected = await committedSource(t);
  const distinct = await runCommand('git', ['-C', redirected.dir, '-c', 'user.name=Demo fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'A separate caller checkout']);
  assert.equal(distinct.code, 0);
  const head = await runCommand('git', ['-C', redirected.dir, 'rev-parse', 'HEAD']);
  assert.equal(head.code, 0);
  redirected.release = head.stdout.trim();
  assert.notEqual(redirected.release, own.release);
  const caller = folder(t);
  const touched = path.join(caller, 'monitor-ran');
  const monitor = path.join(caller, 'monitor');
  writeFileSync(monitor, `#!/bin/sh\nprintf invoked > '${touched}'\n`, { mode: 0o700 });
  const configuration = path.join(caller, 'gitconfig');
  writeFileSync(configuration, `[core]\nfsmonitor = ${monitor}\n`);
  const local = await runCommand('git', ['-C', own.dir, 'config', 'core.fsmonitor', monitor]);
  assert.equal(local.code, 0);
  const env = { PATH: process.env.PATH, HOME: caller,
    GIT_DIR: path.join(redirected.dir, '.git'), GIT_WORK_TREE: redirected.dir,
    GIT_INDEX_FILE: path.join(caller, 'foreign-index'), GIT_CONFIG_GLOBAL: configuration,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: monitor };
  assert.equal((await verifyDemoRelease(own.dir, own.release, { env })).release, own.release);
  assert.equal(existsSync(touched), false);
  assert.equal(existsSync(env.GIT_INDEX_FILE), false);
  await assert.rejects(verifyDemoRelease(own.dir, redirected.release, { env }), /differs from this checkout/u);
});

test('an old dist cannot replace a failed verified-source build or trigger setup', async t => {
  const { dir, release } = await committedSource(t);
  const dist = path.join(dir, 'packages/contract/dist/packages/contract/src'); mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dir, '.git/info/exclude'), 'packages/contract/dist/\n');
  const artifact = path.join(dist, 'rules.js'); writeFileSync(artifact, 'throw new Error("An old artifact was loaded");\n');
  let prepared = false;
  const facts = generateDemoScenario({ seed: 'stale-build', cutoff: '2025-10-16T12:00:00.000Z', release });
  await assert.rejects(createDemoInstallation({ root: dir, home: path.join(dir, 'new-demo'), port: 6020, scenario: facts, env: {} }, {
    prepare: async () => { prepared = true; },
  }), /verified demo contract could not be built/u);
  assert.equal(prepared, false);
  assert.equal(readFileSync(artifact, 'utf8'), 'throw new Error("An old artifact was loaded");\n');
});

test('future observations refuse before creating installation resources', async t => {
  const dir = folder(t);
  const future = generateDemoScenario({ seed: 'future', cutoff: '9999-10-16T12:00:00.000Z', release: '1'.repeat(40) });
  let called = false;
  await assert.rejects(createDemoInstallation({ home: path.join(dir, 'new'), port: 6020, scenario: future, env: {} }, {
    prepare: async () => { called = true; }, loadEvaluator: async () => { called = true; },
  }), /after the current time/u);
  assert.equal(called, false);
});

test('a database without the development mark or with any held data receives no inserts', async () => {
  for (const mark of [null, 'installation']) {
    const sent = [];
    const tx = { workspaceId: '11111111-1111-4111-8111-111111111111', query: async sql => { sent.push(sql); return [{ profile: mark }]; }, execute: async () => { throw new Error('unexpected insert'); } };
    await assert.rejects(fillDemo(tx, scenario(), { evaluatePulse: () => [] }), /not marked for development/u);
    assert.equal(sent.length, 2);
  }
  for (const heldTable of ['assets', 'pulses', 'ledger_entries', 'integration_connections']) {
    let inserted = false;
    const tx = { workspaceId: '11111111-1111-4111-8111-111111111111', query: async sql => {
      if (sql.includes('current_setting')) return [{ profile: 'development' }];
      if (sql.includes('count(*)')) return [Object.fromEntries([...sql.matchAll(/AS (\w+)/gu)].map(([, table]) => [table, table === heldTable ? 1 : 0]))];
      return [];
    }, execute: async () => { inserted = true; } };
    await assert.rejects(fillDemo(tx, scenario(), { evaluatePulse: () => [] }), /already holding data/u);
    assert.equal(inserted, false);
  }
});

test('facts changed independently of the manifest refuse before any database query', async () => {
  const facts = scenario(); facts.daily[0].sessions++;
  let queried = false;
  const tx = { query: async () => { queried = true; }, execute: async () => {} };
  await assert.rejects(fillDemo(tx, facts, { evaluatePulse: () => [] }), /differ from their declared scenario/u);
  assert.equal(queried, false);
});

test('development marking uses only the proven new container and rejects uncertain ownership', async () => {
  const facts = scenario();
  const own = { project: 'noticeos-start-abcdef1234567890', compose: '/owned/public/compose.yaml', secrets: '/owned/new/secrets', port: 6022 };
  const id = 'a'.repeat(64); const image = 'postgres:18.6@sha256:' + 'b'.repeat(64); const volume = own.project + '_postgres-data';
  const empty = { workspaces: '1', workspace: facts.manifest.workspaceId, assets: '0', pulses: '0', ledger: '0', signals: '0', tasks: '0', connections: '0' };
  for (const defect of [null, 'history', 'workspace', 'container', 'project', 'image', 'oneoff', 'volume']) {
    const calls = [];
    const store = { inWorkspace: async (workspace, work, options) => {
      assert.equal(workspace, facts.manifest.workspaceId); assert.deepEqual(options, { readOnly: true });
      return work({ query: async sql => { assert.equal(/BEGIN|SET LOCAL|COMMIT/u.test(sql), false); return [{ ...empty, ...(defect === 'history' ? { ledger: '1' } : defect === 'workspace' ? { workspace: 'other' } : {}) }]; } });
    } };
    const run = async (command, args, options) => {
      calls.push(args); assert.equal(command, 'docker'); assert.equal(options.timeoutMs, 10_000);
      assert.equal(options.env.NOTICEOS_POSTGRES_SECRETS, own.secrets); assert.equal(options.env.NOTICEOS_POSTGRES_PORT, String(own.port));
      let stdout = '';
      if (args[0] === 'compose') stdout = JSON.stringify({ name: own.project, services: { postgres: { image } }, volumes: { 'postgres-data': { name: volume } } });
      else if (args[1] === 'ls') stdout = defect === 'container' ? '' : id;
      else if (args[0] === 'container') stdout = JSON.stringify({ id, image: defect === 'image' ? 'other' : image, labels: { 'com.docker.compose.project': defect === 'project' ? 'other' : own.project, 'com.docker.compose.service': 'postgres', 'com.docker.compose.oneoff': defect === 'oneoff' ? 'True' : 'False' }, mounts: [{ Type: 'volume', Name: volume, Destination: '/var/lib/postgresql' }] });
      else if (args[0] === 'volume') stdout = JSON.stringify({ Name: volume, Labels: { 'com.docker.compose.project': defect === 'volume' ? 'other' : own.project } });
      return { code: 0, stdout };
    };
    const execute = () => markDemoDevelopment(own, { root: '/owned/public' }, facts, store, {}, run);
    if (defect) { await assert.rejects(execute()); assert.equal(calls.some(args => args[0] === 'exec'), false); }
    else { await execute(); assert.deepEqual(calls.at(-1), ['exec', id, 'psql', '-X', '--no-password', '--username', 'postgres', '--dbname', 'noticeos', '--set', 'ON_ERROR_STOP=1', '--command', "ALTER DATABASE noticeos SET noticeos.profile = 'development';"]); }
  }
});

test('CLI requires explicit synthetic confirmation and never prints an input or raw failure', async () => {
  let output = ''; let error = '';
  const code = await main(['--seed', 'private-text'], { write: text => { output += text; } }, { write: text => { error += text; } });
  assert.equal(code, 1);
  assert.equal(output, '');
  assert.ok(error.includes('Demo seed refused'));
  assert.equal(error.includes('private-text'), false);
  assert.ok(demoTargetRefusal(plan(root), {}).includes('holds this checkout'));
  const cli = await runCommand(process.execPath, [path.join(root, 'scripts/demo-seed.mjs'), '--seed', 'private-text'], { timeoutMs: 5000 });
  assert.equal(cli.code, 1);
  assert.equal(cli.stdout, '');
  assert.ok(cli.stderr.includes('Demo seed refused'));
  assert.equal(cli.stderr.includes('private-text'), false);
});

test('demo delegates its exact workspace to guarded setup without a custom schema application', async t => {
  const dir = folder(t); const facts = scenario(); let prepared;
  await assert.rejects(createDemoInstallation({ home: path.join(dir, 'new'), port: 6320, scenario: facts, env: {} }, {
    prepare: async (plan, options) => { prepared = options; return { ok: true, created: true, env: {} }; },
    open: () => { throw new Error('must not open without schema provenance'); },
    loadEvaluator: async () => ({ evaluatePulse: () => [], provenance: null }),
  }), /did not prove a new database/u);
  assert.deepEqual(prepared.workspace, { slug: 'demo', displayName: 'Synthetic demo', workspaceId: facts.manifest.workspaceId });
  assert.equal(Object.hasOwn(prepared, 'apply'), false, 'the fresh helper owns migration/bootstrap application');
});

test('development marking follows guarded setup and the app workspace read, and a refusal closes the store without seeding', async t => {
  const dir = folder(t); const facts = scenario(); const home = path.join(dir, 'new'); const calls = [];
  const store = { onlyWorkspace: async () => { calls.push('workspace'); return facts.manifest.workspaceId; },
    inWorkspace: async () => { throw new Error('must not seed after marking refusal'); }, close: async () => { calls.push('close'); } };
  await assert.rejects(createDemoInstallation({ home, port: 6320, scenario: facts, env: {} }, {
    prepare: async (_plan, options) => {
      calls.push('prepare'); assert.equal(Object.hasOwn(options, 'apply'), false);
      const secrets = path.join(home, 'postgres/secrets'); mkdirSync(secrets, { recursive: true });
      writeFileSync(path.join(secrets, 'database.url'), 'postgresql://noticeos_app@127.0.0.1:6322/noticeos');
      return { ok: true, created: true, env: {}, schema: { frozenSha256: 'a'.repeat(64), migrations: [] } };
    }, open: url => { calls.push('open'); assert.equal(new URL(url).port, '6322'); return store; },
    mark: async (own, plan, scenario, supplied, env) => {
      calls.push('mark'); assert.equal(own.port, 6322); assert.equal(plan.home, home);
      assert.equal(scenario, facts); assert.equal(supplied, store); assert.deepEqual(env, {});
      throw new Error('synthetic marking refusal');
    }, loadEvaluator: async () => ({ evaluatePulse: () => [], provenance: null }),
  }), /synthetic marking refusal/u);
  assert.deepEqual(calls, ['prepare', 'open', 'workspace', 'mark', 'close']);
});

test('the pre-mark app pool closes before a fresh marked-session pool opens for seeding', async t => {
  const dir = folder(t); const facts = scenario(); const home = path.join(dir, 'new'); const calls = [];
  let verifiedClosed = false; let marked = false;
  const verification = { onlyWorkspace: async () => { calls.push('verify workspace'); return facts.manifest.workspaceId; },
    close: async () => { calls.push('close verification'); verifiedClosed = true; } };
  const fresh = { onlyWorkspace: async () => { calls.push('fresh workspace'); throw new Error('synthetic fresh session reached'); },
    close: async () => { calls.push('close fresh'); } };
  await assert.rejects(createDemoInstallation({ home, port: 6320, scenario: facts, env: {} }, {
    prepare: async () => {
      const secrets = path.join(home, 'postgres/secrets'); mkdirSync(secrets, { recursive: true });
      writeFileSync(path.join(secrets, 'database.url'), 'postgresql://noticeos_app@127.0.0.1:6322/noticeos');
      return { ok: true, created: true, env: {}, schema: { frozenSha256: 'a'.repeat(64), migrations: [] } };
    }, open: () => {
      if (!marked) { calls.push('open verification'); return verification; }
      assert.equal(verifiedClosed, true, 'unmarked connections are retired before any fresh session is opened');
      calls.push('open fresh'); return fresh;
    }, mark: async (_own, _plan, _scenario, store) => { assert.equal(store, verification); calls.push('mark'); marked = true; },
    loadEvaluator: async () => ({ evaluatePulse: () => [], provenance: null }),
  }), /synthetic fresh session reached/u);
  assert.deepEqual(calls, ['open verification', 'verify workspace', 'mark', 'close verification', 'open fresh', 'fresh workspace', 'close fresh']);
});
