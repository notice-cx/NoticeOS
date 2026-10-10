#!/usr/bin/env node
// Book a Mediavine Journey daily-revenue export into the ledger.
//
// Journey has no API — the operator exports a CSV when they want to — so this
// is a hand-run importer rather than a cron. The export is daily; the ledger's
// grain is a month (`ledger.period` is 'YYYY-MM'), so days are summed per
// calendar month and one row per month is posted to `POST /api/revenue`, which
// owns idempotency: the same export replayed books once, and a restated figure
// is refused rather than silently merged.
//
// Partial months are booked, and say so: the month is booked as `estimated`
// with its coverage stated as fields, under the auto key (one figure per
// source/property/month/family/booking_state). A later export covering the
// full month collides on that key and the route refuses it as
// `conflicting_replay`, with both figures, which is the signal to post a
// `reconciled` row that supersedes the estimate. A coverage-scoped id would
// leave two `estimated` rows for one month both current, doubling the total.
//
//   node scripts/revenue-import-mediavine.mjs <csv> --asset example.com [--dry-run]

import { readFileSync } from 'node:fs';
import { readProductEnv } from './product-env.mjs';

const INGEST = process.env.INGEST_URL ?? 'http://127.0.0.1:8791';
/** The ledger family Journey earnings belong to (`ledger` CHECK: ads for revenue). */
const FAMILY = 'ads';
/** Namespaces the idempotency key — see the README's `<source>:<external_id>`. */
const SOURCE = 'mediavine-journey';

function parseArgs(argv) {
  const args = { csv: null, asset: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--asset') args.asset = argv[(i += 1)];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (!arg.startsWith('--') && args.csv === null) args.csv = arg;
  }
  return args;
}

/**
 * Journey prints `"Jun 1, 2026"` and `"$53.84"`. Parsed by hand rather than with
 * Date.parse, which is locale- and runtime-dependent on exactly this shape.
 */
const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

export function parseJourneyCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines.shift();
  if (!/^\s*"?Date"?\s*,\s*"?Revenue"?\s*$/i.test(header ?? '')) {
    throw new Error(
      `unexpected header: ${header}\nExpected a Journey key-metrics export with Date,Revenue columns.`,
    );
  }
  const days = [];
  for (const line of lines) {
    const cells = line.match(/"([^"]*)"|([^,]+)/g);
    if (!cells || cells.length < 2) continue;
    const raw = cells.map((c) => c.replace(/^"|"$/g, '').trim());
    const [, mon, day, year] = raw[0].match(/^(\w{3}) (\d{1,2}), (\d{4})$/) ?? [];
    if (!mon || !MONTHS[mon]) throw new Error(`unparseable date: ${raw[0]}`);
    const amount = Number(raw[1].replace(/[$,]/g, ''));
    if (!Number.isFinite(amount)) throw new Error(`unparseable revenue: ${raw[1]}`);
    days.push({
      date: `${year}-${MONTHS[mon]}-${String(day).padStart(2, '0')}`,
      amount,
    });
  }
  return days;
}

/** Sum days into months, keeping the coverage each month's figure rests on. */
export function monthlyTotals(days) {
  const months = new Map();
  for (const { date, amount } of days) {
    const period = date.slice(0, 7);
    const month = months.get(period) ?? { period, amount: 0, first: date, last: date, days: 0 };
    month.amount += amount;
    month.days += 1;
    if (date < month.first) month.first = date;
    if (date > month.last) month.last = date;
    months.set(period, month);
  }
  // Rounded once, at the end: summing cents-as-floats then rounding is exact for
  // these magnitudes, where rounding each day first would drift.
  for (const month of months.values()) month.amount = Math.round(month.amount * 100) / 100;
  return [...months.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/** Whole days in a calendar month, so a partial export can say what it missed. */
function daysInMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Upload rows keep coverage separate from the note and booking identity. */
export function journeyRows(months, asset) {
  return months.map((month) => {
    const whole = daysInMonth(month.period);
    const complete = month.days >= whole;
    return {
      kind: 'revenue',
      asset,
      period: month.period,
      family: FAMILY,
      amount: month.amount,
      source: SOURCE,
      // Journey's dashboard figure firms up after the fact and is paid later, so
      // even a complete month is an ESTIMATE until a payment reconciles it.
      // Calling a dashboard number `reconciled` would erase the very figure a
      // reconciliation is measured against.
      booking_state: 'estimated',
      coverage_start: month.first,
      coverage_end: month.last,
      coverage_complete: complete,
      note: complete
        ? `Mediavine Journey, ${month.days}/${whole} days (complete month)`
        : `Mediavine Journey, ${month.days}/${whole} days — PARTIAL, covers ${month.first}..${month.last}`,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv || !args.asset) {
    console.error(
      'usage: node scripts/revenue-import-mediavine.mjs <csv> --asset <id> [--dry-run]',
    );
    process.exit(2);
  }
  const token = process.env.OPERATOR_TOKEN ?? readProductEnv(process.env, 'operatorToken');
  if (!token && !args.dryRun) {
    console.error('OPERATOR_TOKEN is not set — it is the same bearer the OS runner uses.');
    process.exit(2);
  }

  const months = monthlyTotals(parseJourneyCsv(readFileSync(args.csv, 'utf8')));
  const rows = journeyRows(months, args.asset);

  for (const row of rows) console.log(`  ${row.period}  $${row.amount.toFixed(2)}  ${row.note}`);
  if (args.dryRun) {
    console.log(`\n--dry-run — nothing sent. ${rows.length} month(s) would be posted.`);
    return;
  }

  const response = await fetch(`${INGEST}/api/revenue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(rows),
  });
  const body = await response.json();
  if (!response.ok) {
    console.error(`\nHTTP ${response.status}`, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log(
    `\nbooked ${body.inserted} · replayed ${body.alreadyImported} · failed ${body.failed}`,
  );
  for (const result of body.results ?? []) {
    if (result.error) console.error(`  ! ${result.error}: ${result.detail ?? ''}`);
    if (result.review) console.error(`  ! row ${result.index + 1}: ${result.review.message}`);
  }
  if (body.failed > 0) process.exit(1);
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) main();
