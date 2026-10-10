import { persistCollectionAttempt, type CollectionMonitoring } from './collection-attempt.js';
// Provider-neutral persistence for central analytics/search collectors.
//
// Every attempt is durable. Successful observations are change-only snapshots:
// a provider revision appends a new fact, while an unchanged rolling window
// records a zero-change success without duplicating the whole history.
//
// "Changed" is judged within one measurement series: the same asset,
// integration and provider resource (`property_ref`), measured under the same
// reporting-day definition (`time_zone`). `credential_ref` is deliberately not
// part of the series: rotating the credential does not change what is measured.

import type { Ga4PropertyQuota } from '@noticeos/contract';

export type SignalIntegration = 'ga4' | 'gsc' | 'bing-webmaster';

/** Ninety visible chart days plus seven calculation-only days so the first
 * visible date has a real prior-week comparison; compact Wall cards apply their
 * own shorter 28-day slice. */
export const LIVE_SIGNAL_WINDOW_DAYS = 97;

export interface SignalTarget {
  asset: string;
  integration: SignalIntegration;
  credentialRef: string;
  propertyRef: string;
}

export interface SignalObservation {
  date: string;
  metric: string;
  value: number;
}

export interface SignalProviderResult {
  providerRows: number;
  observations: SignalObservation[];
  dataState: 'final' | 'includes-provisional';
  provisionalFrom: string | null;
  /**
   * What the provider said this call cost (`returnPropertyQuota`, GA4 only).
   * Deliberately not stored on the run row: `signal_runs` records what was
   * observed about the property, and our own spend is a different fact with a
   * different reader (`src/ga4-quota.ts`).
   */
  quota?: Ga4PropertyQuota | null;
  /**
   * The IANA zone whose midnight bounded these observations' days. GA4 reports
   * it on every response; Search Console has none because Google fixes its
   * boundary. Null means the provider did not say and nothing else knew, never
   * "UTC" silently substituted.
   */
  timeZone?: string | null;
}

export interface SignalDateWindow {
  start: string;
  end: string;
}

export class SignalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The run and its changed values go to this call's store; its monitoring
 * result goes to the same store (`persistCollectionAttempt`). */
export type SignalStoreEnv = Pick<IngestEnv, 'STORE'>;

/** The prior values of one measurement series inside a window, oldest write
 * first, so the last one read for a (date, metric) is its newest write. The
 * series is the one this run measures: the same site, provider, property and
 * reporting zone. `IS NOT DISTINCT FROM`, not `=`: a provider that states no
 * zone (Bing) records NULL, and NULL must match NULL — and only NULL — or
 * every run of that provider would re-record its whole window. */
const PRIOR_VALUES_SQL = `SELECT o.observed_date AS date, s.metric, o.value
  FROM noticeos.measurement_series s
  JOIN noticeos.signal_observations o ON o.workspace_id = s.workspace_id AND o.series_id = s.series_id
  JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
 WHERE s.asset_id = $1 AND s.integration = $2 AND s.property_ref = $3
   AND s.time_zone IS NOT DISTINCT FROM $4::text
   AND o.observed_date >= $5::date AND o.observed_date <= $6::date
 ORDER BY r.finished_at, o.observation_id`;

/** One attempt, successful or not. */
const INSERT_RUN_SQL = `INSERT INTO noticeos.signal_runs
  (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
   started_at, finished_at, status, window_start, window_end, data_state, provisional_from,
   provider_rows, observation_count, error_code, error_message)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text, $8::timestamptz, $9::timestamptz, $10, $11::date, $12::date,
        $13, $14::date, $15, $16, $17::text, $18::text)
RETURNING run_seq`;

/** The series this run's changed values belong to, named on first use: a
 * series, once named, is permanent (model.json `measurement_series`). */
const NAME_SERIES_SQL = `INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
SELECT DISTINCT $1::uuid, $2, $3, $4, $5::text, m.metric FROM unnest($6::text[]) AS m(metric)
ON CONFLICT DO NOTHING`;

/** The changed values, written in the order the provider gave them. */
const INSERT_VALUES_SQL = `INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
SELECT $1::uuid, $2::bigint, s.series_id, c.observed_date, c.value
  FROM unnest($3::date[], $4::text[], $5::float8[]) WITH ORDINALITY AS c(observed_date, metric, value, place)
  JOIN noticeos.measurement_series s
    ON s.workspace_id = $1::uuid AND s.asset_id = $6 AND s.integration = $7 AND s.property_ref = $8
   AND s.time_zone IS NOT DISTINCT FROM $9::text AND s.metric = c.metric
 ORDER BY c.place`;

export async function recordSignalSuccess(
  env: SignalStoreEnv,
  target: SignalTarget,
  window: SignalDateWindow,
  startedAt: string,
  result: SignalProviderResult,
  monitoring?: CollectionMonitoring,
): Promise<void> {
  const timeZone = result.timeZone ?? null;
  const runId = crypto.randomUUID();
  const finishedAt = new Date().toISOString();
  await persistCollectionAttempt({
    target,
    monitoring,
    attempt: {
      id: runId, startedAt, finishedAt,
      source: 'signal_runs', ok: true,
    },
  }, () =>
    // One transaction: the prior values read, then the run and its changed
    // values written, or nothing.
    env.STORE.write(async (tx) => {
      const priorRows = await tx.query<{ date: string; metric: string; value: number }>(PRIOR_VALUES_SQL, [
        target.asset, target.integration, target.propertyRef, timeZone, window.start, window.end,
      ]);
      const prior = new Map(
        priorRows.map((row) => [`${row.date}\0${row.metric}`, row.value]),
      );
      const changes = result.observations.filter(
        (observation) =>
          prior.get(`${observation.date}\0${observation.metric}`) !== observation.value,
      );
      const [run] = await tx.query<{ run_seq: bigint }>(INSERT_RUN_SQL, [
        tx.workspaceId, runId, target.asset, target.integration, target.credentialRef, target.propertyRef, timeZone,
        startedAt, finishedAt, 'success', window.start, window.end, result.dataState, result.provisionalFrom,
        result.providerRows, changes.length, null, null,
      ]);
      if (changes.length === 0) return;
      const series = [tx.workspaceId, target.asset, target.integration, target.propertyRef, timeZone] as const;
      await tx.execute(NAME_SERIES_SQL, [...series, changes.map((change) => change.metric)]);
      await tx.execute(INSERT_VALUES_SQL, [
        tx.workspaceId, run!.run_seq,
        changes.map((change) => change.date), changes.map((change) => change.metric), changes.map((change) => change.value),
        target.asset, target.integration, target.propertyRef, timeZone,
      ]);
    }),
  );
}

export async function recordSignalFailure(
  env: SignalStoreEnv,
  target: SignalTarget,
  window: SignalDateWindow,
  startedAtMs: number,
  error: SignalError,
  monitoring?: CollectionMonitoring,
): Promise<void> {
  const startedAt = new Date(
    Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
  ).toISOString();
  const runId = crypto.randomUUID();
  const finishedAt = new Date().toISOString();
  await persistCollectionAttempt({
    target,
    monitoring,
    attempt: {
      id: runId, startedAt, finishedAt,
      source: 'signal_runs', ok: false, code: error.code,
    },
  }, () =>
    env.STORE.write((tx) =>
      tx.execute(INSERT_RUN_SQL, [
        tx.workspaceId, runId, target.asset, target.integration, target.credentialRef, target.propertyRef, null,
        startedAt, finishedAt, 'error', window.start, window.end, 'final', null,
        0, 0, error.code, error.message.slice(0, 500),
      ]),
    ),
  );
}

export function normalizeSignalError(
  error: unknown,
  fallbackMessage: string,
): SignalError {
  if (error instanceof SignalError) return error;
  if (error instanceof Error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    return new SignalError(
      timeout ? 'request_timeout' : 'request_failed',
      error.message.slice(0, 500),
    );
  }
  return new SignalError('request_failed', fallbackMessage);
}
