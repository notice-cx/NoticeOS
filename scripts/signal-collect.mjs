#!/usr/bin/env node
// Collect one property's DataForSEO families NOW, instead of waiting for Monday —
// or its PostHog families (bead ro-ghis.1), `--families 'posthog-*'`, with an
// optional fixed `--start/--end` window.
//
// The Monday `45 12 * * 1` cron sweeps the whole portfolio. Firing it early to
// baseline ONE property re-bills all five — on 2026-08-03 that was ~$1.60 to buy
// ~$0.07 of new data for one site's newly seeded panel. This lane asks for the one
// property (bead ro-282.1), through `POST /api/signal-collect`.
//
// IT DOES NOT OPEN THE STORE, and it does not collect anything itself. Every
// decision — which families the property is due, the $0.25-per-family reserve
// against the monthly cap, the retry budget, the archive and manifest write —
// belongs to the ingest's collector, the same one the cron runs. This script
// carries the operator's request to the loopback door and reports what came back
// (scripts/ingest-door.mjs has the one-runtime rule this obeys).
//
// IT SPENDS MONEY. Every provider call is metered, so the summary below states
// what was attempted, what landed and what it cost, in the same six decimals the
// manifest row stores. A run with any failed family exits non-zero.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DOOR,
  doorRequest,
  doorUrl,
  localDoorFetch,
  operatorToken,
} from './ingest-door.mjs';
import { POSTHOG_FAMILIES as CONTRACT_POSTHOG_FAMILIES } from '../packages/contract/src/posthog-families.mjs';

/** The collector's families, for `--help` and for catching a typo before it
 * becomes a 422. The ingest validates the real list
 * (`DATAFORSEO_REPORTS` in workers/ingest/src/dataforseo-dumps.ts); this copy
 * only shapes the error message, and is never the authority. */
const KNOWN_FAMILIES = [
  'ranked-keywords',
  'backlinks-summary',
  'backlinks-new-lost',
  'llm-mentions-google',
  'llm-mentions-chatgpt',
  'serp-panel',
];

/** PostHog's families (bead ro-ghis.1), named `posthog-<family>`; `posthog-*`
 * asks for all six. Read from the contract's own list (bead ro-ghis.4) rather
 * than copied, so a family the ingest collects is never refused here first. */
const POSTHOG_FAMILIES = CONTRACT_POSTHOG_FAMILIES.map((family) => `posthog-${family}`);
const POSTHOG_ALL = 'posthog-*';

function isPosthog(family) {
  return family === 'posthog' || family === POSTHOG_ALL || family.startsWith('posthog-');
}

function usage() {
  console.log(`Usage:
  pnpm signals:collect -- --asset example.com [--families serp-panel]
  pnpm signals:collect -- --asset example.com --families 'posthog-*' [--start 2026-09-08 --end 2026-09-22]

Collect one property's DataForSEO families now, on the day it needs a baseline,
instead of waiting for the Monday 12:45 UTC sweep. Every call is metered.

Or collect its PostHog product analytics families now, instead of waiting for
the daily 12:30 UTC archive. PostHog charges nothing per query, but its hourly
query allowance applies; a refusal stops the run and names what was skipped.

Options:
  --asset <id>          required property id (must be launched and have a domain)
  --families <a,b>      only these families; repeatable and comma-separated.
                        Default: every DataForSEO family the property is due.
                        DataForSEO: ${KNOWN_FAMILIES.join(', ')}
                        PostHog: ${POSTHOG_ALL} or posthog (all six), or ${POSTHOG_FAMILIES.join(', ')}
                        Quote ${POSTHOG_ALL} in zsh, or it is read as a file pattern.
  --start <YYYY-MM-DD>  PostHog only: one fixed window for every family, inclusive,
  --end <YYYY-MM-DD>    in the PostHog project's timezone. Both or neither; at most
                        28 days. Default: each family's own trailing window.
  --door <url>          local ingest base url (default ${DEFAULT_DOOR})

Notes:
  · The tracked SERP panel is ONE provider call per tracked query PER DEVICE
    (phone and desktop), so a panel collection takes a few minutes. Narrow with
    --families to pay for the one thing you came for.
  · Same-day multi-call reruns reuse every successful paid call and purchase
    only missing or failed calls. A new report day starts a fresh collection.
    Identical completed content is stored as 'unchanged'.
  · \`pnpm os:up\` must be running — this reaches the store through it.
`);
}

export function parseArgs(argv) {
  let asset = null;
  const families = [];
  let door = DEFAULT_DOOR;
  let start = null;
  let end = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') asset = value;
    else if (arg === '--families') {
      for (const family of value.split(',')) {
        const trimmed = family.trim();
        if (trimmed !== '') families.push(trimmed);
      }
    } else if (arg === '--door') door = value;
    else if (arg === '--start') start = value;
    else if (arg === '--end') end = value;
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!asset || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('--asset is required and must be a property id such as example.com.');
  }
  // Checked here so a typo costs a sentence rather than a round trip — but the
  // ingest checks it again against the list that actually drives the sweep.
  const known = [...KNOWN_FAMILIES, 'posthog', POSTHOG_ALL, ...POSTHOG_FAMILIES];
  const unknown = families.filter((family) => !known.includes(family));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown report ${unknown.length === 1 ? 'family' : 'families'}: ${unknown.join(', ')}. ` +
        `One of: ${known.join(', ')}.`,
    );
  }
  const repeated = families.filter((family, index) => families.indexOf(family) !== index);
  if (repeated.length > 0) {
    throw new Error(`--families repeats ${repeated[0]}; each family is collected once.`);
  }
  const posthog = families.filter(isPosthog);
  if (posthog.length > 0 && posthog.length !== families.length) {
    throw new Error('--families mixes PostHog and DataForSEO; collect one provider per run.');
  }
  if ((posthog.includes(POSTHOG_ALL) || posthog.includes('posthog')) && families.length > 1) {
    throw new Error(`${POSTHOG_ALL} already names every PostHog family; name it alone.`);
  }
  if ((start === null) !== (end === null)) {
    throw new Error('--start and --end are given together.');
  }
  if (start !== null) {
    if (posthog.length === 0) throw new Error('--start/--end apply to PostHog families only (--families posthog-*).');
    for (const [flag, date] of [['--start', start], ['--end', end]]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${flag} must be a YYYY-MM-DD date.`);
    }
    if (start > end) throw new Error('--start must not be after --end.');
  }
  return {
    asset,
    families: families.length > 0 ? families : null,
    door,
    ...(start !== null ? { start, end } : {}),
  };
}

/**
 * Ask the running OS to collect one property now.
 *
 * `post` is injectable so the lane is testable without a running OS — and so a
 * test can never fire a real, billed collection at the operator's live door.
 */
export async function collectSignals({
  asset,
  families = null,
  start = null,
  end = null,
  door = DEFAULT_DOOR,
  post = localDoorFetch,
  token = null,
}) {
  const request = { asset };
  if (families) request.families = families;
  if (start !== null && end !== null) Object.assign(request, { start, end });
  const response = await doorRequest(post, doorUrl(door, 'api/signal-collect', {}), {
    token: token ?? (await operatorToken()),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  return {
    asset: body?.asset ?? asset,
    families: body?.families ?? families ?? [],
    attempted: body?.attempted ?? 0,
    succeeded: body?.succeeded ?? 0,
    unchanged: body?.unchanged ?? 0,
    failed: body?.failed ?? 0,
    costUsd: body?.costUsd ?? 0,
    retried: body?.retried ?? [],
    outcomes: body?.outcomes ?? [],
    // PostHog only: what the run did not ask for, and why, and the budget
    // PostHog reported. Absent on a DataForSEO run.
    skipped: body?.skipped ?? [],
    budgetStopped: body?.budgetStopped ?? false,
    budgetRemainingBytes: body?.budgetRemainingBytes ?? null,
  };
}

/** Six decimals, the same precision `archive_runs.cost_usd` and the
 * completion log carry, so the operator's three accounts of one run agree. */
function usd(value) {
  return `$${Number(value).toFixed(6)}`;
}

/** What landed, family by family, and what it cost. A failed family names its
 * error code, because that is the word the manifest row stores and the one the
 * Tower will show. */
export function summarize(result) {
  const lines = [
    `${result.asset}: ${result.attempted} attempted, ${result.succeeded} collected, ` +
      `${result.unchanged} unchanged, ${result.failed} failed. Billed ${usd(result.costUsd)}.`,
  ];
  for (const outcome of result.outcomes) {
    const detail =
      outcome.status === 'error'
        ? outcome.errorCode
        : `${outcome.providerRows} rows`;
    lines.push(
      `  ${outcome.report.padEnd(20)} ${String(outcome.status).padEnd(9)} ` +
        `${String(detail).padEnd(24)} ${usd(outcome.costUsd)}` +
        (outcome.retries > 0 ? ` (${outcome.retries} retried)` : ''),
    );
  }
  for (const skip of result.skipped ?? []) {
    lines.push(`  ${String(skip.report ?? 'every family').padEnd(20)} skipped   ${skip.reason}: ${skip.detail}`);
  }
  if (result.budgetStopped) {
    lines.push('PostHog refused a query within its hourly allowance, so the run stopped; the skipped families above can be collected again later.');
  }
  if (result.failed > 0) {
    lines.push(
      'A failed family wrote an attempt row and is visible to the lane evidence; ' +
        're-running collects it again and re-bills what succeeds.',
    );
  }
  return lines.join('\n');
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const posthog = options.families?.some(isPosthog) === true;
    console.log(
      posthog
        ? `Collecting ${options.families.join(', ')} for ${options.asset}` +
            `${options.start ? ` over ${options.start}..${options.end}` : ''} from PostHog. ` +
            'No cost per query; PostHog’s hourly query allowance applies.'
        : `Collecting ${options.families ? options.families.join(', ') : 'every due family'} ` +
            `for ${options.asset}. Every call is metered; a tracked panel is one call per ` +
            'query and takes a couple of minutes.',
    );
    const result = await collectSignals(options);
    console.log(summarize(result));
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
