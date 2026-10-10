// A test's provider report runs, paid lookups and insight snapshots, written
// through the application role into the store a test's readers take
// (`ctx.call`, test/sites.ts), so the sites must be added first: every row
// references its site. A report run's price is kept by the store's one rule
// (`storedProviderCost`), and a stored run's object is recorded once per key.
import { storedProviderCost } from "@noticeos/contract";
import type { WorkspaceStore } from "@noticeos/postgres";

/** One provider report run, as a test states it. */
export interface TestArchiveRun {
  id: string;
  asset: string;
  integration: string;
  report: string;
  report_date: string;
  finished_at: string;
  /** Default: `finished_at`. */
  requested_at?: string;
  status?: "success" | "unchanged" | "error";
  /** Default: 'provider-snapshot'. */
  data_state?: "provider-final" | "revision-window" | "provider-snapshot";
  credential_ref?: string;
  /** Default: the site's id. */
  property_ref?: string;
  provider_rows?: number;
  request_count?: number;
  provider_truncated?: boolean;
  /** A stored run's object. Default: a key of its own, made from its id. */
  object_key?: string;
  /** Default: 64 zeros. */
  content_sha256?: string;
  /** Default: 1. */
  object_bytes?: number;
  /** Defaults for a failed run: 'test_error', 'failed'. */
  error_code?: string;
  error_message?: string;
  /** What it cost, as its collector states it. Default: 0. */
  provider_cost_usd?: number;
}

/** Each object the runs name, once, dated by the first run that names it. */
const RECORD_OBJECTS = `INSERT INTO noticeos.archive_objects (workspace_id, object_key, content_sha256, object_bytes, first_stored_at)
SELECT $1::uuid, k.object_key, min(k.content_sha256), min(k.object_bytes), min(k.stored_at)
  FROM unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) AS k(object_key, content_sha256, object_bytes, stored_at)
 GROUP BY k.object_key
ON CONFLICT (workspace_id, object_key) DO NOTHING`;

/** The runs, numbered in the order given (a stored run finds its object by
 * key and content: one stored with other content leaves it none, which the
 * table refuses). */
const INSERT_RUNS = `INSERT INTO noticeos.archive_runs
  (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref, report_date,
   requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
   provider_truncated, object_seq, error_code, error_message, cost_usd, cost_state)
SELECT $1::uuid, r.run_id, r.asset_id, r.integration, r.report, r.credential_ref, r.property_ref, r.report_date,
       r.requested_at, r.finished_at, r.status, r.data_state, 1, r.provider_rows, r.request_count,
       r.provider_truncated, o.object_seq, r.error_code, r.error_message, r.cost_usd, r.cost_state
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::date[],
              $9::timestamptz[], $10::timestamptz[], $11::text[], $12::text[], $13::int[], $14::int[],
              $15::boolean[], $16::text[], $17::text[], $18::bigint[], $19::text[], $20::text[],
              $21::numeric[], $22::text[])
       WITH ORDINALITY AS r(run_id, asset_id, integration, report, credential_ref, property_ref, report_date,
                            requested_at, finished_at, status, data_state, provider_rows, request_count,
                            provider_truncated, object_key, content_sha256, object_bytes, error_code, error_message,
                            cost_usd, cost_state, place)
  LEFT JOIN noticeos.archive_objects o
    ON o.workspace_id = $1::uuid AND o.object_key = r.object_key
   AND o.content_sha256 = r.content_sha256 AND o.object_bytes = r.object_bytes
 ORDER BY r.place`;

/** Report runs, in one transaction, in the order given: two statements
 * however many runs, so a year of history is quick to write. */
export async function writeArchiveRuns(store: WorkspaceStore, runs: readonly TestArchiveRun[]): Promise<void> {
  if (runs.length === 0) return;
  const rows = runs.map((run) => {
    const status = run.status ?? "success";
    const failed = status === "error";
    const cost = storedProviderCost(run.integration, run.provider_cost_usd ?? 0);
    return {
      run, status, failed, cost,
      key: failed ? null : (run.object_key ?? `raw/test/${run.integration}/${run.asset}/${run.report}/${run.report_date}/${run.id}.json.gz`),
      sha: failed ? null : (run.content_sha256 ?? "0".repeat(64)),
      bytes: failed ? null : (run.object_bytes ?? 1),
    };
  });
  const stored = rows.filter((row) => !row.failed);
  await store.write(async (tx) => {
    if (stored.length > 0) {
      await tx.execute(RECORD_OBJECTS, [
        tx.workspaceId, stored.map((row) => row.key), stored.map((row) => row.sha),
        stored.map((row) => row.bytes), stored.map((row) => row.run.finished_at),
      ]);
    }
    await tx.execute(INSERT_RUNS, [
      tx.workspaceId,
      rows.map(({ run }) => run.id), rows.map(({ run }) => run.asset), rows.map(({ run }) => run.integration),
      rows.map(({ run }) => run.report), rows.map(({ run }) => run.credential_ref ?? "test"),
      rows.map(({ run }) => run.property_ref ?? run.asset), rows.map(({ run }) => run.report_date),
      rows.map(({ run }) => run.requested_at ?? run.finished_at), rows.map(({ run }) => run.finished_at),
      rows.map((row) => row.status), rows.map(({ run }) => run.data_state ?? "provider-snapshot"),
      rows.map(({ run }) => run.provider_rows ?? 0), rows.map(({ run }) => run.request_count ?? 0),
      rows.map(({ run }) => run.provider_truncated ?? false), rows.map((row) => row.key), rows.map((row) => row.sha),
      rows.map((row) => row.bytes),
      rows.map(({ run, failed }) => (failed ? (run.error_code ?? "test_error") : null)),
      rows.map(({ run, failed }) => (failed ? (run.error_message ?? "failed") : null)),
      rows.map((row) => (row.cost.usd === null ? null : String(row.cost.usd))), rows.map((row) => row.cost.state),
    ]);
  });
}

/** One report run (`writeArchiveRuns`). */
export async function writeArchiveRun(store: WorkspaceStore, run: TestArchiveRun): Promise<void> {
  await writeArchiveRuns(store, [run]);
}

/** One paid lookup, as a test states it. */
export interface TestResearch {
  /** Null: research about no one site. */
  asset: string | null;
  cost_usd: number;
  bought_at: string;
  /** Default: 'dataforseo'. */
  provider?: string;
  endpoint?: string;
  params_sha256?: string;
  question?: string;
  actor?: string;
  object_key?: string | null;
}

/** Paid lookups, in one transaction, in the order given: each numbered in its
 * workspace as the log numbers it, its price kept by the store's one rule. */
export async function writeResearch(store: WorkspaceStore, rows: readonly TestResearch[]): Promise<void> {
  await store.write(async (tx) => {
    for (const row of rows) {
      const provider = row.provider ?? "dataforseo";
      const cost = storedProviderCost(provider, row.cost_usd);
      await tx.execute(
        `INSERT INTO noticeos.research_log
           (workspace_id, asset_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, object_key, actor, bought_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11::timestamptz)`,
        [
          tx.workspaceId, row.asset, provider, row.endpoint ?? "test/endpoint", row.params_sha256 ?? "0".repeat(64),
          row.question ?? "a test lookup", cost.usd, cost.state, row.object_key ?? null, row.actor ?? "test",
          row.bought_at,
        ],
      );
    }
  });
}

/** One insight snapshot, as a test states it. */
export interface TestInsightSnapshot {
  id: string;
  asset: string;
  generated_at: string;
  payload: string;
  /** Default: now, as the store stamps it. */
  created_at?: string;
  window_start?: string | null;
  window_end?: string | null;
  /** Default: 1. */
  source_archive_count?: number;
  /** Default: the SHA-256 of the id. */
  content_sha256?: string;
}

/** Insight snapshots, in one transaction, in the order given. */
export async function writeInsightSnapshots(store: WorkspaceStore, snapshots: readonly TestInsightSnapshot[]): Promise<void> {
  const digests = await Promise.all(snapshots.map((snapshot) => snapshot.content_sha256 ?? digest(snapshot.id)));
  await store.write(async (tx) => {
    for (const [index, snapshot] of snapshots.entries()) {
      await tx.execute(
        `INSERT INTO noticeos.asset_insight_snapshots
           (workspace_id, snapshot_id, asset_id, generated_at, window_start, window_end,
            source_archive_count, content_sha256, payload, created_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::date, $6::date, $7, $8, $9::json, COALESCE($10::timestamptz, now()))`,
        [
          tx.workspaceId, snapshot.id, snapshot.asset, snapshot.generated_at, snapshot.window_start ?? null,
          snapshot.window_end ?? null, snapshot.source_archive_count ?? 1, digests[index]!, snapshot.payload,
          snapshot.created_at ?? null,
        ],
      );
    }
  });
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
