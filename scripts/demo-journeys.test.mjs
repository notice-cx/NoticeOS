import assert from 'node:assert/strict';
import test from 'node:test';
import { readJourneySnapshot } from '../packages/contract/src/journeys.mjs';
import { createDemoActivity } from './demo-activity.mjs';
import { generateDemoDisplay } from './demo-display.mjs';
import { generateDemoScenario, demoProperties, shiftDemoDay } from './demo-scenario.mjs';
import { assetJourneys } from '../apps/tower/worker/asset-journeys.ts';

test('seeded and continuing demo journeys survive the current Tower contract and saved definitions', () => {
  for (const cutoff of ['2026-10-26T12:00:00.000Z', '2024-02-29T02:00:00.000Z']) {
    const timeZone = 'UTC';
    const scenario = generateDemoScenario({ seed: 'journey-coverage', cutoff, release: 'a'.repeat(40), timeZone });
    const activity = createDemoActivity(scenario);
    const configured = generateDemoDisplay(scenario)['config/value-events.json'];
    const firstMonday = shiftDemoDay(scenario.manifest.referenceDate, (8 - new Date(`${scenario.manifest.referenceDate}T00:00:00Z`).getUTCDay()) % 7);
    const batches = [activity.seededReports(), activity.day(firstMonday).reports, activity.day(shiftDemoDay(firstMonday, 140)).reports];
    for (const [generation, reports] of batches.entries()) {
      assert.equal(reports.length, 5);
      for (const report of reports) {
        const asset = scenario.assets.find(asset => asset.id === report.asset);
        const snapshot = readJourneySnapshot(report.journeys);
        assert.ok(snapshot, report.asset);
        const definitions = configured.assets[report.asset].journeys;
        const read = assetJourneys(JSON.stringify(report), definitions, { asset: asset.id, propertyId: demoProperties(asset).ga4, timeZone });
        assert.deepEqual(read.funnels, snapshot.funnels, 'saved definitions and current GA4 binding must retain every result');
        const [result] = read.funnels;
        assert.ok(result.current7 && result.prior7);
        if (asset.prefix === 'fr' && generation < 2) {
          assert.equal(result.current28, null, 'a young asset has no invented month of history');
          assert.equal(result.prior28, null);
          assert.ok(result.weekly.length > 0 && result.weekly.length < 4);
        } else {
          assert.ok(result.current28 && result.prior28);
          assert.equal(result.weekly.length, 12);
          assert.ok(new Set(result.weekly.map(period => period.steps.at(-1).users / period.visitors.users)).size > 3);
        }
        for (const period of [result.current7, result.prior7, result.current28, result.prior28, ...result.weekly].filter(Boolean)) {
          assert.ok(period.startDate >= asset.createdAt.slice(0, 10));
          assert.ok(period.endDate < report.generatedAt.slice(0, 10));
          assert.ok(period.visitors.users > period.steps[0].users);
          assert.ok(period.steps.at(-1).users > 0);
          assert.ok(period.steps.every((step, index, steps) => index === 0 || step.users <= steps[index - 1].users));
        }
        assert.match(snapshot.exploration.reason, /Synthetic/);
      }
    }
    const ga4 = activity.day(firstMonday).assets.flatMap(asset => asset.signals).filter(signal => signal.integration === 'ga4');
    assert.ok(ga4.every(signal => signal.timeZone === timeZone));
  }
});

test('journeys include improving and declining conversion with a distinct save bottleneck', () => {
  const scenario = generateDemoScenario({ seed: 'journey-coverage', cutoff: '2026-10-26T12:00:00.000Z', release: 'a'.repeat(40) });
  const reports = createDemoActivity(scenario).seededReports();
  const changes = reports.map(report => {
    const result = report.journeys.funnels[0];
    const rate = period => period.steps.at(-1).users / period.visitors.users;
    return rate(result.current7) - rate(result.prior7);
  });
  assert.ok(changes.some(change => change > 0));
  assert.ok(changes.some(change => change < 0));
  const recipe = reports.find(report => report.asset === 'weeknightpantry.example').journeys.funnels[0].current7;
  assert.ok(recipe.steps[2].users / recipe.steps[1].users < 0.2);
});
