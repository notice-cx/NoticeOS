// Loopback composition for an empty, foreground-owned customer fixture.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { APP_RELEASE_HEADER, isAppApiPath, releaseMismatch } from '../apps/tower/shared/app-release.ts';
import { demoRequestTarget as requestTarget, readDemoArtifact as readHostedArtifact } from './hosted-demo-server.mjs';
import { emailEnrollmentUrl } from './identity-protocol.mjs';
import { localCustomerOutbound, localD1BackupOutbound } from './local-customer-egress.mjs';
import { customerCollectionPolicy } from './customer-collection-policy.mjs';
import { localDataForSeoOutbound } from './customer-dataforseo-egress.mjs';
import { localCustomerTaskFollowups } from './local-customer-task-followups.mjs';
import { localCustomerReports } from './local-customer-reports.mjs';
import { localCustomerAnalysisWorkflows } from './local-customer-analysis-workflows.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';
import { isPrivateTowerOrigin } from './browser-request-policy.mjs';
import { SITE_REPORT_INTAKE_PATH, localSiteReportsEnabled } from './workspace-operations.mjs';
import { CUSTOMER_BACKUP_PATH, customerBackupBearer } from './customer-backup.mjs';
import { CLOUDFLARE_D1_BACKUP_PATH } from '../packages/contract/src/cloudflare-d1.mjs';
import { BACKUP_APP_ORIGIN } from './container-backup-profile.mjs';
import { activeCustomerBackupRequest } from './container-backup-channel.mjs';

const HOST = '127.0.0.1';
const MAIL_SENDER = 'noticeos@example.test';
const LOCAL_PEER_HEADER = 'x-noticeos-local-peer-proof';
const SCHEDULE_HEADER = 'x-noticeos-local-schedule-proof';
const BACKUP_HEADER = 'x-noticeos-local-backup-proof';
const FIRST_WORKSPACES = [
  { slug: 'east', displayName: 'East workspace', email: 'owner-east@example.test' },
  { slug: 'west', displayName: 'West workspace', email: 'owner-west@example.test' },
];
const MAIL_WORKER = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint {
  async send(message) {
    const result = await this.env.OUTBOX.fetch('https://outbox.invalid/', { method: 'POST', body: JSON.stringify(message) });
    if (!result.ok) throw new Error('Local mail delivery unavailable.');
    return { messageId: await result.text() };
  }
}`;

function provision(cluster, publicOrigin, deliver) {
  const inviter = randomUUID();
  const defaults = JSON.stringify(releasedDefaultDocuments());
  return FIRST_WORKSPACES.map(entry => {
    const workspaceId = randomUUID(), serviceId = randomUUID(), invitationId = randomUUID();
    // Synthetic platform setup prepares active workspaces with pending invitations.
    // Their first owners are created by the normal invitation acceptance route.
    cluster.run(`BEGIN;
      SELECT noticeos_platform.prepare_workspace(:'workspace_id'::uuid, :'slug', :'display_name',
        :'email', now() + interval '1 day', :'defaults'::jsonb);
      UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=:'workspace_id'::uuid;
      UPDATE noticeos_identity.auth_organization SET name=:'display_name' WHERE id=:'workspace_id'::uuid;
      INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
        VALUES (:'inviter'::uuid,'Local workspace setup','provisioner@example.test',false) ON CONFLICT (id) DO NOTHING;
      INSERT INTO noticeos_identity.auth_invitation(id,organization_id,email,role,status,expires_at,inviter_id)
        VALUES (:'invitation'::uuid,:'workspace_id'::uuid,:'email','owner','pending',now()+interval '1 day',:'inviter'::uuid);
      INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
        VALUES (:'service_id'::uuid,:'workspace_id'::uuid,ARRAY['workflows.run'],now()+interval '1 year');
      COMMIT;`, { vars: { workspace_id: workspaceId, service_id: serviceId, invitation: invitationId,
      slug: entry.slug, display_name: entry.displayName, email: entry.email, inviter, defaults } });
    const url = emailEnrollmentUrl(publicOrigin, { kind: 'invitation', id: invitationId });
    deliver({ from: MAIL_SENDER, to: entry.email, subject: 'Join your NoticeOS workspace', text: `Join your workspace: ${url}` });
    return Object.freeze({ workspaceId, serviceId, email: entry.email, url });
  });
}

function renewFirstInvitations(cluster, settings, deliver) {
  for (const [index, workspace] of settings.workspaces.entries()) {
    const email = FIRST_WORKSPACES[index].email;
    const id = /^#invitation=([a-f0-9-]{36})$/u.exec(new URL(workspace.url).hash)?.[1];
    if (!id || workspace.email !== email || workspace.url !== emailEnrollmentUrl(settings.publicOrigin, { kind: 'invitation', id })) {
      throw new Error('The local first-owner invitation is invalid.');
    }
    const renewed = cluster.script(`UPDATE noticeos_identity.auth_invitation AS invitation
      SET expires_at = now() + interval '1 day'
      WHERE invitation.id = :'id'::uuid AND invitation.organization_id = :'workspace'::uuid
        AND invitation.email = :'email' AND invitation.role = 'owner'
        AND invitation.status = 'pending' AND invitation.expires_at <= now()
        AND EXISTS (SELECT FROM noticeos.workspaces w WHERE w.workspace_id = invitation.organization_id AND w.status = 'active')
        AND NOT EXISTS (SELECT FROM noticeos_identity.auth_member m WHERE m.organization_id = invitation.organization_id)
        AND NOT EXISTS (SELECT FROM noticeos_identity.auth_invitation other
          WHERE other.organization_id = invitation.organization_id AND other.id <> invitation.id
            AND other.email = invitation.email AND other.status = 'pending' AND other.expires_at > now())
      RETURNING invitation.id;`, { vars: { id, workspace: workspace.workspaceId, email } });
    if (renewed.length) deliver({ from: MAIL_SENDER, to: email, subject: 'Join your NoticeOS workspace',
      text: `Join your workspace: ${workspace.url}` });
  }
}

export function localMailbox(outbox, accepts = email => /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@example\.test$/iu.test(email)) {
  return message => {
    if (message?.from !== MAIL_SENDER || typeof message.to !== 'string' || message.to.length > 320
      || !accepts(message.to)
      || typeof message.subject !== 'string' || message.subject.length > 128
      || typeof message.text !== 'string' || message.text.length > 2048) throw new Error('Local mail delivery unavailable.');
    const id = randomUUID();
    const { from, to, subject, text } = message;
    writeFileSync(path.join(outbox, `${id}.json`), JSON.stringify({ from, to, subject, text }) + '\n', { mode: 0o600, flag: 'wx' });
    return id;
  };
}

function gatewayHeaders(request, peerProof) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || /^(?:cf-|mf-|x-forwarded-|x-noticeos-local-|x-noticeos-trusted-peer$|forwarded$|connection$|transfer-encoding$|upgrade$)/u.test(name)) continue;
    for (const field of Array.isArray(value) ? value : [value]) headers.append(name, field);
  }
  headers.set('cf-connecting-ip', request.socket.remoteAddress);
  headers.set(LOCAL_PEER_HEADER, peerProof);
  return Object.fromEntries(headers);
}

async function requestBody(request) {
  if (['GET', 'HEAD'].includes(request.method)) {
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) throw new Error('Unexpected request body.');
    return undefined;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function customerServer(publicOrigin, runtime, peerProof, admits, { release, bridgePeer, ready, localTowerOrigin, backup }) {
  const server = createServer(async (request, reply) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30000);
    const stop = () => abort.abort();
    reply.once('close', stop);
    try {
      const peer = request.socket.remoteAddress;
      const serviceHost = new URL(BACKUP_APP_ORIGIN).host;
      if (backup && request.headers.host === serviceHost) {
        const url = requestTarget(BACKUP_APP_ORIGIN, request);
        const authorized = url.pathname === CLOUDFLARE_D1_BACKUP_PATH && request.headers.origin === undefined
          && customerBackupBearer(request.headers.authorization, backup.operatorToken)
          && await activeCustomerBackupRequest(backup.client, request.headers['x-noticeos-backup-request']);
        if (!authorized || !['GET', 'POST'].includes(request.method)) {
          reply.writeHead(403, { 'cache-control': 'no-store', connection: 'close' }).end();
          return;
        }
        if (request.method === 'GET' && !url.search && !await backup.sameTaskRevision()) {
          reply.writeHead(409, { 'cache-control': 'no-store', 'content-type': 'application/json', connection: 'close' });
          reply.end(JSON.stringify({ error: 'connection_changed' }));
          return;
        }
        clearTimeout(timeout);
        const bounds = AbortSignal.any([abort.signal, AbortSignal.timeout(240_000)]);
        const headers = { ...(request.method === 'POST' ? { 'content-type': request.headers['content-type'] ?? '' } : {}) };
        const response = await backup.cloudflare(new Request('https://backup.internal' + url.pathname + url.search,
          { method: request.method, headers, body: await requestBody(request), signal: bounds }));
        const output = Object.fromEntries([...response.headers].filter(([name]) => !['connection', 'transfer-encoding', 'set-cookie'].includes(name)));
        reply.writeHead(response.status, output);
        if (response.body) await pipeline(Readable.fromWeb(response.body), reply, { signal: bounds });
        else reply.end();
        return;
      }
      if (backup && request.url === CUSTOMER_BACKUP_PATH) {
        if (peer !== HOST || request.headers.host !== '127.0.0.1:5173' || request.method !== 'POST' || request.headers.origin !== undefined || request.headers['transfer-encoding']
          || Number(request.headers['content-length'] ?? '0') !== 0 || !customerBackupBearer(request.headers.authorization, backup.operatorToken)) {
          reply.writeHead(403, { 'cache-control': 'no-store' }).end();
          return;
        }
        const result = await backup.manual();
        reply.writeHead(result.ok ? 200 : 503, { 'cache-control': 'no-store', 'content-type': 'application/json' });
        reply.end(JSON.stringify(result));
        return;
      }
      if (ready && request.url === '/_noticeos/ready') {
        const healthy = peer === HOST && request.headers.host === '127.0.0.1:5173' && request.method === 'GET' && await ready();
        reply.writeHead(healthy ? 204 : 404, { 'cache-control': 'no-store' }).end();
        return;
      }
      const privatePeer = localTowerOrigin && isPrivateTowerOrigin(`http://${peer}:5173`);
      if (peer !== HOST && peer !== bridgePeer && !privatePeer) throw new Error('Local connection required.');
      const url = requestTarget(publicOrigin, request);
      // A published bridge may present the same peer for a LAN client and the host.
      // Only a socket originating inside the app container can submit a local report here.
      if (localTowerOrigin && url.pathname === SITE_REPORT_INTAKE_PATH && peer !== HOST) {
        reply.writeHead(404, { 'cache-control': 'no-store' }).end();
        return;
      }
      if (isAppApiPath(url.pathname)) {
        // The browser checks the release on gateway denials as well as Worker responses.
        reply.setHeader(APP_RELEASE_HEADER, release);
        if (releaseMismatch(request.headers[APP_RELEASE_HEADER] ?? null, release)) {
          reply.writeHead(409, { 'cache-control': 'no-store', 'content-type': 'application/json' });
          reply.end(JSON.stringify({ error: 'app_release_changed' }));
          return;
        }
      }
      if (url.pathname.startsWith('/cdn-cgi/')) throw new Error('Internal runtime path.');
      const input = { method: request.method, redirect: 'manual',
        headers: gatewayHeaders(request, peerProof), body: await requestBody(request), signal: abort.signal };
      const response = !admits || await admits(new Request(url.href, input)) ? await runtime.dispatchFetch(url.href, input)
        : new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
      for (const [name, value] of response.headers) {
        if (!['set-cookie', 'connection', 'transfer-encoding'].includes(name)) reply.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.setHeader('set-cookie', cookies);
      reply.writeHead(response.status);
      if (!response.body || request.method === 'HEAD') reply.end();
      else await pipeline(Readable.fromWeb(response.body), reply, { signal: abort.signal });
    } catch {
      if (reply.headersSent) reply.destroy();
      else if (!reply.destroyed) reply.writeHead(400, { 'cache-control': 'no-store' }).end();
    } finally {
      clearTimeout(timeout);
      reply.off('close', stop);
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

export function localNtasksOrigin(value) {
  if (typeof value !== 'string') throw new Error('Use the loopback HTTP address of a separate local Ntasks.');
  const origin = new URL(value);
  if (origin.origin !== value || origin.protocol !== 'http:' || origin.hostname !== HOST || !origin.port) {
    throw new Error('Use the loopback HTTP address of a separate local Ntasks.');
  }
  return value;
}

export async function customerWorkerdReady(schedulerReady, probe) {
  if (!schedulerReady()) return false;
  try { return (await probe(AbortSignal.timeout(1500))).status === 204 && schedulerReady(); }
  catch { return false; }
}

export function privateDirectory(name, create = false) {
  if (create) mkdirSync(name, { mode: 0o700 });
  const stat = lstatSync(name);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || realpathSync(name) !== name) throw new Error('Customer state must be private.');
  return name;
}

function readSettings(file, publicOrigin, requestedNtasks) {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('Customer settings must be private.');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (settings.format !== 'noticeos-local-customer/1' || settings.publicOrigin !== publicOrigin
    || (requestedNtasks !== null && requestedNtasks !== settings.ntasksOrigin)
    || !/^[A-Za-z0-9_-]{64}$/u.test(settings.identitySecret) || !/^[A-Za-z0-9+/]{43}=$/u.test(settings.credentialsKey)
    || !Array.isArray(settings.workspaces) || settings.workspaces.length !== FIRST_WORKSPACES.length) {
    throw new Error('Restart this customer folder with its original Tower port and Ntasks address.');
  }
  return settings;
}

export function buildCustomer(state, artifactRoot, { signal, developmentRelease } = {}) {
  signal?.throwIfAborted();
  const script = fileURLToPath(new URL('./hosted-demo-build.mjs', import.meta.url));
  const home = path.join(state, 'build-home');
  mkdirSync(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: state, XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
  return new Promise((resolve, reject) => {
    const args = [script, '--out', artifactRoot, '--profile', 'hosted'];
    if (developmentRelease) args.push('--development-release', developmentRelease);
    const build = spawn(process.execPath, args, { env, detached: Boolean(signal), stdio: ['ignore', 'ignore', 'inherit'] });
    const stop = () => {
      if (build.pid === undefined) return;
      try { process.kill(-build.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') build.kill('SIGKILL'); }
    };
    signal?.addEventListener('abort', stop, { once: true });
    build.once('error', reject);
    build.once('close', code => {
      signal?.removeEventListener('abort', stop);
      if (code === 0 && !signal?.aborted) resolve();
      else reject(new Error('Could not build the local customer app.'));
    });
  });
}

/** Starts the released Tower and private ingest binding with the hosted profile. */
export async function startLocalCustomer(plan, development, { startSchedules, ntasksOrigin: selectedNtasks, fixtureProvider } = {}) {
  const publicOrigin = new URL(plan.url).origin;
  if (publicOrigin !== `http://${HOST}:${plan.port}` || !development.cluster) throw new Error('Local customer fixture requires its own loopback database.');
  const requestedNtasks = selectedNtasks === undefined ? null : localNtasksOrigin(selectedNtasks);
  const customer = privateDirectory(path.join(realpathSync(path.dirname(development.customer)), path.basename(development.customer)), development.fresh);
  const { cluster } = development;
  const file = path.join(customer, 'settings.json');
  const outbox = privateDirectory(path.join(customer, 'mail'), development.fresh);
  const deliver = localMailbox(outbox);
  if (requestedNtasks === publicOrigin || requestedNtasks === `http://${HOST}:${cluster.loopbackPort}`) throw new Error('Ntasks needs a separate port.');
  const settings = development.fresh ? {
    format: 'noticeos-local-customer/1', publicOrigin, ntasksOrigin: requestedNtasks,
    identitySecret: randomBytes(48).toString('base64url'), credentialsKey: randomBytes(32).toString('base64'),
    workspaces: provision(cluster, publicOrigin, deliver),
  } : readSettings(file, publicOrigin, requestedNtasks);
  if (development.fresh) writeFileSync(file, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' });
  else renewFirstInvitations(cluster, settings, deliver);
  const { address: connectionString, identityDatabase, grantConnectionString } = development;
  const resumeSince = development.fresh ? undefined : lstatSync(file).mtimeMs;
  return startCustomerRuntime(plan, { ...settings, customer, outbox, deliver, connectionString, identityDatabase, resumeSince,
    workerState: privateDirectory(path.join(customer, 'worker-state'), development.fresh),
    grantConnectionString, startSchedules, fixtureProvider });
}

/** Runtime composition shared by the disposable fixture and its read-only shadow. */
export async function startCustomerRuntime(plan, { customer, outbox, workerState, deliver, mailFrom = MAIL_SENDER, membershipMail = false, connectionString,
  identityDatabase, identitySecret, credentialsKey, workspaces, ntasksOrigin = null, grantConnectionString,
  startSchedules, fixtureProvider, shadowAdmission, resumeSince, backupResumeSince, operating, deployment }) {
  const localTowerOrigin = deployment && plan.localTowerOrigin;
  if (localTowerOrigin && !isPrivateTowerOrigin(localTowerOrigin)) throw new Error('Invalid private Tower origin.');
  const publicOrigin = localTowerOrigin || `http://${HOST}:${plan.port}`;
  if (plan.url !== publicOrigin && plan.url !== publicOrigin + '/') throw new Error('Customer runtime requires its loopback origin.');
  if (shadowAdmission && (startSchedules || grantConnectionString || ntasksOrigin || fixtureProvider || operating || deployment)) {
    throw new Error('Customer shadow cannot start providers or schedules.');
  }
  const localBindings = localTowerOrigin ? { NOTICEOS_LOCAL_TOWER_ORIGIN: localTowerOrigin } : {};
  const siteReports = operating?.siteReports ? { NOTICEOS_LOCAL_SITE_REPORTS: '1' } : {};
  if (operating?.siteReports && !localSiteReportsEnabled({ ...siteReports, ...localBindings, NOTICEOS_WORKSPACE_ORIGIN: publicOrigin })) {
    throw new Error('Site reports require the same explicit loopback address as the customer Tower.');
  }
  const state = deployment ? null : mkdtempSync(path.join(customer, 'build-'));
  const artifactRoot = deployment ? deployment.artifactRoot : path.join(state, 'app');
  let runtime, schedules, server, probe;
  let closing;
  function close() {
    closing ??= (async () => {
      if (server) {
        const stopped = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await stopped;
      }
      try { await schedules?.close(); }
      finally { await runtime?.dispose(); }
      if (state) rmSync(state, { recursive: true, force: true });
    })();
    return closing;
  }
  try {
    if (state) await buildCustomer(state, artifactRoot);
    operating?.signal.throwIfAborted();
    const artifact = readHostedArtifact(artifactRoot);
    const { assets } = JSON.parse(readFileSync(path.join(artifactRoot, artifact.tower.modulesRoot, 'wrangler.json'), 'utf8'));
    const peerProof = randomBytes(32).toString('base64url');
    const scheduleProof = randomBytes(32).toString('base64url');
    const paidScheduleProof = randomBytes(32).toString('base64url');
    const backupProof = randomBytes(32).toString('base64url');
    const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
    const { Miniflare, Log } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
    const bindings = { ...localBindings, NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: publicOrigin,
      NOTICEOS_IDENTITY_DATABASE_URL: identityDatabase, NOTICEOS_IDENTITY_SESSION_SECRET: identitySecret,
      NOTICEOS_WORKSPACE_DATABASE_URL: connectionString };
    const denyOutbound = localCustomerOutbound();
    const tasksOutbound = localCustomerOutbound({ ntasksOrigin, signal: operating?.signal });
    const ingestOutbound = request => fixtureProvider && new URL(request.url).origin !== ntasksOrigin
      ? fixtureProvider(request) : tasksOutbound(request);
    const worker = (name, entry, outboundService = denyOutbound) => ({ name, compatibilityDate: entry.compatibilityDate, compatibilityFlags: entry.compatibilityFlags,
      modulesRoot: path.join(artifactRoot, entry.modulesRoot), modules: [entry.main, ...Object.keys(artifact.files)
        .filter(file => file !== entry.main && file.startsWith(entry.modulesRoot + '/') && /\.m?js$/u.test(file))]
        .map(file => ({ type: 'ESModule', path: path.join(artifactRoot, file) })),
      outboundService });
    const tower = worker('tower', artifact.tower), ingest = worker('ingest', artifact.ingest, ingestOutbound);
    const collection = operating ? customerCollectionPolicy(operating) : undefined;
    const { paidDataForSeo = [], ...freeCollection } = collection ?? {};
    const isolated = collection && (collection.googleDaily || collection.collectorProviders.length || collection.sitePulls.length
      || collection.siteChecks.length || collection.revenueNotices.length || collection.taskFollowups.length);
    const paid = Boolean(startSchedules && paidDataForSeo.length);
    const scheduleName = isolated ? 'customer-scheduled-ingest' : ingest.name;
    const serviceWorkspaces = grantConnectionString
      ? workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })) : [];
    const backup = deployment?.backup;
    if (backup && (!startSchedules || serviceWorkspaces.length !== 1)) throw new Error('Customer backup requires one declared workspace.');
    const scheduleBindings = grantConnectionString ? { NOTICEOS_SCHEDULE_GRANTS: JSON.stringify(serviceWorkspaces),
      ...(collection ? { NOTICEOS_CUSTOMER_COLLECTION: JSON.stringify(freeCollection) } : {}) } : {};
    const scheduleTransport = grantConnectionString ? { hyperdrives: { NOTICEOS_SCHEDULE_GRANT_DB: grantConnectionString } } : {};
    const ingestBindings = { ...bindings, ...(credentialsKey ? { CREDENTIALS_KEY: credentialsKey } : {}) };
    const archive = { r2Buckets: { RAW_SIGNALS: deployment?.archiveBucket ?? 'customer-raw-signals' } };
    const scheduleTrigger = (name, service, proof) => ({ name, modules: true, compatibilityDate: ingest.compatibilityDate,
      script: `export default {fetch(r,e){
        if (r.headers.get('${SCHEDULE_HEADER}') !== e.PROOF) return new Response(null,{status:403});
        if (r.method === 'HEAD' && new URL(r.url).pathname === '/health') return new Response(null,{status:204});
        return e.SCHEDULE.fetch(r);
      }}`, bindings: { PROOF: proof },
      serviceBindings: { SCHEDULE: { name: service, entrypoint: 'CustomerSchedule' } } });
    runtime = new Miniflare({ host: HOST, port: 0, cf: { colo: 'LOCAL' }, inspectorPort: undefined,
      resourcePersistencePath: workerState,
      log: new Log(0), handleStructuredLogs: () => undefined,
      telemetry: { enabled: false }, workers: [
        { ...tower, bindings: { ...bindings, ...siteReports, NOTICEOS_IDENTITY_EDGE: localTowerOrigin ? 'local-network' : 'local-loopback', NOTICEOS_LOCAL_PEER_PROOF: peerProof,
          ...(shadowAdmission ? { NOTICEOS_CUSTOMER_SHADOW: true } : {}),
          ...(membershipMail ? { NOTICEOS_IDENTITY_MAIL_WORKSPACES: workspaces.map(workspace => workspace.workspaceId) } : {}),
          NOTICEOS_IDENTITY_EMAIL_FROM: mailFrom },
          assets: { directory: path.join(artifactRoot, artifact.client), binding: assets.binding, run_worker_first: assets.run_worker_first,
            routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: assets.not_found_handling } },
          serviceBindings: { INGEST: 'ingest', NOTICEOS_IDENTITY_EMAIL: 'mail',
            ...(startSchedules ? { NOTICEOS_CUSTOMER_SCHEDULES: async request => {
              const status = schedules?.status(new URL(request.url).pathname.slice(1));
              return status ? Response.json(status) : new Response(null, { status: 404 });
            } } : {}) },
          r2Buckets: { NOTICEOS_PORTFOLIO: 'customer-portfolio-summaries' } },
        { ...ingest, ...archive, bindings: { ...ingestBindings, ...siteReports, ...(isolated ? {} : scheduleBindings),
          ...(ntasksOrigin === null ? {} : { NOTICEOS_NTASKS_ORIGIN: ntasksOrigin }) },
          ...(isolated ? {} : scheduleTransport) },
        ...(isolated ? [{
          ...worker(scheduleName, artifact.ingest, localCustomerOutbound({ ...freeCollection, signal: operating.signal,
            transport: operating.collectorTransport })), ...archive, ...scheduleTransport, bindings: { ...ingestBindings, ...scheduleBindings },
        }] : []),
        ...(startSchedules ? [scheduleTrigger('customer-schedule-trigger', scheduleName, scheduleProof)] : []),
        ...(paid ? [{
          ...worker('customer-paid-ingest', artifact.ingest, localDataForSeoOutbound({ signal: operating.signal,
            transport: operating.dataForSeoTransport })), ...archive, ...scheduleTransport, bindings: {
            NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_DATABASE_URL: connectionString,
            ...(credentialsKey ? { CREDENTIALS_KEY: credentialsKey } : {}),
            NOTICEOS_SCHEDULE_GRANTS: JSON.stringify(serviceWorkspaces), NOTICEOS_CUSTOMER_PAID_SCHEDULE: true,
            NOTICEOS_CUSTOMER_COLLECTION: JSON.stringify({ paidDataForSeo }) },
        }, scheduleTrigger('customer-paid-trigger', 'customer-paid-ingest', paidScheduleProof)] : []),
        ...(backup ? [{ ...worker('customer-backup-ingest', artifact.ingest, localD1BackupOutbound({ signal: operating.signal,
          transport: deployment.backupD1Transport })), ...archive, ...scheduleTransport, bindings: { ...ingestBindings,
          NOTICEOS_BACKUP_WORKSPACE: serviceWorkspaces[0].workspaceId, NOTICEOS_BACKUP_SERVICE: serviceWorkspaces[0].serviceId } },
        { name: 'customer-backup-trigger', modules: true, compatibilityDate: ingest.compatibilityDate,
          script: `export default {fetch(r,e){return r.headers.get('${BACKUP_HEADER}') === e.PROOF
            ? e.BACKUP.fetch(r) : new Response(null,{status:403})}}`, bindings: { PROOF: backupProof },
          serviceBindings: { BACKUP: { name: 'customer-backup-ingest', entrypoint: 'CustomerBackup' } } }] : []),
        { name: 'mail', modules: true, compatibilityDate: '2026-07-06', script: MAIL_WORKER,
          serviceBindings: { OUTBOX: async request => {
            try { return new Response(await deliver(await request.json())); }
            catch { return new Response(null, { status: 403 }); }
          } } },
      ] });
    await Promise.all([runtime.getWorker('tower'), runtime.getWorker('ingest')]);
    const schedulerReady = () => !closing && !operating.signal.aborted && serviceWorkspaces.length > 0
      && serviceWorkspaces.every(({ workspaceId }) => schedules?.status(workspaceId)?.error === null);
    // The private trigger runs in the same Workerd process as both Workers.
    const ready = deployment && (() => customerWorkerdReady(() => schedulerReady() && (!backup || backup.healthy()), probe));
    const backupTrigger = backup ? await runtime.getWorker('customer-backup-trigger') : undefined;
    const listen = async () => {
      server = customerServer(publicOrigin, runtime, peerProof, shadowAdmission,
        { release: artifact.release, bridgePeer: deployment?.bridgePeer, ready, localTowerOrigin,
          backup: backup && { ...backup, manual: () => schedules?.manualBackup?.() ?? { ok: false, stage: 'preparation', cause: 'worker_unavailable' },
            cloudflare(request) {
              request.headers.set(BACKUP_HEADER, backupProof);
              return backupTrigger.fetch(request);
            } } });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deployment?.listenPort ?? plan.port, deployment ? '0.0.0.0' : HOST,
          () => { server.off('error', reject); resolve(); });
      });
    };
    if (backup) await listen(); // A backup due at startup may need the sidecar's gateway immediately.
    if (startSchedules) {
      operating?.signal.throwIfAborted();
      const scopedSchedule = async (name, secret) => {
        const trigger = await runtime.getWorker(name);
        return { fetch(input, init) {
          const request = new Request(input, init);
          request.headers.set(SCHEDULE_HEADER, secret);
          return trigger.fetch(request);
        } };
      };
      const scheduler = await scopedSchedule('customer-schedule-trigger', scheduleProof);
      const paidWorker = paid ? await scopedSchedule('customer-paid-trigger', paidScheduleProof) : undefined;
      probe = async signal => {
        const check = worker => worker.fetch('https://scheduler.internal/health', { method: 'HEAD', signal });
        const result = await check(scheduler);
        return result.status === 204 && paidWorker ? check(paidWorker) : result;
      };
      const bucket = await runtime.getR2Bucket('RAW_SIGNALS', 'ingest');
      const reports = path.join(customer, 'reports');
      const reportRoot = privateDirectory(reports, !existsSync(reports));
      schedules = await startSchedules({ sourceRoot: plan.root, workspaces: serviceWorkspaces, connectionString,
        resumeSince, backupResumeSince, collection, backup,
        taskFollowups: collection?.taskFollowups.length ? localCustomerTaskFollowups({ sourceRoot: plan.root,
          root: reportRoot, credentialsKey, ntasksOrigin, transport: operating.collectorTransport }) : undefined,
        grantConnectionString, credentialsKey, analysis: localCustomerAnalysisWorkflows({ sourceRoot: plan.root, root: reportRoot }),
        reports: localCustomerReports({ sourceRoot: plan.root,
          root: reportRoot, bucket }), worker: scheduler, paidWorker, bucket });
    }
    operating?.signal.throwIfAborted();
    if (deployment && ((backup && !schedules?.manualBackup) || !await customerWorkerdReady(schedulerReady, probe))) {
      throw new Error('The configured customer schedule or Worker runtime is unavailable.');
    }
    if (!backup) await listen();
    return Object.freeze({ publicOrigin, workspaces, outbox, whenIdle: () => schedules?.whenIdle(), close });
  } catch (error) {
    await close();
    throw error;
  }
}
