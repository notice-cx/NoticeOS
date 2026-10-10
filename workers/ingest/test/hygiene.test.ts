import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_BEACONS, EGRESS_DOWN_RULE_ID, EGRESS_USER_AGENT } from '../src/egress.js';
import {
  blockingDirectives,
  countVisibleWords,
  HOME_CONFIRM_WAIT_MS,
  HOME_UNREACHABLE_RULE_ID,
  HYGIENE_CHECKS,
  HYGIENE_USER_AGENT,
  HTML_DEPTH_RULE_ID,
  locValues,
  median,
  PAGE_DIRECTIVES_RULE_ID,
  PAGE_STRUCTURE_RULE_ID,
  parsePageDirectives,
  parsePageStructure,
  sameCanonicalTarget,
  structureFaults,
  parseRobotsGroups,
  resolveBotAccess,
  ROBOTS_AI_RULE_ID,
  runHygieneChecks,
  runUptimeChecks,
  sitemapRoot,
  sitemapUrlsFromRobots,
  SITEMAP_RULE_ID,
  stableSample,
  type HygieneAsset,
  type HygieneStatus,
  UPTIME_FRESH_MS,
} from '../src/hygiene.js';
import { flagRows, insertFlag, pgCount, reset } from './helpers.js';
import { changeSites } from './sites';

beforeEach(reset);

const DOMAIN = 'meadow.example';
const HOME = `https://${DOMAIN}/`;
const ROBOTS = `https://${DOMAIN}/robots.txt`;
const SITEMAP = `https://${DOMAIN}/sitemap.xml`;
const ASSETS: HygieneAsset[] = [{ asset: 'meadow.example', domain: DOMAIN }];

/** 04:00 UTC — the cron's own slot. */
const NOW = Date.parse('2026-07-20T04:00:00.000Z');
const TODAY = '2026-07-20';
/** The day a `NOW + DAY_MS` sweep writes its readings under. */
const TOMORROW = '2026-07-21';
const DAY_MS = 86_400_000;
/** A failed home page's confirming retry, asked without the 45-second wait.
 * The wait itself is proved with fake timers in the uptime suite. */
const AT_ONCE = 0;

function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

// --- origin stub ------------------------------------------------------------

interface StubCall {
  url: string;
  userAgent: string | null;
  accept: string | null;
}

/** Route url -> response factory; an unrouted url is a network failure. */
function stubOrigin(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, userAgent: headers.get('user-agent'), accept: headers.get('accept') });
    const handler = routes[url];
    if (!handler) throw new Error(`connection refused: ${url}`);
    return handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const plain = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
const xml = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
const status = (code: number): Response => new Response('nope', { status: code });

/** An HTML page carrying exactly `count` words of visible text. */
function page(count: number): string {
  const words = Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
  return `<!doctype html><html><head><title>t</title><style>body{color:red}</style></head><body><p>${words}</p><script>var x=1;</script></body></html>`;
}

function urlset(count: number, domain: string = DOMAIN): string {
  const entries = Array.from(
    { length: count },
    (_, i) => `<url><loc>https://${domain}/p/${i}</loc></url>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

/** Route every page an `urlset(count, domain)` names, each a clean document —
 * the fixture for "this property has nothing structurally wrong with it". */
function pageRoutes(count: number, domain: string = DOMAIN): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i < count; i += 1) {
    const url = `https://${domain}/p/${i}`;
    routes[url] = () => html(cleanPage(url));
  }
  return routes;
}


// --- structural fixtures: one page, one broken rule -------------------------
//
// Every page breaks exactly one rule, so a check that fires on the wrong page
// is caught by the fixture. The pages are the four faults `page-structure`
// claims to catch plus a clean control, and `STRUCTURAL_FIXTURES` is swept as
// a whole so a fault added to the parser without a page to prove it fails here.

/** A structurally perfect page: title, description, one h1, self-canonical. */
function cleanPage(url: string, body = 'Some real words about food groups.'): string {
  return (
    `<!doctype html><html><head>` +
    `<title>Clean page</title>` +
    `<meta name="description" content="A description that exists.">` +
    `<link rel="canonical" href="${url}">` +
    `</head><body><h1>Clean page</h1><p>${body}</p></body></html>`
  );
}

const STRUCTURAL_FIXTURES: {
  fault: string;
  html: (url: string) => string;
}[] = [
  {
    fault: 'no-title',
    html: (url) => cleanPage(url).replace('<title>Clean page</title>', ''),
  },
  {
    // An EMPTY title is the same fact as none: the SERP has nothing to print.
    fault: 'no-title',
    html: (url) => cleanPage(url).replace('<title>Clean page</title>', '<title>  </title>'),
  },
  {
    fault: 'no-meta-description',
    html: (url) =>
      cleanPage(url).replace(
        '<meta name="description" content="A description that exists.">',
        '',
      ),
  },
  {
    fault: 'no-h1',
    html: (url) => cleanPage(url).replace('<h1>Clean page</h1>', '<h2>Clean page</h2>'),
  },
  {
    fault: 'multiple-h1',
    html: (url) =>
      cleanPage(url).replace('<h1>Clean page</h1>', '<h1>One</h1><h1>Two</h1>'),
  },
  {
    fault: 'canonical-elsewhere',
    html: (url) =>
      cleanPage(url).replace(
        `<link rel="canonical" href="${url}">`,
        `<link rel="canonical" href="https://${DOMAIN}/somewhere-else">`,
      ),
  },
];

const PERMISSIVE_ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${SITEMAP}\n`;

const isBeacon = (url: string): boolean => (EGRESS_BEACONS as readonly string[]).includes(url);

/** The reference site the egress gate asks before letting a statusless fetch
 * accuse anybody. Routing it means the OS's own connection is fine, which every
 * test about a property's outage has to establish first; leaving it unrouted
 * is how the tests below simulate a dead uplink. */
const BEACON_UP: Record<string, () => Response> = {
  [EGRESS_BEACONS[0]]: () => plain('h=1'),
};

/** The default healthy origin, with per-route overrides. */
function origin(overrides: Partial<Record<string, () => Response>> = {}): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  return stubOrigin({
    [HOME]: () => html(page(800)),
    [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
    [SITEMAP]: () => xml(urlset(120)),
    ...overrides,
  } as Record<string, () => Response>);
}

// --- store helpers ----------------------------------------------------------

async function seedReading(
  check: string,
  day: string,
  readingStatus: HygieneStatus,
  value: number | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
       VALUES ($1, 'meadow.example', $2, $3::timestamptz, $4::date, $5, $6, $7::json)`,
      [tx.workspaceId, check, `${day}T04:00:00.000Z`, day, readingStatus, value, JSON.stringify(detail)],
    ),
  );
}

/** How many stored readings match `where` (a condition on the table's own columns). */
async function readingCount(where: string): Promise<number> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM noticeos.hygiene_checks WHERE ${where}`),
  );
  return row?.n ?? 0;
}

/** `count` consecutive daily readings ending the day before `endDay`. */
async function seedDepthHistory(
  count: number,
  words: number,
  readingStatus: HygieneStatus = 'ok',
  endDay = TODAY,
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    await seedReading('html-depth', daysBefore(endDay, i), readingStatus, words);
  }
}

type ReadingRow = {
  status: string;
  value_num: number | null;
  detail_json: string;
};

async function readingFor(check: string, day = TODAY): Promise<ReadingRow | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<ReadingRow>(
      `SELECT status, value_num, detail::text AS detail_json FROM noticeos.hygiene_checks
        WHERE asset_id = 'meadow.example' AND check_id = $1 AND observed_on = $2::date`,
      [check, day],
    ),
  );
  return row ?? null;
}

function detailOf(row: ReadingRow | null): Record<string, unknown> {
  return row ? (JSON.parse(row.detail_json) as Record<string, unknown>) : {};
}

interface FlagRow {
  severity: string;
  kind: string;
  metric: string | null;
  message: string;
  rule_inputs: string;
  fired_at: string;
  resolved_at: string | null;
}

async function flagFor(ruleId: string, asset = 'meadow.example'): Promise<FlagRow | null> {
  const [row] = await flagRows(`asset_id = $1 AND rule_id = $2`, [asset, ruleId]);
  return row
    ? {
        severity: row.severity,
        kind: row.kind,
        metric: row.metric,
        message: row.message!,
        rule_inputs: row.rule_inputs!,
        fired_at: row.fired_at,
        resolved_at: row.resolved_at,
      }
    : null;
}

async function flagCount(ruleId: string, open: boolean): Promise<number> {
  return pgCount(
    `SELECT count(*) AS n FROM noticeos.current_flags
      WHERE rule_id = $1 AND (NOT $2::boolean OR resolved_at IS NULL)`,
    [ruleId, open],
  );
}

function inputsOf(flag: FlagRow | null): Record<string, unknown> {
  return flag ? (JSON.parse(flag.rule_inputs) as Record<string, unknown>) : {};
}

// --- pure helpers -----------------------------------------------------------

describe('countVisibleWords', () => {
  it('counts visible prose and ignores script, style, head, and markup', () => {
    expect(
      countVisibleWords(
        '<html><head><title>Recipes</title><style>p{color:red}</style></head>' +
          '<body><h1>Chicken thighs</h1><p>Roast them hot.</p><script>var a="one two three";</script></body></html>',
      ),
    ).toBe(5);
  });

  it('does not count punctuation-only separators as words', () => {
    expect(countVisibleWords('<p>Home | About &middot; Contact</p>')).toBe(3);
  });

  it('decodes the entities that affect a count', () => {
    expect(countVisibleWords('<p>salt&nbsp;and&nbsp;pepper</p>')).toBe(3);
    expect(countVisibleWords('<p>rice&amp;beans</p>')).toBe(1);
  });

  it('reads a JS-only shell as the near-empty page a crawler receives', () => {
    // A real app that renders client-side.
    const shell =
      '<html><head><title>Meadow Board</title></head><body><div id="root"></div>' +
      '<script>const app = { boot() { renderEverything(); } };</script></body></html>';
    expect(countVisibleWords(shell)).toBe(0);
  });
});

describe('median', () => {
  it('takes the middle value when odd and the mean of the middle two when even', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('robots parsing', () => {
  it('applies consecutive User-agent lines to one group', () => {
    const groups = parseRobotsGroups('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.agents).toEqual(['gptbot', 'claudebot']);
    expect(groups[0]!.disallow_all).toBe(true);
  });

  it('falls back to the wildcard group and reports which group decided', () => {
    const groups = parseRobotsGroups('User-agent: *\nDisallow: /\n\nUser-agent: Bingbot\nAllow: /\n');
    expect(resolveBotAccess(groups, 'GPTBot')).toEqual({ allowed: false, via: '*' });
    expect(resolveBotAccess(groups, 'Bingbot')).toEqual({ allowed: true, via: 'Bingbot' });
  });

  it('treats an empty Disallow as allow-all and resolves the Allow:/ tie-break', () => {
    expect(resolveBotAccess(parseRobotsGroups('User-agent: *\nDisallow:\n'), 'ClaudeBot').allowed).toBe(true);
    expect(
      resolveBotAccess(parseRobotsGroups('User-agent: *\nDisallow: /\nAllow: /\n'), 'ClaudeBot').allowed,
    ).toBe(true);
  });

  it('reads a path-scoped Disallow as still allowed (documented limit)', () => {
    // Site-level detection only: the bot IS still allowed the rest of the site.
    expect(resolveBotAccess(parseRobotsGroups('User-agent: *\nDisallow: /admin/\n'), 'GPTBot').allowed).toBe(
      true,
    );
  });

  it('collects absolute Sitemap declarations and ignores comments', () => {
    expect(
      sitemapUrlsFromRobots(`# header\nSitemap: ${SITEMAP} # main\nSitemap: /relative.xml\n`),
    ).toEqual([SITEMAP]);
  });
});

describe('sitemap parsing', () => {
  it('identifies the root element and rejects a non-sitemap body', () => {
    expect(sitemapRoot(urlset(2))).toBe('urlset');
    expect(sitemapRoot('<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>')).toBe('sitemapindex');
    expect(sitemapRoot('<!doctype html><html><body>Not found</body></html>')).toBeNull();
    expect(sitemapRoot('<urlset><url><loc>a</loc></url>')).toBeNull(); // truncated
  });

  it('extracts loc values', () => {
    expect(locValues(urlset(3))).toEqual([
      `https://${DOMAIN}/p/0`,
      `https://${DOMAIN}/p/1`,
      `https://${DOMAIN}/p/2`,
    ]);
  });
});

describe('page directive parsing', () => {
  it('reads meta-robots and treats only the closing directives as blocking', () => {
    const parsed = parsePageDirectives(
      '<html><head><meta name="ROBOTS" content="NoIndex, nofollow"></head><body>x</body></html>',
      null,
    );
    expect(parsed.all).toEqual(['noindex', 'nofollow']);
    expect(parsed.sources).toEqual(['meta-robots']);
    // nofollow changes how a page is treated; it does not remove it.
    expect(blockingDirectives(parsed)).toEqual(['noindex']);
  });

  it('counts nosnippet, noai, and max-snippet:0 as closing the page', () => {
    expect(
      blockingDirectives(parsePageDirectives('<meta name="robots" content="nosnippet, noai">', null)),
    ).toEqual(['noai', 'nosnippet']);
    expect(
      blockingDirectives(parsePageDirectives('<meta name="robots" content="max-snippet: 0">', null)),
    ).toEqual(['max-snippet:0']);
    // A snippet cap that still allows a snippet is not a block.
    expect(
      blockingDirectives(parsePageDirectives('<meta name="robots" content="max-snippet:120">', null)),
    ).toEqual([]);
  });

  it('scopes a per-agent meta tag to that agent', () => {
    const parsed = parsePageDirectives('<meta name="GPTBot" content="noindex">', null);
    expect(parsed.all).toEqual([]);
    expect(parsed.byAgent).toEqual({ gptbot: ['noindex'] });
    expect(blockingDirectives(parsed)).toEqual(['gptbot:noindex']);
  });

  it('reads an X-Robots-Tag header, including its agent scope', () => {
    const bare = parsePageDirectives('<html></html>', 'noindex, nofollow');
    expect(bare.all).toEqual(['noindex', 'nofollow']);
    expect(bare.sources).toEqual(['x-robots-tag']);

    const scoped = parsePageDirectives('<html></html>', 'googlebot: noindex, nosnippet');
    expect(scoped.all).toEqual([]);
    expect(blockingDirectives(scoped)).toEqual(['googlebot:noindex', 'googlebot:nosnippet']);
  });

  it('does not mistake a valued directive for a user agent', () => {
    const parsed = parsePageDirectives('<html></html>', 'unavailable_after: 2027-01-01T00:00:00Z, noindex');
    expect(parsed.byAgent).toEqual({});
    expect(parsed.all).toContain('noindex');
  });

  it('finds nothing on an ordinary page', () => {
    const parsed = parsePageDirectives(page(400), null);
    expect(parsed.all).toEqual([]);
    expect(blockingDirectives(parsed)).toEqual([]);
  });
});

describe('stableSample', () => {
  const roster = Array.from({ length: 40 }, (_, i) => `https://${DOMAIN}/p/${i}`);

  it('is deterministic and independent of the order it was given', () => {
    const forwards = stableSample(roster, 3);
    expect(forwards).toHaveLength(3);
    expect(stableSample([...roster].reverse(), 3)).toEqual(forwards);
  });

  it('survives pages being added, so a comparison can accumulate', () => {
    // A lastmod-sorted sitemap prepends today's page every night. First-N would
    // resample every night and every reading would be a first reading.
    const withNewPost = [`https://${DOMAIN}/fresh`, ...roster];
    const kept = stableSample(withNewPost, 3).filter((url) => stableSample(roster, 3).includes(url));
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });

  it('takes everything when the roster is smaller than the sample', () => {
    expect(stableSample(['https://a/1', 'https://a/1', 'https://a/2'], 3).sort()).toEqual([
      'https://a/1',
      'https://a/2',
    ]);
  });
});

// --- html-depth -------------------------------------------------------------

describe('hygiene: html-depth', () => {
  it('flags when today is at or under half the trailing median', async () => {
    await seedDepthHistory(10, 800);
    const { fetchImpl } = origin({ [HOME]: () => html(page(300)) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);

    const row = await readingFor('html-depth');
    expect(row).toMatchObject({ status: 'warn', value_num: 300 });
    expect(detailOf(row)).toMatchObject({ baseline_median: 800, baseline_readings: 10, armed: true });

    const flag = await flagFor(HTML_DEPTH_RULE_ID);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'html-depth' });
    expect(flag!.message).toContain('300 words');
    expect(inputsOf(flag)).toMatchObject({ rule: HTML_DEPTH_RULE_ID, words: 300, occurrences: 1 });
  });

  it('stays silent on sparse history no matter how empty the page is', async () => {
    await seedDepthHistory(6, 800);
    const { fetchImpl } = origin({ [HOME]: () => html(page(4)) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);

    const row = await readingFor('html-depth');
    expect(row).toMatchObject({ status: 'ok', value_num: 4 });
    expect(detailOf(row)).toMatchObject({ armed: false, baseline_readings: 6, baseline_median: null });
  });

  it('does not flag just above the threshold', async () => {
    await seedDepthHistory(10, 800);
    const { fetchImpl } = origin({ [HOME]: () => html(page(401)) });

    expect((await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW })).fired).toBe(0);
    expect(await readingFor('html-depth')).toMatchObject({ status: 'ok', value_num: 401 });
  });

  it('builds the baseline from healthy readings only, so a standing collapse cannot become normal', async () => {
    // Eight recent collapsed nights would drag an all-readings median to 450 and
    // silence the rule; the healthy-only baseline stays at 800.
    for (let i = 1; i <= 8; i += 1) await seedReading('html-depth', daysBefore(TODAY, i), 'warn', 100);
    for (let i = 9; i <= 15; i += 1) await seedReading('html-depth', daysBefore(TODAY, i), 'ok', 800);
    const { fetchImpl } = origin({ [HOME]: () => html(page(300)) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({
      baseline_median: 800,
      baseline_readings: 7,
    });
  });

  it('records a failing home page without filing a depth flag', async () => {
    await seedDepthHistory(10, 800);
    const { fetchImpl } = origin({ [HOME]: () => status(503) });

    const result = await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW });
    expect(await flagCount(HTML_DEPTH_RULE_ID, false)).toBe(0);

    const row = await readingFor('html-depth');
    // An unreachable page is not a zero-word page: no count is stored at all.
    expect(row).toMatchObject({ status: 'error', value_num: null });
    expect(result.outcomes.find((o) => o.check === 'html-depth')).toMatchObject({ status: 'error' });
  });

  it('resolves the open flag when depth recovers', async () => {
    await seedDepthHistory(10, 800);
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin({ [HOME]: () => html(page(300)) }).fetchImpl,
      nowMs: NOW,
    });
    expect(await flagCount(HTML_DEPTH_RULE_ID, true)).toBe(1);

    const result = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin().fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(result.resolved).toBe(1);
    expect(await flagCount(HTML_DEPTH_RULE_ID, true)).toBe(0);
  });
});

// --- home reachability ------------------------------------------------------

describe('hygiene: home-unreachable', () => {
  it('flags a 5xx home page under its own rule, never as a depth collapse', async () => {
    await seedDepthHistory(10, 800);
    const { fetchImpl } = origin({ [HOME]: () => status(503) });

    await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW });

    // The two rules trigger on disjoint outcomes, so they cannot double-report.
    expect(await flagCount(HTML_DEPTH_RULE_ID, false)).toBe(0);
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);

    const flag = await flagFor(HOME_UNREACHABLE_RULE_ID);
    // A site that is down is the revenue-off-switch band.
    expect(flag).toMatchObject({ severity: 'error', kind: 'anomaly', metric: 'html-depth' });
    expect(flag!.message).toContain('HTTP 503');
    expect(inputsOf(flag)).toMatchObject({
      rule: HOME_UNREACHABLE_RULE_ID,
      http_status: 503,
      reading_status: 'error',
      occurrences: 1,
    });
  });

  it('flags an origin that never answers at all', async () => {
    // The home page is routed nowhere: the request throws, so there is no status.
    // The beacon IS routed, so the OS's own egress is proven and the silence is
    // the property's — the regression guard for the gate below, which must never
    // make this case quieter.
    const { fetchImpl } = stubOrigin({
      ...BEACON_UP,
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () => xml(urlset(120)),
    });

    await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW });

    expect(await readingFor('html-depth')).toMatchObject({ status: 'unreachable', value_num: null });
    const flag = await flagFor(HOME_UNREACHABLE_RULE_ID);
    expect(flag!.message).toContain('unreachable');
    expect(inputsOf(flag)).toMatchObject({ http_status: null, reading_status: 'unreachable' });
  });

  it('fires once and refreshes while the outage stands, then resolves when the page returns', async () => {
    const down = origin({ [HOME]: () => status(500) }).fetchImpl;
    await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: down, nowMs: NOW });
    const second = await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: down, nowMs: NOW + DAY_MS });

    // One outage is one problem, not two: the second night rewrites the row.
    expect(second.fired).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(1);
    const standing = await flagFor(HOME_UNREACHABLE_RULE_ID);
    expect(standing!.fired_at).toBe(new Date(NOW).toISOString()); // onset, not tonight
    expect(inputsOf(standing)).toMatchObject({ occurrences: 2 });

    const recovered = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin().fetchImpl,
      nowMs: NOW + 2 * DAY_MS,
    });
    expect(recovered.resolved).toBe(1);
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(0);
  });

  it('retracts the outage flag even while the depth rule is unarmed', async () => {
    // No history at all, so html-depth cannot judge the page — but "the page
    // answered" needs no baseline, so the reachability flag still resolves.
    await runHygieneChecks(env, {
      assets: ASSETS, confirmWaitMs: AT_ONCE,
      fetchImpl: origin({ [HOME]: () => status(502) }).fetchImpl,
      nowMs: NOW,
    });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);

    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin({ [HOME]: () => html(page(4)) }).fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(detailOf(await readingFor('html-depth', TOMORROW))).toMatchObject({ armed: false });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(0);
  });

  it('files nothing when the home page fails once and answers the retry', async () => {
    await seedDepthHistory(10, 800);
    let tries = 0;
    const { fetchImpl } = origin({
      [HOME]: () => {
        tries += 1;
        return tries === 1 ? status(503) : html(page(800));
      },
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW });

    expect(tries).toBe(2);
    expect(result.fired).toBe(0);
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
    expect(result.outcomes.filter((o) => o.check === 'html-depth')).toEqual([
      expect.objectContaining({ status: 'ok', value: 800 }),
    ]);
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ failed_tries: 1, first_try_http_status: 503 });
  });

  it('does not accuse the property when the 200 is one WE declined to read', async () => {
    const { fetchImpl } = origin({
      [HOME]: () =>
        new Response('binary', { status: 200, headers: { 'content-type': 'application/gzip' } }),
    });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    expect(await readingFor('html-depth')).toMatchObject({ status: 'error', value_num: null });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ unsupported: true });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
  });
});

// --- uptime: the home-page check, hourly -------------------------------------

describe('uptime: the hourly home-page check', () => {
  const HOUR_MS = 3_600_000;

  /** The home page answers `failures` in turn, then answers normally. */
  function flaky(...failures: (() => Response)[]): ReturnType<typeof origin> {
    let tries = 0;
    return origin({ [HOME]: () => (failures[tries++] ?? (() => html(page(800))))() });
  }

  it('asks only the home page, and files an error when a second try 45 seconds later fails too', async () => {
    // Captured before the fake clock replaces it: the store's own I/O still
    // needs a real turn of the event loop while the run reaches its wait.
    const realTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The store's connection pool keeps timers of its own, so the run is
    // waited for until it schedules the 45-second wait itself.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { fetchImpl, calls } = origin({ [HOME]: () => status(503) });

    const run = runUptimeChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW + 6 * HOUR_MS });
    for (let turn = 0; !timers.mock.calls.some(([, ms]) => ms === HOME_CONFIRM_WAIT_MS) && turn < 2_000; turn += 1) {
      await new Promise((resolve) => realTimeout(resolve, 1));
    }

    // One failed GET: nothing written, nothing filed, the retry waiting.
    expect(calls.map((call) => call.url)).toEqual([HOME]);
    expect(await readingFor('html-depth')).toBeNull();
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
    await vi.advanceTimersByTimeAsync(HOME_CONFIRM_WAIT_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    // One request a site, and one more only when it failed: robots, the
    // sitemap and the page sample stay nightly.
    expect(calls.map((call) => call.url)).toEqual([HOME, HOME]);
    expect(calls[1]!.userAgent).toBe(HYGIENE_USER_AGENT);
    expect(result).toMatchObject({ assets: 1, checked: 1, skipped: 0, retried: 1, fired: 1 });
    expect(await readingFor('html-depth')).toMatchObject({ status: 'error', value_num: null });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ http_status: 503, failed_tries: 2 });
    const flag = await flagFor(HOME_UNREACHABLE_RULE_ID);
    expect(flag).toMatchObject({ severity: 'error', kind: 'anomaly', metric: 'html-depth' });
    expect(flag!.message).toContain('HTTP 503');
  });

  afterEach(() => {
    // The spy on the faked setTimeout first, then the clock. The other way
    // round, restoring the spy puts the dead clock's setTimeout back on the
    // global, and every timer a later file in this runtime sets never fires.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('files nothing on one transient failure: the retry answers, and the reading keeps the failed try', async () => {
    const { fetchImpl, calls } = flaky(() => status(502));

    const result = await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW + HOUR_MS });

    expect(calls.map((call) => call.url)).toEqual([HOME, HOME]);
    expect(result).toMatchObject({ checked: 1, retried: 1, fired: 0, refreshed: 0 });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
    expect(await readingFor('html-depth')).toMatchObject({ status: 'ok', value_num: 800 });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ failed_tries: 1, first_try_http_status: 502 });
  });

  it('files nothing when a page that never answered answers the retry', async () => {
    // No status at all, with the OS's own egress proven: the site's silence,
    // held for the retry like any other failure.
    let tries = 0;
    const { fetchImpl } = stubOrigin({
      ...BEACON_UP,
      [HOME]: () => {
        tries += 1;
        if (tries === 1) throw new Error('connection reset');
        return html(page(800));
      },
    });

    const result = await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW + HOUR_MS });

    expect(result).toMatchObject({ retried: 1, fired: 0 });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ failed_tries: 1, first_try_http_status: null });
  });

  it('closes the open alert when the retry answers', async () => {
    const down = origin({ [HOME]: () => status(500) }).fetchImpl;
    await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: down, nowMs: NOW + HOUR_MS });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);

    const back = await runUptimeChecks(env, {
      assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: flaky(() => status(500)).fetchImpl, nowMs: NOW + 2 * HOUR_MS,
    });

    expect(back).toMatchObject({ retried: 1, fired: 0, resolved: 1 });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(0);
  });

  it('accuses no site when the OS went offline before the retry', async () => {
    // The first GET got a 503 back, so the OS was online; the retry gets
    // nothing, and neither do the beacons.
    let tries = 0;
    const { fetchImpl } = stubOrigin({
      [HOME]: () => {
        tries += 1;
        if (tries === 1) return status(503);
        throw new Error('internal error; reference = 7c1a03f5');
      },
    });

    const result = await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW + HOUR_MS });

    expect(result).toMatchObject({ retried: 1, fired: 0 });
    expect(result.egress).toMatchObject({ up: false, unmeasuredAssets: [ASSETS[0]!.asset] });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ egress_down: true });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
  });

  it('waits once for every site whose first GET failed, not once a site', async () => {
    const other: HygieneAsset = { asset: 'northwind.example', domain: 'northwind.example' };
    const { fetchImpl, calls } = stubOrigin({
      [HOME]: () => status(503),
      'https://northwind.example/': () => status(503),
    });
    const realTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The store's connection pool keeps timers of its own (each site's last
    // reading is read on Postgres), so the wait is told apart by its length.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const confirmWaits = () => timers.mock.calls.filter(([, ms]) => ms === HOME_CONFIRM_WAIT_MS).length;

    const run = runUptimeChecks(env, { assets: [ASSETS[0]!, other], fetchImpl, nowMs: NOW + HOUR_MS });
    for (let turn = 0; confirmWaits() === 0 && turn < 2_000; turn += 1) {
      await new Promise((resolve) => realTimeout(resolve, 1));
    }
    expect(calls).toHaveLength(2);
    expect(confirmWaits()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOME_CONFIRM_WAIT_MS);
    const result = await run;

    expect(calls).toHaveLength(4);
    expect(confirmWaits()).toBe(1);
    expect(result).toMatchObject({ checked: 2, retried: 2, fired: 2 });
  });

  it('refreshes the one open alert each hour it stays down, and retracts it the hour it answers', async () => {
    const down = origin({ [HOME]: () => status(500) }).fetchImpl;
    await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: down, nowMs: NOW + HOUR_MS });
    const second = await runUptimeChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl: down, nowMs: NOW + 2 * HOUR_MS });
    expect(second).toMatchObject({ fired: 0, refreshed: 1 });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(1);

    const back = await runUptimeChecks(env, { assets: ASSETS, fetchImpl: origin().fetchImpl, nowMs: NOW + 3 * HOUR_MS });
    expect(back.resolved).toBeGreaterThanOrEqual(1);
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(0);
    // The day's reading is the hour's: up, with the words it counted.
    expect(await readingFor('html-depth')).toMatchObject({ status: 'ok', value_num: 800 });
  });

  it('files a site-down alert at error, not warn', async () => {
    await insertFlag({
      asset: 'meadow.example',
      firedAt: new Date(NOW - DAY_MS).toISOString(),
      severity: 'warn',
      kind: 'anomaly',
      metric: 'html-depth',
      message: 'home page did not serve',
      ruleId: HOME_UNREACHABLE_RULE_ID,
      ruleInputs: '{}',
    });

    await runUptimeChecks(env, {
      assets: ASSETS, confirmWaitMs: AT_ONCE,
      fetchImpl: origin({ [HOME]: () => status(502) }).fetchImpl,
      nowMs: NOW + HOUR_MS,
    });

    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(1);
    expect(await flagFor(HOME_UNREACHABLE_RULE_ID)).toMatchObject({ severity: 'error' });
  });

  it('asks a site nothing when its home page was read within the half hour', async () => {
    // The nightly sweep read it at 04:00; the 04:00 hourly tick is the same check.
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl: origin().fetchImpl, nowMs: NOW });
    const { fetchImpl, calls } = origin({ [HOME]: () => status(503) });

    const result = await runUptimeChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW + UPTIME_FRESH_MS - 1 });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ checked: 0, skipped: 1, fired: 0 });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
  });

  it('accuses no site when the OS itself cannot reach the network', async () => {
    const result = await runUptimeChecks(env, { assets: ASSETS, fetchImpl: stubOrigin({}).fetchImpl, nowMs: NOW + HOUR_MS });

    expect(result).toMatchObject({ checked: 1, fired: 0 });
    expect(result.egress).toMatchObject({ up: false, unmeasuredAssets: [ASSETS[0]!.asset] });
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ egress_down: true });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, false)).toBe(0);
  });
});

// --- the OS's own egress ----------------------------------------------------

describe('hygiene: OS egress outage', () => {
  it('records readings, accuses no property, and files ONE flag on the OS row', async () => {
    await seedDepthHistory(10, 800);
    // Nothing is routed: the house uplink is down and every one of these
    // fetches comes back without a status.
    const { fetchImpl, calls } = stubOrigin({});

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    // The readings still land. A night the OS could not measure must not read as
    // a night it found nothing wrong.
    expect(result.checks).toBe(HYGIENE_CHECKS.length);
    for (const check of ['sitemap', 'html-depth', 'robots-ai-access']) {
      const row = await readingFor(check);
      expect(row).toMatchObject({ status: 'unreachable', value_num: null });
      expect(detailOf(row)).toMatchObject({ egress_down: true });
    }

    // Not one accusation, under any of the five property rules.
    expect(result.fired).toBe(0);
    expect(result.refreshed).toBe(0);
    for (const rule of [
      HOME_UNREACHABLE_RULE_ID,
      HTML_DEPTH_RULE_ID,
      ROBOTS_AI_RULE_ID,
      PAGE_DIRECTIVES_RULE_ID,
      SITEMAP_RULE_ID,
    ]) {
      expect(await flagCount(rule, false)).toBe(0);
    }

    // Exactly one flag in the whole store, and it is the OS's own.
    expect(result.egress).toMatchObject({
      up: false,
      fired: 1,
      probes: 1,
      unmeasuredAssets: [ASSETS[0]!.asset],
    });
    const flag = await flagFor(EGRESS_DOWN_RULE_ID, 'root-os');
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: null });
    expect(flag!.message).toBe('OS egress down — 1 properties unmeasured');

    // One question for the whole sweep, asked as ourselves and never as the
    // hygiene lane.
    const probes = calls.filter((call) => isBeacon(call.url));
    expect(probes).toHaveLength(EGRESS_BEACONS.length);
    for (const probe of probes) expect(probe.userAgent).toBe(EGRESS_USER_AGENT);
  });

  it('never asks the beacons about a property that answered — a 403 is proof enough', async () => {
    // The beacons are unrouted, so a gate consulted here would say DOWN and
    // swallow the flag. An HTTP status must skip the question entirely.
    const { fetchImpl, calls } = stubOrigin({
      [HOME]: () => status(403),
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () => xml(urlset(120)),
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, confirmWaitMs: AT_ONCE, fetchImpl, nowMs: NOW });

    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);
    expect(inputsOf(await flagFor(HOME_UNREACHABLE_RULE_ID))).toMatchObject({ http_status: 403 });
    expect(result.egress).toMatchObject({ checked: false, up: null, probes: 0 });
    expect(calls.some((call) => isBeacon(call.url))).toBe(false);
  });

  it('leaves the property flags that predate the outage exactly where they were', async () => {
    // A 503 home page on a night the OS could see the world.
    await runHygieneChecks(env, {
      assets: ASSETS, confirmWaitMs: AT_ONCE,
      fetchImpl: origin({ [HOME]: () => status(503) }).fetchImpl,
      nowMs: NOW - DAY_MS,
    });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);

    const dark = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: stubOrigin({}).fetchImpl,
      nowMs: NOW,
    });

    expect(dark.egress).toMatchObject({ up: false, fired: 1 });
    // Not refreshed and not resolved: the outage night neither confirmed nor
    // withdrew anything, because it measured nothing.
    expect(dark).toMatchObject({ fired: 0, refreshed: 0, resolved: 0 });
    expect(await flagCount(HOME_UNREACHABLE_RULE_ID, true)).toBe(1);
    expect((await flagFor(HOME_UNREACHABLE_RULE_ID))!.message).toContain('HTTP 503');
  });

  it('retracts the OS flag on the next run that can reach the world', async () => {
    const dark = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: stubOrigin({}).fetchImpl,
      nowMs: NOW,
    });
    expect(dark.egress.fired).toBe(1);
    expect(await flagCount(EGRESS_DOWN_RULE_ID, true)).toBe(1);

    // Recovery night: every property answers, so nothing ever consults the gate.
    // The retraction still has to happen — the OS owes it.
    const back = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin(BEACON_UP).fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(back.egress).toMatchObject({ up: true, probes: 1, resolved: 1 });
    expect(await flagCount(EGRESS_DOWN_RULE_ID, true)).toBe(0);
    expect((await flagFor(EGRESS_DOWN_RULE_ID, 'root-os'))!.resolved_at).toBe(
      new Date(NOW + DAY_MS).toISOString(),
    );
  });

  it('judges the properties measured before the uplink died and gates only the rest', async () => {
    const nom: HygieneAsset = { asset: 'northwind.example', domain: 'northwind.example' };
    /** Serves `routes` for the first `until` requests, then nothing ever again —
     * an outage that starts partway through the sweep, beacons included. */
    function dying(until: number, routes: Record<string, () => Response>): typeof fetch {
      let served = 0;
      return (async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        served += 1;
        const handler = served <= until ? routes[url] : undefined;
        if (!handler) throw new Error('internal error; reference = 7c1a03f5');
        return handler();
      }) as typeof fetch;
    }

    // northwind.example spends exactly three requests (robots, sitemap, home) — its empty
    // sitemap leaves no pages to sample — and the uplink dies right after.
    const fetchImpl = dying(3, {
      'https://northwind.example/robots.txt': () => plain('User-agent: *\nAllow: /\n'),
      'https://northwind.example/sitemap.xml': () => xml(urlset(0)),
      'https://northwind.example/': () => html(page(600)),
    });

    const result = await runHygieneChecks(env, { assets: [nom, ASSETS[0]!], fetchImpl, nowMs: NOW });

    // The property read before the outage keeps its verdicts …
    const nomRows = await env.STORE.read((tx) =>
      tx.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM noticeos.hygiene_checks
          WHERE asset_id = 'northwind.example' GROUP BY status ORDER BY status COLLATE "C"`,
      ),
    );
    // … three of them 'ok', and page-structure 'unreachable' rather than 'ok':
    // an empty sitemap leaves no roster, so that check sampled nothing. A
    // check that measured nothing has not found nothing wrong, and this is the
    // one place the distinction is visible in a count.
    expect(nomRows).toEqual([
      { status: 'ok', n: HYGIENE_CHECKS.length - 1 },
      { status: 'unreachable', n: 1 },
    ]);
    // … and the one read after it is unmeasured, not accused.
    expect(result.egress).toMatchObject({ up: false, unmeasuredAssets: ['meadow.example'] });
    expect(result.fired).toBe(0);
    expect(detailOf(await readingFor('html-depth'))).toMatchObject({ egress_down: true });
  });
});

// --- robots-ai-access -------------------------------------------------------

describe('hygiene: robots-ai-access', () => {
  const BLOCK_GPT = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: ${SITEMAP}\n`;

  async function seedRobots(day: string, bots: Record<string, boolean>, present = true): Promise<void> {
    await seedReading('robots-ai-access', day, present ? 'ok' : 'error', null, {
      present,
      hash: 'seedhash',
      bots,
    });
  }

  const ALL_ALLOWED = {
    GPTBot: true,
    'OAI-SearchBot': true,
    'ChatGPT-User': true,
    ClaudeBot: true,
    'anthropic-ai': true,
    PerplexityBot: true,
    'Google-Extended': true,
    Bingbot: true,
  };

  it('never flags the first-ever reading, even when a bot is already blocked', async () => {
    const { fetchImpl } = origin({ [ROBOTS]: () => plain(BLOCK_GPT) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);

    const row = await readingFor('robots-ai-access');
    expect(row).toMatchObject({ status: 'ok', value_num: null });
    const detail = detailOf(row);
    expect(detail.present).toBe(true);
    expect((detail.bots as Record<string, boolean>).GPTBot).toBe(false);
    expect((detail.bots as Record<string, boolean>).ClaudeBot).toBe(true);
    expect(String(detail.hash)).toHaveLength(64);
  });

  it('flags when a previously-allowed bot becomes disallowed', async () => {
    await seedRobots(daysBefore(TODAY, 1), ALL_ALLOWED);
    const { fetchImpl } = origin({ [ROBOTS]: () => plain(BLOCK_GPT) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);

    const flag = await flagFor(ROBOTS_AI_RULE_ID);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'robots-ai-access' });
    expect(flag!.message).toContain('GPTBot');
    expect(inputsOf(flag)).toMatchObject({ lost_bots: ['GPTBot'], robots_vanished: false });
    expect(await readingFor('robots-ai-access')).toMatchObject({ status: 'warn' });
  });

  it('ignores an unrelated robots.txt change', async () => {
    await seedRobots(daysBefore(TODAY, 1), ALL_ALLOWED);
    const changed = `User-agent: *\nAllow: /\nDisallow: /admin/\nCrawl-delay: 5\nSitemap: ${SITEMAP}\n`;
    const { fetchImpl } = origin({ [ROBOTS]: () => plain(changed) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);

    const detail = detailOf(await readingFor('robots-ai-access'));
    // The content hash still moves — the file did change, it just did not
    // change anything this guard is about.
    expect(detail.hash).not.toBe('seedhash');
    expect(detail.bots).toMatchObject(ALL_ALLOWED);
  });

  it('flags robots.txt going from present to absent', async () => {
    await seedRobots(daysBefore(TODAY, 1), ALL_ALLOWED);
    const { fetchImpl } = origin({ [ROBOTS]: () => status(404) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);
    expect(inputsOf(await flagFor(ROBOTS_AI_RULE_ID))).toMatchObject({ robots_vanished: true });
    expect(await readingFor('robots-ai-access')).toMatchObject({ status: 'warn', value_num: null });
  });

  it('refreshes rather than re-fires while the block stands, then resolves on recovery', async () => {
    await seedRobots(daysBefore(TODAY, 1), ALL_ALLOWED);
    const blocked = origin({ [ROBOTS]: () => plain(BLOCK_GPT) });

    const night1 = await runHygieneChecks(env, { assets: ASSETS, fetchImpl: blocked.fetchImpl, nowMs: NOW });
    expect(night1).toMatchObject({ fired: 1, refreshed: 0 });

    // Night two sees no CHANGE against night one — the flag must survive on the
    // strength of the still-blocked state, not re-fire and not resolve.
    const night2 = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin({ [ROBOTS]: () => plain(BLOCK_GPT) }).fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(night2).toMatchObject({ fired: 0, refreshed: 1, resolved: 0 });
    expect(await flagCount(ROBOTS_AI_RULE_ID, false)).toBe(1);

    const flag = await flagFor(ROBOTS_AI_RULE_ID);
    expect(flag!.fired_at).toBe(new Date(NOW).toISOString()); // onset preserved
    expect(inputsOf(flag)).toMatchObject({ occurrences: 2 });

    const night3 = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin().fetchImpl,
      nowMs: NOW + 2 * DAY_MS,
    });
    expect(night3.resolved).toBe(1);
    expect(await flagCount(ROBOTS_AI_RULE_ID, true)).toBe(0);
  });
});

// --- page-level directives --------------------------------------------------

describe('hygiene: page directives', () => {
  const PAGE_A = `https://${DOMAIN}/recipes`;
  const PAGE_B = `https://${DOMAIN}/calculator`;
  const PAGE_C = `https://${DOMAIN}/about`;
  const SAMPLE = [PAGE_A, PAGE_B, PAGE_C];

  function urlsetOf(urls: string[]): string {
    const entries = urls.map((url) => `<url><loc>${url}</loc></url>`).join('');
    return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  }

  /** A healthy property whose sitemap holds exactly the three sampled pages. */
  function pageOrigin(overrides: Partial<Record<string, () => Response>> = {}): {
    fetchImpl: typeof fetch;
    calls: StubCall[];
  } {
    return stubOrigin({
      [HOME]: () => html(page(800)),
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () => xml(urlsetOf(SAMPLE)),
      [PAGE_A]: () => html(page(400)),
      [PAGE_B]: () => html(page(400)),
      [PAGE_C]: () => html(page(400)),
      ...overrides,
    } as Record<string, () => Response>);
  }

  const noindexPage = (): Response =>
    html('<html><head><meta name="robots" content="noindex, follow"></head><body>gone</body></html>');

  /** Yesterday's reading, with the sampled pages recorded clean. */
  async function seedCleanPages(day: string, urls = SAMPLE): Promise<void> {
    await seedReading('robots-ai-access', day, 'ok', null, {
      present: true,
      hash: 'seedhash',
      // Empty map: no bot was allowed in the previous reading, so the SITE rule
      // cannot fire here and these tests only exercise the page rule.
      bots: {},
      pages: urls.map((url) => ({
        url,
        http_status: 200,
        directives: [],
        blocking: [],
        sources: [],
        read: true,
      })),
    });
  }

  it('samples real pages from the sitemap and records what each one carries', async () => {
    const { fetchImpl, calls } = pageOrigin({ [PAGE_B]: () => noindexPage() });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    const detail = detailOf(await readingFor('robots-ai-access'));
    expect(detail).toMatchObject({ pages_sampled: 3, pages_available: 3, pages_source: 'sitemap' });
    const pages = detail.pages as { url: string; blocking: string[]; sources: string[] }[];
    expect(pages.map((p) => p.url).sort()).toEqual([...SAMPLE].sort());
    // The reading NAMES the directive, not merely that something was wrong.
    expect(pages.find((p) => p.url === PAGE_B)).toMatchObject({
      blocking: ['noindex'],
      sources: ['meta-robots'],
    });

    // The sampled pages are fetched as ourselves, like everything else.
    for (const call of calls) expect(call.userAgent).toBe(HYGIENE_USER_AGENT);
  });

  it('never flags a page whose first-ever reading is already noindex', async () => {
    const { fetchImpl } = pageOrigin({ [PAGE_A]: () => noindexPage() });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    expect(result.fired).toBe(0);
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, false)).toBe(0);
    expect(await readingFor('robots-ai-access')).toMatchObject({ status: 'ok' });
  });

  it('flags a page that was clean yesterday and carries meta-robots noindex today', async () => {
    await seedCleanPages(daysBefore(TODAY, 1));
    const { fetchImpl } = pageOrigin({ [PAGE_A]: () => noindexPage() });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);

    expect(await readingFor('robots-ai-access')).toMatchObject({ status: 'warn' });
    const flag = await flagFor(PAGE_DIRECTIVES_RULE_ID);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'robots-ai-access' });
    // The headline is the count; the page and its directive are the inputs the
    // Tower draws as a row.
    expect(flag!.message).toMatch(/^crawler directives closed 1 of \d+ sampled pages$/);
    expect(inputsOf(flag)).toMatchObject({ rule: PAGE_DIRECTIVES_RULE_ID, blocked_urls: [PAGE_A] });
    const flaggedPages = inputsOf(flag).pages as { url: string; blocking: string[] }[];
    expect(flaggedPages.find((p) => p.url === PAGE_A)?.blocking).toContain('noindex');
    // robots.txt is untouched and its own rule stays silent — two levels, two rules.
    expect(await flagCount(ROBOTS_AI_RULE_ID, false)).toBe(0);
  });

  it('flags a page blocked only by an X-Robots-Tag header, which the markup cannot show', async () => {
    await seedCleanPages(daysBefore(TODAY, 1));
    const { fetchImpl } = pageOrigin({
      [PAGE_C]: () =>
        new Response(page(400), {
          status: 200,
          headers: { 'content-type': 'text/html', 'x-robots-tag': 'nosnippet' },
        }),
    });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    const flag = await flagFor(PAGE_DIRECTIVES_RULE_ID);
    const flaggedPages = inputsOf(flag).pages as { url: string; blocking: string[] }[];
    expect(flaggedPages.find((p) => p.url === PAGE_C)?.blocking).toContain('nosnippet');
    const pages = detailOf(await readingFor('robots-ai-access')).pages as { url: string; sources: string[] }[];
    expect(pages.find((p) => p.url === PAGE_C)).toMatchObject({ sources: ['x-robots-tag'] });
  });

  it('holds the flag while the block stands and retracts it only on proof the page is clean', async () => {
    await seedCleanPages(daysBefore(TODAY, 1));
    const blocked = pageOrigin({ [PAGE_A]: () => noindexPage() }).fetchImpl;
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl: blocked, nowMs: NOW });
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, true)).toBe(1);

    // Night two: the page is unreadable. UNKNOWN is not clean — the flag stands.
    const second = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: pageOrigin({ [PAGE_A]: () => status(500) }).fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(second.refreshed).toBe(1);
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, true)).toBe(1);
    // Still named, and tonight's reading of it is unread: the Tower draws that
    // page's row as not re-checked.
    const held = inputsOf(await flagFor(PAGE_DIRECTIVES_RULE_ID));
    expect(held.blocked_urls).toEqual([PAGE_A]);
    expect((held.pages as { url: string; read: boolean }[]).find((p) => p.url === PAGE_A)?.read).not.toBe(true);

    // Night three: the directive is gone and the page reads clean.
    const third = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: pageOrigin().fetchImpl,
      nowMs: NOW + 2 * DAY_MS,
    });
    expect(third.resolved).toBe(1);
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, true)).toBe(0);
  });

  it('never retracts on a night it sampled nothing', async () => {
    await seedCleanPages(daysBefore(TODAY, 1));
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: pageOrigin({ [PAGE_A]: () => noindexPage() }).fetchImpl,
      nowMs: NOW,
    });
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, true)).toBe(1);

    // No sitemap tonight, so no roster: "we did not measure it" is never grounds
    // for withdrawing an alert we already made.
    const blind = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: pageOrigin({ [SITEMAP]: () => status(404) }).fetchImpl,
      nowMs: NOW + DAY_MS,
    });
    expect(detailOf(await readingFor('robots-ai-access', TOMORROW))).toMatchObject({
      pages_sampled: 0,
      pages_source: 'none',
    });
    expect(blind.resolved).toBe(0);
    expect(await flagCount(PAGE_DIRECTIVES_RULE_ID, true)).toBe(1);
  });

  it('spends a bounded number of requests no matter how big the sitemap is', async () => {
    const { fetchImpl, calls } = origin(); // 120-URL sitemap, none of them routed
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    expect(calls.filter((call) => call.url.includes('/p/'))).toHaveLength(3);
    // robots.txt + home + sitemap + three sampled pages, and nothing else.
    expect(calls).toHaveLength(6);
    expect(detailOf(await readingFor('robots-ai-access'))).toMatchObject({
      pages_sampled: 3,
      pages_available: 120,
    });
  });

  it('reads pages the same way through a sitemap index', async () => {
    const child = `https://${DOMAIN}/sitemap-1.xml`;
    const { fetchImpl } = pageOrigin({
      [SITEMAP]: () =>
        xml(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`),
      [child]: () => xml(urlsetOf(SAMPLE)),
      [PAGE_B]: () => noindexPage(),
    });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    const detail = detailOf(await readingFor('robots-ai-access'));
    expect(detail).toMatchObject({ pages_sampled: 3, pages_available: 3 });
    const pages = detail.pages as { url: string; blocking: string[] }[];
    expect(pages.find((p) => p.url === PAGE_B)!.blocking).toEqual(['noindex']);
  });
});

// --- sitemap ----------------------------------------------------------------

describe('hygiene: sitemap', () => {
  it('resolves the sitemap from robots.txt and counts its URLs', async () => {
    const declared = `https://${DOMAIN}/sitemap-index.xml`;
    const { fetchImpl } = origin({
      [ROBOTS]: () => plain(`User-agent: *\nAllow: /\nSitemap: ${declared}\n`),
      [declared]: () => xml(urlset(42)),
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);
    expect(await readingFor('sitemap')).toMatchObject({ status: 'ok', value_num: 42 });
    expect(detailOf(await readingFor('sitemap'))).toMatchObject({ url: declared, source: 'robots.txt' });
  });

  it('falls back to /sitemap.xml when robots declares none', async () => {
    const { fetchImpl } = origin({ [ROBOTS]: () => plain('User-agent: *\nAllow: /\n') });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(detailOf(await readingFor('sitemap'))).toMatchObject({ url: SITEMAP, source: 'convention' });
  });

  it('flags a URL-count collapse against the last healthy reading', async () => {
    await seedReading('sitemap', daysBefore(TODAY, 1), 'ok', 4000);
    const { fetchImpl } = origin({ [SITEMAP]: () => xml(urlset(40)) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);

    const flag = await flagFor(SITEMAP_RULE_ID);
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'sitemap' });
    expect(inputsOf(flag)).toMatchObject({ previous_urls: 4000, reason: 'count-collapse' });
    expect(await readingFor('sitemap')).toMatchObject({ status: 'warn', value_num: 40 });
  });

  it('leaves small sitemaps out of the collapse rule entirely', async () => {
    await seedReading('sitemap', daysBefore(TODAY, 1), 'ok', 20);
    const { fetchImpl } = origin({ [SITEMAP]: () => xml(urlset(5)) });

    expect((await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW })).fired).toBe(0);
    expect(await readingFor('sitemap')).toMatchObject({ status: 'ok', value_num: 5 });
  });

  it('flags an unreachable sitemap', async () => {
    const { fetchImpl } = origin({ [SITEMAP]: () => status(404) });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);
    expect(inputsOf(await flagFor(SITEMAP_RULE_ID))).toMatchObject({ reason: 'unreachable' });
    expect(await readingFor('sitemap')).toMatchObject({ status: 'error', value_num: null });
  });

  it('flags an origin that answers /sitemap.xml with an HTML page', async () => {
    const { fetchImpl } = origin({ [SITEMAP]: () => html('<html><body>Page not found</body></html>') });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);
    expect(inputsOf(await flagFor(SITEMAP_RULE_ID))).toMatchObject({ reason: 'unparseable' });
  });

  it('follows one level of sitemapindex and sums its children', async () => {
    const childA = `https://${DOMAIN}/sitemap-1.xml`;
    const childB = `https://${DOMAIN}/sitemap-2.xml`;
    const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>${childA}</loc></sitemap><sitemap><loc>${childB}</loc></sitemap></sitemapindex>`;
    const { fetchImpl } = origin({
      [SITEMAP]: () => xml(index),
      [childA]: () => xml(urlset(30)),
      [childB]: () => xml(urlset(12)),
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);
    expect(await readingFor('sitemap')).toMatchObject({ status: 'ok', value_num: 42 });
    expect(detailOf(await readingFor('sitemap'))).toMatchObject({
      root: 'sitemapindex',
      children_found: 2,
      children_fetched: 2,
      children_capped: false,
    });
  });

  it('stores no count when a child sitemap cannot be read, and flags that instead', async () => {
    const childA = `https://${DOMAIN}/sitemap-1.xml`;
    const childB = `https://${DOMAIN}/sitemap-2.xml`;
    const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>${childA}</loc></sitemap><sitemap><loc>${childB}</loc></sitemap></sitemapindex>`;
    const { fetchImpl } = origin({
      [SITEMAP]: () => xml(index),
      [childA]: () => xml(urlset(30)),
      [childB]: () => status(500),
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(1);
    // 30 would be an undercount, and an undercount is the exact shape of the
    // collapse this check flags on — so no number is stored.
    expect(await readingFor('sitemap')).toMatchObject({ status: 'error', value_num: null });
    expect(inputsOf(await flagFor(SITEMAP_RULE_ID))).toMatchObject({
      reason: 'child-unreachable',
      children_failed: [childB],
    });
  });

  it('records a gzipped sitemap as an unsupported reading without accusing the property', async () => {
    const gz = `https://${DOMAIN}/sitemap.xml.gz`;
    const { fetchImpl } = origin({
      [ROBOTS]: () => plain(`User-agent: *\nAllow: /\nSitemap: ${gz}\n`),
      [gz]: () => new Response(' binary', { status: 200, headers: { 'content-type': 'application/gzip' } }),
    });

    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(result.fired).toBe(0);
    expect(await readingFor('sitemap')).toMatchObject({ status: 'error', value_num: null });
    expect(detailOf(await readingFor('sitemap'))).toMatchObject({ reason: 'unsupported-encoding' });
  });
});

// --- the sweep --------------------------------------------------------------

describe('hygiene sweep', () => {
  it('identifies itself honestly and impersonates no crawler', async () => {
    const { fetchImpl, calls } = origin();
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.userAgent).toBe(HYGIENE_USER_AGENT);
      expect(call.userAgent).not.toMatch(/GPTBot|ClaudeBot|Googlebot|bingbot|PerplexityBot/i);
    }
  });

  it('fetches robots.txt once and shares it between the two checks that need it', async () => {
    const { fetchImpl, calls } = origin();
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(calls.filter((call) => call.url === ROBOTS)).toHaveLength(1);
  });

  it('keeps one property total failure from stopping the sweep', async () => {
    const good: HygieneAsset = { asset: 'northwind.example', domain: 'northwind.example' };
    const { fetchImpl } = stubOrigin({
      // meadow.example is routed nowhere at all: every request throws.
      'https://northwind.example/': () => html(page(600)),
      'https://northwind.example/robots.txt': () => plain('User-agent: *\nAllow: /\n'),
      'https://northwind.example/sitemap.xml': () => xml(urlset(80, 'northwind.example')),
      // The sampled pages are routed too, so this property is genuinely healthy
      // on all four checks. Left unrouted, page-structure would read nothing and
      // report 'unreachable' — correct, but it would make this test about the
      // fixture's gap rather than about the sweep surviving a dead origin.
      ...pageRoutes(80, 'northwind.example'),
    });

    const result = await runHygieneChecks(env, {
      assets: [ASSETS[0]!, good],
      fetchImpl,
      nowMs: NOW,
    });

    // All six checks ran, and a dead origin produced readings, not exceptions.
    // Two properties swept; the second is not lost to the first's failure.
    expect(result.checks).toBe(2 * HYGIENE_CHECKS.length);
    expect(result.failed).toEqual([]);
    expect(await readingFor('html-depth')).toMatchObject({ status: 'unreachable' });

    expect(await readingCount(`asset_id = 'northwind.example' AND status = 'ok'`)).toBe(HYGIENE_CHECKS.length);
  });

  it('keeps one reading per check per day when the sweep re-runs', async () => {
    const first = await runHygieneChecks(env, { assets: ASSETS, fetchImpl: origin().fetchImpl, nowMs: NOW });
    expect(first.checks).toBe(HYGIENE_CHECKS.length);
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: origin({ [SITEMAP]: () => xml(urlset(121)) }).fetchImpl,
      nowMs: NOW + 3_600_000,
    });

    expect(await readingCount(`asset_id = 'meadow.example'`)).toBe(HYGIENE_CHECKS.length);
    // The re-run replaces the day's reading rather than adding a second one.
    expect(await readingFor('sitemap')).toMatchObject({ value_num: 121 });
  });

  it('sweeps every domain-bearing property except asset #0 and retired ones', async () => {
    await changeSites(['acorn.example'], { status: 'retired' });
    try {
      const { fetchImpl, calls } = stubOrigin({});
      const result = await runHygieneChecks(env, { fetchImpl, nowMs: NOW });

      const swept = [...new Set(result.outcomes.map((outcome) => outcome.asset))].sort();
      // puffin.example is swept alongside pebble.example: the old domain stays
      // live to watch the redirect handoff, so both are domain-bearing.
      expect(swept).toEqual([
        'ferns.example',
        'meadow.example',
        'northwind.example',
        'pebble.example',
        'puffin.example',
      ]);
      expect(calls.some((call) => call.url.includes('os.example'))).toBe(false);
    } finally {
      await changeSites(['acorn.example'], { status: 'onboarding' });
    }
  });
});

// --- page structure ---------------------------------------------------------

describe('page structure parsing', () => {
  const URL = `https://${DOMAIN}/p/0`;

  it('reads a clean page as clean', () => {
    const parsed = parsePageStructure(cleanPage(URL), URL);
    expect(parsed).toMatchObject({
      title: 'Clean page',
      description: 'A description that exists.',
      h1Count: 1,
      canonicalElsewhere: false,
    });
    expect(structureFaults(parsed)).toEqual([]);
  });

  /** Every fault the parser can name has a page that breaks exactly that rule
   * and nothing else; a fault added without a fixture fails here. */
  it('fires exactly the one fault each fixture page breaks', () => {
    for (const fixture of STRUCTURAL_FIXTURES) {
      const faults = structureFaults(parsePageStructure(fixture.html(URL), URL));
      expect(faults).toEqual([fixture.fault]);
    }
  });

  it('covers every fault the parser can produce with a fixture', () => {
    const covered = new Set(STRUCTURAL_FIXTURES.map((fixture) => fixture.fault));
    expect([...covered].sort()).toEqual([
      'canonical-elsewhere',
      'multiple-h1',
      'no-h1',
      'no-meta-description',
      'no-title',
    ]);
  });

  it('does not read an absent canonical as a canonical elsewhere', () => {
    // No canonical at all is not a fault this check names: plenty of perfectly
    // good pages ship without one, and Google self-canonicalises. Only a
    // canonical that actively DISCLAIMS the page is evidence.
    const html = cleanPage(URL).replace(`<link rel="canonical" href="${URL}">`, '');
    const parsed = parsePageStructure(html, URL);
    expect(parsed.canonical).toBeNull();
    expect(structureFaults(parsed)).toEqual([]);
  });
});

describe('sameCanonicalTarget', () => {
  const URL = `https://${DOMAIN}/recipes/`;

  it('accepts the spellings that mean the same document', () => {
    for (const canonical of [
      `https://${DOMAIN}/recipes/`,
      `https://${DOMAIN}/recipes`,
      `https://${DOMAIN.toUpperCase()}/recipes/`,
      '/recipes/',
      `https://${DOMAIN}/recipes/#ingredients`,
    ]) {
      expect(sameCanonicalTarget(URL, canonical)).toBe(true);
    }
  });

  it('rejects a canonical that names another document', () => {
    for (const canonical of [
      `https://${DOMAIN}/other`,
      `https://other.example/recipes/`,
      `http://${DOMAIN}/recipes/`,
      `https://${DOMAIN}/recipes/?page=2`,
    ]) {
      expect(sameCanonicalTarget(URL, canonical)).toBe(false);
    }
  });

  it('treats query order as noise but query CONTENT as meaning', () => {
    expect(
      sameCanonicalTarget(`https://${DOMAIN}/x?b=2&a=1`, `https://${DOMAIN}/x?a=1&b=2`),
    ).toBe(true);
    expect(
      sameCanonicalTarget(`https://${DOMAIN}/x?a=1`, `https://${DOMAIN}/x?a=2`),
    ).toBe(false);
  });

  it('stays silent on a canonical it cannot parse at all', () => {
    // A canonical the URL parser THROWS on is not evidence the page is
    // disclaimed; it is evidence we could not tell, and accusing on a string we
    // did not understand is the one outcome that must not happen.
    expect(sameCanonicalTarget(URL, 'http://[')).toBe(true);
  });

  it('still calls a nonsense RELATIVE canonical a disclaimer', () => {
    // Different from the case above, and deliberately so: `:::not a url:::`
    // parses fine as a relative path, so the page really is pointing at another
    // (nonexistent) document. That is a fault worth naming, not an ambiguity.
    expect(sameCanonicalTarget(URL, ':::not a url:::')).toBe(false);
  });
});

describe('hygiene: page-structure', () => {
  /** A property whose sitemap names `count` pages, each served by `body`. */
  function structuralOrigin(
    pages: Record<string, string>,
  ): { fetchImpl: typeof fetch } {
    const routes: Record<string, () => Response> = {
      [HOME]: () => html(page(800)),
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () =>
        xml(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            Object.keys(pages)
              .map((url) => `<url><loc>${url}</loc></url>`)
              .join('') +
            `</urlset>`,
        ),
      ...BEACON_UP,
    };
    for (const [url, body] of Object.entries(pages)) routes[url] = () => html(body);
    return stubOrigin(routes);
  }

  const P = (n: number) => `https://${DOMAIN}/p/${n}`;

  it('reads the pages the directive check already fetched, and fetches nothing more', async () => {
    const pages = Object.fromEntries(
      [0, 1, 2].map((n) => [P(n), cleanPage(P(n))]),
    );
    const { fetchImpl, calls } = stubOrigin({
      [HOME]: () => html(page(800)),
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () =>
        xml(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            [0, 1, 2].map((n) => `<url><loc>${P(n)}</loc></url>`).join('') +
            `</urlset>`,
        ),
      ...Object.fromEntries(
        Object.entries(pages).map(([url, body]) => [url, () => html(body)]),
      ),
      ...BEACON_UP,
    });

    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    // Each sampled page is fetched EXACTLY ONCE across both checks. A served
    // page is one document; reading it twice would double the property's
    // nightly requests to learn nothing, and the two answers could disagree
    // about a page that changed between them.
    for (const url of Object.keys(pages)) {
      expect(calls.filter((call) => call.url === url)).toHaveLength(1);
    }
  });

  it('records a clean sample as ok, with the pages it actually read', async () => {
    const pages = Object.fromEntries([0, 1, 2].map((n) => [P(n), cleanPage(P(n))]));
    const { fetchImpl } = structuralOrigin(pages);
    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    const reading = await readingFor('page-structure');
    expect(reading).toMatchObject({ status: 'ok', value_num: 3 });
    expect(result.fired).toBe(0);
  });

  /**
   * The discipline every S5 guard is held to: only TRANSITIONS fire. A page
   * that has always shipped without a meta description is a standing editorial
   * decision; a page that had one last night and does not tonight is a
   * regression somebody shipped today. This is also what stops the check from
   * opening a flag on every page of every property the night it lands.
   */
  it('does not flag a fault that was there on the first reading', async () => {
    const broken = STRUCTURAL_FIXTURES[0]!;
    const pages = Object.fromEntries(
      [0, 1, 2].map((n) => [P(n), n === 0 ? broken.html(P(n)) : cleanPage(P(n))]),
    );
    const { fetchImpl } = structuralOrigin(pages);
    const result = await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });

    expect(result.fired).toBe(0);
    expect(await readingFor('page-structure')).toMatchObject({ status: 'ok' });
  });

  it('flags a page that was clean last night and is not tonight', async () => {
    const clean = Object.fromEntries([0, 1, 2].map((n) => [P(n), cleanPage(P(n))]));
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: structuralOrigin(clean).fetchImpl,
      nowMs: NOW,
    });

    const broken = {
      ...clean,
      [P(0)]: STRUCTURAL_FIXTURES.at(-1)!.html(P(0)),
    };
    const result = await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: structuralOrigin(broken).fetchImpl,
      nowMs: NOW + DAY_MS,
    });

    expect(result.fired).toBe(1);
    const [flag] = await flagRows(`asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL`, [
      DOMAIN,
      PAGE_STRUCTURE_RULE_ID,
    ]);
    // The headline is the count; the page and its faults are the inputs the
    // Tower draws as a row.
    expect(flag?.message).toMatch(/^page structure regressed on 1 of \d+ sampled pages$/);
    const inputs = JSON.parse(flag!.rule_inputs!) as { faulty_urls: string[]; pages: { url: string; faults?: string[] }[] };
    expect(inputs.faulty_urls).toEqual([P(0)]);
    expect(inputs.pages.find((p) => p.url === P(0))?.faults).toContain('canonical-elsewhere');
  });

  const openStructureFlags = () =>
    pgCount(
      `SELECT count(*) AS n FROM noticeos.current_flags
        WHERE asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL`,
      [DOMAIN, PAGE_STRUCTURE_RULE_ID],
    );

  it('retracts only on proof the page reads clean again', async () => {
    const clean = Object.fromEntries([0, 1, 2].map((n) => [P(n), cleanPage(P(n))]));
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: structuralOrigin(clean).fetchImpl,
      nowMs: NOW,
    });
    const broken = { ...clean, [P(0)]: STRUCTURAL_FIXTURES[0]!.html(P(0)) };
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: structuralOrigin(broken).fetchImpl,
      nowMs: NOW + DAY_MS,
    });

    // Night three: the page 500s. NOT re-reading it is "we did not measure it",
    // which is never grounds for withdrawing an alert we made.
    const unreadable = structuralOrigin(clean);
    const withDeadPage = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url === P(0)) return status(500);
      return unreadable.fetchImpl(input as RequestInfo, init);
    }) as typeof fetch;
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: withDeadPage,
      nowMs: NOW + 2 * DAY_MS,
    });
    expect(await openStructureFlags()).toBe(1);

    // Night four: it reads clean. Now the flag goes.
    await runHygieneChecks(env, {
      assets: ASSETS,
      fetchImpl: structuralOrigin(clean).fetchImpl,
      nowMs: NOW + 3 * DAY_MS,
    });
    expect(await openStructureFlags()).toBe(0);
  });

  it('reports a sample it could not read as unreachable, never as ok', async () => {
    // An empty sitemap leaves no roster. A check that measured nothing has not
    // found nothing wrong.
    const { fetchImpl } = stubOrigin({
      [HOME]: () => html(page(800)),
      [ROBOTS]: () => plain(PERMISSIVE_ROBOTS),
      [SITEMAP]: () => xml(urlset(0)),
      ...BEACON_UP,
    });
    await runHygieneChecks(env, { assets: ASSETS, fetchImpl, nowMs: NOW });
    expect(await readingFor('page-structure')).toMatchObject({
      status: 'unreachable',
      value_num: 0,
    });
  });
});
