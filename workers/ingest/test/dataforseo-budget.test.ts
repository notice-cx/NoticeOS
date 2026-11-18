import { env } from 'cloudflare:test';
import { loadMeteredDataSpend } from '@noticeos/contract';
import { beforeEach, expect, it } from 'vitest';
import { canReserveDataForSeo, reserveDataForSeo, settleDataForSeo } from '../src/dataforseo-budget.js';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runCustomerDataForSeo } from '../src/customer-dataforseo.js';
import { putCredential } from '../src/credentials.js';
import { ARCHIVE_RUNS, emptyTables, pgFirst, reset } from './helpers.js';

const AUGUST = Date.parse('2026-08-31T23:59:59.000Z');
const SEPTEMBER = Date.parse('2026-09-01T00:00:00.000Z');
const options = { nowMs: AUGUST, login: 'fixture-login', password: 'fixture-password', retryBackoffMs: [0],
  scope: { asset: 'northwind.example', families: ['backlinks-summary'] } };

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
});

it('serializes competing reservations and keeps an unsettled request out of replay', async () => {
  const reserve = (key: string, nowMs = AUGUST, fenceUnsettled = false) => reserveDataForSeo(env.STORE, {
    asset: 'northwind.example', requestKey: key.repeat(64), requestClock: () => nowMs, capUsd: 0.25, reserveUsd: 0.25, fenceUnsettled,
  });
  const results = await Promise.all([reserve('a'), reserve('b')]);
  expect(results.map(result => result.kind).sort()).toEqual(['budget_exhausted', 'reserved']);
  const first = results.findIndex(result => result.kind === 'reserved');
  const winning = results[first]!;
  const key = first === 0 ? 'a' : 'b';
  expect((await reserve(key, SEPTEMBER, true)).kind).toBe('dataforseo_uncertain');
  expect((await reserve('c', SEPTEMBER)).kind).toBe('reserved');
  if (winning.kind !== 'reserved') throw new Error('The budget must admit one request.');
  await settleDataForSeo(env.STORE, winning.attemptId, 0.05);
  await expect(settleDataForSeo(env.STORE, winning.attemptId, 0)).rejects.toThrow();
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.2, 0.25)).toBe(true);
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.200001, 0.25)).toBe(false);
});

it('counts billed retries once in the month of each purchase even when the report date is earlier', async () => {
  let clock = AUGUST;
  const fetchImpl: typeof fetch = async () => {
    if (clock === AUGUST) {
      clock = SEPTEMBER;
      return Response.json({ status_code: 50000, cost: 0.08 }, { status: 503 });
    }
    return Response.json({ status_code: 20000, cost: 0.05,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  const result = await runDataForSeoDumps(env, { ...options, fetchImpl, requestClock: () => clock });
  expect(result).toMatchObject({ succeeded: 1, outcomes: [{ retries: 1 }] });
  expect(result.costUsd).toBeCloseTo(0.13);
  expect(await pgFirst(`SELECT provider_cost_usd::double precision AS cost FROM ${ARCHIVE_RUNS} WHERE report='backlinks-summary'`))
    .toEqual({ cost: 0.13 });
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.92, 1)).toBe(true);
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.920001, 1)).toBe(false);
  expect(await canReserveDataForSeo(env.STORE, SEPTEMBER, 0.95, 1)).toBe(true);
  expect(await canReserveDataForSeo(env.STORE, SEPTEMBER, 0.950001, 1)).toBe(false);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBeCloseTo(0.08);
  expect((await loadMeteredDataSpend(env.STORE, new Date(SEPTEMBER))).byAsset).toEqual([
    { asset: 'northwind.example', spentUsd: 0.05, unknownPrices: 0 },
  ]);
});

it('uses no paid retry after an ambiguous customer response and refuses exact replay', async () => {
  const seeded = await seedConfigDocuments(env, { documents: { 'config/constants.json': { monthly_caps: { data_usd: 1 } } }, actor: 'config:seed' }, AUGUST);
  expect(seeded.ok).toBe(true);
  let paid = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method !== 'POST') return new Response(null, { status: 204 });
    paid += 1;
    throw new TypeError('fixture response lost');
  };
  const run = () => runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true });
  expect(await run()).toMatchObject({ failed: 1, costUsd: 0, outcomes: [{ retries: 0 }] });
  expect(await run()).toMatchObject({ failed: 1, outcomes: [{ errorCode: 'dataforseo_uncertain' }] });
  expect(paid).toBe(1);
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.000001, 0.25)).toBe(false);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBe(0);
});

it('collects only an approved customer property and requires a saved budget', async () => {
  const customer = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
  const paidTargets: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method !== 'POST') return Response.json({ status_code: 20000, tasks: [] });
    const [report] = JSON.parse(String(init.body));
    paidTargets.push(report.target);
    return Response.json({ status_code: 20000, cost: 0.02,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  const input = { assets: ['northwind.example'], approvedMonthlyCapUsd: 1, signal: new AbortController().signal };
  const run = (job: 'dataforseo' | 'dataforseo-recovery') => runCustomerDataForSeo(customer, { ...input, job }, { fetchImpl, nowMs: AUGUST });
  await expect(run('dataforseo')).rejects.toThrow(/monthly data cap/u);
  expect(paidTargets).toEqual([]);
  expect((await seedConfigDocuments(env, { documents: { 'config/constants.json': { monthly_caps: { data_usd: 0.26 } } }, actor: 'config:seed' }, AUGUST)).ok).toBe(true);
  expect(await putCredential(customer, { provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'fixture-login', DATAFORSEO_PASSWORD: 'fixture-password' } }))
    .toMatchObject({ ok: true });
  expect(await run('dataforseo-recovery')).toMatchObject({ attempted: 0 });
  expect(paidTargets).toEqual([]);
  const weekly = await run('dataforseo');
  expect(weekly.succeeded).toBe(1);
  expect(weekly.outcomes.every(outcome => outcome.asset === 'northwind.example')).toBe(true);
  expect(weekly.outcomes.some(outcome => outcome.errorCode === 'budget_exhausted')).toBe(true);
  expect(paidTargets).toEqual(['northwind.example']);
});
