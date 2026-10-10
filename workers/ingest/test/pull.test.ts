import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { EGRESS_BEACONS, EGRESS_DOWN_RULE_ID } from '../src/egress.js';
import { PULL_FAILED_RULE_ID, runPullAdapter, type PullAssetConfig } from '../src/pull.js';
import { ASSET_TOKENS } from './fixtures.js';
import { flagRows, insertPulse, pgCount, pgRows, promBody, reset, stubFetch } from './helpers.js';

beforeEach(reset);

// A fixed clock so the pulse day and the seeded prior days are deterministic.
const NOW = Date.parse('2026-07-05T02:30:00.000Z'); // pulse day 2026-07-05
const MEADOW_URL = 'https://meadow.example/api/internal/metrics';
const NOM_URL = 'https://northwind.example/api/internal/metrics';
const NOM_OVERVIEW_URL = 'https://northwind.example/api/admin/overview';

const MEADOW_ENTRY: PullAssetConfig = {
  asset: 'meadow.example',
  url: MEADOW_URL,
  enabled: true,
  format: 'prometheus',
  metrics: {
    signups: { counter: 'profiles' },
    plansSaved: { counter: 'saved_calculator_results' },
    recipesSaved: { counter: 'saved_recipes' },
    leads: { counter: 'leads' },
    feedback: { counter: 'feedback' },
  },
};

// northwind.example speaks the contract directly: GET /api/admin/overview returns the
// envelope verbatim, so the pull entry carries no metric mapping.
const NOM_ENVELOPE_ENTRY: PullAssetConfig = {
  asset: 'northwind.example',
  url: NOM_OVERVIEW_URL,
  enabled: true,
  format: 'envelope',
};

interface EnvMetric {
  last24h: number;
  avg7d: number;
  total: number;
}

/** The exact contract envelope northwind.example's overview endpoint emits; overrides swap a metric. */
function nomBody(overrides: Record<string, EnvMetric> = {}): Record<string, unknown> {
  const metrics: Record<string, EnvMetric> = {
    // avg7d remains part of the wire contract, but the central rule deliberately
    // ignores it in favor of matching weekdays assembled from stored history.
    affiliateClicks: { last24h: 0, avg7d: 12.5, total: 3400 },
    receiptsHosted: { last24h: 5, avg7d: 4.2, total: 900 },
    receiptVisits: { last24h: 40, avg7d: 38.1, total: 12000 },
    apiRequests: { last24h: 800, avg7d: 790.4, total: 250000 },
    ...overrides,
  };
  return {
    asset: 'northwind.example',
    generatedAt: '2026-07-05T02:00:00.000Z',
    capabilities: Object.keys(metrics),
    metrics,
    flags: [],
  };
}

/** A body where every configured meadow.example counter is present; `signupsH24` varies. */
function meadowBody(signupsH24: number): string {
  return promBody({
    profiles: { total: 5000, h24: signupsH24, d7: signupsH24 * 7 },
    saved_calculator_results: { total: 1880, h24: 4, d7: 30 },
    saved_recipes: { total: 900, h24: 2, d7: 15 },
    leads: { total: 620, h24: 3, d7: 20 },
    feedback: { total: 140, h24: 1, d7: 7 },
  });
}

/** Seed prior stored pulses (one per day before the pulse day) with a signups series. */
async function seedSignupsHistory(dailyLast24h: number[]): Promise<void> {
  for (let i = 0; i < dailyLast24h.length; i++) {
    const dayMs = NOW - (i + 1) * 24 * 3_600_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const value = dailyLast24h[i]!;
    const envelope = JSON.stringify({
      asset: 'meadow.example',
      generatedAt: new Date(dayMs).toISOString(),
      capabilities: ['signups'],
      metrics: { signups: { last24h: value, avg7d: value, total: 5000 } },
    });
    await insertPulse({
      asset: 'meadow.example',
      date,
      generatedAt: new Date(dayMs).toISOString(),
      receivedAt: new Date(dayMs).toISOString(),
      capabilities: ['signups'],
      envelope: JSON.parse(envelope),
    });
  }
}

/** Seed the four matching weekdays required to arm central seasonal rules. */
async function seedEnvelopeWeekdays(
  asset: string,
  metrics: Record<string, EnvMetric>,
): Promise<void> {
  for (const date of ['2026-06-07', '2026-06-14', '2026-06-21', '2026-06-28']) {
    const generatedAt = `${date}T02:00:00.000Z`;
    const envelope = JSON.stringify({
      asset,
      generatedAt,
      capabilities: Object.keys(metrics),
      metrics,
      flags: [],
    });
    await insertPulse({
      asset,
      date,
      generatedAt,
      receivedAt: generatedAt,
      capabilities: Object.keys(metrics),
      envelope: JSON.parse(envelope),
    });
  }
}

async function storedEnvelope(asset: string): Promise<{
  metrics: Record<string, { last24h: number; avg7d: number; total: number }>;
} | null> {
  const [row] = await pgRows<{ envelope: string }>(
    `SELECT envelope::text AS envelope FROM noticeos.current_pulses WHERE asset_id = $1 ORDER BY pulse_date DESC LIMIT 1`,
    [asset],
  );
  return row ? JSON.parse(row.envelope) : null;
}

async function openPullFailures(asset: string): Promise<number> {
  return pgCount(
    `SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL`,
    [asset, PULL_FAILED_RULE_ID],
  );
}

/** The open pull-failure flag for an asset (its operator-facing message + inputs). */
async function pullFailureFlag(
  asset: string,
): Promise<{ message: string; rule_inputs: string; fired_at: string } | null> {
  const [row] = await flagRows(`asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL`, [asset, PULL_FAILED_RULE_ID]);
  return row ? { message: row.message!, rule_inputs: row.rule_inputs!, fired_at: row.fired_at } : null;
}

describe('pull adapter — successful pull', () => {
  it('writes a pulse row, maps the counters, and runs the central rules', async () => {
    // Four prior Sundays at 10 with a 0-signups Sunday => the seasonal central
    // rule must fire, proving the pull went through the shared write path.
    await seedSignupsHistory(Array.from({ length: 28 }, () => 10));

    const result = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response(meadowBody(0), { status: 200 }) }),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });

    // one pulse row for the pull day
    expect(
      await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example' AND pulse_date = '2026-07-05'`),
    ).toBe(1);

    // counters mapped: total from d1_row_count, last24h from the 24h window
    const env0 = await storedEnvelope('meadow.example');
    expect(env0?.metrics.signups).toMatchObject({ last24h: 0, total: 5000 });
    expect(env0?.metrics.leads).toMatchObject({ last24h: 3, total: 620 });

    // central rule fired on the drop, stamped with rule_id + inputs
    const [central] = await flagRows(`asset_id = 'meadow.example' AND rule_id = 'flow-poisson-low'`);
    expect(central).toMatchObject({ metric: 'signups', severity: 'warn' });
    expect(JSON.parse(central!.rule_inputs!)).toMatchObject({
      observed: 0,
      baselinePerDay: 10,
      baselineSource: 'same-weekday-4w',
    });
  });

  it('computes avg7d from the last 7 stored pulses (not the source point-in-time)', async () => {
    await seedSignupsHistory([8, 9, 10, 11, 12, 13, 14]); // mean 11

    await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response(meadowBody(5), { status: 200 }) }),
    });

    const env0 = await storedEnvelope('meadow.example');
    expect(env0?.metrics.signups?.avg7d).toBe(11);
    expect(env0?.metrics.signups?.last24h).toBe(5);
  });

  it('falls back avg7d to the current value when there is no stored history', async () => {
    await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response(meadowBody(7), { status: 200 }) }),
    });

    const env0 = await storedEnvelope('meadow.example');
    // avg7d == last24h => the drop rule is a no-op until a baseline accumulates
    expect(env0?.metrics.signups).toMatchObject({ last24h: 7, avg7d: 7 });
    expect(
      await pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = 'meadow.example' AND rule_id = 'flow-poisson-low'`),
    ).toBe(0);
  });

  it("presents the asset's own ASSET_TOKENS entry as the outbound bearer", async () => {
    // The one per-asset map serves both directions: the token the pulse lane
    // would CHECK on an inbound push is the token this lane PRESENTS outbound.
    const seen: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        authorization: headers.get('authorization'),
        accept: headers.get('accept'),
      });
      return new Response(meadowBody(3), { status: 200 });
    }) as typeof fetch;

    const result = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: recordingFetch,
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(seen).toEqual([
      {
        url: MEADOW_URL,
        authorization: `Bearer ${ASSET_TOKENS['meadow.example']}`,
        accept: 'text/plain',
      },
    ]);
  });

  it('reads no PULL_TOKENS binding a deployed worker may still carry', async () => {
    const legacy = Object.assign({}, env, {
      PULL_TOKENS: JSON.stringify({ 'meadow.example': 'legacy-meadow-token', 'ferns.example': 'legacy-ferns-token' }),
    });
    const presented: Array<string | null> = [];
    const recordingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      presented.push(new Headers(init?.headers).get('authorization'));
      return new Response(mealsBody(3), { status: 200 });
    }) as typeof fetch;
    const feesEntry: PullAssetConfig = {
      ...MEALS_ENTRY,
      asset: 'ferns.example',
      url: 'https://ferns.example/api/internal/metrics',
    };

    const result = await runPullAdapter(legacy, {
      entries: [MEALS_ENTRY, feesEntry],
      nowMs: NOW,
      fetchImpl: recordingFetch,
    });

    expect(presented).toEqual([`Bearer ${ASSET_TOKENS['meadow.example']}`]);
    expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([true, false]);
    expect(result.outcomes[1]?.error).toContain('no pull token');
  });
});

describe('pull adapter — failure handling', () => {
  it('fires an asset-pull-failed flag once, not twice, while it stays open', async () => {
    const fetchImpl = stubFetch({ [MEADOW_URL]: () => new Response('nope', { status: 500 }) });

    const first = await runPullAdapter(env, { entries: [MEADOW_ENTRY], nowMs: NOW, fetchImpl });
    expect(first).toMatchObject({ succeeded: 0, failed: 1 });
    expect(first.outcomes[0]).toMatchObject({ ok: false, status: 500, fired: 1 });
    expect(await openPullFailures('meadow.example')).toBe(1);

    const second = await runPullAdapter(env, { entries: [MEADOW_ENTRY], nowMs: NOW, fetchImpl });
    expect(second.outcomes[0]).toMatchObject({ ok: false, fired: 0, refreshed: 1 });
    expect(await openPullFailures('meadow.example')).toBe(1); // still exactly one

    const [flag] = await flagRows(`asset_id = 'meadow.example' AND rule_id = $1`, [PULL_FAILED_RULE_ID]);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', pulse_id: null });
    expect(JSON.parse(flag!.rule_inputs!)).toMatchObject({ url: MEADOW_URL, status: 500 });
  });

  // A persistent outage keeps one flag, but it must speak for tonight, not
  // the first night's cause.
  it("rewrites the open flag with the current night's cause", async () => {
    const night2 = NOW + 24 * 3_600_000;
    const unconfigured = 'Overview unavailable: set CF_ACCOUNT_ID and CF_ANALYTICS_API_TOKEN.';

    const first = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () =>
          new Response(JSON.stringify({ error: 'unconfigured', message: unconfigured }), { status: 503 }),
      }),
    });
    expect(first.outcomes[0]).toMatchObject({ ok: false, status: 503, fired: 1, refreshed: 0 });

    const second = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: night2,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      }),
    });
    expect(second.outcomes[0]).toMatchObject({ ok: false, status: 401, fired: 0, refreshed: 1 });

    // rewritten in place — a nightly outage still owns exactly one open flag
    expect(await openPullFailures('northwind.example')).toBe(1);

    const flag = await pullFailureFlag('northwind.example');
    expect(flag?.message).toBe('pull failed: 401 unauthorized');
    // fired_at still dates the START of the outage, not tonight's attempt
    expect(flag?.fired_at).toBe(new Date(NOW).toISOString());

    const inputs = JSON.parse(flag!.rule_inputs);
    expect(inputs).toMatchObject({
      status: 401,
      providerError: 'unauthorized',
      failureCount: 2,
      lastFailedAt: new Date(night2).toISOString(),
    });
    // night 1's provider message must not linger under night 2's cause
    expect(inputs.providerMessage).toBeUndefined();
  });

  it('resolves a rewritten flag on success, and a later outage counts from 1 again', async () => {
    const down = stubFetch({ [NOM_OVERVIEW_URL]: () => new Response('down', { status: 503 }) });
    await runPullAdapter(env, { entries: [NOM_ENVELOPE_ENTRY], nowMs: NOW, fetchImpl: down });
    await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW + 24 * 3_600_000,
      fetchImpl: down,
    });
    expect(JSON.parse((await pullFailureFlag('northwind.example'))!.rule_inputs).failureCount).toBe(2);

    const recovery = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW + 48 * 3_600_000,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify(nomBody()), { status: 200 }),
      }),
    });
    expect(recovery.outcomes[0]).toMatchObject({ ok: true, resolved: 1 });
    expect(await openPullFailures('northwind.example')).toBe(0);

    // the next outage is a NEW flag with its own count, not a continuation
    const relapse = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW + 72 * 3_600_000,
      fetchImpl: down,
    });
    expect(relapse.outcomes[0]).toMatchObject({ fired: 1, refreshed: 0 });
    const flag = await pullFailureFlag('northwind.example');
    expect(flag?.fired_at).toBe(new Date(NOW + 72 * 3_600_000).toISOString());
    expect(JSON.parse(flag!.rule_inputs).failureCount).toBe(1);
  });

  // The rewrite above keeps the flag speaking for tonight; each failed night
  // also keeps its own record on the flag it opened or refreshed.
  it("keeps every failed night's own record: N failures leave N readings, each with that night's cause", async () => {
    const nights = [NOW, NOW + 24 * 3_600_000, NOW + 48 * 3_600_000];
    const responses = [
      () => new Response(JSON.stringify({ error: 'unconfigured', message: 'set CF_ACCOUNT_ID' }), { status: 503 }),
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      () => new Response('gateway', { status: 502 }),
    ];
    for (const [i, nowMs] of nights.entries()) {
      const run = await runPullAdapter(env, {
        entries: [NOM_ENVELOPE_ENTRY],
        nowMs,
        fetchImpl: stubFetch({ [NOM_OVERVIEW_URL]: responses[i]! }),
      });
      expect(run.outcomes[0]).toMatchObject({ ok: false, evidence: 'recorded' });
    }

    const flag = { results: await flagRows(`asset_id = 'northwind.example' AND rule_id = $1`, [PULL_FAILED_RULE_ID]) };
    expect(flag.results).toHaveLength(1);
    const readings = {
      results: (
        await pgRows<{ flag_id: number; observed_at: string; severity: string; message: string; rule_inputs: string }>(
          `SELECT f.flag_number::int AS flag_id, e.observed_at, e.severity, e.message, e.rule_inputs::text AS rule_inputs
             FROM noticeos.flag_evidence e
             JOIN noticeos.flags f ON f.workspace_id = e.workspace_id AND f.flag_id = e.flag_id
            ORDER BY e.observed_at`,
        )
      ).map((row) => ({ ...row, observed_at: new Date(row.observed_at).toISOString() })),
    };
    expect(readings.results).toHaveLength(3);
    expect(readings.results.map((row) => row.flag_id)).toEqual([flag.results[0]!.id, flag.results[0]!.id, flag.results[0]!.id]);
    expect(readings.results.map((row) => row.observed_at)).toEqual(nights.map((ms) => new Date(ms).toISOString()));
    expect(readings.results.map((row) => row.severity)).toEqual(['warn', 'warn', 'warn']);
    expect(readings.results.map((row) => row.message)).toEqual([
      'pull failed: 503 unconfigured — set CF_ACCOUNT_ID',
      'pull failed: 401 unauthorized',
      'pull failed: non-200 response (502): gateway',
    ]);
    // Night 1's cause is still there after night 2 rewrote the flag.
    expect(readings.results.map((row) => JSON.parse(row.rule_inputs))).toMatchObject([
      { status: 503, providerError: 'unconfigured', providerMessage: 'set CF_ACCOUNT_ID', failureCount: 1 },
      { status: 401, providerError: 'unauthorized', failureCount: 2 },
      { status: 502, failureCount: 3 },
    ]);
  });

  it("puts a relapse's readings on the new flag, never on the resolved one", async () => {
    const down = stubFetch({ [NOM_OVERVIEW_URL]: () => new Response('down', { status: 503 }) });
    await runPullAdapter(env, { entries: [NOM_ENVELOPE_ENTRY], nowMs: NOW, fetchImpl: down });
    await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW + 24 * 3_600_000,
      fetchImpl: stubFetch({ [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify(nomBody()), { status: 200 }) }),
    });
    await runPullAdapter(env, { entries: [NOM_ENVELOPE_ENTRY], nowMs: NOW + 48 * 3_600_000, fetchImpl: down });

    const byFlag = {
      results: await pgRows<{ id: number; resolvedAt: string | null; readings: number }>(
        `SELECT f.flag_number::int AS id, f.resolved_at AS "resolvedAt", count(e.flag_id)::int AS readings
           FROM noticeos.flags f
           LEFT JOIN noticeos.flag_evidence e ON e.workspace_id = f.workspace_id AND e.flag_id = f.flag_id
          WHERE f.asset_id = 'northwind.example' AND f.rule_id = $1
          GROUP BY f.flag_id, f.flag_number, f.resolved_at, f.fired_at ORDER BY f.fired_at`,
        [PULL_FAILED_RULE_ID],
      ),
    };
    expect(byFlag.results.map(({ resolvedAt, readings }) => ({ resolved: resolvedAt !== null, readings }))).toEqual([
      { resolved: true, readings: 1 },
      { resolved: false, readings: 1 },
    ]);
  });

  it('treats an unmappable body (missing counter) as a failure', async () => {
    const body = promBody({ profiles: { total: 10, h24: 1, d7: 5 } }); // missing the other 4 counters
    const result = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response(body, { status: 200 }) }),
    });

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(await openPullFailures('meadow.example')).toBe(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example'`)).toBe(0);
  });

  it('auto-resolves the open pull-failure flag on the next successful pull', async () => {
    await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response('down', { status: 503 }) }),
    });
    expect(await openPullFailures('meadow.example')).toBe(1);

    const recovery = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({ [MEADOW_URL]: () => new Response(meadowBody(6), { status: 200 }) }),
    });
    expect(recovery.outcomes[0]).toMatchObject({ ok: true, resolved: 1 });
    expect(await openPullFailures('meadow.example')).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example'`)).toBe(1);
  });
});

describe('pull adapter — the OS is what is down', () => {
  /** Routing the reference site is the OS's own connection being fine; leaving
   * it out is a dead uplink, which must not flag both pull-mode properties for
   * an outage that was the OS's. */
  const BEACON_UP = { [EGRESS_BEACONS[0]]: () => new Response('h=1', { status: 200 }) };

  async function openEgressFlags(): Promise<number> {
    return pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE rule_id = $1 AND resolved_at IS NULL`, [
      EGRESS_DOWN_RULE_ID,
    ]);
  }

  it('files no pull-failure flag on either property, and one on the OS row instead', async () => {
    const result = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY, NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({}), // nothing answers, the beacons included
    });

    // The pulls still count as failed — they did not happen — but nobody is blamed.
    expect(result).toMatchObject({ attempted: 2, succeeded: 0, failed: 2 });
    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject({ ok: false, status: null, egressDown: true, fired: 0, refreshed: 0 });
    }
    expect(await openPullFailures('meadow.example')).toBe(0);
    expect(await openPullFailures('northwind.example')).toBe(0);

    // One question asked for the whole run, one flag written.
    expect(result.egress).toMatchObject({
      up: false,
      probes: 1,
      fired: 1,
      unmeasuredAssets: ['meadow.example', 'northwind.example'],
    });
    const [flag] = await flagRows(`rule_id = $1`, [EGRESS_DOWN_RULE_ID]);
    expect(flag).toMatchObject({
      asset: 'root-os',
      severity: 'warn',
      message: 'OS egress down — 2 properties unmeasured',
    });
  });

  it('still flags an endpoint that never answers when the OS can reach the world', async () => {
    // The regression guard: this is the case the gate must never make quieter.
    const result = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch(BEACON_UP), // the property is routed nowhere
    });

    expect(result.outcomes[0]).toMatchObject({ ok: false, status: null, fired: 1 });
    expect(result.outcomes[0]?.egressDown).toBeUndefined();
    expect(await openPullFailures('meadow.example')).toBe(1);
    expect(result.egress).toMatchObject({ up: true, fired: 0 });
    expect(await openEgressFlags()).toBe(0);
  });

  it('still flags a missing pull token — that failure never reached the network', async () => {
    // ferns.example has no entry in ASSET_TOKENS, so the pull throws before any
    // request goes out. A statusless failure is not automatically a connectivity
    // failure, and a config error must not hide behind an outage.
    const unconfigured: PullAssetConfig = {
      ...MEADOW_ENTRY,
      asset: 'ferns.example',
      url: 'https://ferns.example/api/internal/metrics',
    };
    const result = await runPullAdapter(env, {
      entries: [unconfigured],
      nowMs: NOW,
      fetchImpl: stubFetch({}),
    });

    expect(result.outcomes[0]).toMatchObject({ ok: false, status: null, fired: 1 });
    expect(result.outcomes[0]?.error).toContain('no pull token');
    expect(await openPullFailures('ferns.example')).toBe(1);
    expect(result.egress).toMatchObject({ checked: false, probes: 0 });
  });

  it('retracts the OS egress flag on the next run that gets through', async () => {
    await runPullAdapter(env, { entries: [MEADOW_ENTRY], nowMs: NOW, fetchImpl: stubFetch({}) });
    expect(await openEgressFlags()).toBe(1);

    // A successful pull never consults the gate, so the retraction is owed at the
    // end of the run — and it needs a beacon to prove itself with.
    const back = await runPullAdapter(env, {
      entries: [MEADOW_ENTRY],
      nowMs: NOW + 24 * 3_600_000,
      fetchImpl: stubFetch({
        ...BEACON_UP,
        [MEADOW_URL]: () => new Response(meadowBody(4), { status: 200 }),
      }),
    });

    expect(back).toMatchObject({ succeeded: 1, failed: 0 });
    expect(back.egress).toMatchObject({ up: true, probes: 1, resolved: 1 });
    expect(await openEgressFlags()).toBe(0);
  });
});

describe('pull adapter — isolation', () => {
  it('skips a disabled asset entirely (no fetch, no pulse, no flag)', async () => {
    const disabled: PullAssetConfig = { ...MEADOW_ENTRY, enabled: false };
    const result = await runPullAdapter(env, {
      entries: [disabled],
      nowMs: NOW,
      // throws if any fetch is attempted
      fetchImpl: stubFetch({}),
    });

    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example'`)).toBe(0);
    expect(await openPullFailures('meadow.example')).toBe(0);
  });

  it("one asset's failure does not block another asset's pull", async () => {
    const nomEntry: PullAssetConfig = {
      asset: 'northwind.example',
      url: NOM_URL,
      enabled: true,
      format: 'prometheus',
      metrics: { signups: { counter: 'profiles' } },
    };

    const result = await runPullAdapter(env, {
      entries: [nomEntry, MEADOW_ENTRY], // failing asset first
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_URL]: () => new Response('boom', { status: 500 }),
        [MEADOW_URL]: () => new Response(meadowBody(9), { status: 200 }),
      }),
    });

    expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    // northwind.example failed and got flagged
    expect(await openPullFailures('northwind.example')).toBe(1);
    // meadow.example still succeeded despite northwind.example failing first
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example'`)).toBe(1);
    expect(await openPullFailures('meadow.example')).toBe(0);
  });
});

describe('pull adapter — envelope format', () => {
  it('writes the pulse verbatim, runs the central rules, and preserves the source avg7d', async () => {
    await seedEnvelopeWeekdays('northwind.example', {
      affiliateClicks: { last24h: 12, avg7d: 100, total: 3300 },
      receiptsHosted: { last24h: 5, avg7d: 100, total: 880 },
      receiptVisits: { last24h: 40, avg7d: 100, total: 11900 },
      apiRequests: { last24h: 800, avg7d: 100, total: 249000 },
    });
    const result = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify(nomBody()), { status: 200 }),
      }),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });

    // one pulse row for the pull day
    expect(
      await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'northwind.example' AND pulse_date = '2026-07-05'`),
    ).toBe(1);

    // the source's own avg7d is authoritative — stored verbatim, NOT recomputed
    const env0 = await storedEnvelope('northwind.example');
    expect(env0?.metrics.affiliateClicks).toMatchObject({ last24h: 0, avg7d: 12.5, total: 3400 });
    expect(env0?.metrics.apiRequests).toMatchObject({ last24h: 800, avg7d: 790.4 });

    // central rule uses the stored matching-Sunday baseline (0 vs 12), not the
    // source's point-in-time avg7d (12.5).
    const [central] = await flagRows(`asset_id = 'northwind.example' AND rule_id = 'flow-poisson-low'`);
    expect(central).toMatchObject({ metric: 'affiliateClicks', severity: 'warn' });
    expect(JSON.parse(central!.rule_inputs!)).toMatchObject({
      observed: 0,
      baselinePerDay: 12,
      baselineSource: 'same-weekday-4w',
    });
  });

  it('rejects a body whose asset id does not match the config (no silent cross-write)', async () => {
    const mismatched = { ...nomBody(), asset: 'meadow.example' };
    const result = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify(mismatched), { status: 200 }),
      }),
    });

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.outcomes[0]?.error).toContain('asset mismatch');
    expect(await openPullFailures('northwind.example')).toBe(1);
    // nothing written under EITHER asset id
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'northwind.example'`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'meadow.example'`)).toBe(0);
  });

  it("surfaces the provider's own words on a 503 unconfigured body", async () => {
    const message =
      'Overview unavailable: set CF_ACCOUNT_ID and CF_ANALYTICS_API_TOKEN (wrangler secret put) to enable the Analytics Engine SQL API.';
    const result = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () =>
          new Response(JSON.stringify({ error: 'unconfigured', message }), { status: 503 }),
      }),
    });

    expect(result.outcomes[0]).toMatchObject({ ok: false, status: 503, fired: 1 });

    const flag = await pullFailureFlag('northwind.example');
    // the alert message carries the status, the provider's error name, and its
    // message — but not the property name (the flag's asset column owns that fact).
    expect(flag?.message).toBe(`pull failed: 503 unconfigured — ${message}`);
    const inputs = JSON.parse(flag!.rule_inputs);
    expect(inputs).toMatchObject({ status: 503, providerError: 'unconfigured', providerMessage: message });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'northwind.example'`)).toBe(0);
  });

  it('fires the pull-failure flag on a 401 unauthorized', async () => {
    const result = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      }),
    });

    expect(result.outcomes[0]).toMatchObject({ ok: false, status: 401, fired: 1 });
    expect(await openPullFailures('northwind.example')).toBe(1);

    const flag = await pullFailureFlag('northwind.example');
    expect(flag?.message).toBe('pull failed: 401 unauthorized');
    expect(JSON.parse(flag!.rule_inputs)).toMatchObject({ status: 401, providerError: 'unauthorized' });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'northwind.example'`)).toBe(0);
  });

  it('treats a 200 body that fails contract validation as a failure, not a throw', async () => {
    // affiliateClicks.last24h is negative — the PulseEnvelope contract rejects it.
    const invalid = nomBody({ affiliateClicks: { last24h: -5, avg7d: 12.5, total: 3400 } });
    const result = await runPullAdapter(env, {
      entries: [NOM_ENVELOPE_ENTRY],
      nowMs: NOW,
      fetchImpl: stubFetch({
        [NOM_OVERVIEW_URL]: () => new Response(JSON.stringify(invalid), { status: 200 }),
      }),
    });

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.outcomes[0]?.error).toContain('contract validation');
    expect(await openPullFailures('northwind.example')).toBe(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'northwind.example'`)).toBe(0);
  });
});
