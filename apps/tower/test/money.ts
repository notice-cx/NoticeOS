// THE MONEY A TEST SEEDS, ON POSTGRES (beads ro-ujb9.76.6.1, ro-ujb9.76.5.5).
//
// The ledger and Mediavine's daily revenue are read from the call's store, so a
// test writes them there, through the application role, into the store its
// reader takes (`ctx.call`, test/sites.ts): its sites must be there
// first, since every row names one. A test that writes gets that copy to
// itself, so write in the tests that read money, never in a seed every test in
// a file runs: a shared seed that writes Postgres gives every test its own
// copy, and the suite queues on them.
//
// A fixture names its entries by D1-style ids (`id: 1`, `supersedes_id: 1`).
// Those are the fixture's own names: the store hands out each entry's identity
// and its workspace number, and a correction's link is resolved from the name
// to the identity the store gave the entry it names. An estimate's coverage is
// read from its note by the one rule the importer and the ledger route apply.
import { mediavineCoverage } from "@noticeos/contract/ledger-coverage";
import type { WorkspaceStore } from "@noticeos/postgres";

/** One ledger row as a D1 fixture wrote it: a 'YYYY-MM' period, integer cents. */
export interface LedgerRow {
  /** The fixture's name for this entry, for a later row's `supersedes_id`. */
  id?: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  amount_minor: number;
  booking_state: "estimated" | "reconciled";
  supersedes_id?: number | null;
  currency?: string;
  source?: string | null;
  ref?: string | null;
  note?: string | null;
  recorded_at?: string;
  external_id?: string | null;
}

/** The identity and the workspace number each fixture name was booked under, per store. */
const booked = new WeakMap<WorkspaceStore, Map<number, { entryId: bigint; number: number }>>();

/** The number the store handed the entry a fixture named `name`: what a page shows as its id. */
export function bookedNumber(store: WorkspaceStore, name: number): number {
  const found = booked.get(store)?.get(name);
  if (found === undefined) throw new Error(`bookedNumber: entry ${name} was not booked in this store`);
  return found.number;
}

/** Book these entries in order, each in the next workspace number. */
export async function bookLedger(store: WorkspaceStore, rows: readonly LedgerRow[]): Promise<void> {
  const names = booked.get(store) ?? new Map<number, { entryId: bigint; number: number }>();
  booked.set(store, names);
  await store.write(async (tx) => {
    for (const row of rows) {
      let supersedes: bigint | null = null;
      if (row.supersedes_id !== undefined && row.supersedes_id !== null) {
        const target = names.get(row.supersedes_id);
        if (target === undefined) throw new Error(`bookLedger: entry ${row.supersedes_id} was not booked in this store`);
        supersedes = target.entryId;
      }
      const [written] = await tx.query<{ entry_id: bigint; entry_number: bigint }>(
        `INSERT INTO noticeos.ledger_entries
           (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, source, ref, booking_state,
            supersedes_id, note, recorded_at, external_id, coverage_end)
         VALUES ($1::uuid, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()), $14, $15::date)
         RETURNING entry_id, entry_number`,
        [
          tx.workspaceId,
          row.kind,
          row.asset,
          `${row.period}-01`,
          row.family,
          row.amount_minor,
          row.currency ?? "USD",
          row.source ?? null,
          row.ref ?? null,
          row.booking_state,
          supersedes,
          row.note ?? null,
          row.recorded_at ?? null,
          row.external_id ?? null,
          mediavineCoverage({ kind: row.kind, family: row.family, source: row.source ?? null, note: row.note ?? null }, row.period).end,
        ],
      );
      if (row.id !== undefined) names.set(row.id, { entryId: written!.entry_id, number: Number(written!.entry_number) });
    }
  });
}

/** One Mediavine attempt and the days it reported, as the collector writes them. */
export interface MediavineRunRow {
  /** The run's own text id. */
  id: string;
  asset: string;
  siteId: string;
  start: string;
  end: string;
  attemptedAt: string;
  outcome?: "success" | "incomplete" | "failed";
  message?: string | null;
  /** Report days and their cents, each recorded at `recordedAt`. */
  days?: readonly (readonly [date: string, amountMinor: number])[];
  recordedAt?: string;
}

/** Map `siteId` to `asset` (kept when already held), write each run, then its days. */
export async function writeMediavine(store: WorkspaceStore, runs: readonly MediavineRunRow[]): Promise<void> {
  await store.write(async (tx) => {
    for (const run of runs) {
      await tx.execute(
        "INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING",
        [tx.workspaceId, run.siteId, run.asset],
      );
      const [written] = await tx.query<{ run_seq: bigint }>(
        `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome, message)
         VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, $8, $9) RETURNING run_seq`,
        [tx.workspaceId, run.id, run.asset, run.siteId, run.start, run.end, run.attemptedAt, run.outcome ?? "success", run.message ?? null],
      );
      for (const [date, amountMinor] of run.days ?? []) {
        await tx.execute(
          `INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
           VALUES ($1::uuid, $2, $3, $4, $5::date, $6, $7::timestamptz)`,
          [tx.workspaceId, written!.run_seq, run.asset, run.siteId, date, amountMinor, run.recordedAt ?? run.attemptedAt],
        );
      }
    }
  });
}

/** Map a Mediavine site to a site of ours, with no report yet. */
export async function mapMediavineSite(store: WorkspaceStore, siteId: string, asset: string): Promise<void> {
  await store.write((tx) =>
    tx.execute("INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ($1::uuid, $2, $3)", [
      tx.workspaceId,
      siteId,
      asset,
    ]),
  );
}
