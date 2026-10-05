import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDemoScenario } from './demo-scenario.mjs';
import { generateDemoDisplay, seedDemoDisplay } from './demo-display.mjs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentRefusal } from './config-documents.mjs';
import { DEFAULT_WALL_LAYOUT, wallLayoutWidgets, validateWallLayout } from './wall-layout.mjs';

test('saved demo settings select actual nightly totals and a future fictional review without any fetch source', () => {
  const unchanged = JSON.stringify(DEFAULT_WALL_LAYOUT);
  for (const cutoff of ['2026-10-01T07:00:00.000Z', '2026-10-19T23:30:00.000Z', '2024-02-29T00:00:00.000Z', '2026-01-01T00:00:00.000Z']) {
    const scenario = generateDemoScenario({ seed: 'display', cutoff, release: 'a'.repeat(40) });
    const before = JSON.stringify(scenario);
    const documents = generateDemoDisplay(scenario);
    const tower = documents['config/tower.json'];
    const counters = documents['config/counters.json'];
    for (const [file, body] of Object.entries(documents)) assert.equal(documentRefusal(file, body), null);
    validateWallLayout(tower.wall.layout);
    assert.equal(tower.countdown.emoji, '📅');
    assert.equal(tower.countdown.label, 'Portfolio review');
    assert.ok(Date.parse(tower.countdown.targetAt) > Date.parse(cutoff));
    const selection = wallLayoutWidgets(tower.wall.layout).find(widget => widget.type === 'sites').settings.pulseMetrics;
    assert.deepEqual(Object.keys(selection), scenario.assets.filter(asset => !asset.isOs).map(asset => asset.id));
    for (const [asset, metrics] of Object.entries(selection)) {
      const latest = scenario.pulses.filter(pulse => pulse.asset === asset).at(-1);
      for (const metric of metrics) assert.ok(Number.isInteger(latest.metrics[metric].total));
      assert.deepEqual(counters.assets[asset].cards.map(card => card.metric), metrics);
      assert.equal(Object.hasOwn(counters.assets[asset], 'source'), false);
    }
    assert.equal(JSON.stringify(scenario), before);
  }
  assert.equal(JSON.stringify(DEFAULT_WALL_LAYOUT), unchanged);
});

test('display setup refuses altered scenario facts rather than advertising unobserved totals', () => {
  const scenario = generateDemoScenario({ seed: 'display', cutoff: '2026-10-01T07:00:00.000Z', release: 'a'.repeat(40) });
  scenario.pulses.at(-1).metrics.completed_checks.total++;
  assert.throws(() => generateDemoDisplay(scenario), /differ from their declared scenario/);
});

test('display configuration uses the normal writer, checks its readback and refuses prior custody', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-demo-display-settings-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const scenario = generateDemoScenario({ seed: 'display', cutoff: '2026-10-01T07:00:00.000Z', release: 'a'.repeat(40) });
  for (const defect of [null, 'held', 'export', 'alias', 'failed', 'skipped', 'readback']) {
    const home = path.join(base, defect ?? 'valid'); fs.mkdirSync(home);
    const installation = path.join(home, 'installation'); fs.mkdirSync(installation, { mode: 0o700 });
    if (defect === 'export') fs.writeFileSync(path.join(installation, 'tower.json'), 'preserve');
    if (defect === 'alias') { fs.renameSync(installation, installation + '.held'); fs.symlinkSync(installation + '.held', installation); }
    let saved; const calls = [];
    const helpers = {
      getConfigDocuments: async (_capability, files) => {
        calls.push('read');
        return files.map(file => ({ file, version: saved || defect === 'held' ? 1 : null, source: saved || defect === 'held' ? 'store' : 'file', body: defect === 'readback' ? {} : saved?.[file] ?? {} }));
      },
      seedConfigDocuments: async (_capability, input, now) => {
        calls.push('seed'); assert.equal(now, Date.parse(scenario.manifest.cutoff));
        assert.equal(input.actor, 'synthetic-demo-seeder');
        saved = input.documents;
        return { ok: defect !== 'failed', skipped: defect === 'skipped' ? ['tower'] : [] };
      },
    };
    const act = () => seedDemoDisplay({ home, installation, scenario, capability: {}, helpers });
    if (defect) {
      await assert.rejects(act());
      if (defect === 'export') assert.equal(fs.readFileSync(path.join(installation, 'tower.json'), 'utf8'), 'preserve');
      else assert.equal(fs.existsSync(path.join(installation, 'tower.json')), false);
      if (['held', 'export', 'alias'].includes(defect)) assert.equal(calls.includes('seed'), false);
    } else {
      const result = await act(); assert.deepEqual(calls, ['read', 'seed', 'read']);
      for (const [file, body] of Object.entries(result.documents)) {
        const exported = path.join(installation, path.basename(file));
        assert.deepEqual(JSON.parse(fs.readFileSync(exported, 'utf8')), body);
        assert.equal(fs.statSync(exported).mode & 0o777, 0o600);
      }
    }
  }
});
