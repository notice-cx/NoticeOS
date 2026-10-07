import { env } from 'cloudflare:test';
import { dataForSeoReportsFor } from '@noticeos/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SERP_PANEL_LANDING_WINDOW_DAYS,
  serpPanelLandingCutoff,
} from '../src/serp-panel-landings.js';
import { handleSerpPanelLandings } from '../src/routes/serp-panel-landings.js';
// The suite's frozen copy, the one the route's compiled fallback reads here —
// never the checkout's own config/ (bead ro-ujb9.92).
import serpPanelConfig from './fixture-config/serp-panel.json';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storeArchiveRun } from './helpers.js';

beforeEach(reset);

const PANEL_ASSETS = new Set(Object.keys(serpPanelConfig.assets));

/**
 * The clock this file's fixtures AND the route under test are both measured
 * from — the handler takes `nowMs`, so nothing here consults the wall clock.
 *
 * Pinned rather than `Date.now()` on purpose (ro-bjm6). The fixtures used to
 * seed literal August days while the route measured its 21-day window from the
 * real clock, so the file went red on nobody's change three weeks after it was
 * written — 13 of 22 cases by 2026-09-04. A `now` that MOVES is the other trap:
 * the boundary these cases are about only holds still if both ends of the
 * comparison do. A Thursday, three days after that week's Monday sweep.
 *
 * WHERE IT SITS MATTERS. Every collection below is graded against the families
 * that were due ON ITS OWN DAY (`DATAFORSEO_REPORT_AVAILABLE_FROM`), and this
 * pin puts all of them before 2026-09-01, when `backlinks-referring-domains`
 * and `backlinks-anchors` joined the weekly set. That is why the counts asserted
 * here are six families for a panel property and five without. Move the pin
 * across that date and those numbers move with it.
 */
const NOW = Date.parse('2026-08-06T09:00:00.000Z');

/** A collection day `daysBack` before NOW, in the YYYY-MM-DD the manifest
 * stores. UTC throughout, like `serpPanelLandingCutoff`, so the local timezone
 * cannot move a fixture across a midnight. */
function dayBefore(daysBack: number): string {
  return new Date(NOW - daysBack * 86_400_000).toISOString().slice(0, 10);
}

/** The three Monday sweeps the fixtures work with, newest first. All three sit
 * well inside the landing window, so a case about ordering or completeness is
 * never quietly deciding the cutoff instead. */
const THIS_WEEK = dayBefore(3);
const LAST_WEEK = dayBefore(10);
const WEEK_BEFORE = dayBefore(17);

interface LandingsBody {
  windowDays: number;
  landings: {
    asset: string;
    panelDate: string;
    landedAt: string;
    status: string;
    panel: boolean;
    queries: number | null;
    families: number;
    reports: string[];
  }[];
}

/** One manifest row, exactly as the weekly collector writes it. */
async function seedRun(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = {
    asset: 'nosh.example',
    integration: 'dataforseo',
    report: 'serp-panel',
    reportDate: THIS_WEEK,
    finishedAt: `${THIS_WEEK}T12:47:31.000Z`,
    status: 'success',
    queries: 6,
    ...overrides,
  } as {
    asset: string;
    integration: string;
    report: string;
    reportDate: string;
    finishedAt: string;
    status: string;
    queries: number;
  };
  await storeArchiveRun({
    id: crypto.randomUUID(), asset: row.asset, integration: row.integration, report: row.report,
    credential_ref: 'test-cred', property_ref: 'example.test', report_date: row.reportDate, finished_at: row.finishedAt,
    status: row.status as 'success' | 'unchanged' | 'error', provider_rows: 40, request_count: row.queries,
    provider_truncated: true, object_key: `signals/${row.asset}/${row.reportDate}/${crypto.randomUUID()}.json.gz`,
    content_sha256: 'a'.repeat(64), object_bytes: 1024,
    error_code: 'provider_error', error_message: 'the provider returned no tasks', provider_cost_usd: 0.024,
  });
}

async function seedCollection(
  asset: string,
  reportDate: string,
  options: {
    omit?: readonly string[];
    status?: string;
    statusByReport?: Readonly<Record<string, string>>;
    panelQueries?: number;
  } = {},
): Promise<void> {
  for (const report of dataForSeoReportsFor(asset, PANEL_ASSETS)) {
    if (options.omit?.includes(report)) continue;
    await seedRun({
      asset,
      report,
      reportDate,
      finishedAt:
        report === 'serp-panel'
          ? `${reportDate}T12:47:31.000Z`
          : `${reportDate}T12:45:00.000Z`,
      status: options.statusByReport?.[report] ?? options.status ?? 'success',
      queries: report === 'serp-panel' ? options.panelQueries ?? 6 : 1,
    });
  }
}

function landingsRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('https://ingest.local/api/serp-panel-landings', { method: 'GET', headers });
}

/**
 * The route, driven on the pinned clock.
 *
 * Called through the handler rather than `SELF.fetch` because that is where
 * `nowMs` can be handed in; the auth cases below still go over HTTP, so the
 * wiring from `GET /api/serp-panel-landings` to this handler stays covered.
 */
async function get(token: string | undefined = OPERATOR_TOKEN): Promise<LandingsBody> {
  const res = await handleSerpPanelLandings(landingsRequest(token), env, NOW);
  expect(res.status).toBe(200);
  return (await res.json()) as LandingsBody;
}

describe('GET /api/serp-panel-landings — auth', () => {
  it('rejects a request without the operator token (401)', async () => {
    const res = await call(landingsRequest());
    expect(res.status).toBe(401);
  });

  it('rejects a wrong operator token (401)', async () => {
    const res = await call(landingsRequest('nope'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/serp-panel-landings — what landed', () => {
  it('reports a complete panel collection', async () => {
    await seedCollection('nosh.example', THIS_WEEK);
    const body = await get();
    expect(body.windowDays).toBe(SERP_PANEL_LANDING_WINDOW_DAYS);
    expect(body.landings).toEqual([
      {
        asset: 'nosh.example',
        panelDate: THIS_WEEK,
        landedAt: `${THIS_WEEK}T12:47:31.000Z`,
        status: 'success',
        panel: true,
        queries: 6,
        families: 6,
        // The families due that day, by name: what the filer checks the
        // published panel for (epic ro-cvl9).
        reports: dataForSeoReportsFor('nosh.example', PANEL_ASSETS, THIS_WEEK),
      },
    ]);
  });

  it('says nothing at all when nothing has ever been collected', async () => {
    const body = await get();
    expect(body.landings).toEqual([]);
  });

  // The whole read is keyed on the collection day, so the filer's identity for a
  // review — (property, collection day) — is re-derivable every pass. That is
  // where idempotence comes from; there is no cursor to lose.
  it('reports one row per property, the newest collection only', async () => {
    await seedCollection('nosh.example', WEEK_BEFORE);
    await seedCollection('nosh.example', THIS_WEEK);
    await seedCollection('nosh.example', LAST_WEEK);
    const body = await get();
    expect(body.landings.map((l) => l.panelDate)).toEqual([THIS_WEEK]);
  });

  // A later write about an EARLIER collection — a backfill, a re-archive — must
  // not promote it over a newer one.
  it('ranks by the collection day before the write time', async () => {
    await seedCollection('nosh.example', THIS_WEEK);
    await seedCollection('nosh.example', LAST_WEEK);
    await seedRun({
      asset: 'nosh.example',
      report: 'ranked-keywords',
      reportDate: LAST_WEEK,
      // Written the day AFTER this week's collection: the newest WRITE about
      // the oldest DAY.
      finishedAt: `${dayBefore(2)}T09:00:00.000Z`,
    });
    const body = await get();
    expect(body.landings.map((l) => l.panelDate)).toEqual([THIS_WEEK]);
  });

  it('keeps each property’s newest collection, not the portfolio’s', async () => {
    await seedCollection('nosh.example', THIS_WEEK);
    await seedCollection('meals.example', LAST_WEEK);
    const body = await get();
    expect(body.landings.map((l) => [l.asset, l.panelDate])).toEqual([
      ['meals.example', LAST_WEEK],
      ['nosh.example', THIS_WEEK],
    ]);
  });

  // A same-day re-fetch whose bytes matched writes `unchanged`. The archive
  // still holds that day's collection, so it is a landing.
  it('counts an unchanged re-fetch as a landing', async () => {
    await seedCollection('nosh.example', THIS_WEEK, { status: 'unchanged' });
    const body = await get();
    expect(body.landings.map((l) => l.status)).toEqual(['unchanged']);
  });

  // Nothing landed, so there is nothing to triage. Filing "review the
  // collection" against an empty archive would be the OS inventing work.
  it('ignores a collection that failed', async () => {
    await seedCollection('nosh.example', THIS_WEEK, { status: 'error' });
    const body = await get();
    expect(body.landings).toEqual([]);
  });

  it('ignores every other provider', async () => {
    await seedRun({ integration: 'gsc', report: 'serp-panel' });
    await seedRun({ integration: 'ga4', report: 'traffic-acquisition' });
    const body = await get();
    expect(body.landings).toEqual([]);
  });
});

/**
 * ro-478: the anchor is the weekly COLLECTION, not the panel family inside it.
 * A property with no entry in config/serp-panel.json still buys five report
 * families every Monday, and while this read answered only about `serp-panel` it
 * landed nothing for them — so nobody was ever asked to read what they bought.
 */
describe('GET /api/serp-panel-landings — the collection, panel or no panel', () => {
  it('lands a collection for a property that has no panel at all', async () => {
    await seedCollection('pacer.example', THIS_WEEK);
    const body = await get();
    expect(body.landings).toEqual([
      {
        asset: 'pacer.example',
        panelDate: THIS_WEEK,
        landedAt: `${THIS_WEEK}T12:45:00.000Z`,
        status: 'success',
        panel: false,
        queries: null,
        families: 5,
        reports: dataForSeoReportsFor('pacer.example', PANEL_ASSETS, THIS_WEEK),
      },
    ]);
  });

  // The identity guarantee for every review already filed: a panel property's
  // panel and its five broad families share one `report_date`, so the day this
  // reports is the day the panel-only query reported.
  it('reports one landing for a panel property, on the panel’s own day', async () => {
    await seedCollection('nosh.example', THIS_WEEK, { panelQueries: 6 });
    const body = await get();
    expect(body.landings).toHaveLength(1);
    expect(body.landings[0]).toMatchObject({
      panelDate: THIS_WEEK,
      panel: true,
      queries: 6,
      families: 6,
    });
  });

  // A property with nothing in the archive owes nothing. The whole read is
  // "what was bought", so silence stays silence.
  it('lands nothing for a property that bought nothing', async () => {
    await seedCollection('nosh.example', THIS_WEEK);
    const body = await get();
    expect(body.landings.map((l) => l.asset)).toEqual(['nosh.example']);
  });

  // `queries` sizes the PANEL walk. A broad family's one call is not a tracked
  // query, and reporting it would tell the reviewer to walk a panel of one.
  it('never reports a broad family’s request count as a panel size', async () => {
    await seedCollection('pacer.example', THIS_WEEK);
    const body = await get();
    expect(body.landings.map((l) => l.queries)).toEqual([null]);
  });

  // One family re-fetched unchanged is still a collection that changed.
  it('calls the day unchanged only when every family was', async () => {
    await seedCollection('nosh.example', THIS_WEEK, {
      status: 'unchanged',
      statusByReport: { 'backlinks-summary': 'success' },
    });
    await seedCollection('areas.example', THIS_WEEK, {
      status: 'unchanged',
    });
    const body = await get();
    expect(body.landings.map((l) => [l.asset, l.status])).toEqual([
      ['areas.example', 'unchanged'],
      ['nosh.example', 'success'],
    ]);
  });

  it('does not expose a four-of-six interrupted panel sweep', async () => {
    await seedCollection('nosh.example', THIS_WEEK, {
      omit: ['llm-mentions-chatgpt', 'serp-panel'],
    });
    const body = await get();
    expect(body.landings).toEqual([]);
  });

  it('keeps the prior complete identity when the newest day has a failed family', async () => {
    await seedCollection('nosh.example', LAST_WEEK);
    await seedCollection('nosh.example', THIS_WEEK, {
      statusByReport: { 'backlinks-new-lost': 'error' },
    });
    const body = await get();
    expect(body.landings.map((landing) => landing.panelDate)).toEqual([
      LAST_WEEK,
    ]);
  });

  it('promotes a partial day only after its missing families land', async () => {
    await seedCollection('nosh.example', THIS_WEEK, {
      omit: ['backlinks-new-lost', 'serp-panel'],
    });
    expect((await get()).landings).toEqual([]);

    await seedRun({
      asset: 'nosh.example',
      report: 'backlinks-new-lost',
      reportDate: THIS_WEEK,
    });
    await seedRun({
      asset: 'nosh.example',
      report: 'serp-panel',
      reportDate: THIS_WEEK,
      queries: 6,
    });
    expect((await get()).landings).toMatchObject([
      { asset: 'nosh.example', panelDate: THIS_WEEK, panel: true, families: 6 },
    ]);
  });

  // A property whose panel was collected on its own day — an on-demand
  // `--families serp-panel` repair — must not masquerade as the week's whole
  // collection and supersede a review filed from coherent evidence.
  it('does not let a scoped one-family repair supersede a complete collection', async () => {
    await seedCollection('nosh.example', LAST_WEEK);
    // The Wednesday after that Monday sweep — a day carrying the panel alone.
    const repairDay = dayBefore(8);
    await seedRun({ asset: 'nosh.example', report: 'serp-panel', reportDate: repairDay, queries: 6 });
    const body = await get();
    expect(body.landings.map((l) => [l.panelDate, l.families])).toEqual([
      [LAST_WEEK, 6],
    ]);
  });
});

describe('GET /api/serp-panel-landings — the window', () => {
  it('looks back three weekly collections', () => {
    expect(SERP_PANEL_LANDING_WINDOW_DAYS).toBe(21);
    expect(serpPanelLandingCutoff(Date.parse('2026-08-03T12:00:00.000Z'))).toBe('2026-07-13');
  });

  // A collector that stopped a month ago is a different problem, and handing
  // somebody a triage task about a result page that old would be the wrong ask.
  it('drops a panel older than the window', async () => {
    await seedCollection('nosh.example', dayBefore(SERP_PANEL_LANDING_WINDOW_DAYS + 3));
    const body = await get();
    expect(body.landings).toEqual([]);
  });

  // The catch-up case the window exists for: the runner was down when this
  // landed, and the next pass still sees it.
  it('keeps a panel the runner was asleep for', async () => {
    const recent = dayBefore(9);
    await seedCollection('nosh.example', recent);
    const body = await get();
    expect(body.landings.map((l) => l.panelDate)).toEqual([recent]);
  });
});
