import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { runCommand } from './run-command.mjs';
import { startDoltPlan, prepareFreshDolt, doltComposeArgs, doltEnvironment, readDoltCredentials, DOLT_IMAGE } from './dolt-host.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { commandEvidence } from './test-fixtures/command-evidence.mjs';
import { taskClientEnvironment } from './task-client.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';


// Explicit local opt-in only: new generated project/volume, bounded fixture ports.
// SQL credentials are defense in depth, never caller or filesystem authority.
test('restricted Dolt grants support tenant task work and expose raw executor limits', {
  skip: process.env.NOTICEOS_TEST_DOLT_TENANT_CAPABILITIES !== '1', timeout: 240_000,
}, async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const evidence = process.env.NOTICEOS_TEST_DOLT_TENANT_EVIDENCE;
  assert.ok(path.isAbsolute(evidence ?? ''));
  assert.ok(fs.lstatSync(evidence).isDirectory() && !fs.lstatSync(evidence).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(evidence, 'exploration-receipt.json')), 'Use new receipt custody');
  const binary = process.env.NOTICEOS_TEST_BEADS_NEW_BIN;
  assert.ok(path.isAbsolute(binary ?? ''));
  assert.ok(fs.lstatSync(binary).isFile() && !fs.lstatSync(binary).isSymbolicLink());
  const binarySha = process.env.NOTICEOS_TEST_BEADS_SHA256;
  assert.match(binarySha ?? '', /^[0-9a-f]{64}$/u);
  const imageId = process.env.NOTICEOS_TEST_DOLT_IMAGE_ID;
  assert.match(imageId ?? '', /^sha256:[0-9a-f]{64}$/u);
  assert.equal(process.env.NOTICEOS_TEST_DOLT_TENANT_CAPABILITIES, '1', 'Explicit owned qualification required');
  assert.equal(createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), binarySha);
  const free = fs.statfsSync(os.tmpdir());
  assert.ok(free.bavail * free.bsize >= 8 * 1024 ** 3 + 128 * 1024 ** 2, 'Keep8GiB plus128MiB fixture budget');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-dolt-tenants-'));
  const home = path.join(base, 'hub');
  for (const name of ['hub', 'home', 'tmp', 'config', 'cache', 'docker-config']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  assert.ok(path.isAbsolute(process.env.DOCKER_CONFIG ?? ''), 'Declare an isolated Docker client configuration');
  const env = { PATH: process.env.PATH ?? '',
    HOME: path.join(base, 'home'), TMPDIR: path.join(base, 'tmp'), XDG_CONFIG_HOME: path.join(base, 'config'), XDG_CACHE_HOME: path.join(base, 'cache'),
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1' };
  const port = Number(process.env.NOTICEOS_TEST_DOLT_TENANT_BASE_PORT ?? 13380);
  assert.ok(Number.isInteger(port) && port >= 13380 && port <= 13386);
  const profile = startDoltPlan({ root, home, port });
  assert.equal(profile.port, port + 3);
  env.NOTICEOS_DOLT_PORT = String(profile.port);
  env.NOTICEOS_DOLT_SECRETS = profile.secretsDir;
  const compose = doltComposeArgs(profile);
  const summary = { version: 1, base, profile, binary, binarySha, imageId, freeBefore: free.bavail * free.bsize,
    expectedPeakAdditionalBytes: 128 * 1024 ** 2, stages: [], attempts: [], ordinary: [], sources: {} };
  for (const file of ['db/dolt/host/compose.yaml', 'db/dolt/host/start.sh', 'scripts/dolt-host.mjs', 'scripts/task-client.mjs', 'scripts/host-beads.mjs']) {
    summary.sources[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  let knownSecrets = [];
  const save = () => {
    let content = JSON.stringify(summary, null, 2);
    for (const secret of knownSecrets) content = content.replaceAll(secret, '[redacted]');
    fs.writeFileSync(path.join(evidence, 'exploration-receipt.json'), content + '\n', { mode: 0o600 });
  };
  save();
  const taskSecrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  knownSecrets = taskSecrets;
  let record, uncertain = false, cleanup;
  const exec = async (args, options = {}) => {
    const selected = [...args];
    if (selected.includes('up')) selected.push('--pull', 'never');
    const result = await runCommand('docker', selected, { env, ...options });
    if (result.timedOut || result.error) uncertain = true;
    return result;
  };
  const endpoint = await localDockerEndpoint(runCommand, { env });
  assert.ok(endpoint, 'Use an explicitly local Docker endpoint');
  env.DOCKER_HOST = endpoint;
  const capture = async (label, args, action) => record ? record(label, args, action) : action();
  const okay = (result, phase) => { assert.equal(result.code, 0, `${phase}: see complete redacted command result`); return result.stdout; };
  const ownerSql = query => capture('owner-sql', ['docker', 'compose', 'exec', 'owner-sql-stdin'], () => exec([...compose, 'exec', '--no-TTY', '--interactive', 'dolt', '/bin/bash', '-c',
    'export DOLT_CLI_PASSWORD; DOLT_CLI_PASSWORD=$(cat /run/secrets/dolt_root); exec dolt --host=127.0.0.1 --port=3306 --user=noticeos_owner --no-tls sql --result-format=json --batch'], { stdin: query + '\n' }));
  const parse = result => { okay(result, 'SQL'); return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1)?.rows ?? []; };
  const tenantSql = (tenant, query, database = tenant.database) => capture(`sql-${tenant.user}`, ['dolt', '--user', tenant.user, '--use-db', database, 'sql', query], () => exec([...compose, 'exec', '--no-TTY', '--interactive', 'dolt', '/bin/bash', '-c',
    'read -r DOLT_CLI_PASSWORD; export DOLT_CLI_PASSWORD; exec dolt --host=127.0.0.1 --port=3306 --user="$1" --no-tls --use-db="$2" sql --result-format=json --batch', 'qualification', tenant.user, database], { stdin: tenant.password + '\n' + query + '\n' }));
  const clients = ['a', 'b'].map((key, i) => ({ key, database: `tasks_${key}`, user: `tenant${key}`, password: taskSecrets[i], repo: path.join(base, `repo-${key}`), clientHome: path.join(base, `client-${key}`), credentialsFile: path.join(base, `credentials-${key}`) }));
  const bd = (tenant, args, provision = false, extra = {}) => capture(`bd-${tenant.user}`, ['bd', '--sandbox', '--actor', tenant.user, ...args], () => runCommand(binary, ['--sandbox', '--actor', tenant.user, ...args], {
    cwd: tenant.repo, timeoutMs: 30_000,
    env: provision ? { ...doltEnvironment(profile, env), BEADS_DOLT_PASSWORD: readDoltCredentials(profile).noticeos.trim() }
      : { ...taskClientEnvironment({ host: '127.0.0.1', port: profile.port, user: tenant.user, clientHome: tenant.clientHome, credentialsFile: tenant.credentialsFile }, env), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra },
  }));
  const roots = async () => Object.fromEntries(await Promise.all(clients.map(async tenant => [tenant.key, {
    roots: parse(await ownerSql(`USE ${tenant.database}; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working,DOLT_HASHOF_DB('archive') AS archive;`)),
    issues: parse(await ownerSql(`USE ${tenant.database}; SELECT id,title,status FROM issues ORDER BY id;`)),
  }])));
  try {
    const version = await runCommand(binary, ['--version'], { env, cwd: base, timeoutMs: 5_000 });
    summary.binaryVersion = version;
    save();
    assert.match(okay(version, 'pinned Beads release').trim(), /^bd version 1\.3\.1(?:\s|$)/u);
    const image = await exec(['image', 'inspect', DOLT_IMAGE, '--format', '{{.Id}}']);
    assert.equal(okay(image, 'cached image').trim(), imageId);
    const cleanupBase = path.join(base, 'cleanup'); fs.mkdirSync(cleanupBase, { mode: 0o700 });
    cleanup = containerProofCleanup({ base: cleanupBase, project: profile.project, image: '', mounts: [], runDocker: exec });
    await cleanup.proveFresh();
    const prepared = await prepareFreshDolt({ root, home, port }, { fresh: true, env, run: (_bin, args, options) => exec(args, options) });
    assert.equal(prepared.ok, true, prepared.line);
    const secrets = [...taskSecrets, ...Object.values(readDoltCredentials(profile)).map(text => text.trim())];
    knownSecrets = secrets;
    record = commandEvidence(path.join(evidence, `commands-${path.basename(base)}`), { secrets });
    assert.deepEqual(parse(await ownerSql('SELECT DOLT_VERSION() AS version;')), [{ version: '2.4.0' }]);
    const ids = okay(await exec([...compose, 'ps', '--all', '--quiet', 'dolt']), 'exact own container').trim();
    assert.match(ids, /^[a-f0-9]{64}$/u); summary.containerId = ids; save();
    for (const tenant of clients) {
      fs.mkdirSync(tenant.repo, { mode: 0o700 }); fs.mkdirSync(tenant.clientHome, { mode: 0o700 });
      fs.writeFileSync(tenant.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${tenant.password}\n`, { mode: 0o600, flag: 'wx' });
      okay(await runCommand('git', ['init', '--quiet', tenant.repo], { env, cwd: base }), 'new synthetic checkout');
      okay(await ownerSql(`CREATE DATABASE ${tenant.database}; CREATE USER '${tenant.user}'@'%' IDENTIFIED BY '${tenant.password}';`), 'provision database and identity');
      okay(await bd(tenant, ['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', String(profile.port), '--server-user', 'noticeos', '--database', tenant.database, '--prefix', 'tt', '--non-interactive', '--skip-hooks', '--skip-agents'], true), 'privileged init');
      fs.appendFileSync(path.join(tenant.repo, '.beads/config.yaml'), '\nno-git-ops: true\nimport.auto: false\n');
      okay(await bd(tenant, ['create', `Owned ${tenant.key} seed`, '--id', 'tt-collision', '--description', `Private ${tenant.key} content`, '--json'], true), 'colliding seed task');
      okay(await ownerSql(`USE ${tenant.database}; CREATE TABLE ownership_marker (id INT PRIMARY KEY,value TEXT); INSERT INTO ownership_marker VALUES (1,'${tenant.key} archive'); CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Owned history canary','--author','Synthetic <synthetic@example.com>'); CALL DOLT_BRANCH('archive');`), 'own history branch');
      okay(await ownerSql(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tenant.database}.* TO '${tenant.user}'@'%'; GRANT EXECUTE ON PROCEDURE ${tenant.database}.dolt_add TO '${tenant.user}'@'%'; GRANT EXECUTE ON PROCEDURE ${tenant.database}.dolt_commit TO '${tenant.user}'@'%';`), 'ordinary candidate grants');
    }
    okay(await ownerSql("USE tasks_a; DELETE FROM dolt_branch_control; INSERT INTO dolt_branch_control VALUES ('%', '%', 'noticeos_owner', 'localhost', 'admin'),('%', '%', 'noticeos', '%', 'admin'),('tasks\\_a','main','tenanta','%','write'),('tasks\\_b','main','tenantb','%','write'); INSERT INTO dolt_branch_namespace_control VALUES ('%','%','','');"), 'branch restriction');
    for (const tenant of clients) {
      const attempts = [['show', 'tt-collision', '--json'], ['create', `New ${tenant.key} task`, '--id', 'tt-new', '--description', 'Owned ordinary task', '--json'], ['update', 'tt-collision', '--status', 'in_progress'], ['comments', 'add', 'tt-collision', 'Owned handoff'], ['close', 'tt-collision', '--reason', 'Owned acceptance verified'], ['history', 'tt-collision', '--json']];
      for (const args of attempts) { const result = await bd(tenant, args); summary.ordinary.push({ tenant: tenant.key, grants: 'DML+add+commit', args, code: result.code, stdout: result.stdout, stderr: result.stderr }); save(); }
      okay(await ownerSql(`GRANT EXECUTE ON PROCEDURE ${tenant.database}.dolt_checkout TO '${tenant.user}'@'%';`), 'narrow supported history capability');
      const history = await bd(tenant, ['history', 'tt-collision', '--limit', '5', '--json']);
      summary.ordinary.push({ tenant: tenant.key, grants: 'DML+add+commit+checkout', args: ['history', 'tt-collision', '--limit', '5', '--json'], code: history.code, stdout: history.stdout, stderr: history.stderr });
      const list = await bd(tenant, ['list', '--all', '--json']);
      summary.ordinary.push({ tenant: tenant.key, grants: 'DML+add+commit+checkout', args: ['list', '--all', '--json'], code: list.code, stdout: list.stdout, stderr: list.stderr });
      save();
    }
    const initial = await roots();
    const ownedContainerPath = `/tmp/${profile.project}-denied`;
    const fileMarker = 'Only the generated fixture contains this marker.';
    okay(await exec([...compose, 'exec', '--no-TTY', '--interactive', 'dolt', '/bin/bash', '-c',
      'umask 077; set -o noclobber; cat > "$1"', 'qualification', `${ownedContainerPath}-canary`], { stdin: fileMarker }), 'exclusive synthetic file canary');
    const attacks = [
      ['foreign-select', 'SELECT id,title FROM tasks_b.issues', 'tasks_a'],
      ['foreign-revision', 'SELECT id,title FROM `tasks_b/archive`.issues', 'tasks_a'],
      ['foreign-update', "UPDATE tasks_b.issues SET title='Crossed boundary' WHERE id='tt-collision'", 'tasks_a'],
      ['foreign-database-selection', 'SELECT id,title FROM issues', 'tasks_b'],
      ['own-archive-write', "UPDATE ownership_marker SET value='Changed archive' WHERE id=1", 'tasks_a/archive'],
      ['create-database', 'CREATE DATABASE unauthorized_fixture', 'tasks_a'],
      ['alter-table', 'ALTER TABLE issues ADD COLUMN forbidden_fixture INT', 'tasks_a'],
      ['branch-create', "CALL DOLT_BRANCH('forbidden-branch')", 'tasks_a'],
      ['checkout-create', "CALL DOLT_CHECKOUT('-b','forbidden-checkout')", 'tasks_a'],
      ['checkout-archive-write', "CALL DOLT_CHECKOUT('archive'); UPDATE ownership_marker SET value='Checkout changed archive' WHERE id=1", 'tasks_a'],
      ['branch-control-edit', "INSERT INTO dolt_branch_control VALUES ('%', '%', 'tenanta', '%', 'admin')", 'tasks_a'],
      ['backup', `CALL DOLT_BACKUP('sync-url','file://${ownedContainerPath}-backup')`, 'tasks_a'],
      ['remote', `CALL DOLT_REMOTE('add','forbidden','file://${ownedContainerPath}-remote')`, 'tasks_a'],
      ['push', "CALL DOLT_PUSH('missing_fixture_remote','main')", 'tasks_a'],
      ['grant', "GRANT ALL ON *.* TO 'tenanta'@'%'", 'tasks_a'],
      ['mysql-users', 'SELECT User,Host FROM mysql.user', 'tasks_a'],
      ['read-file', `SELECT LOAD_FILE('${ownedContainerPath}-canary') AS body`, 'tasks_a'],
    ];
    for (const [label, query, database] of attacks) {
      const result = await tenantSql(clients[0], query, database);
      summary.attempts.push({ label, query, database, code: result.code, stdout: result.stdout, stderr: result.stderr }); save();
    }
    summary.beforeAttacks = initial; summary.afterAttacks = await roots();
    summary.branchInventory = {};
    for (const tenant of clients) summary.branchInventory[tenant.key] = parse(await ownerSql(`USE ${tenant.database}; SELECT name,hash FROM dolt_branches ORDER BY name;`));
    summary.branchControl = parse(await ownerSql('USE tasks_a; SELECT * FROM dolt_branch_control ORDER BY `database`,branch,user,host;'));
    summary.branchNamespaces = parse(await ownerSql('USE tasks_a; SELECT * FROM dolt_branch_namespace_control ORDER BY `database`,branch,user,host;'));
    summary.archiveContext = parse(await tenantSql(clients[0], 'SELECT ACTIVE_BRANCH() AS branch,DATABASE() AS db,CURRENT_USER() AS actor', 'tasks_a/archive'));
    summary.archiveMarker = parse(await tenantSql(clients[0], 'SELECT * FROM ownership_marker', 'tasks_a/archive'));
    summary.ownerFileReadControl = parse(await ownerSql(`SELECT LOAD_FILE('${ownedContainerPath}-canary') AS body;`));
    summary.ownArchiveRead = parse(await tenantSql(clients[0], 'SELECT id,title FROM issues ORDER BY id', 'tasks_a/archive'));
    summary.tenantGrants = parse(await ownerSql("SHOW GRANTS FOR 'tenanta'@'%';"));
    const foreignInput = path.join(clients[1].repo, 'foreign-task.md');
    fs.writeFileSync(foreignInput, '## Foreign fixture file\n\nOnly tenant B should resolve this path.\n', { mode: 0o600 });
    const fileRead = await bd(clients[0], ['create', '--file', foreignInput, '--json']);
    summary.localSelectors = [{ label: 'foreign-owned-file-input', args: ['create','--file',foreignInput,'--json'], code: fileRead.code, stdout: fileRead.stdout, stderr: fileRead.stderr }];
    const configWrite = await bd(clients[0], ['config', 'set', 'fixture.untrusted-selector', 'changed-local-config']);
    summary.localSelectors.push({ label: 'raw-local-config-write', args: ['config','set','fixture.untrusted-selector','changed-local-config'], code: configWrite.code, stdout: configWrite.stdout, stderr: configWrite.stderr });
    const selectedForeign = await bd(clients[0], ['show', 'tt-collision', '--json'], false, { BEADS_DOLT_DATABASE: clients[1].database });
    summary.localSelectors.push({ label: 'foreign-database-env', code: selectedForeign.code, stdout: selectedForeign.stdout, stderr: selectedForeign.stderr });
    const foreignOutput = path.join(clients[1].repo, 'unauthorized-profile.out');
    const profileWrite = await bd(clients[0], ['--mem-profile', foreignOutput, 'show', 'tt-collision', '--json']);
    summary.localSelectors.push({ label: 'foreign-owned-file-output', code: profileWrite.code, fileCreated: fs.existsSync(foreignOutput), stdout: profileWrite.stdout, stderr: profileWrite.stderr });
    const foreignDatabase = await bd(clients[0], ['--database', clients[1].database, 'show', 'tt-collision', '--json']);
    summary.localSelectors.push({ label: 'foreign-database-flag', code: foreignDatabase.code, stdout: foreignDatabase.stdout, stderr: foreignDatabase.stderr });
    for (const attempt of summary.ordinary) {
      assert.equal(attempt.code, attempt.args[0] === 'history' && !attempt.args.includes('--limit') ? 1 : 0,
        `${attempt.tenant} ${attempt.args[0]}: recorded exact ordinary grants`);
      if (attempt.args[0] === 'history' && !attempt.args.includes('--limit')) {
        assert.match(JSON.parse(attempt.stdout).error,
          /failed to get history: checkout active branch.*Error 1142.*command denied/iu,
          'History specifically requires the otherwise ungranted checkout procedure');
      }
      if (attempt.args[0] === 'show' || attempt.args[0] === 'list') {
        assert.ok(attempt.stdout.includes(`Private ${attempt.tenant} content`));
        assert.ok(!attempt.stdout.includes(`Private ${attempt.tenant === 'a' ? 'b' : 'a'} content`));
      }
    }
    for (const attempt of summary.attempts) {
      if (attempt.label === 'checkout-create' || attempt.label === 'read-file') assert.equal(attempt.code, 0);
      else {
        assert.notEqual(attempt.code, 0, attempt.label);
        assert.match(attempt.stderr, /(?:Access denied|command denied|correct permissions|cannot add the row)/iu, attempt.label);
      }
    }
    assert.deepEqual(summary.beforeAttacks, summary.afterAttacks, 'Foreign and existing branch roots/content remain unchanged');
    assert.ok(summary.branchInventory.a.some(branch => branch.name === 'forbidden-checkout'), 'Checkout privilege also permits own branch creation');
    assert.ok(!summary.branchInventory.b.some(branch => branch.name === 'forbidden-checkout'));
    assert.deepEqual(summary.archiveMarker, [{ id: '1', value: 'a archive' }]);
    const fileAttempt = summary.attempts.find(attempt => attempt.label === 'read-file');
    assert.deepEqual(JSON.parse(fileAttempt.stdout).rows, [{ body: fileMarker }], 'Tenant LOAD_FILE returns the exact owned canary, not NULL');
    assert.deepEqual(summary.ownerFileReadControl, [{ body: fileMarker }]);
    assert.ok(!summary.tenantGrants.some(grant => /\bFILE\b/iu.test(Object.values(grant).join(' '))), 'The tenant has no FILE grant');
    assert.equal(fileRead.code, 0, 'Raw bd can consume a foreign owned input file under the shared host UID');
    assert.equal(profileWrite.code, 0);
    assert.equal(fs.existsSync(foreignOutput), true, 'Raw profiling flags can write a foreign owned file');
    assert.equal(configWrite.code, 0, 'Raw bd can change its own configuration');
    assert.equal(selectedForeign.code, 0);
    assert.ok(selectedForeign.stdout.includes('Private a content'), 'This environment selector does not replace the stored database');
    assert.notEqual(foreignDatabase.code, 0, 'Native external mode refuses proxied database overrides');
    assert.deepEqual((await roots()).b, summary.beforeAttacks.b, 'Local selector attempts never change the other database');
    summary.qualification = { testedForeignDatabaseAndRevisionAttemptsDenied: true, rawExecutorIsolation: false,
      reason: 'Tested separate database credentials deny foreign database/revision access, but server file reads and raw file/configuration/checkout capabilities require trusted fixed-command NoticeOS execution.' };
    summary.stages.push('initial candidate explored'); save();
  } catch (error) { summary.failure = String(error.message); save(); throw error; }
  finally {
    summary.uncertainProcess = uncertain;
    if (cleanup && !uncertain) {
      const cleaned = await cleanup.finish([() => exec([...compose, 'down', '--volumes'], { timeoutMs: 90_000 })]);
      summary.cleanup = cleaned;
      const gone = await exec(['volume', 'inspect', `${profile.project}_dolt-data`]);
      assert.notEqual(gone.code, 0); assert.match(gone.stderr, /no such volume/iu); summary.volumeAbsent = true;
      // Keep redacted receipts, retire only exact fresh client profiles/secrets.
      fs.rmSync(base, { recursive: true }); summary.ownedFixtureRetired = true;
    }
    save();
  }
  console.log(JSON.stringify({ fixture: base, ordinary: summary.ordinary.map(({tenant,args,code}) => ({tenant,args,code})), attacks: summary.attempts.map(({label,code}) => ({label,code})), cleanup: summary.ownedFixtureRetired }, null, 2));
});
