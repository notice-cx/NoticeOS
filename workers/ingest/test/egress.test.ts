// The egress gate's own contract: what proves the OS can get out, what it costs
// to ask, and the single self-flag it files when the answer is no.
//
// The case these pin is 2026-08-08 — a dead house uplink that made every nightly
// lane accuse the properties it could not reach. The rule that fixes it is
// narrow on purpose: any HTTP status proves egress, so only a fetch that never
// completed is worth a question.

import { env } from 'cloudflare:test';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EGRESS_BEACONS,
  EGRESS_DOWN_RULE_ID,
  EGRESS_USER_AGENT,
  EGRESS_VERDICT_TTL_MS,
  EgressGate,
  egressExplains,
  watchTransport,
} from '../src/egress.js';
import { flagRows, insertFlag, openEgressFlags, pgCount, reset } from './helpers.js';

beforeEach(reset);

const AT = '2026-08-08T04:00:00.000Z';
const [CLOUDFLARE, GOOGLE] = EGRESS_BEACONS;

interface Probe {
  url: string;
  userAgent: string | null;
}

/** Route url -> response; an unrouted url fails at the transport level. */
function stub(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  probes: Probe[];
} {
  const probes: Probe[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    probes.push({ url, userAgent: new Headers(init?.headers ?? {}).get('user-agent') });
    const handler = routes[url];
    if (!handler) throw new Error(`internal error; reference = 0d9f4a2c`);
    return handler();
  }) as typeof fetch;
  return { fetchImpl, probes };
}

interface EgressRow {
  observed_at: string;
  up: number;
  detail_json: string;
}

/** The stored rounds in the order they were written, read on Postgres in the
 * terms the gate wrote them: its instant, 1 or 0, the detail as JSON text. */
async function egressRows(): Promise<EgressRow[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ observed_at: string; up: boolean; detail_json: string }>(
      `SELECT observed_at, up, detail::text AS detail_json FROM noticeos.egress_checks ORDER BY egress_check_id`,
    ),
  );
  return rows.map((row) => ({ observed_at: javascriptInstant(row.observed_at), up: row.up ? 1 : 0, detail_json: row.detail_json }));
}

async function egressFlag(): Promise<{
  asset: string;
  severity: string;
  message: string;
  fired_at: string;
  resolved_at: string | null;
  rule_inputs: string;
} | null> {
  const [row] = await flagRows(`rule_id = $1`, [EGRESS_DOWN_RULE_ID]);
  return row
    ? {
        asset: row.asset,
        severity: row.severity,
        message: row.message!,
        fired_at: row.fired_at,
        resolved_at: row.resolved_at,
        rule_inputs: row.rule_inputs!,
      }
    : null;
}

describe('egress verdict', () => {
  it('reads ANY http status as proof and stops asking after the first answer', async () => {
    // A 403 from the beacon is still a round trip. The whole gate rests on this.
    const { fetchImpl, probes } = stub({ [CLOUDFLARE]: () => new Response('nope', { status: 403 }) });
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    expect(await gate.isDown()).toBe(false);
    expect(probes.map((p) => p.url)).toEqual([CLOUDFLARE]);
    expect(await egressRows()).toMatchObject([{ observed_at: AT, up: 1 }]);
  });

  it('asks the second operator when the first does not answer', async () => {
    const { fetchImpl, probes } = stub({ [GOOGLE]: () => new Response(null, { status: 204 }) });
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    expect(await gate.isDown()).toBe(false);
    // Two independent operators on purpose: one company having a bad afternoon
    // must not read as this house's uplink being down.
    expect(probes.map((p) => p.url)).toEqual([CLOUDFLARE, GOOGLE]);
  });

  it('is down only when every beacon fails at the transport level', async () => {
    const { fetchImpl, probes } = stub({});
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    expect(await gate.isDown()).toBe(true);
    expect(probes.map((p) => p.url)).toEqual([CLOUDFLARE, GOOGLE]);

    const [row] = await egressRows();
    expect(row).toMatchObject({ observed_at: AT, up: 0 });
    const detail = JSON.parse(row!.detail_json) as { beacons: { url: string; error: string }[] };
    // workerd's wrapped connection error, verbatim — the string nobody can parse,
    // kept because it is what the operator will be shown.
    expect(detail.beacons.map((b) => b.url)).toEqual([CLOUDFLARE, GOOGLE]);
    expect(detail.beacons[0]!.error).toContain('internal error');
  });

  it('identifies itself honestly, and not as the hygiene lane', async () => {
    const { fetchImpl, probes } = stub({});
    await new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT }).isDown();

    for (const probe of probes) expect(probe.userAgent).toBe(EGRESS_USER_AGENT);
    expect(EGRESS_USER_AGENT).toContain('connectivity self-check');
  });
});

describe('egress verdict caching', () => {
  it('probes at most once per verdict window, however often it is asked', async () => {
    const { fetchImpl, probes } = stub({});
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT, clock: () => Date.parse(AT) });

    // Six properties failing six fetches each is 36 asks of one question.
    for (let i = 0; i < 6; i += 1) expect(await gate.isDown()).toBe(true);

    expect(gate.probeRounds).toBe(1);
    expect(probes).toHaveLength(2);
    expect(await egressRows()).toHaveLength(1);
  });

  it('re-asks once the window has passed, because an outage can start mid-sweep', async () => {
    let now = Date.parse(AT);
    const { fetchImpl } = stub({});
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT, clock: () => now });

    await gate.isDown();
    now += EGRESS_VERDICT_TTL_MS - 1;
    await gate.isDown();
    expect(gate.probeRounds).toBe(1);

    now += 2;
    await gate.isDown();
    expect(gate.probeRounds).toBe(2);
    expect(await egressRows()).toHaveLength(2);
  });
});

describe('os-egress-down flag', () => {
  it('files ONE flag on the OS row, naming how much of the portfolio went unmeasured', async () => {
    const { fetchImpl } = stub({});
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    await gate.isDown();
    gate.recordUnmeasured('meals.example');
    gate.recordUnmeasured('nosh.example');
    gate.recordUnmeasured('meals.example'); // one property, however many checks
    const outcome = await gate.finalize();

    expect(outcome).toMatchObject({
      checked: true,
      up: false,
      fired: 1,
      refreshed: 0,
      unmeasuredAssets: ['meals.example', 'nosh.example'],
    });

    const flag = await egressFlag();
    // The subject is the OS, read from the site list's OS flag rather than written down.
    expect(flag).toMatchObject({ asset: 'root-os', severity: 'warn', fired_at: AT });
    expect(flag!.message).toBe('OS egress down — 2 properties unmeasured');
    expect(JSON.parse(flag!.rule_inputs)).toMatchObject({
      rule: EGRESS_DOWN_RULE_ID,
      unmeasuredAssets: ['meals.example', 'nosh.example'],
      failureCount: 1,
      lastFailedAt: AT,
    });
  });

  it('rewrites the open flag on the next down run and keeps dating the onset', async () => {
    const { fetchImpl } = stub({});
    const first = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });
    await first.isDown();
    first.recordUnmeasured('meals.example');
    await first.finalize();

    const later = '2026-08-09T04:00:00.000Z';
    const second = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: later });
    await second.isDown();
    second.recordUnmeasured('meals.example');
    second.recordUnmeasured('nosh.example');
    expect(await second.finalize()).toMatchObject({ fired: 0, refreshed: 1 });

    const flag = await egressFlag();
    expect(flag!.fired_at).toBe(AT); // onset, not tonight
    expect(flag!.message).toBe('OS egress down — 2 properties unmeasured');
    expect(JSON.parse(flag!.rule_inputs)).toMatchObject({ failureCount: 2, lastFailedAt: later });

    const open = await pgCount(
      `SELECT count(*) AS n FROM noticeos.current_flags WHERE rule_id = $1 AND resolved_at IS NULL`,
      [EGRESS_DOWN_RULE_ID],
    );
    expect(open).toBe(1); // one outage is one problem
  });

  it('retracts the flag the moment a beacon answers again', async () => {
    const down = new EgressGate(env, { lane: 'hygiene', fetchImpl: stub({}).fetchImpl, at: AT });
    await down.isDown();
    down.recordUnmeasured('meals.example');
    await down.finalize();

    const later = '2026-08-09T04:00:00.000Z';
    const back = new EgressGate(env, {
      lane: 'hygiene',
      fetchImpl: stub({ [CLOUDFLARE]: () => new Response('h=1', { status: 200 }) }).fetchImpl,
      at: later,
    });
    expect(await back.isDown()).toBe(false);
    // Settled at the end of the run, not at probe time: whether this collector
    // is still owed a re-check depends on what the rest of the run measures.
    expect((await egressFlag())!.resolved_at).toBeNull();

    expect(await back.finalize()).toMatchObject({ up: true, fired: 0, resolved: 1 });
    expect((await egressFlag())!.resolved_at).toBe(later);
  });

  it('asks once at the end of a run that owes an open flag a retraction', async () => {
    // Recovery night: every property answers, so nothing ever consults the gate.
    // Without this the flag from the outage would stand open with nothing left to
    // withdraw it.
    const down = new EgressGate(env, { lane: 'hygiene', fetchImpl: stub({}).fetchImpl, at: AT });
    await down.isDown();
    down.recordUnmeasured('meals.example');
    await down.finalize();

    const later = '2026-08-09T04:00:00.000Z';
    const { fetchImpl, probes } = stub({ [CLOUDFLARE]: () => new Response('h=1', { status: 200 }) });
    const quiet = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: later });
    const outcome = await quiet.finalize();

    expect(probes.map((p) => p.url)).toEqual([CLOUDFLARE]);
    expect(outcome).toMatchObject({ checked: true, up: true, probes: 1, resolved: 1 });
    expect((await egressFlag())!.resolved_at).toBe(later);
  });

  it('costs nothing at all on a run where nothing failed and nothing is open', async () => {
    const { fetchImpl, probes } = stub({});
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    expect(await gate.finalize()).toMatchObject({ checked: false, up: null, probes: 0 });
    expect(probes).toEqual([]);
    expect(await egressRows()).toEqual([]);
    expect(await egressFlag()).toBeNull();
  });
});

describe('os-egress-down across collectors — one outage, every gap counted (ro-aed0.5)', () => {
  const UP = { [CLOUDFLARE]: () => new Response('h=1', { status: 200 }) };
  const NIGHT = '2026-08-08T02:30:00.000Z';
  const MORNING = '2026-08-08T12:15:00.000Z';
  const NEXT_NIGHT = '2026-08-09T04:00:00.000Z';

  interface StoredInputs {
    unmeasuredAssets: string[];
    lanes: Record<string, { unmeasuredAssets: string[]; parts?: Record<string, string[]> }>;
    connectionBackAt: string | null;
    failureCount: number;
  }
  const inputsOf = async (): Promise<StoredInputs> =>
    JSON.parse((await egressFlag())!.rule_inputs) as StoredInputs;

  /** One collector's run during the outage, leaving `assets` unmeasured. */
  async function darkRun(
    lane: 'pull' | 'hygiene' | 'dataforseo',
    at: string,
    assets: string[],
  ): Promise<void> {
    const gate = new EgressGate(env, { lane, fetchImpl: stub({}).fetchImpl, at });
    await gate.isDown();
    for (const asset of assets) gate.recordUnmeasured(asset);
    await gate.finalize();
  }

  it('counts every collector\'s unmeasured properties, not whichever ran last', async () => {
    await darkRun('pull', NIGHT, ['meals.example', 'nosh.example']);
    await darkRun('hygiene', AT, ['nosh.example', 'fees.example']);

    const flag = await egressFlag();
    // Three distinct properties went dark across the two, not hygiene's two.
    expect(flag!.message).toBe('OS egress down — 3 properties unmeasured');
    const inputs = await inputsOf();
    expect(inputs.unmeasuredAssets).toEqual(['meals.example', 'nosh.example', 'fees.example']);
    expect(inputs.lanes).toMatchObject({
      pull: { unmeasuredAssets: ['meals.example', 'nosh.example'] },
      hygiene: { unmeasuredAssets: ['nosh.example', 'fees.example'] },
    });
    expect(inputs).toMatchObject({ failureCount: 2, connectionBackAt: null });
    expect(await openEgressFlags()).toBe(1);
  });

  it('stays open when one collector recovers first, and clears only when the last one has', async () => {
    await darkRun('pull', NIGHT, ['meals.example', 'nosh.example']);
    await darkRun('hygiene', AT, ['nosh.example', 'fees.example']);

    // The pull collector gets through again and measures everything it owes.
    const pull = new EgressGate(env, { lane: 'pull', fetchImpl: stub(UP).fetchImpl, at: MORNING });
    expect(await pull.finalize()).toMatchObject({ up: true, probes: 1, refreshed: 1, resolved: 0 });

    const open = await egressFlag();
    expect(open!.resolved_at).toBeNull();
    // What is left is exactly what hygiene is still owed — and the alert says
    // the connection itself is back, rather than still claiming it is down.
    expect(open!.message).toBe('OS connection back — 2 properties not yet re-checked');
    const inputs = await inputsOf();
    expect(Object.keys(inputs.lanes)).toEqual(['hygiene']);
    expect(inputs.unmeasuredAssets).toEqual(['nosh.example', 'fees.example']);
    expect(inputs.connectionBackAt).toBe(MORNING);

    // Hygiene re-runs with nothing failing: it asks once (it is owed a
    // retraction) and, as the last collector owed anything, clears the flag.
    const hygiene = new EgressGate(env, { lane: 'hygiene', fetchImpl: stub(UP).fetchImpl, at: NEXT_NIGHT });
    expect(await hygiene.finalize()).toMatchObject({ up: true, probes: 1, resolved: 1 });
    expect((await egressFlag())!.resolved_at).toBe(NEXT_NIGHT);
    expect(await openEgressFlags()).toBe(0);
  });

  it('a collector that missed nothing asks once until the connection is seen back, then costs nothing', async () => {
    await darkRun('hygiene', AT, ['meals.example']);

    // First run after recovery from a collector with no entry: it still asks,
    // because nothing has yet written the up reading that closes the dark span.
    const first = stub(UP);
    const google = new EgressGate(env, { lane: 'google-signals', fetchImpl: first.fetchImpl, at: MORNING });
    expect(await google.finalize()).toMatchObject({ up: true, probes: 1, resolved: 0 });
    expect(first.probes).toHaveLength(1);
    expect((await inputsOf()).connectionBackAt).toBe(MORNING);
    expect((await egressFlag())!.resolved_at).toBeNull();

    // Once that is on record, the same kind of run has nothing to ask.
    const second = stub(UP);
    const again = new EgressGate(env, { lane: 'google-signals', fetchImpl: second.fetchImpl, at: NEXT_NIGHT });
    expect(await again.finalize()).toMatchObject({ checked: false, probes: 0 });
    expect(second.probes).toEqual([]);
  });

  it.each([
    ['no flag is open yet', false],
    ['the flag is already open', true],
  ])('keeps every entry when two collectors settle the flag at the same moment (%s)', async (_, opened) => {
    if (opened) await darkRun('hygiene', '2026-08-08T01:00:00.000Z', ['fees.example']);
    // The 02:30 tick runs pull and Bing together; both rewrite one row, and
    // neither may overwrite the other's entry with what it read before.
    const pull = new EgressGate(env, { lane: 'pull', fetchImpl: stub({}).fetchImpl, at: NIGHT });
    const bing = new EgressGate(env, { lane: 'bing-signals', fetchImpl: stub({}).fetchImpl, at: NIGHT });
    await Promise.all([pull.isDown(), bing.isDown()]);
    pull.recordUnmeasured('meals.example');
    bing.recordUnmeasured('nosh.example');
    await Promise.all([pull.finalize(), bing.finalize()]);

    const inputs = await inputsOf();
    const lanes = opened ? ['bing-signals', 'hygiene', 'pull'] : ['bing-signals', 'pull'];
    const assets = opened ? ['fees.example', 'meals.example', 'nosh.example'] : ['meals.example', 'nosh.example'];
    expect(Object.keys(inputs.lanes).sort()).toEqual(lanes);
    expect([...inputs.unmeasuredAssets].sort()).toEqual(assets);
    expect(await openEgressFlags()).toBe(1);
  });

  it('lets a scoped run clear only the slice it covered', async () => {
    const dark = new EgressGate(env, { lane: 'dataforseo', fetchImpl: stub({}).fetchImpl, at: AT });
    await dark.isDown();
    dark.recordUnmeasured('meals.example', 'ranked-keywords');
    dark.recordUnmeasured('meals.example', 'backlinks-summary');
    dark.recordUnmeasured('nosh.example', 'ranked-keywords');
    await dark.finalize();
    expect((await inputsOf()).lanes.dataforseo).toMatchObject({
      unmeasuredAssets: ['meals.example', 'nosh.example'],
      parts: {
        'meals.example': ['ranked-keywords', 'backlinks-summary'],
        'nosh.example': ['ranked-keywords'],
      },
    });

    // An on-demand collection of one family for one property, connection back.
    const scoped = new EgressGate(env, { lane: 'dataforseo', fetchImpl: stub(UP).fetchImpl, at: MORNING });
    await scoped.finalize({
      covers: (asset, part) => asset === 'meals.example' && part === 'ranked-keywords',
    });

    expect((await inputsOf()).lanes.dataforseo).toMatchObject({
      unmeasuredAssets: ['meals.example', 'nosh.example'],
      parts: { 'meals.example': ['backlinks-summary'], 'nosh.example': ['ranked-keywords'] },
    });
    expect((await egressFlag())!.resolved_at).toBeNull();
  });

  it('retracts a flag written before collectors kept their own entries on the first up verdict', async () => {
    await insertFlag({
      asset: 'root-os',
      firedAt: AT,
      severity: 'warn',
      kind: 'anomaly',
      message: 'OS egress down — 2 properties unmeasured',
      ruleId: EGRESS_DOWN_RULE_ID,
      ruleInputs: JSON.stringify({ rule: EGRESS_DOWN_RULE_ID, beacons: [], unmeasuredAssets: ['a', 'b'], failureCount: 4 }),
    });

    const back = new EgressGate(env, { lane: 'pull', fetchImpl: stub(UP).fetchImpl, at: MORNING });
    expect(await back.finalize()).toMatchObject({ up: true, resolved: 1 });
    expect(await openEgressFlags()).toBe(0);
  });
});

describe('watchTransport — which failures the provider collectors may ask about (ro-aed0)', () => {
  it('recognizes only what the watched fetcher itself threw', async () => {
    const { fetchImpl } = stub({ 'https://api.example.test/ok': () => new Response('{}', { status: 503 }) });
    const transport = watchTransport(fetchImpl);

    const thrown = await transport.fetch('https://api.example.test/dark').catch((error: unknown) => error);
    expect(transport.statusless(thrown)).toBe(true);
    // Rethrown untouched: every caller's handling sees what it always saw.
    expect((thrown as Error).message).toBe('internal error; reference = 0d9f4a2c');

    // A status is an answer, whatever it says — and an error built from one, or
    // thrown by anything but the fetcher, is never the uplink's.
    const answered = await transport.fetch('https://api.example.test/ok');
    expect(answered.status).toBe(503);
    expect(transport.statusless(new Error('HTTP 503'))).toBe(false);
    expect(transport.statusless('internal error; reference = 0d9f4a2c')).toBe(false);
    expect(transport.statusless(null)).toBe(false);
  });

  it('asks the gate only about a status-less failure', async () => {
    const { fetchImpl, probes } = stub({});
    const transport = watchTransport(fetchImpl);
    const gate = new EgressGate(env, { lane: 'hygiene', fetchImpl, at: AT });

    expect(await egressExplains(gate, transport, new Error('provider said no'))).toBe(false);
    expect(probes).toEqual([]);

    const thrown = await transport.fetch('https://api.example.test/dark').catch((error: unknown) => error);
    expect(await egressExplains(gate, transport, thrown)).toBe(true);
    expect(probes.map((p) => p.url)).toEqual(['https://api.example.test/dark', CLOUDFLARE, GOOGLE]);
  });
});
