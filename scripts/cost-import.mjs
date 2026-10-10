#!/usr/bin/env node
// Book the portfolio's costs into the ledger. Three kinds: metered provider
// spend, derived from `GET /api/provider-spend` per (property, family) and the
// only cost genuinely attributable to a property; stated subscriptions, which
// the operator declares once in `config/recurring-costs.json` and which book
// every month from `from`; and amortized domains, where each prepaid annual
// order in `config/domain-costs.json` spreads evenly across the twelve months
// it covers. Everything portfolio-wide books to the OS asset, because
// splitting it needs an allocation key nobody measured
// (config/recurring-costs.README.md).
//
//   node scripts/cost-import.mjs --through 2026-08 [--from 2026-06] [--dry-run]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readablePath } from './installation.mjs';
import { readProductEnv } from './product-env.mjs';

const INGEST = process.env.INGEST_URL ?? 'http://127.0.0.1:8791';
const PERIOD = /^\d{4}-\d{2}$/;

function parseArgs(argv) {
  const args = { from: null, through: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[(i += 1)];
    else if (argv[i] === '--through') args.through = argv[(i += 1)];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** Inclusive month range, `YYYY-MM`. */
export function monthsBetween(from, through) {
  if (!PERIOD.test(from) || !PERIOD.test(through)) {
    throw new Error(`months must be YYYY-MM (got ${from}..${through})`);
  }
  const out = [];
  let [year, month] = from.split('-').map(Number);
  for (let guard = 0; guard < 240; guard += 1) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    out.push(period);
    if (period === through) return out;
    if (period > through) return out.slice(0, -1);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  throw new Error('month range exceeded 20 years — check --from/--through');
}

/** The recurring entries in force for a month, from the operator's config. */
export function recurringFor(config, period) {
  return (config.costs ?? [])
    .filter((cost) => cost.from <= period && (!cost.to || period <= cost.to))
    .map((cost) => ({
      kind: 'cost',
      asset: cost.asset,
      period,
      family: cost.family,
      amount: cost.amountUsdPerMonth,
      // The config `id` is part of the idempotency key, so renaming an entry
      // re-books every month it ever covered.
      source: `recurring:${cost.id}`,
      booking_state: 'estimated',
      note: `${cost.label} — ${cost.note}`,
    }));
}

/**
 * The twelve months a domain order covers, starting the month it was bought.
 * Whole months rather than day-proration: the ledger's grain is a month.
 */
export function amortizeDomain(order) {
  const [year, month] = order.paidOn.slice(0, 7).split('-').map(Number);
  const perMonth = order.paidUsd / 12;
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const m = month + i;
    out.push({
      period: `${year + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`,
      amount: perMonth,
    });
  }
  return out;
}

/**
 * One `infra` row per property per month, summing every domain that property
 * carries: the idempotency key is (source, kind, asset, period, family,
 * booking_state), so several domain rows under one source would collide.
 */
export function domainCostsFor(config, period) {
  const byAsset = new Map();
  for (const order of config.domains ?? []) {
    for (const slice of amortizeDomain(order)) {
      if (slice.period !== period) continue;
      const entry = byAsset.get(order.asset) ?? { amount: 0, names: [] };
      entry.amount += slice.amount;
      entry.names.push(order.domain);
      byAsset.set(order.asset, entry);
    }
  }
  return [...byAsset.entries()]
    .map(([asset, entry]) => ({
      kind: 'cost',
      asset,
      period,
      family: 'infra',
      amount: Math.round(entry.amount * 100) / 100,
      source: 'domains',
      booking_state: 'estimated',
      note: `${entry.names.length} domain(s) amortized: ${entry.names.sort().join(', ')}`,
    }))
    // A rounded-to-zero slice is not a cost anybody paid this month.
    .filter((row) => row.amount > 0)
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

async function api(path, token, init) {
  const response = await fetch(`${INGEST}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.through) {
    console.error('usage: node scripts/cost-import.mjs --through YYYY-MM [--from YYYY-MM] [--dry-run]');
    process.exit(2);
  }
  const token = process.env.OPERATOR_TOKEN ?? readProductEnv(process.env, 'operatorToken');
  if (!token) {
    console.error('OPERATOR_TOKEN is not set — the same bearer the OS runner uses.');
    process.exit(2);
  }
  // This installation's declarations, else the product's empty defaults.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const declared = async (name) => JSON.parse(await readFile(readablePath(name, { root }), 'utf8'));
  const config = await declared('config/recurring-costs.json');
  const domains = await declared('config/domain-costs.json');
  const earliest = (config.costs ?? []).reduce(
    (min, cost) => (min === null || cost.from < min ? cost.from : min),
    null,
  );
  const months = monthsBetween(args.from ?? earliest ?? args.through, args.through);

  const rows = [];
  for (const period of months) {
    rows.push(...recurringFor(config, period));
    rows.push(...domainCostsFor(domains, period));
    // A month with no provider calls contributes no row: a $0 cost would
    // assert the lanes ran and found nothing to buy.
    const spend = await api(`/api/provider-spend?period=${period}`, token);
    for (const entry of spend.byAsset) {
      if (entry.costUsd <= 0) continue;
      rows.push({
        kind: 'cost',
        asset: entry.asset,
        period,
        family: 'api',
        amount: entry.costUsd,
        source: `metered:${entry.integration}`,
        booking_state: 'estimated',
        note: `${entry.integration} — ${entry.runs} metered call(s), from its report runs`,
      });
    }
  }

  for (const row of rows) {
    console.log(
      `  ${row.period}  ${row.asset.padEnd(26)} ${row.family.padEnd(10)} $${row.amount.toFixed(2).padStart(8)}  ${row.source}`,
    );
  }
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  console.log(`\n  ${rows.length} row(s), $${total.toFixed(2)} across ${months.length} month(s)`);

  if (args.dryRun) {
    console.log('\n--dry-run — nothing sent.');
    return;
  }
  const body = await api('/api/revenue', token, {
    method: 'POST',
    body: JSON.stringify(rows),
  });
  console.log(`\nbooked ${body.inserted} · replayed ${body.alreadyImported} · failed ${body.failed}`);
  for (const result of body.results ?? []) {
    if (result.error) console.error(`  ! ${result.error}: ${result.detail ?? ''}`);
  }
  if (body.failed > 0) process.exit(1);
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) main();
