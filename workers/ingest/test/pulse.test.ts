import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ASSET_TOKENS } from './fixtures.js';
import { rollUpAlertDay } from '../src/alert-daily.js';
import { call, insertAnnotation, insertFlag, pgCount, pgRows, reset } from './helpers.js';

const MEALS = 'meals.example';

beforeEach(reset);

function pulseRequest(body: unknown, token?: string): Request {
  return new Request('https://ingest.local/api/pulse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validEnvelope(generatedAt = '2026-07-05T03:00:00.000Z') {
  return {
    asset: MEALS,
    generatedAt,
    capabilities: ['signups', 'plansSaved'],
    metrics: {
      signups: { last24h: 11, avg7d: 9.3, total: 4210 }, // healthy
      plansSaved: { last24h: 0, avg7d: 6.2, total: 1880 }, // fires flow-poisson-low
    },
    flags: [{ severity: 'info', kind: 'milestone', metric: 'signups', msg: '4000 signups' }],
  };
}

async function seedSeasonalHistory(): Promise<void> {
  for (const date of ['2026-06-07', '2026-06-14', '2026-06-21', '2026-06-28']) {
    const envelope = validEnvelope(`${date}T03:00:00.000Z`);
    envelope.metrics.signups.last24h = 10;
    envelope.metrics.plansSaved.last24h = 6;
    envelope.flags = [];
    const res = await call(pulseRequest(envelope, ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
  }
}

describe('POST /api/pulse — auth', () => {
  it('rejects a request with no bearer token (401)', async () => {
    const res = await call(pulseRequest(validEnvelope()));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token (401)', async () => {
    const res = await call(pulseRequest(validEnvelope(), 'not-the-token'));
    expect(res.status).toBe(401);
  });

  it('rejects a token for a different/unknown asset (401)', async () => {
    const body = { ...validEnvelope(), asset: 'ghost.site' };
    const res = await call(pulseRequest(body, ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(401);
  });

  it('rejects a body with no asset id (401)', async () => {
    const res = await call(pulseRequest({ generatedAt: '2026-07-05T03:00:00Z' }, ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/pulse — validation', () => {
  it('returns 422 with issues for an authenticated but invalid envelope', async () => {
    const bad = { asset: MEALS, generatedAt: '2026-07-05T03:00:00Z' }; // no capabilities/metrics
    const res = await call(pulseRequest(bad, ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('unprocessable_entity');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await call(pulseRequest('{not json', ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/pulse — write + flag explosion + central rules', () => {
  it('stays quiet until four matching weekdays establish a central baseline', async () => {
    const res = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { centralFlags: number };
    expect(body.centralFlags).toBe(0);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'`,
        [MEALS],
      ),
    ).toBe(0);
  });

  it('writes the pulse, explodes its flag, and fires against matching weekdays', async () => {
    await seedSeasonalHistory();
    const res = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      date: string;
      envelopeFlags: number;
      centralFlags: number;
    };
    expect(body.ok).toBe(true);
    expect(body.date).toBe('2026-07-05');
    expect(body.envelopeFlags).toBe(1);
    expect(body.centralFlags).toBe(1);

    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = $1`, [MEALS])).toBe(5);

    // asset-declared milestone flag exploded verbatim
    const [declared] = await pgRows<{ severity: string; kind: string; metric: string }>(
      `SELECT severity, kind, metric FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = 'asset-declared'`,
      [MEALS],
    );
    expect(declared).toMatchObject({ severity: 'info', kind: 'milestone', metric: 'signups' });

    // centrally-computed drop flag with mandatory rule_id + rule_inputs
    const [central] = await pgRows<{
      severity: string;
      kind: string;
      metric: string;
      rule_id: string;
      rule_inputs: string;
      pulse_id: number;
    }>(
      `SELECT severity, kind, metric, rule_id, rule_inputs::text AS rule_inputs, pulse_day_number::int AS pulse_id
         FROM noticeos.current_flags
        WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'`,
      [MEALS],
    );
    expect(central).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'plansSaved' });
    expect(central?.pulse_id).toBeTypeOf('number');
    const inputs = JSON.parse(central!.rule_inputs) as {
      observed: number;
      baselinePerDay: number;
      baselineSource: string;
      baselineComparisonDates: string[];
    };
    expect(inputs.observed).toBe(0);
    expect(inputs.baselinePerDay).toBe(6);
    expect(inputs.baselineSource).toBe('same-weekday-4w');
    expect(inputs.baselineComparisonDates).toEqual([
      '2026-06-28',
      '2026-06-21',
      '2026-06-14',
      '2026-06-07',
    ]);
  });

  /**
   * The cohort decision (2026-09-04, bead `ro-kukv.8`, docs/02).
   *
   * The charts now MARK the two days a reporting-timezone change distorted, and
   * a mark on one surface invites the same exclusion everywhere. It does not
   * apply here: this cohort is built from stored PULSES — the asset's own
   * counters out of its own database — while a reporting timezone is a setting
   * on a provider's property. This test pins the boundary, so a later
   * "helpful" exclusion has to argue with a red test rather than quietly
   * silence a metric for four weeks.
   */
  it('keeps a day a reporting-timezone change distorted inside the baseline cohort', async () => {
    await seedSeasonalHistory();
    // The collector's own record of the change, dated to the day the two
    // day-definitions diverged — which is one of the four comparison dates.
    await insertAnnotation({
      asset: MEALS,
      at: '2026-06-28T00:00:00.000Z',
      kind: 'config',
      ref: 'reporting-time-zone-changed:ga4:America/Los_Angeles->America/New_York',
      note: 'GA4 reporting timezone changed.',
    });

    const res = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { centralFlags: number }).centralFlags).toBe(1);

    const [central] = await pgRows<{ rule_inputs: string }>(
      `SELECT rule_inputs::text AS rule_inputs FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'`,
      [MEALS],
    );
    const inputs = JSON.parse(central!.rule_inputs) as {
      baselinePerDay: number;
      baselineSampleSize: number;
      baselineComparisonDates: string[];
    };
    // All four weekdays, the distorted one included, and the same ruler as the
    // run with no annotation filed.
    expect(inputs.baselineComparisonDates).toEqual([
      '2026-06-28',
      '2026-06-21',
      '2026-06-14',
      '2026-06-07',
    ]);
    expect(inputs.baselineSampleSize).toBe(4);
    expect(inputs.baselinePerDay).toBe(6);
  });

  it('same-day re-push replaces the row and re-derives flags without duplicating', async () => {
    await seedSeasonalHistory();
    const first = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(first.status).toBe(201);
    const second = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(second.status).toBe(201);

    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = $1`, [MEALS])).toBe(5);
    // still exactly one of each derived flag, not two
    expect(
      await pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = 'asset-declared'`, [
        MEALS,
      ]),
    ).toBe(1);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'`,
        [MEALS],
      ),
    ).toBe(1);
  });

  // Bead ro-ujb9.76.5.2: the first push's untouched alerts stay in the store,
  // replaced, where D1 deleted them; no count reads them.
  it('same-day re-push leaves its replaced alerts out of the nightly open count', async () => {
    await seedSeasonalHistory();
    expect((await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]))).status).toBe(201);
    const onePush = await pgCount(
      `SELECT count(*) AS n FROM noticeos.current_flags WHERE asset_id = $1 AND resolved_at IS NULL`,
      [MEALS],
    );
    expect(onePush).toBeGreaterThan(0);
    expect((await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]))).status).toBe(201);

    expect(
      await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE asset_id = $1 AND replaced_by_pulse_id IS NOT NULL`, [
        MEALS,
      ]),
    ).toBe(onePush);
    await rollUpAlertDay(env, Date.now());
    const [day] = await pgRows<{ open: number }>(
      `SELECT open FROM noticeos.alert_daily_counts WHERE asset_id = $1`,
      [MEALS],
    );
    expect(day?.open).toBe(onePush);
  });

  it('same-day re-push preserves a dispositioned event and does not reopen it', async () => {
    await seedSeasonalHistory();
    const first = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(first.status).toBe(201);
    expect(((await first.json()) as { centralFlags: number }).centralFlags).toBe(1);
    const [central] = await env.STORE.write((tx) =>
      tx.query<{ id: number }>(
        `UPDATE noticeos.flags
            SET disposition = 'ack',
                disposition_at = '2026-07-05T04:00:00.000Z',
                disposition_note = 'Marked read by operator'
          WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'
          RETURNING flag_number::int AS id`,
        [MEALS],
      ),
    );

    const repush = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(repush.status).toBe(201);
    expect(((await repush.json()) as { centralFlags: number }).centralFlags).toBe(0);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags
          WHERE flag_number = $1 AND disposition = 'ack'
            AND disposition_note = 'Marked read by operator'`,
        [central!.id],
      ),
    ).toBe(1);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags
          WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'
            AND disposition IS NULL AND resolved_at IS NULL`,
        [MEALS],
      ),
    ).toBe(0);
  });

  /**
   * `ro-c7qq`. Every other lane's dedup is keyed on (asset, rule, unresolved),
   * so an open flag — snoozed or not — already stops it re-firing. THIS lane is
   * keyed on `pulse_id`, and a pulse is a new row every night, so without an
   * explicit arm the operator would park a condition at 09:00 and find it back
   * on the board by morning. The cron would defeat the feature.
   */
  describe('a condition the operator snoozed is not raised again tonight', () => {
    /**
     * This fixture seeds its OWN weekday history rather than reusing
     * `seedSeasonalHistory`. Proving the suppression needs a later pulse that
     * genuinely WOULD have fired, and with the shared seed the dip under test
     * drags its own baseline under the rule — a green test that proves nothing.
     * A healthy level well clear of the floor keeps the later collapse a
     * collapse.
     */
    const HEALTHY = 20;

    /** One pulse, on a Sunday so every date here shares a seasonal weekday. */
    async function push(date: string, plansSaved: number): Promise<number> {
      const envelope = validEnvelope(`${date}T03:00:00.000Z`);
      envelope.metrics.signups.last24h = 10;
      envelope.metrics.plansSaved.last24h = plansSaved;
      envelope.flags = [];
      const res = await call(pulseRequest(envelope, ASSET_TOKENS[MEALS]));
      expect(res.status).toBe(201);
      return ((await res.json()) as { centralFlags: number }).centralFlags;
    }

    /** Four healthy Sundays, then a fifth where plansSaved collapses to zero. */
    async function historyThenOneAlert(): Promise<void> {
      for (const date of ['2026-06-07', '2026-06-14', '2026-06-21', '2026-06-28']) {
        expect(await push(date, HEALTHY)).toBe(0);
      }
      expect(await push('2026-07-05', 0)).toBe(1);
    }

    /** The flag that alert left, parked until `until`. Returns its id. */
    async function snoozeFlowAlert(until: string): Promise<number> {
      const [row] = await env.STORE.write((tx) =>
        tx.query<{ id: number }>(
          `UPDATE noticeos.flags
              SET disposition = 'snooze',
                  disposition_at = '2026-07-05T04:00:00.000Z',
                  disposition_note = 'Snoozed by operator',
                  snooze_until = $2::timestamptz
            WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'
            RETURNING flag_number::int AS id`,
          [MEALS, until],
        ),
      );
      return row!.id;
    }

    const openFlowAlerts = () =>
      pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags
          WHERE asset_id = $1 AND rule_id = 'flow-poisson-low'
            AND disposition IS NULL AND resolved_at IS NULL`,
        [MEALS],
      );

    it('inserts nothing for the NEXT pulse while the snooze is running', async () => {
      await historyThenOneAlert();
      // Far future, so the assertion does not depend on this machine's clock.
      const parked = await snoozeFlowAlert('2099-01-01T00:00:00.000Z');

      // The next Sunday: a different pulse row, and the same collapse — the
      // test below proves this pulse fires when nothing is parked.
      expect(await push('2026-07-12', 0)).toBe(0);
      expect(await openFlowAlerts()).toBe(0);

      // The parked row is untouched — same id, same silence, same date.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM noticeos.current_flags
            WHERE flag_number = $1 AND disposition = 'snooze'
              AND snooze_until = '2099-01-01T00:00:00.000Z'`,
          [parked],
        ),
      ).toBe(1);
    });

    it('fires again once the snooze has run out — silence has an end', async () => {
      await historyThenOneAlert();
      await snoozeFlowAlert('2020-01-01T00:00:00.000Z');

      expect(await push('2026-07-12', 0)).toBe(1);
      expect(await openFlowAlerts()).toBe(1);
    });

    it('closes a snoozed flow alert when the metric itself recovers', async () => {
      await historyThenOneAlert();
      const parked = await snoozeFlowAlert('2099-01-01T00:00:00.000Z');

      expect(await push('2026-07-12', HEALTHY)).toBe(0);

      // A snooze says "ask me later", and the metric has answered. Leaving the
      // row parked would hand back a month-old false alarm on its date.
      expect(
        await pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE flag_number = $1 AND resolved_at IS NOT NULL`, [
          parked,
        ]),
      ).toBe(1);
    });

    it('still refuses to close an ACKED alert the same way', async () => {
      await historyThenOneAlert();
      const [acked] = await env.STORE.write((tx) =>
        tx.query<{ id: number }>(
          `UPDATE noticeos.flags SET disposition = 'ack', disposition_at = '2026-07-05T04:00:00.000Z'
            WHERE asset_id = $1 AND rule_id = 'flow-poisson-low' RETURNING flag_number::int AS id`,
          [MEALS],
        ),
      );

      await push('2026-07-12', HEALTHY);

      // Ack and resolve are the operator saying "done with this"; a lane may
      // not rewrite that. Only the disposition that ASKS TO BE REVISITED is
      // closable by the evidence.
      expect(
        await pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE flag_number = $1 AND resolved_at IS NULL`, [
          acked!.id,
        ]),
      ).toBe(1);
    });
  });

  it('compares a Saturday with prior Saturdays instead of a misleading weekday average', async () => {
    for (const date of ['2026-06-06', '2026-06-13', '2026-06-20', '2026-06-27']) {
      const envelope = validEnvelope(`${date}T03:00:00.000Z`);
      envelope.metrics.signups.last24h = 20;
      envelope.metrics.plansSaved.last24h = 20;
      envelope.flags = [];
      expect((await call(pulseRequest(envelope, ASSET_TOKENS[MEALS]))).status).toBe(201);
    }

    const saturday = validEnvelope('2026-07-04T03:00:00.000Z');
    saturday.metrics.signups = { last24h: 18, avg7d: 80, total: 4210 };
    saturday.metrics.plansSaved = { last24h: 18, avg7d: 80, total: 1880 };
    saturday.flags = [];
    const res = await call(pulseRequest(saturday, ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { centralFlags: number }).centralFlags).toBe(0);
  });

  it('resolves an older flow anomaly when a new reading arrives', async () => {
    await insertFlag({
      asset: MEALS,
      firedAt: '2026-07-04T03:00:00.000Z',
      severity: 'warn',
      kind: 'anomaly',
      metric: 'plansSaved',
      message: 'old drop',
      ruleId: 'flow-poisson-low',
      ruleInputs: '{}',
    });

    const res = await call(pulseRequest(validEnvelope(), ASSET_TOKENS[MEALS]));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { resolvedAnomalies: number }).resolvedAnomalies).toBe(1);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM noticeos.current_flags
          WHERE asset_id = $1 AND rule_id = 'flow-poisson-low' AND resolved_at IS NULL`,
        [MEALS],
      ),
    ).toBe(0);
  });
});
