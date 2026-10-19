import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateDemoScenario, demoScenarioHash, demoAdRevenueMinor, demoCodebaseEnvelope, demoCodebaseReports, demoProperties, shiftDemoDay, DEMO_DEPENDENCY_CLEANUP_AGE, DEMO_LIBRARY_SWAP_AGE, DEMO_REDESIGN_AGE, DEMO_REPORT_GAP_DAYS } from './demo-scenario.mjs';
import { demoCodebaseVerdicts } from './demo-store.mjs';
import * as codebaseRules from '../packages/contract/src/codebase-measures.ts';

const options = { seed: 'portfolio-v1', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };

test('the same declared seed, cutoff and release reproduce all facts and identities', () => {
  const first = generateDemoScenario(options);
  const second = generateDemoScenario(options);
  assert.deepEqual(second, first);
  assert.equal(demoScenarioHash(first), demoScenarioHash(second));
  assert.notEqual(demoScenarioHash(generateDemoScenario({ ...options, seed: 'portfolio-v2' })), demoScenarioHash(first));
  assert.equal(first.manifest.synthetic, true);
  assert.equal(first.manifest.identities.length, 6);
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
  // GA4 keeps only yesterday provisional, so a projection has its complete days.
  assert.equal(scenario.daily.filter(d => d.provisional).length, 5);
  assert.ok(scenario.daily.filter(d => d.provisional).every(d => d.age === -1));
  // Light Brief's nightly report stopped; its GA4 days are still reported.
  const quiet = scenario.daily.filter(d => d.pulseMissing);
  assert.equal(quiet.length, DEMO_REPORT_GAP_DAYS);
  assert.ok(quiet.every(d => d.asset === scenario.manifest.reportGap.asset && !d.reportMissing && d.date >= scenario.manifest.reportGap.from));
  assert.ok(!scenario.pulses.some(p => quiet.some(d => d.asset === p.asset && d.date === p.date)));
  assert.ok(scenario.daily.every(day => !('adMinor' in day) && !('adMissing' in day)));
  // Subscription and licensing income is recorded monthly; only the
  // ad-supported site has ad income, as the network's payments.
  const ads = scenario.assets.filter(a => a.adRpm).map(a => a.id);
  assert.deepEqual(ads, ['weeknightpantry.example', 'trailnotes.example']);
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
  // Each report's total is the site's own counter through its night, so a
  // night without a report never loses the actions it counted.
  for (const asset of scenario.assets.filter(a => !a.isOs)) {
    const pulses = scenario.pulses.filter(p => p.asset === asset.id);
    assert.equal(pulses.at(-1).metrics[asset.event].total, scenario.daily.filter(d => d.asset === asset.id && d.date <= pulses.at(-1).date).reduce((n, d) => n + d.events, 0));
    assert.ok(pulses.every(p => p.generatedAt <= options.cutoff));
  }
});

test('the recipe site shipped a change a week ago whose comparison is still counting', () => {
  const scenario = generateDemoScenario(options);
  const { ship } = scenario.manifest;
  const site = scenario.assets.find(a => a.prefix === 'wp');
  assert.equal(ship.asset, site.id);
  assert.ok(scenario.tasks.some(task => task.id === ship.ref && task.asset === site.id));
  assert.ok(scenario.tasks.some(task => task.id === ship.readbackTaskId && task.asset === site.id));
  assert.ok(ship.registeredAt <= ship.annotationAt && ship.annotationAt < options.cutoff);
  assert.equal(ship.baselineEnd < ship.registeredAt.slice(0, 10), true);
  assert.deepEqual(ship.checkOffsets, [28]);
  const baseline = scenario.daily.filter(d => d.asset === site.id && d.date >= ship.baselineStart && d.date <= ship.baselineEnd);
  assert.equal(baseline.length, 28);
  // The verdict is still ahead: the final check falls after the cutoff.
  assert.ok(shiftDemoDay(ship.registeredAt.slice(0, 10), 28) > options.cutoff.slice(0, 10));
  // A modest lift after the ship, inside the kill and ship thresholds' reach, so nothing is claimed.
  const week = scenario.daily.filter(d => d.asset === site.id && d.age >= -7);
  const before = scenario.daily.filter(d => d.asset === site.id && d.age >= -14 && d.age < -7);
  assert.ok(week.reduce((n, d) => n + d.sessions, 0) > before.reduce((n, d) => n + d.sessions, 0));
  assert.notEqual(ship.watchId, scenario.manifest.stories.repair.watchId);
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
  assert.equal(scenario.manifest.scenarioVersion, 8);
  assert.deepEqual(scenario.assets.filter(asset => !asset.isOs).map(asset => [asset.name, asset.id, asset.prefix, asset.event, asset.revenueFamily]), [
    ['Light Brief', 'lightbrief.example', 'lb', 'brief_exports', 'subs'],
    ['Pinwell', 'pinwell.example', 'pw', 'source_saves', 'licensing'],
    ['Weeknight Pantry', 'weeknightpantry.example', 'wp', 'recipe_saves', null],
    ['Trail Notes', 'trailnotes.example', 'tn', 'route_downloads', null],
    ['Fresh Rows', 'freshrows.example', 'fr', 'completed_checks', null],
  ]);
  // Only the OS and the site still setting up are observed without acting.
  assert.deepEqual(scenario.assets.filter(asset => asset.senseOnly).map(asset => asset.prefix), ['fr', 'no']);
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

test('the ad-supported sites have daily estimates through their reported day and paid months reconciled', () => {
  for (const [cutoff, through] of [['2026-10-16T12:00:00.000Z', '2026-10-14'], ['2026-10-16T14:10:00.000Z', '2026-10-15'], ['2026-10-01T00:01:00.000Z', '2026-09-29']]) {
    const scenario = generateDemoScenario({ ...options, cutoff });
    assert.deepEqual(scenario.manifest.adSites, [{ asset: 'weeknightpantry.example', siteId: 'demo-wp' }, { asset: 'trailnotes.example', siteId: 'demo-tn' }]);
    for (const asset of scenario.assets.filter(a => a.adRpm)) {
      const days = scenario.daily.filter(d => d.asset === asset.id);
      const estimates = scenario.adRevenue.filter(day => day.asset === asset.id);
      assert.equal(estimates.at(-1).date, through, cutoff);
      assert.equal(estimates[0].date, asset.createdAt.slice(0, 10));
      for (const estimate of estimates) {
        const day = days.find(d => d.date === estimate.date);
        assert.equal(estimate.minor, demoAdRevenueMinor(options.seed, asset, estimate.date, day.sessions));
        assert.ok(estimate.minor > 0 && estimate.recordedAt <= cutoff && estimate.recordedAt.slice(0, 10) > estimate.date);
      }
      for (const payment of scenario.ledger.filter(row => row.asset === asset.id && row.kind === 'revenue')) {
        const month = estimates.filter(day => day.date.startsWith(payment.period)).reduce((n, day) => n + day.minor, 0);
        assert.ok(Math.abs(payment.minor / month - 1) <= 0.016, payment.period);
        assert.ok(payment.recordedAt <= cutoff && payment.coverageComplete === true);
        assert.equal(payment.recordedAt.slice(0, 10), `${new Date(Date.UTC(Number(payment.period.slice(0, 4)), Number(payment.period.slice(5, 7)) + 1, 6)).toISOString().slice(0, 7)}-06`);
      }
    }
  }
  // Recipe demand peaks before the holidays and trail demand in summer; ad
  // income follows each.
  const scenario = generateDemoScenario(options);
  const month = (asset, prefix) => scenario.adRevenue.filter(day => day.asset === asset && day.date.startsWith(prefix)).reduce((n, day) => n + day.minor, 0);
  assert.ok(month('weeknightpantry.example', '2025-12') > month('weeknightpantry.example', '2026-06') * 1.5);
  assert.ok(month('trailnotes.example', '2026-07') > month('trailnotes.example', '2026-09') * 1.25);
});

test('the outdoor guide slides, and its redesign comparison has a decline to read', () => {
  const scenario = generateDemoScenario(options);
  const { slide } = scenario.manifest;
  const visits = (from, to) => scenario.daily.filter(d => d.asset === slide.asset && d.date >= from && d.date <= to).reduce((n, d) => n + d.sessions, 0);
  const lastFourWeeks = visits(shiftDemoDay(scenario.manifest.referenceDate, -28), shiftDemoDay(scenario.manifest.referenceDate, -1));
  const fourBefore = visits(shiftDemoDay(scenario.manifest.referenceDate, -56), shiftDemoDay(scenario.manifest.referenceDate, -29));
  assert.ok(lastFourWeeks < fourBefore * 0.85);
  assert.ok(slide.registeredAt <= slide.annotationAt && slide.baselineEnd < slide.registeredAt.slice(0, 10) && slide.checkAt < options.cutoff);
  const registered = slide.registeredAt.slice(0, 10);
  // The release's evaluator decides; the scenario only has to hold a decline
  // past the registered ten-percent kill threshold for it to find.
  assert.ok(visits(registered, shiftDemoDay(registered, 27)) < visits(slide.baselineStart, slide.baselineEnd) * 0.9);
  assert.ok(scenario.tasks.some(task => task.id === slide.ref && task.events.at(-1).status === 'closed'));
  const readback = scenario.tasks.find(task => task.id === slide.readbackTaskId);
  assert.ok(readback.events.find(event => event.status === 'closed').at > slide.checkAt);
});

test('the recipe site\'s one-day dip recovers on its next report, and the save repair ships after the last report', () => {
  const scenario = generateDemoScenario(options);
  const { dip, fix } = scenario.manifest;
  const saves = date => scenario.pulses.find(p => p.asset === dip.asset && p.date === date).metrics[dip.metric].last24h;
  const weekBefore = saves(shiftDemoDay(dip.date, -7));
  assert.ok(saves(dip.date) < weekBefore * 0.3 && saves(shiftDemoDay(dip.date, 1)) > weekBefore * 0.7);
  assert.equal(dip.resolvedAt, scenario.pulses.find(p => p.asset === dip.asset && p.date === shiftDemoDay(dip.date, 1)).generatedAt);
  const lastReport = scenario.pulses.filter(p => p.asset === fix.asset).at(-1).generatedAt;
  assert.ok(lastReport < fix.annotationAt && fix.annotationAt < options.cutoff);
  assert.equal(scenario.tasks.find(task => task.id === fix.ref).events.at(-1).status, 'closed');
});

test('each source names the property the register maps', () => {
  const scenario = generateDemoScenario(options);
  const sites = scenario.assets.filter(asset => !asset.isOs);
  for (const site of sites) {
    const properties = demoProperties(site);
    assert.match(properties.ga4, /^[1-9][0-9]{4,14}$/u);
    assert.equal(properties.gsc, `sc-domain:${site.id}`);
    assert.equal(properties.bing, ['wp', 'tn'].includes(site.prefix) ? `https://${site.id}/` : null);
  }
  assert.equal(new Set(sites.map(site => demoProperties(site).ga4)).size, sites.length);
});

// The contract's own schema, bundled from source as the release's Worker
// helpers are, so every envelope the demo stores or posts is one the ingest
// route accepts.
const esbuild = createRequire(createRequire(new URL('../workers/ingest/package.json', import.meta.url)).resolve('wrangler/package.json'))('esbuild');
async function contractSchema() {
  const out = mkdtempSync(path.join(tmpdir(), 'demo-codebase-contract-'));
  try {
    await esbuild.build({ entryPoints: [new URL('../packages/contract/src/codebase.ts', import.meta.url).pathname], outfile: path.join(out, 'codebase.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    return (await import(pathToFileURL(path.join(out, 'codebase.mjs')).href)).CodebaseReport;
  } finally { rmSync(out, { recursive: true, force: true }); }
}
/** What the schema cannot check: the envelope agrees with itself. */
function assertConsistent(envelope) {
  const { measures, byLanguage, findings } = envelope;
  assert.equal(measures.languages, byLanguage.length);
  assert.equal(byLanguage.reduce((n, row) => n + row.code_lines, 0), measures.code_lines);
  assert.equal(byLanguage.reduce((n, row) => n + row.files, 0), measures.files);
  assert.ok(byLanguage.every((row, i, rows) => i === 0 || rows[i - 1].code_lines >= row.code_lines));
  assert.ok(envelope.repository.committedAt < envelope.generatedAt);
  assert.equal(measures.duplication_percent, Math.round(measures.duplicated_lines / measures.code_lines * 1000) / 10);
  assert.ok(findings.duplicates.reduce((n, block) => n + block.lines, 0) <= measures.duplicated_lines);
  assert.ok(findings.duplicates.every((block, i, rows) => i === 0 || rows[i - 1].lines >= block.lines));
  assert.ok(findings.complexFunctions.length <= measures.complex_functions);
  assert.ok(findings.complexFunctions.every(fn => fn.complexity > 15 && fn.complexity <= measures.max_function_complexity));
  assert.ok(findings.unused.filter(item => item.kind === 'file').length <= (measures.unused_files ?? 0));
  assert.ok(findings.unused.filter(item => item.kind === 'dependency').length <= (measures.unused_dependencies ?? 0));
  // An absent measure carries the engine's reason; a measured one carries none.
  assert.ok(Object.keys(envelope.unmeasured).every(key => !(key in measures)));
  assert.ok(['unused_files', 'unused_exports', 'unused_dependencies', 'dependencies_direct'].every(key => key in measures || typeof envelope.unmeasured[key] === 'string'));
  // Times to the second, as the engine writes them.
  assert.match(envelope.generatedAt, /T\d\d:\d\d:\d\dZ$/u);
  assert.match(envelope.repository.committedAt, /T\d\d:\d\d:\d\dZ$/u);
  assert.ok(findings.unused.filter(item => item.kind === 'export').length <= (measures.unused_exports ?? 0));
  assert.ok(findings.largestFiles.every((file, i, rows) => i === 0 || rows[i - 1].code_lines >= file.code_lines));
}

const codebase = generateDemoScenario(options);
const seededCodebase = demoCodebaseReports(codebase);
const reportsOf = prefix => seededCodebase.filter(report => report.asset === codebase.assets.find(asset => asset.prefix === prefix).id);
const codebaseFlags = demoCodebaseVerdicts(seededCodebase, codebaseRules);
const flagsOf = (prefix, ruleId) => codebaseFlags.filter(flag => flag.asset === codebase.assets.find(asset => asset.prefix === prefix).id && (!ruleId || flag.ruleId === ruleId));
const ageOf = date => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${codebase.manifest.referenceDate}T00:00:00Z`)) / 86_400_000);
const nearestTo = (reports, age) => reports.reduce((best, report) => Math.abs(ageOf(report.date) - age) < Math.abs(ageOf(best.date) - age) ? report : best);

test('codebase reports are reproduced byte for byte and each is a valid envelope sent weekly through the cutoff', async () => {
  const CodebaseReport = await contractSchema();
  assert.equal(JSON.stringify(demoCodebaseReports(generateDemoScenario(options))), JSON.stringify(seededCodebase));
  // The scenario keeps only when each report ran, so the demo's runtime file stays bounded.
  assert.ok(JSON.stringify(codebase.codebaseRuns).length < 40_000 && JSON.stringify(codebase).length < 1_500_000);
  const other = demoCodebaseReports(generateDemoScenario({ ...options, seed: 'portfolio-v2' }));
  assert.notEqual(other[0].envelope.repository.commit, seededCodebase[0].envelope.repository.commit);
  assert.equal(new Set(seededCodebase.map(report => report.envelope.repository.commit)).size, seededCodebase.length);
  for (const asset of codebase.assets) {
    const reports = seededCodebase.filter(report => report.asset === asset.id);
    if (asset.prefix === 'fr') { assert.equal(reports.length, 0); continue; }
    assert.ok(reports.length >= 57, asset.prefix);
    assert.ok(ageOf(reports[0].date) - -asset.days < 7);
    const gaps = reports.slice(1).map((report, i) => ageOf(report.date) - ageOf(reports[i].date));
    assert.ok(gaps.slice(0, -1).every(gap => gap === 7), asset.prefix);
    assert.ok(gaps.at(-1) >= 1 && gaps.at(-1) <= 7);
    assert.equal(reports.at(-1).date, codebase.manifest.referenceDate);
    for (const report of reports) {
      const parsed = CodebaseReport.safeParse(report.envelope);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
      assert.deepEqual(parsed.data, report.envelope);
      assertConsistent(report.envelope);
      assert.equal(report.envelope.asset, asset.id);
      assert.equal(report.date, report.envelope.generatedAt.slice(0, 10));
      const lag = Date.parse(report.receivedAt) - Date.parse(report.envelope.generatedAt);
      assert.ok(lag >= 120_000 && lag < 360_000 && report.receivedAt <= options.cutoff);
      assert.equal(report.envelope.repository.remote.split('/')[0], asset.domain ? `git.${asset.domain}` : 'git.noticeos.example');
    }
  }
  // The envelopes the simulator posts after the cutoff follow the same contract.
  for (const asset of codebase.assets.filter(entry => entry.prefix !== 'fr')) {
    for (let age = 1; age <= 400; age += 9) {
      const envelope = demoCodebaseEnvelope(options.seed, asset, codebase.manifest.referenceDate, shiftDemoDay(codebase.manifest.referenceDate, age));
      assert.ok(CodebaseReport.safeParse(envelope).success, `${asset.prefix} ${age}`);
      assertConsistent(envelope);
    }
  }
  assert.throws(() => demoCodebaseEnvelope(options.seed, codebase.assets.find(asset => asset.prefix === 'fr'), codebase.manifest.referenceDate, codebase.manifest.referenceDate));
  // A cutoff before that day's measurement ends the history the day before.
  const early = generateDemoScenario({ ...options, cutoff: '2026-10-16T00:01:00.000Z' });
  assert.ok(early.codebaseRuns.every(run => run.date < '2026-10-16' && run.receivedAt <= early.manifest.cutoff));
  assert.ok(early.assets.filter(asset => asset.prefix !== 'fr').every(asset => early.codebaseRuns.filter(run => run.asset === asset.id).at(-1).date === '2026-10-15'));
});

test('Light Brief grows slowly with little repeated code, its unused code unmeasured, and raises no codebase flag', () => {
  const reports = reportsOf('lb');
  const first = reports[0].envelope.measures, last = reports.at(-1).envelope.measures;
  assert.ok(last.code_lines / first.code_lines > 1.15 && last.code_lines / first.code_lines < 1.3);
  assert.ok(reports.every(report => report.envelope.measures.duplication_percent >= 2 && report.envelope.measures.duplication_percent <= 3));
  assert.ok(reports.every(report => report.envelope.measures.complex_functions <= 10));
  assert.ok(reports.every(report => Math.abs(report.envelope.measures.test_ratio - 0.35) <= 0.03));
  // A Ruby codebase: the unused-code check does not read it and the engine reads no Gemfile, so
  // those measures are absent with the engine's reasons, never zero.
  for (const { envelope } of reports) {
    assert.ok(['unused_files', 'unused_exports', 'unused_dependencies', 'dependencies_direct'].every(key => !(key in envelope.measures)) && envelope.findings.unused.length === 0);
    assert.deepEqual(envelope.unmeasured, { unused_files: 'Unused code is checked in JavaScript, TypeScript and Python only.', unused_exports: 'Unused code is checked in JavaScript, TypeScript and Python only.',
      unused_dependencies: 'Unused packages are not measured yet.', dependencies_direct: 'No package list (package.json, requirements.txt, go.mod or Cargo.toml) was found.' });
  }
  assert.equal(reports.at(-1).envelope.byLanguage[0].language, 'Ruby');
  assert.deepEqual(flagsOf('lb'), []);
});

test('Pinwell carries a library swap\'s unused files for a month, flagged until its cleanup deploy', () => {
  const reports = reportsOf('pw');
  const peak = Math.max(...reports.map(report => report.envelope.measures.unused_files));
  assert.equal(peak, 12);
  const raised = reports.filter(report => report.envelope.measures.unused_files > 2);
  assert.ok(raised.every(report => ageOf(report.date) >= DEMO_LIBRARY_SWAP_AGE && ageOf(report.date) <= DEMO_DEPENDENCY_CLEANUP_AGE));
  assert.ok(raised.length >= 4 && raised.length <= 5);
  const flags = flagsOf('pw');
  assert.ok(flags.length >= 3 && flags.every(flag => flag.ruleId === 'codebase-unused' && flag.severity === 'info' && flag.kind === 'opportunity' && flag.resolvedAt !== null));
  const { dependencyCleanup } = codebase.manifest;
  assert.equal(dependencyCleanup.asset, 'pinwell.example');
  const after = reports.find(report => report.envelope.generatedAt > dependencyCleanup.annotationAt);
  assert.equal(after.envelope.measures.unused_files, 2);
  assert.equal(flags.at(-1).resolvedAt, after.receivedAt);
  assert.match(flags.find(flag => flag.inputs.unused_files === 12).message, /^12 files are not used\.$/u);
  assert.ok(reports.find(report => report.envelope.measures.unused_files === 12).envelope.findings.unused.some(item => item.kind === 'file' && item.path === 'app/src/lib/dates/moment-format.ts'));
  assert.ok(after.envelope.findings.unused.every(item => !/moment|axios|tippy/u.test(item.path ?? '')));
  assert.deepEqual(reports[0].envelope.paths, ['app', 'desktop']);
});

test('Weeknight Pantry\'s code balloons with repeated recipe and nutrition components, its growth and repetition flags open at the cutoff', () => {
  const reports = reportsOf('wp');
  const last = reports.at(-1).envelope.measures;
  const before = nearestTo(reports, -60).envelope.measures, month = nearestTo(reports, -30).envelope.measures;
  assert.ok(last.code_lines / before.code_lines > 1.4 && last.code_lines / before.code_lines < 1.5);
  assert.ok(last.code_lines / month.code_lines >= 1.25);
  assert.ok(before.duplication_percent <= 3.3 && last.duplication_percent >= 9 && last.duplication_percent <= 10);
  const firstOver = reports.find(report => report.envelope.measures.duplication_percent >= 8);
  assert.ok(ageOf(firstOver.date) >= -21 && ageOf(firstOver.date) <= -3);
  assert.ok(last.complex_functions > before.complex_functions);
  assert.ok(last.test_ratio < before.test_ratio);
  const open = flagsOf('wp').filter(flag => flag.resolvedAt === null);
  assert.deepEqual(open.map(flag => flag.ruleId).sort(), ['codebase-duplication', 'codebase-growth']);
  assert.ok(open.every(flag => flag.severity === 'warn' && flag.date === codebase.manifest.referenceDate));
  assert.match(open.find(flag => flag.ruleId === 'codebase-growth').message, /^The code grew \d+% in \d\d days \(\d{2},\d{3} → \d{2},\d{3} lines\)\.$/u);
  assert.match(open.find(flag => flag.ruleId === 'codebase-duplication').message, /^\d\.\d% of the code is repeated\.$/u);
  assert.ok(flagsOf('wp', 'codebase-duplication').some(flag => flag.resolvedAt !== null));
  assert.deepEqual(flagsOf('wp', 'codebase-complexity'), []);
  const paths = reports.at(-1).envelope.findings.duplicates.flatMap(block => block.files.map(file => file.path));
  assert.ok(paths.filter(path => /RecipeCard\.tsx$/u.test(path)).length >= 3 && paths.some(path => /Nutrition/u.test(path)));
  assert.ok(nearestTo(reports, -60).envelope.findings.duplicates.every(block => block.files.every(file => !/RecipeCard/u.test(file.path))));
});

test('Trail Notes\' redesign is a step in its code, its hard-to-change functions and, afterwards, its unused files', () => {
  const reports = reportsOf('tn');
  const { slide } = codebase.manifest;
  const stepIndex = reports.findIndex(report => report.envelope.generatedAt > slide.annotationAt);
  const before = reports[stepIndex - 1].envelope.measures, after = reports[stepIndex].envelope.measures;
  assert.ok(after.code_lines / before.code_lines >= 1.28 && after.code_lines / before.code_lines <= 1.32);
  assert.ok(after.complex_functions - before.complex_functions >= 5);
  assert.ok(reports.at(-1).envelope.measures.unused_files >= 14 && before.unused_files <= 3);
  assert.ok(reports.at(-1).envelope.findings.unused.some(item => item.kind === 'file' && item.path.includes('/legacy/')));
  const complexity = flagsOf('tn', 'codebase-complexity'), growth = flagsOf('tn', 'codebase-growth');
  assert.ok(complexity.length >= 1 && growth.length >= 1);
  assert.equal(complexity[0].date, reports[stepIndex].date);
  assert.ok([...complexity, ...growth].every(flag => flag.resolvedAt !== null));
  assert.match(complexity[0].message, /^\d+ more functions became hard to change in \d\d days\.$/u);
  const unused = flagsOf('tn', 'codebase-unused');
  assert.equal(unused.filter(flag => flag.resolvedAt === null).length, 1);
  assert.ok(unused.every(flag => flag.date > slide.annotationAt.slice(0, 10)));
});

test('the workflow checks: Weeknight Pantry\'s tests fail into the cutoff, and Trail Notes\' redesign breaks one build and leaves a vulnerable package open at the cutoff', () => {
  const pantry = reportsOf('wp');
  const failing = pantry.filter(report => report.envelope.measures.tests_passed === 0);
  assert.ok(failing.length >= 3);
  assert.ok(failing.every(report => ageOf(report.date) >= -20 && ageOf(report.date) <= 0));
  // One unbroken run of failing test reports, through the report on the reference day.
  assert.ok(pantry.slice(pantry.indexOf(failing[0])).every(report => report.envelope.measures.tests_passed === 0));
  assert.equal(pantry.at(-1).date, codebase.manifest.referenceDate);
  assert.ok(pantry.filter(report => ageOf(report.date) < -20).every(report => report.envelope.measures.tests_passed === 1));
  assert.ok(pantry.every(report => report.envelope.measures.build_passed === 1 && report.envelope.measures.vulnerable_dependencies === 0));

  const trail = reportsOf('tn');
  const broken = trail.filter(report => report.envelope.measures.build_passed === 0);
  assert.deepEqual(broken.map(report => ageOf(report.date)), [DEMO_REDESIGN_AGE]);
  assert.ok(trail.every(report => report.envelope.measures.tests_passed === 1));
  assert.ok(trail.filter(report => ageOf(report.date) < DEMO_REDESIGN_AGE).every(report => report.envelope.measures.vulnerable_dependencies === 0));
  assert.equal(broken[0].envelope.measures.vulnerable_dependencies, 2);
  // The redesign's two are updated away before one more arrives.
  assert.ok(trail.some(report => ageOf(report.date) > DEMO_REDESIGN_AGE && ageOf(report.date) < -10 && report.envelope.measures.vulnerable_dependencies === 0));
  assert.equal(trail.at(-1).envelope.measures.vulnerable_dependencies, 1);

  const vulnerable = flagsOf('tn', 'codebase-vulnerabilities');
  const open = vulnerable.filter(flag => flag.resolvedAt === null);
  assert.equal(open.length, 1);
  assert.equal(open[0].date, codebase.manifest.referenceDate);
  assert.ok(open[0].firedAt <= options.cutoff);
  assert.equal(open[0].message, '1 package has a known vulnerability.');
  assert.ok(open[0].severity === 'info' && open[0].kind === 'opportunity');
  assert.ok(vulnerable.some(flag => flag.resolvedAt !== null && flag.message === '2 packages have a known vulnerability.'));
  assert.ok(vulnerable.every(flag => flag.date >= broken[0].date));
  // Trail Notes is the only site with a vulnerable package.
  assert.deepEqual(codebaseFlags.filter(flag => flag.ruleId === 'codebase-vulnerabilities' && !vulnerable.includes(flag)), []);
});

test('Fresh Rows sends no codebase report and NoticeOS measures itself steadily, at its own repository\'s scale', () => {
  assert.deepEqual(reportsOf('fr'), []);
  const reports = reportsOf('no');
  const last = reports.at(-1).envelope.measures;
  // This repository's own measurement: about 176k lines, 1% repeated, 421 hard-to-change functions, tests outnumbering code.
  assert.ok(Math.abs(last.code_lines - 176_000) < 2_000 && last.complex_functions === 421 && last.test_ratio > 1);
  assert.ok(last.unused_files <= 9 && last.unused_exports <= 28 && last.commits_30d >= 140 && last.commits_30d <= 174);
  assert.ok(reports.every(report => report.envelope.measures.duplication_percent <= 1.3 && report.envelope.byLanguage[0].language === 'TypeScript'));
  assert.ok(reports.every(report => report.envelope.unmeasured.unused_dependencies === 'Unused packages are not measured yet.' && !('unused_dependencies' in report.envelope.measures)));
  assert.equal(reports[0].envelope.paths, undefined);
  assert.deepEqual(flagsOf('no'), []);
});

test('every codebase rule fires somewhere, open and resolved, with no flag before its comparison report', () => {
  const flags = codebaseFlags;
  const states = new Set(flags.map(flag => `${flag.ruleId}/${flag.resolvedAt === null ? 'open' : 'resolved'}`));
  for (const state of ['codebase-growth/open', 'codebase-growth/resolved', 'codebase-duplication/open', 'codebase-duplication/resolved', 'codebase-unused/open', 'codebase-unused/resolved', 'codebase-complexity/resolved', 'codebase-vulnerabilities/open', 'codebase-vulnerabilities/resolved']) assert.ok(states.has(state), state);
  for (const flag of flags) {
    assert.ok(flag.resolvedAt === null || flag.resolvedAt > flag.firedAt);
    if (flag.ruleId === 'codebase-growth' || flag.ruleId === 'codebase-complexity') assert.ok(flag.inputs.comparison.days >= 28 && flag.inputs.comparison.days <= 45);
    assert.equal(flag.inputs.report.reportDate, flag.date);
  }
  // One open flag per site and rule at most.
  const open = flags.filter(flag => flag.resolvedAt === null).map(flag => `${flag.asset}/${flag.ruleId}`);
  assert.equal(new Set(open).size, open.length);
  // The very first report of a site has nothing to compare and holds no 30-day flag.
  const single = demoCodebaseVerdicts(reportsOf('tn').slice(-1), codebaseRules);
  assert.ok(single.every(flag => flag.ruleId !== 'codebase-growth' && flag.ruleId !== 'codebase-complexity'));
});
