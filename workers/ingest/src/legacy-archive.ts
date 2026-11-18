import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { signalObjectScope, type SignalObjectScope } from './signal-objects.js';
import { boundedResponseJson } from './signal-store.js';
import { isRecord, sha256Hex } from './shared.js';

export const LEGACY_ARCHIVE_PATH = '/api/legacy-archives';
const FORMAT = 'noticeos-archive-legacy-v1';
const HEX = /^[0-9a-f]{64}$/u;
const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/u;
const PAGE_OBJECTS = 4;
const ENVELOPE_BYTES = 32 * 1024 * 1024;
const OBJECT_BYTES = 33 * 1024 * 1024;
const META_SOURCE = 'legacyArchiveSource';
const META_BYTES = 'legacyArchiveSha256';
const META_VERSION = 'legacyArchiveFormat';
const ORIGINAL_GOOGLE_REPORTS = {
  ga4: new Set(['pages-screens', 'landing-pages', 'traffic-acquisition', 'traffic-sources', 'events']),
  gsc: new Set(['page-query', 'page', 'query', 'country', 'device']),
};

type ArchiveEnv = Parameters<typeof signalObjectScope>[0] & Pick<IngestEnv, 'RAW_SIGNALS'>;
type Counts = { through: string; objects: number; bytes: number };
type Plan = Counts & { workspaceId: string; otherObjects: number; archiveBytes: number };
type Progress = Counts & { format: typeof FORMAT; workspaceId: string; cursor: string; verified: number; copiedBytes: number; complete: boolean };

export class LegacyArchiveRefusal extends Error {}

const legacy = `(o.object_key LIKE 'raw/%' OR o.object_key LIKE 'signals/%')`;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function archivePreparation(value: unknown, workspaceId: string): Counts | null {
  if (!isRecord(value) || value.workspaceId !== workspaceId
    || typeof value.through !== 'string' || !SEQUENCE.test(value.through)
    || !nonnegative(value.objects) || !nonnegative(value.bytes) || value.objects === 0 || value.bytes === 0) return null;
  return { through: value.through, objects: value.objects, bytes: value.bytes };
}

function parseProgress(value: unknown, workspaceId: string): Progress {
  if (!isRecord(value) || value.format !== FORMAT || value.workspaceId !== workspaceId
    || typeof value.through !== 'string' || !SEQUENCE.test(value.through) || typeof value.cursor !== 'string' || !SEQUENCE.test(value.cursor)
    || BigInt(value.cursor) > BigInt(value.through) || !nonnegative(value.objects) || !nonnegative(value.bytes)
    || !nonnegative(value.verified) || value.verified > value.objects || !nonnegative(value.copiedBytes) || value.copiedBytes > value.bytes
    || typeof value.complete !== 'boolean' || (value.complete && (value.cursor !== value.through || value.verified !== value.objects || value.copiedBytes !== value.bytes))) {
    throw new LegacyArchiveRefusal('Legacy archive progress is invalid.');
  }
  return { format: FORMAT, workspaceId, through: value.through, cursor: value.cursor, objects: value.objects,
    bytes: value.bytes, verified: value.verified, copiedBytes: value.copiedBytes, complete: value.complete };
}

async function progress(bucket: R2Bucket, scope: SignalObjectScope) {
  const object = await bucket.get(scope.legacyArchiveReceipt);
  if (object === null) return null;
  const value = parseProgress(await boundedResponseJson(new Response(object.body), 'Legacy archive progress', 2048), scope.workspaceId);
  return { value, etag: object.etag };
}

/** The reader consults the receipt only for historical locators in its own manifest. */
export async function legacyArchiveThrough(env: ArchiveEnv, scope: SignalObjectScope): Promise<bigint | null> {
  if (workspaceProfile(env) !== 'hosted') return null;
  const current = await progress(env.RAW_SIGNALS, scope);
  return current?.value.complete ? BigInt(current.value.through) : null;
}

export function matchesLegacyArchiveCopy(object: R2Object, workspaceId: string, sourceKey: string, hash: string): boolean {
  const meta = object.customMetadata;
  return meta?.[META_VERSION] === FORMAT && meta.workspaceId === workspaceId && meta[META_SOURCE] === sourceKey
    && meta.contentSha256 === hash && HEX.test(meta[META_BYTES] ?? '');
}

async function estimateLegacyArchives(env: ArchiveEnv, scope: SignalObjectScope): Promise<Plan> {
  const [row] = await env.STORE.read(tx => tx.query<{
    through: string; objects: string; bytes: string; other_objects: string; archive_bytes: string;
  }>(`SELECT coalesce(max(o.object_seq) FILTER (WHERE ${legacy}),0)::text AS through,
      count(*) FILTER (WHERE ${legacy})::text AS objects, coalesce(sum(o.object_bytes) FILTER (WHERE ${legacy}),0)::text AS bytes,
      count(*) FILTER (WHERE NOT ${legacy} AND NOT starts_with(o.object_key,$1))::text AS other_objects,
      coalesce(sum(o.object_bytes),0)::text AS archive_bytes FROM noticeos.archive_objects o`, [`workspaces/${scope.workspaceId}/raw/`]));
  if (!row || !SEQUENCE.test(row.through)) throw new LegacyArchiveRefusal('Legacy archive inventory is unavailable.');
  const numbers = [row.objects, row.bytes, row.other_objects, row.archive_bytes].map(Number);
  if (!numbers.every(nonnegative)) throw new LegacyArchiveRefusal('Legacy archive inventory is too large.');
  return { workspaceId: scope.workspaceId, through: row.through, objects: numbers[0]!, bytes: numbers[1]!,
    otherObjects: numbers[2]!, archiveBytes: numbers[3]! };
}

function sameInventory(a: Counts, b: Counts): boolean {
  return a.through === b.through && a.objects === b.objects && a.bytes === b.bytes;
}

export async function legacyArchivePlan(env: ArchiveEnv, scope: SignalObjectScope) {
  const plan = await estimateLegacyArchives(env, scope);
  const receipt = plan.objects ? (await progress(env.RAW_SIGNALS, scope))?.value : undefined;
  if (receipt && !sameInventory(plan, receipt)) throw new LegacyArchiveRefusal('The archive inventory differs from the saved copy progress.');
  let stagedObjects = 0;
  let stagedBytes = 0;
  if (plan.objects && !plan.otherObjects && !receipt?.complete) {
    // A failed page can leave destinations only in the next bounded page.
    // Their storage is spent even though only preparation can verify them.
    const rows = await archivePage(env, receipt?.cursor ?? '0', plan.through);
    for (const row of rows) {
      const key = scope.legacyArchiveCopy(row.key);
      const existing = key ? await env.RAW_SIGNALS.head(key) : null;
      if (existing && existing.size === Number(row.bytes) && matchesLegacyArchiveCopy(existing, scope.workspaceId, row.key, row.hash)) {
        stagedObjects++;
        stagedBytes += existing.size;
      }
    }
  }
  return { ...plan, verified: receipt?.verified ?? 0, copiedBytes: receipt?.copiedBytes ?? 0,
    stagedObjects, stagedBytes, complete: !plan.otherObjects && (plan.objects === 0 || receipt?.complete === true) };
}

type ArchiveRow = {
  seq: string; key: string; hash: string; bytes: string;
  asset: string | null; integration: string | null; report: string | null; date: string | null;
  credential: string | null; property: string | null; version: number | null;
};

async function archivePage(env: ArchiveEnv, cursor: string, through: string): Promise<ArchiveRow[]> {
  const rows = await env.STORE.read(tx => tx.query<ArchiveRow>(
    `SELECT o.object_seq::text AS seq,o.object_key AS key,o.content_sha256 AS hash,o.object_bytes::text AS bytes,
       r.asset_id AS asset,r.integration,r.report,r.report_date::text AS date,r.credential_ref AS credential,r.property_ref AS property,r.schema_version AS version
     FROM noticeos.archive_objects o
     LEFT JOIN LATERAL (SELECT asset_id,integration,report,report_date,credential_ref,property_ref,schema_version
       FROM noticeos.archive_runs WHERE workspace_id=o.workspace_id AND object_seq=o.object_seq ORDER BY run_seq LIMIT 1) r ON true
     WHERE ${legacy} AND o.object_seq>$1::bigint AND o.object_seq<=$2::bigint
     ORDER BY o.object_seq LIMIT ${PAGE_OBJECTS}`, [cursor, through]));
  const page: ArchiveRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Number(row.bytes);
    if (page.length && bytes + size > OBJECT_BYTES) break;
    page.push(row);
    bytes += size;
  }
  return page;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalPages(row: ArchiveRow, pages: unknown[]): unknown[] {
  const journey = row.integration === 'ga4' && row.report?.startsWith('journeys-');
  if (row.integration !== 'posthog' && !journey) return pages;
  const first: unknown = pages[0];
  if (!isRecord(first) || !isRecord(first.response)) throw new LegacyArchiveRefusal('The legacy archive has no provider report.');
  // Both writers omit collection time, and the GA4 funnel hash uses only its
  // first response without the provider's quota reading.
  const { collectedAt: _collectedAt, ...response } = first.response;
  if (journey) delete response.propertyQuota;
  return [{ request: first.request, response }];
}

function originalGoogleMetadata(row: ArchiveRow, meta: R2Object['customMetadata']): boolean {
  return (row.integration === 'ga4' || row.integration === 'gsc') && row.version === 1
    && row.report !== null && ORIGINAL_GOOGLE_REPORTS[row.integration].has(row.report)
    && meta !== undefined && Object.keys(meta).length === 6
    && meta.asset === row.asset && meta.contentSha256 === row.hash && meta.integration === row.integration
    && meta.report === row.report && meta.reportDate === row.date && meta.schemaVersion === '1';
}

async function originalBytes(object: R2ObjectBody, row: ArchiveRow, workspaceId: string): Promise<ArrayBuffer> {
  const meta = object.customMetadata;
  const size = Number(row.bytes);
  if (object.size !== size || (meta?.workspaceId && meta.workspaceId !== workspaceId)
    || (meta?.contentSha256 && meta.contentSha256 !== row.hash)) {
    await object.body.cancel();
    throw new LegacyArchiveRefusal('The saved legacy archive differs from its manifest.');
  }
  const compressed = await object.arrayBuffer();
  if (compressed.byteLength !== size) throw new LegacyArchiveRefusal('The saved legacy archive size changed.');
  const content = await boundedResponseJson(new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))),
    'Legacy archive', ENVELOPE_BYTES);
  if (!isRecord(content) || content.asset !== row.asset || content.integration !== row.integration || content.report !== row.report
    || content.reportDate !== row.date || content.schemaVersion !== row.version || content.credentialRef !== row.credential
    || content.propertyRef !== row.property || !Array.isArray(content.pages)) throw new LegacyArchiveRefusal('The legacy archive belongs to a different report.');
  const { schemaVersion, provider, integration, report, asset, credentialRef, propertyRef, reportDate, dataState,
    providerRows, providerTruncated, pages } = content;
  const canonical = { schemaVersion, provider, integration, report, asset, credentialRef, propertyRef,
    reportDate, dataState, providerRows, providerTruncated, pages: canonicalPages(row, pages) };
  if (await sha256Hex(JSON.stringify(canonical)) === row.hash) return compressed;
  if (provider === 'google' && originalGoogleMetadata(row, meta)) {
    // The initial Google digest omitted the credential field. Its body still
    // has to match the credential and property in the selected SQL receipt.
    const { credentialRef: _credentialRef, ...original } = canonical;
    if (await sha256Hex(JSON.stringify(original)) === row.hash) return compressed;
  }
  throw new LegacyArchiveRefusal('The legacy archive content hash does not match.');
}

async function copyOne(bucket: R2Bucket, scope: SignalObjectScope, row: ArchiveRow): Promise<void> {
  const key = scope.legacyArchiveCopy(row.key);
  const size = Number(row.bytes);
  if (!key || !HEX.test(row.hash) || !nonnegative(size) || size === 0 || size > OBJECT_BYTES || row.asset === null) {
    throw new LegacyArchiveRefusal('The legacy locator has no supported archive receipt.');
  }
  const object = await bucket.get(row.key);
  if (!object) throw new LegacyArchiveRefusal('A legacy archive object is missing.');
  const bytes = await originalBytes(object, row, scope.workspaceId);
  const checksum = await digest(bytes);
  let stored = await bucket.get(key);
  if (!stored) {
    await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: object.httpMetadata, customMetadata: {
      ...object.customMetadata, workspaceId: scope.workspaceId, contentSha256: row.hash,
      [META_VERSION]: FORMAT, [META_SOURCE]: row.key, [META_BYTES]: checksum,
    } });
    stored = await bucket.get(key);
  }
  if (!stored || stored.size !== size || !matchesLegacyArchiveCopy(stored, scope.workspaceId, row.key, row.hash)
    || stored.customMetadata?.[META_BYTES] !== checksum) {
    await stored?.body.cancel();
    throw new LegacyArchiveRefusal('The workspace archive destination conflicts.');
  }
  if (await digest(await stored.arrayBuffer()) !== checksum) throw new LegacyArchiveRefusal('The workspace archive copy failed verification.');
}

/** Advance one bounded page. A receipt advances only after its copies verify.
 * Immutable destinations make a lost response or a competing retry harmless. */
export async function prepareLegacyArchives(env: ArchiveEnv, scope: SignalObjectScope, expected: Counts): Promise<Progress> {
  const bucket = env.RAW_SIGNALS;
  const before = await progress(bucket, scope);
  let current = before?.value;
  if (!current) {
    const plan = await estimateLegacyArchives(env, scope);
    if (plan.otherObjects || !sameInventory(plan, expected)) {
      throw new LegacyArchiveRefusal('The archive inventory changed or includes unrecognized keys.');
    }
    current = { format: FORMAT, workspaceId: scope.workspaceId, through: plan.through, objects: plan.objects, bytes: plan.bytes,
      cursor: '0', verified: 0, copiedBytes: 0, complete: false };
  }
  if (!sameInventory(current, expected)) {
    throw new LegacyArchiveRefusal('The requested inventory differs from the saved copy progress.');
  }
  if (current.complete) return current;
  const rows = await archivePage(env, current.cursor, current.through);
  const next = { ...current };
  for (const row of rows) {
    await copyOne(bucket, scope, row);
    next.cursor = row.seq;
    next.verified++;
    next.copiedBytes += Number(row.bytes);
  }
  if (next.verified === next.objects) {
    const final = await estimateLegacyArchives(env, scope);
    if (next.cursor !== next.through || next.copiedBytes !== next.bytes || final.otherObjects || !sameInventory(final, next)) {
      throw new LegacyArchiveRefusal('The archive inventory changed during preparation.');
    }
    next.complete = true;
  } else if (next.cursor === current.cursor) throw new LegacyArchiveRefusal('The archive inventory is incomplete.');
  parseProgress(next, scope.workspaceId);
  const stored = await bucket.put(scope.legacyArchiveReceipt, JSON.stringify(next), {
    onlyIf: before ? { etagMatches: before.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!stored) throw new LegacyArchiveRefusal('Another archive preparation advanced this workspace.');
  return next;
}
