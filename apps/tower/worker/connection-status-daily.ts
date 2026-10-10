// System health's four connection counts, once a day
// (`noticeos.connection_status_daily_counts`). The recorder makes the same two
// reads and counts with the same functions the strip calls
// (shared/connection-status.ts), so the line under a number counts the same
// thing. Written by the hourly tick (worker/tower-cron.ts); each hour upserts
// the day's row and the day keeps its newest observation.

import { type WorkspaceStore } from "@noticeos/postgres";
import {
  INTEGRATION_PROVIDERS,
  type CredentialStoreState,
  type IntegrationHealthPayload,
} from "@noticeos/contract";
import {
  CONNECTION_COUNT_KEYS,
  connectionCounts,
  currentHealth,
  providerStatuses,
  type ConnectionCounts,
  type ConnectionCountsHistory,
  type IntegrationHealthResponse,
  type ProviderCredential,
} from "../shared/connection-status";
import type { SeriesPoint } from "../shared/wall";
import { JSON_HEADERS } from "./http";

/** How long the record keeps a day. Fixed here AND in `model.json`'s retention. */
export const CONNECTION_STATUS_RETENTION_DAYS = 400;

/** The two ingest reads the recorder makes; the route makes the first. */
export interface IntegrationHealthIngest {
  integrationHealth?(): Promise<unknown>;
  listCredentialSummaries(): Promise<CredentialStoreState>;
}

const UPSERT = `INSERT INTO noticeos.connection_status_daily_counts AS kept
       (workspace_id, day, observed_at, sites_failing, sites_overdue, reports_missing, sites_working)
     VALUES ($1::uuid, $2::date, $3::timestamptz, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, day) DO UPDATE SET
       observed_at     = excluded.observed_at,
       sites_failing   = excluded.sites_failing,
       sites_overdue   = excluded.sites_overdue,
       reports_missing = excluded.reports_missing,
       sites_working   = excluded.sites_working
      WHERE excluded.observed_at >= kept.observed_at`;

/**
 * Write today's row, and drop the days past retention, in one transaction.
 * The upsert refuses an observation older than the one stored, so two writes
 * finishing out of order cannot walk the day backwards.
 */
export async function recordConnectionStatusDay(store: WorkspaceStore, counts: ConnectionCounts, now: Date): Promise<void> {
  const observedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - CONNECTION_STATUS_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  await store.write(async (tx) => {
    await tx.execute(UPSERT, [
      tx.workspaceId, observedAt.slice(0, 10), observedAt, counts.sitesFailing, counts.sitesOverdue, counts.reportsMissing, counts.sitesWorking,
    ]);
    await tx.execute(`DELETE FROM noticeos.connection_status_daily_counts WHERE day < $1::date`, [cutoff]);
  });
}

function emptySeries(): Record<keyof ConnectionCounts, SeriesPoint[]> {
  return { sitesFailing: [], sitesOverdue: [], reportsMissing: [], sitesWorking: [] };
}

/** Every day the record holds, oldest first. */
export async function loadConnectionStatusHistory(store: WorkspaceStore): Promise<ConnectionCountsHistory> {
  const rows = await store.read((tx) =>
    tx.query<{ day: string; sitesFailing: number; sitesOverdue: number; reportsMissing: number; sitesWorking: number }>(
      `SELECT day,
              sites_failing   AS "sitesFailing",
              sites_overdue   AS "sitesOverdue",
              reports_missing AS "reportsMissing",
              sites_working   AS "sitesWorking"
         FROM noticeos.connection_status_daily_counts
        ORDER BY day ASC`,
    ),
  );
  const series = emptySeries();
  for (const row of rows) {
    for (const key of CONNECTION_COUNT_KEYS) series[key].push({ t: row.day, v: Number(row[key]) || 0 });
  }
  return { days: rows.length, series };
}

/** The stored credentials, in catalog order, as the providers list pairs them. */
export function providerCredentials(state: CredentialStoreState): ProviderCredential[] {
  const summaries = new Map(state.summaries.map((summary) => [summary.provider, summary]));
  return INTEGRATION_PROVIDERS.flatMap((provider) => {
    const credential = summaries.get(provider.id);
    return credential === undefined ? [] : [{ provider, credential }];
  });
}

function isHealthPayload(value: unknown): value is IntegrationHealthPayload {
  return typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items) && typeof (value as { generatedAt?: unknown }).generatedAt === "string";
}

/**
 * The strip's four counts over this health read, or null when the strip would
 * not state them either: the read is not current, or the credentials could not
 * be read. A day's record never says more than the screen.
 */
export function systemHealthCounts(payload: IntegrationHealthPayload, providers: readonly ProviderCredential[], nowMs: number): ConnectionCounts | null {
  const health = currentHealth(payload, false, nowMs);
  if (!health.current) return null;
  return connectionCounts(providerStatuses(providers, health.items).map(({ status }) => status));
}

/** What one hourly recording did. A skip is a fact about the installation,
 * never a failure: the step's trace reads it as skipped. */
export type ConnectionCountsRun =
  | { outcome: "ran"; counts: ConnectionCounts }
  | { outcome: "skipped"; reason: "unavailable" | "not-current" };

/**
 * The hourly step: read what System health reads,
 * count it as the strip counts it, and upsert today's row. Nothing is recorded
 * when monitoring cannot answer or its read is not current — the strip would
 * state nothing then either.
 */
export async function recordTodaysConnectionCounts(
  ingest: IntegrationHealthIngest,
  store: WorkspaceStore,
  now: Date,
): Promise<ConnectionCountsRun> {
  if (!ingest.integrationHealth) return { outcome: "skipped", reason: "unavailable" };
  const payload = await ingest.integrationHealth();
  if (!isHealthPayload(payload)) return { outcome: "skipped", reason: "unavailable" };
  const counts = systemHealthCounts(payload, providerCredentials(await ingest.listCredentialSummaries()), now.getTime());
  if (!counts) return { outcome: "skipped", reason: "not-current" };
  await recordConnectionStatusDay(store, counts, now);
  return { outcome: "ran", counts };
}

/** `GET /api/integrations/health`: the ingest's read and the record the strip
 * draws. It writes nothing: the hourly tick records the day. */
export async function handleIntegrationHealthRequest(
  request: Request,
  ingest: IntegrationHealthIngest,
  store: WorkspaceStore,
  now: Date,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  let payload: unknown;
  try {
    if (!ingest.integrationHealth) throw new Error("Monitoring unavailable");
    payload = await ingest.integrationHealth();
  } catch {
    return Response.json({ generatedAt: now.toISOString(), available: false, items: [], events: [] }, { status: 503, headers: JSON_HEADERS });
  }
  if (!isHealthPayload(payload)) return Response.json(payload, { headers: JSON_HEADERS });
  // The record is a history of the read, never a reason to lose the read.
  let countsHistory: ConnectionCountsHistory | undefined;
  try {
    countsHistory = await loadConnectionStatusHistory(store);
  } catch (error) {
    console.warn(JSON.stringify({ event: "connection_status_daily_failed", step: "read", message: error instanceof Error ? error.message : String(error) }));
  }
  const body: IntegrationHealthResponse = countsHistory ? { ...payload, countsHistory } : payload;
  return Response.json(body, { headers: JSON_HEADERS });
}
