import type { WorkspaceStore } from '@noticeos/postgres';
import type { PortfolioSummaryVersion, WallPayload } from '../shared/wall';
import { revenueCalendarDate } from '../shared/daily-revenue';
import { loadPropertyHistories, summarizePropertyHistory } from './property-history';
import { buildWallPayload, type BuildOptions } from './wall-payload';

export const PORTFOLIO_HISTORY_DAYS = 28;
const MAX_BYTES = 4 * 1024 * 1024;
const SCHEMA = 1;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const VERSION = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface PortfolioSummaryBucket {
  get(key: string): Promise<{
    size: number;
    etag: string;
    body: { cancel(): Promise<void> };
    text(): Promise<string>;
  } | null>;
  put(key: string, body: string, options: {
    onlyIf: { etagMatches: string } | Headers;
    httpMetadata: { contentType: string };
  }): Promise<{ etag: string } | null>;
}

export interface PortfolioSummaryStore {
  readonly bucket: PortfolioSummaryBucket;
  /** The workspace from the current evidence-read admission. */
  readonly workspaceId: string;
  readonly readOnly: boolean;
}

interface Snapshot {
  schema: typeof SCHEMA;
  workspaceId: string;
  version: PortfolioSummaryVersion;
  wall: WallPayload;
  propertyHistory: [string, ReturnType<typeof summarizePropertyHistory>][];
}

interface Stored {
  etag: string;
  snapshot: Snapshot | null;
}

export function portfolioSummaryStore(bucket: PortfolioSummaryBucket | undefined, workspaceId: string, readOnly = false): PortfolioSummaryStore | undefined {
  return bucket ? { bucket, workspaceId, readOnly } : undefined;
}

async function readStored(bucket: PortfolioSummaryStore['bucket'], key: string, workspaceId: string): Promise<Stored | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_BYTES) {
    await object.body.cancel();
    return { etag: object.etag, snapshot: null };
  }
  let snapshot: Partial<Snapshot> | null;
  try { snapshot = JSON.parse(await object.text()) as Partial<Snapshot> | null; } catch { snapshot = null; }
  const valid = snapshot?.schema === SCHEMA && snapshot.workspaceId === workspaceId
    && snapshot.version && VERSION.test(snapshot.version.version) && DATE.test(snapshot.version.reportingDate)
    && typeof snapshot.wall?.generatedAt === 'string' && Number.isFinite(Date.parse(snapshot.wall.generatedAt))
    && Array.isArray(snapshot.wall.assets) && Array.isArray(snapshot.wall.attention)
    && Array.isArray(snapshot.propertyHistory)
    && snapshot.propertyHistory.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string');
  return { etag: object.etag, snapshot: valid ? snapshot as Snapshot : null };
}

function result(snapshot: Snapshot, retained = false) {
  return {
    wall: { ...snapshot.wall, portfolioSummary: { ...snapshot.version, retained } },
    histories: new Map(snapshot.propertyHistory),
  };
}

/** Both callers build from stored evidence. The private object is an atomic
 * publication of a complete read, and is never an authorization decision. */
export async function readPortfolioSummary(store: WorkspaceStore, saved: PortfolioSummaryStore, options: BuildOptions) {
  const { bucket, workspaceId } = saved;
  if (!UUID.test(workspaceId) || await store.workspaceId() !== workspaceId) throw new Error('Portfolio workspace is unavailable.');
  const key = `workspaces/${workspaceId}/portfolio/summary-v1.json`;
  // Undefined means the bucket was unavailable. A failed read is insufficient
  // evidence to overwrite an object, even when the source data is readable.
  let current = await readStored(bucket, key, workspaceId).catch(() => undefined);
  let candidate: Snapshot;
  let body: string;
  try {
    const [wallRead, historyRead] = await Promise.allSettled([
      buildWallPayload(store, options),
      loadPropertyHistories(store, { now: options.now, days: PORTFOLIO_HISTORY_DAYS, months: 0, osTimeZone: options.osTimeZone }),
    ]);
    if (wallRead.status === 'rejected') throw wallRead.reason;
    if (historyRead.status === 'rejected') throw historyRead.reason;
    const wall = wallRead.value;
    const propertyHistory = historyRead.value;
    const histories: Snapshot['propertyHistory'] = [];
    for (const { id } of wall.assets) {
      const history = propertyHistory.get(id);
      if (history) histories.push([id, summarizePropertyHistory(history)]);
    }
    const reportingDate = revenueCalendarDate(options.now, options.osTimeZone);
    const encode = new TextEncoder();
    const { generatedAt: _generatedAt, ...content } = wall;
    const sha = await crypto.subtle.digest('SHA-256', encode.encode(JSON.stringify([reportingDate, content, histories])));
    const version = Array.from(new Uint8Array(sha), byte => byte.toString(16).padStart(2, '0')).join('');
    candidate = { schema: SCHEMA, workspaceId, version: { version, reportingDate, retained: false }, wall, propertyHistory: histories };
    body = JSON.stringify(candidate);
  } catch (error) {
    if (current?.snapshot) return result(current.snapshot, true);
    throw error;
  }
  if (saved.readOnly) return result(candidate);
  if (current === undefined || new TextEncoder().encode(body).byteLength > MAX_BYTES) return result(candidate);

  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = current?.snapshot;
    if (previous && (previous.version.version === candidate.version.version
      || Date.parse(previous.wall.generatedAt) >= options.now.getTime())) return result(previous);
    try {
      const stored = await bucket.put(key, body, {
        onlyIf: current ? { etagMatches: current.etag } : new Headers({ 'if-none-match': '*' }),
        httpMetadata: { contentType: 'application/json' },
      });
      if (stored) return result(candidate);
      current = await readStored(bucket, key, workspaceId);
    } catch {
      return result(candidate);
    }
  }
  return result(current?.snapshot ?? candidate);
}
