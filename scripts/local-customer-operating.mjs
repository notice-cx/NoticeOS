import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import path from 'node:path';
import { holdLock } from './history-files.mjs';
import { MANAGED_START_PORTS } from './start-ports.mjs';

const FORMAT = 'noticeos-customer-operating/1';
const MARK = '.noticeos-customer-operating';
const ROLES = { app: 'noticeos_app', identity: 'noticeos_identity', grant: 'noticeos_service_grant' };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu;
const options = new Set(['format', 'database', 'identitySecret', 'credentialsKey', 'workspaces', 'mailRecipients', 'ntasksOrigin', 'googleDaily', 'siteReports']);

export class CustomerOperatingRefused extends Error {}
function refused() { return new CustomerOperatingRefused('Use a private customer config for one separately provisioned loopback Postgres database.'); }
function privateFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 32 * 1024) throw refused();
  return readFileSync(file, 'utf8');
}

function localDatabase(value, role, plan) {
  if (typeof value !== 'string') throw refused();
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.username !== role || !url.password || !url.port || MANAGED_START_PORTS.includes(Number(url.port))
    || [plan.port, plan.doorPort].includes(Number(url.port))
    || !/^\/[a-zA-Z0-9_-]{1,63}$/u.test(url.pathname) || !['', '?sslmode=disable'].includes(url.search) || url.hash) throw refused();
  return url;
}

function taskOrigin(value, plan, databasePort) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw refused();
  const url = new URL(value);
  const host = url.hostname;
  const local = host === '127.0.0.1';
  if (url.origin !== value || url.username || url.password
    || !(url.protocol === 'https:' && !isIP(host.replace(/^\[|\]$/gu, '')) && !/(?:^|\.)localhost\.?$/iu.test(host)
      || url.protocol === 'http:' && local && url.port)
    || (local && [...MANAGED_START_PORTS, plan.port, plan.doorPort, databasePort].includes(Number(url.port)))) {
    throw refused();
  }
  return url.origin;
}

export function readCustomerOperating(file, plan) {
  try {
    const config = JSON.parse(privateFile(file));
    if (config.format !== FORMAT || Object.keys(config).some(key => !options.has(key))
      || !config.database || Object.keys(config.database).length !== 3
      || typeof config.identitySecret !== 'string' || config.identitySecret.length < 32 || config.identitySecret.length > 512
      || typeof config.credentialsKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(config.credentialsKey)
      || config.googleDaily !== undefined && typeof config.googleDaily !== 'boolean'
      || config.siteReports !== undefined && typeof config.siteReports !== 'boolean'
      || !Array.isArray(config.mailRecipients) || config.mailRecipients.length < 1 || config.mailRecipients.length > 64
      || config.mailRecipients.some(email => typeof email !== 'string' || email.length > 320 || !EMAIL.test(email))
      || !Array.isArray(config.workspaces) || config.workspaces.length < 1 || config.workspaces.length > 64
      || config.workspaces.some(binding => !binding || typeof binding.workspaceId !== 'string' || !UUID.test(binding.workspaceId)
        || typeof binding.serviceId !== 'string' || !UUID.test(binding.serviceId)
        || Object.keys(binding).some(key => !['workspaceId', 'serviceId'].includes(key)))
      || new Set(config.workspaces.map(binding => binding.workspaceId)).size !== config.workspaces.length) throw refused();
    const app = localDatabase(config.database.app, ROLES.app, plan);
    const identity = localDatabase(config.database.identity, ROLES.identity, plan);
    const grant = localDatabase(config.database.grant, ROLES.grant, plan);
    const target = app.host + app.pathname;
    if ([identity, grant].some(url => url.host + url.pathname !== target)) throw refused();
    const workspaces = config.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    return { target, address: app.href, identityAddress: identity.href, grantAddress: grant.href,
      mailRecipients: config.mailRecipients.map(email => email.toLowerCase()), workspaces,
      identitySecret: config.identitySecret, credentialsKey: config.credentialsKey,
      ntasksOrigin: taskOrigin(config.ntasksOrigin, plan, Number(app.port)), googleDaily: config.googleDaily === true,
      siteReports: config.siteReports === true };
  } catch { throw refused(); }
}

/** One direct session holds the lease for this database, including while idle. */
async function acquireScheduleLease(connectionString) {
  const require = createRequire(new URL('../packages/postgres/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 5000,
    keepAlive: true, keepAliveInitialDelayMillis: 5000, application_name: 'noticeos-local-customer-scheduler' });
  const abort = new AbortController();
  let closing;
  const lost = () => { if (!closing) abort.abort(new CustomerOperatingRefused('The customer scheduler lost its database lease.')); };
  client.on('error', lost);
  client.on('end', lost);
  const close = () => { closing ??= client.end().catch(() => {}); return closing; };
  try {
    await client.connect();
    const { rows: [status] } = await client.query(`SELECT session_user::text AS role,
      r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
      pg_catalog.current_setting('server_version_num')::int / 10000 = 18 AND
        pg_catalog.has_function_privilege(session_user,
          pg_catalog.to_regprocedure('noticeos_platform.resolve_workspace_service(uuid,uuid)'), 'EXECUTE') AS prepared,
      pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('noticeos.local-customer-schedule/v1', 0)) AS acquired
      FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`);
    if (status?.role !== ROLES.grant || status.elevated !== false || status.prepared !== true) {
      throw new CustomerOperatingRefused('The customer database needs its prepared PostgreSQL 18 schema and runtime roles.');
    }
    if (!status.acquired) throw new CustomerOperatingRefused('A customer scheduler already owns this database.');
    abort.signal.throwIfAborted();
    return { signal: abort.signal, close };
  } catch (error) {
    await close();
    // Postgres diagnostics may contain credentials or connection details.
    if (error instanceof CustomerOperatingRefused) throw error;
    throw new CustomerOperatingRefused('Could not acquire the customer scheduler database lease.');
  }
}

function operatingFolder(plan) {
  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  const info = lstatSync(plan.home);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new CustomerOperatingRefused('Use a private runtime folder for this customer database.');
  const home = realpathSync(plan.home);
  const marker = path.join(home, MARK);
  const folders = readdirSync(home);
  if (folders.length === 0) {
    writeFileSync(marker, FORMAT + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(plan.mark, FORMAT + '\n', { flag: 'wx', mode: 0o600 });
  } else if (!folders.every(item => [MARK, path.basename(plan.mark), '.local'].includes(item))
    || privateFile(marker).trim() !== FORMAT || privateFile(plan.mark).trim() !== FORMAT) {
    throw new CustomerOperatingRefused('Use a new runtime folder for the separately provisioned customer database.');
  }
  const state = path.join(home, '.local');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const stateInfo = lstatSync(state);
  if (!stateInfo.isDirectory() || stateInfo.uid !== process.getuid() || stateInfo.mode & 0o077) {
    throw new CustomerOperatingRefused('Customer runtime state must be private.');
  }
  return state;
}

/** Attach to an already prepared store. Any schema work or role setup is owned
 * by its provisioner. The runtime only writes in the separate local folder. */
export async function openCustomerOperating(plan, file) {
  const operating = readCustomerOperating(file, plan);
  const state = operatingFolder(plan);
  const release = await holdLock(path.join(state, '.customer-start.lock'), () => new CustomerOperatingRefused('This customer runtime folder is already in use.'));
  let lease;
  try {
    const publicOrigin = new URL(plan.url).origin, customer = path.join(state, 'customer');
    const receipt = path.join(state, 'customer-target.json');
    const schedule = createHash('sha256').update(JSON.stringify(operating.workspaces)).digest('hex');
    let previous;
    try { previous = JSON.parse(privateFile(receipt)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (previous && (previous.target !== operating.target || previous.publicOrigin !== publicOrigin)) {
      throw new CustomerOperatingRefused('Restart with the original customer database and Tower port, or use a separate runtime folder.');
    }
    lease = await acquireScheduleLease(operating.grantAddress);
    const now = Date.now();
    const resumeSince = operating.googleDaily && previous?.schedule === schedule
      && Number.isSafeInteger(previous.googleSince) && previous.googleSince > 0 && previous.googleSince <= now
      ? previous.googleSince : undefined;
    return { address: operating.address, customer, operating, resumeSince, signal: lease.signal,
      ready() {
        lease.signal.throwIfAborted();
        const temporary = receipt + '.' + randomUUID();
        try {
          writeFileSync(temporary, JSON.stringify({ target: operating.target, publicOrigin, schedule,
            googleSince: operating.googleDaily ? resumeSince ?? Date.now() : null }) + '\n', { flag: 'wx', mode: 0o600 });
          renameSync(temporary, receipt);
        } finally { rmSync(temporary, { force: true }); }
      },
      async close() { try { await lease.close(); } finally { await release(); } },
    };
  } catch (error) {
    try { await lease?.close(); } finally { await release(); }
    throw error;
  }
}
