// A TEST'S CHANGES AND READBACK WINDOWS, ON POSTGRES (bead ro-ujb9.76.5.7).
//
// Changes (`noticeos.annotations`) and readback windows
// (`noticeos.watch_windows`, their readings in `noticeos.watch_window_readings`)
// live on Postgres. A test writes them as the application does, into the copy
// a test opened with `createTestStore` (test/postgres-store.ts): it serves
// this test alone.

import type { WorkspaceStore } from "@noticeos/postgres";

/** One change, as the ingest files it. */
export interface StoredChange {
  asset: string;
  at: string;
  kind: string;
  ref?: string | null;
  note?: string | null;
}

/** File these changes in the order given; their workspace numbers back, in
 * that order (a number is handed out in filing order). */
export async function storeChanges(store: WorkspaceStore, changes: readonly StoredChange[]): Promise<number[]> {
  if (changes.length === 0) return [];
  const numbers = await store.write((tx) =>
    tx.query<{ n: bigint }>(
      `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
       SELECT $1::uuid, c.asset_id, c.at, c.kind, c.ref, c.note
         FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[])
              WITH ORDINALITY AS c(asset_id, at, kind, ref, note, filed)
        ORDER BY c.filed
       RETURNING annotation_number AS n`,
      [
        tx.workspaceId,
        changes.map((change) => change.asset),
        changes.map((change) => change.at),
        changes.map((change) => change.kind),
        changes.map((change) => change.ref ?? null),
        changes.map((change) => change.note ?? null),
      ],
    ),
  );
  return numbers.map((row) => Number(row.n)).sort((a, b) => a - b);
}

/** File one change; its workspace number. */
export async function storeChange(store: WorkspaceStore, change: StoredChange): Promise<number> {
  const [number] = await storeChanges(store, [change]);
  return number!;
}

/** One readback window, as the ingest registers and closes it. */
export interface StoredWindow {
  id: string;
  asset: string;
  refKind?: "annotation" | "decision" | "manual";
  ref: string;
  integration?: string;
  metric?: string;
  /** JSON text, or null for the whole site. */
  scope?: string | null;
  registeredAt: string;
  baselineStart: string;
  baselineEnd: string;
  offsets: number[];
  /** JSON text, or null. */
  thresholds?: string | null;
  note?: string | null;
  /** The offsets already read: one reading each, dated its check day. */
  read?: number[];
  closed?: { outcome: string; at: string; note?: string | null } | null;
  readbackBead?: string | null;
}

/** Register a window, with a reading for each offset in `read`, and close it
 * when `closed` says so. */
export async function storeWatchWindow(store: WorkspaceStore, window: StoredWindow): Promise<void> {
  await store.write(async (tx) => {
    await tx.execute(
      `INSERT INTO noticeos.watch_windows
         (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, scope,
          registered_at, baseline_start, baseline_end, check_offsets, thresholds, note,
          status, outcome, closed_at, outcome_note, readback_bead)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::date, $11::date,
               $12::integer[], $13::jsonb, $14, $15, $16, $17::timestamptz, $18, $19)`,
      [
        tx.workspaceId,
        window.id,
        window.asset,
        window.refKind ?? "manual",
        window.ref,
        window.integration ?? "ga4",
        window.metric ?? "active_users",
        window.scope ?? null,
        window.registeredAt,
        window.baselineStart,
        window.baselineEnd,
        window.offsets,
        window.thresholds ?? null,
        window.note ?? null,
        window.closed ? "closed" : "open",
        window.closed?.outcome ?? null,
        window.closed?.at ?? null,
        window.closed?.note ?? null,
        window.readbackBead ?? null,
      ],
    );
    const last = Math.max(...window.offsets);
    for (const offset of window.read ?? []) {
      const day = new Date(Date.parse(`${window.registeredAt.slice(0, 10)}T00:00:00.000Z`) + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await tx.execute(
        `INSERT INTO noticeos.watch_window_readings
           (workspace_id, window_id, offset_days, check_date, checked_at, final, pre_change_days)
         VALUES ($1::uuid, $2, $3, $4::date, $5::timestamptz, $6, 0)`,
        [tx.workspaceId, window.id, offset, day, `${day}T03:30:00.000Z`, offset === last],
      );
    }
  });
}
