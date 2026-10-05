import { env } from 'cloudflare:test';
import { REPORT_MAX_AGE_HOURS } from '@noticeos/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigOps, forgetConfigCache, getConfigDocument } from '../src/config-store.js';
import { runFreshnessCheck, writePulse } from '../src/db.js';
import { flagRows, forgetConfigDocuments, insertFlag, insertPulse as insertReport, pgCount, reset } from './helpers.js';
import { TEST_SITES } from './invented-sites';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-05T12:00:00.000Z');
// db/0002 registers every seeded asset at 2026-07-05T00:00Z, so NOW sits 12h
// after registration and LATER 60h after it — past the 48h age that used to
// make a site that never reported an error (before D29's amendment).
const LATER = Date.parse('2026-07-07T12:00:00.000Z');

/**
 * Every seeded asset, counted from the shared fixture rather than restated, so
 * registering the next one moves the number instead of reddening this file.
 * With no report stored, every one of them expects none (D29 amended,
 * `ro-ujb9.121`), so they are all outside the obligation.
 */
const ALL_ASSETS = TEST_SITES.length;

beforeEach(reset);

/** One report of `asset` for `date`, arriving at `receivedAtMs`: a second one
 * for the same day is that day's next revision, which is its report now. */
async function insertPulse(asset: string, date: string, receivedAtMs: number): Promise<void> {
  const iso = new Date(receivedAtMs).toISOString();
  await insertReport({ asset, date, generatedAt: iso, receivedAt: iso });
}

/** One `egress_checks` reading, the shape src/egress.ts writes, on Postgres. */
async function insertEgressCheck(observedAtMs: number, up: boolean): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail) VALUES ($1, $2::timestamptz, $3, '{}')`,
      [tx.workspaceId, new Date(observedAtMs).toISOString(), up],
    ),
  );
}

async function freshnessInputs(asset: string): Promise<Record<string, unknown> | null> {
  const [row] = await flagRows(`asset_id = $1 AND rule_id = 'ingest-freshness'`, [asset]);
  return row ? (JSON.parse(row.rule_inputs!) as Record<string, unknown>) : null;
}

async function freshnessMessage(asset: string): Promise<string | null> {
  const [row] = await flagRows(`asset_id = $1 AND rule_id = 'ingest-freshness'`, [asset]);
  return row?.message ?? null;
}

async function openFreshness(asset: string): Promise<number> {
  return pgCount(
    `SELECT count(*) AS n FROM noticeos.current_flags
      WHERE asset_id = $1 AND rule_id = 'ingest-freshness' AND resolved_at IS NULL`,
    [asset],
  );
}

describe('hourly ingest-freshness cron', () => {
  it('fires an error flag once the latest pulse is past the shared threshold', async () => {
    const now = NOW;
    await insertPulse('meals.example', '2026-07-03', now - 50 * HOUR);

    const result = await runFreshnessCheck(env, now);
    expect(result.fired).toBe(1);
    expect(await openFreshness('meals.example')).toBe(1);

    const [flag] = await flagRows(`asset_id = 'meals.example' AND rule_id = 'ingest-freshness'`);
    expect(flag).toMatchObject({ severity: 'error', kind: 'anomaly', pulse_id: null });
    // The message quotes the ONE threshold, so the operator reading the flag and
    // the operator reading the SYSTEM count are told the same number.
    expect(flag!.message).toBe(`no pulse in 50h (> ${REPORT_MAX_AGE_HOURS}h threshold)`);
  });

  it('does not double-fire while an identical open flag exists', async () => {
    const now = NOW;
    await insertPulse('meals.example', '2026-07-03', now - 50 * HOUR);

    expect((await runFreshnessCheck(env, now)).fired).toBe(1);
    expect((await runFreshnessCheck(env, now)).fired).toBe(0);
    expect(await openFreshness('meals.example')).toBe(1);
  });

  // ro-uwo.1. 40h used to be the contradiction age: this cron fired an error at
  // 36h while the Tower's SYSTEM card counted the same property fresh until 48h,
  // so one payload carried both claims about one property. The cron now reads
  // the contract's REPORT_MAX_AGE_HOURS, which is what the wall payload counts
  // with (apps/tower/test/wall-payload.test.ts asserts the other half).
  it('holds fire at 40h — the age the two surfaces used to disagree at', async () => {
    const now = NOW;
    await insertPulse('meals.example', '2026-07-03', now - 40 * HOUR);

    const result = await runFreshnessCheck(env, now);
    expect(result.fired).toBe(0);
    expect(await openFreshness('meals.example')).toBe(0);
    // Not merely unflagged — counted fresh, the same word the Tower uses.
    expect(result.fresh).toBe(1);
    expect(result.stale).toBe(0);
  });

  it('calls a property stale at exactly the age the contract does', async () => {
    const now = NOW;
    await insertPulse('nosh.example', '2026-07-03', now - REPORT_MAX_AGE_HOURS * HOUR);
    expect((await runFreshnessCheck(env, now)).stale).toBe(0);

    await insertPulse('nosh.example', '2026-07-03', now - (REPORT_MAX_AGE_HOURS + 1) * HOUR);
    const late = await runFreshnessCheck(env, now);
    expect(late.stale).toBe(1);
    expect(late.fired).toBe(1);
  });

  it('does not fire for a fresh asset', async () => {
    const now = NOW;
    await insertPulse('nosh.example', '2026-07-05', now - 10 * HOUR);

    const result = await runFreshnessCheck(env, now);
    expect(result.fired).toBe(0);
    expect(await openFreshness('nosh.example')).toBe(0);
  });

  it('excludes pre-launch assets even when stale', async () => {
    const now = NOW;
    await insertPulse('fees.example', '2026-07-02', now - 60 * HOUR); // fees.example is pre-launch

    await runFreshnessCheck(env, now);
    expect(await openFreshness('fees.example')).toBe(0);
  });

  it('auto-resolves the open freshness flag when a new pulse arrives', async () => {
    const now = NOW;
    await insertPulse('meals.example', '2026-07-03', now - 50 * HOUR);
    await runFreshnessCheck(env, now);
    expect(await openFreshness('meals.example')).toBe(1);

    await writePulse(env, {
      asset: 'meals.example',
      generatedAt: new Date(now).toISOString(),
      capabilities: ['signups'],
      metrics: { signups: { last24h: 5, avg7d: 4.2, total: 100 } },
    });

    expect(await openFreshness('meals.example')).toBe(0);
  });
});

// D29, amended 2026-09-23 (bead ro-ujb9.121). A site expects a nightly report
// once it has sent one. Before, a site that had never sent one was an error 48h
// after it was added — on a new installation, for a sender nobody had set up.
describe('a site that has never sent a report owes none', () => {
  it('is outside the expected set and fires nothing, however long ago it was added', async () => {
    const result = await runFreshnessCheck(env, LATER);

    expect(result.checked).toBe(0);
    expect(result).not.toHaveProperty("neverReported");
    expect(result.notExpected).toBe(ALL_ASSETS);
    expect(result.fired).toBe(0);
    expect(await openFreshness('pacer.example')).toBe(0);
  });

  it('counts only the sites that have sent one', async () => {
    await insertPulse('nosh.example', '2026-07-05', NOW - 2 * HOUR);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.checked).toBe(1);
    expect(result.fresh).toBe(1);
    expect(result.notExpected).toBe(ALL_ASSETS - 1);
  });

  it('expects a report from the first one on, so a sender that stops goes stale and fires', async () => {
    await insertPulse('areas.example', '2026-07-05', NOW);
    const first = await runFreshnessCheck(env, NOW);
    expect(first.checked).toBe(1);
    expect(first.fresh).toBe(1);

    const stopped = await runFreshnessCheck(env, LATER + 2 * HOUR);
    expect(stopped.stale).toBe(1);
    expect(stopped.fired).toBe(1);
    expect(await openFreshness('areas.example')).toBe(1);
    expect(await freshnessInputs('areas.example')).toMatchObject({ state: 'stale' });
  });

  it('resolves a "never reported" flag fired under the old rule on the next run', async () => {
    await insertFlag({
      asset: 'pacer.example',
      firedAt: new Date(LATER).toISOString(),
      severity: 'error',
      kind: 'anomaly',
      metric: 'pulse',
      message: 'no pulse ever received',
      ruleId: 'ingest-freshness',
      ruleInputs: '{"state":"never-reported"}',
    });
    // A sender that really stopped keeps its flag.
    await insertPulse('meals.example', '2026-07-03', NOW - 50 * HOUR);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.released).toBe(1);
    expect(await openFreshness('pacer.example')).toBe(0);
    expect(await openFreshness('meals.example')).toBe(1);
  });

  it('never fires for a pre-launch property, however long it stays silent', async () => {
    await runFreshnessCheck(env, LATER);
    expect(await openFreshness('fees.example')).toBe(0);
  });
});

// ro-ujb9.96.8. The operator may declare that an asset sends no nightly report.
// Declared through the SAME write the asset Settings switch performs, then read
// store first by the cron.
describe('assets declared as sending no nightly report', () => {
  const DECLARED = ['areas.example', 'pacer.example'];

  async function declare(assets: string[]): Promise<void> {
    const result = await applyConfigOps(env, {
      actor: 'operator',
      slug: 'no-nightly-report',
      ops: [
        {
          kind: 'file-json-set',
          file: 'config/constants.json',
          pointer: '/no_nightly_report',
          expectAbsent: true,
          value: assets,
        },
      ],
    });
    expect(result.ok).toBe(true);
  }

  beforeEach(async () => {
    forgetConfigCache();
    await forgetConfigDocuments(['config/constants.json']);
    forgetConfigCache();
  });
  afterEach(async () => {
    await forgetConfigDocuments(['config/constants.json']);
    forgetConfigCache();
  });

  it('never fires for a declared asset and leaves it out of the expected set', async () => {
    await declare(DECLARED);
    // Both declared sites once sent a report that has since gone quiet, and so
    // did one site that declared nothing.
    for (const asset of [...DECLARED, 'meals.example']) await insertPulse(asset, '2026-07-03', NOW - 50 * HOUR);
    const result = await runFreshnessCheck(env, NOW);

    expect(await openFreshness('areas.example')).toBe(0);
    expect(await openFreshness('pacer.example')).toBe(0);
    expect(await openFreshness('meals.example')).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.fired).toBe(1);
    expect(result.notExpected).toBe(ALL_ASSETS - 1);
  });

  it('resolves a freshness flag opened before the declaration on the next run', async () => {
    for (const asset of [...DECLARED, 'meals.example']) await insertPulse(asset, '2026-07-03', NOW - 50 * HOUR);
    await runFreshnessCheck(env, NOW);
    expect(await openFreshness('areas.example')).toBe(1);

    await declare(DECLARED);
    const result = await runFreshnessCheck(env, NOW + HOUR);

    expect(result.released).toBe(DECLARED.length);
    expect(await openFreshness('areas.example')).toBe(0);
    expect(await openFreshness('pacer.example')).toBe(0);
    // Resolved, not deleted: the store is history, and the row says when.
    const [row] = await flagRows(`asset_id = 'areas.example' AND rule_id = 'ingest-freshness'`);
    expect(row?.resolved_at).toBe(new Date(NOW + HOUR).toISOString());
    // An asset that did not declare keeps its flag.
    expect(await openFreshness('meals.example')).toBe(1);
  });

  it('does not call a declared asset stale when the report it once sent goes quiet', async () => {
    await declare(['meals.example']);
    await insertPulse('meals.example', '2026-07-03', NOW - 50 * HOUR);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.stale).toBe(0);
    expect(await openFreshness('meals.example')).toBe(0);
  });

  it('accepts a report a declared asset sends anyway, and keeps the declaration', async () => {
    await declare(DECLARED);
    const written = await writePulse(env, {
      asset: 'areas.example',
      generatedAt: new Date(LATER).toISOString(),
      capabilities: ['lookups'],
      metrics: { lookups: { last24h: 12, avg7d: 11, total: 300 } },
    });
    expect(written.pulseId).toBeGreaterThan(0);

    const result = await runFreshnessCheck(env, LATER);
    // Still not owed: shown when it arrives, never counted when it stops.
    expect(result.fresh).toBe(0);
    const saved = await getConfigDocument(env, 'config/constants.json');
    expect((saved.body as { no_nightly_report: string[] }).no_nightly_report).toEqual(DECLARED);
  });
});

// ro-6le. The egress gate (src/egress.ts) stopped the 2026-08-08 uplink outage
// from being reported as six properties' outage — but only for the checks that
// ran that night. Two days later THIS rule came around and fired "no pulse in
// 48h" on the same properties: the same wrong accusation through a second door,
// because a pull-mode property cannot report when the OS cannot reach it (and a
// push-mode one cannot reach the OS either).
//
// The semantics these pin: staleness does not count hours the OS itself was
// dark, and it counts nothing the store does not evidence — the gate is lazy, so
// a night with no readings is a night on which nothing failed.
//
// meals.example is a pull-mode asset (config/pull.json): the OS fetches its
// report, so a dead uplink is exactly what silences it.
describe('staleness does not count hours the OS was dark', () => {
  const at = (hoursAgo: number): number => NOW - hoursAgo * HOUR;

  /** A two-night outage, the shape of 2026-08-08: the 02:30 pull lane and the
   * 04:00 hygiene sweep each probe and each come back down, two nights running,
   * and the first lane run after recovery writes the up reading that closes it.
   * Evidenced dark span: the 25h from the first down reading to the last. */
  async function twoNightOutage(): Promise<void> {
    await insertEgressCheck(at(50), false);
    await insertEgressCheck(at(49), false);
    await insertEgressCheck(at(26), false);
    await insertEgressCheck(at(25), false);
    await insertEgressCheck(at(1), true);
  }

  it('withholds the flag when the dark hours account for the silence', async () => {
    await insertPulse('meals.example', '2026-07-02', at(70));
    await twoNightOutage();

    const result = await runFreshnessCheck(env, NOW);

    // 70h silent, 25h of it with this house's uplink down: 45h of real silence,
    // inside the threshold. No accusation.
    expect(result.fired).toBe(0);
    expect(await openFreshness('meals.example')).toBe(0);
    // Still counted stale, and counted as gated. The report IS late — what is
    // withheld is the accusation, not the fact, and the Tower reads the same
    // property stale off the same store (ro-uwo.1).
    expect(result.stale).toBe(1);
    expect(result.egressGated).toBe(1);
  });

  it('still fires when the property was silent longer than the outage explains', async () => {
    await insertPulse('meals.example', '2026-07-02', at(80));
    await insertEgressCheck(at(60), false);
    await insertEgressCheck(at(50), false);
    await insertEgressCheck(at(49), true);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.fired).toBe(1);
    expect(result.egressGated).toBe(0);
    // 80h silent, 10h of it dark: 70h unexplained, well past the threshold. The
    // flag fires — and says how much of it was the OS, so the operator is not
    // sent to read a property's logs for hours nobody could have reported in.
    expect(await freshnessMessage('meals.example')).toBe(
      `no pulse in 80h (> ${REPORT_MAX_AGE_HOURS}h threshold) · OS offline 10h`,
    );
    expect(await freshnessInputs('meals.example')).toMatchObject({
      state: 'stale',
      ageHours: 80,
      osDarkHours: 10,
      thresholdHours: REPORT_MAX_AGE_HOURS,
    });
  });

  it('is unchanged, to the byte, when the store holds no egress evidence', async () => {
    await insertPulse('meals.example', '2026-07-03', at(50));

    const result = await runFreshnessCheck(env, NOW);
    expect(result).toMatchObject({ fired: 1, stale: 1, egressGated: 0 });
    expect(await freshnessMessage('meals.example')).toBe(
      `no pulse in 50h (> ${REPORT_MAX_AGE_HOURS}h threshold)`,
    );
    // toEqual, not toMatchObject: the inputs of an ungated flag carry exactly
    // the fields they carried before this rule learned about egress at all —
    // no osDarkHours: 0, which would be a claim where there is no reading.
    expect(await freshnessInputs('meals.example')).toEqual({
      rule: 'ingest-freshness',
      state: 'stale',
      lastReceivedAt: new Date(at(50)).toISOString(),
      thresholdHours: REPORT_MAX_AGE_HOURS,
      ageHours: 50,
      evaluatedAt: new Date(NOW).toISOString(),
    });
  });

  it('credits only the hours two down readings bracket — a lone one is a moment', async () => {
    await insertPulse('meals.example', '2026-07-02', at(70));
    // A blip 60h ago, egress proven back up 40h ago, another blip 30h ago. Three
    // readings, no span longer than an instant: nothing here excuses 70h.
    await insertEgressCheck(at(60), false);
    await insertEgressCheck(at(40), true);
    await insertEgressCheck(at(30), false);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.fired).toBe(1);
    expect(result.egressGated).toBe(0);
    // No clause and no input: zero dark hours is not a fact worth stating.
    expect(await freshnessMessage('meals.example')).toBe(
      `no pulse in 70h (> ${REPORT_MAX_AGE_HOURS}h threshold)`,
    );
    expect(await freshnessInputs('meals.example')).not.toHaveProperty('osDarkHours');
  });

  it('ignores an outage that ended before the property last reported', async () => {
    await insertPulse('meals.example', '2026-07-03', at(50));
    // Last week's outage, closed 60h ago — outside this silence, so it explains
    // none of it. The property reported AFTER it and then went quiet.
    await insertEgressCheck(at(100), false);
    await insertEgressCheck(at(61), false);
    await insertEgressCheck(at(60), true);

    const result = await runFreshnessCheck(env, NOW);
    expect(result.fired).toBe(1);
    expect(await freshnessInputs('meals.example')).not.toHaveProperty('osDarkHours');
  });

  it('counts only the part of an outage that overlaps the silence', async () => {
    await insertPulse('meals.example', '2026-07-03', at(60));
    // A dark span that began 70h ago — before this property's last report — and
    // ran until 30h ago. Only the 30h inside the silence may be credited: the
    // property demonstrably got a report out mid-outage, so the hours before it
    // are not hours it was prevented from reporting.
    await insertEgressCheck(at(70), false);
    await insertEgressCheck(at(30), false);
    await insertEgressCheck(at(29), true);

    const result = await runFreshnessCheck(env, NOW);
    // 60h silent minus the 30h overlap is 30h — inside the threshold.
    expect(result.fired).toBe(0);
    expect(result.egressGated).toBe(1);
  });

  it('does not retract a flag that was already open when the outage began', async () => {
    // The gate's own rule, and this rule follows it: a gated evaluation files
    // nothing AND resolves nothing. A property that was already delinquent is
    // exactly where the operator left it.
    await insertPulse('meals.example', '2026-07-02', at(70));
    expect((await runFreshnessCheck(env, NOW)).fired).toBe(1);

    await twoNightOutage();
    const second = await runFreshnessCheck(env, NOW);
    expect(second.egressGated).toBe(1);
    expect(await openFreshness('meals.example')).toBe(1);
  });

  it('resolves a dark-hour flag on the next report like any other', async () => {
    await insertPulse('meals.example', '2026-07-02', at(80));
    await insertEgressCheck(at(60), false);
    await insertEgressCheck(at(50), false);
    await insertEgressCheck(at(49), true);
    await runFreshnessCheck(env, NOW);
    expect(await openFreshness('meals.example')).toBe(1);

    await writePulse(env, {
      asset: 'meals.example',
      generatedAt: new Date(NOW).toISOString(),
      capabilities: ['signups'],
      metrics: { signups: { last24h: 5, avg7d: 4.2, total: 100 } },
    });

    expect(await openFreshness('meals.example')).toBe(0);
  });
});
