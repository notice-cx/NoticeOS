#!/usr/bin/env node
// pulse-relay.mjs — relay a pull-mode site's live pulse into the LOCAL ingest worker.
//
// A PULL-mode site (the saved pull roster, config/pull.json) whose entry has
// `"format": "envelope"` computes the contract envelope at its own `url`
// (Bearer-gated) and the nightly cron reads it. Such a site has no push cron of
// its own, and while the OS runs on the operator's machine it could not reach
// localhost if it did — so this relay is the by-hand version of that same read:
// fetch the site's envelope, forward it verbatim through the local ingest's
// POST /api/pulse. The envelope is already PulseEnvelope-shaped
// (asset, generatedAt, capabilities, metrics{last24h,avg7d,total}, flags), so
// this script transforms NOTHING — any 422 is a real contract break to fix at
// the source, not to patch here.
//
// WHICH SITES: `--asset <id>`, else every enabled envelope entry in the roster —
// read from this installation, never a site written here.
//
// ONE token, both hops: ASSET_TOKENS["<site id>"] (the structured local secret
// source, gitignored) is that site's own ASSET_TOKEN — it gates the envelope
// endpoint on the way out and authenticates the pulse on the way in. See the
// ASSET_TOKEN convention in docs/11-integrations.md.
//
// Run: pnpm pulse:relay [-- --asset <id>]   (ingest must be up — pnpm os:up)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDevSecretBindings } from './dev-secrets.mjs';
import { readablePath } from './installation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * The sites to relay, from the saved pull roster: the one `asset` names, else
 * every enabled entry that serves a whole envelope. A named site that is not
 * one of those is an error, not a quiet nothing.
 */
export function envelopeTargets(roster, asset = null) {
  const rows = Array.isArray(roster) ? roster : [];
  const relayable = rows.filter(
    (row) => row && row.enabled !== false && row.format === 'envelope'
      && typeof row.asset === 'string' && typeof row.url === 'string',
  );
  if (asset === null) return relayable.map(({ asset: id, url }) => ({ asset: id, url }));
  const named = relayable.find((row) => row.asset === asset);
  if (!named) {
    throw new Error(`${asset} is not an enabled pull site that serves an envelope (config/pull.json "format": "envelope").`);
  }
  return [{ asset: named.asset, url: named.url }];
}

/** Fetch one site's self-report and forward it verbatim. True when the ingest
 * accepted it. */
export async function relayPulse({ asset, url, token, ingestUrl, fetchImpl = fetch, log = console.log, error = console.error }) {
  // 1. Fetch the site's self-report.
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    error(`${asset}: envelope fetch failed: ${res.status} ${body.slice(0, 200)}`);
    if (res.status === 401) error(`  → ASSET_TOKENS["${asset}"] does not match the site worker's ASSET_TOKEN (or it is unset there).`);
    if (res.status === 503) error('  → the site worker has no CF_ACCOUNT_ID / CF_ANALYTICS_API_TOKEN secrets yet.');
    return false;
  }
  const envelope = await res.json();
  log(`pulled envelope: asset=${envelope.asset} generatedAt=${envelope.generatedAt}`);
  for (const [name, m] of Object.entries(envelope.metrics ?? {})) {
    log(`  ${name}: last24h=${m.last24h} avg7d=${m.avg7d} total=${m.total}`);
  }
  if (envelope.flags?.length) log(`  flags: ${envelope.flags.map((f) => `${f.severity}/${f.metric}`).join(', ')}`);

  // 2. Forward verbatim to the local ingest.
  const push = await fetchImpl(`${ingestUrl}/api/pulse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const pushBody = await push.text().catch(() => '');
  if (push.status === 201) {
    log(`ingest accepted (201) — ${asset} pulse for ${envelope.generatedAt.slice(0, 10)} is in the store.`);
    return true;
  }
  error(`${asset}: ingest rejected: ${push.status} ${pushBody.slice(0, 300)}`);
  if (push.status === 422) error("  → contract violation — fix at the source (the site's pulse), do not patch the relay.");
  return false;
}

function assetArgument(argv) {
  const index = argv.indexOf('--asset');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--asset requires a site id, such as example.com.');
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const ingestUrl = process.env.INGEST_URL || 'http://localhost:8791';
  const rosterFile = readablePath('config/pull.json', { root: REPO_ROOT });
  const targets = envelopeTargets(JSON.parse(await fs.readFile(rosterFile, 'utf8')), assetArgument(argv));
  if (targets.length === 0) {
    console.error('No enabled pull site serves an envelope (config/pull.json "format": "envelope"): nothing to relay.');
    return 1;
  }
  const { bindings: vars, sourceFile } = await readDevSecretBindings();
  let tokens = {};
  try {
    tokens = JSON.parse(vars.ASSET_TOKENS || '{}');
  } catch {
    /* fall through to the per-site check below */
  }
  let failed = 0;
  for (const target of targets) {
    const token = tokens?.[target.asset];
    if (!token) {
      console.error(
        `ASSET_TOKENS in ${path.relative(REPO_ROOT, sourceFile)} has no "${target.asset}" entry — ` +
          "it must equal the ASSET_TOKEN wrangler secret on that site's worker.",
      );
      failed += 1;
      continue;
    }
    if (!(await relayPulse({ ...target, token, ingestUrl }))) failed += 1;
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err?.message ?? err);
      process.exitCode = 1;
    },
  );
}
