// The host copies SQL through its own authenticated Worker. Provider credentials
// and signed download URLs stay inside that Worker; this client selects no origin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BACKUP_APP_ORIGIN, privateBackupFile } from './container-backup-profile.mjs';
import { doorFromEnv } from './ingest-door.mjs';
import { CLOUDFLARE_D1_BACKUP_PATH, D1_MAX_BYTES, cloudflareAccountId, d1Record, d1Receipt, d1Selection } from '../packages/contract/src/cloudflare-d1.mjs';

class Unavailable extends Error {}
class TimedOut extends Error {}
// A reason is built only from fixed words, an HTTP status, an error code or
// the app's own error token, so a refusal never carries response or error text.
const unavailable = reason => new Unavailable(`Cloudflare D1 backup unavailable (${reason}); the previous complete set is preserved.`);
const refuse = reason => { throw unavailable(reason); };
const errorToken = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(value) ? value : null;
function unreachable(error) {
  if (error instanceof Unavailable) throw error;
  if (error instanceof TimedOut) refuse('the app did not answer in time');
  const code = error?.cause?.code ?? error?.code;
  refuse(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/u.test(code) ? `the app could not be reached: ${code}` : 'the app could not be reached');
}
async function bounded(promise, signal) {
  if (signal.aborted) { void promise.catch(() => undefined); refuse('the time limit had already passed'); }
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(new TimedOut('Cloudflare D1 backup timed out.')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function cancel(body) {
  if (body) await bounded(body.cancel(), AbortSignal.timeout(2000)).catch(() => undefined);
}
async function* sqlChunks(reader, signal) {
  while (true) {
    const next = await bounded(reader.read(), signal);
    if (next.done) return;
    yield next.value;
  }
}
async function jsonResponse(response, signal) {
  if (!response.body) refuse('the reply had no body');
  const reader = response.body.getReader(); let bytes = 0; let empty = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await bounded(reader.read(), signal);
      if (next.done) break;
      if (!next.value.byteLength && ++empty > 64) refuse('the reply sent only empty chunks');
      bytes += next.value.byteLength; if (bytes > 1024 * 1024) refuse('the reply was too large');
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await bounded(reader.cancel(), AbortSignal.timeout(2000)).catch(() => undefined); reader.releaseLock(); }
}

/** Only the selected installation's loopback door, or the protected Compose
 * worker's fixed app service, may receive the bootstrap bearer. */
export function createCloudflareD1BackupClient({ repoRoot, transport, env = process.env, fetchImpl = fetch,
  readBootstrap = file => JSON.parse(privateBackupFile(file).text), requestMs = 240_000 } = {}) {
  if (!path.isAbsolute(repoRoot ?? '') || (transport !== undefined && transport !== 'container')
    || !Number.isFinite(requestMs) || requestMs < 1 || requestMs > 240_000) refuse('the backup client settings are invalid');
  const origin = new URL(transport === 'container' ? BACKUP_APP_ORIGIN : doorFromEnv(env));
  if (transport === 'container' ? repoRoot !== '/state' || origin.origin !== BACKUP_APP_ORIGIN
    : origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) refuse('the app address is not allowed');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) refuse('the app address is not allowed');
  let bearer;
  const token = () => {
    if (bearer === undefined) {
      let value;
      try { value = readBootstrap(path.join(repoRoot, 'workers/ingest/.dev.secrets.json')).OPERATOR_TOKEN; }
      catch { refuse('the app access token could not be read'); }
      if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n]/u.test(value)) refuse('the app access token could not be read');
      bearer = value.trim();
    }
    return bearer;
  };
  async function request(query = {}, body, outerSignal) {
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(requestMs)]) : AbortSignal.timeout(requestMs);
    if (signal.aborted) refuse('the time limit had already passed');
    const url = new URL(CLOUDFLARE_D1_BACKUP_PATH, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return bounded(fetchImpl(url.href, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }), signal);
  }
  return {
    async inventory() {
      const signal = AbortSignal.timeout(requestMs);
      let response, row;
      try { response = await request({}, undefined, signal); }
      catch (error) { unreachable(error); }
      try { row = d1Record(await jsonResponse(response, signal)); }
      catch { refuse(`the app answered ${response.status} without a selection`); }
      if (response.status === 409 && row?.error === 'not_connected' && Object.keys(row).length === 1) return null;
      if (!response.ok) refuse(`the app answered ${response.status}${errorToken(row?.error) ? ` ${errorToken(row.error)}` : ''}`);
      if (row?.accountMismatch === true) refuse('the saved selection names another Cloudflare account');
      if (!row || !cloudflareAccountId(row.accountId) || row.accountMismatch !== false || !Array.isArray(row.receipts)) refuse('the app answered an unreadable selection');
      const selection = row.selection === null ? { version: 1, accountId: row.accountId, targets: [] } : d1Selection(row.selection);
      if (!selection || selection.accountId !== row.accountId) refuse('the app answered an unreadable selection');
      return selection;
    },
    async exportTarget(selection, target, signal) {
      const checked = d1Selection(selection);
      if (!checked || !checked.targets.some(item => item.databaseId === target.databaseId && item.asset === target.asset)) refuse('the target is not in the saved selection');
      const bounds = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestMs)]) : AbortSignal.timeout(requestMs);
      let response, value;
      try { response = await request({}, { accountId: checked.accountId, databaseId: target.databaseId }, bounds); }
      catch (error) { unreachable(error); }
      try { value = await jsonResponse(response, bounds); }
      catch { refuse(`the export answered ${response.status} without a receipt`); }
      if (!response.ok) refuse(`the export answered ${response.status}${errorToken(value?.error) ? ` ${errorToken(value.error)}` : ''}`);
      const receipt = d1Receipt(value);
      if (receipt && receipt.state !== 'complete') refuse(`the export ended ${receipt.state}${errorToken(receipt.failure) ? ` ${errorToken(receipt.failure)}` : ''}`);
      if (!receipt || receipt.accountId !== checked.accountId || receipt.databaseId !== target.databaseId || receipt.asset !== target.asset) {
        refuse('the export answered a receipt for another target');
      }
      return receipt;
    },
    async artifact(receipt, signal) {
      const checked = d1Receipt(receipt); if (checked?.state !== 'complete') refuse('the receipt is not complete');
      let response;
      try { response = await request({ view: 'artifact', accountId: checked.accountId, databaseId: checked.databaseId, runId: checked.runId }, undefined, signal); }
      catch (error) { unreachable(error); }
      // The Workers runtime sends this reply chunked, without content-length.
      // copyCloudflareD1 checks the streamed bytes and SHA-256 against the receipt.
      const length = response.headers.get('content-length');
      const reason = !response.ok ? `the download answered ${response.status}`
        : !response.body ? 'the download had no body'
        : length !== null && length !== String(checked.bytes) ? 'the download length header differs from its receipt'
        : response.headers.get('x-noticeos-sha256') !== checked.sha256 ? 'the download hash header differs from its receipt'
        : response.headers.has('content-encoding') ? 'the download arrived encoded'
        : null;
      if (reason !== null) { await cancel(response.body); refuse(reason); }
      return response;
    },
  };
}

export function cloudflareD1InventoryKey(value) {
  if (value === null) return 'not_connected';
  const selection = d1Selection(value); if (!selection) refuse('the app answered an unreadable selection');
  return JSON.stringify({ ...selection, targets: [...selection.targets].sort((a, b) => a.databaseId.localeCompare(b.databaseId)) });
}

/** Stream straight into gzip. The verified receipt and compressed hash are
 * written last, so a partial SQL stream cannot become a complete backup item. */
export async function copyCloudflareD1({ client, selection, target, output, io = fs, deadlineMs = 240_000 }) {
  const signal = AbortSignal.timeout(Math.min(240_000, deadlineMs)); let response; let handle; let reader;
  try {
    const receipt = await bounded(client.exportTarget(selection, target, signal), signal);
    const checked = d1Receipt(receipt);
    if (checked?.state !== 'complete' || checked.accountId !== selection.accountId || checked.databaseId !== target.databaseId || checked.asset !== target.asset) refuse('the export answered a receipt for another target');
    response = await bounded(client.artifact(checked, signal), signal);
    if (!response.body) refuse('the download had no body');
    reader = response.body.getReader();
    await io.mkdir(output, { recursive: true, mode: 0o700 });
    const sqlHash = createHash('sha256'), compressedHash = createHash('sha256'); let bytes = 0, compressedBytes = 0;
    const meter = new Transform({ transform(chunk, _, callback) {
      bytes += chunk.length;
      if (bytes > D1_MAX_BYTES || bytes > checked.bytes) { callback(unavailable('the download is longer than its receipt')); return; }
      sqlHash.update(chunk); callback(null, chunk);
    } });
    const compressedMeter = new Transform({ transform(chunk, _, callback) { compressedBytes += chunk.length; compressedHash.update(chunk); callback(null, chunk); } });
    handle = await io.open(path.join(output, 'export.sql.gz'), 'wx', 0o600);
    // fromWeb waits for an upstream cancel promise during destruction. Own the
    // reader instead: pending reads follow the deadline; teardown gets 2s.
    await pipeline(Readable.from(sqlChunks(reader, signal), { objectMode: false }), meter, createGzip(), compressedMeter, handle.createWriteStream(), { signal });
    if (!bytes) refuse('the download was empty');
    if (bytes !== checked.bytes) refuse('the download is shorter than its receipt');
    if (sqlHash.digest('hex') !== checked.sha256) refuse('the download hash differs from its receipt');
    if (!compressedBytes) refuse('the compressed copy was empty');
    const custody = { format: 'noticeos-cloudflare-d1-backup-v1', receipt: checked,
      gzip: { file: 'export.sql.gz', bytes: compressedBytes, sha256: compressedHash.digest('hex') },
      restore: { documentation: 'https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/',
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${checked.accountId}/d1/database/${checked.databaseId}/import` } };
    await io.writeFile(path.join(output, 'receipt.json'), JSON.stringify(custody, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return custody;
  } catch (error) {
    if (error instanceof Unavailable) throw error;
    const code = error?.code;
    refuse(error instanceof TimedOut ? 'the export did not finish in time'
      : typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/u.test(code) ? `the copy failed: ${code}` : 'the copy failed');
  }
  finally {
    try { await handle?.close(); }
    finally {
      if (reader) {
        await bounded(reader.cancel(), AbortSignal.timeout(2000)).catch(() => undefined);
        reader.releaseLock();
      } else await cancel(response?.body);
    }
  }
}
