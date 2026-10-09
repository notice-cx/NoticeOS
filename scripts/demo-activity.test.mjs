import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoActivity, DEMO_ACTIVITY_LIMITS, DEMO_HOUR_SHARE, demoDayShare } from './demo-activity.mjs';
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

test('quarter-hour refreshes rise toward the finished day and keep a missing report missing', () => {
  const date = shiftDemoDay(scenario.manifest.referenceDate, 3);
  const final = activity.day(date);
  assert.ok(Math.abs(DEMO_HOUR_SHARE.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(demoDayShare(1439) - 1) < 1e-12);
  let previous = null;
  for (const time of ['00:00', '06:15', '12:30', '18:45', '23:45']) {
    const refresh = activity.collection(`${date}T${time}:00.000Z`);
    assert.equal(refresh.date, date); assert.equal(refresh.synthetic, true); assert.equal(refresh.scenarioHash, final.scenarioHash);
    assert.deepEqual(refresh, activity.collection(`${date}T${time}:00.000Z`));
    for (const [index, asset] of refresh.assets.entries()) {
      for (const signal of asset.signals) {
        const day = final.assets[index].signals.find(row => row.integration === signal.integration);
        assert.deepEqual({ ...signal, observations: null }, { ...day, observations: null });
        const now = values(signal), whole = values(day);
        assert.ok(signal.observations.every(row => row.date === date));
        for (const metric of ['sessions', 'active_users', 'page_views', 'event_count', 'clicks', 'impressions']) {
          if (!(metric in now)) continue;
          assert.ok(now[metric] <= whole[metric]);
          if (previous) assert.ok(now[metric] >= values(previous.assets[index].signals.find(row => row.integration === signal.integration))[metric]);
        }
        if (signal.integration === 'gsc') assert.equal(now.position, whole.position);
      }
    }
    previous = refresh;
  }
  const late = values(previous.assets[0].signals[0]), whole = values(final.assets[0].signals[0]);
  assert.ok(late.active_users > whole.active_users * 0.97);
  // The scenario's missing report is not refreshed into a partial value.
  const missingDay = shiftDemoDay(scenario.manifest.referenceDate, 10);
  const missing = activity.collection(`${missingDay}T15:00:00.000Z`).assets.find(asset => asset.asset === 'pinwell.example');
  assert.equal(missing.signals.find(signal => signal.integration === 'ga4').observations, null);
  for (const at of [`${date}T12:30:00Z`, `${date}T12:30:00.000+00:00`, 'today', `${shiftDemoDay(scenario.manifest.referenceDate, -1)}T12:30:00.000Z`]) {
    assert.throws(() => activity.collection(at));
  }
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
  assert.equal(month.filter(row => row.kind === 'cost').length, 5);
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

test('each site runs its own weekly cycle, reviews and ships alternating, without claiming real execution or lift', () => {
  assert.deepEqual(activity.day('2026-10-16').tasks, []);
  const sites = scenario.assets.filter(asset => !asset.isOs).map(asset => asset.id);
  const first = activity.batch('2026-10-19', '2026-10-25').flatMap(day => day.tasks);
  // The first Monday files the first site's review; the others follow a day apart.
  assert.deepEqual(activity.day('2026-10-19').tasks.map(task => [task.asset, task.phase]), [[sites[0], 'create']]);
  assert.deepEqual(activity.day('2026-10-20').tasks.map(task => [task.asset, task.phase]), [[sites[1], 'create']]);
  for (const site of sites) {
    const own = first.filter(task => task.asset === site);
    assert.deepEqual(own.map(task => task.phase), site === sites[3] ? ['create', 'start'] : ['create', 'start', 'complete']);
    assert.equal(new Set(own.map(task => task.key)).size, 1);
    assert.match(own[0].description, /simulated review of fictional data/u);
  }
  assert.match(first.find(task => task.phase === 'complete').closeReason, /No live deployment or measured business improvement/u);
  // Review weeks register nothing; the following week every site ships and its close records one change with its comparison.
  assert.ok(activity.batch('2026-10-19', '2026-10-25').every(day => day.changes.length === 0));
  const shipWeek = activity.batch('2026-10-26', '2026-11-01').concat(activity.day('2026-11-02'));
  const shipped = shipWeek.flatMap(day => day.changes);
  assert.deepEqual(shipped.map(change => change.asset), sites);
  for (const change of shipped) {
    const day = shipWeek.find(entry => entry.changes.includes(change));
    const close = day.tasks.find(task => task.asset === change.asset && task.phase === 'complete');
    assert.equal(change.ref, close.key);
    assert.match(close.title, /^Ship /u);
    assert.match(close.closeReason, /28-day comparison.*No live deployment/u);
    assert.equal(change.kind, 'deploy');
    assert.equal(change.at, `${day.date}T15:00:00.000Z`);
    assert.match(change.note, /^Synthetic change: .*No live deployment\.$/u);
    assert.equal(change.watch.baselineStart, shiftDemoDay(day.date, -28));
    assert.equal(change.watch.baselineEnd, shiftDemoDay(day.date, -1));
    assert.deepEqual(change.watch.checkOffsets, [28]);
    assert.match(change.watch.note, /no causal revenue claim/u);
  }
  // Each site's work is about its own site, and keys never repeat across cycles.
  const titles = { 'lightbrief.example': /brief/u, 'pinwell.example': /source|collection/u, 'weeknightpantry.example': /recipe/u, 'freshrows.example': /row|CSV/u };
  const keys = new Set();
  for (let w = 0; w < 8; w++) {
    for (const task of activity.day(shiftDemoDay('2026-10-19', w * 7)).tasks) {
      assert.match(task.title, titles[task.asset]);
      assert.ok(!keys.has(task.key)); keys.add(task.key);
    }
  }
});

test('every Monday each site reports its search queries against the week before, in the executive snapshot shape', () => {
  assert.deepEqual(activity.day('2026-10-18').reports, []);
  const monday = activity.day('2026-10-19');
  assert.equal(monday.reports.length, 4);
  for (const report of monday.reports) {
    const asset = monday.assets.find(entry => entry.asset === report.asset);
    assert.ok(asset);
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.generatedAt.startsWith('2026-10-19T') && report.generatedAt < `2026-10-19T23:30:00.000Z`);
    const google = report.searchQueries.google;
    assert.deepEqual([google.previousStart, google.previousEnd, google.currentStart, google.currentEnd], ['2026-10-05', '2026-10-11', '2026-10-12', '2026-10-18']);
    assert.equal(google.movers.length, 8);
    assert.equal(new Set(google.movers.map(mover => mover.query)).size, 8);
    // The queries share the week's impressions the signals carry, no more.
    const week = Array.from({ length: 7 }, (_, i) => shiftDemoDay('2026-10-12', i)).map(date => {
      const facts = date < scenario.manifest.referenceDate ? scenario.daily.find(row => row.asset === report.asset && row.date === date).impressions
        : values(activity.day(date).assets.find(entry => entry.asset === report.asset).signals.find(signal => signal.integration === 'gsc')).impressions;
      return facts;
    }).reduce((a, b) => a + b, 0);
    const claimed = google.movers.reduce((sum, mover) => sum + mover.currentImpressions, 0);
    assert.ok(claimed <= week * 1.16 && claimed >= week * 0.84);
    for (const mover of google.movers) {
      assert.equal(mover.impressionDelta, mover.currentImpressions - mover.previousImpressions);
      assert.ok(mover.currentPosition >= 1 && mover.previousPosition >= 1);
      assert.equal(mover.positionImprovement, Math.round((mover.previousPosition - mover.currentPosition) * 10) / 10);
    }
    assert.ok(google.movers.some(mover => mover.positionImprovement !== 0));
    assert.equal(report.items.length, 1);
    const [finding] = report.items;
    assert.ok(['insight', 'warning'].includes(finding.kind));
    assert.match(finding.title, /^“.+” (climbed|slipped) \d+\.\d places to #\d+(\.\d)?$/u);
    assert.match(finding.caveat, /Synthetic/u);
    assert.match(google.caveat, /Synthetic/u);
    assert.ok(finding.evidence.every(row => typeof row.label === 'string' && typeof row.value === 'string'));
  }
  // The next week's finding has a new key, so the feed can tell it from the week before's.
  const next = activity.day('2026-10-26').reports[0];
  assert.notEqual(next.items[0].key, monday.reports[0].items[0].key);
  assert.deepEqual(activity.day('2026-10-26').reports.map(report => report.asset), monday.reports.map(report => report.asset));
});

test('visits surge and settle on their own, so a day can read well above or below the same weekday a week before', () => {
  const site = 'weeknightpantry.example';
  const users = date => values(activity.day(date).assets.find(entry => entry.asset === site).signals.find(signal => signal.integration === 'ga4')).active_users;
  const ratios = [];
  for (let i = 7; i < 120; i++) {
    const date = shiftDemoDay(scenario.manifest.referenceDate, i);
    ratios.push(users(date) / users(shiftDemoDay(date, -7)));
  }
  assert.ok(ratios.some(ratio => ratio >= 1.25), 'a surge week');
  assert.ok(ratios.some(ratio => ratio <= 0.8), 'the week after a surge');
  assert.ok(ratios.filter(ratio => ratio > 0.9 && ratio < 1.1).length > ratios.length / 3, 'most weeks are ordinary');
  // The young site has no surges: its weeks stay within its own growth.
  const young = 'freshrows.example';
  const youngUsers = date => values(activity.day(date).assets.find(entry => entry.asset === young).signals.find(signal => signal.integration === 'ga4')).active_users;
  for (let i = 7; i < 60; i++) {
    const date = shiftDemoDay(scenario.manifest.referenceDate, i);
    assert.ok(youngUsers(date) / youngUsers(shiftDemoDay(date, -7)) < 1.25);
  }
});

test('the ad-supported site continues its seeded estimates and is paid two months later', () => {
  const site = scenario.manifest.adSites[0].asset;
  for (const estimate of scenario.adRevenue.slice(-20)) assert.equal(activity.adRevenue(site, estimate.date), estimate.minor);
  assert.throws(() => activity.adRevenue('lightbrief.example', '2026-10-20'));
  assert.throws(() => activity.adRevenue(site, '2020-01-01'));
  const later = Array.from({ length: 10 }, (_, i) => activity.adRevenue(site, shiftDemoDay(scenario.manifest.referenceDate, i)));
  assert.ok(later.every(minor => Number.isSafeInteger(minor) && minor > 0));
  const paid = activity.day('2026-12-06').money.filter(row => row.family === 'ads');
  assert.equal(paid.length, 1);
  const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const estimates = days.reduce((sum, date) => sum + activity.adRevenue(site, date), 0);
  assert.deepEqual({ ...paid[0], amountMinor: 0 }, { asset: site, kind: 'revenue', family: 'ads', period: '2026-10', amountMinor: 0, currency: 'USD',
    bookingState: 'reconciled', source: 'mediavine', externalId: `${activity.day('2026-12-06').key}/wp/payment`,
    note: 'Synthetic ad network payment; no real payout.', coverageStart: '2026-10-01', coverageEnd: '2026-10-31', coverageComplete: true });
  assert.ok(Math.abs(paid[0].amountMinor / estimates - 1) <= 0.016);
  assert.equal(activity.day('2026-12-07').money.filter(row => row.family === 'ads').length, 0);
  // The seed booked every payment before its reference day; none repeats.
  const seeded = new Set(scenario.ledger.filter(row => row.family === 'ads').map(row => row.period));
  const continued = activity.batch('2026-10-16', '2026-10-22').flatMap(day => day.money.filter(row => row.family === 'ads').map(row => row.period));
  assert.ok(continued.every(period => !seeded.has(period)));
});

test('recurring incidents dip each mature site\'s tracked action and recover; the young site has none', () => {
  const days = activity.batch('2026-10-16', '2026-10-22').concat(...Array.from({ length: 8 }, (_, w) =>
    activity.batch(shiftDemoDay('2026-10-23', w * 7), shiftDemoDay('2026-10-29', w * 7))));
  const dips = new Map();
  for (const day of days) for (const asset of day.assets) {
    if (!asset.pulse) continue;
    const [reading] = Object.values(asset.pulse.metrics);
    // Only a baseline of three a day or more can carry a volume-aware alert.
    if (reading.avg7d >= 3 && reading.last24h < reading.avg7d * 0.65) dips.set(asset.asset, (dips.get(asset.asset) ?? 0) + 1);
  }
  for (const site of ['lightbrief.example', 'pinwell.example', 'weeknightpantry.example']) assert.ok(dips.get(site) >= 2, site);
  assert.equal(dips.get('freshrows.example'), undefined);
  assert.ok(days.every(day => day.assets.find(asset => asset.asset === 'freshrows.example').pulse.metrics.completed_checks.avg7d < 3));
  // Most incident days are followed, within a week, by an ordinary day.
  const recipes = days.map(day => day.assets.find(asset => asset.asset === 'weeknightpantry.example').pulse.metrics.recipe_saves);
  assert.ok(recipes.slice(-14).some(reading => reading.last24h >= reading.avg7d));
});

test('dated generation has finite work/output and rejects malformed or historical intervals', () => {
  for (const date of ['', 'today', '2026-02-30', '2026-10-15', null, 20261016, '2026-10-16T00:00:00Z']) assert.throws(() => activity.day(date));
  assert.throws(() => activity.batch('2026-10-20', '2026-10-19'));
  assert.throws(() => activity.batch('2026-10-16', '2026-10-23'));
  const last = shiftDemoDay(scenario.manifest.referenceDate, DEMO_ACTIVITY_LIMITS.daysFromAnchor);
  const lastDay = activity.day(last);
  assert.ok(lastDay.assets.every(asset => !asset.pulse || Object.values(asset.pulse.metrics).every(metric => Number.isSafeInteger(metric.total) && metric.total >= 0)));
  assert.ok(Buffer.byteLength(JSON.stringify(lastDay)) < 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(activity.day('2026-10-26'))) < 32768);
  assert.throws(() => activity.day(shiftDemoDay(last, 1)));
});
