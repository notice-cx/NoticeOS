/** Private simulator adapter. The caller supplies a freshly admitted, fixed
 * demo workspace and owns its transaction/checkpoint. No HTTP entry, provider,
 * credential, operator token or custom rule is accepted here. */
import type { WorkspaceStore } from '@noticeos/postgres';
import type { DemoActivityCollection, DemoActivityDay } from '../../../scripts/demo-activity.mjs';
import type { BeadsSnapshotInput } from '@noticeos/contract/task-snapshot';
import { ingestPulseEnvelope, runAssetZeroPulse } from './db.js';
import { recordSignalFailure, recordSignalSuccess, SignalError } from './signal-store.js';
import { importLedgerRows } from './routes/revenue.js';
import { persistReport } from './mediavine.js';
import { dates, pacificDay, shiftDate } from '@noticeos/mediavine';
import { writeBeadsSnapshot } from './beads-snapshots.js';
import { runWatchWindows, type WatchWindowEvaluation } from './watch-windows.js';
import { writeAnnotation } from './annotations.js';
import { writeWatchWindow } from './routes/watch-windows.js';
import { writeInsightSnapshot } from './insight-snapshots.js';

const DAY_MS = 86_400_000;

export async function writeDemoActivity(store: WorkspaceStore, day: DemoActivityDay): Promise<{
  written: number; assets: number; date: string; changes: number; reports: number;
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
  // A ship's change and its comparison, and a Monday's search reports, go
  // through the same writers an operator's annotation, bet and published
  // analysis do. Their instants sit inside the day being written, which a
  // catch-up may write after it ended: the writers' clock is that day's end
  // at the earliest, never a backdated "now".
  const ingest = env as unknown as IngestEnv;
  const clockMs = Math.max(Date.now(), Date.parse(`${day.date}T00:00:00.000Z`) + DAY_MS);
  for (const change of day.changes) {
    const annotation = await writeAnnotation(ingest, { asset: change.asset, kind: change.kind, at: change.at, ref: change.ref, note: change.note }, clockMs);
    if (!annotation.ok) throw new Error('Synthetic change refused by the ordinary writer.');
    const watch = await writeWatchWindow(ingest, { asset: change.asset, ref_kind: 'annotation', ref: change.ref,
      metric_integration: change.watch.metricIntegration, metric: change.watch.metric, registered_at: change.at,
      baseline_start: change.watch.baselineStart, baseline_end: change.watch.baselineEnd, check_offsets: change.watch.checkOffsets,
      thresholds: change.watch.thresholds, note: change.watch.note }, clockMs);
    if (!watch.ok) throw new Error('Synthetic comparison refused by the ordinary writer.');
    written += 2;
  }
  for (const report of day.reports) {
    const result = await writeInsightSnapshot(ingest, JSON.stringify(report), clockMs);
    if (!result.ok) throw new Error('Synthetic search report refused by the ordinary writer.');
    written++;
  }
  // Observe the actual stored inputs at execution time. Catch-up never forges
  // an earlier OS report or successful provider/scheduler activity.
  if (await runAssetZeroPulse(env) === null) throw new Error('Demo OS observation has no asset.');
  return { written: written + 1, assets: day.assets.length, date: day.date, changes: day.changes.length, reports: day.reports.length };
}

/** One quarter-hour refresh through the ordinary signal writer: today's
 * provisional counts, or a recorded failure for a report the scenario keeps
 * missing — never a zero standing in for it. Outcomes follow the Google
 * collector's per-property shape, so the run names what it could not read. */
export async function writeDemoCollection(store: WorkspaceStore, collection: DemoActivityCollection): Promise<{
  succeeded: number; written: number; outcomes: { asset: string; integration: string; status: 'success' | 'error'; observationCount: number }[];
}> {
  const env = Object.freeze({ STORE: store });
  const window = { start: collection.date, end: collection.date };
  const outcomes: { asset: string; integration: string; status: 'success' | 'error'; observationCount: number }[] = [];
  for (const asset of collection.assets) {
    for (const signal of asset.signals) {
      const target = { asset: asset.asset, integration: signal.integration, propertyRef: signal.propertyRef, credentialRef: signal.credentialRef };
      if (signal.observations === null) {
        await recordSignalFailure(env, target, window, Date.parse(collection.at),
          new SignalError('report_unavailable', 'Synthetic report unavailable for this day.'));
        outcomes.push({ asset: asset.asset, integration: signal.integration, status: 'error', observationCount: 0 });
        continue;
      }
      await recordSignalSuccess(env, target, window, collection.at, {
        observations: signal.observations, providerRows: 1, dataState: 'includes-provisional',
        provisionalFrom: collection.date, timeZone: signal.timeZone,
      });
      outcomes.push({ asset: asset.asset, integration: signal.integration, status: 'success', observationCount: signal.observations.length });
    }
  }
  const succeeded = outcomes.filter(outcome => outcome.status === 'success');
  return { succeeded: succeeded.length, written: succeeded.reduce((sum, outcome) => sum + outcome.observationCount, 0), outcomes };
}

/** The ad network's morning report through the ordinary Mediavine writer:
 * once yesterday is reportable on the network's own clock, every day not yet
 * stored (at most the 31 before yesterday's) arrives in one report. Nothing
 * due is a skipped pass, as the real collector reports it. */
export async function writeDemoAdRevenue(store: WorkspaceStore, input: {
  at: string; sites: readonly { asset: string; siteId: string; since: string }[]; amount(asset: string, date: string): number;
}): Promise<{ succeeded: number; written: number; outcomes: { asset: string; status: 'success'; observationCount: number }[] } | { outcome: 'skipped'; detail: string }> {
  const env = Object.freeze({ STORE: store });
  const skipped = { outcome: 'skipped' as const, detail: 'No Mediavine report is due.' };
  const clock = pacificDay(Date.parse(input.at));
  if (!clock.ready) return skipped;
  const outcomes: { asset: string; status: 'success'; observationCount: number }[] = [];
  for (const site of input.sites) {
    const [last] = await store.read((tx) => tx.query<{ day: string | null }>(
      'SELECT MAX(report_date)::text AS day FROM noticeos.mediavine_current_daily WHERE asset_id = $1', [site.asset]));
    const floor = shiftDate(clock.yesterday, -31);
    const next = last?.day ? shiftDate(last.day, 1) : site.since;
    const start = next < floor ? floor : next;
    if (start > clock.yesterday) continue;
    const daily = dates({ start, end: clock.yesterday }).map(date => ({ date, revenueMinor: input.amount(site.asset, date) }));
    const total = daily.reduce((sum, day) => sum + day.revenueMinor, 0);
    await persistReport(env, site.asset, { site: { id: site.siteId, title: site.asset, domain: site.asset },
      period: { start, end: clock.yesterday }, daily, summaryMinor: total, dailyMinor: total, differenceMinor: 0,
      complete: true, missingDates: [], fetchedAt: input.at });
    outcomes.push({ asset: site.asset, status: 'success', observationCount: daily.length });
  }
  if (outcomes.length === 0) return skipped;
  return { succeeded: outcomes.length, written: outcomes.reduce((sum, outcome) => sum + outcome.observationCount, 0), outcomes };
}

/** The release's outcome check, over the demo's own windows at the
 * scheduler's minute. Its windows read only the store. */
export async function writeDemoOutcomeChecks(store: WorkspaceStore, at: string): Promise<WatchWindowEvaluation> {
  const nowMs = Date.parse(at);
  if (!Number.isFinite(nowMs)) throw new Error('Synthetic outcome check needs its scheduled minute.');
  return runWatchWindows(Object.freeze({ STORE: store }) as unknown as IngestEnv, nowMs);
}

export async function writeDemoTaskSnapshot(store: WorkspaceStore, snapshot: BeadsSnapshotInput): Promise<{ written: number }> {
  const result = await writeBeadsSnapshot({ STORE: store }, snapshot);
  if (!result.ok) throw new Error('Synthetic task summary refused by the ordinary writer.');
  return { written: result.unchanged ? 0 : 1 };
}
