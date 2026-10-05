import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyRows, monthlyTotals, parseJourneyCsv } from './revenue-import-mediavine.mjs';

/** The export's exact shape: quoted cells, `Jun 1, 2026` dates, `$` amounts,
 * zero-revenue days before the property monetized, and a month that stops
 * mid-way because the operator exported before it ended. */
const FIXTURE_CSV = `Date,Revenue
"Jun 29, 2026","$0.00"
"Jun 30, 2026","$0.00"
"Jul 1, 2026","$0.00"
"Jul 7, 2026","$4.11"
"Jul 31, 2026","$9.02"
"Aug 1, 2026","$12.50"
"Aug 2, 2026","$1,234.56"
`;

test('parses Journey dates and dollar amounts', () => {
  const days = parseJourneyCsv(FIXTURE_CSV);
  assert.equal(days.length, 7);
  assert.deepEqual(days[0], { date: '2026-06-29', amount: 0 });
  assert.deepEqual(days[3], { date: '2026-07-07', amount: 4.11 });
  // A thousands separator inside a quoted cell must not truncate the figure —
  // reading $1,234.56 as 1 would understate a month by three orders of magnitude.
  assert.deepEqual(days[6], { date: '2026-08-02', amount: 1234.56 });
});

test('refuses a file that is not a Journey key-metrics export', () => {
  assert.throws(
    () => parseJourneyCsv('Date,Sessions,Revenue\n"Jun 1, 2026",10,"$1.00"\n'),
    /unexpected header/,
  );
});

test('sums days into months and records the coverage each figure rests on', () => {
  const months = monthlyTotals(parseJourneyCsv(FIXTURE_CSV));
  assert.deepEqual(
    months.map((m) => [m.period, m.amount, m.days, m.first, m.last]),
    [
      ['2026-06', 0, 2, '2026-06-29', '2026-06-30'],
      ['2026-07', 13.13, 3, '2026-07-01', '2026-07-31'],
      ['2026-08', 1247.06, 2, '2026-08-01', '2026-08-02'],
    ],
  );
});

/**
 * A zero month is a REAL figure — "Journey was live and earned nothing" — and
 * must book rather than be skipped as falsy. Dropping it would leave a hole a
 * later month-over-month read would interpret as missing data.
 */
test('keeps a zero-revenue month', () => {
  const june = monthlyTotals(parseJourneyCsv(FIXTURE_CSV)).find((m) => m.period === '2026-06');
  assert.equal(june.amount, 0);
  assert.equal(june.days, 2);
});

/**
 * Cents are summed as floats and rounded ONCE at the end. Rounding each day
 * first would drift on a 31-row month, and the ledger stores integer cents that
 * must agree with the export a person can add up by hand.
 */
test('rounds the month once, not each day', () => {
  const csv =
    'Date,Revenue\n' +
    ['Jul 1', 'Jul 2', 'Jul 3'].map((d) => `"${d}, 2026","$0.005"`).join('\n') +
    '\n';
  const [july] = monthlyTotals(parseJourneyCsv(csv));
  assert.equal(july.amount, 0.02); // 0.015 → 0.02, not 3 × 0.01 = 0.03
});


test('upload rows state partial and complete coverage without changing their estimated booking grain', () => {
  const months = monthlyTotals(parseJourneyCsv(FIXTURE_CSV));
  const rows = journeyRows(months, 'example.com');
  assert.deepEqual(rows.map((row) => [row.coverage_start, row.coverage_end, row.coverage_complete]), [
    ['2026-06-29', '2026-06-30', false], ['2026-07-01', '2026-07-31', false], ['2026-08-01', '2026-08-02', false],
  ]);
  const complete = journeyRows(monthlyTotals(Array.from({ length: 30 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`, amount: 1,
  }))), 'example.com')[0];
  assert.deepEqual([complete.coverage_start, complete.coverage_end, complete.coverage_complete], ['2026-06-01', '2026-06-30', true]);
  for (const row of [...rows, complete]) {
    assert.equal(row.source, 'mediavine-journey');
    assert.equal(row.booking_state, 'estimated');
    assert.equal(row.family, 'ads');
    assert.equal(row.asset, 'example.com');
    assert.equal(Object.hasOwn(row, 'external_id'), false);
    assert.equal(Object.hasOwn(row, 'supersedes_external_id'), false);
  }
});
