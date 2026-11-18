import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { request } from 'node:http';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { isPrivateTowerOrigin } from '../../scripts/browser-request-policy.mjs';
import { NEW_INSTALL_NAMES, readResourceNames } from '../../scripts/resource-names.mjs';
import { ContainerRefusal } from './development.mjs';
import { CUSTOMER_BACKUP_CLIENT, CUSTOMER_BACKUP_EFFECT_MS, CUSTOMER_BACKUP_PATH } from '../../scripts/customer-backup.mjs';
import { D1_FAILURE_LABELS } from '../../packages/contract/src/cloudflare-d1.mjs';

const marker = '/state/installation/customer-runtime.enabled';
const selected = '/tmp/noticeos-running-profile';
const format = 'noticeos-compose-customer/1';
const artifactRoot = '/opt/noticeos/customer-artifacts';
export const customerReadinessPath = '/_noticeos/ready';

function privateText(io, file, limit) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > limit) {
    throw new ContainerRefusal('Customer profile declarations must be private regular files.');
  }
  return io.readFileSync(file, 'utf8');
}

export function selectedCustomerProfile(io = { lstatSync, readFileSync }) {
  try {
    if (privateText(io, marker, 64) !== `${format}\n`) throw new ContainerRefusal('The customer profile selection is invalid.');
    return 'customer';
  } catch (error) {
    if (error.code === 'ENOENT') return 'standalone';
    throw error;
  }
}

function containerStart(io) {
  const stat = io.readFileSync('/proc/1/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/u.test(start ?? '')) throw new ContainerRefusal('The container start cannot be established.');
  return start;
}

export function recordContainerProfile(profile) {
  const temporary = `${selected}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${containerStart({ readFileSync })} ${profile}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, selected);
  } finally { rmSync(temporary, { force: true }); }
}

export function runningContainerProfile(io = { lstatSync, readFileSync }) {
  try {
    const value = privateText(io, selected, 64).trim();
    const [start, profile, extra] = value.split(' ');
    if (/^\d+$/u.test(start) && ['customer', 'standalone'].includes(profile) && extra === undefined) {
      return start === containerStart(io) ? profile : null;
    }
  } catch (error) { if (error.code === 'ENOENT') return null; }
  throw new ContainerRefusal('The running application profile cannot be established.');
}

export function composeCustomerPlan(env, towerOrigin) {
  const port = Number(env.NOTICEOS_HOST_TOWER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || String(port) !== env.NOTICEOS_HOST_TOWER_PORT) {
    throw new ContainerRefusal('Customer mode needs the published Tower port.');
  }
  const address = env.NOTICEOS_HOST_TOWER_ADDRESS;
  const local = { root: '/opt/noticeos', url: `http://127.0.0.1:${port}`, port, doorPort: 5173 };
  if (towerOrigin === undefined && address === '127.0.0.1') return local;
  const hosts = (env.TOWER_ALLOWED_HOSTS ?? '').split(/[,\s]+/u);
  if (!isPrivateTowerOrigin(towerOrigin)) throw new ContainerRefusal('Set towerOrigin to the exact home-network Tower address in the private customer configuration.');
  const url = new URL(towerOrigin);
  if (url.port !== String(port) || !hosts.includes(url.hostname)
    || (address !== '0.0.0.0' && address !== '127.0.0.1' && !(isIP(address) === 4 && isPrivateTowerOrigin(`http://${address}:${port}`)))) {
    throw new ContainerRefusal('The home-network Tower address must match the published port and an allowed installation host.');
  }
  return { ...local, url: towerOrigin, localTowerOrigin: towerOrigin };
}

// Linux reports the default IPv4 route in network-interface byte order.
export function composeBridgePeer(routeTable) {
  const gateways = routeTable.trim().split('\n').slice(1).flatMap(line => {
    const [, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/u);
    if (destination !== '00000000' || mask !== '00000000' || !/^[0-9a-f]{8}$/iu.test(gateway ?? '')
      || !/^[0-9a-f]{4}$/iu.test(flags ?? '') || (Number.parseInt(flags, 16) & 3) !== 3) return [];
    const address = Array.from(Buffer.from(gateway, 'hex')).reverse().join('.');
    return isIP(address) === 4 && !/^(?:0|127|22[4-9]|2[3-5][0-9])\./u.test(address) ? [address] : [];
  });
  if (gateways.length !== 1) throw new ContainerRefusal('Customer mode requires one unambiguous IPv4 Compose gateway.');
  return gateways[0];
}

export function composeArchiveState(home, io, makeDirectory) {
  const locations = ['.wrangler', '.wrangler/state', '.wrangler/state/v3'].map(folder => path.join(home, folder));
  for (const folder of locations) {
    makeDirectory(folder);
    const stat = io.lstatSync(folder);
    if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new ContainerRefusal('The existing application archive path is unavailable.');
  }
  return locations[2];
}

export async function verifyComposeCustomerWorkspace(origin, operating, localTowerOrigin) {
  const { openStore } = await import('../../packages/postgres/src/store.mjs');
  const { openWorkspaceServiceGrant } = await import('../../packages/postgres/src/service-grant.mjs');
  const { openIdentity } = await import('../../packages/postgres/src/identity.mjs');
  const { workspaceId, serviceId } = operating.workspaces[0];
  const store = openStore(operating.address, { maxConnections: 1 });
  try {
    if (await store.onlyWorkspace() !== workspaceId) throw new Error('workspace');
  } catch { throw new ContainerRefusal('The existing database must contain exactly the prepared customer workspace.'); }
  finally { await store.close(); }
  const grant = openWorkspaceServiceGrant({ connectionString: operating.grantAddress, workspaceId, principalId: serviceId });
  try {
    const facts = await grant.facts();
    if (facts?.workspaceStatus !== 'active' || !facts.actions.includes('workflows.run')) throw new Error('grant');
  } catch { throw new ContainerRefusal('The prepared workspace needs its active customer schedule grant.'); }
  finally { await grant.close(); }
  let identity;
  try {
    identity = await openIdentity({ connectionString: operating.identityAddress, sessionSecret: operating.identitySecret, trustedOrigin: origin, localTowerOrigin });
    if ((await identity.workspaceSummary(workspaceId))?.status !== 'active') throw new Error('identity');
  } catch { throw new ContainerRefusal('The prepared identity role cannot read the enrolled customer workspace.'); }
  finally { await identity?.close(); }
}

/** Check the selected effects without contacting a site, Discord or the task service. */
export async function verifyComposeCustomerFollowups(operating) {
  const { workspaceId } = operating.workspaces[0];
  const notice = operating.revenueNotices?.find(entry => entry.workspaceId === workspaceId);
  const filing = operating.taskFollowups?.find(entry => entry.workspaceId === workspaceId);
  if (notice) {
    try {
      const { readCustomerConnection, customerCredentialFields } = await import('../../scripts/customer-stored-connection.mjs');
      const { revenueWebhookId } = await import('../../scripts/customer-collection-policy.mjs');
      const row = await readCustomerConnection({ address: operating.address, workspaceId }, 'discord');
      const fields = await customerCredentialFields(row, operating.credentialsKey);
      if (revenueWebhookId(new URL(fields.DISCORD_WEBHOOK_URL)) !== notice.webhookId) throw new Error();
    } catch { throw new ContainerRefusal('Connect the selected revenue webhook in Integrations before enabling Discord revenue notices.'); }
  }
  if (filing) {
    const { openWorkspaceServiceGrant } = await import('../../packages/postgres/src/service-grant.mjs');
    const grant = openWorkspaceServiceGrant({ connectionString: operating.grantAddress, workspaceId, principalId: filing.serviceId });
    try {
      const facts = await grant.facts();
      if (facts?.workspaceStatus !== 'active' || !['workflows.run', 'tasks.write'].every(action => facts.actions.includes(action))) throw new Error();
    } catch { throw new ContainerRefusal('Prepare the dedicated automatic task grant with workflows.run and tasks.write.'); }
    finally { await grant.close(); }
  }
}

export async function verifyComposeCustomerCollection(operating) {
  if (!operating.collectorProviders.includes('clarity')) return;
  const { openWorkspaceStore } = await import('../../packages/postgres/src/store.mjs');
  const store = openWorkspaceStore(operating.address, { workspaceId: operating.workspaces[0].workspaceId, maxConnections: 1 });
  try {
    const connected = await store.read(tx => tx.query(`SELECT 1 FROM noticeos.integration_connections c
      JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
      WHERE c.workspace_id=$1::uuid AND c.provider='clarity' LIMIT 1`, [tx.workspaceId]));
    if (!connected.length) throw new ContainerRefusal('Connect Microsoft Clarity in the standalone Tower before enabling its customer schedule.');
  } finally { await store.close(); }
}

export function composeArchiveBucket(installationDir) {
  try {
    const names = readResourceNames({ env: { NOTICEOS_INSTALLATION_DIR: installationDir } });
    return names.rawSignalsBucket ?? NEW_INSTALL_NAMES.rawSignalsBucket;
  } catch {
    throw new ContainerRefusal('The installation’s resource-names.json must identify its existing archive bucket.');
  }
}

async function prepareCustomer() {
  const { containerBackupStatus } = await import('../../scripts/container-backup-channel.mjs');
  const { createCustomerBackup } = await import('../../scripts/customer-backup.mjs');
  const { readComposeCustomerOperating } = await import('../../scripts/local-customer-operating.mjs');
  const io = { lstatSync, readFileSync };
  const config = JSON.parse(privateText(io, '/state/installation/customer-runtime.json', 32768));
  const plan = composeCustomerPlan(process.env, config.towerOrigin);
  const archiveBucket = composeArchiveBucket('/state/installation');
  const backupStatus = await containerBackupStatus(CUSTOMER_BACKUP_CLIENT);
  const bridgePeer = composeBridgePeer(readFileSync('/proc/net/route', 'utf8'));
  const bootstrap = JSON.parse(privateText(io, '/state/workers/ingest/.dev.secrets.json', 16384));
  const operating = readComposeCustomerOperating('/state/installation/customer-runtime.json', plan, bootstrap);
  await verifyComposeCustomerWorkspace(plan.url, operating, plan.localTowerOrigin);
  const backup = backupStatus.configured ? {
    ...createCustomerBackup({ ...operating, workspaceId: operating.workspaces[0].workspaceId, client: CUSTOMER_BACKUP_CLIENT,
      staging: '/state/.local/compose-customer/backup-staging' }),
    client: CUSTOMER_BACKUP_CLIENT, operatorToken: bootstrap.OPERATOR_TOKEN,
  } : undefined;
  return { plan, operating, bridgePeer, archiveBucket, backup };
}

async function runCustomer(stop) {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { openCustomerTarget } = await import('../../scripts/local-customer-operating.mjs');
  const { startPreparedCustomer } = await import('../../scripts/local-customer-attach.mjs');
  const { privateDirectory } = await import('../../scripts/local-customer.mjs');
  if (selectedCustomerProfile() !== 'customer') throw new ContainerRefusal('The customer profile was not selected.');
  const selection = lstatSync(marker);
  const activation = `${selection.ino}/${selection.mtimeMs}`;
  const { plan, operating, bridgePeer, archiveBucket, backup } = await prepareCustomer();
  const state = '/state/.local/compose-customer';
  privateDirectory(state, !existsSync(state));
  const workerState = composeArchiveState('/state', { lstatSync }, folder => { if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 }); });
  const launch = async artifactRoot => {
    const db = await openCustomerTarget(plan, operating, path.join(state, 'customer'), path.join(state, 'target.json'), { activation, backup: Boolean(backup) });
    // A backed-up store remains accessible so its owner can replace a revoked credential.
    try {
      const backupProblem = await backup?.check(db.signal);
      if (backupProblem) process.stderr.write(`NoticeOS backup unavailable. ${backupProblem}\n`);
    } catch (error) { await db.close(); throw error; }
    return startPreparedCustomer(plan, db, { deployment: {
      artifactRoot, archiveBucket, workerState, listenPort: 5173, bridgePeer, backup,
    } });
  };
  if (process.env.NOTICEOS_LIVE_SOURCE_ROOT) {
    const { runLiveCustomer } = await import('../../scripts/customer-development.mjs');
    return runLiveCustomer({ root: plan.root, state, launch, stop });
  }
  const app = await launch(artifactRoot);
  try {
    const status = await Promise.race([stop.then(() => 0), app.whenLost.then(() => 1)]);
    if (status === 1) process.stderr.write('NoticeOS customer runtime lost its scheduler lease.\n');
    return status;
  } finally { await app.close(); }
}

export async function runCustomerBackupCommand({ operatorToken, send = request } = {}) {
  const token = operatorToken ?? JSON.parse(privateText({ lstatSync, readFileSync }, '/state/workers/ingest/.dev.secrets.json', 16384)).OPERATOR_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/u.test(token)) throw new ContainerRefusal('The prepared backup access token is missing.');
  const signal = AbortSignal.timeout(CUSTOMER_BACKUP_EFFECT_MS + 5000);
  return new Promise((resolve, reject) => {
    const call = send(`http://127.0.0.1:5173${CUSTOMER_BACKUP_PATH}`, { method: 'POST', signal,
      headers: { host: '127.0.0.1:5173', authorization: `Bearer ${token.trim()}`, 'content-length': '0' } }, async response => {
      try {
        if (![200, 503].includes(response.statusCode) || response.headers['content-type'] !== 'application/json') throw new Error();
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error();
          chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks));
        if (result?.ok === (response.statusCode === 200)) resolve(result);
        else reject(new Error());
      } catch (error) { response.destroy(); reject(error); }
    });
    call.once('error', reject);
    call.end();
  });
}

function reportRefusal(error) {
  const documented = ['ContainerRefusal', 'CustomerOperatingRefused'].includes(error?.constructor?.name);
  process.stderr.write(`NoticeOS customer runtime refused. ${documented ? error.message : 'Check the prepared app, database roles and scheduler grant.'}\n`);
}

async function launchWorker() {
  const runtime = new Worker(new URL(import.meta.url), { workerData: { composeCustomer: true } });
  const stop = () => runtime.postMessage('stop');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await new Promise(resolve => {
      let status = 1;
      runtime.on('message', code => { status = code; });
      runtime.once('error', () => { process.stderr.write('NoticeOS customer runtime stopped before it became ready.\n'); });
      runtime.once('exit', code => resolve(code || status));
    });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (!isMainThread && workerData?.composeCustomer === true) {
  const stop = new Promise(resolve => parentPort.once('message', resolve));
  try { parentPort.postMessage(await runCustomer(stop)); }
  catch (error) {
    reportRefusal(error);
    parentPort.postMessage(1);
  } finally { parentPort.close(); }
} else if (process.argv[1] === import.meta.filename) {
  if (process.argv[2] === '--check') {
    try {
      const { backup, operating, plan } = await prepareCustomer();
      await verifyComposeCustomerFollowups(operating);
      await verifyComposeCustomerCollection(operating);
      const problem = await backup?.check();
      if (problem) throw new ContainerRefusal(problem);
      if (process.env.NOTICEOS_LIVE_SOURCE_ROOT) {
        const { customerSourceRevision, prepareLiveCustomerArtifact } = await import('../../scripts/customer-development.mjs');
        const revision = customerSourceRevision(plan.root);
        const candidate = await prepareLiveCustomerArtifact('/state/.local', revision);
        candidate.dispose();
        if (revision !== customerSourceRevision(plan.root)) throw new ContainerRefusal('The checkout changed during preflight. Check again after saving edits.');
      } else {
        const { readDemoArtifact } = await import('../../scripts/hosted-demo-server.mjs');
        readDemoArtifact(artifactRoot);
      }
      process.stdout.write('The prepared customer target passed preflight.\n');
    } catch (error) { reportRefusal(error); process.exitCode = 1; }
  } else if (process.argv[2] === '--backup') {
    try {
      const result = await runCustomerBackupCommand();
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.ok) {
        const d1 = result.stage === 'assets' && result.cause?.startsWith('d1_') ? D1_FAILURE_LABELS[result.cause.slice(3)] : undefined;
        const action = result.stage === 'taskHub' ? 'Check the saved Ntasks workspace and its backup-only credential.'
          : d1 ? `${d1}.` : 'Check the backup worker and its latest report.';
        process.stderr.write(`Customer backup incomplete. ${action}\n`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } catch { process.stderr.write('Customer backup unavailable. Check the configured worker and the running customer app.\n'); process.exitCode = 1; }
  } else process.exitCode = await launchWorker();
}
