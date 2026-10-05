/** Private simulator adapter. The caller supplies a freshly admitted, fixed
 * demo workspace and owns its transaction/checkpoint. No HTTP entry, provider,
 * credential, operator token or custom rule is accepted here. */
import type { WorkspaceStore } from '@noticeos/postgres';
import type { DemoActivityDay } from '../../../scripts/demo-activity.mjs';
import type { BeadsSnapshotInput } from '@noticeos/contract/task-snapshot';
import { ingestPulseEnvelope, runAssetZeroPulse } from './db.js';
import { recordSignalSuccess } from './signal-store.js';
import { importLedgerRows } from './routes/revenue.js';
import { writeBeadsSnapshot } from './beads-snapshots.js';

export async function writeDemoActivity(store: WorkspaceStore, day: DemoActivityDay): Promise<{
  written: number; assets: number; date: string;
}> {
  const env = Object.freeze({ STORE: store });
  let written = 0;
  for (const asset of day.assets) {
    for (const signal of asset.signals) {
      if (signal.observations === null) continue;
      await recordSignalSuccess(env, { asset: asset.asset, integration: signal.integration,
        propertyRef: signal.propertyRef, credentialRef: signal.credentialRef },
      { start: day.date, end: day.date }, new Date().toISOString(), {
        observations: signal.observations, providerRows: 1, dataState: 'final',
        provisionalFrom: null, timeZone: signal.timeZone,
      });
      written += signal.observations.length;
    }
    if (asset.pulse !== null) {
      const result = await ingestPulseEnvelope(env, asset.pulse);
      if (!result.ok) throw new Error('Synthetic report refused by the ordinary writer.');
      written++;
    }
  }
  if (day.money.length) {
    const result = await importLedgerRows(day.money.map(row => ({
      asset: row.asset, kind: row.kind, family: row.family, period: row.period,
      // The ordinary boundary accepts decimal major units and converts once.
      amount: (row.amountMinor / 100).toFixed(2), currency: row.currency,
      booking_state: row.bookingState, source: row.source, external_id: row.externalId,
      note: row.note, coverage_start: row.coverageStart, coverage_end: row.coverageEnd,
      coverage_complete: row.coverageComplete,
    })), store);
    if (result.failed || result.reviewRequired) throw new Error('Synthetic ledger input refused by the ordinary writer.');
    written += result.inserted;
  }
  // Observe the actual stored inputs at execution time. Catch-up never forges
  // an earlier OS report or successful provider/scheduler activity.
  if (await runAssetZeroPulse(env) === null) throw new Error('Demo OS observation has no asset.');
  return { written: written + 1, assets: day.assets.length, date: day.date };
}

export async function writeDemoTaskSnapshot(store: WorkspaceStore, snapshot: BeadsSnapshotInput): Promise<{ written: number }> {
  const result = await writeBeadsSnapshot({ STORE: store }, snapshot);
  if (!result.ok) throw new Error('Synthetic task summary refused by the ordinary writer.');
  return { written: result.unchanged ? 0 : 1 };
}
