import { env } from 'cloudflare:test';
import {
  MAX_REPORT_COST_USD as REPORT_RESERVE_USD,
  SERP_PANEL_CALL_USD as CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT as PANEL_CEILING,
} from '@noticeos/contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATAFORSEO_CHECKPOINT_PREFIX,
  dataForSeoFamiliesFor,
  runDataForSeoDumps,
  trackedQueries,
  type SerpPanelQuery,
} from '../src/dataforseo-dumps.js';
import { SignalError } from '../src/signal-store.js';
import { putCredential } from '../src/credentials.js';
import serpPanelConfig from './fixture-config/serp-panel.json';
import { ARCHIVE_RUNS, pgAll, pgFirst, reset, storedHealthStates } from './helpers.js';
import { inSiteOrder } from './sites';
import {
  NOW,
  PANEL_ASSETS,
  panelEntries,
  panelKeyword,
  panelLabel,
  PANEL_QUERIES,
  panelCallCount,
  PANEL_CALLS,
  panelKeywordOrder,
  LAUNCHED,
  SERP_PATH,
  FAST_RETRY,
  providerFetch,
  ACCOUNT_PATH,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('tracked-query SERP panel', () => {
  /** The panel's newest recorded collection outcome for meadow.example, after
   * a sweep run off the stored credential (the path that records health). */
  async function panelOutcome() {
    const family = JSON.stringify(['serp-panel', '2026-07-27', '', '']);
    const state = (await storedHealthStates()).find((row) => row.asset === 'meadow.example' && row.family === family);
    return state && { outcome: state.outcome, failure: state.failure_kind };
  }

  async function storeCredential(): Promise<void> {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: 'fixture-password' },
    });
  }

  it('records a panel that stopped at its own depth as collected, and keeps the truncation on its run', async () => {
    await storeCredential();
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: { asset: 'meadow.example', families: ['serp-panel'] } });

    expect(await panelOutcome()).toEqual({ outcome: 'success', failure: null });
    const run = await pgFirst<{ providerTruncated: number }>(`SELECT provider_truncated AS "providerTruncated" FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example' AND report = 'serp-panel'`);
    expect(run?.providerTruncated).toBe(1);
  });

  it('still records a panel with unanswered calls as an incomplete report', async () => {
    await storeCredential();
    const { fetchImpl } = providerFetch({ failSerpKeyword: PANEL_QUERIES[0] });
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: { asset: 'meadow.example', families: ['serp-panel'] } });

    expect(await panelOutcome()).toEqual({ outcome: 'failure', failure: 'incomplete-report' });
  });

  it('a second firing the same day buys only the panels a failed sweep left missing', async () => {
    const failed = providerFetch({ failPath: SERP_PATH });
    await runDataForSeoDumps(env, {
      nowMs: NOW, fetchImpl: failed.fetchImpl, login: 'operator-login', password: 'operator-password', retryBackoffMs: FAST_RETRY,
    });
    const { fetchImpl, calls } = providerFetch();
    const retry = await runDataForSeoDumps(env, {
      nowMs: NOW + 10 * 60_000, fetchImpl, login: 'operator-login', password: 'operator-password',
    });

    expect(retry).toMatchObject({ attempted: PANEL_ASSETS.length, succeeded: PANEL_ASSETS.length, failed: 0 });
    expect(calls.filter((call) => !call.url.endsWith(SERP_PATH) && !call.url.endsWith(ACCOUNT_PATH))).toEqual([]);
    expect(calls.filter((call) => call.url.endsWith(SERP_PATH))).toHaveLength(PANEL_CALLS);
  });

  /** The archived page envelope: what the collector stored about one provider
   * call. `body` is the only part that was transmitted. */
  interface ArchivedPage {
    request: {
      path: string;
      body: Record<string, unknown>;
      attempts: number;
      label?: string;
    };
    response: unknown;
  }

  async function archivedPanelPages(asset: string): Promise<ArchivedPage[]> {
    const row = await pgFirst<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel' AND asset = $1
          AND object_key IS NOT NULL
        ORDER BY run_seq DESC LIMIT 1`, [asset]);
    const object = await env.RAW_SIGNALS.get(row!.objectKey);
    return (
      JSON.parse(
        await new Response(
          object!.body.pipeThrough(new DecompressionStream('gzip')),
        ).text(),
      ) as { pages: ArchivedPage[] }
    ).pages;
  }

  it.each(['current', 'legacy', 'invalid', 'failed-read'] as const)(
    'resumes paid pages after interruption with %s checkpoints', async (mode) => {
    const panel = {
      assets: { 'meadow.example': { queries: ['my plume', 'meadow meal plan'] } },
    };
    const firstProvider = providerFetch();
    let attempted = 0;
    const interruptedFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attempted += 1;
      if (attempted === 3) throw new Error('socket closed mid-panel');
      return firstProvider.fetchImpl(input, init);
    }) as typeof fetch;

    const interrupted = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: interruptedFetch,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [],
      serpPanelConfig: panel,
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });
    expect(interrupted).toMatchObject({ attempted: 1, failed: 1, costUsd: 0.008 });
    const workspacePrefix = `workspaces/${await env.STORE.workspaceId()}/`;
    const saved = (await env.RAW_SIGNALS.list({
      prefix: `${workspacePrefix}${DATAFORSEO_CHECKPOINT_PREFIX}/meadow.example/2026-07-27/serp-panel/`,
    })).objects;
    expect(saved).toHaveLength(2);
    // A pre-upgrade paid page has the same request identity but no namespace.
    // Populate both paths for preference/failure controls, not a second provider.
    for (const { key } of saved) {
      const checkpoint = await env.RAW_SIGNALS.get(key);
      await env.RAW_SIGNALS.put(key.slice(workspacePrefix.length), await checkpoint!.text());
      if (mode === 'legacy') await env.RAW_SIGNALS.delete(key);
      if (mode === 'invalid') await env.RAW_SIGNALS.put(key, '{}');
    }
    const get = vi.spyOn(env.RAW_SIGNALS, 'get');
    if (mode === 'failed-read') get.mockRejectedValue(new Error('fixture object read failed'));

    const secondProvider = providerFetch();
    let resumed: Awaited<ReturnType<typeof runDataForSeoDumps>>;
    let readKeys: string[];
    try { resumed = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: secondProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [],
      serpPanelConfig: panel,
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });
      readKeys = get.mock.calls.map(([key]) => key as string);
    } finally { get.mockRestore(); }
    if (mode !== 'legacy') {
      // Missing pages may probe a proven legacy path too. The current/invalid
      // pages already present must never consult their older counterparts.
      const olderKeys = saved.map(({ key }) => key.slice(workspacePrefix.length));
      expect(readKeys!.filter((key) => olderKeys.includes(key))).toEqual([]);
    }
    if (mode === 'failed-read') {
      expect(secondProvider.calls).toHaveLength(0);
      expect(resumed!).toMatchObject({ attempted: 1, failed: 1, costUsd: 0 });
      return;
    }
    // Valid current/legacy pages are not re-bought. Invalid current bytes never
    // silently borrow the older object: all four requests must be observed anew.
    const newCalls = mode === 'invalid' ? 4 : 2;
    expect(secondProvider.calls).toHaveLength(newCalls);
    expect(resumed!).toMatchObject({ attempted: 1, succeeded: 1, costUsd: newCalls * 0.004 });
    expect(await archivedPanelPages('meadow.example')).toHaveLength(4);
    const spend = await pgFirst<{ costUsd: number }>(`SELECT SUM(provider_cost_usd) AS "costUsd"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'`);
    expect(spend?.costUsd).toBeCloseTo(0.008 + newCalls * 0.004);
  });

  /** The refusal code one panel earns from the collector's own validation, or
   * null when the panel is fine. Checked directly because a sweep per case is
   * slow; `panelError` below proves a refusal reaches the sweep's outcome. */
  function panelRefusal(queries: SerpPanelQuery[]): string | null {
    try {
      trackedQueries({ assets: { 'meadow.example': { queries } } }, 'meadow.example');
      return null;
    } catch (error) {
      if (error instanceof SignalError) return error.code;
      throw error;
    }
  }

  /** The `config_invalid` code one panel earns from a whole sweep, or null when
   * the config is fine. */
  async function panelError(
    queries: SerpPanelQuery[],
    fetchImpl: typeof fetch,
  ): Promise<string | null | undefined> {
    await reset();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: { assets: { 'meadow.example': { queries } } },
    });
    return result.outcomes.find((outcome) => outcome.report === 'serp-panel')
      ?.errorCode;
  }

  it('collects the configured panel as one archive of per-query result pages', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const panelCalls = calls.filter((call) => call.url.endsWith(SERP_PATH));
    // Every seeded panel's terms, verbatim and in file order, each asked once
    // per device, site by site in the order the site list gives them.
    expect(panelCalls.map((call) => call.task.keyword)).toEqual(
      (await inSiteOrder(PANEL_ASSETS)).flatMap((asset) =>
        panelKeywordOrder(panelEntries(asset).map(panelKeyword)),
      ),
    );
    expect(panelCalls[0]?.task).toMatchObject({
      location_code: 2840,
      language_code: 'en',
      device: 'mobile',
      depth: 20,
      load_async_ai_overview: true,
    });
    // The device rides in the request body, which is archived verbatim: that is
    // how an observation records its device with no manifest column. Devices are
    // asked in a fixed order, desktop last, so a query's two pages are adjacent;
    // which device a one-row-per-query reader reports is named in that reader.
    expect(
      panelCalls.slice(0, SERP_PANEL_DEVICES.length).map((call) => call.task.device),
    ).toEqual([...SERP_PANEL_DEVICES]);
    expect(SERP_PANEL_DEVICES.at(-1)).toBe('desktop');
    expect(panelCalls.at(-1)?.task.device).toBe('desktop');

    const manifest = await pgAll<{
      asset: string;
      reportDate: string;
      status: string;
      requestCount: number;
      providerTruncated: number;
      costUsd: number;
      objectKey: string;
    }>(`SELECT asset, report_date AS "reportDate", status, request_count AS "requestCount",
              provider_truncated AS "providerTruncated", provider_cost_usd AS "costUsd",
              object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'
        ORDER BY asset`);
    // One manifest row per property per run, not one per query.
    expect(manifest.results).toHaveLength(PANEL_ASSETS.length);
    const meadow = manifest.results.find(
      (row) => row.asset === 'meadow.example',
    );
    expect(meadow).toMatchObject({
      reportDate: '2026-07-27',
      status: 'success',
      requestCount: panelCallCount(PANEL_QUERIES),
      // The panel reads two pages of a result set that continues past them.
      providerTruncated: 1,
    });
    // Both devices are billed and both land on the one manifest row, so the
    // Tower's month-to-date spend meter reads the real weekly bill without
    // knowing the panel gained a dimension.
    expect(meadow!.costUsd).toBeCloseTo(panelCallCount(PANEL_QUERIES) * 0.004);
    // Each property is billed for its own terms, never the portfolio's.
    expect(
      manifest.results.reduce((sum, row) => sum + row.requestCount, 0),
    ).toBe(PANEL_CALLS);

    const object = await env.RAW_SIGNALS.get(meadow!.objectKey);
    const archived = JSON.parse(
      await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text(),
    ) as { report: string; pages: { response: unknown }[] };
    expect(archived.report).toBe('serp-panel');
    expect(archived.pages).toHaveLength(panelCallCount(PANEL_QUERIES));
    expect(JSON.stringify(archived.pages[0])).toContain('ai_overview');
  });

  /** A phone reading and a desktop reading of the same term are two
   * observations. Both are pages of one archive, so the content hash compares
   * whole archives; this proves a provider answering both devices identically
   * still stores two distinguishable pages, because the archived request body
   * carries the device. */
  it('never lets one device\'s result page stand in for the other\'s', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: { assets: { 'meadow.example': { queries: ['my plume'] } } },
    });

    const row = await pgFirst<{ objectKey: string; requestCount: number }>(`SELECT object_key AS "objectKey", request_count AS "requestCount"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'
          AND asset = 'meadow.example'`);
    expect(row?.requestCount).toBe(SERP_PANEL_DEVICES.length);

    const object = await env.RAW_SIGNALS.get(row!.objectKey);
    const archived = JSON.parse(
      await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text(),
    ) as { pages: { request: { body: { keyword: string; device: string } } }[] };
    expect(
      archived.pages.map((page) => [page.request.body.keyword, page.request.body.device]),
    ).toEqual(SERP_PANEL_DEVICES.map((device) => ['my plume', device]));
  });

  /** The label is stored with the observation and nowhere else: the flattened
   * CSV derives only from the immutable archive, so a label looked up in
   * today's config would relabel already-collected rows when a cluster is
   * renamed. `device` is a provider field and is posted; the label is our
   * taxonomy and is not. */
  it('archives each query beside the cluster it measures, and tells the provider nothing new', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    // Nothing about the label is transmitted. The POSTed body carries the same
    // provider-documented fields it always did, and `tag` — the provider's own
    // free-text slot, which the label was NOT folded into — still holds exactly
    // the join key an archive reader matches on.
    for (const call of calls.filter((one) => one.url.endsWith(SERP_PATH))) {
      expect(call.task).not.toHaveProperty('label');
      expect(call.task.tag).toMatch(/^[a-z0-9.]+:serp-panel$/);
    }

    // Every page says which bet it was, one page per device, both carrying the
    // same label: a cluster is a property of the term, not of the surface.
    const nom = await archivedPanelPages('northwind.example');
    expect(
      nom.map((page) => [page.request.body.keyword, page.request.label]),
    ).toEqual(
      panelEntries('northwind.example').flatMap((entry) =>
        SERP_PANEL_DEVICES.map(() => [panelKeyword(entry), panelLabel(entry)]),
      ),
    );
    expect(new Set(nom.map((page) => page.request.label))).toEqual(
      new Set([
        'Calculator seam',
        'Item head',
        'Guide anomaly',
        'Category head',
        'Fuel grades',
        'Stats hub',
        'Product hubs',
      ]),
    );

    // An unlabelled panel archives the envelope it always archived — no `label`
    // key at all, rather than one holding an empty string. That is what lets an
    // older archive flatten to exactly the columns it had before labels existed.
    for (const page of await archivedPanelPages('meadow.example')) {
      expect(Object.keys(page.request)).toEqual(['path', 'body', 'attempts']);
    }
  });

  it('rejects a mis-spelled cluster rather than quietly grouping by it', () => {
    // Labelling is optional per QUERY as well as per property: a panel may mix
    // the two shapes, and that must stay valid.
    expect(panelRefusal([{ query: 'my plume', label: 'Brand' }, 'meadow calculator'])).toBeNull();
    // An entry that is neither shape names the file rather than collecting a
    // panel that means something else.
    expect(panelRefusal([42 as unknown as SerpPanelQuery])).toBe('config_invalid');
    // A blank label is not "no label" — omitting the field is.
    expect(panelRefusal([{ query: 'my plume', label: '  ' }])).toBe('config_invalid');
    expect(panelRefusal([{ query: 'my plume', label: 'x'.repeat(61) }])).toBe('config_invalid');
    // Grouping is an exact-string match on the archived label, so one cluster
    // spelled two ways is two bets in the readout and one in the operator's
    // head — the duplicate-query rule, applied to the group name.
    expect(
      panelRefusal([
        { query: 'my plume', label: 'Item head' },
        { query: 'anvil specs', label: 'item head' },
      ]),
    ).toBe('config_invalid');
  });

  it('skips a property with no panel configured without an attempt row', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const assets = await pgAll<{ asset: string }>(`SELECT DISTINCT asset FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'`);
    // Absence of config is not a failed collection: no success row, and no
    // error row either.
    expect(assets.results.map((row) => row.asset).sort()).toEqual(
      [...PANEL_ASSETS].sort(),
    );
  });

  it('publishes answered-query evidence as degraded and repairs only the failed query', async () => {
    const firstProvider = providerFetch({
      failSerpKeyword: PANEL_QUERIES[0],
    });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: firstProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });

    const panel = result.outcomes.find(
      (outcome) =>
        outcome.report === 'serp-panel' && outcome.asset === 'meadow.example',
    );
    expect(panel?.status).toBe('success');
    const attempts = await pgAll<{
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
      costUsd: number;
      costState: string;
    }>(`SELECT status, error_code AS "errorCode", error_message AS "errorMessage",
              provider_cost_usd AS "costUsd", cost_state AS "costState"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'
        ORDER BY run_seq`);
    expect(attempts.results).toHaveLength(2);
    expect(attempts.results[0]).toMatchObject({ status: 'success' });
    expect(attempts.results[1]).toMatchObject({
      status: 'error',
      errorCode: 'dataforseo_partial_40501',
      costUsd: 0,
      costState: 'reported',
    });
    // Counted values, then DataForSEO's own words.
    expect(attempts.results[1]!.errorMessage).toBe(
      '2 of 60 calls unanswered · 58 answered · DataForSEO: Invalid Field: keyword.',
    );
    expect(
      (
        await env.RAW_SIGNALS.list({
          prefix: `workspaces/${await env.STORE.workspaceId()}/${DATAFORSEO_CHECKPOINT_PREFIX}/meadow.example/2026-07-27/serp-panel/`,
        })
      ).objects,
    ).toHaveLength(panelCallCount(PANEL_QUERIES));

    const repairProvider = providerFetch();
    const repair = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: repairProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });
    // The two devices for the failed query are the only calls bought again.
    expect(repairProvider.calls).toHaveLength(SERP_PANEL_DEVICES.length);
    expect(repair).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await archivedPanelPages('meadow.example')).toHaveLength(
      panelCallCount(PANEL_QUERIES),
    );
    const latest = await pgFirst<{ status: string }>(`SELECT status FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'
        ORDER BY finished_at DESC, id DESC LIMIT 1`);
    expect(latest?.status).toBe('success');
  });

  it('spends the bounded family retry budget on an internal search-engine task error', async () => {
    let attempts = 0;
    const provider = providerFetch();
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(SERP_PATH) && attempts < 2) {
        attempts += 1;
        return Response.json({
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          tasks: [
            {
              status_code: 40101,
              status_message: 'Internal SE Server Error.',
              cost: 0,
              result: null,
            },
          ],
        });
      }
      return provider.fetchImpl(input, init);
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [0, 0],
      serpPanelConfig: {
        assets: { 'meadow.example': { queries: ['my plume'] } },
      },
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ retries: 2 });
    expect(provider.calls).toHaveLength(SERP_PANEL_DEVICES.length);
  });

  it('settles a reviewable partial panel after three failed attempts shared across calls', async () => {
    const provider = providerFetch();
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Array<{ keyword?: string }>;
      if (path.endsWith(SERP_PATH) && body[0]?.keyword === 'broken query') {
        return Response.json({
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          tasks: [
            {
              status_code: 40101,
              status_message: 'Internal SE Server Error.',
              cost: 0,
              result: null,
            },
          ],
        });
      }
      return provider.fetchImpl(input, init);
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [0, 0],
      serpPanelConfig: {
        assets: {
          'meadow.example': { queries: ['broken query', 'observed query'] },
        },
      },
      scope: { asset: 'meadow.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ retries: 2 });
    const marker = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND status = 'error'
        ORDER BY run_seq DESC LIMIT 1`);
    expect(marker?.errorMessage).toBe(
      '2 of 4 calls unanswered after 3 attempts · 2 answered · DataForSEO: Internal SE Server Error.',
    );
  });

  it('fails the panel when the provider answered none of its queries', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push(url);
      if (!url.endsWith(SERP_PATH)) {
        return Response.json({
          status_code: 20000,
          cost: 0.011,
          tasks: [{ status_code: 20000, cost: 0.011, result: [{ items_count: 0 }] }],
        });
      }
      void init;
      return Response.json({
        status_code: 20000,
        cost: 0.004,
        tasks: [
          {
            status_code: 40501,
            status_message: 'Invalid Field: keyword.',
            cost: 0.004,
            result: null,
          },
        ],
      });
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const panels = result.outcomes.filter(
      (outcome) => outcome.report === 'serp-panel',
    );
    expect(panels).toHaveLength(PANEL_ASSETS.length);
    for (const panel of panels) {
      expect(panel).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_task_40501',
      });
    }
    // Every request was still billed and still counts against the cap.
    const spend = await pgFirst<{ costUsd: number }>(`SELECT SUM(provider_cost_usd) AS "costUsd" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'`);
    expect(spend?.costUsd).toBeCloseTo(PANEL_CALLS * 0.004);
  });

  it('fails one property\'s panel for an over-cap config without touching the others', async () => {
    const { fetchImpl } = providerFetch();
    // One term past the enforced ceiling, which is what the $0.25 per-report
    // reserve buys at two devices and $0.004 a call.
    const overCapPanel = {
      assets: {
        'meadow.example': {
          queries: Array.from(
            { length: PANEL_CEILING + 1 },
            (_, index) => `query ${index}`,
          ),
        },
      },
    };
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: overCapPanel,
    });

    expect(
      result.outcomes.find((outcome) => outcome.report === 'serp-panel'),
    ).toMatchObject({
      asset: 'meadow.example',
      status: 'error',
      errorCode: 'config_invalid',
    });
    // The over-cap panel is the only casualty — not `keyword-ideas`, which reads
    // the same config to seed one call and has no stake in a per-(query, device)
    // cost ceiling. Counted against the injected panel, since that decides which
    // properties are due panel-seeded families at all.
    expect(result.failed).toBe(1);
    expect(
      result.outcomes.filter((outcome) => outcome.status === 'error'),
    ).toHaveLength(1);
    expect(result.succeeded).toBe(
      LAUNCHED.reduce(
        (total, asset) =>
          total +
          dataForSeoFamiliesFor(asset, overCapPanel).filter(
            (family) => family !== 'serp-panel',
          ).length,
        0,
      ),
    );
    expect(
      result.outcomes.some((outcome) => outcome.report === 'keyword-ideas'),
    ).toBe(true);
  });

  /** The gate reserves $0.25 for a family before it calls, and the panel is the
   * only family whose cost is a function of config, so the ceiling must be
   * whatever that reserve buys. The invariant is asserted, not the number. */
  it('keeps the biggest legal panel inside the reserve its gate takes', async () => {
    expect(PANEL_CEILING * SERP_PANEL_DEVICES.length * CALL_USD).toBeLessThanOrEqual(
      REPORT_RESERVE_USD,
    );
    expect(
      (PANEL_CEILING + 1) * SERP_PANEL_DEVICES.length * CALL_USD,
    ).toBeGreaterThan(REPORT_RESERVE_USD);
    // That every shipped panel still fits under it is a check of the committed
    // file, in config-seeds.test.ts.
  });

  it('rejects an empty or duplicated panel rather than quietly repairing it', async () => {
    expect(panelRefusal([])).toBe('config_invalid');
    expect(panelRefusal(['my plume', 'My Plume'])).toBe('config_invalid');
    expect(panelRefusal(['my plume', '  '])).toBe('config_invalid');
    // The object form is held to the same two rules as the shorthand.
    expect(panelRefusal([{ query: 'my plume' }, { query: 'My Plume', label: 'Brand' }])).toBe('config_invalid');
    expect(panelRefusal([{ query: '  ' }])).toBe('config_invalid');
    // And a refused panel is the sweep's own outcome for that property, not a
    // repair it quietly made.
    const { fetchImpl, calls } = providerFetch();
    expect(await panelError(['my plume', 'My Plume'], fetchImpl)).toBe('config_invalid');
    expect(calls.filter((call) => call.url.endsWith(SERP_PATH))).toEqual([]);
  });
});
