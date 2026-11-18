import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { cloudflareAccountId, storedD1Selection, CLOUDFLARE_D1_TARGETS } from '../packages/contract/src/cloudflare-d1.mjs';
import { containerBackupStatus, requestContainerBackup } from './container-backup-channel.mjs';
import { ntasksBackupAccess, ntasksBackupCredential, ntasksEndpoint, NTASKS_BACKUP_SCOPE_QUERY } from './ntasks-backup-access.mjs';
import { takeNtasksExport } from './ntasks-backup.mjs';
import { unsealCredential } from './sealed-credential.mjs';

export const CUSTOMER_BACKUP_PATH = '/_noticeos/backup';
export const CUSTOMER_BACKUP_CLIENT = '/state/backup-client.json';
export const CUSTOMER_BACKUP_EFFECT_MS = 900_000;
const EXPORT_MS = 180_000;
const REQUEST_MS = 10_000;
const WAKE_MS = 60_000;
const FAIL_TASKS = Object.freeze({ ok: false, stage: 'taskHub', cause: 'stage_failed' });
const FAIL_WORKER = Object.freeze({ ok: false, stage: 'preparation', cause: 'worker_unavailable' });
const BUSY = Object.freeze({ ok: false, stage: 'preparation', cause: 'worker_busy' });

async function readJson(response, limit, signal) {
  if (!response.body) throw new Error('Empty Ntasks response.');
  const buffers = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Ntasks response is too large.');
    buffers.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers, bytes)));
}

export function customerBackupBearer(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || !token.trim()) return false;
  const actual = Buffer.from(header);
  const wanted = Buffer.from(`Bearer ${token.trim()}`);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function createCustomerBackup({ address, workspaceId, credentialsKey, ntasksOrigin, client, staging,
  fetchImpl = fetch, requestBackup = requestContainerBackup, backupStatus = containerBackupStatus }) {
  let active = false, healthy = false;
  let revision;

  async function readConnection(provider) {
    const store = openWorkspaceStore(address, { workspaceId, maxConnections: 1 });
    try {
      const rows = await store.read(tx => tx.query(`SELECT c.connection_id, s.secret_version,
          CASE WHEN octet_length(s.ciphertext) <= 65552 THEN s.ciphertext END AS ciphertext, s.iv
        FROM noticeos.integration_connections c LEFT JOIN LATERAL (
          SELECT secret_version, ciphertext, iv FROM noticeos.connection_secrets
          WHERE workspace_id=c.workspace_id AND connection_id=c.connection_id
          ORDER BY secret_version DESC LIMIT 1
        ) s ON true WHERE c.workspace_id=$1::uuid AND c.provider=$2`, [workspaceId, provider]));
      if (rows.length > 1) throw new Error('Ambiguous connection.');
      return rows[0] ?? null;
    } finally { await store.close(); }
  }

  async function fields(row) {
    const key = Uint8Array.from(Buffer.from(credentialsKey, 'base64'));
    if (key.length !== 32 || row?.iv?.length !== 12 || !row.ciphertext || !Number.isInteger(row.secret_version)) throw new Error('Unreadable connection.');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await unsealCredential(key, row.iv, row.ciphertext)));
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(field => typeof field !== 'string')) {
      throw new Error('Unreadable connection.');
    }
    return value;
  }

  async function taskSource(signal) {
    const row = await readConnection('ntasks');
    if (!row && !ntasksOrigin) return { row: null, service: null };
    const held = await fields(row);
    const credential = ntasksBackupCredential(held);
    if (!credential || !ntasksOrigin || ntasksEndpoint(held.NTASKS_URL)?.origin !== ntasksOrigin) throw new Error('Missing independent backup scope.');
    const call = async (pathname, body) => {
      const stop = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
      stop.throwIfAborted();
      const response = await fetchImpl(`${ntasksOrigin}${pathname}`, { method: body ? 'POST' : 'GET',
        redirect: 'error', signal: stop, headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json',
          'x-ntasks-workspace': credential.workspaceId, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
      if (response.status === 200) {
        return { status: 200, body: await readJson(response, body ? 65536 : 8 * 1024 * 1024, stop) };
      }
      let value;
      try { value = await readJson(response, 65536, stop); } catch { /* The status is already a failure. */ }
      const error = value?.error;
      return { status: response.status, body: ['insufficient_scope', 'store_changed'].includes(error) ? { error } : null };
    };
    const access = await call('/api/mcp', NTASKS_BACKUP_SCOPE_QUERY);
    if (!ntasksBackupAccess(access.status, access.body, credential.workspaceId)) throw new Error('Unproven backup scope.');
    return { row, service: { call: ({ path }) => call(path) } };
  }

  async function inventory() {
    const row = await readConnection('cloudflare');
    if (!row) return null;
    const held = await fields(row);
    const accountId = held.CLOUDFLARE_ACCOUNT_ID;
    const selection = storedD1Selection(held);
    if (!cloudflareAccountId(accountId) || !held.CLOUDFLARE_API_TOKEN
      || (Object.hasOwn(held, CLOUDFLARE_D1_TARGETS) && (!selection || selection.accountId !== accountId))) {
      throw new Error('Unreadable Cloudflare backup selection.');
    }
    return selection ?? { version: 1, accountId, targets: [] };
  }

  function taskRevision(row) {
    return row === null ? null : `${row.connection_id}/${row.secret_version}`;
  }

  return {
    healthy: () => healthy,
    async check(signal = AbortSignal.timeout(WAKE_MS)) {
      healthy = false;
      try {
        if (!(await backupStatus(client)).available) return 'The configured backup worker is unavailable.';
        const source = await taskSource(signal);
        if (source.service) {
          const page = await source.service.call({ path: '/api/backup' });
          if (page.status !== 200 || page.body?.format !== 'ntasks-backup-v1') throw new Error('Backup route unavailable.');
        }
      } catch { return 'Verify the saved workspace connection and its separate backup-only Ntasks credential.'; }
      try {
        await inventory();
      } catch { return 'Verify the saved Cloudflare connection and backup selection.'; }
      healthy = true;
      return null;
    },
    inventory,
    async sameTaskRevision() {
      // Inventory is checked twice by the worker. The late check keeps a
      // reconnected task store out of a set whose Postgres dump may name it.
      try { return revision !== undefined && revision === taskRevision(await readConnection('ntasks')); }
      catch { return false; }
    },
    async run(signal) {
      if (active) return BUSY;
      active = true;
      let exported;
      try {
        if (!(await backupStatus(client)).available) { healthy = false; return FAIL_WORKER; }
        const exportSignal = AbortSignal.any([signal, AbortSignal.timeout(EXPORT_MS)]);
        let source;
        try {
          source = await taskSource(exportSignal);
          if (source.service) {
            exported = await takeNtasksExport(source.service, staging);
            if (!exported.file) throw new Error('Incomplete Ntasks export.');
          }
          const latest = await readConnection('ntasks');
          if (taskRevision(latest) !== taskRevision(source.row)) {
            throw new Error('Connection changed during export.');
          }
          exportSignal.throwIfAborted();
          revision = taskRevision(source.row);
        } catch { healthy = false; return FAIL_TASKS; }
        const result = await requestBackup(client, { customer: true, signal, ...(source.service ? { tasks: 'ntasks', tasksExport: exported.file } : {}) });
        healthy = result.ok;
        const { ok, stage, cause, backup } = result;
        return { ok, ...(stage ? { stage, cause } : {}), ...(backup ? { backup } : {}),
          ...(result.unconfirmed || cause === 'worker_timeout' ? { unconfirmed: true } : {}) };
      } catch { healthy = false; return FAIL_WORKER; }
      finally {
        try { if (exported?.dir) await rm(exported.dir, { recursive: true, force: true }); }
        finally { revision = undefined; active = false; }
      }
    },
  };
}
