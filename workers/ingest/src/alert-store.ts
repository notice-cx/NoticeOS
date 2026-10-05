// THE ALERT STATEMENTS THE LANES SHARE (bead ro-ujb9.76.5.2; the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md).
//
// Alerts live on Postgres: `noticeos.flags` holds each firing as it was first
// raised, `noticeos.flag_evidence` each later reading of a condition that is
// still open, and `noticeos.current_flags` shows every alert as its newest
// reading states it (db/postgres/migrations/0001_baseline.sql). The
// application may not rewrite a firing's message, inputs or severity, so a lane
// that finds its condition still open APPENDS a reading here where the D1 lanes
// rewrote the row; what the operator reads is the same.
//
// ONE OPEN ALERT PER CONDITION. A lane that keeps one open alert for its (site,
// rule) — the freshness check, the nightly pull, the internet check, GA4 quota,
// the site checks — reads, decides and writes inside one transaction that holds
// that condition (`holdCondition`), so two runs can never both find nothing
// open and raise two. D1 got that from running one statement at a time.

import type { Transaction } from '@noticeos/postgres';

/** Hold one condition — a site and a rule — until the transaction ends. */
export async function holdCondition(tx: Transaction, asset: string, ruleId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `noticeos.alert:${tx.workspaceId}:${asset}:${ruleId}`,
  ]);
}

/** The open alert of a condition, as its newest reading states it. */
export interface OpenAlert {
  flagId: bigint;
  /** Its inputs as JSON text, or null. */
  ruleInputs: string | null;
}

/**
 * The condition's open alert — the oldest, as the D1 lanes read it — or null.
 * Open is `resolved_at IS NULL`: an alert the operator acknowledged or parked
 * is still the condition's record, and its next reading lands on it.
 */
export async function readOpenAlert(tx: Transaction, asset: string, ruleId: string): Promise<OpenAlert | null> {
  const [row] = await tx.query<{ flag_id: bigint; rule_inputs: string | null }>(
    `SELECT flag_id, rule_inputs::text AS rule_inputs
       FROM noticeos.current_flags
      WHERE asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL
      ORDER BY fired_at, flag_id
      LIMIT 1`,
    [asset, ruleId],
  );
  return row === undefined ? null : { flagId: row.flag_id, ruleInputs: row.rule_inputs };
}

/** One new firing. */
export interface NewAlert {
  asset: string;
  firedAt: string;
  severity: string;
  kind: string;
  metric: string | null;
  message: string | null;
  ruleId: string;
  /** JSON text, or null. */
  ruleInputs: string | null;
}

/**
 * Raise the condition's alert unless one is already open, as the D1 lanes'
 * `INSERT … WHERE NOT EXISTS` did; the flag id, or null when one was open.
 * Called under `holdCondition`.
 */
export async function raiseAlertUnlessOpen(tx: Transaction, alert: NewAlert): Promise<bigint | null> {
  const [row] = await tx.query<{ flag_id: bigint }>(
    `INSERT INTO noticeos.flags (workspace_id, asset_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
     SELECT $1::uuid, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM noticeos.flags
         WHERE asset_id = $2 AND rule_id = $8 AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL
      )
     RETURNING flag_id`,
    [tx.workspaceId, alert.asset, alert.firedAt, alert.severity, alert.kind, alert.metric, alert.message, alert.ruleId, alert.ruleInputs],
  );
  return row?.flag_id ?? null;
}

/** One reading of a condition. */
export interface Reading {
  /** The reading's instant, or null for the store's own clock: a lane whose
   * readings two runs can take at one instant (the internet check, which every
   * collector consults) is stamped by the store, one instant per reading. */
  observedAt: string | null;
  severity: string;
  message: string | null;
  /** JSON text, or null. */
  ruleInputs: string | null;
}

/**
 * Append a reading to every open alert of a condition — the D1 lanes rewrote
 * each one's summary — and say how many alerts it reached. A second reading at
 * an instant an alert already holds is the same reading, and is kept once.
 */
export async function appendReadingToOpen(
  tx: Transaction,
  asset: string,
  ruleId: string,
  reading: Reading,
): Promise<number> {
  const [row] = await tx.query<{ reached: number }>(
    `WITH open AS (
       SELECT workspace_id, flag_id FROM noticeos.flags
        WHERE asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL
     ), kept AS (
       INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
       SELECT workspace_id, flag_id, coalesce($3::timestamptz, clock_timestamp()), $4, $5, $6::jsonb FROM open
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM open)::int AS reached`,
    [asset, ruleId, reading.observedAt, reading.severity, reading.message, reading.ruleInputs],
  );
  return row?.reached ?? 0;
}

/** Append a reading to these alerts; a second reading at an instant an alert
 * already holds is kept once. */
export async function appendReading(tx: Transaction, flagIds: readonly bigint[], reading: Reading): Promise<void> {
  if (flagIds.length === 0) return;
  await tx.execute(
    `INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
     SELECT $1::uuid, flag_id, coalesce($3::timestamptz, clock_timestamp()), $4, $5, $6::jsonb FROM unnest($2::bigint[]) AS f(flag_id)
     ON CONFLICT DO NOTHING`,
    [tx.workspaceId, flagIds, reading.observedAt, reading.severity, reading.message, reading.ruleInputs],
  );
}

/** Resolve a condition's open alerts at `at`; how many. */
export async function resolveOpen(tx: Transaction, asset: string, ruleId: string, at: string): Promise<number> {
  return tx.execute(
    `UPDATE noticeos.flags SET resolved_at = $1::timestamptz
      WHERE asset_id = $2 AND rule_id = $3 AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL`,
    [at, asset, ruleId],
  );
}
