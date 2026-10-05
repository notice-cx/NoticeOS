// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { evaluatePulse } from '@noticeos/contract';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { fillDemo } from '../../../scripts/demo-store.mjs';
import { generateDemoDisplay, seedDemoDisplay } from '../../../scripts/demo-display.mjs';
import { createTestStore } from './postgres-store';
import { buildWallPayload } from '../worker/wall-payload';
import { readDashboardConfig } from '../shared/dashboard';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';

type DisplayHelpers = Parameters<typeof seedDemoDisplay>[0]['helpers'];
type Reporter = (capability: unknown, now: number) => Promise<unknown>;
type Observation = { asset: string; capabilities: string[]; metrics: Record<string, { last24h: number; avg7d: number; total: number }> };
type ReleasedHelpers = DisplayHelpers & { runAssetZeroPulse: Reporter; provenance: { artifacts: Record<string, string> } };

let home: string | undefined;
let installation: string;
let fixture: Awaited<ReturnType<typeof createTestStore>> | undefined;
let helpers: ReleasedHelpers;
let capability: unknown;
let recordDemoOsObservation: (capability: unknown, scenario: ReturnType<typeof generateDemoScenario>, reporter: Reporter) => Promise<Observation>;
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
  };
  helpers = await evaluator.buildDemoWorkerHelpers(root);
  recordDemoOsObservation = seed.recordDemoOsObservation;
  fixture = await createTestStore({ scope: 'suite' });
  await fixture.call.write(tx => fillDemo(tx, scenario, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
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
  expect(Object.keys(helpers.provenance.artifacts).sort()).toEqual(['configuration', 'jobs', 'reports', 'snapshots', 'watch']);
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
  expect(configuredSites).toBe(3);
  expect(await fixture.call.read(tx => tx.query('SELECT count(*)::int AS jobs FROM noticeos.job_runs'))).toEqual([{ jobs: 0 }]);
  await expect(seedDemoDisplay({ home, installation, scenario, capability, helpers })).rejects.toThrow('existing exports');
  expect((await helpers.getConfigDocuments(capability, display.files)).every(document => document.version === 1)).toBe(true);
});
