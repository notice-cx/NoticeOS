#!/usr/bin/env node
// Prepare, enroll, activate or serve a separate local PostgreSQL target for the read-only customer shadow.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { openPlatformProvisioning } from '../packages/postgres/src/platform-provisioning.mjs';
import { SHADOW_EVIDENCE_FORMAT } from './customer-shadow-export.mjs';
import { EMAIL_CODE_PATHS } from './identity-protocol.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { localMailbox, localNtasksOrigin, privateDirectory } from './local-customer.mjs';
import { readLocalCustomerShadowRuntime } from './local-customer-shadow.mjs';
import { ntasksActivationVerifier } from './ntasks-activation.mjs';
import { readFrozenMarker } from './postgres-apply.mjs';
import { CLUSTER_MARKER, LOOPBACK_HBA, MIGRATIONS_DIR, openThrowaway } from './postgres-dev.mjs';
import { applyMigrations, FROZEN_MIGRATIONS, frozenMigrationProblems, migrationStatus, readMigrations } from './postgres-migrate.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { findPostgres } from './postgres-tools.mjs';
import { MANAGED_START_PORTS } from './start-postgres.mjs';

const DATABASE = 'noticeos_dev';
const TARGET_FORMAT = 'noticeos-shadow-target-v1';
const PLAN_FORMAT = 'noticeos-shadow-plan-v1';
const NTASKS_FORMAT = 'noticeos-shadow-ntasks-v1';
const STATE_FORMAT = 'noticeos-shadow-target-state-v1';
const HOST = '127.0.0.1';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SYSTEM_ID = /^\d{17,20}$/u;
const TOKEN = /^ntasks_service\.[A-Za-z0-9._~-]{1,1024}$/u;
const ROOT_LOCK = '.shadow-target-running';
const CONSUMER_LOCK = '.shadow-running';
const STATE = 'target-state.json';
const PLATFORM = 'platform.json';
const RECEIPT = 'shadow-target.json';

class Refusal extends Error {}
function refuse(message) { throw new Refusal(message); }
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/u.test(value)) refuse('Use an absolute local path.');
  return path.resolve(value);
}
function privateJson(name, limit = 16_384) {
  const file = localPath(name);
  if (realpathSync(path.dirname(file)) !== path.dirname(file)) refuse('Use a private file without symlinks.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > limit) {
      refuse('Use an owner-only, regular local file.');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function ownedJson(name, value, replace = false) {
  if (!replace) {
    writeFileSync(name, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = name + '.' + randomUUID();
  try {
    ownedJson(temporary, value);
    renameSync(temporary, name);
  } finally { rmSync(temporary, { force: true }); }
}
function fields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function port(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 && !MANAGED_START_PORTS.includes(value);
}
function takeLock(root, name) {
  const file = path.join(root, name);
  try { writeFileSync(file, String(process.pid), { mode: 0o600, flag: 'wx' }); }
  catch { refuse('The private shadow folder is in use. Stop its current process first.'); }
  const held = lstatSync(file);
  return () => {
    const current = lstatSync(file, { throwIfNoEntry: false });
    if (current?.dev === held.dev && current?.ino === held.ino) rmSync(file);
  };
}
function tools() {
  const found = findPostgres();
  if (found?.major !== 18) refuse('Put PostgreSQL 18 server and client tools on PATH.');
  return found;
}
function controlId(postgres, dataDir) {
  const value = execFileSync(path.join(path.dirname(postgres.psql), 'pg_controldata'), [dataDir], {
    timeout: 5000, maxBuffer: 8192, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const id = /^Database system identifier:\s+(\d+)$/mu.exec(value)?.[1];
  if (!id || !SYSTEM_ID.test(id)) refuse('The shadow database identity is unavailable.');
  return id;
}
function planFrom(file) {
  const result = privateJson(file);
  if (!fields(result, ['format', 'bundle', 'workspaceId', 'ownerEmail', 'slug', 'displayName', 'towerPort', 'databasePort'])
    || result.format !== PLAN_FORMAT || !UUID.test(result.workspaceId) || typeof result.ownerEmail !== 'string'
    || result.ownerEmail.length > 254 || !EMAIL.test(result.ownerEmail)
    || typeof result.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(result.slug)
    || typeof result.displayName !== 'string' || result.displayName.length < 1 || result.displayName.length > 80
    || result.displayName.trim() !== result.displayName || /[\u0000-\u001f\u007f]/u.test(result.displayName)
    || !port(result.towerPort) || !port(result.databasePort) || result.towerPort === result.databasePort) {
    refuse('The private shadow plan is invalid.');
  }
  const bundle = privateDirectory(localPath(result.bundle));
  const manifest = privateJson(path.join(bundle, 'manifest.json'), 128 * 1024);
  if (manifest?.format !== SHADOW_EVIDENCE_FORMAT || manifest.workspaceId !== result.workspaceId
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.refusals) || manifest.refusals.length !== 0) {
    refuse('Choose the workspace UUID in the completed offline bundle.');
  }
  return { ...result, bundle, ownerEmail: result.ownerEmail.toLowerCase() };
}
function ntasksFrom(file, plan) {
  const input = privateJson(file);
  if (!fields(input, ['format', 'origin', 'ntasksWorkspaceId', 'projectId', 'serviceToken'])
    || input.format !== NTASKS_FORMAT || !UUID.test(input.ntasksWorkspaceId) || !UUID.test(input.projectId)
    || typeof input.serviceToken !== 'string' || !TOKEN.test(input.serviceToken)) refuse('The private Ntasks binding is invalid.');
  const origin = localNtasksOrigin(input.origin);
  const taskPort = Number(new URL(origin).port);
  if (taskPort === plan.towerPort || taskPort === plan.databasePort) refuse('Ntasks needs its own loopback port.');
  return { origin, ntasksWorkspaceId: input.ntasksWorkspaceId, projectId: input.projectId, serviceToken: input.serviceToken };
}

// A direct socket keeps local verification independent of proxy environment settings.
function ntasksRead(origin) {
  return async (url, { signal, headers }) => {
    const target = new URL(url);
    if (target.origin !== origin) refuse('Ntasks project verification refused.');
    return new Promise((resolve, reject) => {
      const request = httpRequest(target, { method: 'GET', agent: false, headers, signal }, response => {
        const status = response.statusCode;
        if (status < 200 || status >= 300 || status === 204) {
          response.destroy();
          resolve(new Response(null, { status: status < 200 ? 502 : status }));
          return;
        }
        resolve(new Response(Readable.toWeb(response), { status, headers: response.headers }));
      });
      request.once('error', reject);
      request.end();
    });
  };
}
function platformOptions(runtime, platform) {
  return { platformConnectionString: platform, identityConnectionString: runtime.identityDatabase,
    trustedOrigin: runtime.publicOrigin, sessionSecret: runtime.identitySecret };
}
function platform(runtime, address, binding) {
  return openPlatformProvisioning({ ...platformOptions(runtime, address),
    verifyProject: ntasksActivationVerifier(binding, ntasksRead(binding.origin)) });
}
function addLogins(cluster, pending) {
  const roles = pending ? ['noticeos_identity', 'noticeos_platform'] : ['noticeos_identity'];
  const permissions = roles.map(role => `host ${DATABASE} ${role} ${HOST}/32 scram-sha-256\n`).join('');
  appendFileSync(path.join(cluster.root, LOOPBACK_HBA), permissions);
  execFileSync(cluster.tools.pgCtl, ['reload', '-D', path.join(cluster.root, 'data')], { stdio: 'pipe', timeout: 5000 });
}
function login(cluster, databaseUrl, role) {
  const secret = randomBytes(32).toString('base64url');
  const address = new URL(databaseUrl);
  address.username = role;
  address.password = secret;
  cluster.run(`ALTER ROLE ${role} LOGIN PASSWORD '${scramVerifier(secret)}';`);
  return address.href;
}
function frozenSchema() {
  const frozen = readFrozenMarker(FROZEN_MIGRATIONS);
  if (frozenMigrationProblems(frozen, { dir: MIGRATIONS_DIR }).length
    || frozen.trim().split('\n').length !== readMigrations(MIGRATIONS_DIR).length) refuse('The released PostgreSQL schema is unavailable.');
}
function assertStopped(dataDir) {
  if (lstatSync(path.join(dataDir, 'postmaster.pid'), { throwIfNoEntry: false })) {
    refuse('The private shadow database still has an active server marker.');
  }
}
function liveIdentity(cluster, dataDir, port, id) {
  const [facts] = cluster.sql(`SELECT system_identifier::text AS system_id, current_database() AS database,
    current_setting('data_directory') AS directory, current_setting('port') AS port,
    current_setting('unix_socket_directories') AS socket_dir,
    current_setting('server_version_num') AS version FROM pg_control_system()`);
  if (facts?.system_id !== id || facts.database !== DATABASE || facts.directory !== dataDir
    || Number(facts.port) !== port || !/^18\d{4}$/u.test(facts.version)
    || realpathSync(facts.socket_dir) !== privateDirectory(realpathSync(cluster.socketDir))) {
    refuse('The shadow database identity changed.');
  }
}
function currentState(cluster, state, runtime) {
  const [result] = cluster.script(`BEGIN READ ONLY;
    SELECT count(*)::text AS workspaces,
    (SELECT status FROM noticeos.workspaces WHERE workspace_id=:'id'::uuid) AS lifecycle,
    EXISTS (SELECT 1 FROM noticeos_identity.platform_enrollment e
      LEFT JOIN noticeos_identity.auth_user u ON u.id=e.verified_person_id
      LEFT JOIN noticeos_identity.auth_member m ON m.user_id=u.id AND m.organization_id=e.workspace_id
      WHERE e.workspace_id=:'id'::uuid AND e.id=:'enrollment'::uuid AND e.email=:'email' AND e.revoked_at IS NULL
        AND e.activated_at IS NOT NULL AND u.email=:'email' AND u.email_verified AND m.role='owner')::text AS confirmed
    FROM noticeos.workspaces;
    COMMIT;`, { vars: { id: runtime.workspaceId, enrollment: state.enrollmentId, email: runtime.ownerEmail } });
  if (result?.workspaces !== '1' || (result.lifecycle !== 'provisioning' && !(result.lifecycle === 'active' && result.confirmed === 'true'))) {
    refuse('The expected workspace and verified owner are unavailable.');
  }
  return result.lifecycle;
}
function saveReceipt(root, state, runtime, cluster, dataDir) {
  const receipt = { format: TARGET_FORMAT, workspaceId: runtime.workspaceId, ownerEmail: runtime.ownerEmail,
    postgresSystemId: state.postgresSystemId, dataDir, socketDir: realpathSync(cluster.socketDir),
    port: state.databasePort, database: DATABASE };
  ownedJson(path.join(root, RECEIPT), receipt, true);
  rmSync(path.join(root, PLATFORM), { force: true });
}
function activationState(root) {
  const state = privateJson(path.join(root, STATE));
  if (!fields(state, ['format', 'postgresSystemId', 'databasePort', 'enrollmentId', 'workspaceId', 'ownerEmail', 'ntasks'])
    || state.format !== STATE_FORMAT || !SYSTEM_ID.test(state.postgresSystemId) || !UUID.test(state.enrollmentId)
    || !UUID.test(state.workspaceId) || typeof state.ownerEmail !== 'string' || !EMAIL.test(state.ownerEmail)
    || !port(state.databasePort) || !fields(state.ntasks, ['origin', 'ntasksWorkspaceId', 'projectId', 'credentialRef', 'executorRef', 'databaseKey'])
    || ![state.ntasks.ntasksWorkspaceId, state.ntasks.projectId, state.ntasks.credentialRef, state.ntasks.executorRef].every(id => UUID.test(id))
    || !/^n_[a-f0-9]{32}$/u.test(state.ntasks.databaseKey) || localNtasksOrigin(state.ntasks.origin) !== state.ntasks.origin) {
    refuse('The private shadow target has no valid preparation state.');
  }
  return state;
}
function readPlatform(root, state) {
  const input = privateJson(path.join(root, PLATFORM));
  const url = new URL(input?.address);
  if (!fields(input, ['address']) || url.protocol !== 'postgresql:' || url.hostname !== HOST
    || Number(url.port) !== state.databasePort || url.pathname !== '/' + DATABASE || url.username !== 'noticeos_platform'
    || !url.password || url.search !== '?sslmode=disable' || url.hash) refuse('The local activation connection is unavailable.');
  return url.href;
}
async function userProof(root, state, runtime, otp) {
  const mail = localMailbox(privateDirectory(path.join(root, 'mail')), address => address === runtime.ownerEmail);
  let delivered = false;
  const login = openEmailCodeLogin({ connectionString: runtime.identityDatabase, trustedOrigin: runtime.publicOrigin,
    sessionSecret: runtime.identitySecret, peerAddress: HOST, async deliver(message) {
      mail({ from: 'noticeos@example.test', to: message.email, subject: 'Your NoticeOS sign-in code',
        text: `Your NoticeOS sign-in code is ${message.code}.` });
      delivered = true;
    } });
  const action = otp === undefined ? 'request' : 'verify';
  const request = new Request(runtime.publicOrigin + EMAIL_CODE_PATHS[action], { method: 'POST',
    headers: { origin: runtime.publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: runtime.ownerEmail, ...(otp === undefined ? {} : { otp }) }) });
  try {
    const enrollment = { kind: 'platform', id: state.enrollmentId };
    const result = action === 'request' ? await login.requestCode(request, enrollment) : await login.verifyCode(request, enrollment);
    if (action === 'request' ? result.status !== 202 || !delivered : result.status !== 200) {
      refuse(action === 'request' ? 'The enrollment code could not be sent.' : 'The enrollment code was refused.');
    }
  } finally { await login.close(); }
}

async function prepare(root, plan, ntasks) {
  const postgres = tools();
  frozenSchema();
  const { bavail, bsize } = statfsSync(path.dirname(root), { bigint: true });
  if (bavail * bsize < 8n * 1024n ** 3n) refuse('Leave at least 8 GiB free before creating the shadow target.');
  if (!lstatSync(root, { throwIfNoEntry: false })) privateDirectory(root, true);
  privateDirectory(root);
  const releaseRoot = takeLock(root, ROOT_LOCK);
  let releaseConsumer, cluster;
  try {
    if (readdirSync(root).some(name => name !== ROOT_LOCK)) refuse('Choose a new, empty private target folder.');
    releaseConsumer = takeLock(root, CONSUMER_LOCK);
    const home = privateDirectory(path.join(root, 'postgres'), true);
    const dataDir = path.join(home, 'data');
    cluster = openThrowaway(home, postgres, { loopbackPort: plan.databasePort, durable: true });
    const id = controlId(postgres, dataDir);
    liveIdentity(cluster, dataDir, plan.databasePort, id);
    applyMigrations(cluster);
    const workspaceDatabaseUrl = cluster.applicationLogin().url();
    const identityDatabaseUrl = login(cluster, workspaceDatabaseUrl, 'noticeos_identity');
    const platformUrl = login(cluster, workspaceDatabaseUrl, 'noticeos_platform');
    addLogins(cluster, true);
    privateDirectory(path.join(root, 'mail'), true);
    privateDirectory(path.join(root, 'worker-state'), true);
    const runtimeFile = path.join(root, 'runtime.json');
    ownedJson(runtimeFile, { format: 'noticeos-customer-shadow/1', publicOrigin: `http://${HOST}:${plan.towerPort}`,
      workspaceId: plan.workspaceId, ownerEmail: plan.ownerEmail, workspaceDatabaseUrl, identityDatabaseUrl,
      identitySecret: randomBytes(48).toString('base64url') });
    ownedJson(path.join(root, PLATFORM), { address: platformUrl });
    const runtime = readLocalCustomerShadowRuntime(runtimeFile);
    const { serviceToken, ...directory } = ntasks;
    const task = { ...directory, executorRef: randomUUID(), credentialRef: randomUUID(), databaseKey: 'n_' + randomBytes(16).toString('hex') };
    const initializer = platform(runtime, platformUrl, { workspaceId: plan.workspaceId, ...task, serviceToken });
    let enrollment;
    try {
      enrollment = await initializer.prepare({ workspaceId: plan.workspaceId, slug: plan.slug, displayName: plan.displayName,
        intendedEmail: plan.ownerEmail, expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString() });
    } finally { await initializer.close(); }
    cluster.run(`INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key)
      VALUES (:'workspaceId'::uuid,:'projectId'::uuid,:'executorRef'::uuid,:'credentialRef'::uuid,:'databaseKey')`,
    { vars: { workspaceId: plan.workspaceId, projectId: task.projectId, executorRef: task.executorRef,
      credentialRef: task.credentialRef, databaseKey: task.databaseKey } });
    const state = { format: STATE_FORMAT, postgresSystemId: id, databasePort: plan.databasePort,
      workspaceId: plan.workspaceId, ownerEmail: plan.ownerEmail, enrollmentId: enrollment.enrollmentId, ntasks: task };
    ownedJson(path.join(root, STATE), state);
    await userProof(root, state, runtime);
  } finally {
    if (cluster) {
      cluster.close();
      assertStopped(path.join(cluster.root, 'data'));
    }
    releaseConsumer?.();
    releaseRoot();
  }
}

async function openTarget(root, action, ntasksFile, otp) {
  privateDirectory(root);
  const releaseRoot = takeLock(root, ROOT_LOCK);
  let releaseConsumer, cluster;
  let foreground = false;
  try {
    releaseConsumer = takeLock(root, CONSUMER_LOCK);
    const state = activationState(root);
    const runtime = readLocalCustomerShadowRuntime(path.join(root, 'runtime.json'));
    if (runtime.workspaceId !== state.workspaceId || runtime.ownerEmail !== state.ownerEmail
      || new URL(runtime.connectionString).pathname !== '/' + DATABASE
      || Number(new URL(runtime.connectionString).port) !== state.databasePort) refuse('The target runtime does not match its preparation.');
    const postgres = tools();
    const home = privateDirectory(path.join(root, 'postgres'));
    const dataDir = privateDirectory(path.join(home, 'data'));
    assertStopped(dataDir);
    if (!lstatSync(path.join(home, CLUSTER_MARKER)).isFile()
      || controlId(postgres, dataDir) !== state.postgresSystemId) refuse('The stored Postgres identity does not match this target.');
    const bind = action === 'activate' ? ntasksFrom(ntasksFile, { databasePort: state.databasePort, towerPort: runtime.port }) : null;
    if (bind && ['origin', 'ntasksWorkspaceId', 'projectId'].some(key => bind[key] !== state.ntasks[key])) {
      refuse('The Ntasks binding does not match the prepared task project.');
    }
    cluster = openThrowaway(home, postgres, { loopbackPort: state.databasePort, durable: true });
    liveIdentity(cluster, dataDir, state.databasePort, state.postgresSystemId);
    const schema = migrationStatus(cluster);
    if (schema.pending.length || schema.problems.length) refuse('The target schema does not match the released migrations.');
    const lifecycle = currentState(cluster, state, runtime);
    if (action === 'serve') {
      if (lifecycle !== 'active') refuse('Activate the enrolled workspace before starting its database.');
      addLogins(cluster, false);
      saveReceipt(root, state, runtime, cluster, dataDir);
      releaseConsumer();
      releaseConsumer = undefined;
      foreground = true;
      return () => {
        const release = takeLock(root, CONSUMER_LOCK);
        cluster.close();
        assertStopped(dataDir);
        release();
        releaseRoot();
      };
    }
    addLogins(cluster, lifecycle === 'provisioning');
    if (action === 'activate') {
      if (lifecycle === 'provisioning') {
        const initializer = platform(runtime, readPlatform(root, state),
          { workspaceId: runtime.workspaceId, ...state.ntasks, serviceToken: bind.serviceToken });
        try { await initializer.activate({ workspaceId: runtime.workspaceId, enrollmentId: state.enrollmentId, projectId: bind.projectId }); }
        finally { await initializer.close(); }
      }
      if (currentState(cluster, state, runtime) !== 'active') refuse('The workspace activation did not finish.');
      saveReceipt(root, state, runtime, cluster, dataDir);
      return;
    }
    if (lifecycle !== 'provisioning') refuse('The workspace owner has already been activated.');
    await userProof(root, state, runtime, otp);
  } finally {
    if (!foreground) {
      if (cluster) {
        cluster.close();
        assertStopped(path.join(cluster.root, 'data'));
      }
      releaseConsumer?.();
      releaseRoot();
    }
  }
}

function readCode(input) {
  return new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => done(''), 120_000);
    const end = () => done(value);
    function data(chunk) {
      value += chunk;
      if (value.length > 16) done('');
      else if (value.includes('\n')) done(value);
    }
    function done(text) {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.pause();
      const code = text.trim();
      if (/^\d{6}$/u.test(code)) resolve(code);
      else reject(new Refusal('Enter one six-digit enrollment code on standard input.'));
    }
    input.on('data', data);
    input.on('end', end);
  });
}
function hold(tryStop) {
  return new Promise(resolve => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const stop = () => {
      try { tryStop(); }
      catch (error) {
        process.stderr.write((error instanceof Refusal ? error.message : 'The private target could not stop.') + '\n');
        return;
      }
      for (const signal of signals) process.off(signal, stop);
      clearInterval(keepAlive);
      resolve();
    };
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    for (const signal of signals) process.on(signal, stop);
  });
}

async function main([action, directory, ...args]) {
  const contract = { prepare: 2, 'send-code': 0, enroll: 0, activate: 1, serve: 0 };
  if (!directory || !Object.hasOwn(contract, action) || args.length !== contract[action]) {
    refuse('Usage: customer-shadow-target.mjs prepare <root> <plan.json> <ntasks.json> | send-code <root> | enroll <root> | activate <root> <ntasks.json> | serve <root>');
  }
  const root = localPath(directory);
  if (realpathSync(path.dirname(root)) !== path.dirname(root)) refuse('Use the actual private target folder path.');
  if (action === 'prepare') {
    const plan = planFrom(args[0]);
    await prepare(root, plan, ntasksFrom(args[1], plan));
  } else {
    const otp = action === 'enroll' ? await readCode(process.stdin) : undefined;
    const stop = await openTarget(root, action, args[0], otp);
    if (action === 'serve') {
      const stopping = hold(stop);
      process.stdout.write('Private shadow database ready for the importer and Tower.\n');
      return stopping;
    }
  }
  process.stdout.write({ prepare: 'Enrollment code saved in the private mail folder.', 'send-code': 'Enrollment code saved in the private mail folder.',
    enroll: 'Owner enrolled. Activate the workspace with its approved local Ntasks binding.',
    activate: 'Workspace activated. Start the private target database before importing.' }[action] + '\n');
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof Refusal ? error.message : 'The private shadow target operation did not finish.') + '\n');
    process.exitCode = 1;
  });
}
