#!/usr/bin/env node
// Book a model provider's usage export into the ledger as inference costs.
//
// No process in this repo calls a model; the agents' model spend is billed by
// the provider outside the OS, so a person exports it and this importer books
// it (docs/00-objective-and-roi.md, rule 5). The export is a CSV with the
// columns `month` (YYYY-MM), `provider`, `amount` (USD) and the optional
// `asset` (a site id; blank books to the OS asset) and `ref` (a task or change
// id). Lines are summed into one `inference` cost row per (month, provider,
// asset) and posted to `POST /api/revenue`. The row's `external_id` is those
// three, so the same export replayed books once, and a changed figure for a
// booked month is refused as `conflicting_replay`, as for every other cost.
//
//   pnpm cost:import-inference -- --file usage.csv [--dry-run]
//
// --dry-run prints the rows and contacts nothing; OS rows show as `(OS asset)`
// because the OS asset's id is read from the store only when posting.

import { readFileSync } from 'node:fs';
import { invokedDirectly } from './invoked-directly.mjs';
import { readProductEnv } from './product-env.mjs';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const ASSET = /^[^\s/]{1,120}$/u;
const AMOUNT = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u;
const REQUIRED = ['month', 'provider', 'amount'];
const OPTIONAL = ['asset', 'ref'];
/** The placeholder a dry run prints for a row booked to the OS asset. */
export const OS_PLACEHOLDER = '(OS asset)';

function parseArgs(argv) {
  const args = { file: null, dryRun: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--file') args.file = argv[(i += 1)] ?? null;
    else if (arg === '--dry-run') args.dryRun = true;
    else args.unknown.push(arg);
  }
  return args;
}

/** One CSV line's cells; quoted cells may hold commas and doubled quotes. */
export function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('unterminated quote');
  cells.push(cell.trim());
  return cells;
}

/**
 * The export's lines as entries `{ line, period, provider, asset, amount, ref }`,
 * `asset` null for the OS. Any malformed line refuses the whole file, naming
 * its 1-based line number, because a partial import would book part of a
 * month under a key that then refuses the rest.
 */
export function parseUsageCsv(text) {
  const lines = text.replace(/^﻿/u, '').split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trim() !== '');
  if (headerIndex === -1) throw new Error('the file is empty');
  const fail = (index, message) => {
    throw new Error(`line ${index + 1}: ${message}`);
  };
  let header;
  try {
    header = splitCsvLine(lines[headerIndex]).map((name) => name.toLowerCase());
  } catch (error) {
    fail(headerIndex, error.message);
  }
  for (const name of header) {
    if (![...REQUIRED, ...OPTIONAL].includes(name)) {
      fail(headerIndex, `unknown column '${name}'; the columns are ${[...REQUIRED, ...OPTIONAL].join(', ')}`);
    }
  }
  if (new Set(header).size !== header.length) fail(headerIndex, 'a column is named twice');
  for (const name of REQUIRED) {
    if (!header.includes(name)) fail(headerIndex, `missing column '${name}'`);
  }

  const entries = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    let cells;
    try {
      cells = splitCsvLine(lines[index]);
    } catch (error) {
      fail(index, error.message);
    }
    if (cells.length !== header.length) {
      fail(index, `${cells.length} cell(s) where the header has ${header.length}`);
    }
    const value = (name) => cells[header.indexOf(name)] ?? '';
    const period = value('month');
    if (!PERIOD.test(period)) fail(index, `month '${period}' is not YYYY-MM`);
    const provider = value('provider').toLowerCase();
    if (!PROVIDER.test(provider)) {
      fail(index, `provider '${value('provider')}' must be letters, digits, '.', '_' or '-'`);
    }
    const rawAmount = value('amount');
    if (!AMOUNT.test(rawAmount)) fail(index, `amount '${rawAmount}' is not a USD figure of at least 0`);
    const amount = Number(rawAmount.replace(/[$,]/gu, ''));
    const asset = value('asset') || null;
    if (asset !== null && !ASSET.test(asset)) fail(index, `asset '${asset}' is not a site id`);
    const ref = value('ref') || null;
    if (ref !== null && ref.length > 200) fail(index, 'ref is longer than 200 characters');
    entries.push({ line: index + 1, period, provider, asset, amount, ref });
  }
  return entries;
}

/** The stable id of one (month, provider, asset) row; `source` namespaces it. */
export function inferenceExternalId(period, provider, asset) {
  return `${period}/${provider}/${asset}`;
}

/**
 * One `inference` cost row per (month, provider, asset), with `osAsset` for the
 * lines whose asset is blank. Summed before rounding to cents, since provider
 * exports carry fractions of a cent per line. A month that rounds to $0 books
 * nothing: a $0 row would record spend that did not happen.
 */
export function inferenceRows(entries, osAsset) {
  const groups = new Map();
  for (const entry of entries) {
    const asset = entry.asset ?? osAsset;
    const key = inferenceExternalId(entry.period, entry.provider, asset);
    const group = groups.get(key) ?? { ...entry, asset, amount: 0, lines: 0, refs: new Set() };
    group.amount += entry.amount;
    group.lines += 1;
    if (entry.ref) group.refs.add(entry.ref);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const refs = [...group.refs].sort();
      const row = {
        kind: 'cost',
        asset: group.asset,
        period: group.period,
        family: 'inference',
        amount: Math.round(group.amount * 100) / 100,
        source: `inference:${group.provider}`,
        external_id: key,
        // A usage export is the provider's running figure, not its invoice.
        booking_state: 'estimated',
        note: `${group.provider} usage export, ${group.lines} line(s)` +
          (refs.length > 1 ? `; refs: ${refs.join(', ')}` : ''),
      };
      if (refs.length === 1) row.ref = refs[0];
      return row;
    })
    .filter((row) => row.amount > 0)
    .sort((a, b) =>
      a.period.localeCompare(b.period) || a.source.localeCompare(b.source) || a.asset.localeCompare(b.asset));
}

/** The printed table, one line per row, then the total. */
export function formatRows(rows) {
  const lines = rows.map((row) =>
    `  ${row.period}  ${row.asset.padEnd(26)} ${row.source.padEnd(22)} $${row.amount.toFixed(2).padStart(9)}  ${row.external_id}`);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  lines.push('', `  ${rows.length} row(s), $${total.toFixed(2)}`);
  return lines.join('\n');
}

async function api(ingest, route, token, fetchImpl, init) {
  const response = await fetchImpl(`${ingest}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route} → HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

export async function main(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = fetch,
  readText = (file) => readFileSync(file, 'utf8'),
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  const args = parseArgs(argv);
  if (!args.file || args.unknown.length) {
    if (args.unknown.length) error(`unknown argument(s): ${args.unknown.join(' ')}`);
    error('usage: pnpm cost:import-inference -- --file <csv> [--dry-run]');
    return 2;
  }
  let entries;
  try {
    entries = parseUsageCsv(readText(args.file));
  } catch (cause) {
    error(`${args.file}: ${cause.message}`);
    return 1;
  }
  const needsOs = entries.some((entry) => entry.asset === null);

  if (args.dryRun) {
    log(formatRows(inferenceRows(entries, OS_PLACEHOLDER)));
    log('\n--dry-run — nothing sent.');
    return 0;
  }

  const token = env.OPERATOR_TOKEN ?? readProductEnv(env, 'operatorToken');
  if (!token) {
    error('OPERATOR_TOKEN is not set — the same bearer the OS runner uses.');
    return 2;
  }
  const ingest = env.INGEST_URL ?? 'http://127.0.0.1:8791';
  try {
    let osAsset = null;
    if (needsOs) {
      osAsset = (await api(ingest, '/api/os-asset', token, fetchImpl)).asset ?? null;
      if (!osAsset) {
        error('The store has no OS asset; put a site id in the asset column of every line.');
        return 1;
      }
    }
    const rows = inferenceRows(entries, osAsset);
    log(formatRows(rows));
    if (!rows.length) return 0;
    const body = await api(ingest, '/api/revenue', token, fetchImpl, {
      method: 'POST',
      body: JSON.stringify(rows),
    });
    log(`\nbooked ${body.inserted} · replayed ${body.alreadyImported} · failed ${body.failed}`);
    for (const result of body.results ?? []) {
      if (result.error) error(`  ! row ${result.index + 1}: ${result.error}: ${result.detail ?? ''}`);
    }
    return body.failed > 0 ? 1 : 0;
  } catch (cause) {
    error(cause.message);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
