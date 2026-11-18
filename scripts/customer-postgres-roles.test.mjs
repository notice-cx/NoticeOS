import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { customerPostgresRoles, roleStack } from './customer-postgres-roles.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { scramVerifier } from './postgres-scram.mjs';

const image = 'postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722';
const hbaTarget = '/etc/noticeos/pg_hba.conf';
const baseline = fs.readFileSync(new URL('../db/postgres/host/pg_hba.conf', import.meta.url), 'utf8');
const spec = (file, port) => ({ postgres: { command: ['postgres', '-c', `hba_file=${hbaTarget}`], networks: { default: {} },
  volumes: [{ type: 'bind', source: file, target: hbaTarget, read_only: true }, { type: 'volume', source: 'data', target: '/var/lib/postgresql' }],
  ports: [{ host_ip: '127.0.0.1', target: 5432, published: String(port) }] } });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

test('role preparation stages a private mount for a checkout HBA and refuses an externally published database', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-role-plan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'shared.conf'), envFile = path.join(root, 'installation.env'), compose = path.join(root, 'compose.yaml');
  const config = path.join(root, 'stack.json'), directory = path.join(root, 'plan');
  const selector = { project: 'noticeos-role-fixture', files: [compose], envFile, dockerHost: 'unix:///tmp/local-fixture.sock' };
  fs.writeFileSync(file, baseline, { mode: 0o644 }); fs.writeFileSync(envFile, ''); fs.writeFileSync(compose, ''); write(config, selector);
  const services = spec(file, 25432), declaration = { services, volumes: { data: { name: 'role-fixture-data' } } };
  const run = async (_bin, args) => {
    assert.deepEqual(args.slice(-3), ['config', '--format', 'json']);
    return { code: 0, stdout: JSON.stringify(declaration) };
  };
  assert.equal((await customerPostgresRoles('prepare', { config, directory }, { run })).privateMountPrepared, true);
  const staged = JSON.parse(fs.readFileSync(path.join(directory, 'stack.with-private-hba.json'), 'utf8'));
  assert.deepEqual(staged.files, [compose, path.join(directory, 'private-hba.compose.json')]);
  assert.equal(fs.readFileSync(file, 'utf8'), baseline);
  assert.equal(fs.readFileSync(path.join(directory, 'pg_hba.conf'), 'utf8'), baseline);
  assert.equal(fs.statSync(path.join(directory, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  await assert.rejects(customerPostgresRoles('apply', { config, directory, confirmation: 'other' }, { run }), /exact selected/u);
  await assert.rejects(customerPostgresRoles('apply', { config, directory, confirmation: selector.project }, { run }), /private mount/u);
  const credentialsPath = path.join(directory, 'credentials.json');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const accidentalCopy = new URL(credentials.noticeos_platform.loopback);
  accidentalCopy.password = 'x'.repeat(32);
  credentials.noticeos_platform.loopback = accidentalCopy.href;
  write(credentialsPath, credentials);
  services.postgres.volumes[0].source = path.join(directory, 'pg_hba.conf');
  await assert.rejects(customerPostgresRoles('apply', { config: path.join(directory, 'stack.with-private-hba.json'), directory,
    confirmation: selector.project }, { run }), /credentials do not match/u);
  services.postgres.ports[0].host_ip = '0.0.0.0';
  assert.throws(() => roleStack(selector, declaration), /loopback/u);
});

test('disposable OrbStack keeps the identical HBA bind and older credentials across apply, retry and rollback', {
  skip: process.env.NOTICEOS_TEST_CONTAINER_ROLES !== '1', timeout: 150_000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-role-compose-')));
  let cleanup;
  t.after(async () => {
    await cleanup?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dockerHost = await localDockerEndpoint(runCommand);
  assert.ok(dockerHost, 'use the explicit local Docker socket');
  const project = `noticeos-role-proof-${randomBytes(8).toString('hex')}`;
  const listen = net.createServer();
  await new Promise((resolve, reject) => listen.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listen.address().port;
  await new Promise(resolve => listen.close(resolve));
  const envFile = path.join(root, 'installation.env'), config = path.join(root, 'stack.json'), composeFile = path.join(root, 'compose.json');
  const shared = path.join(root, 'shared', 'pg_hba.conf');
  const installed = path.join(root, 'stack', 'db/postgres/host/pg_hba.conf');
  const seed = path.join(root, '10-roles.sql');
  for (const file of [shared, installed]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, baseline, { mode: 0o644 }); }
  const appPassword = randomBytes(24).toString('base64url');
  const roles = fs.readFileSync(new URL('../db/postgres/roles.sql', import.meta.url), 'utf8');
  fs.writeFileSync(seed, `${roles}\nALTER ROLE noticeos_app LOGIN PASSWORD '${scramVerifier(appPassword)}';
    CREATE DATABASE noticeos OWNER noticeos_owner;
    REVOKE CONNECT ON DATABASE noticeos FROM PUBLIC;
    GRANT CONNECT ON DATABASE noticeos TO noticeos_app, noticeos_maint;`);
  fs.writeFileSync(envFile, '');
  write(config, { project, dockerHost, envFile, files: [composeFile] });
  const own = (files, ...args) => runCommand('docker', ['--host', dockerHost, 'compose', '-p', project,
    ...files.flatMap(file => ['-f', file]), '--env-file', envFile, ...args], { timeoutMs: 60_000 });
  const definition = file => {
    const services = spec(file, port);
    Object.assign(services.postgres, { image, pull_policy: 'never', environment: { POSTGRES_HOST_AUTH_METHOD: 'trust' },
      healthcheck: { test: ['CMD', 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'], interval: '1s', timeout: '2s', retries: 30 } });
    services.postgres.volumes.push({ type: 'bind', source: seed, target: '/docker-entrypoint-initdb.d/10-roles.sql', read_only: true });
    write(composeFile, { services, volumes: { data: { name: `${project}-data` } } });
  };
  definition(shared);
  const empty = await own([composeFile], 'ps', '--all', '--quiet');
  assert.equal(empty.code, 0); assert.equal(empty.stdout.trim(), '');
  cleanup = async () => {
    const stopped = await own([composeFile], 'down', '--volumes');
    assert.equal(stopped.code, 0, 'remove only the owned project');
  };
  const start = async (...files) => {
    const answer = await own(files, 'up', '--detach', '--wait', '--wait-timeout', '45', '--pull', 'never', 'postgres');
    assert.equal(answer.code, 0, answer.stderr);
  };
  await start(composeFile);
  const admin = async (file, statement) => {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = await own(config.files, 'exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', 'noticeos', '-c', statement);
    assert.equal(value.code, 0, 'the owned database answered');
    return value.stdout.trim();
  };
  const baseState = `SELECT rolname, md5(coalesce(rolpassword,'')), has_database_privilege(oid, 'noticeos', 'CONNECT')
    FROM pg_authid WHERE rolname IN ('noticeos_app','noticeos_maint') ORDER BY rolname;`;
  const originalGrants = await admin(config, baseState);
  const first = path.join(root, 'checkout-plan');
  assert.equal((await customerPostgresRoles('prepare', { config, directory: first })).privateMountPrepared, true);
  await assert.rejects(customerPostgresRoles('apply', { config, directory: first, confirmation: project }), /private mount/u);
  const overlay = path.join(first, 'stack.with-private-hba.json');
  const selections = JSON.parse(fs.readFileSync(overlay, 'utf8')).files;
  await start(...selections);
  const forPlan = (directory, selected = config) => action => customerPostgresRoles(action, { directory, config: selected, confirmation: project });
  const checkout = forPlan(first, overlay);
  const loginState = expected => ({ noticeos_platform: expected, noticeos_identity: expected, noticeos_service_grant: expected });
  assert.deepEqual((await checkout('status')).logins, loginState(false));
  assert.equal((await checkout('apply')).enabled, true);
  assert.equal((await checkout('apply')).enabled, true);
  assert.deepEqual((await checkout('status')).logins, loginState(true));
  const credentials = JSON.parse(fs.readFileSync(path.join(first, 'credentials.json'), 'utf8'));
  const { Client } = createRequire(new URL('../packages/postgres/package.json', import.meta.url))('pg');
  const active = new Client({ connectionString: credentials.noticeos_service_grant.loopback });
  await active.connect();
  try { await assert.rejects(checkout('rollback'), /Role changes refused/u); }
  finally { await active.end(); }
  assert.equal((await checkout('rollback')).enabled, false);
  assert.deepEqual((await checkout('status')).logins, loginState(false));
  assert.equal(await admin(overlay, baseState), originalGrants);
  assert.equal(fs.readFileSync(shared, 'utf8'), baseline);
  assert.equal(fs.readFileSync(path.join(first, 'pg_hba.conf'), 'utf8'), baseline);

  definition(installed);
  await start(composeFile);
  const second = path.join(root, 'installed-plan');
  assert.equal((await customerPostgresRoles('prepare', { config, directory: second })).privateMountPrepared, false);
  const installedRoles = forPlan(second);
  const inode = fs.statSync(installed).ino;
  assert.equal((await installedRoles('apply')).enabled, true);
  assert.equal((await installedRoles('rollback')).enabled, false);
  assert.equal(fs.statSync(installed).ino, inode);
  const readonlyPreexisting = 'host all all samenet scram-sha-256\n';
  fs.appendFileSync(installed, readonlyPreexisting);
  const unsafePlan = path.join(root, 'broader-rules');
  await customerPostgresRoles('prepare', { config, directory: unsafePlan });
  await assert.rejects(forPlan(unsafePlan)('apply'), /broader access/u);
  assert.equal(fs.readFileSync(installed, 'utf8'), baseline + readonlyPreexisting);
  fs.truncateSync(installed, Buffer.byteLength(baseline));
  const custom = scramVerifier(randomBytes(24).toString('base64url'));
  await admin(config, `ALTER ROLE noticeos_identity LOGIN PASSWORD '${custom}'; GRANT CONNECT ON DATABASE noticeos TO noticeos_identity;`);
  const before = await admin(config, `SELECT rolname, rolcanlogin, md5(coalesce(rolpassword,'')), has_database_privilege(oid, 'noticeos', 'CONNECT')
    FROM pg_authid WHERE rolname IN ('noticeos_platform','noticeos_identity','noticeos_service_grant') ORDER BY rolname;`);
  await assert.rejects(installedRoles('apply'), /Role changes refused/u);
  assert.equal(await admin(config, `SELECT rolname, rolcanlogin, md5(coalesce(rolpassword,'')), has_database_privilege(oid, 'noticeos', 'CONNECT')
    FROM pg_authid WHERE rolname IN ('noticeos_platform','noticeos_identity','noticeos_service_grant') ORDER BY rolname;`), before);
  assert.equal(await admin(config, baseState), originalGrants);
  assert.equal(fs.readFileSync(installed, 'utf8'), baseline);
});
