import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import path from 'node:path';
import { holdLock } from './history-files.mjs';
import { readLocalIdentityMail } from './local-identity-mail.mjs';
import { MANAGED_START_PORTS } from './start-ports.mjs';
import { customerCollectionPolicy } from './customer-collection-policy.mjs';

const FORMAT = 'noticeos-customer-operating/1';
const MARK = '.noticeos-customer-operating';
const ROLES = { app: 'noticeos_app', identity: 'noticeos_identity', grant: 'noticeos_service_grant' };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu;
const options = new Set(['format', 'database', 'identitySecret', 'credentialsKey', 'workspaces', 'mailRecipients', 'mailDelivery', 'ntasksOrigin',
  'googleDaily', 'extendedArchives', 'collectorProviders', 'sitePulls', 'siteReports', 'siteChecks', 'revenueNotices', 'taskFollowups']);

export class CustomerOperatingRefused extends Error {}
function refused() { return new CustomerOperatingRefused('Use a private customer config for one separately provisioned loopback Postgres database.'); }
function privateFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 32 * 1024) throw refused();
  return readFileSync(file, 'utf8');
}

function localDatabase(value, role, plan, compose) {
  if (typeof value !== 'string') throw refused();
  const url = new URL(value);
  const address = compose ? url.hostname === 'postgres' && ['', '5432'].includes(url.port)
    : url.hostname === '127.0.0.1' && url.port && ![...MANAGED_START_PORTS, plan.port, plan.doorPort].includes(Number(url.port));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !address || url.username !== role || !url.password
    || !/^\/[a-zA-Z0-9_-]{1,63}$/u.test(url.pathname) || !['', '?sslmode=disable'].includes(url.search) || url.hash) throw refused();
  if (compose) url.port = '5432';
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
  let config;
  try { config = JSON.parse(privateFile(file)); }
  catch { throw refused(); }
  return withDelivery(config, customerOperating(config, plan), file);
}

class SitePullBearerMissing extends Error {}

function composeSitePulls(pulls, assetTokens, workspaceId) {
  if (pulls === undefined) return [];
  if (!Array.isArray(pulls)) throw refused();
  if (!pulls.length) return [];
  let tokens = assetTokens;
  try { if (typeof tokens === 'string') tokens = JSON.parse(tokens); }
  catch { throw new SitePullBearerMissing(); }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new SitePullBearerMissing();
  return pulls.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3
      || Object.hasOwn(entry, 'token') || entry.workspaceId !== workspaceId || typeof entry.asset !== 'string') throw refused();
    const token = Object.hasOwn(tokens, entry.asset) ? tokens[entry.asset] : null;
    if (typeof token !== 'string' || !token.trim()) throw new SitePullBearerMissing();
    return { ...entry, token };
  });
}

export function readComposeCustomerOperating(file, plan, bootstrap) {
  let config, operating;
  try {
    const { towerOrigin, ...declaration } = JSON.parse(privateFile(file));
    if (towerOrigin !== plan.localTowerOrigin) throw refused();
    config = declaration;
    if (config.format !== 'noticeos-compose-customer/1' || !config.database || !Array.isArray(config.workspaces)
      || config.workspaces.length !== 1 || Object.keys(config.database).length !== 2
      || 'app' in config.database || 'credentialsKey' in config) throw refused();
    const sitePulls = composeSitePulls(config.sitePulls, bootstrap.ASSET_TOKENS, config.workspaces[0]?.workspaceId);
    operating = customerOperating({ ...config, format: FORMAT, credentialsKey: bootstrap.CREDENTIALS_KEY, sitePulls,
      database: { ...config.database, app: bootstrap.DATABASE_URL } }, plan, true);
  } catch (error) {
    if (error instanceof SitePullBearerMissing) throw new CustomerOperatingRefused('A configured site pull needs its existing bearer in ASSET_TOKENS.');
    throw new CustomerOperatingRefused('The app needs a private customer configuration for its existing database and one prepared workspace.');
  }
  return withDelivery(config, operating, file);
}

function withDelivery(config, operating, file) {
  if (config.mailDelivery === undefined) return operating;
  try { return { ...operating, mailDelivery: readLocalIdentityMail(config.mailDelivery, file) }; }
  catch { throw new CustomerOperatingRefused('Restore the private SMTP mail file beside the customer configuration before starting the app.'); }
}

function customerOperating(config, plan, compose = false) {
  try {
    if (config.format !== FORMAT || Object.keys(config).some(key => !options.has(key))
      || !config.database || Object.keys(config.database).length !== 3
      || typeof config.identitySecret !== 'string' || config.identitySecret.length < 32 || config.identitySecret.length > 512
      || typeof config.credentialsKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(config.credentialsKey)
      || config.siteReports !== undefined && typeof config.siteReports !== 'boolean'
      || !Array.isArray(config.mailRecipients) || config.mailRecipients.length < 1 || config.mailRecipients.length > 64
      || config.mailRecipients.some(email => typeof email !== 'string' || email.length > 320 || !EMAIL.test(email))
      || !Array.isArray(config.workspaces) || config.workspaces.length < 1 || config.workspaces.length > 64
      || config.workspaces.some(binding => !binding || typeof binding.workspaceId !== 'string' || !UUID.test(binding.workspaceId)
        || typeof binding.serviceId !== 'string' || !UUID.test(binding.serviceId)
        || Object.keys(binding).some(key => !['workspaceId', 'serviceId'].includes(key)))
      || new Set(config.workspaces.map(binding => binding.workspaceId)).size !== config.workspaces.length) throw refused();
    const app = localDatabase(config.database.app, ROLES.app, plan, compose);
    const identity = localDatabase(config.database.identity, ROLES.identity, plan, compose);
    const grant = localDatabase(config.database.grant, ROLES.grant, plan, compose);
    const target = app.host + app.pathname;
    if ([identity, grant].some(url => url.host + url.pathname !== target)) throw refused();
    const workspaces = config.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    const collection = customerCollectionPolicy(config);
    const approvedWorkspaces = new Set(workspaces.map(workspace => workspace.workspaceId));
    if ([...collection.sitePulls, ...collection.siteChecks, ...collection.revenueNotices].some(entry => !approvedWorkspaces.has(entry.workspaceId))
      || collection.taskFollowups.some(entry => !approvedWorkspaces.has(entry.workspaceId) || !config.ntasksOrigin
        || workspaces.some(binding => binding.serviceId === entry.serviceId))) throw refused();
    return { target, address: app.href, identityAddress: identity.href, grantAddress: grant.href,
      mailRecipients: config.mailRecipients.map(email => email.toLowerCase()), workspaces,
      identitySecret: config.identitySecret, credentialsKey: config.credentialsKey,
      ntasksOrigin: taskOrigin(config.ntasksOrigin, plan, Number(app.port)), ...collection,
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
  try { return await openCustomerTarget(plan, operating, path.join(state, 'customer'), path.join(state, 'customer-target.json'), { release }); }
  catch (error) { await release(); throw error; }
}

/** Compose already replaces the single app container. It still takes the same
 * database session lease as the attached runner, including across containers. */
export async function openCustomerTarget(plan, operating, customer, receipt, { release = async () => {}, activation, backup = false } = {}) {
  let lease;
  try {
    const publicOrigin = new URL(plan.url).origin;
    const scope = createHash('sha256').update(JSON.stringify(operating.workspaces));
    if (activation !== undefined) scope.update('\0' + activation);
    const schedule = scope.digest('hex');
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
    const backupResumeSince = backup && previous?.schedule === schedule
      && Number.isSafeInteger(previous.backupSince) && previous.backupSince > 0 && previous.backupSince <= now ? previous.backupSince : undefined;
    return { address: operating.address, customer, operating, resumeSince, backupResumeSince, signal: lease.signal,
      ready() {
        lease.signal.throwIfAborted();
        const temporary = receipt + '.' + randomUUID();
        try {
          writeFileSync(temporary, JSON.stringify({ target: operating.target, publicOrigin, schedule,
            googleSince: operating.googleDaily ? resumeSince ?? Date.now() : null,
            ...(backup ? { backupSince: backupResumeSince ?? Date.now() } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
          renameSync(temporary, receipt);
        } finally { rmSync(temporary, { force: true }); }
      },
      async close() { try { await lease.close(); } finally { await release(); } },
    };
  } catch (error) {
    await lease?.close();
    throw error;
  }
}
