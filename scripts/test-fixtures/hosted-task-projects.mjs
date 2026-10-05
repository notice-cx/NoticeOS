import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { runCommand } from '../run-command.mjs';
import { startDoltPlan, prepareFreshDolt, doltComposeArgs, doltEnvironment, readDoltCredentials, DOLT_IMAGE } from '../dolt-host.mjs';
import { containerProofCleanup } from '../container-proof-cleanup.mjs';
import { commandEvidence } from './command-evidence.mjs';
import { localDockerEndpoint } from '../postgres-compose.mjs';
import { createWorkspaceAdmission } from '../workspace-admission.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from '../browser-request-policy.mjs';
import { createHostedTaskExecutor, HostedTaskRefused } from '../hosted-task-executor.mjs';
import { taskClientEnvironment } from '../task-client.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const R = '66666666-6666-4666-8666-666666666666';
const C = '77777777-7777-4777-8777-777777777777';
const OTHER_CREDENTIAL = '99999999-9999-4999-8999-999999999999';
const headers = { origin: 'https://tower.example.com', 'sec-fetch-site': 'same-origin', [WORKSPACE_SESSION_HEADER]: SESSION };
const request = workspace => new Request('https://tower.example.com/api/tasks', { method: 'POST', headers: { ...headers, [WORKSPACE_SELECTION_HEADER]: workspace } });

// Test-only physical fixture. No raw SQL, provisioning credentials, or mutable
// readiness assertion crosses this callback. The outer lifetime owns every
// container, file, command observer, and awaited cleanup even when work fails.
export async function withOwnedTaskProjects(work, { projects } = {}) {
  assert.equal(process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR, '1', 'Explicit synthetic fixture opt-in is required');
  assert.equal(typeof work, 'function');
  const selections = projects ?? [A, B].map(workspaceId => ({ workspaceId, projectId: P, databaseId: workspaceId }));
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
  assert.ok(Array.isArray(selections) && selections.length >= 2 && selections.length <= 8
    && selections.every(row => uuid(row.workspaceId) && uuid(row.projectId) && uuid(row.databaseId)
      && (row.prefix === undefined || typeof row.prefix === 'string' && /^[a-z0-9]{1,32}$/u.test(row.prefix))));
  assert.equal(new Set(selections.map(row => row.workspaceId + '/' + row.projectId)).size, selections.length);
  assert.equal(new Set(selections.map(row => row.databaseId)).size, selections.length);
  const root = path.resolve(import.meta.dirname, '../..');
  const evidence = process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE;
  assert.ok(path.isAbsolute(evidence ?? ''));
  assert.ok(fs.lstatSync(evidence).isDirectory() && !fs.lstatSync(evidence).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(evidence, 'exploration-receipt.json')), false);
  const binary = process.env.NOTICEOS_TEST_BEADS_NEW_BIN;
  const binarySha = process.env.NOTICEOS_TEST_BEADS_SHA256;
  assert.ok(path.isAbsolute(binary ?? '') && fs.lstatSync(binary).isFile() && !fs.lstatSync(binary).isSymbolicLink());
  assert.match(binarySha ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), binarySha);
  const doltBinary = process.env.NOTICEOS_TEST_DOLT_CLIENT_BIN;
  const doltSha = process.env.NOTICEOS_TEST_DOLT_CLIENT_SHA256;
  assert.ok(path.isAbsolute(doltBinary ?? '') && fs.lstatSync(doltBinary).isFile() && !fs.lstatSync(doltBinary).isSymbolicLink());
  assert.match(doltSha ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(createHash('sha256').update(fs.readFileSync(doltBinary)).digest('hex'), doltSha);
  const imageId = process.env.NOTICEOS_TEST_DOLT_IMAGE_ID;
  assert.match(imageId ?? '', /^sha256:[0-9a-f]{64}$/u);
  const free = fs.statfsSync(os.tmpdir());
  assert.ok(free.bavail * free.bsize >= 8 * 1024 ** 3 + 128 * 1024 ** 2);
  const suppliedBase = process.env.NOTICEOS_TEST_HOSTED_TASK_OWNED_BASE;
  const base = suppliedBase ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-task-executor-'));
  assert.ok(path.isAbsolute(base) && fs.realpathSync(base) === base
    && path.basename(base).startsWith('noticeos-task-executor-') && fs.statSync(base).uid === process.getuid()
    && !(fs.statSync(base).mode & 0o077));
  assert.deepEqual(fs.readdirSync(base), [], 'Only a newly prepared empty owned fixture is accepted');
  for (const name of ['hub', 'home', 'tmp', 'config', 'cache', 'scratch', 'cleanup']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  const home = path.join(base, 'hub'), profile = startDoltPlan({ root, home, port: 13380 });
  assert.equal(profile.port, 13383);
  const compose = doltComposeArgs(profile);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(base, 'home'), TMPDIR: path.join(base, 'tmp'),
    XDG_CONFIG_HOME: path.join(base, 'config'), XDG_CACHE_HOME: path.join(base, 'cache'), DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    NOTICEOS_DOLT_PORT: '13383', NOTICEOS_DOLT_SECRETS: profile.secretsDir,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1',
    DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1' };
  assert.ok(path.isAbsolute(env.DOCKER_CONFIG ?? ''));
  const summary = { version: 1, bead: 'ro-ujb9.289.10.2.3', base, profile, binarySha, doltSha, imageId,
    expectedPeakAdditionalBytes: 128 * 1024 ** 2, freeBefore: free.bavail * free.bsize, stages: [], commands: [] };
  let secrets = [], cleanup, record, fresh = false, uncertain = false, restoreSpawn;
  const save = () => {
    let content = JSON.stringify(summary, null, 2);
    for (const value of secrets) content = content.replaceAll(value, '[redacted]');
    fs.writeFileSync(path.join(evidence, 'exploration-receipt.json'), content + '\n', { mode: 0o600 });
  };
  const exec = async (args, opts = {}) => {
    const selected = [...args]; if (selected.includes('up')) selected.push('--pull', 'never');
    const reply = await runCommand('docker', selected, { env, timeoutMs: 30_000, ...opts });
    if (reply.timedOut || reply.error) uncertain = true;
    return reply;
  };
  const okay = (reply, label) => { assert.equal(reply.code, 0, `${label}: inspect redacted command evidence`); return reply.stdout; };
  const capture = (label, args, work) => record ? record(label, args, work) : work();
  const ownerSql = sql => capture('platform-sql', ['docker', 'compose', 'exec', 'fixed-platform-sql'], () => exec([...compose, 'exec', '--no-TTY', '--interactive', 'dolt', '/bin/bash', '-c',
    'export DOLT_CLI_PASSWORD; DOLT_CLI_PASSWORD=$(cat /run/secrets/dolt_root); exec dolt --host=127.0.0.1 --port=3306 --user=noticeos_owner --no-tls sql --result-format=json --batch'], { stdin: sql + '\n' }));
  const rows = reply => JSON.parse(okay(reply, 'platform metadata').trim().split('\n').at(-1)).rows ?? [];
  const clients = selections.map(({ workspaceId, projectId, databaseId, prefix = 'tt' }, i) => ({ workspaceId, projectId, prefix, executorRef: i === 0 ? R : C, credentialRef: i === 0 ? C : i === 1 ? OTHER_CREDENTIAL : databaseId,
    databaseKey: 'n_' + databaseId.replaceAll('-', ''), user: `task${i}`, password: randomBytes(32).toString('hex'),
    cwd: path.join(base, `project-${i}`), clientHome: path.join(base, `client-${i}`), credentialsFile: path.join(base, `credentials-${i}`),
    clientProfile: path.join(base, `client-${i}.json`) }));
  const bd = (client, args, provision = false) => capture(`bd-${client.user}`, ['bd', ...args], () => runCommand(binary, args, {
    cwd: client.cwd, timeoutMs: 30_000, env: provision ? { ...doltEnvironment(profile, env), BEADS_DOLT_PASSWORD: readDoltCredentials(profile).noticeos.trim() }
      : { ...taskClientEnvironment({ host: '127.0.0.1', port: 13383, user: client.user, credentialsFile: client.credentialsFile, clientHome: client.clientHome }, env), BEADS_DOLT_DATABASE: client.databaseKey },
  }));
  const roots = async () => Object.fromEntries(await Promise.all(clients.map(async c => [c.workspaceId,
    rows(await ownerSql(`USE ${c.databaseKey}; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working;`))])));
  let unready;
  try {
    save();
    const version = await runCommand(binary, ['--version'], { cwd: base, env, timeoutMs: 5000 });
    assert.match(okay(version, 'pinned bd').trim(), /^bd version 1\.3\.1(?:\s|$)/u);
    okay(await runCommand(doltBinary, ['config', '--global', '--add', 'versioncheck.disabled', 'true'],
      { cwd: base, env, timeoutMs: 5000 }), 'owned client disables outside update checks');
    const sqlVersion = await runCommand(doltBinary, ['version'], { cwd: base, env, timeoutMs: 5000 });
    assert.equal(okay(sqlVersion, 'pinned Dolt client').trim(), 'dolt version 2.4.0');
    env.DOCKER_HOST = await localDockerEndpoint(runCommand, { env }); assert.ok(env.DOCKER_HOST);
    assert.equal(okay(await exec(['image', 'inspect', DOLT_IMAGE, '--format', '{{.Id}}']), 'cached image').trim(), imageId);
    cleanup = containerProofCleanup({ base: path.join(base, 'cleanup'), project: profile.project, image: '', mounts: [], runDocker: exec });
    await cleanup.proveFresh();
    const initialVolume = await exec(['volume', 'inspect', `${profile.project}_dolt-data`]);
    assert.notEqual(initialVolume.code, 0, 'Existing project volumes are never reused');
    assert.match(initialVolume.stderr, /no such volume/iu);
    fresh = true;
    fs.writeFileSync(path.join(evidence, 'planned-config.json'), JSON.stringify({ profile, compose, image: DOLT_IMAGE, listener: '127.0.0.1:13383', base }, null, 2));
    const started = await prepareFreshDolt({ root, home, port: 13380 }, { fresh: true, env, run: (_bin, args, opts) => exec(args, opts) });
    assert.equal(started.ok, true, started.line);
    secrets = [...clients.map(c => c.password), ...Object.values(readDoltCredentials(profile)).map(x => x.trim())];
    record = commandEvidence(path.join(evidence, 'commands'), { secrets });
    assert.deepEqual(rows(await ownerSql('SELECT DOLT_VERSION() AS version')), [{ version: '2.4.0' }]);
    for (const client of clients) {
      fs.mkdirSync(client.cwd, { mode: 0o700 }); fs.mkdirSync(client.clientHome, { mode: 0o700 });
      fs.writeFileSync(client.credentialsFile, `[127.0.0.1:13383]\npassword=${client.password}\n`, { mode: 0o600 });
      fs.writeFileSync(client.clientProfile, JSON.stringify({ host: '127.0.0.1', port: 13383, user: client.user,
        clientHome: client.clientHome, credentialsFile: client.credentialsFile }), { mode: 0o600 });
      okay(await ownerSql(`CREATE DATABASE ${client.databaseKey}; CREATE USER '${client.user}'@'%' IDENTIFIED BY '${client.password}';`), 'owned provisioning');
      okay(await bd(client, ['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', '13383', '--server-user', 'noticeos',
        '--database', client.databaseKey, '--prefix', client.prefix, '--non-interactive', '--skip-hooks', '--skip-agents'], true), 'privileged initialization');
      fs.appendFileSync(path.join(client.cwd, '.beads/config.yaml'), '\nno-git-ops: true\nimport.auto: false\n');
      okay(await bd(client, ['--sandbox', '--json', 'create', `--id=${client.prefix}-collision`, '--', `Private ${client.user}`], true), 'colliding fixture');
      client.beadsProjectId = rows(await ownerSql(`SELECT value AS project_id FROM ${client.databaseKey}.metadata WHERE \`key\`='_project_id'`))[0].project_id;
      okay(await ownerSql(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${client.databaseKey}.* TO '${client.user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${client.databaseKey}.dolt_add TO '${client.user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${client.databaseKey}.dolt_commit TO '${client.user}'@'%';
        GRANT EXECUTE ON PROCEDURE ${client.databaseKey}.dolt_checkout TO '${client.user}'@'%';`), 'restricted grants');
    }
    okay(await ownerSql(`USE ${clients[0].databaseKey}; DELETE FROM dolt_branch_control; INSERT INTO dolt_branch_control VALUES
      ('%','%','noticeos_owner','localhost','admin'),('%','%','noticeos','%','admin'),
      ${clients.map(client => `('${client.databaseKey}','main','${client.user}','%','write')`).join(',')};`), 'branch restrictions');
    const branchRows = rows(await ownerSql(`USE ${clients[0].databaseKey}; SELECT \`database\`,branch,user,host,permissions FROM dolt_branch_control WHERE user IN (${clients.map(client => `'${client.user}'`).join(',')}) ORDER BY user;`));
    assert.deepEqual(branchRows, clients.map(c => ({ database: c.databaseKey, branch: 'main', user: c.user, host: '%', permissions: 'write' })));
    summary.branchRows = branchRows;
    const inspectorProfile = path.join(base, 'inspection-profile.json');
    {
      const password = randomBytes(32).toString('hex'); secrets.push(password);
      okay(await ownerSql(`CREATE USER 'grant_inspector'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON mysql.* TO 'grant_inspector'@'%';`), 'owned least privilege inspector');
      const inspect = sql => capture('inspector-fixed-sql', ['dolt', 'fixed-inspector-sql'], () => runCommand(doltBinary,
        ['--host=127.0.0.1', '--port=13383', '--user=grant_inspector', '--use-db=mysql', '--no-tls', 'sql', '--result-format=json', `--query=${sql}`],
        { cwd: clients[0].clientHome, env: { PATH: '/usr/bin:/bin', HOME: clients[0].clientHome, TMPDIR: path.join(base, 'tmp'), DOLT_CLI_PASSWORD: password,
          DOLT_DISABLE_EVENT_FLUSH: '1', DO_NOT_TRACK: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 5000 }));
      const query = 'SHOW GRANTS FOR \`task0\`@\`%\`';
      const inspectorCredentials = path.join(base, 'inspection-credentials');
      fs.writeFileSync(inspectorCredentials, `[127.0.0.1:13383]\npassword=${password}\n`, { mode: 0o600 });
      fs.writeFileSync(inspectorProfile, JSON.stringify({ host: '127.0.0.1', port: 13383, user: 'grant_inspector',
        credentialsFile: inspectorCredentials, clientHome: clients[0].clientHome }), { mode: 0o600 });
      summary.inspectorQualification = { controls: [] };
      const actual = await inspect(query); okay(actual, 'inspector reads exact user grants');
      summary.inspectorQualification.actual = actual;
      summary.inspectorQualification.finalGrants = rows(await ownerSql("SHOW GRANTS FOR 'grant_inspector'@'%';"));
      for (const sql of ["UPDATE mysql.user SET User='forbidden_fixture' WHERE User='grant_inspector'",
        `GRANT SELECT ON ${clients[0].databaseKey}.* TO 'grant_inspector'@'%'`,
        `SELECT id FROM ${clients[0].databaseKey}.issues`,
        `UPDATE ${clients[0].databaseKey}.issues SET title='Forbidden fixture' WHERE id='tt-collision'`]) {
        const reply = await inspect(sql); summary.inspectorQualification.controls.push({ sql, reply }); save();
        assert.notEqual(reply.code, 0); assert.match(reply.stderr + reply.stdout, /denied|access/iu);
      }
      summary.inspectorQualification.complete = true; save();
      if (process.env.NOTICEOS_TEST_HOSTED_TASK_GRANT_INSPECTION === '1') return;
    }
    const mappings = Object.freeze(clients.map(({ workspaceId, projectId, executorRef, credentialRef, databaseKey }) =>
      Object.freeze({ workspaceId, projectId, executorRef, credentialRef, databaseKey })));
    const resolveTarget = async m => {
      const selected = mappings.find(x => x.workspaceId === m.workspaceId && x.projectId === m.projectId
        && x.executorRef === m.executorRef && x.credentialRef === m.credentialRef && x.databaseKey === m.databaseKey);
      if (!selected) return null;
      const c = clients.find(x => x.workspaceId === selected.workspaceId && x.projectId === selected.projectId);
      return Object.freeze({ cwd: c.cwd, clientProfile: c.clientProfile, grantVerifierProfile: inspectorProfile,
        beadsProjectId: c.beadsProjectId, tls: false });
    };
    const facts = Object.freeze({ mappings, resolveTarget,
      pinnedBinary: Object.freeze({ path: binary, sha256: binarySha }),
      pinnedDoltBinary: Object.freeze({ path: doltBinary, sha256: doltSha }), scratchRoot: path.join(base, 'scratch') });
    // Observe the exact real children without substituting any command/result.
    const originalSpawn = childProcess.spawn;
    summary.executorProcessEvidence = [];
    childProcess.spawn = function (...args) {
      const child = originalSpawn(...args);
      if ([binary, doltBinary].includes(args[0])) {
        let stdout = '', stderr = '', captured = 0;
        const observe = (field, data) => {
          const text = data.toString('utf8'), remaining = Math.max(0, 65536 - captured);
          const part = text.slice(0, remaining); captured += Buffer.byteLength(part);
          if (field === 'stdout') stdout += part; else stderr += part;
        };
        child.stdout?.on('data', data => observe('stdout', data));
        child.stderr?.on('data', data => observe('stderr', data));
        child.once('close', (code, signal) => {
          summary.executorProcessEvidence.push({ binary: args[0] === binary ? 'bd' : 'dolt', argv: args[1], code, signal, stdout, stderr });
          save();
        });
      }
      return child;
    };
    syncBuiltinESMExports();
    restoreSpawn = () => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); };
    // Fixed test-only qualification retains all controls without exposing raw
    // owner SQL or child credentials to the activation callback.
    // These sequential pinned-client controls do not qualify cross-replica
    // coordination. The native PostgreSQL/browser fixture supplies the actual
    // TaskDirectory lease and proves concurrent executor behavior separately.
    const sequentialClientDirectory = {
      project: async (workspaceId,projectId)=>mappings.find(m=>m.workspaceId===workspaceId&&m.projectId===projectId)??null,
      withProjectMutation: async(workspaceId,projectId,controls,work)=>{
        if(controls.signal?.aborted)throw new Error('Owned client qualification aborted');
        return work(Object.freeze({project:()=>sequentialClientDirectory.project(workspaceId,projectId),
          signal:controls.signal??new AbortController().signal}));
      },
    };
    const qualifyExecutor = async () => {
      const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: 'https://tower.example.com',
        membership: async (_headers, workspaceId) => ({ principalId: PERSON, sessionId: SESSION, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          workspaceId, role: 'operator', workspaceStatus: 'active' }) });
      const executor = createHostedTaskExecutor({ admission, directory: sequentialClientDirectory,
        resolveTarget, binary: facts.pinnedBinary, doltBinary: facts.pinnedDoltBinary, scratchRoot: facts.scratchRoot });
      const before = await roots();
      for (const m of mappings) {
        try { const v = await executor.verifyProject(m); executor.assertVerifiedProject(v, m); }
        catch (error) {
          const client = clients.find(c => c.workspaceId === m.workspaceId);
          summary.fixedReadinessDiagnostics = [];
          for (const sql of [
            'SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME',
            'SHOW GRANTS',
            'SELECT `database`,branch,user,host,permissions FROM dolt_branch_control WHERE user=SUBSTRING_INDEX(CURRENT_USER(),\u0027@\u0027,1)',
          ]) summary.fixedReadinessDiagnostics.push({ sql, reply: await bd(client, ['--sandbox', '--readonly', '--json', 'sql', sql]) });
          save(); throw error;
        }
      }
      assert.deepEqual(await roots(), before, 'Readiness does not mutate initialized startup roots');
      summary.readinessUnchanged = true; save();
      for (const client of clients) {
        const execute = operation => executor.execute(request(client.workspaceId), client.workspaceId, { projectId: P, operation });
        const shown = await execute({ kind: 'show', taskId: 'tt-collision' });
        assert.ok(JSON.stringify(shown).includes(`Private ${client.user}`));
        assert.ok(!JSON.stringify(shown).includes(`Private task${client.user === 'task0' ? 1 : 0}`));
        await execute({ kind: 'list', limit: 10 });
        await execute({ kind: 'history', taskId: 'tt-collision', limit: 5 });
        let created;
        try { created = await execute({ kind: 'create', title: '--file=/not-a-selector', description: 'Actual owned synthetic work' }); }
        catch (error) {
          summary.failedCreateMetadata = await bd(client, ['--sandbox', '--readonly', '--json', 'sql', 'SELECT DATABASE() AS database_key,ACTIVE_BRANCH() AS branch']);
          summary.failedCreateExactControl = await bd(client, ['--sandbox', '--json', `--actor=${PERSON}`, 'create',
            '--description=Actual owned synthetic work', '--title=--file=/not-a-selector', '--']);
          save(); throw error;
        }
        assert.match(created.id, /^tt-[a-z0-9]+$/u);
        await execute({ kind: 'update', taskId: created.id, status: 'in_progress', title: '--database=not-a-selector' });
        await execute({ kind: 'comment', taskId: created.id, text: '--file=/not-a-selector' });
        await execute({ kind: 'close', taskId: created.id, reason: 'Synthetic acceptance verified' });
        summary.stages.push({ workspaceId: client.workspaceId, sevenOperations: true, createdId: created.id }); save();
        const foreign = await bd(client, ['--sandbox', '--readonly', '--json', 'sql', `SELECT id FROM ${clients.find(c => c !== client).databaseKey}.issues`]);
        assert.notEqual(foreign.code, 0); assert.match(foreign.stdout + foreign.stderr, /denied|access/iu);
        const foreignWrite = await capture('restricted-cross-database-write', ['dolt', 'fixed-foreign-UPDATE'], () => runCommand(doltBinary,
          ['--host=127.0.0.1', '--port=13383', `--user=${client.user}`, `--use-db=${client.databaseKey}`, '--no-tls', 'sql', '--result-format=json',
            `--query=UPDATE ${clients.find(c => c !== client).databaseKey}.issues SET title='Forbidden cross-database write' WHERE id='tt-collision'`],
          { cwd: client.clientHome, env: { PATH: '/usr/bin:/bin', HOME: client.clientHome, TMPDIR: path.join(base, 'tmp'), DOLT_CLI_PASSWORD: client.password,
            DOLT_DISABLE_EVENT_FLUSH: '1', DO_NOT_TRACK: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 5000 }));
        assert.notEqual(foreignWrite.code, 0); assert.match(foreignWrite.stdout + foreignWrite.stderr, /denied|access|permissions/iu);
        assert.deepEqual(rows(await ownerSql(`SELECT title FROM ${clients.find(c => c !== client).databaseKey}.issues WHERE id='tt-collision'`)),
          [{ title: `Private ${clients.find(c => c !== client).user}` }]);
        summary.stages.at(-1).foreignReadWriteDenied = true; save();
      }
      // A missing database schema must stay missing after readiness refusal.
      unready = 'n_88888888888848888888888888888888';
      okay(await ownerSql(`CREATE DATABASE ${unready}; GRANT SELECT,INSERT,UPDATE,DELETE ON ${unready}.* TO 'task0'@'%';`), 'uninitialized control');
      const unreadyCwd = path.join(base, 'uninitialized-project');
      fs.mkdirSync(unreadyCwd, { mode: 0o700 }); fs.mkdirSync(path.join(unreadyCwd, '.beads'), { mode: 0o700 });
      const metadata = JSON.parse(fs.readFileSync(path.join(clients[0].cwd, '.beads/metadata.json'), 'utf8'));
      assert.equal(metadata.dolt_database, clients[0].databaseKey);
      metadata.dolt_database = unready;
      fs.writeFileSync(path.join(unreadyCwd, '.beads/metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      fs.copyFileSync(path.join(clients[0].cwd, '.beads/config.yaml'), path.join(unreadyCwd, '.beads/config.yaml'));
      const wrong = createHostedTaskExecutor({ admission, directory: { project: async () => ({ ...mappings[0], databaseKey: unready }) },
        resolveTarget: async () => ({ cwd: unreadyCwd, clientProfile: clients[0].clientProfile, grantVerifierProfile: inspectorProfile, beadsProjectId: clients[0].beadsProjectId, tls: false }),
        binary: { path: binary, sha256: binarySha }, doltBinary: { path: doltBinary, sha256: doltSha }, scratchRoot: path.join(base, 'scratch') });
      await assert.rejects(() => wrong.verifyProject({ ...mappings[0], databaseKey: unready }), HostedTaskRefused);
      assert.deepEqual(rows(await ownerSql(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${unready}'`)), []);
      summary.uninitializedUnchanged = true;
      okay(await ownerSql(`REVOKE SELECT,INSERT,UPDATE,DELETE ON ${unready}.* FROM 'task0'@'%';`), 'owned uninitialized-control grant restoration');
      // Exact grant verification also rejects an independently real excess grant.
      okay(await ownerSql("GRANT FILE ON *.* TO 'task0'@'%';"), 'owned overgrant control');
      await assert.rejects(() => executor.verifyProject(mappings[0]), HostedTaskRefused);
      okay(await ownerSql("REVOKE FILE ON *.* FROM 'task0'@'%';"), 'owned overgrant restoration');
      executor.assertVerifiedProject(await executor.verifyProject(mappings[0]), mappings[0]);
      summary.overgrantRefused = true;
      okay(await ownerSql("GRANT FILE ON *.* TO 'grant_inspector'@'%';"), 'owned inspector drift control');
      await assert.rejects(() => executor.verifyProject(mappings[0]), HostedTaskRefused);
      okay(await ownerSql("REVOKE FILE ON *.* FROM 'grant_inspector'@'%';"), 'owned inspector drift restoration');
      executor.assertVerifiedProject(await executor.verifyProject(mappings[0]), mappings[0]);
      summary.inspectorGrantDriftRefused = true;
      const rootsBeforeForgery = await roots();
      await assert.rejects(() => executor.execute(request(A), A, { projectId: P, operation: { kind: 'show', taskId: 'tt-collision' }, workspaceId: B }), HostedTaskRefused);
      assert.deepEqual(await roots(), rootsBeforeForgery);
      summary.callerForgedSelectorRefused = true;
      assert.deepEqual(fs.readdirSync(path.join(base, 'scratch')), []);
    };
    const qualifyRepeatedComments = async () => {
      const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: 'https://tower.example.com',
        membership: async (_headers, workspaceId) => ({ principalId: PERSON, sessionId: SESSION,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), workspaceId, role: 'operator', workspaceStatus: 'active' }) });
      const executor = createHostedTaskExecutor({ admission, directory: sequentialClientDirectory, resolveTarget,
        binary: facts.pinnedBinary, doltBinary: facts.pinnedDoltBinary, scratchRoot: facts.scratchRoot });
      summary.repeatedComments = { attempted: 0, completed: 0, persistedWorkspaces: [] }; save();
      for (const m of mappings) {
        const expected = [];
        assert.deepEqual(rows(await ownerSql(`SELECT text,author FROM ${m.databaseKey}.comments WHERE issue_id='tt-collision'`)), []);
        for (let index = 0; index < 12; index++) {
          const text = `--file=comment-diagnostic-${m.workspaceId}-${index}`;
          summary.repeatedComments.attempted++; save();
          const reply = await executor.execute(request(m.workspaceId), m.workspaceId,
            { projectId: m.projectId, operation: { kind: 'comment', taskId: 'tt-collision', text } });
          assert.equal(reply.text, text); assert.equal(reply.author, PERSON); assert.equal(reply.issue_id, 'tt-collision');
          expected.push({ text, author: PERSON }); summary.repeatedComments.completed++; save();
        }
        const persisted = rows(await ownerSql(`SELECT text,author FROM ${m.databaseKey}.comments WHERE issue_id='tt-collision' ORDER BY text`));
        assert.deepEqual(persisted, expected.sort((a, b) => a.text.localeCompare(b.text)));
        summary.repeatedComments.persistedWorkspaces.push({ workspaceId: m.workspaceId, count: persisted.length }); save();
      }
      assert.equal(summary.repeatedComments.completed, 24);
    };
    const prepareHumanDecisions = async () => {
      const client=clients[0],run=args=>bd(client,['--sandbox','--json',`--actor=${PERSON}`,...args]);
      for (const [id,title,labels] of [['tt-browseranswer','Owned browser answer','human'],
        ['tt-browserdismiss','Owned browser dismiss','human'],['tt-browserblocked','Owned browser dependent','']]) {
        okay(await run(['create',`--id=${id}`,`--title=${title}`,...(labels?[`--labels=${labels}`]:[]),'--']), 'owned browser decision fixture');
      }
      const gate=JSON.parse(okay(await run(['gate','create','--type=human','--blocks=tt-browserblocked','--reason=Owned browser gate']), 'owned browser gate'));
      return Object.freeze({answerId:'tt-browseranswer',dismissId:'tt-browserdismiss',blockedId:'tt-browserblocked',gateId:gate.id});
    };
    const qualifyHumanDecisions = async () => {
      summary.humanDecisionQualification = [];
      for (const client of clients) {
        const run = args => bd(client, ['--sandbox', '--json', `--actor=${PERSON}`, ...args]);
        for (const id of ['tt-humanresponse', 'tt-humandismiss']) {
          okay(await run(['create', `--id=${id}`, '--title=Owned synthetic human decision', '--labels=human', '--']), 'synthetic human ask');
        }
        const response = await run(['human', 'respond', '--response=--file=literal-response', '--', 'tt-humanresponse']);
        const dismissed = await run(['human', 'dismiss', '--reason=--database=literal-reason', '--', 'tt-humandismiss']);
        const gate = JSON.parse(okay(await run(['gate', 'create', '--type=human', '--blocks=tt-collision', '--reason=Owned synthetic approval']), 'synthetic gate'));
        assert.match(gate.id, /^tt-[a-z0-9]+$/u);
        const resolved = await run(['gate', 'resolve', '--reason=Owned synthetic approval', '--', gate.id]);
        const read = async id => JSON.parse(okay(await run(['--readonly', 'show', '--', id]), 'decision readback'));
        const state = { workspaceId: client.workspaceId, response, dismissed, resolved,
          human: await read('tt-humanresponse'), dismiss: await read('tt-humandismiss'), gate: await read(gate.id),
          comments: JSON.parse(okay(await run(['--readonly', 'comments', '--', 'tt-humanresponse']), 'response comments')),
          ready: JSON.parse(okay(await run(['--readonly', 'ready', '--limit=0']), 'unblocked ready readback')) };
        summary.humanDecisionQualification.push(state); save();
      }
      for (const state of summary.humanDecisionQualification) {
        okay(state.response, 'fixed human respond'); okay(state.dismissed, 'fixed human dismiss'); okay(state.resolved, 'fixed gate resolve');
        assert.equal(state.human[0].status, 'closed'); assert.equal(state.human[0].close_reason, 'Responded');
        assert.equal(state.dismiss[0].status, 'closed'); assert.equal(state.dismiss[0].close_reason, 'Dismissed: --database=literal-reason');
        assert.equal(state.gate[0].status, 'closed'); assert.equal(state.gate[0].await_type, 'human');
        assert.equal(state.gate[0].close_reason, 'Owned synthetic approval');
        assert.deepEqual(state.comments.map(({ issue_id,author,text }) => ({ issue_id,author,text })),
          [{ issue_id: 'tt-humanresponse', author: PERSON, text: 'Response: --file=literal-response' }]);
        assert.ok(state.ready.some(row => row.id === 'tt-collision'));
      }
    };
    const initializedRoots = await roots();
    const assertUnchangedPhysicalRoots = async () => {
      assert.deepEqual(await roots(), initializedRoots, 'Read-only callback preserves HEAD/STAGED/WORKING in both task projects');
      summary.callbackRootsUnchanged = true; save();
    };
    await work(facts, Object.freeze({ qualifyExecutor, qualifyRepeatedComments, qualifyHumanDecisions, prepareHumanDecisions, assertUnchangedPhysicalRoots }));
    assert.deepEqual(fs.readdirSync(facts.scratchRoot), [], 'All verifier profiles are awaited before outer teardown');
  } catch (error) { summary.failure = { name: error.name, message: error.message }; save(); throw error; }
  finally {
    restoreSpawn?.();
    summary.uncertainProcess = uncertain;
    if (cleanup && fresh && !uncertain) {
      summary.cleanup = await cleanup.finish([() => exec([...compose, 'down', '--volumes'], { timeoutMs: 90_000 })]);
      assert.equal(summary.cleanup.complete, true);
      const volume = await exec(['volume', 'inspect', `${profile.project}_dolt-data`]);
      assert.notEqual(volume.code, 0); assert.match(volume.stderr, /no such volume/iu);
      summary.volumeAbsent = true;
      fs.rmSync(base, { recursive: true, force: true });
      assert.equal(fs.existsSync(base), false);
      summary.ownedFixtureRetired = true;
    }
    if (!fresh) {
      // Only preflight reads ran. Retire our new files; never tear down a
      // pre-existing project or volume that made the freshness check refuse.
      fs.rmSync(base, { recursive: true, force: false });
      summary.preflightFixtureRetired = true;
    }
    save();
  }
}
