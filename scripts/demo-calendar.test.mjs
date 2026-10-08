import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { createDemoCalendar } from './demo-calendar.mjs';
import { demoCountdown } from './demo-display.mjs';

const scenario = generateDemoScenario({ seed: 'calendar-test', cutoff: '2026-10-05T12:00:00.000Z', release: 'a'.repeat(40) });
const calendar = createDemoCalendar(scenario);
const HOUR = 3_600_000;

test('one readable work feed in the ordinary calendar read shape', () => {
  const at = Date.parse('2026-10-06T13:20:30.000Z');
  const payload = calendar.read(at);
  assert.equal(payload.fetchedAt, '2026-10-06T13:20:00.000Z');
  assert.deepEqual([payload.feedsConfigured, payload.feedsOk, payload.calendars], [1, 1, [{ id: 'Work', color: null, status: 'ok' }]]);
  assert.deepEqual(payload, createDemoCalendar(scenario).read(at), 'the same minute always reads the same');
  for (const meeting of payload.meetings) {
    assert.deepEqual(Object.keys(meeting).sort(), ['allDay', 'calendar', 'endsAt', 'location', 'startsAt', 'title']);
    assert.equal(meeting.calendar, 'Work'); assert.equal(meeting.allDay, false); assert.equal(meeting.location, null);
    assert.ok(Date.parse(meeting.endsAt) > Date.parse(meeting.startsAt));
    assert.ok(meeting.title.trim().split(/\s+/u).length <= 6);
  }
});

test('the window holds meetings in progress and those starting within 48 hours, in order', () => {
  // Tuesday 16:05 UTC: the daily check-in is in progress; Thursday's 16:00 is 48 hours out minus five minutes.
  const now = Date.parse('2026-10-06T16:05:00.000Z');
  const { meetings } = calendar.read(now);
  assert.equal(meetings[0].title, 'Daily check-in'); assert.ok(Date.parse(meetings[0].startsAt) < now);
  assert.ok(meetings.every(m => Date.parse(m.endsAt) > now && Date.parse(m.startsAt) <= now + 48 * HOUR));
  assert.deepEqual(meetings.map(m => m.startsAt), [...meetings.map(m => m.startsAt)].sort());
  assert.ok(meetings.some(m => m.startsAt === '2026-10-08T16:00:00.000Z'));
  assert.ok(!meetings.some(m => m.startsAt === '2026-10-06T14:00:00.000Z' || m.startsAt === '2026-10-05T14:00:00.000Z'), 'finished meetings leave');
  assert.ok(meetings.length <= 20);
});

test('site meetings name the scenario sites, every day has one, and the countdown review is on its day', () => {
  const names = scenario.assets.filter(asset => !asset.isOs).map(asset => asset.name);
  const week = Array.from({ length: 7 }, (_, day) => calendar.read(Date.parse(`${shiftDemoDay('2026-10-04', day)}T00:00:00.000Z`)).meetings);
  for (const [day, meetings] of week.entries()) {
    assert.ok(meetings.some(m => m.startsAt.startsWith(shiftDemoDay('2026-10-04', day))), `day ${day} has a meeting`);
  }
  const titles = new Set(week.flat().map(m => m.title));
  for (const name of names) assert.ok([...titles].some(title => title.startsWith(`${name} `)), name);
  const review = demoCountdown(scenario);
  const near = calendar.read(Date.parse(review.targetAt) - 2 * HOUR).meetings;
  assert.ok(near.some(m => m.title === review.label && m.startsAt === review.targetAt));
  assert.ok(!calendar.read(Date.parse(review.targetAt) - 72 * HOUR).meetings.some(m => m.title === review.label));
});

test('an altered scenario or instant is refused', () => {
  const changed = structuredClone(scenario); changed.daily[0].sessions++;
  assert.throws(() => createDemoCalendar(changed));
  for (const value of [NaN, Infinity]) assert.throws(() => calendar.read(value));
});
