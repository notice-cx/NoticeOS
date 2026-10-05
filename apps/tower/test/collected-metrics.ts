// A TEST'S COLLECTION RUNS AND THE VALUES THEY CHANGED, on Postgres where the
// collectors write them (bead ro-ujb9.76.5.3; the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md, section 7 step 8).
//
// Written through the application role into the store a test's readers take
// (`ctx.call`, test/sites.ts), so the sites must be added first:
// a run references its site. Each value goes under the series its run measured
// (site, provider, property, reporting zone and metric), named on first use,
// in the order given; the store refuses a value under a run that did not
// succeed and a metric its provider does not report.
import type { Transaction, WorkspaceStore } from "@noticeos/postgres";

/** One collection run, as a test states it. */
export interface TestSignalRun {
  id: string;
  asset: string;
  integration: "ga4" | "gsc" | "bing-webmaster";
  finishedAt: string;
  /** Default: `finishedAt`. */
  startedAt?: string;
  status?: "success" | "error";
  credentialRef?: string;
  propertyRef?: string;
  timeZone?: string | null;
  /** Default: `windowEnd`. */
  windowStart?: string;
  /** Default: the day `finishedAt` falls on. */
  windowEnd?: string;
  /** A provisional tail makes the run `includes-provisional`. */
  provisionalFrom?: string | null;
  providerRows?: number;
  /** Default: how many values are written with it. */
  observationCount?: number;
  /** Defaults for a failed run: 'provider_error', 'the provider refused the read'. */
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** One value a run changed; `id` sets its identity, for a test of which write is newest. */
export interface TestSignalValue {
  date: string;
  metric: string;
  value: number;
  id?: bigint;
}

const INSERT_RUN = `INSERT INTO noticeos.signal_runs
  (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
   started_at, finished_at, status, window_start, window_end, data_state, provisional_from,
   provider_rows, observation_count, error_code, error_message)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text, $8::timestamptz, $9::timestamptz, $10, $11::date, $12::date,
        $13, $14::date, $15, $16, $17::text, $18::text)
RETURNING run_seq`;

const NAME_SERIES = `INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
SELECT DISTINCT $1::uuid, $2, $3, $4, $5::text, m.metric FROM unnest($6::text[]) AS m(metric)
ON CONFLICT DO NOTHING`;

const SERIES_OF = `JOIN noticeos.measurement_series s
    ON s.workspace_id = $1::uuid AND s.asset_id = $2 AND s.integration = $3 AND s.property_ref = $4
   AND s.time_zone IS NOT DISTINCT FROM $5::text AND s.metric = v.metric`;

const INSERT_VALUES = `INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
SELECT $1::uuid, $6::bigint, s.series_id, v.observed_date, v.value
  FROM unnest($7::date[], $8::text[], $9::float8[]) WITH ORDINALITY AS v(observed_date, metric, value, place)
  ${SERIES_OF}
 ORDER BY v.place`;

const INSERT_VALUE_WITH_ID = `INSERT INTO noticeos.signal_observations (workspace_id, observation_id, run_seq, series_id, observed_date, value)
OVERRIDING SYSTEM VALUE
SELECT $1::uuid, $7::bigint, $6::bigint, s.series_id, v.observed_date, v.value
  FROM (VALUES ($8::date, $9::text, $10::float8)) AS v(observed_date, metric, value)
  ${SERIES_OF}`;

/** The values, under their run and its series, in the order given: a stretch
 * of values without an identity in one statement, each with one alone. */
async function insertValues(
  tx: Transaction,
  runSeq: bigint,
  series: readonly [string, string, string, string, string | null],
  values: readonly TestSignalValue[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.execute(NAME_SERIES, [...series, values.map((value) => value.metric)]);
  let pending: TestSignalValue[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    await tx.execute(INSERT_VALUES, [
      ...series, runSeq,
      pending.map((value) => value.date), pending.map((value) => value.metric), pending.map((value) => value.value),
    ]);
    pending = [];
  };
  for (const value of values) {
    if (value.id === undefined) {
      pending.push(value);
      continue;
    }
    await flush();
    await tx.execute(INSERT_VALUE_WITH_ID, [...series, runSeq, value.id, value.date, value.metric, value.value]);
  }
  await flush();
}

/** One run and the values it changed, in one transaction. */
export async function writeSignalRun(
  store: WorkspaceStore,
  run: TestSignalRun,
  values: readonly TestSignalValue[] = [],
): Promise<void> {
  const status = run.status ?? "success";
  const failed = status === "error";
  const provisionalFrom = run.provisionalFrom ?? null;
  const windowEnd = run.windowEnd ?? run.finishedAt.slice(0, 10);
  await store.write(async (tx) => {
    const [row] = await tx.query<{ run_seq: bigint }>(INSERT_RUN, [
      tx.workspaceId, run.id, run.asset, run.integration, run.credentialRef ?? "test-credential",
      run.propertyRef ?? "test-property", run.timeZone ?? null, run.startedAt ?? run.finishedAt, run.finishedAt,
      status, run.windowStart ?? windowEnd, windowEnd, provisionalFrom === null ? "final" : "includes-provisional",
      provisionalFrom, run.providerRows ?? values.length, run.observationCount ?? values.length,
      run.errorCode ?? (failed ? "provider_error" : null), run.errorMessage ?? (failed ? "the provider refused the read" : null),
    ]);
    await insertValues(tx, row!.run_seq, [tx.workspaceId, run.asset, run.integration, run.propertyRef ?? "test-property", run.timeZone ?? null], values);
  });
}

/** More values under a run already written, found by its id. */
export async function writeSignalValues(store: WorkspaceStore, runId: string, values: readonly TestSignalValue[]): Promise<void> {
  await store.write(async (tx) => {
    const [run] = await tx.query<{ run_seq: bigint; asset_id: string; integration: string; property_ref: string; time_zone: string | null }>(
      `SELECT run_seq, asset_id, integration, property_ref, time_zone FROM noticeos.signal_runs WHERE run_id = $1`,
      [runId],
    );
    if (run === undefined) throw new Error(`writeSignalValues: no run ${runId}`);
    await insertValues(tx, run.run_seq, [tx.workspaceId, run.asset_id, run.integration, run.property_ref, run.time_zone], values);
  });
}

/** `date → value` as the values of one metric, in date order as written. */
export function valuesOf(metric: string, byDate: Record<string, number>): TestSignalValue[] {
  return Object.entries(byDate).map(([date, value]) => ({ date, metric, value }));
}
