import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDemoScenario, demoScenarioHash, demoAdRevenueMinor, shiftDemoDay } from './demo-scenario.mjs';

const options = { seed: 'portfolio-v1', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };

test('the same declared seed, cutoff and release reproduce all facts and identities', () => {
  const first = generateDemoScenario(options);
  const second = generateDemoScenario(options);
  assert.deepEqual(second, first);
  assert.equal(demoScenarioHash(first), demoScenarioHash(second));
  assert.notEqual(demoScenarioHash(generateDemoScenario({ ...options, seed: 'portfolio-v2' })), demoScenarioHash(first));
  assert.equal(first.manifest.synthetic, true);
  assert.equal(first.manifest.identities.length, 5);
});

test('mature sites have 400 days and the young site has no pre-launch history', () => {
  const scenario = generateDemoScenario(options);
  for (const asset of scenario.assets.filter(a => !a.isOs)) {
    const daily = scenario.daily.filter(d => d.asset === asset.id);
    assert.equal(daily.length, asset.days);
    assert.equal(daily[0].date, asset.createdAt.slice(0, 10));
    assert.equal(daily.at(-1).date, shiftDemoDay(scenario.manifest.referenceDate, -1));
    assert.equal(new Set(daily.map(d => d.date)).size, daily.length);
    for (const row of daily) {
      for (const name of ['sessions', 'pageViews', 'activeUsers', 'events', 'eventCount', 'clicks', 'impressions']) assert.ok(Number.isSafeInteger(row[name]) && row[name] >= 0);
      assert.ok(row.pageViews > row.sessions && row.sessions >= row.activeUsers);
      assert.equal(row.eventCount, row.pageViews + row.sessions + row.events);
      assert.equal(row.ctr, row.clicks / row.impressions);
      assert.ok(Number.isFinite(row.position));
    }
  }
});

test('reference-month traffic and independently recorded income reconcile to exact integer cents', () => {
  const scenario = generateDemoScenario(options);
  const month = scenario.manifest.referencePeriod;
  let net = 0;
  for (const asset of scenario.assets.filter(a => a.revenue !== null)) {
    const days = scenario.daily.filter(d => d.asset === asset.id && d.date.startsWith(month));
    assert.equal(days.reduce((n, d) => n + d.sessions, 0), asset.sessions);
    assert.equal(scenario.ledger.find(row => row.asset === asset.id && row.period === month && row.kind === 'revenue' && row.state === 'reconciled').minor, asset.revenue);
    const ledger = scenario.ledger.filter(l => l.asset === asset.id && l.period === month);
    const replaced = new Set(ledger.map(l => l.supersedes));
    const current = ledger.filter(l => !replaced.has(l.key));
    assert.ok(current.every(l => l.state === 'reconciled'));
    net += current.reduce((n, l) => n + (l.kind === 'cost' ? -l.minor : l.minor), 0);
  }
  const overhead = scenario.ledger.find(l => l.asset === scenario.assets.find(a => a.isOs).id && l.period === month);
  assert.equal(overhead.minor, 21000);
  assert.equal(net - overhead.minor, 172000);
  assert.equal(scenario.ledger.filter(l => l.asset === 'freshrows.example' && l.period === month).length, 0);
  for (const row of scenario.ledger) {
    assert.ok(Number.isSafeInteger(row.minor));
    assert.ok(row.recordedAt <= options.cutoff);
    if (row.supersedes) {
      const previous = scenario.ledger.find(l => l.key === row.supersedes);
      for (const field of ['asset', 'period', 'kind', 'family', 'currency']) assert.equal(row[field], previous[field]);
      assert.equal(previous.state, 'estimated');
    }
  }
  assert.equal(new Set(scenario.ledger.filter(l => l.state === 'reconciled' && l.period !== scenario.manifest.referenceDate.slice(0, 7)).map(l => l.period)).size, 12);
});

test('missing traffic, provisional signals and absent recorded income remain distinct', () => {
  const scenario = generateDemoScenario(options);
  assert.equal(scenario.daily.filter(d => d.reportMissing).length, 1);
  assert.equal(scenario.daily.filter(d => d.provisional).length, 12);
  assert.ok(scenario.daily.every(day => !('adMinor' in day) && !('adMissing' in day)));
  // Subscription and licensing income is recorded monthly; only the
  // ad-supported site has ad income, as the network's payments.
  const ads = scenario.assets.filter(a => a.adRpm).map(a => a.id);
  assert.deepEqual(ads, ['weeknightpantry.example']);
  assert.ok(scenario.ledger.filter(row => row.kind === 'revenue').every(row => ads.includes(row.asset)
    ? row.family === 'ads' && row.source === 'mediavine' && row.state === 'reconciled'
    : ['subs', 'licensing'].includes(row.family) && row.source === 'demo-recorded-income'));
  assert.doesNotMatch(JSON.stringify(scenario), /MRR|Stripe|churn/iu);
  assert.ok(scenario.ledger.filter(l => l.asset === 'freshrows.example').every(l => l.kind === 'cost'));
  assert.equal(scenario.ledger.filter(l => l.period === '2026-10' && l.kind === 'revenue').length, 2);
});

test('first-of-month has no fabricated complete current-month observations or income', () => {
  const scenario = generateDemoScenario({ ...options, cutoff: '2026-10-01T00:01:00.000Z' });
  assert.ok(scenario.daily.every(d => d.date < '2026-10-01'));
  assert.equal(scenario.ledger.filter(l => l.period === '2026-10' && l.kind === 'revenue').length, 0);
  assert.equal(scenario.manifest.referencePeriod, '2026-06');
});

test('the repair and current failure share their dated source facts', () => {
  const scenario = generateDemoScenario(options);
  const { repair, problem } = scenario.manifest.stories;
  assert.ok(repair.registeredAt < repair.annotationAt && repair.annotationAt < repair.checkAt && repair.checkAt < options.cutoff);
  const before = scenario.daily.filter(d => d.asset === repair.asset && d.date >= repair.baselineStart && d.date <= repair.baselineEnd);
  const after = scenario.daily.filter(d => d.asset === repair.asset && d.age >= -41 && d.age <= -14);
  assert.equal(before.length, 28);
  assert.equal(after.length, 28);
  assert.ok(after.reduce((n, d) => n + d.sessions, 0) > before.reduce((n, d) => n + d.sessions, 0));
  const broken = scenario.pulses.find(p => p.asset === problem.asset && p.date === problem.date);
  const comparisons = [7, 14, 21, 28].map(offset => scenario.pulses.find(p => p.asset === problem.asset && p.date === shiftDemoDay(problem.date, -offset)));
  assert.ok(comparisons.every(p => p.metrics.source_saves.last24h > broken.metrics.source_saves.last24h * 10));
  for (const asset of scenario.assets.filter(a => !a.isOs)) {
    const pulses = scenario.pulses.filter(p => p.asset === asset.id);
    assert.equal(pulses.at(-1).metrics[asset.event].total, scenario.daily.filter(d => d.asset === asset.id).reduce((n, d) => n + d.events, 0));
    assert.ok(pulses.every(p => p.generatedAt <= options.cutoff));
  }
});

test('undeclared or malformed generator inputs fail before producing data', () => {
  for (const patch of [{ seed: '' }, { cutoff: 'today' }, { cutoff: '2026-02-30T12:00:00.000Z' }, { release: 'main' }, { timeZone: 'Not/AZone' }]) assert.throws(() => generateDemoScenario({ ...options, ...patch }));
});

test('accounting anchors precede the unchanged repair windows across calendar boundaries', () => {
  for (const cutoff of ['2026-10-16T12:00:00.000Z', '2026-01-01T00:01:00.000Z', '2026-02-28T12:00:00.000Z', '2024-02-29T12:00:00.000Z']) {
    const scenario = generateDemoScenario({ ...options, cutoff });
    const { repair } = scenario.manifest.stories;
    const anchorDays = scenario.daily.filter(d => d.asset === repair.asset && d.date.startsWith(scenario.manifest.referencePeriod));
    assert.ok(anchorDays.at(-1).date < repair.baselineStart, cutoff);
    assert.ok(repair.baselineEnd < repair.annotationAt.slice(0, 10), cutoff);
    assert.ok(repair.annotationAt < repair.checkAt && repair.checkAt < cutoff, cutoff);
    assert.ok(anchorDays.at(-1).date < scenario.assets.find(a => a.prefix === 'fr').createdAt.slice(0, 10), cutoff);
    const baseline = scenario.daily.filter(d => d.asset === repair.asset && d.date >= repair.baselineStart && d.date <= repair.baselineEnd);
    const post = scenario.daily.filter(d => d.asset === repair.asset && d.age >= -41 && d.age <= -14);
    assert.ok(post[0].date > repair.annotationAt.slice(0, 10), cutoff);
    assert.equal(baseline.length, 28);
    assert.equal(post.length, 28);
    assert.ok(post.reduce((n, d) => n + d.sessions, 0) > baseline.reduce((n, d) => n + d.sessions, 0) * 1.1, cutoff);
  }
});

// Income describes recorded monthly amounts, never a payment-provider model.
test('the software portfolio retains meaningful metrics and honest monthly correction evidence', () => {
  const scenario = generateDemoScenario(options);
  assert.equal(scenario.manifest.scenarioVersion, 4);
  assert.deepEqual(scenario.assets.filter(asset => !asset.isOs).map(asset => [asset.name, asset.id, asset.prefix, asset.event, asset.revenueFamily]), [
    ['Light Brief', 'lightbrief.example', 'lb', 'brief_exports', 'subs'],
    ['Pinwell', 'pinwell.example', 'pw', 'source_saves', 'licensing'],
    ['Weeknight Pantry', 'weeknightpantry.example', 'wp', 'recipe_saves', null],
    ['Fresh Rows', 'freshrows.example', 'fr', 'completed_checks', null],
  ]);
  const correction = scenario.ledger.find(row => row.supersedes && row.minor !== scenario.ledger.find(old => old.key === row.supersedes).minor);
  assert.ok(correction && correction.family === 'subs');
  assert.equal(scenario.ledger.find(row => row.key === correction.supersedes).source, correction.source);
  const currentIncome = scenario.ledger.filter(row => row.period === scenario.manifest.referenceDate.slice(0, 7) && row.kind === 'revenue');
  assert.equal(currentIncome.length, 2);
  assert.ok(currentIncome.every(row => row.minor > 0 && row.minor < scenario.assets.find(asset => asset.id === row.asset).revenue && row.state === 'reconciled'));
  assert.ok(currentIncome.every(row => row.coverageStart === '2026-10-01' && row.coverageEnd === '2026-10-16' && row.coverageComplete === false && row.recordedAt === options.cutoff));
  assert.ok(scenario.ledger.filter(row => row.kind === 'revenue' && row.period !== '2026-10').every(row => row.coverageComplete === true && row.coverageStart === row.period + '-01'));
});

test('partial income has bounded explicit coverage even on the first posting day', () => {
  for (const cutoff of ['2026-10-01T07:00:00.000Z', '2026-10-16T12:00:00.000Z', '2026-01-01T12:00:00.000Z', '2024-02-29T12:00:00.000Z']) {
    const scenario = generateDemoScenario({ ...options, cutoff });
    const rows = scenario.ledger.filter(row => row.kind === 'revenue' && row.period === cutoff.slice(0, 7));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.coverageStart, row.period + '-01');
      assert.equal(row.coverageEnd, cutoff.slice(0, 10));
      assert.equal(row.coverageComplete, false);
      assert.equal(row.recordedAt, cutoff);
      assert.ok(row.minor > 0 && row.minor < scenario.assets.find(asset => asset.id === row.asset).revenue);
    }
    assert.ok(scenario.ledger.filter(row => row.kind === 'cost').every(row => row.coverageStart === undefined && row.coverageEnd === undefined && row.coverageComplete === undefined));
  }
});

test('the ad-supported site has daily estimates through its reported day and paid months reconciled', () => {
  for (const [cutoff, through] of [['2026-10-16T12:00:00.000Z', '2026-10-14'], ['2026-10-16T14:10:00.000Z', '2026-10-15'], ['2026-10-01T00:01:00.000Z', '2026-09-29']]) {
    const scenario = generateDemoScenario({ ...options, cutoff });
    const asset = scenario.assets.find(a => a.adRpm);
    const days = scenario.daily.filter(d => d.asset === asset.id);
    assert.deepEqual(scenario.manifest.adSites, [{ asset: asset.id, siteId: 'demo-wp' }]);
    assert.equal(scenario.adRevenue.at(-1).date, through, cutoff);
    assert.equal(scenario.adRevenue[0].date, asset.createdAt.slice(0, 10));
    for (const estimate of scenario.adRevenue) {
      const day = days.find(d => d.date === estimate.date);
      assert.equal(estimate.minor, demoAdRevenueMinor(options.seed, asset, estimate.date, day.sessions));
      assert.ok(estimate.minor > 0 && estimate.recordedAt <= cutoff && estimate.recordedAt.slice(0, 10) > estimate.date);
    }
    for (const payment of scenario.ledger.filter(row => row.asset === asset.id && row.kind === 'revenue')) {
      const month = scenario.adRevenue.filter(day => day.date.startsWith(payment.period)).reduce((n, day) => n + day.minor, 0);
      assert.ok(Math.abs(payment.minor / month - 1) <= 0.016, payment.period);
      assert.ok(payment.recordedAt <= cutoff && payment.coverageComplete === true);
      assert.equal(payment.recordedAt.slice(0, 10), `${new Date(Date.UTC(Number(payment.period.slice(0, 4)), Number(payment.period.slice(5, 7)) + 1, 6)).toISOString().slice(0, 7)}-06`);
    }
  }
  // Recipe demand peaks before the holidays and ad income follows it.
  const scenario = generateDemoScenario(options);
  const month = prefix => scenario.adRevenue.filter(day => day.date.startsWith(prefix)).reduce((n, day) => n + day.minor, 0);
  assert.ok(month('2025-12') > month('2026-06') * 1.5);
});
