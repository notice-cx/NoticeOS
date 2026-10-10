import { createHash } from 'node:crypto';
import { D1_MAX_BYTES, cloudflareAccountId, d1DatabaseId, d1Record, d1Receipt, d1Selection, storedD1Selection, type D1Failure, type D1Receipt, type D1Request, type D1Selection, type D1Status } from '@noticeos/contract/cloudflare-d1';
import { resolveCredential, assertCredentialOwner, publishCloudflareBackup, saveCloudflareSelection, type ResolvedCredential } from './credentials.js';
import { CloudflareD1Error, d1Api, d1Bounded, listD1Databases } from './cloudflare-d1-client.js';
import { tryHealthConnection, observeIntegration } from './integration-health-context.js';
import { knownAssetIds } from './asset-registry.js';
import type { Transaction } from '@noticeos/postgres';
import { claimLease, releaseLease } from './integration-leases.js';

export class D1BackupError extends Error { constructor(readonly code: D1Failure) { super(code); } }
const EXPORT_MS = 180_000;
const MAX_BYTES = D1_MAX_BYTES;
const PART_BYTES = 8 * 1024 ** 2;
interface Pointer { latest: D1Receipt; complete: D1Receipt | null; previous: D1Receipt | null }
export interface D1Options { fetchImpl?: typeof fetch; deadlineMs?: number; pollMs?: number; maxBytes?: number; signal?: AbortSignal }
function fail(code: D1Failure): never { throw new D1BackupError(code); }
const safeFailure = (error: unknown): D1Failure => error instanceof D1BackupError ? error.code
  : error instanceof CloudflareD1Error && error.code !== 'invalid_configuration' ? error.code : 'artifact_unavailable';

async function connection(env: IngestEnv): Promise<ResolvedCredential> {
  const held = await resolveCredential(env, 'cloudflare', 'store-only');
  await assertCredentialOwner(env, held, 'cloudflare');
  if (held.source !== 'store') fail(held.connectionId ? 'unreadable_connection' : 'not_connected');
  if (!cloudflareAccountId(held.fields.CLOUDFLARE_ACCOUNT_ID) || !held.fields.CLOUDFLARE_API_TOKEN) fail('unreadable_connection');
  return held;
}
function selectionOf(held: ResolvedCredential): D1Selection | null {
  const selection = storedD1Selection(held.fields);
  if (held.fields.CLOUDFLARE_D1_TARGETS && !selection) fail('invalid_selection');
  return selection;
}
function selectedTarget(held: ResolvedCredential, accountId: string, databaseId: string) {
  if (!cloudflareAccountId(accountId) || !d1DatabaseId(databaseId)) fail('invalid_selection');
  const selection = selectionOf(held);
  if (accountId !== held.fields.CLOUDFLARE_ACCOUNT_ID || selection?.accountId !== accountId) fail('account_mismatch');
  return selection.targets.find(target => target.databaseId === databaseId) ?? fail('invalid_selection');
}
async function prefix(env: IngestEnv, account: string, database: string): Promise<string> {
  return `cloudflare-d1/${await env.STORE.workspaceId()}/${account}/${database}`;
}
function receipt(value: unknown, account: string, database: string): D1Receipt | null {
  const row = d1Receipt(value);
  return row?.accountId === account && row.databaseId === database ? row : null;
}
const leaseKey = (account: string, database: string) => `cloudflare-d1:${account}:${database}`;
/** The existing provider-coordination JSON column (`sites`) holds this module's
 * bounded receipt state. SQL owns publication; R2 contains immutable SQL only. */
async function readPointer(env: IngestEnv, account: string, database: string): Promise<Pointer | null> {
  const [held] = await env.STORE.read(tx => tx.query<{ payload: string | null }>('SELECT sites::text AS payload FROM noticeos.integration_leases WHERE lease_key = $1', [leaseKey(account, database)]));
  if (!held?.payload) return null;
  if (held.payload.length > 64 * 1024) fail('artifact_unavailable');
  let row: Record<string, unknown> | null;
  try { row = d1Record(JSON.parse(held.payload)); } catch { return fail('artifact_unavailable'); }
  const latest = receipt(row?.latest, account, database);
  if (!latest) fail('artifact_unavailable');
  const complete = row?.complete === null ? null : receipt(row?.complete, account, database);
  const previous = row?.previous === null ? null : receipt(row?.previous, account, database);
  if ((row?.complete !== null && complete?.state !== 'complete') || (row?.previous !== null && previous?.state !== 'complete')) fail('artifact_unavailable');
  return { latest, complete, previous };
}
async function writePointer(tx: Transaction, key: string, pointer: Pointer, owner: string): Promise<void> {
  const saved = await tx.execute('UPDATE noticeos.integration_leases SET sites = $1::jsonb, sites_checked_at = $2::timestamptz WHERE lease_key = $3 AND owner = $4', [JSON.stringify(pointer), new Date(), key, owner]);
  if (!saved) fail('already_running');
}
export async function d1Status(env: IngestEnv, inventory = false, options: D1Options = {}): Promise<D1Status> {
  const held = await connection(env); const selection = selectionOf(held);
  const accountId = held.fields.CLOUDFLARE_ACCOUNT_ID!;
  const databases = inventory ? await listD1Databases(held.fields, options.fetchImpl) : undefined;
  const receipts: D1Status['receipts'] = [];
  if (selection?.accountId === accountId) for (const target of selection.targets) {
    const saved = await readPointer(env, accountId, target.databaseId);
    receipts.push({ databaseId: target.databaseId, latest: saved?.latest.asset === target.asset ? saved.latest : null,
      complete: saved?.complete?.asset === target.asset ? saved.complete : null });
  }
  return { accountId, selection, accountMismatch: selection !== null && selection.accountId !== accountId, ...(databases ? { databases } : {}), receipts };
}
export async function selectD1Databases(env: IngestEnv, selection: D1Selection, options: D1Options = {}): Promise<D1Status> {
  if (!d1Selection(selection)) fail('invalid_selection');
  const held = await connection(env);
  if (selection.accountId !== held.fields.CLOUDFLARE_ACCOUNT_ID) fail('account_mismatch');
  const known = await knownAssetIds(env.STORE);
  if (selection.targets.some(target => !known.has(target.asset))) fail('invalid_selection');
  const databases = new Set((await listD1Databases(held.fields, options.fetchImpl)).map(database => database.id));
  if (selection.targets.some(target => !databases.has(target.databaseId))) fail('invalid_selection');
  if (!await saveCloudflareSelection(env, held, selection)) fail('connection_changed');
  return d1Status(env);
}

/** Downloads are confined to Cloudflare's R2 HTTPS endpoints. This is a fail-closed
 * boundary, not a claim that an unobserved provider response will use that host. */
export function d1DownloadUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) fail('unsafe_download');
  let url: URL;
  try { url = new URL(value); } catch { return fail('unsafe_download'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !/^(?:[a-z0-9][a-z0-9-]*\.)?[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(url.hostname)) fail('unsafe_download');
  return url.href;
}
async function exportUrl(held: ResolvedCredential, database: string, signal: AbortSignal, options: D1Options): Promise<string> {
  let bookmark: string | undefined;
  for (let count = 0; count < 240; count++) {
    const payload = await d1Api(held.fields.CLOUDFLARE_ACCOUNT_ID!, held.fields.CLOUDFLARE_API_TOKEN!, `/${database}/export`, {
      fetchImpl: options.fetchImpl, signal, method: 'POST', body: { output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) },
    });
    const result = d1Record(payload.result);
    if (!result || result.success === false || result.status === 'error') fail('invalid_response');
    if (result.type !== undefined && result.type !== 'export') fail('invalid_response');
    if (result.status === 'complete') return d1DownloadUrl(d1Record(result.result)?.signed_url);
    if (result.status !== 'active' || typeof result.at_bookmark !== 'string' || !result.at_bookmark || result.at_bookmark.length > 2048
      || (bookmark !== undefined && result.at_bookmark !== bookmark)) fail('invalid_response');
    bookmark = result.at_bookmark;
    // A modest poll cadence bounds provider requests; tests can select zero locally.
    if ((options.pollMs ?? 750) > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new CloudflareD1Error('timeout')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, options.pollMs ?? 750);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  return fail('timeout');
}
/** One bounded buffer per multipart part, with a streaming hash. No SQL is logged. */
async function storeExport(env: IngestEnv, key: string, url: string, signal: AbortSignal, options: D1Options) {
  if (signal.aborted) fail('timeout');
  const response = await d1Bounded((options.fetchImpl ?? fetch)(url, { redirect: 'error', signal }), signal);
  if (!response.ok || !response.body) fail('provider_unavailable');
  const max = Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > max)) {
    await d1Bounded(response.body.cancel(), AbortSignal.timeout(2000)).catch(() => undefined); fail('too_large');
  }
  const reader = response.body.getReader(); const hash = createHash('sha256');
  let upload: R2MultipartUpload | undefined; let completed = false; let bytes = 0; let filled = 0; let empty = 0;
  const buffer = new Uint8Array(PART_BYTES); const parts: R2UploadedPart[] = [];
  try {
    upload = await d1Bounded(env.RAW_SIGNALS.createMultipartUpload(key, { httpMetadata: { contentType: 'application/sql' } }), signal);
    while (true) {
      const chunk = await d1Bounded(reader.read(), signal);
      if (chunk.done) break;
      if (!chunk.value.byteLength) { if (++empty > 64) fail('invalid_response'); continue; }
      bytes += chunk.value.byteLength; if (bytes > max) fail('too_large');
      hash.update(chunk.value);
      for (let offset = 0; offset < chunk.value.byteLength;) {
        const length = Math.min(PART_BYTES - filled, chunk.value.byteLength - offset);
        buffer.set(chunk.value.subarray(offset, offset + length), filled); filled += length; offset += length;
        if (filled === PART_BYTES) {
          parts.push(await d1Bounded(upload.uploadPart(parts.length + 1, buffer), signal)); filled = 0;
        }
      }
    }
    if (!bytes || (declared !== null && bytes !== Number(declared))) fail('invalid_response');
    if (filled) parts.push(await d1Bounded(upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)), signal));
    if (signal.aborted) fail('timeout');
    await d1Bounded(upload.complete(parts), signal); completed = true;
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await d1Bounded(reader.cancel(), AbortSignal.timeout(2000)).catch(() => undefined);
    reader.releaseLock();
    if (upload && !completed) await d1Bounded(upload.abort(), AbortSignal.timeout(2000)).catch(() => undefined);
  }
}
export async function exportD1Database(env: IngestEnv, accountId: string, databaseId: string, options: D1Options = {}): Promise<D1Receipt> {
  const held = await connection(env); const target = selectedTarget(held, accountId, databaseId);
  const health = await tryHealthConnection(env, 'cloudflare', held);
  const runId = crypto.randomUUID(), start = Date.now(), key = await prefix(env, accountId, databaseId);
  const lease = leaseKey(accountId, databaseId);
  const duration = Math.min(EXPORT_MS, options.deadlineMs ?? EXPORT_MS);
  const claimed = await claimLease(env.STORE, { key: lease, owner: runId, nowMs: start, expiresAtMs: start + duration + 30_000 });
  if (!claimed) fail('already_running');
  let saved: Pointer | null = null; let initialized = false; let stored = false;
  const deadline = AbortSignal.timeout(duration);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const running: D1Receipt = { version: 1, accountId, databaseId, asset: target.asset, runId, startedAt: new Date(start).toISOString(), finishedAt: null, state: 'running', bytes: null, sha256: null, failure: null };
  try {
    saved = await readPointer(env, accountId, databaseId);
    await env.STORE.write(tx => writePointer(tx, lease, { latest: running, complete: saved?.complete ?? null, previous: saved?.previous ?? null }, runId));
    initialized = true;
    const url = await exportUrl(held, databaseId, signal, options);
    const artifact = await storeExport(env, `${key}/${runId}.sql`, url, signal, options); stored = true;
    if (signal.aborted) fail('timeout');
    const complete: D1Receipt = { ...running, ...artifact, finishedAt: new Date().toISOString(), state: 'complete' };
    const published = await publishCloudflareBackup(env, held, lease, runId, async tx => {
      if (signal.aborted) fail('timeout');
      await writePointer(tx, lease, { latest: complete, complete, previous: saved?.complete ?? null }, runId);
    });
    if (!published) fail('connection_changed');
    await observeIntegration(env, health, { capability: 'cloudflare-d1-export', asset: target.asset, target: databaseId, observedAt: complete.finishedAt!, ok: true, attemptId: runId });
    // Retain the current and previous complete SQL objects. Cleanup follows publication.
    if (saved?.previous) await d1Bounded(env.RAW_SIGNALS.delete(`${key}/${saved.previous.runId}.sql`), AbortSignal.timeout(2000)).catch(() => undefined);
    return complete;
  } catch (error) {
    const failed: D1Receipt = { ...running, state: 'failed', failure: safeFailure(error), finishedAt: new Date().toISOString() };
    // Owner-conditional SQL publication cannot erase an unreadable baseline or
    // the receipt a successor published. A failed artifact never promotes itself.
    let recorded = false;
    if (initialized) recorded = await env.STORE.write(async tx => { await writePointer(tx, lease, { latest: failed, complete: saved?.complete ?? null, previous: saved?.previous ?? null }, runId); return true; }).catch(() => false);
    await observeIntegration(env, health, { capability: 'cloudflare-d1-export', asset: target.asset, target: databaseId,
      observedAt: failed.finishedAt!, ok: false, code: failed.failure, attemptId: runId });
    if (stored && recorded) await d1Bounded(env.RAW_SIGNALS.delete(`${key}/${runId}.sql`), AbortSignal.timeout(2000)).catch(() => undefined);
    return failed;
  } finally {
    // Keep durable receipts while releasing only the owned run's active lease.
    await releaseLease(env.STORE, lease, runId);
  }
}
export async function d1Artifact(env: IngestEnv, accountId: string, databaseId: string, runId: string): Promise<Response> {
  if (!d1DatabaseId(runId)) fail('invalid_selection');
  const held = await connection(env); const target = selectedTarget(held, accountId, databaseId);
  const saved = await readPointer(env, accountId, databaseId);
  const complete = [saved?.complete, saved?.previous].find(item => item?.runId === runId && item.asset === target.asset);
  if (!complete) fail('artifact_unavailable');
  const object = await d1Bounded(env.RAW_SIGNALS.get(`${await prefix(env, accountId, databaseId)}/${runId}.sql`), AbortSignal.timeout(10_000));
  if (!object || object.size !== complete.bytes) fail('artifact_unavailable');
  return new Response(object.body, { headers: { 'content-type': 'application/sql', 'content-length': String(object.size), 'cache-control': 'no-store', 'x-noticeos-sha256': complete.sha256! } });
}
export async function handleD1Request(env: IngestEnv, selected: D1Request, signal?: AbortSignal): Promise<Response> {
  try {
    if (selected.kind === 'artifact') return await d1Artifact(env, selected.accountId, selected.databaseId, selected.runId);
    const result = selected.kind === 'select' ? await selectD1Databases(env, selected.selection)
      : selected.kind === 'export' ? await exportD1Database(env, selected.accountId, selected.databaseId, { signal })
      : await d1Status(env, selected.kind === 'databases');
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return Response.json({ error: safeFailure(error) }, { status: 409, headers: { 'cache-control': 'no-store' } }); }
}
