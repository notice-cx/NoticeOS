import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoActivity, DEMO_ACTIVITY_LIMITS, DEMO_HOUR_SHARE, DEMO_NIGHTLY_HOUR, DEMO_OUTAGE_MINUTES, demoDayShare } from './demo-activity.mjs';
import { generateDemoScenario, demoCodebaseEnvelope, demoCodebaseReports, demoScenarioHash, demoRecurringCost, demoSubscriptionMinor, shiftDemoDay, DEMO_INFERENCE_SOURCE } from './demo-scenario.mjs';
import { STRIPE_REVENUE_SOURCE } from '../packages/contract/src/revenue-sources.mjs';
import { parseProductSnapshot } from '../apps/tower/shared/product-snapshot.ts';
import { readFileSync } from 'node:fs';
import { demoCodebaseVerdicts } from './demo-store.mjs';
import * as codebaseRules from '../packages/contract/src/codebase-measures.ts';

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
  // Each site's own counter through the last seeded day, reported or not.
  const sites = scenario.assets.filter(asset => !asset.isOs);
  const totals = new Map(sites.map(asset => [asset.id, scenario.daily.filter(row => row.asset === asset.id).reduce((n, row) => n + row.events, 0)]));
  const previous = new Map(sites.map(asset => [asset.id, -1]));
  for (let i = 0; i < 366; i++) {
    const date = shiftDemoDay(scenario.manifest.referenceDate, i);
    for (const asset of activity.day(date).assets) {
      const ga4 = asset.signals.find(signal => signal.integration === 'ga4');
      const gsc = values(asset.signals.find(signal => signal.integration === 'gsc'));
      assert.equal(gsc.ctr, gsc.clicks / gsc.impressions);
      assert.ok(gsc.impressions >= gsc.clicks);
      if (ga4.observations === null) { assert.equal(asset.pulse, null); continue; }
      const read = values(ga4);
      for (const name of ['sessions', 'active_users', 'page_views', 'event_count']) assert.ok(Number.isSafeInteger(read[name]) && read[name] >= 0);
      assert.ok(read.page_views > read.sessions && read.sessions >= read.active_users);
      // A quiet night sends no report while its traffic is still collected.
      if (asset.pulse === null) { assert.equal(asset.asset, scenario.manifest.reportGap.asset); continue; }
      const pulse = Object.values(asset.pulse.metrics)[0];
      assert.equal(read.event_count, read.page_views + read.sessions + pulse.last24h);
      assert.ok(Number.isSafeInteger(pulse.total) && pulse.total >= totals.get(asset.asset));
      if (previous.get(asset.asset) === i - 1) assert.equal(pulse.total - totals.get(asset.asset), pulse.last24h);
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
      // Bing answers once a day, never in the quarter-hour refresh.
      assert.ok(asset.signals.every(signal => signal.integration !== 'bing-webmaster'));
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

test('a stopped nightly report continues from the seed and recurs, each gap closed by the next report', () => {
  const { reportGap } = scenario.manifest;
  const quiet = Array.from({ length: 70 }, (_, i) => activity.day(shiftDemoDay(scenario.manifest.referenceDate, i)))
    .map(day => day.assets.find(asset => asset.asset === reportGap.asset).pulse === null);
  // The seeded gap's last night, then reports, then the next gap three weeks on.
  assert.equal(quiet[0], true);
  assert.equal(quiet[1], false);
  assert.deepEqual(quiet.flatMap((value, i) => value ? [i] : []), [0, 21, 22, 23, 44, 45, 46, 67, 68, 69]);
  for (const site of scenario.assets.filter(asset => !asset.isOs && asset.id !== reportGap.asset)) {
    assert.ok(activity.day(scenario.manifest.referenceDate).assets.find(asset => asset.asset === site.id).pulse !== null, site.id);
  }
});

test('seven-day pulse averages cross the original seed boundary without resetting', () => {
  const first = activity.day(scenario.manifest.referenceDate);
  for (const asset of first.assets) {
    if (asset.pulse === null) continue;
    const previous = scenario.daily.filter(row => row.asset === asset.asset).slice(-6);
    const metric = Object.values(asset.pulse.metrics)[0];
    assert.equal(metric.avg7d, (previous.reduce((sum, row) => sum + row.events, 0) + metric.last24h) / 7);
  }
});

test('new receipts and operating bills never duplicate the seeded cutoff or invent young-product income', () => {
  assert.deepEqual(activity.day(scenario.manifest.referenceDate).money, []);
  const next = activity.day('2026-10-17').money;
  // Licensing receipts only: subscription income arrives as daily figures.
  assert.equal(next.length, 1);
  assert.ok(next.every(row => row.kind === 'revenue' && row.coverageStart === '2026-10-17' && row.coverageEnd === '2026-10-17' && !row.coverageComplete));
  const month = activity.day('2026-11-01').money;
  // Each site's and the OS's prepaid bill for the month, and the OS's model
  // usage for the month that just ended, estimated as a usage export is.
  const bills = month.filter(row => row.kind === 'cost' && row.family !== 'inference');
  assert.equal(bills.length, 6);
  assert.ok(bills.every(row => row.coverageEnd === '2026-11-30' && row.coverageComplete && row.bookingState === 'reconciled'));
  const usage = month.filter(row => row.family === 'inference');
  assert.deepEqual(usage.map(row => [row.asset, row.kind, row.period, row.bookingState, row.source, row.coverageStart, row.coverageEnd]),
    [[scenario.assets.find(asset => asset.isOs).id, 'cost', '2026-10', 'estimated', DEMO_INFERENCE_SOURCE, '2026-10-01', '2026-10-31']]);
  assert.ok(!scenario.ledger.some(row => row.family === 'inference' && row.period === '2026-10'), 'the seed books only finished months');
  assert.ok(month.filter(row => row.asset === 'freshrows.example').every(row => row.kind === 'cost'));
  for (const row of [...next, ...month]) {
    assert.ok(Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0);
    assert.equal(row.currency, 'USD');
    // Subscription income names its Stripe source, so Money reads it as subscriptions.
    // Other recorded income has no collector and no source; a bill is a
    // declared recurring cost, booked at its declared amount.
    const asset = scenario.assets.find(entry => entry.id === row.asset);
    assert.equal(row.source, row.family === 'subs' ? STRIPE_REVENUE_SOURCE : row.family === 'inference' ? DEMO_INFERENCE_SOURCE
      : row.kind === 'revenue' ? null : demoRecurringCost(asset).source);
    if (row.kind === 'cost' && row.family !== 'inference') assert.equal(row.amountMinor, asset.cost);
    assert.match(row.note, /^Synthetic /u);
  }
  assert.deepEqual(next.map(row => row.family).sort(), ['licensing']);
  assert.equal(new Set([...next, ...month].map(row => row.externalId)).size, next.length + month.length);
});

test('subscription income continues day by day after the seed, and each finished month closes on their sum', () => {
  const site = scenario.assets.find(asset => asset.revenueFamily === 'subs');
  const seeded = scenario.subscriptionDays.at(-1).date;
  assert.equal(seeded, '2026-10-15');
  // The anchor day writes every day after the seed's last, through itself.
  assert.deepEqual(activity.day(scenario.manifest.referenceDate).subscriptions,
    [{ asset: site.id, account: 'acct_demo_lb', date: '2026-10-16', amountMinor: demoSubscriptionMinor(input.seed, site, '2026-10-16'), currency: 'USD' }]);
  assert.deepEqual(activity.day('2026-10-17').subscriptions.map(day => [day.asset, day.date]), [[site.id, '2026-10-17']]);
  // No ledger receipt stands beside them, so nothing is counted twice.
  const rest = Array.from({ length: 16 }, (_, i) => activity.day(shiftDemoDay('2026-10-16', i)));
  assert.ok(rest.every(day => !day.money.some(row => row.family === 'subs')));
  const close = activity.day('2026-11-01').money.filter(row => row.family === 'subs');
  const october = [...scenario.subscriptionDays.filter(day => day.date.startsWith('2026-10')).map(day => day.minor),
    ...rest.flatMap(day => day.subscriptions.map(row => row.amountMinor))];
  assert.equal(october.length, 31);
  assert.deepEqual(close.map(row => [row.asset, row.period, row.amountMinor, row.bookingState, row.source, row.coverageStart, row.coverageEnd, row.coverageComplete]),
    [[site.id, '2026-10', october.reduce((sum, minor) => sum + minor, 0), 'reconciled', STRIPE_REVENUE_SOURCE, '2026-10-01', '2026-10-31', true]]);
});

test('leap days and month/year transitions retain exact calendar coverage', () => {
  const leap = createDemoActivity(generateDemoScenario({ ...input, cutoff: '2024-01-31T12:00:00.000Z' }));
  const february = leap.day('2024-02-01').money.filter(row => row.kind === 'cost');
  assert.ok(february.filter(row => row.family !== 'inference').every(row => row.coverageEnd === '2024-02-29'));
  assert.ok(february.filter(row => row.family === 'inference').every(row => row.period === '2024-01' && row.coverageEnd === '2024-01-31'));
  assert.equal(leap.batch('2024-02-28', '2024-03-01').length, 3);
  const january = activity.day('2027-01-01').money;
  assert.ok(january.filter(row => row.family !== 'inference' && row.family !== 'subs').every(row => row.period === '2027-01'));
  assert.deepEqual(january.filter(row => row.family === 'subs').map(row => [row.period, row.coverageStart, row.coverageEnd]), [['2026-12', '2026-12-01', '2026-12-31']]);
  assert.deepEqual(january.filter(row => row.family === 'inference').map(row => [row.period, row.coverageEnd]), [['2026-12', '2026-12-31']]);
});

test('each asset runs its own weekly cycle, reviews and ships alternating, without claiming real execution or lift', () => {
  assert.deepEqual(activity.day('2026-10-16').tasks, []);
  const sites = scenario.assets.filter(asset => !asset.isOs).map(asset => asset.id);
  const first = activity.batch('2026-10-19', '2026-10-25').flatMap(day => day.tasks);
  // The first Monday files the first site's review; the others follow a day apart.
  assert.deepEqual(activity.day('2026-10-19').tasks.map(task => [task.asset, task.phase]), [[sites[0], 'create']]);
  assert.deepEqual(activity.day('2026-10-20').tasks.map(task => [task.asset, task.phase]), [[sites[1], 'create']]);
  for (const site of sites) {
    const own = first.filter(task => task.asset === site);
    // A site's cycle closes four days after it starts, so the last two sites close the next week.
    assert.deepEqual(own.map(task => task.phase), sites.indexOf(site) >= 3 ? ['create', 'start'] : ['create', 'start', 'complete']);
    assert.equal(new Set(own.map(task => task.key)).size, 1);
    assert.match(own[0].description, /simulated review of fictional data/u);
    // The verifier reviews, naming its model on every step of the cycle.
    assert.ok(own.every(task => task.agent === 'codex' && task.model === 'GPT-5-Codex'));
  }
  assert.match(first.find(task => task.phase === 'complete').closeReason, /No live deployment or measured business improvement/u);
  // Review weeks register nothing; the following week every site ships and its close records one change with its comparison.
  assert.ok(activity.batch('2026-10-19', '2026-10-25').every(day => day.changes.length === 0));
  const shipWeek = activity.batch('2026-10-26', '2026-11-01').concat(activity.batch('2026-11-02', '2026-11-03'));
  const shipped = shipWeek.flatMap(day => day.changes);
  assert.deepEqual(shipped.map(change => change.asset), sites);
  for (const change of shipped) {
    const day = shipWeek.find(entry => entry.changes.includes(change));
    const close = day.tasks.find(task => task.asset === change.asset && task.phase === 'complete');
    assert.equal(change.ref, close.key);
    assert.match(close.title, /^Ship /u);
    // The builder ships, under one of the models it names.
    assert.equal(close.agent, 'claude'); assert.ok(['Opus 5.5', 'Sonnet 5.5'].includes(close.model));
    assert.ok(shipWeek.flatMap(entry => entry.tasks).filter(task => task.key === close.key).every(task => task.model === close.model));
    assert.match(close.closeReason, /28-day comparison.*No live deployment/u);
    assert.equal(change.kind, 'deploy');
    assert.equal(change.at, `${day.date}T15:00:00.000Z`);
    assert.match(change.note, /^Synthetic change: .*No live deployment\.$/u);
    assert.equal(change.watch.baselineStart, shiftDemoDay(day.date, -28));
    assert.equal(change.watch.baselineEnd, shiftDemoDay(day.date, -1));
    assert.deepEqual(change.watch.checkOffsets, [28]);
    // The comparison is named for the change it reads.
    assert.equal(change.watch.note.toLowerCase(), close.title.replace(/^Ship the /u, '').toLowerCase());
  }
  // Each site's work is about its own site, and keys never repeat across cycles.
  const titles = { 'lightbrief.example': /brief/u, 'pinwell.example': /source|collection/u, 'weeknightpantry.example': /recipe/u, 'trailnotes.example': /trail/u, 'freshrows.example': /row|CSV/u };
  const keys = new Set();
  for (let w = 0; w < 8; w++) {
    for (const task of activity.day(shiftDemoDay('2026-10-19', w * 7)).tasks) {
      assert.match(task.title, titles[task.asset]);
      assert.ok(!keys.has(task.key)); keys.add(task.key);
    }
  }
});

test('every Monday each asset reports its search queries against the week before, in the executive snapshot shape', () => {
  assert.deepEqual(activity.day('2026-10-18').reports, []);
  const monday = activity.day('2026-10-19');
  assert.equal(monday.reports.length, 5);
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
    // The week's lead search finding, then at most one opportunity.
    assert.ok(report.items.length >= 1 && report.items.length <= 2);
    const [finding] = report.items;
    assert.ok(['insight', 'warning'].includes(finding.kind));
    assert.match(finding.title, /^“.+” (climbed|slipped) \d+\.\d places to #\d+(\.\d)?$/u);
    assert.match(google.caveat, /Synthetic/u);
    for (const item of report.items) {
      assert.match(item.caveat, /Synthetic/u);
      assert.ok(item.evidence.every(row => typeof row.label === 'string' && typeof row.value === 'string'));
    }
  }
  // The next week's finding has a new key, so the feed can tell it from the week before's.
  const next = activity.day('2026-10-26').reports[0];
  assert.notEqual(next.items[0].key, monday.reports[0].items[0].key);
  assert.deepEqual(activity.day('2026-10-26').reports.map(report => report.asset), monday.reports.map(report => report.asset));
});

test('each weekly report says where the last four weeks of visits came from, summing to GA4\'s visits', () => {
  const ga4 = (asset, date) => {
    if (date < scenario.manifest.referenceDate) { const row = scenario.daily.find(row => row.asset === asset && row.date === date); return row && !row.reportMissing ? row.sessions : 0; }
    const signal = activity.day(date).assets.find(entry => entry.asset === asset).signals.find(signal => signal.integration === 'ga4');
    return signal.observations === null ? 0 : values(signal).sessions;
  };
  for (const report of [...activity.seededReports(), ...activity.day('2026-10-26').reports]) {
    const { channels } = report;
    const site = scenario.assets.find(asset => asset.id === report.asset);
    assert.equal(channels.windowEnd, report.searchQueries.google.currentEnd);
    // Four weeks, or the young site's whole life.
    assert.equal(channels.windowStart, [shiftDemoDay(report.generatedAt.slice(0, 10), -28), site.createdAt.slice(0, 10)].sort().at(-1));
    assert.deepEqual(channels.provisionalDates, []);
    const days = [];
    for (let date = channels.windowStart; date <= channels.windowEnd; date = shiftDemoDay(date, 1)) days.push(date);
    const total = days.reduce((sum, date) => sum + ga4(report.asset, date), 0);
    assert.equal(channels.rows.reduce((sum, row) => sum + row.sessions, 0), total, report.asset);
    assert.ok(Math.abs(channels.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
    assert.ok(channels.rows.every((row, i, rows) => row.share > 0 && row.share <= 1 && Number.isSafeInteger(row.sessions) && (i === 0 || rows[i - 1].sessions >= row.sessions)));
    assert.ok(channels.rows.every(row => ['Organic Search', 'Direct', 'Referral', 'AI Assistant', 'Organic Social'].includes(row.channel)));
  }
  // Trail Notes leans on search every week; Light Brief's AI assistant
  // visits grow week by week.
  const share = (date, asset, channel) => activity.day(date).reports.find(report => report.asset === asset).channels.rows.find(row => row.channel === channel).share;
  for (let w = 0; w < 30; w++) assert.ok(share(shiftDemoDay('2026-10-19', w * 7), 'trailnotes.example', 'Organic Search') >= 0.85);
  assert.ok(share('2027-01-11', 'lightbrief.example', 'AI Assistant') > share('2026-10-19', 'lightbrief.example', 'AI Assistant') * 1.2);
});

test('the two product-analytics assets carry a product block the Tower reads: Pinwell slow for one in four, the recipe asset clear with a funnel', () => {
  for (const report of [...activity.seededReports(), ...activity.day('2026-10-26').reports, ...activity.day('2027-03-01').reports]) {
    if (!['pinwell.example', 'weeknightpantry.example'].includes(report.asset)) { assert.equal(report.product, undefined); continue; }
    const product = parseProductSnapshot(report.product);
    assert.ok(product, report.asset);
    // Everything the producer sent survives the Tower's own reader.
    assert.equal(product.vitals.segments.length, report.product.vitals.segments.length);
    assert.equal(product.exceptions.top.length, report.product.exceptions.top.length);
    assert.equal(product.funnels.length, report.product.funnels.length);
    assert.ok(product.vitals.segments.every(segment => segment.measurements >= product.vitals.minMeasurements));
    const state = key => product.checks.find(check => check.key === key)?.state;
    const errors = report.product.exceptions;
    assert.ok(Number.isSafeInteger(errors.people) && errors.people > 0 && errors.people <= errors.top.reduce((sum, row) => sum + row.people, 0));
    assert.equal(errors.top.reduce((sum, row) => sum + row.count, 0), errors.total);
    if (report.asset === 'pinwell.example') {
      assert.equal(state('posthog-slow-segment'), 'fired');
      assert.equal(state('posthog-error-concentration'), 'fired');
      const [slow, ...rest] = product.vitals.segments;
      assert.equal(slow.lcpRating, 'poor');
      assert.ok(rest.every(segment => segment.lcpRating === 'good' && segment.inpRating === 'good'));
      const measured = product.vitals.segments.reduce((sum, segment) => sum + segment.measurements, 0);
      assert.ok(Math.abs(slow.measurements / measured - 0.25) < 0.01, 'one visitor in four');
      assert.ok(Math.max(...errors.top.map(row => row.count)) / errors.total >= 0.5);
      assert.deepEqual(product.funnels, []);
    } else {
      assert.equal(state('posthog-slow-segment'), 'clear');
      assert.equal(state('posthog-error-concentration'), 'clear');
      assert.ok(product.vitals.segments.every(segment => segment.lcpRating === 'good' && segment.inpRating === 'good'));
      assert.ok(Math.max(...errors.top.map(row => row.count)) / errors.total < 0.5);
      const [funnel] = product.funnels;
      assert.deepEqual(funnel.steps.map(step => step.event), ['Visited', 'Opened a recipe', 'Saved it', 'Signed up']);
      const conversions = funnel.steps.slice(1).map((step, i) => step.people / funnel.steps[i].people);
      assert.equal(funnel.largestDrop.stepConversion, Math.min(...conversions));
      assert.equal(funnel.largestDrop.lostPeople, funnel.steps[funnel.largestDrop.fromStep - 1].people - funnel.steps[funnel.largestDrop.toStep - 1].people);
    }
  }
});

test('each mature asset\'s week names one opportunity the Home list ranks', () => {
  // The keys the Home page's "Worth a look" list reads as opportunities.
  const gaps = readFileSync(new URL('../apps/tower/src/lib/business-gaps.ts', import.meta.url), 'utf8');
  const expected = { 'pinwell.example': 'search-striking-distance', 'weeknightpantry.example': 'posthog-funnel-drop-recipe-to-sign-up',
    'lightbrief.example': 'ai-referral-floor', 'trailnotes.example': 'concentration-risk' };
  for (const report of [...activity.seededReports(), ...activity.day('2026-10-26').reports]) {
    const extra = report.items.slice(1);
    if (!expected[report.asset]) { assert.deepEqual(extra, []); continue; }
    assert.deepEqual(extra.map(item => item.key), [expected[report.asset]]);
    assert.ok(gaps.includes(`"${expected[report.asset].replace(/-recipe-to-sign-up$/u, '')}"`), expected[report.asset]);
    assert.ok(['recommendation', 'discovery', 'insight', 'warning'].includes(extra[0].kind));
    assert.ok(extra[0].title.length > 0 && extra[0].title.length <= 80, extra[0].title);
  }
  const titles = Object.fromEntries(activity.day('2026-10-26').reports.map(report => [report.asset, report.items[1]?.title]));
  assert.match(titles['pinwell.example'], /^Move “.+” into the top results$/u);
  assert.match(titles['weeknightpantry.example'], /^Recipe to sign-up: \d+% go from Opened a recipe to Saved it$/u);
  assert.equal(titles['lightbrief.example'], 'AI assistants are already sending visitors');
  assert.match(titles['trailnotes.example'], /^Search brings (8[5-9]|9\d)% of all visits$/u);
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

test('the ad-supported assets continue their seeded estimates and are paid two months later', () => {
  assert.throws(() => activity.adRevenue('lightbrief.example', '2026-10-20'));
  const paid = activity.day('2026-12-06').money.filter(row => row.family === 'ads');
  assert.equal(paid.length, scenario.manifest.adSites.length);
  for (const { asset: site } of scenario.manifest.adSites) {
    const prefix = scenario.assets.find(asset => asset.id === site).prefix;
    for (const estimate of scenario.adRevenue.filter(day => day.asset === site).slice(-20)) assert.equal(activity.adRevenue(site, estimate.date), estimate.minor);
    assert.throws(() => activity.adRevenue(site, '2020-01-01'));
    const later = Array.from({ length: 10 }, (_, i) => activity.adRevenue(site, shiftDemoDay(scenario.manifest.referenceDate, i)));
    assert.ok(later.every(minor => Number.isSafeInteger(minor) && minor > 0));
    const payment = paid.find(row => row.asset === site);
    const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    const estimates = days.reduce((sum, date) => sum + activity.adRevenue(site, date), 0);
    assert.deepEqual({ ...payment, amountMinor: 0 }, { asset: site, kind: 'revenue', family: 'ads', period: '2026-10', amountMinor: 0, currency: 'USD',
      bookingState: 'reconciled', source: 'mediavine', externalId: `${activity.day('2026-12-06').key}/${prefix}/payment`,
      note: 'Synthetic ad network payment; no real payout.', coverageStart: '2026-10-01', coverageEnd: '2026-10-31', coverageComplete: true });
    assert.ok(Math.abs(payment.amountMinor / estimates - 1) <= 0.016);
  }
  assert.equal(activity.day('2026-12-07').money.filter(row => row.family === 'ads').length, 0);
  // The seed booked every payment before its reference day; none repeats.
  const seeded = new Set(scenario.ledger.filter(row => row.family === 'ads').map(row => row.period));
  const continued = activity.batch('2026-10-16', '2026-10-22').flatMap(day => day.money.filter(row => row.family === 'ads').map(row => row.period));
  assert.ok(continued.every(period => !seeded.has(period)));
});

test('recurring incidents dip each mature asset\'s tracked action and recover; the young asset has none', () => {
  const days = activity.batch('2026-10-16', '2026-10-22').concat(...Array.from({ length: 8 }, (_, w) =>
    activity.batch(shiftDemoDay('2026-10-23', w * 7), shiftDemoDay('2026-10-29', w * 7))));
  const dips = new Map();
  for (const day of days) for (const asset of day.assets) {
    if (!asset.pulse) continue;
    const [reading] = Object.values(asset.pulse.metrics);
    // Only a baseline of three a day or more can carry a volume-aware alert.
    if (reading.avg7d >= 3 && reading.last24h < reading.avg7d * 0.65) dips.set(asset.asset, (dips.get(asset.asset) ?? 0) + 1);
  }
  for (const site of ['lightbrief.example', 'pinwell.example', 'weeknightpantry.example', 'trailnotes.example']) assert.ok(dips.get(site) >= 2, site);
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
  // A Monday also carries five reports with twelve weeks of ordered journeys.
  assert.ok(Buffer.byteLength(JSON.stringify(activity.day('2026-10-26'))) < 73728);
  assert.throws(() => activity.day(shiftDemoDay(last, 1)));
});

test('each day one fictional home page is down briefly, across the hourly check and its retry', async () => {
  const activity = createDemoActivity(scenario);
  const sites = scenario.assets.filter(asset => !asset.isOs);
  const outages = sites.map((_, i) => activity.homeOutage(shiftDemoDay(scenario.manifest.referenceDate, i)));
  // Every site takes its turn, and the outage stays inside its day.
  assert.equal(new Set(outages.map(outage => outage.asset)).size, sites.length);
  for (const outage of outages) {
    assert.equal(Date.parse(outage.to) - Date.parse(outage.from), DEMO_OUTAGE_MINUTES * 60_000);
    assert.ok(outage.from < outage.checkAt && outage.checkAt < outage.to);
    assert.equal(outage.from.slice(0, 10), outage.to.slice(0, 10));
    const during = activity.homeFetch(outage.checkAt);
    assert.equal((await during(`https://${outage.domain}/`)).status, 503);
    const other = sites.find(site => site.id !== outage.asset);
    const page = await during(new URL(`https://${other.domain}/`));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const after = new Date(Date.parse(outage.checkAt) + 3_600_000).toISOString();
    assert.equal((await activity.homeFetch(after)(`https://${outage.domain}/`)).status, 200);
  }
  // The same page every hour (no outage starts before 00:50 or ends after
  // 22:15), and no answer for a site the demo does not hold.
  const home = `https://${sites[0].domain}/`;
  const at = (hour) => `${shiftDemoDay(scenario.manifest.referenceDate, 1)}T${hour}:00:00.000Z`;
  assert.equal(await (await activity.homeFetch(at('00'))(home)).text(), await (await activity.homeFetch(at('23'))(home)).text());
  assert.equal((await activity.homeFetch(at('00'))('https://example.org/')).status, 404);
});

test('each fictional asset answers the nightly asset checks: robots.txt, a sitemap of its pages, and its security headers', async () => {
  const sites = scenario.assets.filter(asset => !asset.isOs);
  const fetchAt = activity.homeFetch(`${shiftDemoDay(scenario.manifest.referenceDate, 1)}T${DEMO_NIGHTLY_HOUR}:00:00.000Z`);
  for (const site of sites) {
    const robots = await fetchAt(`https://${site.domain}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/u);
    assert.equal(await robots.text(), `User-agent: *\nAllow: /\nSitemap: https://${site.domain}/sitemap.xml\n`);
    const sitemap = await fetchAt(`https://${site.domain}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    const body = await sitemap.text();
    assert.match(body, /^<\?xml [^>]+\?><urlset /u);
    const pages = [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1]);
    assert.ok(pages.length >= 3 && pages[0] === `https://${site.domain}/`);
    for (const page of pages) {
      const answer = await fetchAt(page);
      assert.equal(answer.status, 200, page);
      const html = await answer.text();
      // What the nightly page-structure check reads on each page.
      assert.equal(html.match(/<h1>/gu).length, 1);
      assert.match(html, /<title>[^<]+<\/title>/u);
      assert.match(html, /<meta name="description" content="[^"]+">/u);
      assert.ok(html.includes(`<link rel="canonical" href="${page}">`), page);
      const headers = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']
        .filter(name => answer.headers.get(name) !== null);
      // Pinwell sends four of the six; every other site sends all six.
      assert.equal(headers.length, site.prefix === 'pw' ? 4 : 6, site.id);
    }
    assert.equal((await fetchAt(`https://${site.domain}/missing`)).status, 404);
  }
});

test("each measured asset has a daily page speed: Pinwell's phones are slow, the others fast, the young asset unmeasured", () => {
  for (let i = -6; i < 60; i += 1) {
    const date = shiftDemoDay(scenario.manifest.referenceDate, i);
    const readings = activity.pageSpeed(date);
    assert.deepEqual(readings.map(reading => reading.asset), ['lightbrief.example', 'pinwell.example', 'weeknightpantry.example', 'trailnotes.example']);
    for (const { asset, lcp, detail } of readings) {
      // The page-speed job's own stored shape (workers/ingest/src/crux.ts).
      assert.deepEqual(Object.keys(detail), ['origin', 'lcp', 'inp', 'cls', 'formFactor', 'collectionPeriod', 'formFactors']);
      assert.equal(detail.origin, `https://${asset}`);
      assert.equal(detail.formFactor, 'PHONE');
      assert.equal(lcp, detail.lcp);
      assert.deepEqual(detail.formFactors.PHONE, { lcp: detail.lcp, inp: detail.inp, cls: detail.cls, collectionPeriod: detail.collectionPeriod });
      assert.ok(detail.collectionPeriod.firstDate < detail.collectionPeriod.lastDate && detail.collectionPeriod.lastDate < date);
      if (asset === 'pinwell.example') assert.ok(lcp > 4000, 'poor');
      else assert.ok(lcp <= 2500 && detail.inp <= 200 && detail.cls <= 0.1, asset);
    }
  }
  assert.deepEqual(activity.pageSpeed(scenario.manifest.referenceDate), createDemoActivity(generateDemoScenario(input)).pageSpeed(scenario.manifest.referenceDate));
});

test('each reporting asset keeps its weekly codebase report after the seed, with the same stories, and the young asset stays silent', () => {
  const sites = scenario.assets.filter(asset => asset.prefix !== 'fr');
  const seededLast = new Map(sites.map(asset => [asset.id, scenario.codebaseRuns.filter(run => run.asset === asset.id).at(-1)]));
  const sent = new Map(sites.map(asset => [asset.id, []]));
  for (let i = 0; i < 120; i++) {
    const day = activity.day(shiftDemoDay(scenario.manifest.referenceDate, i));
    assert.deepEqual(createDemoActivity(generateDemoScenario(input)).day(day.date).codebase, day.codebase);
    for (const envelope of day.codebase) {
      assert.ok(sent.has(envelope.asset), envelope.asset);
      assert.ok(day.date > seededLast.get(envelope.asset).date);
      assert.equal(envelope.generatedAt.slice(0, 10), day.date);
      assert.deepEqual(envelope, demoCodebaseEnvelope(scenario.manifest.seed, scenario.assets.find(asset => asset.id === envelope.asset), scenario.manifest.referenceDate, day.date));
      sent.get(envelope.asset).push({ asset: envelope.asset, date: day.date, receivedAt: envelope.generatedAt, envelope });
    }
  }
  for (const [asset, reports] of sent) {
    assert.ok(reports.length >= 17 && reports.length <= 18, asset);
    const gaps = reports.slice(1).map((report, i) => (Date.parse(report.date) - Date.parse(reports[i].date)) / 86_400_000);
    assert.ok(gaps.every(gap => gap === 7), asset);
    assert.ok(reports.every(report => report.envelope.measures.code_lines > 0 && report.envelope.findings.largestFiles.length > 0));
  }
  // The released rules over the seed and its continuation, as ingest runs them after each report.
  const flags = demoCodebaseVerdicts([...demoCodebaseReports(scenario), ...[...sent.values()].flat()], codebaseRules);
  const after = flags.filter(flag => flag.date > scenario.manifest.referenceDate);
  const of = (prefix, ruleId) => after.filter(flag => flag.asset === `${prefix}.example` && flag.ruleId === ruleId);
  // The recipe site's surge slows: its growth flag stops within weeks while its
  // repeated code stays above the line; the guide's old templates stay behind.
  assert.ok(of('weeknightpantry', 'codebase-growth').length <= 2);
  assert.ok(of('weeknightpantry', 'codebase-duplication').length >= 15);
  assert.ok(of('trailnotes', 'codebase-unused').length >= 15);
  assert.ok(after.every(flag => ['weeknightpantry.example', 'trailnotes.example'].includes(flag.asset)));
  assert.ok(!JSON.stringify(after).includes('freshrows'));
});
