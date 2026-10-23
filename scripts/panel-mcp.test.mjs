import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { INTEGRATION_MONITORS } from '../packages/contract/src/integration-health.ts';
import { createHostedMcp } from './hosted-mcp.mjs';
import { PANEL_MCP_TOOL_NAMES } from './panel-mcp.mjs';
import { PanelQueryError, queryPanel } from './panel-query.mjs';
import { createPanelStore, panelTableName } from './panel-store.mjs';
import { PANEL_VERSION_KEEP_DAYS, panelVersionId, panelVersionTime, retainPanelVersions } from './panel-versions.mjs';
import { analyzeSignalHistory } from './signal-history-analyze.mjs';
import { ARCHIVE_MONITORS, familyCollection, freshnessReport, refreshAsset } from './signal-panels-refresh.mjs';
import { openStandaloneMcp } from './standalone-mcp.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// Site panels for agents: versions kept and gzipped (panel-versions.mts), each
// report family's collection recorded at publication (signal-panels-refresh),
// read at read time (panel-store.mts), queried in a bounded child
// (panel-query.mts) and served as MCP tools (panel-mcp.mts). Synthetic
// panels and a stubbed health read only.

const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6';
const ASSET = 'example.com';
const LATEST = '00000003-2026-10-12T13-10-04-637Z-4f83dc';
const OLDER = '00000002-2026-10-11T13-10-04-637Z-aaaaaa';
const VITALS = 'asset,report_date,device,os,path,inp_p75,measurements\n'
  + 'example.com,2026-10-11,Desktop,Chrome OS,/calculator,1000,50\nexample.com,2026-10-11,Desktop,Windows,/calculator,200,80\n';
const healthy = { state: 'healthy', reportDate: null, failure: null, code: null, lastSuccessAt: '2026-10-12T12:31:00.000Z', failing: [] };

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A published panel with two versions: LATEST (linked) and OLDER. */
async function panelRoot(t, { freshness } = {}) {
  const root = await tempRoot(t, 'noticeos-panel-');
  for (const version of [LATEST, OLDER]) {
    const folder = path.join(root, `${ASSET}.reports`, version);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'posthog-web-vitals.csv'), VITALS);
    await fs.writeFile(path.join(folder, 'signal-trend-daily.csv'), 'date,integration,metric,value,provisional\n2026-10-11,gsc,clicks,12,1\n');
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify({ format: 'noticeos-signal-report/2', asset: ASSET, generation: Number(version.slice(0, 8)),
      analyzedAt: panelVersionTime(version), files: [{ name: 'posthog-web-vitals.csv', bytes: Buffer.byteLength(VITALS), sha256: createHash('sha256').update(VITALS).digest('hex') }] }));
    await fs.writeFile(path.join(folder, 'summary.json'), JSON.stringify({ datasets: [{ name: 'posthog-web-vitals', rows: 2 }], archives: Array.from({ length: 3000 }, (_, index) => ({ index, file: `gsc/query/${index}.json` })) }));
    await fs.writeFile(path.join(folder, 'freshness.json'), JSON.stringify(freshness ?? {
      asset: ASSET, collection: { readAt: '2026-10-12T13:09:00.000Z', available: true },
      families: [
        { family: 'posthog-web-vitals', integration: 'posthog', report: 'web-vitals', newestReportDate: '2026-10-11', archives: 3, role: 'collected', collection: healthy },
        { family: 'posthog-exceptions', integration: 'posthog', report: 'exceptions', newestReportDate: null, archives: 0, role: 'collected',
          collection: { ...healthy, state: 'failing', reportDate: '2026-10-12', failure: 'provider', code: 'provider', lastSuccessAt: null,
            failing: [{ reportDate: '2026-10-12', failure: 'provider', code: 'provider' }] } },
        { family: 'gsc-query', integration: 'gsc', report: 'query', newestReportDate: '2026-10-11', archives: 4, role: 'collected',
          collection: { ...healthy, failing: [{ reportDate: '2026-10-09', failure: 'network', code: 'network' }] } },
        { family: 'bing-webmaster-ai-queries', integration: 'bing-webmaster', report: 'ai-queries', newestReportDate: '2026-09-01', archives: 1, role: 'imported', collection: null },
      ] }));
  }
  await fs.symlink(path.join(`${ASSET}.reports`, LATEST), path.join(root, ASSET));
  return root;
}

/** The standalone endpoint over `root`, and a tools/call helper. */
async function endpoint(root) {
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => {} }, receipts: memoryReceipts(Date.now),
    projects: async () => [], run: async () => ({ code: 0, stdout: '{}' }), panelRoot: root, fetch: async () => Response.json({}) });
  const rpc = async (method, params) => (await (await mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json());
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name, arguments: { workspace: WORKSPACE, ...args } });
    return reply.result.isError ? { error: reply.result.content[0].text } : reply.result.structuredContent;
  };
  return { mcp, rpc, call };
}

test('a version is named for its generation and analysis time, and that time reads back from the name', () => {
  const id = panelVersionId(11, '2026-10-13T13:10:04.637Z');
  assert.match(id, /^00000011-2026-10-13T13-10-04-637Z-[0-9a-f]{6}$/u);
  assert.equal(panelVersionTime(id), '2026-10-13T13:10:04.637Z');
  assert.equal(panelVersionTime('00000011-not-a-time'), null);
});

test('kept versions: the current and previous stay as written, younger ones are gzipped, older ones and leftovers go', async (t) => {
  const reports = await tempRoot(t, 'noticeos-panel-versions-');
  const now = '2026-10-20T13:10:00.000Z';
  const at = (days) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
  const names = { current: panelVersionId(9, now), previous: panelVersionId(8, at(1)), young: panelVersionId(5, at(4)),
    edge: panelVersionId(3, at(PANEL_VERSION_KEEP_DAYS - 0.5)), old: panelVersionId(1, at(PANEL_VERSION_KEEP_DAYS + 1)), legacy: '00000007-legacy' };
  for (const name of Object.values(names)) {
    await fs.mkdir(path.join(reports, name));
    await fs.writeFile(path.join(reports, name, 'gsc-query.csv'), `query,clicks\n${name},1\n`);
    await fs.writeFile(path.join(reports, name, 'summary.json'), '{}');
  }
  await fs.writeFile(path.join(reports, names.young, 'gsc-page.csv.gz.123-abcd.tmp'), 'partial');
  await fs.mkdir(path.join(reports, 'not-a-version'));

  const result = await retainPanelVersions(reports, { current: names.current, previous: names.previous, now });
  assert.deepEqual(result.removed.sort(), [names.legacy, names.old].sort());
  assert.deepEqual(result.compressed.sort(), [names.edge, names.young].sort());
  assert.deepEqual((await fs.readdir(reports)).sort(), [names.current, names.previous, names.young, names.edge, 'not-a-version'].sort());
  for (const name of [names.current, names.previous]) assert.deepEqual((await fs.readdir(path.join(reports, name))).sort(), ['gsc-query.csv', 'summary.json']);
  assert.deepEqual((await fs.readdir(path.join(reports, names.young))).sort(), ['gsc-query.csv.gz', 'summary.json']);
  assert.equal(gunzipSync(await fs.readFile(path.join(reports, names.young, 'gsc-query.csv.gz'))).toString(), `query,clicks\n${names.young},1\n`);
  // A second pass changes nothing.
  assert.deepEqual(await retainPanelVersions(reports, { current: names.current, previous: names.previous, now }), { removed: [], compressed: [] });
});

test('each family\'s collection is the state of its newest report day, with its failing days, and the monitor table matches the contract', () => {
  const monitors = Object.fromEntries(Object.values(INTEGRATION_MONITORS).flat()
    .filter((monitor) => monitor.evidence === 'signal_dump_runs' && monitor.scope === 'family').map((monitor) => [monitor.id, monitor.lanes[0]]));
  assert.deepEqual(ARCHIVE_MONITORS, monitors);

  const item = (fields) => ({ provider: 'x', capability: 'gsc-archive', asset: ASSET, report: 'query', reportDate: null, state: 'healthy',
    lastSuccessAt: null, failure: null, code: null, ...fields });
  const families = familyCollection(ASSET, [
    item({ reportDate: '2026-10-10', lastSuccessAt: '2026-10-11T12:15:00.000Z' }),
    item({ reportDate: '2026-10-12', state: 'failing', failure: 'network', code: 'network' }),
    item({ reportDate: '2026-10-11', state: 'healthy', lastSuccessAt: '2026-10-12T12:15:00.000Z' }),
    item({ capability: 'bing-archive', report: 'pages', state: 'never-run' }),
    item({ capability: 'bing-archive', report: 'pages', state: 'healthy', lastSuccessAt: '2026-10-12T12:15:00.000Z' }),
    item({ asset: 'other.example' }),
    item({ capability: 'ga4-realtime', report: null }),
  ]);
  assert.deepEqual([...families.keys()].sort(), ['bing-webmaster/pages', 'gsc/query']);
  assert.deepEqual(families.get('gsc/query'), { state: 'failing', reportDate: '2026-10-12', failure: 'network', code: 'network',
    lastSuccessAt: '2026-10-12T12:15:00.000Z', failing: [{ reportDate: '2026-10-12', failure: 'network', code: 'network' }] });
  assert.equal(families.get('bing-webmaster/pages').state, 'healthy', 'the target that collects stands for the family');
});

test('freshness.json lists every family the panel holds or collection expects, imported ones by role, paused absent ones not at all', () => {
  const manifest = [
    { integration: 'gsc', report: 'query', reportDate: '2026-10-10' }, { integration: 'gsc', report: 'query', reportDate: '2026-10-11' },
    { integration: 'bing-webmaster', report: 'ai-queries', reportDate: '2026-09-01' },
  ];
  const items = [
    { capability: 'gsc-archive', asset: ASSET, report: 'query', reportDate: '2026-10-11', state: 'healthy', lastSuccessAt: '2026-10-12T12:15:00.000Z' },
    { capability: 'posthog-archive', asset: ASSET, report: 'exceptions', reportDate: null, state: 'never-run', lastSuccessAt: null },
    { capability: 'clarity-export', asset: ASSET, report: 'url-3d', reportDate: null, state: 'paused', lastSuccessAt: null },
  ];
  const freshness = freshnessReport({ asset: ASSET, manifest, maxAgeDays: 7, refreshedAt: '2026-10-12T13:10:00.000Z',
    collection: { readAt: '2026-10-12T13:09:00.000Z', available: true, items } });
  assert.deepEqual(freshness.collection, { readAt: '2026-10-12T13:09:00.000Z', available: true });
  assert.deepEqual(freshness.families.map(({ family, role, newestReportDate, archives, collection }) => [family, role, newestReportDate, archives, collection?.state ?? null]), [
    ['bing-webmaster-ai-queries', 'imported', '2026-09-01', 1, null],
    ['gsc-query', 'collected', '2026-10-11', 2, 'healthy'],
    ['posthog-exceptions', 'collected', null, 0, 'never-run'],
  ]);
  const unread = freshnessReport({ asset: ASSET, manifest, maxAgeDays: 7, refreshedAt: '2026-10-12T13:10:00.000Z' });
  assert.deepEqual(unread.collection, { readAt: null, available: false });
  assert.ok(unread.families.every((family) => family.collection === null));
});

test('the store resolves the latest or a kept version by name, and never stands one version in for another', async (t) => {
  const root = await panelRoot(t);
  const store = createPanelStore(root);
  assert.deepEqual(await store.sites(), [ASSET]);
  assert.deepEqual(await store.kept(ASSET), [LATEST, OLDER]);
  assert.equal((await store.resolve(ASSET)).version, LATEST);
  assert.equal((await store.resolve(ASSET, OLDER)).version, OLDER);
  await assert.rejects(store.resolve(ASSET, '00000001-2026-09-01T13-10-04-637Z-bbbbbb'), /no longer kept: versions are kept 14 days\. The latest is 00000003/u);
  await assert.rejects(store.resolve(ASSET, '../../etc'), /is not a panel version/u);
  await assert.rejects(store.resolve('nothing.example'), /has no published panel/u);
  await assert.rejects(store.resolve('../x'), /asset must be an asset id/u);
});

test('a version describes its tables and each family\'s age today, and lists only what needs attention', async (t) => {
  const root = await panelRoot(t);
  const store = createPanelStore(root);
  // The older version is stored gzipped; it reads the same.
  const older = path.join(root, `${ASSET}.reports`, OLDER);
  await retainPanelVersions(path.join(root, `${ASSET}.reports`), { current: LATEST, previous: null, now: '2026-10-12T13:10:04.637Z' });
  assert.ok((await fs.readdir(older)).includes('posthog-web-vitals.csv.gz'));

  const panel = await store.describe(await store.resolve(ASSET), '2026-10-13T13:10:04.637Z');
  assert.equal(panel.ageHours, 24);
  assert.equal(panel.generation, 3);
  assert.deepEqual(panel.tables.map(({ table, file, rows, columns }) => [table, file, rows, columns.length]), [
    ['posthog_web_vitals', 'posthog-web-vitals.csv', 2, 7], ['signal_trend_daily', 'signal-trend-daily.csv', null, 5]]);
  assert.match(panel.tables[0].sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(panel.families.map(({ family, table, status, ageDays }) => [family, table, status, ageDays]), [
    ['posthog-web-vitals', 'posthog_web_vitals', 'ok', 2], ['posthog-exceptions', null, 'missing', null],
    ['gsc-query', null, 'ok', 2], ['bing-webmaster-ai-queries', null, 'imported', 42]]);
  assert.deepEqual(panel.attention.map(({ family, status }) => [family, status]), [
    ['posthog-exceptions', 'missing'], ['gsc-query', 'earlier-failures'], ['bing-webmaster-ai-queries', 'imported']]);

  const old = await store.describe(await store.resolve(ASSET, OLDER), '2026-10-15T13:10:04.637Z');
  assert.deepEqual(old.tables.map((table) => [table.file, table.columns[0]]), [['posthog-web-vitals.csv', 'asset'], ['signal-trend-daily.csv', 'date']]);
  assert.deepEqual(old.attention[0], { family: null, status: 'not-latest', detail: `A newer version is published: ${LATEST}.` });

  // A latest version two days old says the refresh has stopped.
  const behind = await store.describe(await store.resolve(ASSET), '2026-10-14T13:10:04.637Z');
  assert.equal(behind.attention[0].status, 'panel-behind');
});

test('a version built before families were recorded reads its families from its sources, unchecked, under one line', async (t) => {
  const root = await panelRoot(t, { freshness: { asset: ASSET, sources: [{ key: 'gsc', integration: 'gsc', reports: [{ report: 'query', newestReportDate: '2026-10-11' }] }],
    uncollected: [{ key: 'bing-webmaster/ai-pages', integration: 'bing-webmaster', report: 'ai-pages', newestReportDate: '2026-08-01' }] } });
  const store = createPanelStore(root);
  const panel = await store.describe(await store.resolve(ASSET), '2026-10-12T20:00:00.000Z');
  assert.deepEqual(panel.families.map(({ family, status }) => [family, status]), [['bing-webmaster-ai-pages', 'imported'], ['gsc-query', 'unchecked']]);
  assert.deepEqual(panel.attention.map(({ family, status }) => [family, status]), [[null, 'unchecked'], ['bing-webmaster-ai-pages', 'imported']]);
});

test('a query runs one SELECT in a bounded child, reads only its version, and says when it cut the result', async (t) => {
  const folder = await tempRoot(t, 'noticeos-panel-query-');
  await fs.writeFile(path.join(folder, 'posthog-web-vitals.csv'), VITALS);
  const tables = [{ table: 'posthog_web_vitals', file: 'posthog-web-vitals.csv' }];
  const run = (sql, extra = {}) => queryPanel({ folder, tables, sql, maxRows: 200, ...extra });

  const result = await run("SELECT os, path, inp_p75, count(*) OVER () AS n FROM posthog_web_vitals WHERE os = 'Chrome OS'");
  assert.deepEqual(result.columns, [{ name: 'os', type: 'VARCHAR' }, { name: 'path', type: 'VARCHAR' }, { name: 'inp_p75', type: 'BIGINT' }, { name: 'n', type: 'BIGINT' }]);
  assert.deepEqual(result.rows, [['Chrome OS', '/calculator', 1000, 1]]);
  assert.equal(result.truncated, false);
  assert.deepEqual((await run('WITH v AS (SELECT * FROM posthog_web_vitals) SELECT count(*) AS n FROM v')).rows, [[2]]);

  assert.equal((await run('SELECT * FROM range(10)', { maxRows: 3 })).truncated, 'rows');
  const wide = await run("SELECT repeat('x', 1000) AS text FROM range(1000)", { maxRows: 2000 });
  assert.equal(wide.truncated, 'bytes');
  assert.ok(wide.rows.length > 0 && wide.rows.length < 1000);

  for (const [sql, refusal] of [
    ['SELECT 1; SELECT 2', /exactly one SELECT statement; this text holds 2/u],
    [`COPY posthog_web_vitals TO '${path.join(folder, 'copy.csv')}'`, /Only a SELECT statement runs here/u],
    ['SET threads = 4', /Only a SELECT statement runs here/u],
    ['INSTALL httpfs', /Only a SELECT statement runs here/u],
    ["SELECT * FROM read_csv('/etc/hosts')", /Permission Error/u],
    ['SELECT nope FROM posthog_web_vitals', /Referenced column "nope" not found/u],
  ]) await assert.rejects(run(sql), (error) => error instanceof PanelQueryError && refusal.test(error.message) && !error.message.includes(folder), sql);
  await assert.rejects(run('SELECT count(*) FROM range(100000000000)', { seconds: 1 }), /ran longer than 1 seconds and was stopped/u);
  assert.deepEqual(await fs.readdir(folder), ['posthog-web-vitals.csv']);
});

test('the endpoint offers the panel tools for evidence reads and answers them from the published panels', async (t) => {
  const root = await panelRoot(t);
  const { rpc, call } = await endpoint(root);
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(initialized.result.instructions, /use get_panel then query_panel, never a provider's API/u);
  const tools = (await rpc('tools/list', {})).result.tools;
  for (const name of PANEL_MCP_TOOL_NAMES) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.ok(tool.inputSchema.required.includes('workspace'), name);
    assert.equal(tool.annotations.readOnlyHint, true, name);
  }
  assert.ok((await call('list_workspaces')).error, 'list_workspaces takes no workspace');
  const workspaces = (await rpc('tools/call', { name: 'list_workspaces', arguments: {} })).result.structuredContent.workspaces;
  assert.ok(workspaces[0].access.includes('evidence:read'));

  const listed = await call('list_panels');
  assert.deepEqual(listed.panels.map(({ asset, latestVersion, families }) => [asset, latestVersion, families]), [[ASSET, LATEST, 4]]);
  const panel = await call('get_panel', { asset: ASSET });
  assert.equal(panel.version, LATEST);
  assert.deepEqual(panel.versions.map(({ version, latest }) => [version, latest]), [[LATEST, true], [OLDER, false]]);
  assert.ok(panel.rules.length > 0);
  assert.equal(panel.tables[0].stored, undefined, 'storage stays inside the store');

  const queried = await call('query_panel', { asset: ASSET, version: OLDER, sql: "SELECT path, inp_p75 FROM posthog_web_vitals WHERE os = 'Chrome OS'" });
  assert.deepEqual([queried.version, queried.latest, queried.rows], [OLDER, false, [['/calculator', 1000]]]);
  assert.match((await call('query_panel', { asset: ASSET, sql: 'SELECT * FROM range(5)', max_rows: 2 })).note, /^Cut at 2 rows/u);
  assert.match((await call('query_panel', { asset: ASSET, sql: 'DROP VIEW posthog_web_vitals' })).error, /Only a SELECT statement runs here/u);
  assert.match((await call('query_panel', { asset: ASSET, sql: 'SELECT 1', max_rows: 5000 })).error, /max_rows must be a whole number from 1 to 2000/u);

  const outline = await call('read_panel_document', { asset: ASSET, document: 'summary' });
  assert.equal(outline.truncated, true);
  assert.deepEqual(outline.outline, { datasets: 'array of 1', archives: 'array of 3000' });
  assert.deepEqual((await call('read_panel_document', { asset: ASSET, document: 'summary', pointer: '/datasets/0' })).value, { name: 'posthog-web-vitals', rows: 2 });
  assert.match((await call('read_panel_document', { asset: ASSET, document: 'summary', pointer: '/nothing' })).error, /No nothing at the top/u);
  assert.match((await call('read_panel_document', { asset: ASSET, document: 'secrets' })).error, /document is one of executive, summary, freshness, report/u);
  assert.match((await call('get_panel', { asset: ASSET, extra: 1 })).error, /unknown extra/u);
  assert.match((await rpc('tools/call', { name: 'get_panel', arguments: { workspace: '0f42e967-bb21-4e9b-9c69-8b082e8491a6', asset: ASSET } })).result.content[0].text,
    /workspace/u, 'another workspace is refused');
});

test('a hosted endpoint asks for evidence reads before a panel tool runs, and refuses a panel configuration it cannot call', async () => {
  const reads = [];
  const handle = createHostedMcp({ profile: 'hosted', trustedOrigin: 'https://noticeos.example',
    operations: { write: async () => ({}) },
    agents: { verify: async () => ({ scopes: ['tasks:read'] }), workspaces: async () => [] },
    panels: { read: async (...args) => { reads.push(args); return {}; } } });
  const response = await handle(new Request('https://noticeos.example/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(32)}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_panels', arguments: { workspace: WORKSPACE } } }) }));
  assert.equal(response.status, 403);
  assert.match(response.headers.get('www-authenticate') ?? '', /insufficient_scope/u);
  assert.deepEqual(reads, []);
  assert.throws(() => createHostedMcp({ profile: 'standalone', trustedOrigin: 'http://localhost', standaloneWorkspaceId: WORKSPACE,
    operations: { write: async () => ({}) }, panels: {} }), /MCP configuration refused/u);
});

test('a refresh publishes a version an agent reads through the endpoint, with each family\'s collection as health stood', async (t) => {
  const root = await tempRoot(t, 'noticeos-panel-refresh-');
  const day = '2026-09-20', now = '2026-09-22T06:00:00.000Z';
  const archive = { schemaVersion: 1, asset: ASSET, integration: 'gsc', report: 'query', reportDate: day, providerRows: 1, providerTruncated: false,
    pages: [{ request: { dimensions: ['query'] }, response: { rows: [{ keys: ['sample query'], clicks: 7, impressions: 100, ctr: 0.07, position: 4 }] } }] };
  const options = { door: 'http://fixture.invalid', downloadsRoot: path.join(root, 'downloads'), historyRoot: path.join(root, 'history'),
    analysisRoot: path.join(root, 'reports'), publish: false };
  const result = await refreshAsset(ASSET, options, {
    token: 'fixture-operator', windowDays: 35, freshnessMaxAgeDays: 7, now: () => now,
    collection: { readAt: now, available: true, items: [
      { capability: 'gsc-archive', asset: ASSET, report: 'query', reportDate: day, state: 'healthy', lastSuccessAt: '2026-09-21T12:15:00.000Z' },
      { capability: 'gsc-archive', asset: ASSET, report: 'page', reportDate: day, state: 'failing', failure: 'access', code: 'forbidden', lastSuccessAt: null }] },
    get: async (url) => new URL(url).pathname === '/api/panel-source'
      ? Response.json({ asset: ASSET, manifest: [{ integration: 'gsc', report: 'query', reportDate: day, objectKey: 'synthetic-query',
        contentSha256: 'a'.repeat(64), providerRows: 1, finishedAt: '2026-09-21T12:15:00.000Z', providerTruncated: 0 }],
        trend: [{ date: day, integration: 'gsc', metric: 'clicks', value: 7, provisional: 0 }] })
      : new Response(JSON.stringify(archive)),
    analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: async () => ({ assets: {} }), now }),
  });
  assert.match(result.version, /^00000001-2026-09-22T06-00-00-000Z-[0-9a-f]{6}$/u);

  const { call } = await endpoint(options.analysisRoot);
  const panel = await call('get_panel', { asset: ASSET });
  assert.equal(panel.version, result.version);
  assert.deepEqual(panel.families.map(({ family, status }) => [family, status]), [['gsc-page', 'missing'], ['gsc-query', 'ok']]);
  assert.match(panel.attention.find((entry) => entry.family === 'gsc-page').detail, /collection is failing/u);
  assert.ok(panel.tables.some((table) => table.table === panelTableName('gsc-query.csv')));
  const queried = await call('query_panel', { asset: ASSET, sql: 'SELECT sum(clicks) AS clicks FROM gsc_query' });
  assert.deepEqual(queried.rows, [[7]]);
  const report = await call('read_panel_document', { asset: ASSET, document: 'report' });
  assert.ok(report.value.files.some((file) => file.name === 'gsc-query.csv' && /^[0-9a-f]{64}$/u.test(file.sha256)));
});

test('a page whose address holds a comma, a quote or a line break reads back whole, after more plain rows than DuckDB samples', async (t) => {
  const root = await tempRoot(t, 'noticeos-panel-quoting-');
  const day = '2026-09-20', now = '2026-09-22T06:00:00.000Z';
  const plain = Array.from({ length: 25_000 }, (_, index) => ({ keys: [`https://example.com/page-${index}`], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }));
  const awkward = ['https://example.com/2,000-calorie-plan', 'https://example.com/say-"cheese"', 'https://example.com/two\nlines'];
  const archive = { schemaVersion: 1, asset: ASSET, integration: 'gsc', report: 'page', reportDate: day, providerRows: plain.length + awkward.length, providerTruncated: false,
    pages: [{ request: { dimensions: ['page'], dimensionFilterGroups: [{ filters: [{ dimension: 'search,"appearance"', operator: 'equals', expression: 'a,"b"' }] }] },
      response: { rows: [...plain, ...awkward.map((page, index) => ({ keys: [page], clicks: 100 + index, impressions: 1000, ctr: 0.1, position: 2 }))] } }] };
  const options = { door: 'http://fixture.invalid', downloadsRoot: path.join(root, 'downloads'), historyRoot: path.join(root, 'history'),
    analysisRoot: path.join(root, 'reports'), publish: false };
  await refreshAsset(ASSET, options, {
    token: 'fixture-operator', windowDays: 35, freshnessMaxAgeDays: 7, now: () => now,
    get: async (url) => new URL(url).pathname === '/api/panel-source'
      ? Response.json({ asset: ASSET, manifest: [{ integration: 'gsc', report: 'page', reportDate: day, objectKey: 'synthetic-page',
        contentSha256: 'a'.repeat(64), providerRows: archive.providerRows, finishedAt: '2026-09-21T12:15:00.000Z', providerTruncated: 0 }], trend: [] })
      : new Response(JSON.stringify(archive)),
    analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: async () => ({ assets: {} }), now }),
  });

  const { call } = await endpoint(options.analysisRoot);
  const counted = await call('query_panel', { asset: ASSET, sql: 'SELECT count(*) AS n FROM gsc_page' });
  assert.deepEqual([counted.error, counted.rows], [undefined, [[plain.length + awkward.length]]]);
  const read = await call('query_panel', { asset: ASSET,
    sql: 'SELECT page, clicks, position, row_grain, "search,""appearance""" AS appearance FROM gsc_page WHERE clicks >= 100 ORDER BY clicks' });
  assert.deepEqual([read.error, read.rows], [undefined, awkward.map((page, index) => [page, 100 + index, 2, 'page', 'a,"b"'])]);
});
