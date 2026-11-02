import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { ASSET_TOKENS } from './fixtures.js';
import { call, pgCount, pgRows, reset } from './helpers.js';

const ASSET = 'meadow.example';
const tools = { image: `example.com/measure@sha256:${'a'.repeat(64)}`, profile: 'b'.repeat(64), scc: '3', jscpd: '5', lizard: '1' };
const report = (date: string, lines: number) => ({ asset: ASSET, generatedAt: `${date}T12:00:00Z`, repository: { commit: 'a'.repeat(40), ref: 'main', committedAt: `${date}T10:00:00Z` }, tools, measures: { code_lines: lines, duplication_percent: 10 } });
const history = () => ({ version: 1, asset: ASSET, reports: [{ ...report('2026-10-01', 1000), generatedAt: '2026-11-02T00:00:00Z', history: { effectiveAt: '2026-10-01T23:59:59Z', selectionRef: 'main' } }],
  releases: [{ source: 'releases.jsonl', sequence: 0, id: 'c'.repeat(64), commit: 'a'.repeat(40), recordedAt: '2026-10-01T13:00:00Z', supersedes: [] }] });
const request = (body: unknown, route = '/api/codebase-history', token = ASSET_TOKENS[ASSET]) => new Request(`https://ingest.local${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
beforeEach(reset);

it('previews without writes, imports once, resumes without duplicates and preserves current reports and flags', async () => {
  expect((await call(request(report('2026-11-01', 10000), '/api/codebase-report'))).status).toBe(201);
  const flags = await pgRows(`SELECT flag_number, resolved_at FROM noticeos.flags ORDER BY flag_number`);
  const preview = await call(request(history()));
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ reports: 1, releases: 1, preview: true, alertsChanged: 0 });
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports`)).toBe(1);
  const apply = await call(request(history(), '/api/codebase-history?apply=true'));
  expect(apply.status).toBe(201);
  expect(await apply.json()).toMatchObject({ reports: 1, releases: 1, preview: false, alertsChanged: 0 });
  expect(await (await call(request(history(), '/api/codebase-history?apply=true'))).json()).toMatchObject({ reports: 0, releases: 0, skippedReports: 1, skippedReleases: 1 });
  expect(await pgRows(`SELECT flag_number, resolved_at FROM noticeos.flags ORDER BY flag_number`)).toEqual(flags);
  const rows = await pgRows<{ report_date: string; generated: string; received: string }>(`SELECT report_date::text, generated_at::text AS generated, received_at::text AS received FROM noticeos.current_codebase_reports ORDER BY report_date`);
  expect(rows.map(row => row.report_date)).toEqual(['2026-10-01', '2026-11-01']);
  expect(rows[0]!.generated).toContain('2026-11-02');
  expect(rows[0]!.received).not.toBe(rows[0]!.generated);
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.annotations`)).toBe(1);
  // A later normal report can now use the imported comparison; importing did
  // not replay the old conditions as current alerts.
  expect((await call(request(report('2026-11-01', 11000), '/api/codebase-report'))).status).toBe(201);
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE rule_id = 'codebase-growth'`)).toBe(1);
});

it('rejects foreign assets, unpinned tools, history sent through the normal writer, and dates newer than the current report', async () => {
  expect((await call(request(history(), '/api/codebase-history', 'wrong'))).status).toBe(401);
  expect((await call(request({ ...history(), asset: 'northwind.example' }))).status).toBe(401);
  const mixed = history(); mixed.reports[0]!.asset = 'northwind.example';
  expect((await call(request(mixed))).status).toBe(422);
  const unpinned = history(); unpinned.reports[0]!.tools = { ...tools, image: 'example.com/measure:main' };
  expect((await call(request(unpinned))).status).toBe(422);
  expect((await call(request(history().reports[0], '/api/codebase-report'))).status).toBe(422);
  expect((await call(request(history(), '/api/codebase-history?apply=true'))).status).toBe(422);
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports`)).toBe(0);
  await call(request(report('2026-09-01', 50), '/api/codebase-report'));
  expect((await call(request(history(), '/api/codebase-history?apply=true'))).status).toBe(422);
  expect(await env.STORE.read(tx => tx.query(`SELECT 1 FROM noticeos.annotations`))).toEqual([]);
});

it('rolls back a whole refused batch and skips existing days without appending another revision', async () => {
  await call(request(report('2026-11-01', 10000), '/api/codebase-report'));
  await call(request(report('2026-10-01', 500), '/api/codebase-report'));
  expect(await (await call(request(history(), '/api/codebase-history?apply=true'))).json()).toMatchObject({ skippedReports: 1 });
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports WHERE report_date = '2026-10-01'`)).toBe(1);
  const bundle = history();
  bundle.reports[0]!.history.effectiveAt = '2026-10-02T23:59:59Z';
  bundle.releases[0]!.recordedAt = '2099-01-01T00:00:00Z';
  expect((await call(request(bundle, '/api/codebase-history?apply=true'))).status).toBe(422);
  expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports WHERE report_date = '2026-10-02'`)).toBe(0);
});
