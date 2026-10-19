// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DEFAULT_CODEBASE_RULE_THRESHOLDS, evaluateCodebaseRules, evaluatePulse, pickComparisonReport } from '@noticeos/contract';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { fillDemo } from '../../../scripts/demo-store.mjs';
import { generateDemoDisplay, seedDemoDisplay } from '../../../scripts/demo-display.mjs';
import { createTestStore } from './postgres-store';
import { buildWallPayload } from '../worker/wall-payload';
import { buildAssetDetailPayload } from '../worker/asset-detail-payload';
import { readDashboardConfig } from '../shared/dashboard';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';

type DisplayHelpers = Parameters<typeof seedDemoDisplay>[0]['helpers'];
type Reporter = (capability: unknown, now: number) => Promise<unknown>;
type Observation = { asset: string; capabilities: string[]; metrics: Record<string, { last24h: number; avg7d: number; total: number }> };
type Released = (...input: never[]) => Promise<unknown>;
type ReleasedHelpers = DisplayHelpers & { runAssetZeroPulse: Reporter; writeInsightSnapshot: Released; runHygieneChecks: Released; writeReading: Released;
  provenance: { artifacts: Record<string, string> } };
type SeedStep<T> = (capability: unknown, scenario: ReturnType<typeof generateDemoScenario>, ...released: Released[]) => Promise<T>;

let home: string | undefined;
let installation: string;
let fixture: Awaited<ReturnType<typeof createTestStore>> | undefined;
let helpers: ReleasedHelpers;
let capability: unknown;
let recordDemoOsObservation: (capability: unknown, scenario: ReturnType<typeof generateDemoScenario>, reporter: Reporter) => Promise<Observation>;
let recordDemoSearchReports: SeedStep<{ reports: number }>;
let recordDemoSiteChecks: SeedStep<{ checks: number; fired: number; pageSpeed: number }>;
const scenario = generateDemoScenario({ seed: 'display-store', cutoff: '2026-10-01T07:00:00.000Z', release: 'a'.repeat(40) });

// Compilation and the relational seed are integration-fixture preparation,
// separately bounded on shared CI runners. The reader keeps its normal deadline.
beforeAll(async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-demo-display-reader-')));
  installation = path.join(home, 'installation'); fs.mkdirSync(installation, { mode: 0o700 });
  vi.stubEnv(PRODUCT_ENV.home.name, home);
  vi.stubEnv(PRODUCT_ENV.installationDir.name, installation);
  // Native JS entry points have no authored declarations. The test binds only
  // their narrow display/reporter interface and exercises their actual bytes.
  const evaluator = await import(pathToFileURL(path.join(root, 'scripts/demo-evaluator.mjs')).href) as unknown as {
    buildDemoWorkerHelpers(root: string): Promise<ReleasedHelpers>;
    demoStoreCapability(store: unknown, workspace: string): unknown;
  };
  const seed = await import(pathToFileURL(path.join(root, 'scripts/demo-seed.mjs')).href) as unknown as {
    recordDemoOsObservation(capability: unknown, scenario: ReturnType<typeof generateDemoScenario>, reporter: Reporter): Promise<Observation>;
    recordDemoSearchReports: typeof recordDemoSearchReports;
    recordDemoSiteChecks: typeof recordDemoSiteChecks;
  };
  helpers = await evaluator.buildDemoWorkerHelpers(root);
  recordDemoOsObservation = seed.recordDemoOsObservation;
  recordDemoSearchReports = seed.recordDemoSearchReports;
  recordDemoSiteChecks = seed.recordDemoSiteChecks;
  fixture = await createTestStore({ scope: 'suite' });
  await fixture.call.write(tx => fillDemo(tx, scenario, { evaluatePulse, codebaseRules: { evaluateCodebaseRules, pickComparisonReport, DEFAULT_CODEBASE_RULE_THRESHOLDS }, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
  capability = evaluator.demoStoreCapability(fixture.store, fixture.workspaceId);
}, 30_000);

afterAll(async () => {
  // End the owned connections before removing the files they can still use.
  try { await fixture?.close(); }
  finally {
    try { if (home) fs.rmSync(home, { recursive: true, force: true }); }
    finally { vi.unstubAllEnvs(); }
  }
});

it('saved demo display and the released OS observer reach ordinary Wall readers without any scheduler evidence', async () => {
  if (!home || !fixture) throw new Error('The disposable demo fixture is absent.');
  expect(Object.keys(helpers.provenance.artifacts).sort()).toEqual(['configuration', 'insights', 'jobs', 'reports', 'snapshots', 'uptime', 'watch']);
  const display = await seedDemoDisplay({ home, installation, scenario, capability, helpers });
  expect(display.documents).toEqual(generateDemoDisplay(scenario));
  const report = await recordDemoOsObservation(capability, scenario, helpers.runAssetZeroPulse);
  expect(report.capabilities).not.toContain('cronRunSuccess');
  expect(Object.keys(report.metrics)).not.toContain('heartbeat');
  expect(report.metrics.pulsesReceived?.total).toBe(scenario.pulses.length);
  expect(report.metrics.ledgerRows?.total).toBe(scenario.ledger.length);
  const wall = await buildWallPayload(fixture.call, {
    now: new Date(scenario.manifest.cutoff), osTimeZone: 'UTC', constants: { dataUsd: 25 },
    integrations: { catalog: [], assets: {} }, pullConfig: [], serpPanel: { assets: {} },
    dashboard: readDashboardConfig(display.documents['config/tower.json']),
    counters: display.documents['config/counters.json'],
  });
  expect(wall.dashboard.countdown).toEqual(display.documents['config/tower.json'].countdown);
  expect(wall.system.hasPulse).toBe(true);
  expect(wall.system.assetId).toBe(report.asset);
  expect(wall.system.scheduledLanes).toEqual([]);
  let configuredSites = 0;
  for (const site of wall.assets) {
    const configured = display.documents['config/counters.json'].assets[site.id];
    if (!configured) continue;
    configuredSites++;
    const latest = scenario.pulses.filter(pulse => pulse.asset === site.id).at(-1)!;
    expect(site.counters?.cards[0]?.value).toBe(latest.metrics[configured.cards[0]!.metric]!.total);
    expect(site.counters?.cards[0]?.source).toBe('nightly');
  }
  expect(configuredSites).toBe(5);
  expect(await fixture.call.read(tx => tx.query('SELECT count(*)::int AS jobs FROM noticeos.job_runs'))).toEqual([{ jobs: 0 }]);
  await expect(seedDemoDisplay({ home, installation, scenario, capability, helpers })).rejects.toThrow('existing exports');
  expect((await helpers.getConfigDocuments(capability, display.files)).every(document => document.version === 1)).toBe(true);
});

it('the seeded weekly reports and nightly site checks give every founder view its readings', async () => {
  if (!fixture) throw new Error('The disposable demo fixture is absent.');
  const reports = await recordDemoSearchReports(capability, scenario, helpers.writeInsightSnapshot);
  expect(reports.reports).toBe(5);
  const checks = await recordDemoSiteChecks(capability, scenario, helpers.runHygieneChecks, helpers.writeReading);
  // First readings: nothing to compare with, so no alert.
  expect(checks.fired).toBe(0);
  // A week of nightly page speed for the four measured sites.
  expect(checks.pageSpeed).toBe(28);
  const wall = await buildWallPayload(fixture.call, {
    now: new Date(scenario.manifest.cutoff), osTimeZone: 'UTC', constants: { dataUsd: 25 },
    integrations: { catalog: [], assets: {} }, pullConfig: [], serpPanel: { assets: {} }, dashboard: {},
  });
  const card = (id: string) => wall.assets.find(asset => asset.id === id)!;
  // Where visitors come from, on every site.
  for (const site of scenario.assets.filter(asset => !asset.isOs)) expect(card(site.id).channels?.rows.length, site.id).toBeGreaterThan(0);
  // Speed and errors: Pinwell slow for one in four and erring, the recipe site clear with its funnel.
  expect(card('pinwell.example').product).toMatchObject({ speed: 'fired', worstSpeed: 'poor', errors: 'fired', funnel: null });
  expect(card('pinwell.example').product?.errorPeople).toBeGreaterThan(0);
  expect(card('weeknightpantry.example').product).toMatchObject({ speed: 'clear', errors: 'clear',
    funnel: { name: 'Recipe to sign-up', largestDrop: { fromStep: 'Opened a recipe', toStep: 'Saved it' } } });
  expect(card('lightbrief.example').product).toBeNull();
  // The opportunities the Home list ranks.
  const keys = (id: string) => (card(id).findings ?? []).map(finding => finding.key);
  expect(keys('pinwell.example')).toContain('search-striking-distance');
  expect(keys('weeknightpantry.example')).toContain('posthog-funnel-drop-recipe-to-sign-up');
  expect(keys('lightbrief.example')).toContain('ai-referral-floor');
  expect(keys('trailnotes.example')).toContain('concentration-risk');
  // The site's Health tab: security headers, sitemap, crawlers and page speed.
  const deps = { now: new Date(scenario.manifest.cutoff), osTimeZone: 'UTC', flagDefaults: {}, monthlyCaps: { dataUsd: 25 }, operatorRateUsdPerMin: 2,
    integrations: { catalog: [], assets: {} }, counters: { assets: {} }, pullConfig: [], serpPanel: { assets: {} }, signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} } };
  for (const site of scenario.assets.filter(asset => !asset.isOs)) {
    const hygiene = (await buildAssetDetailPayload(fixture.call, site.id, deps))?.hygiene;
    expect(hygiene?.headers?.headers.filter(header => header.present).length, site.id).toBe(site.prefix === 'pw' ? 4 : 6);
    expect(hygiene?.sitemap.latest?.status, site.id).toBe('ok');
    expect(hygiene?.bots.length && hygiene.bots.every(bot => bot.allowed), site.id).toBe(true);
    if (site.prefix === 'fr') expect(hygiene?.pageSpeed ?? null).toBeNull();
    else expect(hygiene?.pageSpeed?.vitals?.lcp, site.id)[site.prefix === 'pw' ? 'toBeGreaterThan' : 'toBeLessThanOrEqual'](site.prefix === 'pw' ? 4000 : 2500);
  }
});
