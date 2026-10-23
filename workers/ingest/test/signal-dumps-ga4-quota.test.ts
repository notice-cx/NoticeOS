import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgCount, pgFirst, pgRows, reset } from './helpers.js';
import {
  NOW,
  GOOGLE_PROPERTIES,
  providerDumpFetch,
} from './signal-dumps-fixture';

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
  describe('GA4 quota accounting', () => {
    /** The archived envelope for one GA4 family. */
    async function archivedGa4(report = 'pages-screens'): Promise<Record<string, unknown>> {
      const manifest = await pgFirst<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'ga4' AND report = $1 AND object_key IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`, [report]);
      const object = await env.RAW_SIGNALS.get(manifest!.objectKey);
      const text = await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text();
      return JSON.parse(text) as Record<string, unknown>;
    }

    async function quotaFlag(): Promise<{ message: string; ruleInputs: string } | null> {
      const [row] = await pgRows<{ message: string; ruleInputs: string }>(
        `SELECT message, rule_inputs::text AS "ruleInputs" FROM noticeos.current_flags
          WHERE rule_id = 'ga4-quota-pressure' AND resolved_at IS NULL
          ORDER BY fired_at, flag_number LIMIT 1`,
      );
      return row ?? null;
    }

    it('asks the Data API what every archive request costs', async () => {
      const { fetchImpl, calls } = providerDumpFetch({
        ga4Quota: { consumed: 500, remaining: 199_500 },
      });
      await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1 });

      const ga4Calls = calls.filter((call) => call.url.includes('analyticsdata.googleapis.com'));
      expect(ga4Calls.length).toBeGreaterThan(0);
      for (const call of ga4Calls) expect(call.body?.returnPropertyQuota).toBe(true);
    });

    it('archives the quota beside the pages and never inside the content hash', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });

      const archived = await archivedGa4();
      expect(archived.providerQuota).toMatchObject({
        tokensPerDay: { consumed: 500, remaining: 199_500 },
      });
      // The quota is lifted OUT of the response bytes: leaving it there would
      // put a number that moves on every call into the archived page.
      const pages = archived.pages as { response: Record<string, unknown> }[];
      expect(pages[0]?.response.propertyQuota).toBeUndefined();
      expect(pages[0]?.response.rowCount).toBe(1);

      // Same data, different spend: still `unchanged`, so the dedup that keeps
      // this lane's R2 footprint honest survives asking for quota at all.
      const objectsAfterFirst = (await env.RAW_SIGNALS.list()).objects.length;
      const second = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 9_000, remaining: 191_000 } })
          .fetchImpl,
        revisionDays: 1,
      });
      expect(second.succeeded).toBe(0);
      expect(second.unchanged).toBeGreaterThan(0);
      expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(objectsAfterFirst);
    });

    it('says nothing while the budget is comfortable', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });
      expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE rule_id = 'ga4-quota-pressure'`)).toBe(0);
    });

    it('raises ONE flag per property while the budget is thin, however many families spend it', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        // Ten thousand tokens remain; consumed is only this request's cost.
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 10, remaining: 10_000 } })
          .fetchImpl,
        revisionDays: 1,
      });

      // Nine GA4 families spend from one property's budget; one budget is one
      // problem. The budget is per property, so the flag is too.
      const flagged = await pgRows<{ asset: string }>(
        `SELECT asset_id AS asset FROM noticeos.current_flags WHERE rule_id = 'ga4-quota-pressure' ORDER BY asset_id COLLATE "C"`,
      );
      expect(flagged.map((row) => row.asset)).toEqual([...GOOGLE_PROPERTIES]);
      const flag = await quotaFlag();
      // Headroom is an absolute count; request cost is not daily usage.
      expect(flag!.message).toBe('GA4 daily quota low: 10000 tokens remaining for 123456');
      const inputs = JSON.parse(flag!.ruleInputs) as Record<string, unknown>;
      expect(inputs).toMatchObject({
        lane: 'signal-dumps',
        pool: 'core',
        tokensPerDay: { consumed: 10, remaining: 10_000 },
      });
      expect(inputs.observations).toBeGreaterThan(1); // refreshed, not re-fired
      expect(
        (inputs.pressured as { bucket: string; threshold: number }[])[0],
      ).toMatchObject({ bucket: 'tokensPerDay', threshold: 40_000, remaining: 10_000 });
    });

    it('retracts the flag once the buckets refill, but never on silence', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 10, remaining: 10_000 } })
          .fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).not.toBeNull();

      // A provider that reported no quota at all is not evidence of recovery.
      await runSignalDumps(env, {
        nowMs: NOW + 86_400_000,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).not.toBeNull();

      await runSignalDumps(env, {
        nowMs: NOW + 2 * 86_400_000,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).toBeNull();
    });
  });
});
