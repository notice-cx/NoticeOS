import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoScenario } from './demo-scenario.mjs';
import { createDemoRealtime } from './demo-realtime.mjs';

const scenario = generateDemoScenario({ seed: 'realtime-test', cutoff: '2026-10-05T12:00:00.000Z', release: 'a'.repeat(40) });
const realtime = createDemoRealtime(scenario);
const integer = value => Number.isInteger(value) && value >= 0;

test('every site with traffic gets one reading shaped like the GA4 realtime contract', () => {
  const payload = realtime.read(Date.parse('2026-10-06T14:23:00.000Z'));
  assert.equal(payload.generatedAt, '2026-10-06T14:23:00.000Z');
  assert.deepEqual(payload.assets.map(row => row.asset), scenario.assets.filter(asset => !asset.isOs).map(asset => asset.id));
  for (const reading of payload.assets) {
    assert.equal(reading.status, 'success'); assert.equal(reading.errorCode, null); assert.equal(reading.timeZone, 'UTC');
    assert.equal(reading.observedAt, payload.generatedAt); assert.equal(reading.hourlyObservedAt, payload.generatedAt);
    assert.equal(reading.activeUsersByMinute.length, 30); assert.ok(reading.activeUsersByMinute.every(integer));
    assert.ok(integer(reading.activeUsers5m) && integer(reading.activeUsers30m));
    assert.ok(reading.activeUsers30m >= reading.activeUsers5m, 'the 30-minute window holds the 5-minute one');
    assert.ok(reading.activeUsers5m >= Math.max(...reading.activeUsersByMinute.slice(-5)), 'no minute exceeds its window');
    assert.deepEqual(reading.hourlyActiveUsers.map(row => row.hour), Array.from({ length: 24 }, (_, h) => h));
    assert.ok(reading.hourlyActiveUsers.every(row => integer(row.sameDayLastWeek)));
    assert.ok(reading.hourlyActiveUsers.slice(0, 15).every(row => integer(row.today)), 'finished hours and the filling hour are counted');
    assert.ok(reading.hourlyActiveUsers.slice(15).every(row => row.today === null), 'later hours are never forecast');
  }
});

test('readings are deterministic, follow each site\'s daily users and grow within the filling hour', () => {
  const at = Date.parse('2026-10-06T14:23:00.000Z');
  assert.deepEqual(realtime.read(at), createDemoRealtime(scenario).read(at));
  const [light, pin, fresh] = realtime.read(at).assets;
  const dayTotal = reading => reading.hourlyActiveUsers.reduce((total, row) => total + row.sameDayLastWeek, 0);
  assert.ok(dayTotal(light) > dayTotal(pin) && dayTotal(pin) > dayTotal(fresh), 'busier sites read busier');
  const seeded = scenario.daily.find(row => row.asset === light.asset && row.date === '2026-09-29');
  assert.ok(dayTotal(light) > seeded.activeUsers * 1.0 && dayTotal(light) < seeded.activeUsers * 1.35, 'hourly sums sit a little above distinct users');
  assert.ok(light.activeUsers30m > 0 && light.activeUsers30m < seeded.activeUsers / 8, 'a live window is a small slice of the day');
  const later = realtime.read(Date.parse('2026-10-06T14:51:00.000Z')).assets[0];
  assert.ok(later.hourlyActiveUsers[14].today > light.hourlyActiveUsers[14].today, 'the current hour fills as minutes pass');
  assert.deepEqual(later.hourlyActiveUsers.slice(0, 14), light.hourlyActiveUsers.slice(0, 14), 'finished hours do not move');
});

test('a pulse that starts before midnight borrows yesterday\'s rate and a missing report borrows the previous day', () => {
  const early = realtime.read(Date.parse('2026-10-07T00:10:00.000Z')).assets[0];
  assert.equal(early.activeUsersByMinute.length, 30);
  assert.ok(early.hourlyActiveUsers[0].today !== null && early.hourlyActiveUsers.slice(1).every(row => row.today === null));
  // Pinwell's synthetic report is deliberately missing every 29th day after the anchor; the pulse still reads.
  const missing = realtime.read(Date.parse('2026-10-15T09:00:00.000Z')).assets.find(row => row.asset === 'pinwell.example');
  assert.ok(missing.hourlyActiveUsers[8].today > 0);
  assert.throws(() => realtime.read(Number.NaN), /refused/u);
});
