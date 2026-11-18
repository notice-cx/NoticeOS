import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { cloudflareAccountId, storedD1Selection, CLOUDFLARE_D1_TARGETS } from '../packages/contract/src/cloudflare-d1.mjs';
import { containerBackupStatus, requestContainerBackup } from './container-backup-channel.mjs';
import { ntasksBackupAccess, ntasksBackupCredential, ntasksEndpoint, NTASKS_BACKUP_SCOPE_QUERY } from './ntasks-backup-access.mjs';
import { takeNtasksExport } from './ntasks-backup.mjs';
import { readCustomerConnection, customerCredentialFields } from './customer-stored-connection.mjs';

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

  async function taskSource(signal) {
    const row = await readCustomerConnection({ address, workspaceId }, 'ntasks');
    if (!row && !ntasksOrigin) return { row: null, service: null };
    const held = await customerCredentialFields(row, credentialsKey);
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
    const row = await readCustomerConnection({ address, workspaceId }, 'cloudflare');
    if (!row) return null;
    const held = await customerCredentialFields(row, credentialsKey);
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
      try { return revision !== undefined && revision === taskRevision(await readCustomerConnection({ address, workspaceId }, 'ntasks')); }
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
          const latest = await readCustomerConnection({ address, workspaceId }, 'ntasks');
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
