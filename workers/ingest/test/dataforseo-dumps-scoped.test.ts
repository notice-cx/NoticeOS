import { env } from 'cloudflare:test';
import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PANEL_REPORT,
  DATAFORSEO_PERIODIC_REPORTS,
  MAX_REPORT_COST_USD as REPORT_RESERVE_USD,
  dataForSeoReportsFor,
} from '@noticeos/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATAFORSEO_REPORTS, dataForSeoFamiliesFor, runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { ARCHIVE_RUNS, pgAll, pgCount, pgFirst, reset } from './helpers.js';
import { changeSites } from './sites';
import {
  NOW,
  PANEL_ASSETS,
  panelEntries,
  panelCallCount,
  SERP_PATH,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

/** A scope is not a second collector: it narrows the sweep plan and nothing
 * else, so what lands is what the Monday lane would have landed for that
 * property. */
describe('a scoped run — the same run, narrowed', () => {
  const NOM_QUERIES = panelEntries('northwind.example');

  /** Every column a downstream reader joins, filters or renders on. `id` is a
   * UUID and `finished_at` is the wall clock at write; everything else must be
   * identical between the two doors. */
  async function manifestRow(
    asset: string,
    report: string,
  ): Promise<Record<string, unknown> | null> {
    return pgFirst(`SELECT asset, integration, report, credential_ref, property_ref, report_date,
              requested_at, status, data_state, schema_version, provider_rows,
              request_count, provider_truncated, object_key, content_sha256,
              object_bytes, error_code, error_message, provider_cost_usd
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND asset = $1 AND report = $2`, [asset, report]);
  }

  async function archivedText(objectKey: string): Promise<string> {
    const object = await env.RAW_SIGNALS.get(objectKey);
    return new Response(
      object!.body.pipeThrough(new DecompressionStream('gzip')),
    ).text();
  }

  /** The panel-review filer, the daily refresh and the lane evidence read these
   * rows, and none may need to know which door a run came through. */
  it('lands a row indistinguishable from the Monday one', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    const weekly = await manifestRow('northwind.example', 'serp-panel');
    const weeklyArchive = await archivedText(weekly!.object_key as string);

    await reset();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'northwind.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await manifestRow('northwind.example', 'serp-panel')).toEqual(weekly);
    // Down to the archived bytes: same object key, same content hash, same body.
    expect(await archivedText(weekly!.object_key as string)).toBe(weeklyArchive);
  });

  it('bills one property and never touches another', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'northwind.example' },
    });

    // Everything northwind.example is due, and nothing else at all.
    expect(result.outcomes.map((outcome) => outcome.report)).toEqual(
      dataForSeoFamiliesFor('northwind.example'),
    );
    expect(calls.every((call) => String(call.task.tag ?? '').startsWith('northwind.example:'))).toBe(
      true,
    );
    expect(
      (
        await pgAll<{ asset: string }>(`SELECT DISTINCT asset FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`)
      ).results,
    ).toEqual([{ asset: 'northwind.example' }]);
    // Every single-call family this property is due, at the stub's $0.011,
    // plus the panel's per-call price. Derived, so a family added to the
    // registry shows up here as spend rather than as a red test.
    const singleCall = dataForSeoFamiliesFor('northwind.example').filter(
      (family) => family !== 'serp-panel',
    ).length;
    expect(result.costUsd).toBeCloseTo(
      singleCall * 0.011 + panelCallCount(NOM_QUERIES) * 0.004,
    );
  });

  it('keeps the cheap families ahead of the long one inside a single property', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'northwind.example' },
    });

    // Breadth-first survives the narrowing: an interruption during the panel
    // cannot take the cheap families with it.
    const firstPanelCall = calls.findIndex((call) => call.url.endsWith(SERP_PATH));
    expect(firstPanelCall).toBe(
      dataForSeoFamiliesFor('northwind.example').filter((f) => f !== 'serp-panel').length,
    );
    expect(calls.slice(firstPanelCall).every((call) => call.url.endsWith(SERP_PATH))).toBe(
      true,
    );
  });

  it('asks for SERP competitors without the property itself among them', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['serp-competitors'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    const asked = calls.filter((call) => call.url.endsWith('/competitors_domain/live'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.task).toMatchObject({
      target: 'meadow.example',
      filters: [['intersections', '>', 0], 'and', ['domain', '<>', 'meadow.example']],
    });
  });

  /**
   * Defense in depth. `POST /api/signal-collect` turns this into a 422 before
   * anything runs, but the runner must not bill a family a property does not own
   * even if something later calls it directly: `families` can only ever REMOVE
   * from the set `appliesTo` allows.
   */
  it('cannot be talked into a family the property does not own', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'pebble.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0, costUsd: 0 });
    expect(calls).toHaveLength(0);
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`),
    ).toBe(0);
  });

  it('cannot reach a property the weekly lane would not collect', async () => {
    const { fetchImpl, calls } = providerFetch();
    // Lifecycle is a mutable store fact; put ferns.example back before launch to
    // prove the gate still excludes it.
    await changeSites(['ferns.example'], { status: 'pre-launch' });
    for (const asset of ['ferns.example', 'root-os', 'not-a-property']) {
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        scope: { asset },
      });
      expect(result.attempted).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  /** `backlinks-summary` returns a referring-domain count and
   * `backlinks-new-lost` its weekly delta; neither names a domain. Both
   * orderings are asserted because a 100-row cap filled by whichever scraper
   * farm links most would answer a different question. */
  it('asks for referring domains by rank and anchors by reach', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: {
        asset: 'northwind.example',
        families: ['backlinks-referring-domains', 'backlinks-anchors'],
      },
    });

    const domains = calls.find((call) =>
      call.url.endsWith('/backlinks/referring_domains/live'),
    );
    expect(domains?.task).toMatchObject({
      target: 'northwind.example',
      include_subdomains: true,
      backlinks_status_type: 'live',
      limit: 100,
      order_by: ['rank,desc'],
      tag: 'northwind.example:backlinks-referring-domains',
    });

    const anchors = calls.find((call) =>
      call.url.endsWith('/backlinks/anchors/live'),
    );
    expect(anchors?.task).toMatchObject({
      target: 'northwind.example',
      include_subdomains: true,
      backlinks_status_type: 'live',
      limit: 100,
      order_by: ['referring_domains,desc'],
      tag: 'northwind.example:backlinks-anchors',
    });

    // One call each, and nothing else bought on the way past.
    expect(calls).toHaveLength(2);
  });

  /** The row cap is a cost decision, so it is pinned against the reserve:
   * backlinks bills per request plus per row, and a family that could outspend
   * the reserve its own gate takes is how a cap gets crossed. */
  it('keeps a full-limit backlinks call inside the per-family reserve', () => {
    const worstCaseUsd = 0.024 + 100 * 0.000036;
    expect(worstCaseUsd).toBeLessThan(REPORT_RESERVE_USD);
  });

  /** The route validates `families` against this exported list, so the two can
   * never name different families. */
  it('publishes the family names the route validates against', () => {
    expect([...DATAFORSEO_REPORTS].sort()).toEqual(
      [
        ...DATAFORSEO_BASE_REPORTS,
        ...DATAFORSEO_PERIODIC_REPORTS,
        DATAFORSEO_PANEL_REPORT,
      ].sort(),
    );
    // What a week owes and what may be requested are different questions: the
    // requestable set is a superset by exactly the periodic families this
    // property is due.
    const weekly = dataForSeoReportsFor('northwind.example', new Set(PANEL_ASSETS));
    const requestable = dataForSeoFamiliesFor('northwind.example');
    expect(weekly.every((family) => requestable.includes(family))).toBe(true);
    expect(
      requestable
        .filter((family) => !(weekly as string[]).includes(family))
        .sort(),
    ).toEqual([...DATAFORSEO_PERIODIC_REPORTS].sort());
    expect(dataForSeoFamiliesFor('pebble.example')).not.toContain('serp-panel');
    expect(dataForSeoFamiliesFor('acorn.example')).toContain('serp-panel');
    expect(dataForSeoFamiliesFor('northwind.example')).toContain('serp-panel');
  });
});
