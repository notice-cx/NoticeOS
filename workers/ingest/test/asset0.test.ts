import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAssetZeroPulse } from '../src/db.js';
import { readOsAssetId } from '../src/os-asset.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { asOwner, bookEntry, call, insertFlag, insertPulse as insertReport, pgCount, pgRows, reset } from './helpers.js';
import { addSites, changeSites, removeSites } from './sites';

beforeEach(reset);

async function insertPulse(asset: string, date: string): Promise<void> {
  const now = new Date().toISOString();
  await insertReport({ asset, date, generatedAt: now, receivedAt: now });
}

async function insertLedger(asset: string, family: string): Promise<void> {
  // Cents, and only cents: the store has no dollars column.
  await bookEntry({ kind: 'revenue', asset, period: '2026-06', family, amountMinor: 1000, bookingState: 'estimated' });
}

async function insertOpenFlag(asset: string, severity: string): Promise<void> {
  await insertFlag({ asset, firedAt: new Date().toISOString(), severity, kind: 'anomaly', ruleId: 'seed-test' });
}

/** One firing in the runner's record, as the store holds it. */
async function insertJobRun(
  job: string,
  outcome: 'ran' | 'skipped' | 'failed',
  startedAt: string,
): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.job_runs (workspace_id, job, started_at, finished_at, outcome, recorded_at)
       VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz, $4, $3::timestamptz)`,
      [tx.workspaceId, job, startedAt, outcome],
    ),
  );
}

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

interface OsMetric {
  last24h: number;
  avg7d: number;
  total: number;
}

interface OsEnvelope {
  asset: string;
  capabilities: string[];
  metrics: Record<string, OsMetric>;
}

/** The envelope the self-pulse just wrote. */
async function readEnvelope(): Promise<OsEnvelope> {
  const [row] = await pgRows<{ envelope: string }>(
    `SELECT envelope::text AS envelope FROM noticeos.current_pulses WHERE asset_id = 'root-os'
      ORDER BY pulse_date DESC LIMIT 1`,
  );
  expect(row).toBeDefined();
  return JSON.parse(row!.envelope) as OsEnvelope;
}

describe('nightly asset-#0 self-pulse', () => {
  it('reports pulses, ledger rows, and open flags in the standard envelope shape', async () => {
    await insertPulse('meals.example', '2026-07-05');
    await insertPulse('nosh.example', '2026-07-05');
    await insertLedger('meals.example', 'ads');
    await insertLedger('nosh.example', 'affiliate');
    await insertOpenFlag('meals.example', 'error');
    await insertOpenFlag('meals.example', 'warn');
    await insertOpenFlag('nosh.example', 'warn');

    await insertJobRun('backup', 'ran', minutesAgo(30));

    const result = await runAssetZeroPulse(env);
    expect(result?.date).toBe(new Date().toISOString().slice(0, 10));

    const envelope = await readEnvelope();
    expect(envelope.asset).toBe('root-os');
    expect(envelope.capabilities).toContain('cronRunSuccess');

    // two pre-existing pulses received in the last 24h
    expect(envelope.metrics.pulsesReceived?.last24h).toBe(2);
    // two ledger rows ingested in the last 24h
    expect(envelope.metrics.ledgerRows?.last24h).toBe(2);
    // open flags by severity (gauges: last24h == avg7d == total)
    expect(envelope.metrics.openFlagsError).toEqual({ last24h: 1, avg7d: 1, total: 1 });
    expect(envelope.metrics.openFlagsWarn).toEqual({ last24h: 2, avg7d: 2, total: 2 });
    expect(envelope.metrics.openFlagsInfo).toEqual({ last24h: 0, avg7d: 0, total: 0 });
    // Observed, not asserted: the lane that fired half an hour ago is why this
    // is a 1.
    expect(envelope.metrics.cronRunSuccess).toEqual({ last24h: 1, avg7d: 1, total: 1 });
  });

  describe('cronRunSuccess is derived from the job-run record', () => {
    it('says nothing at all when nothing has been recorded', async () => {
      // An empty record is not evidence of success, which is why the metric is
      // three-valued: reporting 1 here would be a constant rebuilt out of a
      // table, so the metric and its capability are omitted — `capabilities`
      // is what this asset can observe.
      await runAssetZeroPulse(env);
      const envelope = await readEnvelope();
      expect(envelope.capabilities).not.toContain('cronRunSuccess');
      expect(envelope.metrics.cronRunSuccess).toBeUndefined();
      // Everything else it CAN observe is still reported.
      expect(envelope.capabilities).toContain('pulsesReceived');
    });

    it('is 0 when a lane’s latest firing failed', async () => {
      await insertJobRun('beads-snapshot', 'ran', minutesAgo(1));
      await insertJobRun('backup', 'ran', minutesAgo(2 * 24 * 60));
      await insertJobRun('backup', 'failed', minutesAgo(24 * 60 - 60));

      await runAssetZeroPulse(env);
      const envelope = await readEnvelope();
      // One failed lane is enough, and the healthy minute-cadence lane beside it
      // does not average the failure away.
      expect(envelope.metrics.cronRunSuccess).toEqual({ last24h: 0, avg7d: 0, total: 0 });
    });

    it('counts a stood-down lane as a lane that ran, not one that failed', async () => {
      // `skipped` is a first-class outcome: a poller that stands down because the
      // ingest is restarting has not failed, and calling it a failure would make
      // every restart a cron incident.
      await insertJobRun('beads-snapshot', 'skipped', minutesAgo(3));
      await runAssetZeroPulse(env);
      expect((await readEnvelope()).metrics.cronRunSuccess).toEqual({
        last24h: 1,
        avg7d: 1,
        total: 1,
      });
    });

    it('is 0 when every lane went silent, however healthy the last firing was', async () => {
      // A dead runner stops writing, so the newest row stays healthy forever.
      // Without this rule the metric would freeze at 1 on stale evidence.
      await insertJobRun('beads-snapshot', 'ran', minutesAgo(26 * 60));
      await runAssetZeroPulse(env);
      expect((await readEnvelope()).metrics.cronRunSuccess).toEqual({
        last24h: 0,
        avg7d: 0,
        total: 0,
      });
    });
  });

  it('is held to its own contract: the self-pulse is stored as a real pulse row', async () => {
    await runAssetZeroPulse(env);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_pulses WHERE asset_id = 'root-os'`)).toBe(1);
  });
});

// The OS is whichever row the store marks `is_os = 1`. An installation that
// seeded its OS under another id must still get its self-report, and the
// runner must be able to ask which one it is.
describe('the OS asset is the store\'s is_os row, whatever it is called', () => {
  const RENAMED = 'home-os.example';

  /** Make RENAMED the OS for the body of `run`, then put the seed back. */
  async function asRenamedOs(run: () => Promise<void>): Promise<void> {
    const previous = await readOsAssetId(env);
    // In both stores: the OS is read from the site list on Postgres (src/os-asset.ts).
    await changeSites([previous!], { isOs: 0 });
    await addSites([{ id: RENAMED, domain: null, displayName: 'Home OS', status: 'live', senseOnly: 0, isOs: 1 }]);
    try {
      await run();
    } finally {
      // Its report and alerts go first, as the owner: they belong to the site.
      await asOwner(
        [
          `DELETE FROM noticeos.flag_evidence e USING noticeos.flags f
            WHERE e.workspace_id = f.workspace_id AND e.flag_id = f.flag_id AND f.asset_id = '${RENAMED}';`,
          `DELETE FROM noticeos.flags WHERE asset_id = '${RENAMED}';`,
          `DELETE FROM noticeos.pulses WHERE asset_id = '${RENAMED}';`,
        ].join('\n'),
      );
      await removeSites([RENAMED]);
      await changeSites([previous!], { isOs: 1 });
    }
  }

  it('files the nightly self-report against a renamed OS asset', async () => {
    await asRenamedOs(async () => {
      const result = await runAssetZeroPulse(env);
      expect(result).not.toBeNull();
      const [row] = await pgRows<{ asset: string; envelope: string }>(
        `SELECT asset_id AS asset, envelope::text AS envelope FROM noticeos.pulses ORDER BY pulse_id DESC LIMIT 1`,
      );
      expect(row?.asset).toBe(RENAMED);
      expect((JSON.parse(row!.envelope) as OsEnvelope).asset).toBe(RENAMED);
    });
  });

  it('answers the runner with the renamed id, operator-authed', async () => {
    await asRenamedOs(async () => {
      const denied = await call(new Request('https://ingest.local/api/os-asset'));
      expect(denied.status).toBe(401);
      const res = await call(
        new Request('https://ingest.local/api/os-asset', {
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ asset: RENAMED });
    });
  });

  it('writes no self-report, and names no OS, when no row is the OS', async () => {
    const previous = await readOsAssetId(env);
    await changeSites([previous!], { isOs: 0 });
    try {
      expect(await runAssetZeroPulse(env)).toBeNull();
      expect(await pgCount(`SELECT count(*) AS n FROM noticeos.pulses`)).toBe(0);
      const res = await call(
        new Request('https://ingest.local/api/os-asset', {
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        }),
      );
      expect(await res.json()).toEqual({ asset: null });
    } finally {
      await changeSites([previous!], { isOs: 1 });
    }
  });
});
