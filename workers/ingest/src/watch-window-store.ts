// Where a watch window lives. A window is one `noticeos.watch_windows` row:
// its registration, fixed, and its close, one-way. Each offset the sweep has
// read is one `noticeos.watch_window_readings` row, and that table's key
// (window, offset) is what stops a re-run from reading an offset twice. Every
// caller speaks `WatchWindowRow` (@noticeos/contract); this module turns the
// store's rows into that shape and back, and nothing else does.

import type { WatchWindowRow } from '@noticeos/contract';
import { javascriptInstant, type Transaction } from '@noticeos/postgres';
import type { WatchReading } from './watch-windows.js';

/** A window's own columns, as the store keeps them. */
interface WindowRecord extends Record<string, unknown> {
  window_id: string;
  asset_id: string;
  ref_kind: string;
  ref: string;
  metric_integration: string;
  metric: string;
  scope: string | null;
  registered_at: string;
  baseline_start: string;
  baseline_end: string;
  check_offsets: number[];
  thresholds: string | null;
  status: string;
  outcome: string | null;
  last_checked_at: string | null;
  closed_at: string | null;
  note: string | null;
  outcome_note: string | null;
  created_at: string;
  readback_bead: string | null;
  readback_posted_at: string | null;
}

interface ReadingRecord extends Record<string, unknown> {
  window_id: string;
  offset_days: number;
  check_date: string;
  checked_at: string;
  final: boolean;
  baseline: string | null;
  post: string | null;
  delta_pct: number | null;
  pre_change_days: number;
}

const WINDOW_COLUMNS = `window_id, asset_id, ref_kind, ref, metric_integration, metric, scope::text AS scope,
       registered_at, baseline_start, baseline_end, check_offsets, thresholds::text AS thresholds,
       status, outcome, last_checked_at, closed_at, note, outcome_note, created_at,
       readback_bead, readback_posted_at`;

/** `jsonb` text as `JSON.stringify` writes it. */
function compactJson(text: string | null): string | null {
  return text === null ? null : JSON.stringify(JSON.parse(text));
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : javascriptInstant(value);
}

/** A window as a `WatchWindowRow`, its readings in offset order. */
function asRow(record: WindowRecord, readings: readonly WatchReading[]): WatchWindowRow {
  return {
    id: record.window_id,
    asset: record.asset_id,
    ref_kind: record.ref_kind,
    ref: record.ref,
    metric_integration: record.metric_integration,
    metric: record.metric,
    scope_json: compactJson(record.scope),
    registered_at: javascriptInstant(record.registered_at),
    baseline_start: record.baseline_start,
    baseline_end: record.baseline_end,
    check_offsets_json: JSON.stringify(record.check_offsets),
    thresholds_json: compactJson(record.thresholds),
    readings_json: JSON.stringify(readings),
    status: record.status,
    outcome: record.outcome,
    last_checked_at: instantOrNull(record.last_checked_at),
    closed_at: instantOrNull(record.closed_at),
    note: record.note,
    outcome_note: record.outcome_note,
    created_at: javascriptInstant(record.created_at),
    readback_bead: record.readback_bead,
    readback_posted_at: instantOrNull(record.readback_posted_at),
  };
}

function asReading(record: ReadingRecord): WatchReading {
  return {
    offset_days: record.offset_days,
    check_date: record.check_date,
    checked_at: javascriptInstant(record.checked_at),
    final: record.final,
    baseline: record.baseline === null ? null : JSON.parse(record.baseline),
    post: record.post === null ? null : JSON.parse(record.post),
    delta_pct: record.delta_pct,
    pre_change_days: record.pre_change_days,
  };
}

/** These windows with their readings, in the order the records came. */
async function withReadings(tx: Transaction, records: WindowRecord[]): Promise<WatchWindowRow[]> {
  if (records.length === 0) return [];
  const rows = await tx.query<ReadingRecord>(
    `SELECT window_id, offset_days, check_date, checked_at, final, baseline::text AS baseline,
            post::text AS post, delta_pct, pre_change_days
       FROM noticeos.watch_window_readings
      WHERE window_id = ANY($1::text[])
      ORDER BY window_id, offset_days`,
    [records.map((record) => record.window_id)],
  );
  const byWindow = new Map<string, WatchReading[]>();
  for (const row of rows) {
    const list = byWindow.get(row.window_id) ?? [];
    list.push(asReading(row));
    byWindow.set(row.window_id, list);
  }
  return records.map((record) => asRow(record, byWindow.get(record.window_id) ?? []));
}

/** Every open window, oldest registration first (ties by id: Postgres keeps
 * no insertion order). */
export async function readOpenWindows(tx: Transaction): Promise<WatchWindowRow[]> {
  const records = await tx.query<WindowRecord>(
    `SELECT ${WINDOW_COLUMNS}
       FROM noticeos.watch_windows
      WHERE status = 'open'
      ORDER BY registered_at ASC, window_id COLLATE "C" ASC`,
  );
  return withReadings(tx, records);
}

/** What makes two registrations the same bet. */
export interface WatchBet {
  asset: string;
  refKind: string;
  ref: string;
  integration: string;
  metric: string;
  /** The scope as JSON text, or null for the whole site. */
  scopeJson: string | null;
}

/**
 * Hold one bet until the transaction ends, so two registrations of it at once
 * are one window: each reads, decides and writes under it.
 */
export async function holdBet(tx: Transaction, bet: WatchBet): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `noticeos.watch-bet:${tx.workspaceId}:${JSON.stringify([bet.asset, bet.refKind, bet.ref, bet.integration, bet.metric, bet.scopeJson])}`,
  ]);
}

/** The window already holding this bet, the first registered, or null. A
 * scope is the same scope when it is the same JSON value. */
export async function findBet(tx: Transaction, bet: WatchBet): Promise<WatchWindowRow | null> {
  const records = await tx.query<WindowRecord>(
    `SELECT ${WINDOW_COLUMNS}
       FROM noticeos.watch_windows
      WHERE asset_id = $1 AND ref_kind = $2 AND ref = $3
        AND metric_integration = $4 AND metric = $5
        AND scope IS NOT DISTINCT FROM $6::jsonb
      ORDER BY created_at ASC, window_id COLLATE "C" ASC
      LIMIT 1`,
    [bet.asset, bet.refKind, bet.ref, bet.integration, bet.metric, bet.scopeJson],
  );
  const [row] = await withReadings(tx, records);
  return row ?? null;
}

/** One new window's registration. */
export interface NewWindow extends WatchBet {
  id: string;
  registeredAt: string;
  baselineStart: string;
  baselineEnd: string;
  offsets: number[];
  /** JSON text, or null. */
  thresholdsJson: string | null;
  note: string | null;
  readbackBead: string | null;
}

/** Register a window; the stored row. */
export async function insertWindow(tx: Transaction, window: NewWindow): Promise<WatchWindowRow | null> {
  const records = await tx.query<WindowRecord>(
    `INSERT INTO noticeos.watch_windows
       (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, scope,
        registered_at, baseline_start, baseline_end, check_offsets, thresholds, note, readback_bead)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::date, $11::date,
             $12::integer[], $13::jsonb, $14, $15)
     RETURNING ${WINDOW_COLUMNS}`,
    [
      tx.workspaceId,
      window.id,
      window.asset,
      window.refKind,
      window.ref,
      window.integration,
      window.metric,
      window.scopeJson,
      window.registeredAt,
      window.baselineStart,
      window.baselineEnd,
      window.offsets,
      window.thresholdsJson,
      window.note,
      window.readbackBead,
    ],
  );
  const [row] = await withReadings(tx, records);
  return row ?? null;
}

/** Append readings a sweep took; an offset already read is kept as it was. */
export async function appendReadings(tx: Transaction, windowId: string, readings: readonly WatchReading[]): Promise<void> {
  for (const reading of readings) {
    await tx.execute(
      `INSERT INTO noticeos.watch_window_readings
         (workspace_id, window_id, offset_days, check_date, checked_at, final, baseline, post, delta_pct, pre_change_days)
       VALUES ($1::uuid, $2, $3, $4::date, $5::timestamptz, $6, $7::jsonb, $8::jsonb, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        tx.workspaceId,
        windowId,
        reading.offset_days,
        reading.check_date,
        reading.checked_at,
        reading.final,
        reading.baseline === null ? null : JSON.stringify(reading.baseline),
        reading.post === null ? null : JSON.stringify(reading.post),
        reading.delta_pct,
        reading.pre_change_days,
      ],
    );
  }
}

/** Stamp an open window's check, holding its row to the end of the
 * transaction; false when the window is no longer open. */
export async function markChecked(tx: Transaction, windowId: string, at: string): Promise<boolean> {
  const changed = await tx.execute(
    `UPDATE noticeos.watch_windows SET last_checked_at = $2::timestamptz
      WHERE window_id = $1 AND status = 'open'`,
    [windowId, at],
  );
  return changed > 0;
}

/** Close an open window with its verdict, holding its row to the end of the
 * transaction; false when another sweep closed it first. */
export async function markClosed(
  tx: Transaction,
  windowId: string,
  verdict: { outcome: string; note: string },
  at: string,
): Promise<boolean> {
  const changed = await tx.execute(
    `UPDATE noticeos.watch_windows
        SET status = 'closed', outcome = $2, closed_at = $3::timestamptz,
            outcome_note = $4, last_checked_at = $3::timestamptz
      WHERE window_id = $1 AND status = 'open'`,
    [windowId, verdict.outcome, at, verdict.note],
  );
  return changed > 0;
}
