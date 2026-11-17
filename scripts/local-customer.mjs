// Loopback composition for an empty, foreground-owned customer fixture.
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { demoRequestTarget as requestTarget, readDemoArtifact as readHostedArtifact } from './hosted-demo-server.mjs';
import { emailEnrollmentUrl } from './identity-protocol.mjs';
import { localCustomerReports } from './local-customer-reports.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { LOOPBACK_HBA } from './postgres-dev.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';

const HOST = '127.0.0.1';
const MAIL_SENDER = 'noticeos@example.test';
const LOCAL_PEER_HEADER = 'x-noticeos-local-peer-proof';
const SCHEDULE_HEADER = 'x-noticeos-local-schedule-proof';
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

function localLogin(cluster, address, role) {
  const password = randomBytes(32).toString('base64url');
  cluster.run(`ALTER ROLE ${role} LOGIN PASSWORD '${scramVerifier(password)}';`);
  appendFileSync(path.join(cluster.root, LOOPBACK_HBA), `host all ${role} ${HOST}/32 scram-sha-256\n`);
  const url = new URL(address);
  url.username = role;
  url.password = password;
  return url.href;
}

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

function localMailbox(outbox) {
  return message => {
    if (message?.from !== MAIL_SENDER || typeof message.to !== 'string' || message.to.length > 320
      || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@example\.test$/iu.test(message.to)
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

function customerServer(publicOrigin, runtime, peerProof) {
  const server = createServer(async (request, reply) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30000);
    const stop = () => abort.abort();
    reply.once('close', stop);
    try {
      if (request.socket.remoteAddress !== HOST) throw new Error('Loopback required.');
      const url = requestTarget(publicOrigin, request);
      if (url.pathname.startsWith('/cdn-cgi/')) throw new Error('Internal runtime path.');
      const response = await runtime.dispatchFetch(url.href, { method: request.method, redirect: 'manual',
        headers: gatewayHeaders(request, peerProof), body: await requestBody(request), signal: abort.signal });
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

function privateDirectory(name, create = false) {
  if (create) mkdirSync(name, { mode: 0o700 });
  const stat = lstatSync(name);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || realpathSync(name) !== name) throw new Error('Customer state must be private.');
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

function buildCustomer(state, artifactRoot) {
  const script = fileURLToPath(new URL('./hosted-demo-build.mjs', import.meta.url));
  const home = path.join(state, 'build-home');
  mkdirSync(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: state, XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
  return new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [script, '--out', artifactRoot, '--profile', 'hosted'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    build.once('error', reject);
    build.once('close', code => code === 0 ? resolve() : reject(new Error('Could not build the local customer app.')));
  });
}

/** Starts the released Tower and private ingest binding with the hosted profile. */
export async function startLocalCustomer(plan, development, { startSchedules, ntasksOrigin: selectedNtasks, fixtureProvider } = {}) {
  const publicOrigin = new URL(plan.url).origin;
  if (publicOrigin !== `http://${HOST}:${plan.port}` || !development.cluster) throw new Error('Local customer fixture requires its own loopback database.');
  const requestedNtasks = selectedNtasks === undefined ? null : localNtasksOrigin(selectedNtasks);
  const customer = privateDirectory(path.join(realpathSync(path.dirname(development.customer)), path.basename(development.customer)), development.fresh);
  const state = mkdtempSync(path.join(customer, 'build-'));
  const artifactRoot = path.join(state, 'app');
  const connectionString = development.address;
  const { cluster } = development;
  let runtime, schedules, server;
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
      rmSync(state, { recursive: true, force: true });
    })();
    return closing;
  }
  try {
    const file = path.join(customer, 'settings.json');
    const outbox = privateDirectory(path.join(customer, 'mail'), development.fresh);
    const workerState = privateDirectory(path.join(customer, 'worker-state'), development.fresh);
    const deliver = localMailbox(outbox);
    if (requestedNtasks === publicOrigin || requestedNtasks === `http://${HOST}:${cluster.loopbackPort}`) throw new Error('Ntasks needs a separate port.');
    const settings = development.fresh ? {
      format: 'noticeos-local-customer/1', publicOrigin, ntasksOrigin: requestedNtasks,
      identitySecret: randomBytes(48).toString('base64url'), credentialsKey: randomBytes(32).toString('base64'),
      workspaces: provision(cluster, publicOrigin, deliver),
    } : readSettings(file, publicOrigin, requestedNtasks);
    if (development.fresh) writeFileSync(file, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' });
    const { workspaces, ntasksOrigin, identitySecret, credentialsKey } = settings;
    await buildCustomer(state, artifactRoot);
    const artifact = readHostedArtifact(artifactRoot);
    const { assets } = JSON.parse(readFileSync(path.join(artifactRoot, artifact.tower.modulesRoot, 'wrangler.json'), 'utf8'));
    const identityDatabase = localLogin(cluster, connectionString, 'noticeos_identity');
    const grantConnectionString = localLogin(cluster, connectionString, 'noticeos_service_grant');
    execFileSync(cluster.tools.pgCtl, ['reload', '-D', path.join(cluster.root, 'data')], { stdio: 'pipe' });
    const peerProof = randomBytes(32).toString('base64url');
    const scheduleProof = randomBytes(32).toString('base64url');
    const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
    const { Miniflare, Log } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
    const bindings = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: publicOrigin,
      NOTICEOS_IDENTITY_DATABASE_URL: identityDatabase, NOTICEOS_IDENTITY_SESSION_SECRET: identitySecret,
      NOTICEOS_WORKSPACE_DATABASE_URL: connectionString };
    const outboundService = async (request, fixture) => {
      if (ntasksOrigin === null || new URL(request.url).origin !== ntasksOrigin) {
        return fixture ? fixture(request) : new Response(null, { status: 403 });
      }
      return fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        body: request.body ? await request.arrayBuffer() : undefined, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    };
    const worker = (name, entry) => ({ name, compatibilityDate: entry.compatibilityDate, compatibilityFlags: entry.compatibilityFlags,
      modulesRoot: path.join(artifactRoot, entry.modulesRoot), modules: [entry.main, ...Object.keys(artifact.files)
        .filter(file => file !== entry.main && file.startsWith(entry.modulesRoot + '/') && /\.m?js$/u.test(file))]
        .map(file => ({ type: 'ESModule', path: path.join(artifactRoot, file) })),
      outboundService: request => outboundService(request, name === 'ingest' ? fixtureProvider : undefined) });
    const tower = worker('tower', artifact.tower), ingest = worker('ingest', artifact.ingest);
    const serviceWorkspaces = workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }));
    runtime = new Miniflare({ host: HOST, port: 0, cf: { colo: 'LOCAL' }, inspectorPort: undefined,
      resourcePersistencePath: workerState,
      log: new Log(0), handleStructuredLogs: () => undefined,
      telemetry: { enabled: false }, workers: [
        { ...tower, bindings: { ...bindings, NOTICEOS_IDENTITY_EDGE: 'local-loopback', NOTICEOS_LOCAL_PEER_PROOF: peerProof,
          NOTICEOS_IDENTITY_EMAIL_FROM: MAIL_SENDER },
          assets: { directory: path.join(artifactRoot, artifact.client), binding: assets.binding, run_worker_first: assets.run_worker_first,
            routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: assets.not_found_handling } },
          serviceBindings: { INGEST: 'ingest', NOTICEOS_IDENTITY_EMAIL: 'mail',
            ...(startSchedules ? { NOTICEOS_CUSTOMER_SCHEDULES: async request => {
              const status = schedules?.status(new URL(request.url).pathname.slice(1));
              return status ? Response.json(status) : new Response(null, { status: 404 });
            } } : {}) },
          r2Buckets: { NOTICEOS_PORTFOLIO: 'customer-portfolio-summaries' } },
        { ...ingest, bindings: { ...bindings, CREDENTIALS_KEY: credentialsKey,
          NOTICEOS_SCHEDULE_GRANTS: JSON.stringify(serviceWorkspaces),
          ...(ntasksOrigin === null ? {} : { NOTICEOS_NTASKS_ORIGIN: ntasksOrigin }) },
          hyperdrives: { NOTICEOS_SCHEDULE_GRANT_DB: grantConnectionString }, r2Buckets: { RAW_SIGNALS: 'customer-raw-signals' } },
        ...(startSchedules ? [{ name: 'customer-schedule-trigger', modules: true, compatibilityDate: ingest.compatibilityDate,
          script: `export default {fetch(r,e){return r.headers.get('${SCHEDULE_HEADER}') === e.PROOF
            ? e.SCHEDULE.fetch(r) : new Response(null,{status:403})}}`, bindings: { PROOF: scheduleProof },
          serviceBindings: { SCHEDULE: { name: 'ingest', entrypoint: 'CustomerSchedule' } } }] : []),
        { name: 'mail', modules: true, compatibilityDate: '2026-07-06', script: MAIL_WORKER,
          serviceBindings: { OUTBOX: async request => {
            try { return new Response(deliver(await request.json())); }
            catch { return new Response(null, { status: 403 }); }
          } } },
      ] });
    await runtime.getWorker('tower');
    if (startSchedules) {
      const trigger = await runtime.getWorker('customer-schedule-trigger');
      const bucket = await runtime.getR2Bucket('RAW_SIGNALS', 'ingest');
      const reports = path.join(customer, 'reports');
      schedules = await startSchedules({ sourceRoot: plan.root, workspaces: serviceWorkspaces, connectionString,
        grantConnectionString, credentialsKey, reports: localCustomerReports({ sourceRoot: plan.root,
          root: privateDirectory(reports, !existsSync(reports)), bucket }), worker: {
          fetch(input, init) {
            const proof = new Request(input, init);
            proof.headers.set(SCHEDULE_HEADER, scheduleProof);
            return trigger.fetch(proof);
          },
        }, bucket });
    }
    server = customerServer(publicOrigin, runtime, peerProof);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(plan.port, HOST, () => { server.off('error', reject); resolve(); });
    });
    return Object.freeze({ publicOrigin, workspaces, outbox, whenIdle: () => schedules?.whenIdle(), close });
  } catch (error) {
    await close();
    throw error;
  }
}
