import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoActivity, DEMO_ACTIVITY_LIMITS } from './demo-activity.mjs';
import { generateDemoScenario, demoScenarioHash, shiftDemoDay } from './demo-scenario.mjs';

const input = { seed: 'continuing-portfolio', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };
const scenario = generateDemoScenario(input);
const activity = createDemoActivity(scenario);
const values = signal => Object.fromEntries(signal.observations.map(row => [row.metric, row.value]));

test('advancing the demo appends stable dated facts and never shifts its original history', () => {
  const original = JSON.stringify(scenario);
  const first = activity.day('2026-10-18');
  const longer = activity.batch('2026-10-17', '2026-10-23');
  assert.deepEqual(longer[1], first);
  assert.deepEqual(createDemoActivity(generateDemoScenario(input)).day('2026-10-18'), first);
  assert.equal(JSON.stringify(scenario), original);
  assert.equal(first.scenarioHash, demoScenarioHash(scenario));
  assert.equal(first.synthetic, true);
  assert.equal(new Set(longer.map(day => day.key)).size, longer.length);
  assert.deepEqual(first.assets.map(asset => asset.asset), scenario.assets.filter(asset => !asset.isOs).map(asset => asset.id));
  assert.ok(!JSON.stringify(first).includes('workspaceId')); // facts cannot select a tenant
});

test('the factory owns its scenario snapshot and refuses altered seeded facts', () => {
  const source = structuredClone(scenario);
  const owned = createDemoActivity(source), expected = owned.day('2026-11-01');
  source.assets[0].id = 'different.example';
  source.manifest.seed = 'different';
  assert.deepEqual(owned.day('2026-11-01'), expected);
  assert.throws(() => createDemoActivity(source));
});

test('usage relationships, exact counts and cumulative pulse totals stay consistent for a year', () => {
  const totals = new Map(scenario.assets.filter(asset => !asset.isOs).map(asset => {
    const last = scenario.pulses.filter(pulse => pulse.asset === asset.id).at(-1);
    return [asset.id, last.metrics[asset.event].total];
  }));
  const previous = new Map();
  for (let i = 0; i < 366; i++) {
    const date = shiftDemoDay(scenario.manifest.referenceDate, i);
    for (const asset of activity.day(date).assets) {
      const ga4 = asset.signals.find(signal => signal.integration === 'ga4');
      const gsc = values(asset.signals.find(signal => signal.integration === 'gsc'));
      assert.equal(gsc.ctr, gsc.clicks / gsc.impressions);
      assert.ok(gsc.impressions >= gsc.clicks);
      if (ga4.observations === null) { assert.equal(asset.pulse, null); continue; }
      const read = values(ga4), pulse = Object.values(asset.pulse.metrics)[0];
      for (const name of ['sessions', 'active_users', 'page_views', 'event_count']) assert.ok(Number.isSafeInteger(read[name]) && read[name] >= 0);
      assert.ok(read.page_views > read.sessions && read.sessions >= read.active_users);
      assert.equal(read.event_count, read.page_views + read.sessions + pulse.last24h);
      assert.ok(Number.isSafeInteger(pulse.total) && pulse.total >= totals.get(asset.asset));
      if (!previous.has(asset.asset) || previous.get(asset.asset) === i - 1) assert.equal(pulse.total - totals.get(asset.asset), pulse.last24h);
      else assert.ok(pulse.total - totals.get(asset.asset) > pulse.last24h); // missed report still counted by the asset
      assert.ok(pulse.avg7d >= 0 && Number.isFinite(pulse.avg7d));
      totals.set(asset.asset, pulse.total); previous.set(asset.asset, i);
      assert.equal(asset.pulse.generatedAt, `${date}T23:30:00.000Z`);
    }
  }
});

test('missing reports do not become zero and a recovery remains an ordinary observation', () => {
  const missing = activity.day(shiftDemoDay(scenario.manifest.referenceDate, 10)).assets.find(asset => asset.asset === 'pinwell.example');
  assert.equal(missing.pulse, null);
  assert.equal(missing.signals.find(signal => signal.integration === 'ga4').observations, null);
  assert.ok(missing.signals.find(signal => signal.integration === 'gsc').observations.length > 0);
  const before = activity.day(shiftDemoDay(scenario.manifest.referenceDate, 11)).assets[1];
  const incident = activity.day(shiftDemoDay(scenario.manifest.referenceDate, 12)).assets[1];
  const recovered = activity.day(shiftDemoDay(scenario.manifest.referenceDate, 14)).assets[1];
  const count = asset => asset.pulse.metrics.source_saves.last24h;
  assert.ok(count(incident) < count(before) * 0.65);
  assert.ok(count(recovered) > count(incident));
  assert.ok(!('flags' in recovered) && !('outcome' in recovered));
});

test('seven-day pulse averages cross the original seed boundary without resetting', () => {
  const first = activity.day(scenario.manifest.referenceDate);
  for (const asset of first.assets) {
    const previous = scenario.daily.filter(row => row.asset === asset.asset).slice(-6);
    const metric = Object.values(asset.pulse.metrics)[0];
    assert.equal(metric.avg7d, (previous.reduce((sum, row) => sum + row.events, 0) + metric.last24h) / 7);
  }
});

test('new receipts and operating bills never duplicate the seeded cutoff or invent young-product income', () => {
  assert.deepEqual(activity.day(scenario.manifest.referenceDate).money, []);
  const next = activity.day('2026-10-17').money;
  assert.equal(next.length, 2);
  assert.ok(next.every(row => row.kind === 'revenue' && row.coverageStart === '2026-10-17' && row.coverageEnd === '2026-10-17' && !row.coverageComplete));
  const month = activity.day('2026-11-01').money;
  assert.equal(month.filter(row => row.kind === 'cost').length, 4);
  assert.ok(month.filter(row => row.kind === 'cost').every(row => row.coverageEnd === '2026-11-30' && row.coverageComplete));
  assert.ok(month.filter(row => row.asset === 'freshrows.example').every(row => row.kind === 'cost'));
  for (const row of [...next, ...month]) {
    assert.ok(Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0);
    assert.equal(row.currency, 'USD'); assert.equal(row.source, 'demo-simulator');
    assert.match(row.note, /^Synthetic /u);
  }
  assert.equal(new Set([...next, ...month].map(row => row.externalId)).size, next.length + month.length);
});

test('leap days and month/year transitions retain exact calendar coverage', () => {
  const leap = createDemoActivity(generateDemoScenario({ ...input, cutoff: '2024-01-31T12:00:00.000Z' }));
  const february = leap.day('2024-02-01').money.filter(row => row.kind === 'cost');
  assert.ok(february.every(row => row.coverageEnd === '2024-02-29'));
  assert.equal(leap.batch('2024-02-28', '2024-03-01').length, 3);
  assert.ok(activity.day('2027-01-01').money.every(row => row.period === '2027-01'));
});

test('one weekly task progresses through a stable key without claiming real execution or lift', () => {
  assert.equal(activity.day('2026-10-16').task, null);
  const week = activity.batch('2026-10-19', '2026-10-25').flatMap(day => day.task ? [day.task] : []);
  assert.deepEqual(week.map(task => task.phase), ['create', 'start', 'complete']);
  assert.equal(new Set(week.map(task => task.key)).size, 1);
  assert.equal(new Set(week.map(task => task.asset)).size, 1);
  assert.match(week[0].description, /simulated review of fictional data/u);
  assert.match(week[2].closeReason, /No live deployment or measured business improvement/u);
  assert.notEqual(activity.day('2026-10-26').task.key, week[0].key);
  assert.notEqual(activity.day('2026-10-26').task.asset, week[0].asset);
});

test('dated generation has finite work/output and rejects malformed or historical intervals', () => {
  for (const date of ['', 'today', '2026-02-30', '2026-10-15', null, 20261016, '2026-10-16T00:00:00Z']) assert.throws(() => activity.day(date));
  assert.throws(() => activity.batch('2026-10-20', '2026-10-19'));
  assert.throws(() => activity.batch('2026-10-16', '2026-10-23'));
  const last = shiftDemoDay(scenario.manifest.referenceDate, DEMO_ACTIVITY_LIMITS.daysFromAnchor);
  const lastDay = activity.day(last);
  assert.ok(lastDay.assets.every(asset => !asset.pulse || Object.values(asset.pulse.metrics).every(metric => Number.isSafeInteger(metric.total) && metric.total >= 0)));
  assert.ok(Buffer.byteLength(JSON.stringify(lastDay)) < 16384);
  assert.throws(() => activity.day(shiftDemoDay(last, 1)));
});
