// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PulseEnvelope, evaluatePulse } from '@noticeos/contract';
import { generateDemoScenario, demoScenarioHash, shiftDemoDay } from '../../../scripts/demo-scenario.mjs';
import { fillDemo, demoPulseVerdicts } from '../../../scripts/demo-store.mjs';
import { buildFinancialsPayload } from '../worker/financials-payload';
import { buildWallPayload } from '../worker/wall-payload';
import { buildAssetDetailPayload, type AssetDetailDeps } from '../worker/asset-detail-payload';
import { loadSignalTrends } from '../worker/signal-trends';
import { monthRevenue } from '../src/lib/wall-revenue';
import { portfolioHeadline } from '../src/lib/portfolio-headline';
import { createTestStore, type TestStore } from './postgres-store';

const INPUT = { seed: 'portfolio-v1', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };
const NOW = new Date(INPUT.cutoff);
const scenario = generateDemoScenario(INPUT);
const integrations = { catalog: [], assets: {} };
const detail: AssetDetailDeps = {
  now: NOW, osTimeZone: 'UTC', flagDefaults: {}, monthlyCaps: { dataUsd: 25 }, operatorRateUsdPerMin: 2,
  integrations, counters: { assets: {} }, pullConfig: [], serpPanel: { assets: {} }, signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} },
};
// One filled store for the tests that only read it (issue #24); the refused
// second seed rolls back. A test that fills its own scenario gets its own.
let fixture: TestStore;
beforeAll(async () => {
  fixture = await createTestStore({ scope: 'suite' });
  await fixture.call.write(tx => fillDemo(tx, scenario, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
}, 30_000);
afterAll(async () => {
  await fixture?.close();
});

it('ordinary financials and Wall read the same integer-cents ledger without counting estimates twice', async () => {
  const financials = await buildFinancialsPayload(fixture.call, { now: NOW, osTimeZone: 'UTC', domainOrders: [], period: scenario.manifest.referencePeriod });
  const last = financials.months.find(m => m.period === scenario.manifest.referencePeriod)!;
  expect(last.booked.net).toBe(1720);
  expect(last.estimated.revenue).toBe(0);
  expect(financials.overhead.net).toBe(-210);
  expect(financials.properties.find(p => p.asset === 'lightbrief.example')?.figure.net).toBe(1540);
  expect(financials.properties.find(p => p.asset === 'pinwell.example')?.figure.net).toBe(390);
  const wall = await buildWallPayload(fixture.call, { now: NOW, osTimeZone: 'UTC', constants: { dataUsd: 25 }, integrations, pullConfig: [], dashboard: {}, serpPanel: { assets: {} } });
  const productCards = wall.assets.filter(asset => scenario.assets.some(product => !product.isOs && product.id === asset.id));
  expect(productCards).toHaveLength(3);
  expect(productCards.every(asset => asset.revenueProjection?.status === 'no-revenue')).toBe(true);
  const current = await buildFinancialsPayload(fixture.call, { now: NOW, osTimeZone: 'UTC', domainOrders: [], period: '2026-10' });
  expect(current.months.find(m => m.period === '2026-10')?.estimated.net).toBe(wall.portfolio.forecast.net);
  const corrected = scenario.ledger.find(row => row.asset === 'lightbrief.example' && row.supersedes && row.minor !== scenario.ledger.find(old => old.key === row.supersedes)!.minor)!;
  const correction = await fixture.call.read(tx => tx.query<{ minor: bigint; older: bigint }>(`SELECT current.amount_minor AS minor, old.amount_minor AS older
    FROM noticeos.ledger_entries current JOIN noticeos.ledger_entries old ON old.workspace_id = current.workspace_id AND old.entry_id = current.supersedes_id
    WHERE current.asset_id = $1 AND current.period_month = $2::date AND current.family = 'subs'`, ['lightbrief.example', `${corrected.period}-01`]));
  expect(correction).toHaveLength(1);
  expect(correction[0]!.minor).not.toBe(correction[0]!.older);
});

it('ordinary chart readers preserve provisional values and missing traffic while the young site has only its own history', async () => {
  const signals = await loadSignalTrends(fixture.call, 28, { asset: 'freshrows.example', includeSessions: true, includeSecondarySeries: true, includeWebSearch: true, nowMs: NOW.getTime() });
  const young = signals.get('freshrows.example')!;
  expect([...(young.sessions.contextSeries ?? []), ...young.sessions.series]).toHaveLength(24);
  expect(young.sessions.provisionalFrom).toBe(shiftDemoDay(scenario.manifest.referenceDate, -3));
  const page = await buildAssetDetailPayload(fixture.call, 'pinwell.example', detail);
  expect(page).not.toBeNull();
  const financials = await buildFinancialsPayload(fixture.call, { now: NOW, osTimeZone: 'UTC', domainOrders: [] });
  const missing = scenario.daily.find(d => d.reportMissing)!;
  const matureSignals = await loadSignalTrends(fixture.call, 28, { asset: missing.asset, includeSessions: true, nowMs: NOW.getTime() });
  expect(matureSignals.get(missing.asset)!.sessions.series.some(day => day.t === missing.date)).toBe(false);
  expect(await fixture.call.read(tx => tx.query('SELECT site_id FROM noticeos.mediavine_sites'))).toEqual([]);
  expect(await fixture.call.read(tx => tx.query('SELECT run_seq FROM noticeos.mediavine_runs'))).toEqual([]);
  expect(await fixture.call.read(tx => tx.query('SELECT run_seq FROM noticeos.mediavine_daily'))).toEqual([]);
  const youngMoney = financials.properties.find(p => p.asset === 'freshrows.example')!;
  expect(youngMoney.figure.cost).toBe(60);
  expect(youngMoney.figure.revenue).toBe(0);
  const heldRevenue = await fixture.call.read(tx => tx.query(`SELECT entry_id FROM noticeos.ledger_entries WHERE asset_id = $1 AND kind = 'revenue'`, ['freshrows.example']));
  expect(heldRevenue).toEqual([]);
});

it('pulse validation and the unchanged seasonal evaluator explain the current failure and quiet young site', async () => {
  for (const pulse of scenario.pulses) expect(PulseEnvelope.safeParse(pulse).success).toBe(true);
  const { problem } = scenario.manifest.stories;
  const broken = scenario.pulses.find(p => p.asset === problem.asset && p.date === problem.date)!;
  const verdict = demoPulseVerdicts(scenario, broken, evaluatePulse).find(v => v.outcome === 'fired')!;
  expect(verdict.ruleId).toBe('flow-poisson-low');
  expect(verdict.inputs.baselineSampleSize).toBe(4);
  const rows = await fixture.call.read(tx => tx.query<{ rule: string; inputs: string; resolved: string | null }>('SELECT rule_id AS rule, rule_inputs AS inputs, resolved_at AS resolved FROM noticeos.flags WHERE asset_id = $1', [problem.asset]));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.resolved).toBeNull();
  expect(JSON.parse(rows[0]!.inputs)).toEqual(verdict.inputs);
  const youngest = scenario.pulses.filter(p => p.asset === 'freshrows.example').at(-1)!;
  expect(demoPulseVerdicts(scenario, youngest, evaluatePulse).every(v => v.outcome === 'not-applicable')).toBe(true);
});

it('a second seed refuses and leaves every previously seeded fact unchanged', async () => {
  const before = await fixture.call.read(tx => tx.query('SELECT count(*) AS count, sum(value) AS total FROM noticeos.signal_observations'));
  await expect(fixture.call.write(tx => fillDemo(tx, scenario, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }))).rejects.toThrow('already holding data');
  expect(await fixture.call.read(tx => tx.query('SELECT count(*) AS count, sum(value) AS total FROM noticeos.signal_observations'))).toEqual(before);
  expect(demoScenarioHash(generateDemoScenario(INPUT))).toBe(demoScenarioHash(scenario));
});

it.each(['2026-10-01T07:00:00.000Z', '2026-10-16T12:00:00.000Z'])('current recorded income agrees across Home, Wall and Financials at %s', async cutoff => {
  const own = await createTestStore();
  const facts = generateDemoScenario({ ...INPUT, cutoff });
  await own.call.write(tx => fillDemo(tx, facts, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
  const now = new Date(cutoff);
  const period = cutoff.slice(0, 7);
  const income = facts.ledger.filter(row => row.period === period && row.kind === 'revenue');
  const recorded = income.reduce((sum, row) => sum + row.minor, 0) / 100;
  const wall = await buildWallPayload(own.call, { now, osTimeZone: 'UTC', constants: { dataUsd: 25 }, integrations, pullConfig: [], dashboard: {}, serpPanel: { assets: {} } });
  const financials = await buildFinancialsPayload(own.call, { now, osTimeZone: 'UTC', domainOrders: [], period });
  expect(recorded).toBeGreaterThan(0);
  // Home's money tile uses this exact shared headline derivation.
  expect(portfolioHeadline(wall.portfolio)).toMatchObject({ state: 'booked', figure: { revenue: recorded } });
  expect(monthRevenue(wall.portfolio, wall.assets)).toMatchObject({ period, periodIsCurrent: true, revenue: recorded, state: 'booked', pace: null });
  expect(financials.months.find(month => month.period === period)?.booked.revenue).toBe(recorded);
  expect(financials.properties.find(asset => asset.asset === 'freshrows.example')?.revenueReported).toBe(false);
  expect(financials.properties.filter(asset => ['lightbrief.example', 'pinwell.example'].includes(asset.asset)).every(asset => asset.revenueReported)).toBe(true);
  const saved = await own.call.read(tx => tx.query<{ asset: string; start: string; end: string; complete: boolean }>(`SELECT asset_id AS asset, coverage_start::text AS start, coverage_end::text AS end, coverage_complete AS complete
    FROM noticeos.ledger_entries WHERE kind = 'revenue' AND period_month = $1::date ORDER BY asset_id`, [period + '-01']));
  expect(saved).toEqual(['lightbrief.example', 'pinwell.example'].map(asset => ({ asset, start: period + '-01', end: cutoff.slice(0, 10), complete: false })));
  expect(wall.assets.every(asset => asset.revenueProjection?.status === 'no-revenue')).toBe(true);
});
