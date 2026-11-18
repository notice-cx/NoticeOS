#!/usr/bin/env node
// Preview, enable or reverse the dedicated Postgres logins for a local customer workspace.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { holdLock } from './history-files.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { ENV_FILE, STACK_DIR } from './installation-layout.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { DATABASE, connectionString } from './postgres-secrets.mjs';
import { runCommand } from './run-command.mjs';
import { readSelector } from './stack-control.mjs';
import { composePrefix } from './stack-database.mjs';

const FORMAT = 'noticeos-customer-postgres-roles/1';
const roles = ['noticeos_platform', 'noticeos_identity', 'noticeos_service_grant'];
const hbaTarget = '/etc/noticeos/pg_hba.conf';
const hbaRule = `host    ${DATABASE}  ${roles.join(',')}  samenet  scram-sha-256`;
const hbaAddition = `\n# NoticeOS customer roles\n${hbaRule}\n`;
const usage = 'Use prepare, status, apply or rollback with --config <stack selector> --plan <private directory>. Apply and rollback require --confirm <project>.';
const refuse = message => { throw new RoleRefused(message); };
class RoleRefused extends Error {}
const privateWrite = (file, data) => fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readText = fd => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd));

function localEnvironment(env) {
  return Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

function safeFile(file, { privateFile = false, maxBytes = 32_768 } = {}) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) refuse('Use the absolute path to a regular file.');
  const flag = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(file, flag);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.uid !== process.getuid()
      || stat.mode & (privateFile ? 0o077 : 0o022)) refuse('The selected file ownership or permissions are unsafe.');
    return readText(fd);
  } finally { fs.closeSync(fd); }
}

export function roleStack(selector, declaration) {
  const install = path.dirname(selector.envFile);
  if (path.basename(selector.envFile) !== ENV_FILE) refuse('Select a prepared NoticeOS installation with installation.env.');
  const db = declaration.services?.postgres;
  const ports = db?.ports ?? [];
  const binds = (db?.volumes ?? []).filter(item => item.target === hbaTarget);
  const data = (db?.volumes ?? []).filter(item => item.target === '/var/lib/postgresql');
  const port = Number(ports[0]?.published);
  if (binds.length !== 1 || binds[0].type !== 'bind' || binds[0].read_only !== true || typeof binds[0].source !== 'string'
    || !Array.isArray(db.command) || !db.command.includes(`hba_file=${hbaTarget}`)
    || ports.length !== 1 || ports[0].host_ip !== '127.0.0.1' || Number(ports[0].target) !== 5432
    || !Number.isInteger(port) || port < 1 || port > 65535 || Object.keys(db?.networks ?? {}).length !== 1
    || data.length !== 1 || data[0].type !== 'volume' || !declaration.volumes?.[data[0].source]?.name) {
    refuse('Use the existing local Postgres service with its private network, loopback port, data volume and HBA bind.');
  }
  const hba = binds[0].source;
  const owned = [path.join(install, STACK_DIR, 'db/postgres/host/pg_hba.conf'), path.join(install, 'postgres/pg_hba.conf')].includes(hba);
  return { project: selector.project, dockerHost: selector.dockerHost, volume: declaration.volumes[data[0].source].name, port, hba, owned };
}

function prepare(directory, selector, target) {
  const base = safeFile(target.hba, { maxBytes: 31_000 });
  if (base.includes('# NoticeOS customer roles')) refuse('This HBA already has a role preparation. Use its existing plan.');
  if (!target.owned && selector.files.length >= 8) refuse('The stack has no room for a private HBA declaration.');
  if (fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)) refuse('Use a new directory under an existing private location.');
  fs.mkdirSync(directory, { mode: 0o700 });
  const passwords = roles.map(role => {
    const password = randomBytes(24).toString('base64url');
    return { role, verifier: scramVerifier(password), ...roleAddresses(role, password, target.port) };
  });
  let hba = target.hba;
  if (!target.owned) {
    // A checkout template can serve more than one installation. Stage a
    // dedicated file and leave the existing selector and mount alone.
    hba = path.join(directory, 'pg_hba.conf');
    fs.writeFileSync(hba, base, { flag: 'wx', mode: 0o644 });
    const overlay = path.join(directory, 'private-hba.compose.json');
    privateWrite(overlay, json({ services: { postgres: { volumes: [{ type: 'bind', source: hba, target: hbaTarget,
      read_only: true, bind: { create_host_path: false } }] } } }));
    privateWrite(path.join(directory, 'stack.with-private-hba.json'), json({ ...selector, files: [...selector.files, overlay] }));
  }
  privateWrite(path.join(directory, 'original-hba.conf'), base);
  privateWrite(path.join(directory, 'credentials.json'), json(Object.fromEntries(passwords.map(row => [row.role, { loopback: row.loopback, internal: row.internal }]))));
  privateWrite(path.join(directory, 'plan.json'), json({ format: FORMAT, ...target, hba, verifiers: passwords.map(row => row.verifier) }));
  return { project: target.project, database: DATABASE, roles, privateMountPrepared: !target.owned };
}

function roleAddresses(role, password, port) {
  const loopback = connectionString(role, password, port);
  const internal = new URL(loopback); internal.hostname = 'postgres'; internal.port = '5432';
  return { loopback, internal: internal.href };
}

function readPlan(directory, target) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077 || fs.realpathSync(directory) !== directory) refuse('Use the private role plan directory.');
  const plan = JSON.parse(safeFile(path.join(directory, 'plan.json'), { privateFile: true }));
  const source = plan.owned ? target.owned : target.hba === path.join(directory, 'pg_hba.conf');
  if (plan.format !== FORMAT || !source || ['project', 'dockerHost', 'volume', 'port', 'hba'].some(key => target[key] !== plan[key])
    || !Array.isArray(plan.verifiers) || plan.verifiers.length !== roles.length || plan.verifiers.some(value =>
      typeof value !== 'string' || !/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u.test(value))) {
    refuse('The role plan and selected installation do not match. A shared HBA needs the staged private mount.');
  }
  const creds = JSON.parse(safeFile(path.join(directory, 'credentials.json'), { privateFile: true }));
  for (const [index, role] of roles.entries()) {
    let password;
    try { password = new URL(creds[role]?.loopback).password; } catch { /* Invalid below. */ }
    const verifier = plan.verifiers[index];
    const salt = Buffer.from(verifier.slice(verifier.indexOf(':') + 1, verifier.lastIndexOf('$')), 'base64');
    const addresses = roleAddresses(role, password, plan.port);
    if (!/^[A-Za-z0-9_-]{32}$/u.test(password ?? '') || salt.length !== 16 || creds[role].loopback !== addresses.loopback
      || creds[role].internal !== addresses.internal || scramVerifier(password, { salt }) !== verifier) {
      refuse('The prepared credentials do not match this role plan.');
    }
  }
  return { ...plan, creds, base: safeFile(path.join(directory, 'original-hba.conf'), { privateFile: true }) };
}

function roleUnit(plan, enable) {
  const insert = roles.map((role, index) => `('${role}', '${plan.verifiers[index]}')`).join(',');
  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('noticeos.customer-postgres-roles/1', 0));
DO $role_prep$
DECLARE requested record; existing record; connects boolean; inactive boolean; prepared boolean;
BEGIN
  IF current_user <> 'postgres' OR current_database() <> '${DATABASE}' OR current_setting('server_version_num')::int / 10000 <> 18 THEN
    RAISE EXCEPTION 'role preparation target';
  END IF;
  ${enable ? '' : `IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename IN (${roles.map(role => `'${role}'`).join(',')})) THEN
    RAISE EXCEPTION 'scoped role sessions are still active';
  END IF;`}
  FOR requested IN SELECT * FROM (VALUES ${insert}) AS requested(name, verifier) LOOP
    SELECT * INTO existing FROM pg_catalog.pg_authid WHERE rolname = requested.name;
    IF NOT FOUND OR existing.rolsuper OR existing.rolbypassrls OR existing.rolreplication OR existing.rolcreatedb
      OR existing.rolcreaterole OR existing.rolinherit OR existing.rolvaliduntil IS NOT NULL
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid=existing.oid OR member=existing.oid) THEN
      RAISE EXCEPTION 'role preparation privileges';
    END IF;
    connects := has_database_privilege(existing.oid, current_database(), 'CONNECT');
    inactive := NOT existing.rolcanlogin AND existing.rolpassword IS NULL AND NOT connects;
    prepared := existing.rolcanlogin AND existing.rolpassword IS NOT DISTINCT FROM requested.verifier AND connects;
    IF NOT (inactive OR prepared) THEN RAISE EXCEPTION 'role preparation would overwrite existing access'; END IF;
    ${enable ? `IF inactive THEN
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', requested.name, requested.verifier);
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), requested.name);
    END IF;` : `IF prepared THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', requested.name);
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), requested.name);
    END IF;`}
  END LOOP;
END; $role_prep$;
COMMIT;`;
}

function changeHba(file, base, desired) {
  const flag = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(file, flag);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o022 || stat.size > 32_768
      || fs.realpathSync(file) !== file) refuse('The private HBA file changed.');
    const contents = readText(fd);
    const currentAddition = contents.slice(base.length);
    if (!contents.startsWith(base) || !hbaAddition.startsWith(currentAddition)) refuse('The HBA has other changes. Keep its current contents and review the plan.');
    if (contents === desired) return;
    // PostgreSQL holds the existing bind inode. Preserve the original bytes
    // so an interrupted append can be retried with the same plan.
    fs.ftruncateSync(fd, Buffer.byteLength(base));
    if (desired !== base) {
      const addition = Buffer.from(hbaAddition);
      if (fs.writeSync(fd, addition, 0, addition.length, Buffer.byteLength(base)) !== addition.length) refuse('The HBA write was interrupted. Retry the same plan.');
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export async function customerPostgresRoles(action, { directory, config, confirmation }, { run = runCommand, env = process.env } = {}) {
  if (!['prepare', 'status', 'apply', 'rollback'].includes(action) || !path.isAbsolute(directory ?? '') || !path.isAbsolute(config ?? '')) refuse(usage);
  const selector = readSelector(config);
  if (['apply', 'rollback'].includes(action) && confirmation !== selector.project) refuse('Confirm the exact selected Compose project.');
  const docker = (args, stdin = null) => run('docker', [...composePrefix(selector), ...args], { env: localEnvironment(env), timeoutMs: 20_000, stdin });
  const resolved = await docker(['config', '--format', 'json']);
  if (resolved.code !== 0) refuse('Compose could not read the selected declaration.');
  const target = roleStack(selector, JSON.parse(resolved.stdout));
  if (action === 'prepare') return prepare(directory, selector, target);
  const plan = readPlan(directory, target);
  const runtime = await docker(['ps', '--quiet', 'postgres']);
  const container = runtime.stdout.trim();
  if (runtime.code !== 0 || !/^[a-f0-9]{64}$/u.test(container)) refuse('The selected PostgreSQL container is unavailable.');
  const inspected = await run('docker', ['--host', target.dockerHost, 'inspect', '--type', 'container', container], {
    env: localEnvironment(env), timeoutMs: 20_000,
  });
  if (inspected.code !== 0) refuse('The selected PostgreSQL container could not be inspected.');
  const [actual] = JSON.parse(inspected.stdout);
  const mounts = actual?.Mounts ?? [];
  const mappings = actual?.HostConfig?.PortBindings ?? {};
  const binding = mappings['5432/tcp'] ?? [];
  if (actual?.Id !== container || actual.Config?.Labels?.['com.docker.compose.project'] !== target.project
    || actual.Config.Labels['com.docker.compose.service'] !== 'postgres'
    || Object.keys(actual.NetworkSettings?.Networks ?? {}).length !== 1 || Object.keys(mappings).length !== 1
    || binding.length !== 1 || binding[0].HostIp !== '127.0.0.1' || binding[0].HostPort !== String(target.port)
    || !mounts.some(row => row.Type === 'bind' && row.Source === target.hba && row.Destination === hbaTarget && row.RW === false)
    || !mounts.some(row => row.Type === 'volume' && row.Name === target.volume && row.Destination === '/var/lib/postgresql')) {
    refuse('The running database mounts or local port differ from the reviewed declaration.');
  }
  const sql = async (statement, failure) => {
    const result = await run('docker', ['--host', target.dockerHost, 'exec', '-i', '--user', 'postgres', container,
      'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '--username=postgres', `--dbname=${DATABASE}`], {
      env: localEnvironment(env), timeoutMs: 20_000, stdin: statement,
    });
    if (result.code !== 0) refuse(failure);
    return result.stdout.trim();
  };
  const receipt = path.join(directory, 'database-id');
  const verifyIdentity = async () => {
    const id = await sql("SELECT system_identifier FROM pg_control_system() WHERE current_setting('hba_file') = '/etc/noticeos/pg_hba.conf';", 'The selected PostgreSQL administrative socket did not answer.');
    if (!/^\d{10,25}$/u.test(id)) refuse('The selected PostgreSQL did not confirm the expected HBA mount.');
    if (fs.existsSync(receipt) && safeFile(receipt, { privateFile: true }).trim() !== id) refuse('The prepared database changed.');
    return id;
  };
  const checkHba = async enabled => {
    const scoped = `ARRAY[${roles.map(role => `'${role}'`).join(',')}]`;
    const rule = `type='host' AND database=ARRAY['${DATABASE}'] AND user_name=${scoped} AND address='samenet' AND auth_method='scram-sha-256'`;
    const facts = await sql(`SELECT count(*) FILTER (WHERE error IS NOT NULL), count(*) FILTER (WHERE ${rule}),
      count(*) FILTER (WHERE type LIKE 'host%' AND NOT (${rule}) AND EXISTS
        (SELECT 1 FROM unnest(user_name) AS login WHERE login=ANY(${scoped}) OR login='all' OR login LIKE '/%'))
      FROM pg_hba_file_rules;`, 'PostgreSQL did not report its HBA rules.');
    return facts === (enabled ? '0|1|0' : '0|0|0');
  };
  const checkLogins = async () => {
    const { Client } = createRequire(new URL('../packages/postgres/package.json', import.meta.url))('pg');
    return await Promise.all(roles.map(async role => {
      const client = new Client({ connectionString: plan.creds[role].loopback, connectionTimeoutMillis: 2600, query_timeout: 2600 });
      try { await client.connect(); return (await client.query('SELECT current_user AS role')).rows[0]?.role === role; }
      catch (error) { if (['28P01', '28000', '42501'].includes(error.code)) return false; refuse('The local login readback could not connect.'); }
      finally { await client.end().catch(() => {}); }
    }));
  };
  if (action === 'status') {
    await verifyIdentity();
    const logins = await checkLogins();
    return { project: target.project, database: DATABASE, hbaReady: await checkHba(true),
      logins: Object.fromEntries(roles.map((role, index) => [role, logins[index]])) };
  }
  const release = await holdLock(path.join(directory, '.roles.lock'), () => new RoleRefused('Another process is using the role plan.'));
  try {
    const id = await verifyIdentity();
    const before = safeFile(target.hba);
    if (!before.startsWith(plan.base) || !hbaAddition.startsWith(before.slice(plan.base.length))) refuse('The HBA has other changes.');
    const completeAddition = before === plan.base + hbaAddition;
    if (!completeAddition && before !== plan.base) changeHba(target.hba, plan.base, plan.base);
    if (!await checkHba(completeAddition)) refuse('The mounted HBA has other or broader access rules for the customer roles.');
    if (!fs.existsSync(receipt)) privateWrite(receipt, `${id}\n`);
    const enabled = action === 'apply';
    await sql(roleUnit(plan, enabled), 'Role changes refused. Check the PostgreSQL version and any existing access for these roles.');
    changeHba(target.hba, plan.base, enabled ? plan.base + hbaAddition : plan.base);
    if (!await checkHba(enabled)) refuse('PostgreSQL has not read the expected HBA file from its existing bind.');
    if (await sql('SELECT pg_reload_conf();', 'PostgreSQL could not reload the HBA.') !== 't') refuse('PostgreSQL could not reload the HBA.');
    if ((await checkLogins()).some(state => state !== enabled)) refuse('The role or HBA readback is incomplete. Recheck or retry the same plan.');
    return { project: target.project, database: DATABASE, roles, enabled };
  } finally { await release(); }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const { values } = parseArgs({ args, options: { config: { type: 'string' }, plan: { type: 'string' }, confirm: { type: 'string' } } });
    process.stdout.write(json(await customerPostgresRoles(action, { directory: values.plan, config: values.config, confirmation: values.confirm })));
  } catch (error) {
    const message = error instanceof RoleRefused ? error.message : 'Role preparation failed. Check the declared local stack and private plan.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}
