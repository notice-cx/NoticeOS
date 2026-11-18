// Serve one already activated local target without starting a job runner.
// Usage: node scripts/local-customer-shadow.mjs /absolute/private/runtime.json
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { openIdentityDatabase } from '../packages/postgres/src/identity-engine.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { verifyShadowTargetReceipt } from './customer-shadow-receipt.mjs';
import { EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, PERSONAL_PROFILE_PATH } from './identity-protocol.mjs';
import { localMailbox, privateDirectory, startCustomerRuntime } from './local-customer.mjs';
import { findPsql } from './postgres-tools.mjs';
import { isHostedStoredRead, siteIconsReadRequest } from './workspace-operations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const format = 'noticeos-customer-shadow/1';
const fields = ['format', 'publicOrigin', 'workspaceId', 'ownerEmail', 'workspaceDatabaseUrl', 'identityDatabaseUrl', 'identitySecret'];
const invalid = () => new Error('The customer shadow requires its own private runtime file and an already activated target with its enrolled owner.');

function databaseAddress(value, role) {
  if (typeof value !== 'string') throw invalid();
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || !url.port || url.username !== role || !url.password || !/^\/[a-zA-Z0-9_-]+$/u.test(url.pathname)
    || (url.search && url.search !== '?sslmode=disable') || url.hash) throw invalid();
  url.searchParams.set('sslmode', 'disable');
  return url;
}

export function readLocalCustomerShadowRuntime(name) {
  if (!path.isAbsolute(name) || path.basename(name) !== 'runtime.json') throw invalid();
  const file = path.resolve(name);
  const customer = privateDirectory(path.dirname(file));
  if (lstatSync(path.join(customer, 'settings.json'), { throwIfNoEntry: false })) throw invalid();
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw invalid();
    const input = JSON.parse(readFileSync(handle, 'utf8'));
    if (input === null || typeof input !== 'object' || Object.keys(input).length !== fields.length
      || fields.some(key => !Object.hasOwn(input, key)) || input.format !== format
      || typeof input.publicOrigin !== 'string'
      || typeof input.workspaceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.workspaceId)
      || typeof input.ownerEmail !== 'string' || input.ownerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.ownerEmail)
      || typeof input.identitySecret !== 'string' || !/^[A-Za-z0-9_-]{64}$/u.test(input.identitySecret)) throw invalid();
    const origin = new URL(input.publicOrigin);
    if (origin.origin !== input.publicOrigin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || !origin.port || Number(origin.port) < 1024) throw invalid();
    const app = databaseAddress(input.workspaceDatabaseUrl, 'noticeos_app');
    const identity = databaseAddress(input.identityDatabaseUrl, 'noticeos_identity');
    if (app.port !== identity.port || app.pathname !== identity.pathname || app.port === origin.port) throw invalid();
    app.searchParams.set('options', '-c default_transaction_read_only=on');
    return { customer, publicOrigin: origin.origin, port: Number(origin.port), workspaceId: input.workspaceId,
      ownerEmail: input.ownerEmail.toLowerCase(), connectionString: app.href, identityDatabase: identity.href,
      identitySecret: input.identitySecret };
  } finally { closeSync(handle); }
}

async function verifyTarget(input) {
  const store = openWorkspaceStore(input.connectionString);
  try {
    if (await store.workspaceId() !== input.workspaceId) throw invalid();
    await store.read(async tx => {
      const [row] = await tx.query("SELECT current_setting('default_transaction_read_only') AS read_only");
      if (row?.read_only !== 'on') throw invalid();
    });
  } finally { await store.close(); }
  const { pool } = await openIdentityDatabase({ connectionString: input.identityDatabase,
    trustedOrigin: input.publicOrigin, sessionSecret: input.identitySecret });
  try {
    const { rowCount } = await pool.query(`
      SELECT 1
      FROM noticeos_identity.auth_member m
      JOIN noticeos_identity.auth_user u ON u.id = m.user_id
      JOIN noticeos_identity.workspace_summary($1::uuid) w ON w.workspace_id = m.organization_id
      WHERE m.role = 'owner' AND u.email = $2 AND u.email_verified = true AND w.status = 'active'
    `, [input.workspaceId, input.ownerEmail]);
    if (rowCount !== 1) throw invalid();
  } finally { await pool.end(); }
}

async function admits(request, { ownerEmail, workspaceId }) {
  const { pathname } = new URL(request.url);
  const selected = request.headers.get(WORKSPACE_SELECTION_HEADER);
  if (selected !== null && selected !== workspaceId) return false;
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return pathname === '/api/session' || pathname === '/api/app-release' || pathname === PERSONAL_PROFILE_PATH || isHostedStoredRead(request);
    }
    return true;
  }
  if (siteIconsReadRequest(request)) return true;
  if (request.method !== 'POST' || !Object.values(EMAIL_CODE_PATHS).includes(pathname)
    || Object.values(EMAIL_ENROLLMENT_HEADERS).some(key => request.headers.has(key))) return false;
  if (pathname === EMAIL_CODE_PATHS.logout) return true;
  const body = await request.json().catch(() => null);
  return typeof body?.email === 'string' && body.email.trim().toLowerCase() === ownerEmail;
}

/** The operator-owned file is server input, never a Tower request setting. */
export async function startLocalCustomerShadow(file) {
  let input;
  try { input = readLocalCustomerShadowRuntime(file); } catch { throw invalid(); }
  const workerState = privateDirectory(path.join(input.customer, 'worker-state'));
  const outbox = privateDirectory(path.join(input.customer, 'mail'));
  const lock = path.join(input.customer, '.shadow-running');
  let handle;
  try { handle = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('The customer shadow directory is already in use or unavailable.'); }
  const release = () => { closeSync(handle); rmSync(lock); };
  let app;
  try {
    const tools = findPsql();
    if (tools?.major !== 18) throw invalid();
    const database = new URL(input.connectionString);
    await verifyShadowTargetReceipt(input.customer, tools.psql, {
      workspaceId: input.workspaceId, ownerEmail: input.ownerEmail, port: Number(database.port), database: database.pathname.slice(1),
    });
    await verifyTarget(input);
    app = await startCustomerRuntime({ root, port: input.port, url: input.publicOrigin }, {
      ...input, workerState, outbox, workspaces: [{ workspaceId: input.workspaceId }],
      deliver: localMailbox(outbox, recipient => recipient === input.ownerEmail),
      shadowAdmission: request => admits(request, input),
    });
  } catch {
    release();
    throw invalid();
  }
  let closing;
  return Object.freeze({ publicOrigin: app.publicOrigin, async close() {
    closing ??= app.close().then(release);
    await closing;
  } });
}

async function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/local-customer-shadow.mjs /absolute/private/runtime.json');
  // Worker isolation keeps Miniflare's signal hooks out of the launcher.
  const worker = new Worker(new URL(import.meta.url), { workerData: { shadowFile: args[0] } });
  const stop = () => worker.postMessage('stop');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  worker.once('message', origin => process.stdout.write(`Customer shadow ready at ${origin}/\n`));
  try {
    const code = await new Promise(resolve => {
      worker.once('error', () => process.stderr.write('The customer shadow stopped unexpectedly.\n'));
      worker.once('exit', resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function serve(file) {
  const stopping = new Promise(resolve => parentPort.once('message', resolve));
  const app = await startLocalCustomerShadow(file);
  parentPort.postMessage(app.publicOrigin);
  try { await stopping; }
  finally { await app.close(); }
}

if (!isMainThread && typeof workerData?.shadowFile === 'string') {
  serve(workerData.shadowFile).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }).finally(() => parentPort.close());
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
