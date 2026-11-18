import { env } from 'cloudflare:test';
import { loadMeteredDataBudget, loadMeteredDataSpend } from '@noticeos/contract';
import { openWorkspaceStore, type WorkspaceStore } from '@noticeos/postgres';
import { beforeEach, expect, it, vi } from 'vitest';
import { canReserveDataForSeo, reserveDataForSeo, settleDataForSeo } from '../src/dataforseo-budget.js';
import { DATAFORSEO_CHECKPOINT_PREFIX, runDataForSeoDumps, runDataForSeoRecovery } from '../src/dataforseo-dumps.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runCustomerDataForSeo } from '../src/customer-dataforseo.js';
import { putCredential, resolveCredential } from '../src/credentials.js';
import { EgressGate, openEgressLaneRecord } from '../src/egress.js';
import { ARCHIVE_RUNS, asOwner, cutUplink, emptyTables, pgFirst, reset } from './helpers.js';

const AUGUST = Date.parse('2026-08-31T23:59:59.000Z');
const SEPTEMBER = Date.parse('2026-09-01T00:00:00.000Z');
const options = { nowMs: AUGUST, login: 'fixture-login', password: 'fixture-password', retryBackoffMs: [0],
  scope: { asset: 'northwind.example', families: ['backlinks-summary'] } };

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
});

async function saveCap(dataUsd: number): Promise<void> {
  expect((await seedConfigDocuments(env, { documents: { 'config/constants.json': { monthly_caps: { data_usd: dataUsd } } },
    actor: 'config:seed' }, AUGUST)).ok).toBe(true);
}

it('serializes competing reservations and keeps an unsettled request out of replay', async () => {
  const reserve = (key: string, nowMs = AUGUST, store = env.STORE, fenceUnsettled = false) => reserveDataForSeo(store, {
    asset: 'northwind.example', requestKey: key.repeat(64), requestClock: () => nowMs, capUsd: 0.25, reserveUsd: 0.25, fenceUnsettled,
  });
  const written = gate<void>(), release = gate<void>(), entered = gate<number>();
  const uncommitted: WorkspaceStore = { ...env.STORE, write: work => env.STORE.write(async tx => {
    const result = await work(tx);
    written.resolve();
    await release.promise;
    return result;
  }) };
  const contender: WorkspaceStore = { ...env.STORE, write: work => env.STORE.write(async tx => {
    const [row] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    entered.resolve(row!.pid);
    return work(tx);
  }) };
  const first = reserve('a', AUGUST, uncommitted, true);
  let second: ReturnType<typeof reserve> | undefined, secondFinished = false;
  try {
    await Promise.race([written.promise, first]);
    second = reserve('b', AUGUST, contender).finally(() => { secondFinished = true; });
    const pid = await Promise.race([entered.promise, second.then(() => 0)]);
    const until = Date.now() + 5_000;
    const waiting = await env.STORE.read(async tx => {
      while (!secondFinished && Date.now() < until) {
        const [row] = await tx.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting', [pid]);
        if (row?.waiting) return true;
      }
      return false;
    });
    expect(waiting).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
  const winning = await first;
  expect((await second)?.kind).toBe('budget_exhausted');
  expect((await reserve('a', SEPTEMBER)).kind).toBe('dataforseo_uncertain');
  expect((await reserve('c', SEPTEMBER)).kind).toBe('reserved');
  expect((await reserve('c', SEPTEMBER, env.STORE, true)).kind).toBe('dataforseo_uncertain');
  if (winning.kind !== 'reserved') throw new Error('The budget must admit one request.');
  await settleDataForSeo(env.STORE, winning.attemptId, 0.05, true);
  // The provider response is settled, and its archive is still absent.
  const later = Date.parse('2026-10-01T00:00:00Z');
  expect((await reserve('a', later, env.STORE, true)).kind).toBe('dataforseo_already_purchased');
  expect((await reserve('a', later)).kind).toBe('dataforseo_already_purchased');
  await expect(settleDataForSeo(env.STORE, winning.attemptId, 0)).rejects.toThrow();
  await expect(env.STORE.write(tx => tx.execute(`UPDATE noticeos.dataforseo_request_charges
    SET provider_completed=false WHERE attempt_id=$1::uuid`, [winning.attemptId]))).rejects.toThrow(/only be established once/u);
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

it('reads the same balance the collector enforces and moves a held charge to confirmed spend once', async () => {
  await saveCap(1);
  const primary = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId: await env.STORE.workspaceId() });
  const otherId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES('${otherId}','budget-fixture','Budget fixture');
    INSERT INTO noticeos.assets (workspace_id,asset_id,display_name,status) VALUES('${otherId}','northwind.example','Northwind','live');`);
  const other = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId: otherId });
  const reserve = async (store: WorkspaceStore, key: string, month: number) => {
    const result = await reserveDataForSeo(store, { asset: 'northwind.example', requestKey: key.repeat(64),
      requestClock: () => month, reserveUsd: 0.25, capUsd: 1, fenceUnsettled: true });
    if (result.kind !== 'reserved') throw new Error(`Unexpected reservation result: ${result.kind}`);
    return result.attemptId;
  };
  const read = (store: WorkspaceStore, month: number) => loadMeteredDataBudget(store, new Date(month), 2);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Budget reads use the local store'));
  try {
    await reserve(primary, 'a', AUGUST);
    const confirmed = await reserve(primary, 'b', SEPTEMBER);
    await settleDataForSeo(primary, confirmed, 0.12, true);
    const held = await reserve(primary, 'c', SEPTEMBER);
    await reserve(other, 'c', SEPTEMBER);
    const previous = await read(primary, AUGUST);
    const neighbor = await read(other, SEPTEMBER);
    expect(previous).toMatchObject({ spentUsd: 0, budget: { heldUsd: 0.25, availableUsd: 0.75 } });
    expect(neighbor).toMatchObject({ spentUsd: 0, budget: { heldUsd: 0.25, availableUsd: 1.75 } });
    expect(await loadMeteredDataBudget(other, new Date(SEPTEMBER), 2, true))
      .toMatchObject({ capUsd: 0, spentUsd: 0, budget: { heldUsd: 0.25, availableUsd: 0 } });
    expect(await canReserveDataForSeo(other, SEPTEMBER, 0.25, 2, true)).toBe(false);
    expect(await canReserveDataForSeo(other, SEPTEMBER, 1.75, 2)).toBe(true);
    const balance = await loadMeteredDataBudget(primary, new Date(SEPTEMBER), 2, true);
    expect(balance).toMatchObject({ capUsd: 1, spentUsd: 0.12, budget: { heldUsd: 0.25, availableUsd: 0.63 } });
    expect(await canReserveDataForSeo(primary, SEPTEMBER, balance.budget.availableUsd, 2, true)).toBe(true);
    expect(await canReserveDataForSeo(primary, SEPTEMBER, 0.630001, 2, true)).toBe(false);
    await settleDataForSeo(primary, held, 0.05, true);
    await expect(settleDataForSeo(primary, held, 0.05, true)).rejects.toThrow();
    expect(await read(primary, SEPTEMBER)).toMatchObject({ spentUsd: 0.17, budget: { heldUsd: 0, availableUsd: 0.83 } });
    expect(await read(primary, AUGUST)).toEqual(previous);
    expect(await read(other, SEPTEMBER)).toEqual(neighbor);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await Promise.all([primary.close(), other.close()]);
    await asOwner(['dataforseo_request_charges', 'assets', 'workspace_counters', 'workspaces']
      .map(table => `DELETE FROM noticeos.${table} WHERE workspace_id='${otherId}';`).join('\n'));
  }
});

it.each([
  ['envelope', 503, { status_code: 50000, cost: 0.02 }],
  ['task', 200, { status_code: 20000, cost: 0.02, tasks: [{ status_code: 40101, result: null }] }],
] as const)('retries a confirmed %s failure when the next request fits the budget', async (_location, status, failure) => {
  await saveCap(0.50);
  let paid = 0;
  const fetchImpl: typeof fetch = async () => {
    if (++paid === 1) return Response.json(failure, { status });
    return Response.json({ status_code: 20000, cost: 0.05,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  expect(await runDataForSeoDumps(env, { ...options, fetchImpl, monthlyCapUsd: 0.50, fenceUnsettled: true }))
    .toMatchObject({ succeeded: 1, costUsd: 0.07, outcomes: [{ retries: 1 }] });
  expect(paid).toBe(2);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBeCloseTo(0.07);
  expect(await pgFirst(`SELECT count(*)::int AS attempts, count(*) FILTER (WHERE provider_completed)::int AS completed
    FROM noticeos.dataforseo_request_charges`)).toEqual({ attempts: 2, completed: 1 });
});

it('blocks exact replay of an ambiguous customer purchase after return to standalone', async () => {
  await saveCap(1);
  let paid = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method !== 'POST') return new Response(null, { status: 204 });
    paid += 1;
    throw new TypeError('fixture response lost');
  };
  const run = () => runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true });
  expect(await run()).toMatchObject({ failed: 1, costUsd: 0, outcomes: [{ retries: 0 }] });
  expect(await run()).toMatchObject({ failed: 1, outcomes: [{ errorCode: 'dataforseo_uncertain' }] });
  const offline = new EgressGate(env, { lane: 'dataforseo', fetchImpl: cutUplink(fetchImpl), at: new Date(AUGUST).toISOString() });
  expect(await offline.isDown()).toBe(true);
  offline.recordUnmeasured(options.scope.asset, options.scope.families[0]);
  await offline.finalize();
  expect(await runDataForSeoRecovery(env, { ...options, fetchImpl })).toMatchObject({ failed: 1,
    outcomes: [{ asset: options.scope.asset, report: options.scope.families[0], errorCode: 'dataforseo_uncertain' }] });
  expect(paid).toBe(1);
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.000001, 0.25)).toBe(false);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBe(0);
});

it('settles a provider-confirmed charge even if the completed result is malformed', async () => {
  await saveCap(1);
  let paid = 0;
  const fetchImpl: typeof fetch = async () => {
    paid += 1;
    return Response.json({ status_code: 20000, cost: 0.03,
      tasks: [{ status_code: 20000, result: [{ items_count: 2, items: [{ fixture: true }] }] }] });
  };
  const run = () => runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true,
    scope: { asset: options.scope.asset, families: ['ranked-keywords'] } });
  expect(await run()).toMatchObject({ failed: 1, costUsd: 0.03, outcomes: [{ errorCode: 'dataforseo_invalid_response' }] });
  expect(await run()).toMatchObject({ failed: 1, costUsd: 0, outcomes: [{ errorCode: 'dataforseo_already_purchased' }] });
  expect(paid).toBe(1);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBeCloseTo(0.03);
});

it.each([
  ['missing task status', 503, { status_code: 20000, cost: 0.03, tasks: [{ result: null }] }],
  ['conflicting prices', 200, { status_code: 20000, cost: 0, tasks: [{ status_code: 20000, cost: 0.03, result: [] }] }],
] as const)('holds the reservation for %s instead of repeating the purchase', async (_cause, status, reply) => {
  await saveCap(1);
  let paid = 0;
  const fetchImpl: typeof fetch = async () => {
    paid += 1;
    return Response.json(reply, { status });
  };
  const run = () => runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true });
  expect(await run()).toMatchObject({ failed: 1, outcomes: [{ errorCode: 'dataforseo_uncertain', retries: 0, unconfirmedCost: true }] });
  expect(await run()).toMatchObject({ failed: 1, outcomes: [{ errorCode: 'dataforseo_uncertain' }] });
  expect(paid).toBe(1);
  expect(await pgFirst(`SELECT provider_cost_usd AS cost FROM noticeos.dataforseo_request_charges`)).toEqual({ cost: null });
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.000001, 0.25)).toBe(false);
});

it('does not repurchase an answered report when its archive is missing', async () => {
  await saveCap(1);
  let paid = 0;
  const fetchImpl: typeof fetch = async () => {
    paid += 1;
    return Response.json({ status_code: 20000, cost: 0.03,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  const put = vi.spyOn(env.RAW_SIGNALS, 'put').mockRejectedValue(new Error('Synthetic archive write failure'));
  try {
    expect(await runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true })).toMatchObject({
      failed: 1, outcomes: [{ errorCode: 'local_store_failed', objectKey: null }], costUsd: 0.03,
    });
  } finally { put.mockRestore(); }
  expect(await runDataForSeoDumps(env, { ...options, fetchImpl })).toMatchObject({
    failed: 1, outcomes: [{ errorCode: 'dataforseo_already_purchased' }], costUsd: 0,
  });
  expect(paid).toBe(1);
  expect((await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).spentUsd).toBeCloseTo(0.03);
});

it('promotes a staged ordinary report with no available purchase budget, then removes the staging object', async () => {
  await saveCap(0.25);
  let paid = 0, checkpointKey = '';
  const fetchImpl: typeof fetch = async () => {
    paid += 1;
    return Response.json({ status_code: 20000, cost: 0.03,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  const put = env.RAW_SIGNALS.put.bind(env.RAW_SIGNALS);
  const brokenArchive = vi.spyOn(env.RAW_SIGNALS, 'put').mockImplementation((key, value, settings) => {
    if (!key.includes(DATAFORSEO_CHECKPOINT_PREFIX + '/')) throw new Error('Synthetic final archive write failure');
    checkpointKey = key;
    return put(key, value, settings);
  });
  const run = () => runDataForSeoDumps(env, { ...options, fetchImpl, monthlyCapUsd: 0.25, fenceUnsettled: true });
  try {
    expect(await run()).toMatchObject({ failed: 1, costUsd: 0.03, outcomes: [{ errorCode: 'local_store_failed' }] });
  } finally { brokenArchive.mockRestore(); }
  expect(checkpointKey).not.toBe('');
  expect(await env.RAW_SIGNALS.head(checkpointKey)).not.toBeNull();
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.25, 0.25)).toBe(false);
  const repaired = await run();
  expect(repaired).toMatchObject({ succeeded: 1, failed: 0, costUsd: 0 });
  expect(await env.RAW_SIGNALS.head(repaired.outcomes[0]!.objectKey!)).not.toBeNull();
  expect(await env.RAW_SIGNALS.head(checkpointKey)).toBeNull();
  expect(paid).toBe(1);
  expect(await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).toMatchObject({ spentUsd: 0.03, unknownPrices: 0 });
});

it('reports a confirmed zero-priced customer report as a known amount', async () => {
  await saveCap(1);
  const fetchImpl: typeof fetch = async () => Response.json({ status_code: 20000, cost: 0,
    tasks: [{ status_code: 20000, cost: 0, result: [] }] });
  expect(await runDataForSeoDumps(env, { ...options, fetchImpl, fenceUnsettled: true })).toMatchObject({ succeeded: 1, costUsd: 0 });
  expect(await loadMeteredDataSpend(env.STORE, new Date(AUGUST))).toMatchObject({ spentUsd: 0, unknownPrices: 0 });
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
  expect(await putCredential(customer, { provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'fixture-login', DATAFORSEO_PASSWORD: 'fixture-password' } }))
    .toMatchObject({ ok: true });
  const { connectionId, secretVersion } = await resolveCredential(customer, 'dataforseo', 'store-only');
  const approval = { workspaceId: await env.STORE.workspaceId(), connectionId: connectionId!, secretVersion: secretVersion!,
    assets: [{ asset: 'northwind.example', families: ['ranked-keywords', 'backlinks-summary'] }],
    approvedMonthlyCapUsd: 1, weekly: true, recovery: true };
  const run = (job: 'dataforseo' | 'dataforseo-recovery') => runCustomerDataForSeo(customer,
    { approval, job, signal: new AbortController().signal, authorizePurchase: async () => undefined }, { fetchImpl, nowMs: AUGUST });
  await expect(run('dataforseo')).rejects.toThrow(/monthly data cap/u);
  expect(paidTargets).toEqual([]);
  await saveCap(0.26);
  expect(await run('dataforseo-recovery')).toMatchObject({ attempted: 0 });
  expect(paidTargets).toEqual([]);
  const weekly = await run('dataforseo');
  expect(weekly.succeeded).toBe(1);
  expect(weekly.outcomes.every(outcome => outcome.asset === 'northwind.example')).toBe(true);
  expect(weekly.outcomes.some(outcome => outcome.errorCode === 'budget_exhausted')).toBe(true);
  expect(paidTargets).toEqual(['northwind.example']);
  expect(await putCredential(customer, { provider: 'dataforseo',
    fields: { DATAFORSEO_LOGIN: 'replacement-login', DATAFORSEO_PASSWORD: 'replacement-password' } })).toMatchObject({ ok: true });
  await expect(run('dataforseo')).rejects.toThrow(/renew its paid scheduling approval/u);
  expect(paidTargets).toEqual(['northwind.example']);
});

it('allows recovery on its own for approved outage gaps only', async () => {
  const customer = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
  await saveCap(1);
  expect(await putCredential(customer, { provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'fixture-login', DATAFORSEO_PASSWORD: 'fixture-password' } }))
    .toMatchObject({ ok: true });
  const { connectionId, secretVersion } = await resolveCredential(customer, 'dataforseo', 'store-only');
  const property = 'northwind.example';
  const approval = { workspaceId: await env.STORE.workspaceId(), connectionId: connectionId!, secretVersion: secretVersion!,
    assets: [{ asset: property, families: ['backlinks-summary'] }], approvedMonthlyCapUsd: 1, weekly: false, recovery: true };
  const offline = new EgressGate(customer, { lane: 'dataforseo',
    fetchImpl: cutUplink(async () => new Response(null, { status: 204 })), at: new Date(AUGUST).toISOString() });
  expect(await offline.isDown()).toBe(true);
  offline.recordUnmeasured(property, 'backlinks-summary');
  offline.recordUnmeasured(property, 'backlinks-anchors');
  await offline.finalize();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.method !== 'POST') return Response.json({ status_code: 20000, tasks: [] });
    calls.push(String(input));
    return Response.json({ status_code: 20000, cost: 0.03,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  const run = (job: 'dataforseo' | 'dataforseo-recovery') => runCustomerDataForSeo(customer,
    { approval, job, signal: new AbortController().signal, authorizePurchase: async () => undefined }, { fetchImpl, nowMs: SEPTEMBER });
  await expect(run('dataforseo')).rejects.toThrow(/paid DataForSEO schedule is unavailable/iu);
  expect(calls).toEqual([]);
  expect(await run('dataforseo-recovery')).toMatchObject({ attempted: 1, succeeded: 1, costUsd: 0.03 });
  expect(calls.map(url => new URL(url).pathname)).toEqual(['/v3/backlinks/summary/live']);
  expect((await openEgressLaneRecord(customer, 'dataforseo'))?.parts).toEqual({ [property]: ['backlinks-anchors'] });
});

it('returns an unused reservation when the purchase grant is withdrawn after admission', async () => {
  let purchased = false;
  const fetchImpl: typeof fetch = async () => {
    purchased = true;
    throw new Error('The provider must see no request.');
  };
  const controller = new AbortController();
  await expect(runDataForSeoDumps(env, { ...options, monthlyCapUsd: 0.25, signal: controller.signal, fetchImpl,
    async authorizePurchase() { controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(purchased).toBe(false);
  expect(await pgFirst(`SELECT provider_cost_usd::double precision AS cost FROM noticeos.dataforseo_request_charges`)).toEqual({ cost: 0 });
  expect(await canReserveDataForSeo(env.STORE, AUGUST, 0.25, 0.25)).toBe(true);
});
