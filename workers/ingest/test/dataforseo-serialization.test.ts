// One DataForSEO collection at a time.
//
// The collector has two triggers — the Monday `45 12 * * 1` cron and the
// operator-authed `POST /api/signal-collect`. A double collection does not
// double the archive (`archiveCollectedDump` stores identical content as
// `unchanged`); it doubles the spend, because both runs make every provider
// call, both write manifest rows carrying `provider_cost_usd`, and the cap gate
// reads month-to-date spend once at the top of a run.
//
// Every test here holds the lane with a real run parked inside its first
// provider call, because that is the shape of the overlap: a full-property run
// holds the request open for minutes, the operator's client times out, the run
// carries on server-side invisibly, and firing again is the honest next move.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATAFORSEO_DUMPS_CRON } from '../src/crons.js';
import { runDataForSeoDumps, runDataForSeoRecovery } from '../src/dataforseo-dumps.js';
import { runCron, runScheduledCron } from '../src/dispatch.js';
import { EgressGate } from '../src/egress.js';
import { handleSignalCollect } from '../src/routes/signal-collect.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, cutUplink, pgCount, reset } from './helpers.js';

const NOW = Date.parse('2026-08-04T09:12:00.000Z');
const CREDENTIALS = { login: 'operator-login', password: 'operator-password' };
const DUMP_ROWS = `SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`;
/** The completed, billed calls of one asset: the rows the monthly meter reads. */
const SETTLED_CHARGES = `SELECT count(*) AS n FROM noticeos.dataforseo_request_charges
  WHERE asset_id = $1 AND provider_completed AND provider_cost_usd = 0.011`;

/** A run's end as a value, so a rejection that arrives early is not unhandled. */
function settled<T>(run: Promise<T>): Promise<{ result: T | null; error: unknown }> {
  return run.then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
}

interface Provider {
  fetchImpl: typeof fetch;
  calls: string[];
}

/** A provider that answers every call at once — the challenger's provider, so a
 * call that should never have been made is a recorded call rather than a hang. */
function provider(): Provider {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(requestUrl(input));
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface GatedProvider extends Provider {
  /** Resolves once the holding run is genuinely inside a provider call. */
  readonly started: Promise<void>;
  /** Let the holding run finish. */
  open(): void;
}

/**
 * A provider that parks on its first call until the test says otherwise.
 *
 * This is the whole fixture: a run held here has claimed the lane, has spent one
 * provider call and has written NO manifest row (a family's row is written only
 * after its last request returns), which is exactly the invisible in-flight run
 * the operator would re-fire.
 */
function gatedProvider(): GatedProvider {
  const calls: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let sawFirstCall!: () => void;
  const started = new Promise<void>((resolve) => {
    sawFirstCall = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(requestUrl(input));
    sawFirstCall();
    await gate;
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls, started, open: () => open() };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function answer(): Response {
  return Response.json({
    status_code: 20000,
    status_message: 'Ok.',
    cost: 0.011,
    tasks: [
      {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.011,
        result: [{ items_count: 1, items: [{ ok: true }] }],
      },
    ],
  });
}

interface CollectBody {
  collected?: boolean;
  attempted?: number;
  costUsd?: number;
  error?: string;
  detail?: string;
  asset?: string;
  families?: string[];
  inFlight?: {
    startedAt: string;
    runningSeconds: number;
    scope: { asset: string; families?: string[] | null } | null;
    leaseExpiresAt: string;
  };
}

/** The route with a provider that is never the network. */
async function collect(
  body: unknown,
  options: Parameters<typeof handleSignalCollect>[2],
): Promise<{ status: number; body: CollectBody }> {
  const request = new Request('https://ingest.local/api/signal-collect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const res = await handleSignalCollect(request, env, {
    ...CREDENTIALS,
    ...options,
  });
  return { status: res.status, body: (await res.json()) as CollectBody };
}

beforeEach(reset);

describe('the DataForSEO collector runs one collection at a time', () => {
  /** The refusal names what is running, and pays for nothing. */
  it('refuses a second on-demand run with a 409 naming the run in flight', async () => {
    const holder = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    await holder.started;

    const challenger = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example' },
      { nowMs: NOW, fetchImpl: challenger.fetchImpl },
    );

    expect(status).toBe(409);
    expect(body.error).toBe('collection_in_flight');
    // The two facts the operator came for: when it started, and what it covers.
    expect(body.inFlight).toMatchObject({
      startedAt: '2026-08-04T09:12:00.000Z',
      runningSeconds: 0,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    expect(body.detail).toContain('2026-08-04T09:12:00.000Z');
    expect(body.detail).toContain('northwind.example (serp-panel)');
    expect(body.detail?.length ?? 0).toBeLessThanOrEqual(360);

    // Nothing was asked of the provider and nothing was written. The holder
    // is still parked in its first call, so a row here could only be the
    // refusal's.
    expect(challenger.calls).toEqual([]);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    holder.open();
    await running;
  });

  /** The lane is the run's, not the process's — it comes back on completion. */
  it('collects normally once the run in flight has completed', async () => {
    const holder = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });
    await holder.started;
    expect((await collect({ asset: 'northwind.example' }, { nowMs: NOW, fetchImpl: provider().fetchImpl })).status).toBe(409);

    holder.open();
    const held = await running;
    expect(held.refused).toBeUndefined();
    expect(held.attempted).toBe(1);

    const next = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { nowMs: NOW, fetchImpl: next.fetchImpl },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ collected: true, attempted: 1 });
    expect(next.calls).toHaveLength(1);
    expect(await pgCount(DUMP_ROWS)).toBe(2);
  });

  /** The direction that costs the most: the operator's run is in flight when
   * Monday 12:45 comes round. The cron takes no options, so it collects on the
   * real clock and through the global `fetch` — stubbed here so a serialization
   * that failed would be a recorded call rather than a live, billed one. */
  it('refuses the weekly cron while an on-demand run is in flight', async () => {
    const holder = gatedProvider();
    // No injected clock: the cron reads Date.now(), so the lease it is measured
    // against has to be on the same clock.
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      fetchImpl: holder.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    await holder.started;
    const heldCalls = holder.calls.length;

    const cronFetch = provider();
    vi.stubGlobal('fetch', cronFetch.fetchImpl);
    try {
      await runCron(DATAFORSEO_DUMPS_CRON, env);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(cronFetch.calls).toEqual([]);
    expect(holder.calls).toHaveLength(heldCalls);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    holder.open();
    await running;
  });

  it('reports a weekly sweep blocked by outage recovery as failed and collects only outstanding reports on replay', async () => {
    const asset = 'northwind.example';
    const recoveredReport = 'backlinks-summary';
    const offline = new EgressGate(env, {
      lane: 'dataforseo', at: new Date(NOW).toISOString(), fetchImpl: cutUplink(provider().fetchImpl),
    });
    expect(await offline.isDown()).toBe(true);
    offline.recordUnmeasured(asset, recoveredReport);
    await offline.finalize();

    const holder = gatedProvider();
    const recovery = runDataForSeoRecovery(env, { ...CREDENTIALS, nowMs: NOW, fetchImpl: holder.fetchImpl });
    const weekly = provider();
    vi.stubGlobal('fetch', weekly.fetchImpl);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW + 6 * 60_000);
    try {
      await holder.started;
      const refusal = await runScheduledCron(DATAFORSEO_DUMPS_CRON, env);
      expect(refusal.outcome).toBe('failed');
      expect(refusal.steps?.find((step) => step.id === 'search')?.state).toBe('failed');
      expect(weekly.calls).toEqual([]);
      expect(await pgCount(DUMP_ROWS)).toBe(0);

      // The retry's ten-minute delay crosses the ordinary lease expiry.
      clock.mockReturnValue(NOW + 16 * 60_000);
      expect((await runScheduledCron(DATAFORSEO_DUMPS_CRON, env)).outcome).toBe('failed');
      expect(weekly.calls).toEqual([]);
      expect(await pgCount(DUMP_ROWS)).toBe(0);

      holder.open();
      expect(await recovery).toMatchObject({ attempted: 1, succeeded: 1 });
      const replay = await runScheduledCron(DATAFORSEO_DUMPS_CRON, env);
      expect(replay.outcome).toBe('ran');
      expect(weekly.calls.some((url) => url.includes('/ranked_keywords/'))).toBe(true);
      expect(await pgCount(
        `${DUMP_ROWS} AND asset = $1 AND report = $2`,
        [asset, recoveredReport],
      )).toBe(1);
    } finally {
      holder.open();
      try {
        await recovery;
      } finally {
        clock.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  });

  /** The other direction: the Monday sweep is running and somebody fires the
   * route. The refusal has to name the sweep, which carries no scope at all. */
  it('refuses an on-demand run while the weekly sweep holds the lane', async () => {
    const sweep = gatedProvider();
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: sweep.fetchImpl,
    });
    await sweep.started;

    const challenger = provider();
    const { status, body } = await collect(
      { asset: 'northwind.example', families: ['serp-panel'] },
      { nowMs: NOW, fetchImpl: challenger.fetchImpl },
    );

    expect(status).toBe(409);
    expect(body.inFlight?.scope).toBeNull();
    expect(challenger.calls).toEqual([]);
    expect(await pgCount(DUMP_ROWS)).toBe(0);

    sweep.open();
    await running;
  });

  /** A lock over money must fail open on a schedule. A run whose request
   * context was torn down mid-await never reaches its release, so the lane is
   * held by nobody — and the lease is the answer. The expiry is the one the
   * refusal itself advertised, so the promise made to the operator is the
   * promise under test. (A restarted runtime is the other release: the marker
   * lives in module scope and comes back empty.) */
  it('lets the next trigger through once a stale run has outlived its lease', async () => {
    const abandoned = gatedProvider();
    const stale = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: abandoned.fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    const staleEnd = settled(stale);
    await abandoned.started;

    const refused = await collect(
      { asset: 'northwind.example', families: ['ranked-keywords'] },
      { nowMs: NOW, fetchImpl: provider().fetchImpl },
    );
    expect(refused.status).toBe(409);
    // Fifteen minutes, pinned: how long a run may hold the lane without
    // returning is a decision about money, not an implementation detail.
    const freesAt = Date.parse(refused.body.inFlight!.leaseExpiresAt);
    expect(freesAt - NOW).toBe(15 * 60_000);

    const successor = gatedProvider();
    const taken = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: freesAt,
      fetchImpl: successor.fetchImpl,
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });
    await successor.started;

    // The run that lost the lane resumes: its parked call returns, and it stops
    // before buying the panel's next call beside its successor. It cannot free
    // the lane on its way out either — the lane now belongs to the successor,
    // and a trigger arriving after the stale run has ended is refused by the
    // run that is actually working.
    abandoned.open();
    const staleRun = await staleEnd;
    expect(staleRun.result).toBeNull();
    expect(staleRun.error).toMatchObject({ code: 'collection_superseded' });
    expect(abandoned.calls).toHaveLength(1);
    // It wrote no manifest on its way out, and the call it had paid for stays
    // counted: the request charge the monthly meter reads is settled.
    expect(await pgCount(DUMP_ROWS)).toBe(0);
    expect(await pgCount(SETTLED_CHARGES, ['northwind.example'])).toBe(1);

    const third = await collect(
      { asset: 'northwind.example', families: ['backlinks-summary'] },
      { nowMs: freesAt, fetchImpl: provider().fetchImpl },
    );
    expect(third.status).toBe(409);
    expect(third.body.inFlight).toMatchObject({
      startedAt: new Date(freesAt).toISOString(),
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    });

    successor.open();
    const takenResult = await taken;
    expect(takenResult.refused).toBeUndefined();
    expect(takenResult.attempted).toBe(1);
    expect(await pgCount(DUMP_ROWS)).toBe(1);
  });

  /** The manifest is the last thing a family writes, after its archive object.
   * A run parked in that object write while another takes the lane has paid
   * and stored, and must still not write the row. */
  it('writes no manifest when the lane is taken during the archive object write', async () => {
    const storeObject = env.RAW_SIGNALS.put.bind(env.RAW_SIGNALS);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let sawObjectWrite!: () => void;
    const objectWrite = new Promise<void>((resolve) => { sawObjectWrite = resolve; });
    let parked = false;
    const put = vi.spyOn(env.RAW_SIGNALS, 'put').mockImplementation((async (...args: Parameters<typeof storeObject>) => {
      if (!parked) {
        parked = true;
        sawObjectWrite();
        await gate;
      }
      return storeObject(...args);
    }) as typeof storeObject);
    const former = provider();
    const formerEnd = settled(runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: former.fetchImpl,
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    }));
    const successor = gatedProvider();
    try {
      await objectWrite;
      const taken = runDataForSeoDumps(env, {
        ...CREDENTIALS,
        nowMs: NOW + 15 * 60_000,
        fetchImpl: successor.fetchImpl,
        scope: { asset: 'northwind.example', families: ['backlinks-summary'] },
      });
      await successor.started;

      open();
      expect((await formerEnd).error).toMatchObject({ code: 'collection_superseded' });
      expect(former.calls).toHaveLength(1);
      expect(await pgCount(DUMP_ROWS)).toBe(0);
      expect(await pgCount(SETTLED_CHARGES, ['northwind.example'])).toBe(1);

      successor.open();
      expect(await taken).toMatchObject({ attempted: 1, succeeded: 1 });
      expect(await pgCount(DUMP_ROWS)).toBe(1);
    } finally {
      open();
      successor.open();
      await formerEnd;
      put.mockRestore();
    }
  });

  /** A failing family asks whether the uplink is down before it records the
   * failure. A run that loses the lane during that wait records nothing. */
  it('writes no failure manifest when the lane is taken during the uplink check', async () => {
    const dropped = (async () => { throw new TypeError('Synthetic dropped connection'); }) as unknown as typeof fetch;
    const egress = new EgressGate(env, { lane: 'dataforseo', at: new Date(NOW).toISOString(), fetchImpl: dropped });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let sawSecondCheck!: () => void;
    const secondCheck = new Promise<void>((resolve) => { sawSecondCheck = resolve; });
    let checks = 0;
    // The uplink is up both times: the call's own check answers at once, the
    // failure handler's check parks.
    vi.spyOn(egress, 'isDown').mockImplementation(async () => {
      checks += 1;
      if (checks === 2) {
        sawSecondCheck();
        await gate;
      }
      return false;
    });
    const formerEnd = settled(runDataForSeoDumps(env, {
      ...CREDENTIALS,
      nowMs: NOW,
      fetchImpl: dropped,
      egress,
      retryBackoffMs: [],
      scope: { asset: 'northwind.example', families: ['ranked-keywords'] },
    }));
    const successor = gatedProvider();
    try {
      await secondCheck;
      const taken = runDataForSeoDumps(env, {
        ...CREDENTIALS,
        nowMs: NOW + 15 * 60_000,
        fetchImpl: successor.fetchImpl,
        scope: { asset: 'northwind.example', families: ['backlinks-summary'] },
      });
      await successor.started;

      open();
      expect((await formerEnd).error).toMatchObject({ code: 'collection_superseded' });
      expect(await pgCount(DUMP_ROWS)).toBe(0);

      successor.open();
      expect(await taken).toMatchObject({ attempted: 1, succeeded: 1 });
      expect(await pgCount(DUMP_ROWS)).toBe(1);
    } finally {
      open();
      successor.open();
      await formerEnd;
    }
  });

  /** The lease measures silence, not age: a sweep of many slow calls is working
   * for longer than fifteen minutes, and a trigger that took its lane would buy
   * the calls the sweep has not reached yet. */
  it('keeps the lane for a run that is still making provider calls past the lease', async () => {
    const later = NOW + 16 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let sawSecondCall!: () => void;
    const secondCall = new Promise<void>((resolve) => { sawSecondCall = resolve; });
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(requestUrl(input));
      if (calls.length === 1) {
        // The first call took sixteen minutes to come back.
        clock.mockReturnValue(later);
        return answer();
      }
      sawSecondCall();
      await gate;
      return answer();
    }) as typeof fetch;
    // No injected clock: the lease is renewed on the clock the lane was claimed on.
    const running = runDataForSeoDumps(env, {
      ...CREDENTIALS,
      fetchImpl,
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });
    try {
      await secondCall;
      const challenger = provider();
      const { status, body } = await collect(
        { asset: 'northwind.example', families: ['ranked-keywords'] },
        { fetchImpl: challenger.fetchImpl },
      );
      expect(status).toBe(409);
      expect(body.inFlight?.startedAt).toBe(new Date(NOW).toISOString());
      expect(Date.parse(body.inFlight!.leaseExpiresAt) - later).toBe(15 * 60_000);
      expect(challenger.calls).toEqual([]);
    } finally {
      open();
      try {
        await running;
      } finally {
        clock.mockRestore();
      }
    }
  });
});
