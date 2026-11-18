import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { isPrivateTowerOrigin } from '../../scripts/browser-request-policy.mjs';
import { NEW_INSTALL_NAMES, readResourceNames } from '../../scripts/resource-names.mjs';
import { ContainerRefusal } from './development.mjs';

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
  const { readComposeCustomerOperating } = await import('../../scripts/local-customer-operating.mjs');
  const io = { lstatSync, readFileSync };
  const config = JSON.parse(privateText(io, '/state/installation/customer-runtime.json', 32768));
  const plan = composeCustomerPlan(process.env, config.towerOrigin);
  const archiveBucket = composeArchiveBucket('/state/installation');
  const backup = await containerBackupStatus('/state/backup-client.json');
  if (backup.configured) throw new ContainerRefusal('Customer mode needs the existing backup request and export path before it can run with this backup declaration.');
  const bridgePeer = composeBridgePeer(readFileSync('/proc/net/route', 'utf8'));
  const bootstrap = JSON.parse(privateText(io, '/state/workers/ingest/.dev.secrets.json', 16384));
  const operating = readComposeCustomerOperating('/state/installation/customer-runtime.json', plan, bootstrap);
  await verifyComposeCustomerWorkspace(plan.url, operating, plan.localTowerOrigin);
  return { plan, operating, bridgePeer, archiveBucket };
}

async function runCustomer(stop) {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { openCustomerTarget } = await import('../../scripts/local-customer-operating.mjs');
  const { startPreparedCustomer } = await import('../../scripts/local-customer-attach.mjs');
  const { privateDirectory } = await import('../../scripts/local-customer.mjs');
  if (selectedCustomerProfile() !== 'customer') throw new ContainerRefusal('The customer profile was not selected.');
  const selection = lstatSync(marker);
  const activation = `${selection.ino}/${selection.mtimeMs}`;
  const { plan, operating, bridgePeer, archiveBucket } = await prepareCustomer();
  const state = '/state/.local/compose-customer';
  privateDirectory(state, !existsSync(state));
  const workerState = composeArchiveState('/state', { lstatSync }, folder => { if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 }); });
  const db = await openCustomerTarget(plan, operating, path.join(state, 'customer'), path.join(state, 'target.json'), { activation });
  const app = await startPreparedCustomer(plan, db, { deployment: {
    artifactRoot, archiveBucket, workerState, listenPort: 5173, bridgePeer,
  } });
  try {
    const status = await Promise.race([stop.then(() => 0), app.whenLost.then(() => 1)]);
    if (status === 1) process.stderr.write('NoticeOS customer runtime lost its scheduler lease.\n');
    return status;
  } finally { await app.close(); }
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
      await prepareCustomer();
      const { readDemoArtifact } = await import('../../scripts/hosted-demo-server.mjs');
      readDemoArtifact(artifactRoot);
      process.stdout.write('The prepared customer target passed preflight.\n');
    } catch (error) { reportRefusal(error); process.exitCode = 1; }
  } else process.exitCode = await launchWorker();
}
