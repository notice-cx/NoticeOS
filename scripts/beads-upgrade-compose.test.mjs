// Qualification uses generated data only. Neither Beads binary ever receives
// a real spoke, source data path, inherited selector or live endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { startDoltPlan, prepareFreshDolt, preflightDolt, doltExecutor, doltComposeArgs, doltEnvironment, readDoltCredentials, DOLT_VERSION } from './dolt-host.mjs';
import { BEADS_VERSION } from './dolt-project.mjs';
import { runCommand } from './run-command.mjs';
import { prepareHostBeads, runHostBeads } from './host-beads.mjs';
import { captureTargetState, compareTargetState } from './dolt-migration-state.mjs';
import { commandEvidence } from './test-fixtures/command-evidence.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';

for (const hasRemote of [false, true]) test(`synthetic Beads 1.1.2 moves and upgrades with ${hasRemote ? 'a declared remote' : 'no remote'}, preserving tasks, history and rollback source`, {
  skip: process.env.NOTICEOS_TEST_BEADS_UPGRADE !== '1', timeout: 240_000,
}, async t => {
  const binaries = [process.env.NOTICEOS_TEST_BEADS_OLD_BIN, process.env.NOTICEOS_TEST_BEADS_NEW_BIN];
  assert.ok(binaries.every(binary => path.isAbsolute(binary ?? '')), 'Declare both exact disposable qualification binaries');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-beads-upgrade-'));
  const root = path.resolve(import.meta.dirname, '..');
  const definitionRoot = path.join(base, 'source-definition');
  const host = path.join(definitionRoot, 'db/dolt/host');
  fs.mkdirSync(host, { recursive: true });
  for (const name of ['compose.yaml', 'server.yaml', 'start.sh', 'sql.sh', 'capture.sh', 'backup-metadata.sh', 'restore.sh', 'restore-native.sh']) fs.copyFileSync(path.join(root, 'db/dolt/host', name), path.join(host, name));
  const compose = path.join(host, 'compose.yaml');
  fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace(/image: dolthub\/dolt-sql-server:[^\n]+/u,
    'image: dolthub/dolt-sql-server:2.2.3@sha256:0243d2f3d1655a816d363885a7eb9e373f2aee9f96f8e289a0a0010f067314f3'));
  const homes = ['source', 'target'].map(name => path.join(base, name));
  homes.forEach(home => fs.mkdirSync(home, { mode: 0o700 }));
  const plans = homes.map((home, index) => ({ root: index ? root : definitionRoot, home, port: 5360 + index * 4 }));
  const profiles = plans.map(startDoltPlan);
  const env = { ...Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const originalExecutors = await Promise.all(profiles.map(profile => doltExecutor(profile, { env })));
  let record;
  const executors = originalExecutors.map((execute, index) => (args, timeout) => record
    ? record(`dolt-${index}`, ['docker', ...args], () => execute(args, timeout)) : execute(args, timeout));
  let uncertainRestore = false, uncertainClient = false, accepted = false;
  const cleanups = profiles.map(profile => {
    const directory = path.join(base, `cleanup-${profile.project}`); fs.mkdirSync(directory, { mode: 0o700 });
    return containerProofCleanup({ base: directory, project: profile.project, image: '', mounts: [],
      runDocker: (args, options) => runCommand('docker', args, { env, ...options }) });
  });
  for (const cleanup of cleanups) await cleanup.proveFresh();
  t.after(async () => {
    assert.equal(uncertainRestore || uncertainClient, false, `Uncertain fixture work preserves its resources and evidence at ${base}`);
    for (const [index, profile] of profiles.entries()) {
      const receipt = await cleanups[index].finish([
        () => executors[index]([...doltComposeArgs(profile), 'down', '--volumes'], 90_000),
      ]);
      fs.writeFileSync(path.join(base, `cleanup-${index}.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    t.diagnostic(`Redacted command evidence retained at ${path.join(base, 'commands')}`);
    // Successful runs may retain their complete private receipts for review.
    if (!accepted || process.env.NOTICEOS_TEST_KEEP_BEADS_EVIDENCE === '1') return;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const sql = async (index, query) => {
    const result = await executors[index]([...doltComposeArgs(profiles[index]), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', query]);
    assert.equal(result.code, 0, 'Owned SQL failed; raw diagnostics withheld');
    return JSON.parse(result.stdout.trim().split('\n').at(-1)).rows ?? [];
  };
  const repos = homes.map(home => path.join(home, 'spoke'));
  const bd = async (index, args, extra = {}) => record(`beads-${index}-${args[0]}`, args, () => runCommand(binaries[index], args, {
    env: { ...doltEnvironment(profiles[index], env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, ...extra },
    cwd: repos[index], timeoutMs: 90_000,
  }));
  const okayBd = async (index, args, extra) => {
    const result = await bd(index, args, extra);
    if (result.code) t.diagnostic(`Owned Beads ${args[0]}: ${result.stderr.replace(/[0-9a-f]{64}/gu, '[redacted]').slice(-3000)}`);
    assert.equal(result.code, 0, 'Owned Beads failed; raw task data withheld');
    return result.stdout;
  };
  assert.equal((await prepareFreshDolt(plans[0], { fresh: true, env })).ok, true);
  record = commandEvidence(path.join(base, 'commands'), { secrets: Object.values(readDoltCredentials(profiles[0])).map(value => value.trim()) });
  fs.mkdirSync(repos[0]);
  assert.equal((await runCommand('git', ['init', '--quiet', repos[0]], { env: doltEnvironment(profiles[0], env), cwd: base })).code, 0);
  assert.match(await okayBd(0, ['version']), /^bd version 1\.1\.2(?:\s|$)/u);
  await sql(0, 'CREATE DATABASE synthetic_tasks');
  await okayBd(0, ['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', String(profiles[0].port),
    '--server-user', 'noticeos', '--database', 'synthetic_tasks', '--prefix', 'no', '--non-interactive', '--skip-hooks', '--skip-agents'],
  { BEADS_DOLT_PASSWORD: readDoltCredentials(profiles[0]).noticeos.trim() });
  fs.appendFileSync(path.join(repos[0], '.beads/config.yaml'), '\nno-git-ops: true\nimport.auto: false\n');
  const first = JSON.parse(await okayBd(0, ['create', 'Synthetic parent', '--description', 'Line one\nUnicode Ω and comma, retained.', '--design', 'Synthetic design', '--acceptance', 'Synthetic acceptance', '--json']));
  const second = JSON.parse(await okayBd(0, ['create', 'Synthetic child', '--description', 'Dependent task', '--json']));
  await okayBd(0, ['dep', 'add', second.id, first.id]);
  await okayBd(0, ['label', 'add', first.id, 'synthetic']);
  await okayBd(0, ['comments', 'add', first.id, 'Synthetic comment with Ω\nand another line', '--author', 'synthetic-agent']);
  await okayBd(0, ['update', first.id, '--status', 'in_progress', '--actor', 'synthetic-agent']);
  const ephemeral = JSON.parse(await okayBd(0, ['create', 'Synthetic ephemeral task', '--description', 'Ignored working-set content', '--ephemeral', '--json']));
  await okayBd(0, ['dep', 'add', ephemeral.id, first.id]);
  await okayBd(0, ['label', 'add', ephemeral.id, 'synthetic-ephemeral']);
  await okayBd(0, ['comments', 'add', ephemeral.id, 'Ephemeral comment retained', '--author', 'synthetic-agent']);
  await sql(0, "USE synthetic_tasks; CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Pre-upgrade synthetic content','--author','Synthetic <synthetic@example.com>'); INSERT INTO config (`key`,value) VALUES ('synthetic-copy-setting','Retained uncommitted content');");
  const identity = JSON.parse(fs.readFileSync(path.join(repos[0], '.beads/metadata.json'))).project_id;
  assert.match(identity, /^[0-9a-f-]{36}$/u);
  const evidence = async index => ({
    issues: await sql(index, 'USE synthetic_tasks; SELECT id,title,status,priority,issue_type,description,design,acceptance_criteria,notes,assignee FROM issues ORDER BY id'),
    comments: await sql(index, 'USE synthetic_tasks; SELECT issue_id,author,text,created_at FROM comments ORDER BY issue_id,created_at'),
    dependencies: await sql(index, 'USE synthetic_tasks; SELECT issue_id,depends_on_issue_id,depends_on_wisp_id,depends_on_external,type FROM dependencies ORDER BY issue_id,depends_on_issue_id,depends_on_wisp_id,depends_on_external,type'),
    labels: await sql(index, 'USE synthetic_tasks; SELECT issue_id,label FROM labels ORDER BY issue_id,label'),
    events: await sql(index, 'USE synthetic_tasks; SELECT issue_id,event_type,actor,old_value,new_value,comment,created_at FROM events ORDER BY issue_id,created_at,event_type,actor'),
    config: await sql(index, "USE synthetic_tasks; SELECT `key`,value FROM config WHERE `key` IN ('issue_prefix','synthetic-copy-setting') ORDER BY `key`"),
    wisps: await sql(index, 'USE synthetic_tasks; SELECT id,title,status,description,notes FROM wisps ORDER BY id'),
    wispComments: await sql(index, 'USE synthetic_tasks; SELECT issue_id,author,text,created_at FROM wisp_comments ORDER BY issue_id,created_at'),
    wispDependencies: await sql(index, 'USE synthetic_tasks; SELECT issue_id,depends_on_issue_id,depends_on_wisp_id,depends_on_external,type FROM wisp_dependencies ORDER BY issue_id,depends_on_issue_id,depends_on_wisp_id,depends_on_external,type'),
    wispLabels: await sql(index, 'USE synthetic_tasks; SELECT issue_id,label FROM wisp_labels ORDER BY issue_id,label'),
    wispEvents: await sql(index, 'USE synthetic_tasks; SELECT issue_id,event_type,actor,old_value,new_value,comment,created_at FROM wisp_events ORDER BY issue_id,created_at,event_type,actor'),
  });
  const roots = async index => sql(index, "USE synthetic_tasks; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working");
  const before = await evidence(0); const beforeRoots = await roots(0);
  assert.equal(before.wisps.length, 1);
  assert.equal(before.wispComments.length, 1);
  assert.equal(before.wispDependencies.length, 1);
  const oldHistory = await sql(0, 'USE synthetic_tasks; SELECT commit_hash FROM dolt_log ORDER BY commit_hash');
  assert.deepEqual(await sql(0, 'SELECT DOLT_VERSION() AS version'), [{ version: '2.2.3' }]);
  const sourceStage = `/tmp/noticeos-backup-${randomBytes(16).toString('hex')}`;
  const sourceArgs = doltComposeArgs(profiles[0]);
  assert.equal((await executors[0]([...sourceArgs, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/capture.sh', sourceStage, 'synthetic_tasks'], 120_000)).code, 0);
  const snapshot = path.join(base, 'snapshot'); fs.mkdirSync(snapshot, { mode: 0o700 });
  assert.equal((await executors[0]([...sourceArgs, 'cp', `dolt:${sourceStage}/.`, snapshot], 120_000)).code, 0);
  assert.equal((await executors[0]([...sourceArgs, 'exec', '--no-TTY', 'dolt', 'rm', '-rf', '--', sourceStage])).code, 0);
  assert.ok([0, '0'].includes(JSON.parse(fs.readFileSync(path.join(snapshot, 'status/synthetic_tasks.json'))).rows[0].status));
  assert.equal((await preflightDolt(plans[1], { env })).ok, true);
  const credentials = readDoltCredentials(profiles[0]);
  fs.mkdirSync(path.dirname(profiles[1].credentialsFile), { mode: 0o700 });
  fs.mkdirSync(profiles[1].secretsDir, { mode: 0o700 });
  fs.mkdirSync(path.join(homes[1], 'dolt/client-home'), { mode: 0o700 });
  for (const name of ['root', 'noticeos']) fs.writeFileSync(path.join(profiles[1].secretsDir, name), credentials[name], { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(profiles[1].credentialsFile, `[127.0.0.1:${profiles[1].port}]\npassword=${credentials.noticeos.trim()}\n`, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(homes[1], 'dolt/profile.json'), JSON.stringify(profiles[1]), { mode: 0o600, flag: 'wx' });
  const targetArgs = doltComposeArgs(profiles[1]); const targetStage = `/var/lib/dolt/.noticeos-restore-${randomBytes(16).toString('hex')}`;
  assert.equal((await executors[1]([...targetArgs, 'create', 'dolt'], 120_000)).code, 0);
  assert.equal((await executors[1]([...targetArgs, 'cp', `${snapshot}/.`, `dolt:${targetStage}`], 120_000)).code, 0);
  uncertainRestore = true;
  const restore = await executors[1]([...targetArgs, 'run', '--rm', '--no-deps', '--no-TTY', '--entrypoint', '/bin/bash', 'dolt', '/etc/noticeos/restore.sh', targetStage, 'synthetic_tasks'], 120_000);
  uncertainRestore = restore.timedOut === true || Boolean(restore.signal) || Boolean(restore.error) || Boolean(restore.spawnError);
  assert.equal(restore.code, 0);
  assert.equal((await executors[1]([...targetArgs, 'up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'], 120_000)).code, 0);
  assert.deepEqual(await sql(1, 'SELECT DOLT_VERSION() AS version'), [{ version: DOLT_VERSION }]);
  assert.deepEqual(await roots(1), beforeRoots, 'Dolt move preserves HEAD, staged and working roots before Beads upgrade');
  assert.deepEqual(await evidence(1), before);
  const semanticBefore = await captureTargetState(['synthetic_tasks'], query => sql(1, query));
  fs.cpSync(repos[0], repos[1], { recursive: true });
  const metaPath = path.join(repos[1], '.beads/metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaPath)); meta.dolt_server_port = profiles[1].port;
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  assert.match(await okayBd(1, ['version']), new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  // Dirty working content is preserved through the move, then reconciled only
  // on the target before migration. No commit is made on the original source.
  await sql(1, "USE synthetic_tasks; CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Preserve pre-upgrade working content','--author','Synthetic <synthetic@example.com>');");
  const image = process.env.NOTICEOS_TEST_BEADS_IMAGE;
  assert.match(image ?? '', /^sha256:[0-9a-f]{64}$/u, 'Declare the exact qualified bundled application image');
  const gate = path.join(repos[1], '.beads.gate.lock');
  if (!fs.existsSync(gate)) fs.writeFileSync(gate, '', { mode: 0o600, flag: 'wx' });
  const wrapperPrepare = path.join(base, 'wrapper-prepare.json');
  fs.writeFileSync(wrapperPrepare, JSON.stringify({ format: 'noticeos-host-beads-prepare-v1', directory: path.join(homes[1], 'schema-agent'),
    doltHome: homes[1], image, spokes: [repos[1]], fallbackActor: 'synthetic-schema-migrator' }), { mode: 0o600 });
  const wrapper = prepareHostBeads(wrapperPrepare);
  const migrate = async (label, args) => {
    uncertainClient = true;
    const result = await record(label, args, () => runHostBeads(wrapper.plan, args, { cwd: base, env }));
    uncertainClient = result.timedOut === true || Boolean(result.signal) || Boolean(result.error) || Boolean(result.spawnError);
    return result;
  };
  const bundled = await migrate('bundled-version', ['-C', repos[1], '--sandbox', 'version']);
  assert.equal(bundled.code, 0);
  assert.match(bundled.stdout, new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u'));
  let contacts = 0, controlContacts = 0, remoteURL, unforcedBefore, unforcedAfter;
  if (hasRemote) {
    let observedControl;
    const controlObserved = new Promise(resolve => { observedControl = resolve; });
    const trap = net.createServer(socket => { contacts++; observedControl(); socket.destroy(); });
    await new Promise((resolve, reject) => { trap.once('error', reject); trap.listen(0, '0.0.0.0', resolve); });
    t.after(() => new Promise((resolve, reject) => trap.close(error => error ? reject(error) : resolve())));
    remoteURL = `http://host.docker.internal:${trap.address().port}/synthetic-schema-proof`;
    const control = await executors[1]([...targetArgs, 'exec', '--no-TTY', 'dolt', '/bin/bash', '-c',
      `exec 3<>/dev/tcp/host.docker.internal/${trap.address().port}; exec 3>&-`], 10_000);
    assert.equal(control.code, 0, 'The same target container can reach the owned mock remote listener');
    await controlObserved;
    controlContacts = contacts;
    assert.equal(controlContacts, 1, 'The trap observes the explicit reachability control');
    contacts = 0;
    await sql(1, `USE synthetic_tasks; CALL DOLT_REMOTE('add','origin','${remoteURL}');`);
    fs.appendFileSync(path.join(repos[1], '.beads/config.yaml'), '\ndolt.auto-push: true\n');
    unforcedBefore = await captureTargetState(['synthetic_tasks'], query => sql(1, query));
    const args = ['-C', repos[1], '--sandbox', 'migrate', 'schema', '--json', '--actor', 'synthetic-schema-migrator'];
    const refusal = await migrate('unforced-remote', args);
    assert.equal(refusal.code, 1, 'A configured remote requires a designated migrator');
    assert.match(refusal.stderr, /remote-backed database|database has a remote/u);
    unforcedAfter = await captureTargetState(['synthetic_tasks'], query => sql(1, query));
    assert.deepEqual(unforcedAfter, unforcedBefore,
      'Refusal preserves every table digest, schema, history, ref and all three roots');
    assert.deepEqual(await evidence(1), before);
    assert.equal(contacts, 0, 'Unforced refusal never contacts the configured mock remote');
  }
  const remotesBefore = await sql(1, 'USE synthetic_tasks; SELECT name,url FROM dolt_remotes ORDER BY name');
  assert.equal(remotesBefore.length, hasRemote ? 1 : 0);
  const argv = ['-C', repos[1], '--sandbox', 'migrate', 'schema', '--force', '--json', '--actor', 'synthetic-schema-migrator'];
  const migration = await migrate('designated-migrator', argv);
  assert.equal(migration.code, 0, 'Actual bundled client explicitly migrates only the copied destination schema');
  if (hasRemote) {
    const enabled = await migrate('auto-push-configuration', ['-C', repos[1], '--sandbox', 'config', 'get', 'dolt.auto-push']);
    assert.equal(enabled.code, 0);
    assert.equal(enabled.stdout.trim(), 'true', 'The proof opts into auto-push rather than relying on its default being off');
  }
  assert.equal(contacts, 0, 'Sandbox blocks opted-in auto-push and all mock-remote contact');
  assert.equal(fs.existsSync(path.join(repos[1], '.beads/push-state.json')), false, 'No push attempt state was written');
  assert.deepEqual(await sql(1, 'USE synthetic_tasks; SELECT name,url FROM dolt_remotes ORDER BY name'), remotesBefore);
  const semanticAfter = await captureTargetState(['synthetic_tasks'], query => sql(1, query), { baseline: semanticBefore });
  assert.equal(compareTargetState(semanticBefore, semanticAfter).semanticContentPreserved, true);
  assert.deepEqual(await evidence(1), before, 'Schema changes retain semantic task content, including legacy audit events');
  const schema = await sql(1, 'USE synthetic_tasks; SELECT MAX(version) AS version FROM schema_migrations');
  assert.equal(Number(schema[0].version), 66);
  assert.equal((await sql(1, "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA='synthetic_tasks' AND TABLE_NAME IN ('leases','provenance_events','bd_events_journal')"))[0].count, '3');
  assert.equal(JSON.parse(fs.readFileSync(metaPath)).project_id, identity);
  const newHistory = (await sql(1, 'USE synthetic_tasks; SELECT commit_hash FROM dolt_log')).map(row => row.commit_hash);
  assert.ok(oldHistory.every(row => newHistory.includes(row.commit_hash)), 'Every original historical commit remains reachable');
  assert.equal(JSON.parse(await okayBd(1, ['--sandbox', 'show', first.id, '--json']))[0].id, first.id);
  const update = await migrate('post-upgrade-write', ['-C', repos[1], '--sandbox', 'update', first.id, '--notes', 'First upgraded target write', '--actor', 'synthetic-agent']);
  assert.equal(update.code, 0);
  assert.equal(contacts, 0);
  assert.deepEqual(await evidence(0), before, 'Target upgrade and writes never change the source');
  assert.deepEqual(await roots(0), beforeRoots, 'Original source remains an exact rollback copy');
  fs.writeFileSync(path.join(base, 'qualification.json'), JSON.stringify({
    complete: true, hasRemote, image, doltVersion: DOLT_VERSION, beadsVersion: BEADS_VERSION,
    projects: profiles.map(profile => profile.project), ports: profiles.map(profile => profile.port),
    singleDesignatedMigrator: true, argv, mockRemoteContacts: contacts, mockRemoteControlContacts: controlContacts, remotes: remotesBefore,
    sourceRootsBefore: beforeRoots, sourceRootsAfter: await roots(0),
    ...(hasRemote ? { unforcedBefore, unforcedAfter } : {}),
    migration: compareTargetState(semanticBefore, semanticAfter),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  accepted = true;
});
