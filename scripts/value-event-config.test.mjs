import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readStoredValueEvents } from './signal-history-analyze.mjs';
import { analyzeArchiveFixture } from './test-fixtures/signal-report.mjs';

function stored(body, version = 9, extra = {}) {
  return { token: 'test-operator', fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/config-documents');
    assert.equal(init.method, 'GET');
    return Response.json({ ready: true, documents: [{ file: 'config/value-events.json', version, body }] });
  }, ...extra };
}
const configured = (names) => ({ assets: { 'review.example': { valueEvents: names } } });
const archive = {
  schemaVersion: 1, asset: 'review.example', integration: 'ga4', report: 'events',
  reportDate: '2026-09-01', collectedAt: '2026-09-02T12:00:00.000Z', dataState: 'complete',
  providerTruncated: false, providerRows: 2,
  pages: [{ response: {
    dimensionHeaders: [{ name: 'eventName' }], metricHeaders: [{ name: 'eventCount' }, { name: 'keyEvents' }],
    rows: [
      { dimensionValues: [{ value: 'trial_started' }], metricValues: [{ value: '100' }, { value: '0' }] },
      { dimensionValues: [{ value: 'old_event' }], metricValues: [{ value: '50' }, { value: '7' }] },
    ],
  } }],
};

test('saved declarations select the current warning while historical provider labels and counts remain unchanged', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'value-config-proof-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input'); await fs.mkdir(input);
  const raw = JSON.stringify(archive); await fs.writeFile(path.join(input, 'events.json'), raw);
  // Only the stored document declares review.example. The checkout's exported
  // config/value-events.json cannot answer instead: under `pnpm test:scripts`
  // no read of it succeeds in this process (bead ro-ujb9.97,
  // scripts/test-config-isolation.mjs), so a fallback to it would fail loudly.
  let reads = 0;
  const first = await analyzeArchiveFixture({ asset: 'review.example', input, output: path.join(dir, 'first'),
    readValueEvents: async () => { reads += 1; return readStoredValueEvents(stored(configured(['trial_started']))); },
  });
  assert.equal(reads, 1);
  assert.equal(first.configuration.valueEventsVersion, 9);
  const warning = first.executiveSnapshot.items.find((item) => item.key === 'value-event-not-key-event');
  assert.match(warning.title, /trial_started/);
  const second = await analyzeArchiveFixture({ asset: 'review.example', input, output: path.join(dir, 'second'),
    readValueEvents: () => readStoredValueEvents(stored(configured(['old_event']), 10)),
  });
  assert.equal(second.configuration.valueEventsVersion, 10);
  assert.equal(second.executiveSnapshot.items.some((item) => item.key === 'value-event-not-key-event'), false);
  const firstCsv = await fs.readFile(path.join(dir, 'first/ga4-events.csv'), 'utf8');
  assert.equal(await fs.readFile(path.join(dir, 'second/ga4-events.csv'), 'utf8'), firstCsv);
  assert.match(firstCsv, /trial_started/); assert.match(firstCsv, /old_event/);
  assert.equal(await fs.readFile(path.join(input, 'events.json'), 'utf8'), raw);
});

test('empty or absent asset declarations remain explicit without manufacturing a value event', async () => {
  for (const body of [{ assets: {} }, configured([]), { assets: { 'review.example': {} } }]) {
    assert.deepEqual((await readStoredValueEvents(stored(body))).body, body);
  }
});

test('unavailable, unseeded or malformed settings stop analysis before outputs are replaced', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'value-config-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output'); await fs.mkdir(output);
  const input = path.join(dir, 'input'); await fs.mkdir(input);
  await fs.writeFile(path.join(input, 'events.json'), JSON.stringify(archive));
  await fs.writeFile(path.join(output, 'executive.json'), 'previous result');
  const unavailable = stored({}, 9, { fetchImpl: async () => Response.json({ ready: false }, { status: 503 }) });
  const absent = stored({}, 9, { fetchImpl: async () => Response.json({ ready: true, documents: [] }) });
  for (const options of [unavailable, absent, stored({}), stored({ assets: [] }), stored(configured([7]))]) {
    await assert.rejects(analyzeArchiveFixture({ asset: 'review.example', input, output,
      readValueEvents: () => readStoredValueEvents(options),
    }), /Configuration database unavailable|declarations are not stored|declarations are invalid/);
    assert.equal(await fs.readFile(path.join(output, 'executive.json'), 'utf8'), 'previous result');
    assert.deepEqual(await fs.readdir(output), ['executive.json']);
  }
});
