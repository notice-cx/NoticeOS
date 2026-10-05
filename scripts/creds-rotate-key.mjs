#!/usr/bin/env node
// creds-rotate-key.mjs — re-seal every stored credential under a new
// CREDENTIALS_KEY (bead `ro-vu8d.11`, epic `ro-vu8d`, table db/0028).
//
// WHAT THIS SCRIPT IS NOT. It is not the rotation. `db/0028` shipped a
// `key_version` column that nothing could move a row between, so rotating the
// bootstrap secret used to mean every stored credential became undecryptable
// and the operator reconnected each provider by hand. The obvious fix — a
// script beside `dev-secrets.mjs` opening the same sqlite file — would have to
// DECRYPT IN NODE, and the store's one rule is that plaintext exists inside the
// ingest Worker and nowhere else. So the sweep is
// `rotateCredentialKeys()` in `workers/ingest/src/credentials.ts`, behind
// `POST /api/credentials/rotate-key`, and this file is a client that presents
// the operator token and prints what came back.
//
// IT PRINTS COUNTS AND PROVIDER IDS. Nothing else — not a field name, not a
// value, not a key, not a fragment of either. A provider id is in the shipped
// catalog (`packages/contract/src/integrations.ts`).
//
// IT ROTATES A LOCAL HOST AND NOTHING ELSE (bead `ro-vu8d.20`). The only door
// that answers is the loopback one `pnpm os:up` opens; a deployed ingest Worker
// carries the route but has no operator-facing address for it, and the Tower's
// proxy is compiled out of a production build by `__RUNNER_LANE__`. A deployed
// install RE-SEEDS instead: `wrangler secret put CREDENTIALS_KEY`, then
// reconnect each provider at /integrations — the old rows are named unreadable,
// never deleted. workers/ingest/README.md § Rotating CREDENTIALS_KEY has the
// reasoning. `--ingest` below chooses a different LOCAL door, not a remote one:
// the token it presents comes from this machine's .dev.secrets.json.
//
// THE RUNBOOK (also in workers/ingest/README.md § Rotating CREDENTIALS_KEY):
//
//   1. Generate the new key:            openssl rand -base64 32
//   2. In workers/ingest/.dev.secrets.json,
//      move the CURRENT value of CREDENTIALS_KEY to CREDENTIALS_KEY_PREVIOUS
//      and put the new value in CREDENTIALS_KEY. BOTH have to be readable at
//      once — that window is the whole operation.
//   3. pnpm os:restart            (the Worker has to see both bindings)
//   4. pnpm creds:rotate-key      (this script)
//   5. Remove CREDENTIALS_KEY_PREVIOUS, then `pnpm os:restart` again.
//   6. Open /integrations and press Test connection on each card.
//
// Steps 2, 3 and 5 are the operator's — this repo never edits a secrets file it
// was not asked to, and `os:restart` is operator-directed (AGENTS.md).
//
// Plain Node ESM, no dependencies, house style of creds-check.mjs.
//
//   pnpm creds:rotate-key
//   pnpm creds:rotate-key --ingest http://127.0.0.1:8791

import { readDevSecretBindings } from './dev-secrets.mjs';

/** Where `pnpm os:up` puts the loopback-only ingest door (scripts/runner/config.mjs
 * CONFIG.ingestPort). It is loopback by construction — the kernel, not a
 * header — which is the second guard on this route, the first being the
 * operator token below. */
export const DEFAULT_INGEST_ORIGIN = 'http://127.0.0.1:8791';

export const ROTATE_PATH = '/api/credentials/rotate-key';

/** The runbook above, as the lines printed when the Worker refuses for want
 * of the previous key: the window this command needs, opened in order. */
export const ROTATION_RUNBOOK = Object.freeze([
  '1. openssl rand -base64 32                       (the new key)',
  '2. In workers/ingest/.dev.secrets.json: the current CREDENTIALS_KEY value',
  '   moves to CREDENTIALS_KEY_PREVIOUS; the new key goes in CREDENTIALS_KEY.',
  '3. pnpm os:restart, then pnpm creds:rotate-key again.',
  '   workers/ingest/README.md § Rotating CREDENTIALS_KEY has the rest.',
]);

const c = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s };

function out(line = '') {
  process.stdout.write(line + '\n');
}

/**
 * POST the sweep and hand back what the Worker answered.
 *
 * Exported so the suite can drive it against a fake fetch: the interesting
 * behaviour here is the REPORTING contract (what a caller is told, and that no
 * secret is among it), and the crypto is pinned against real D1 and real
 * WebCrypto in `workers/ingest/test/credentials.test.ts`.
 */
export async function requestRotation({
  origin = DEFAULT_INGEST_ORIGIN,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!token) {
    throw new Error(
      'no OPERATOR_TOKEN is configured for the ingest worker — set it in ' +
        'workers/ingest/.dev.secrets.json (or .dev.vars) and restart the OS.',
    );
  }
  let response;
  try {
    response = await fetchImpl(`${origin}${ROTATE_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch (error) {
    // The thrown thing may carry the url, which is harmless here (no secret is
    // in it) — but the useful sentence is about the OS being down, not about
    // the socket.
    throw new Error(
      `${origin} did not answer (${error?.message ?? 'unreachable'}) — is \`pnpm os:up\` running?`,
    );
  }
  if (response.status === 401) {
    throw new Error(
      'the ingest refused the operator token — check OPERATOR_TOKEN matches the running Worker.',
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`the ingest answered HTTP ${response.status} with no JSON body.`);
  }
  return { status: response.status, body };
}

/** The lines this command prints, as data — so the suite asserts the report
 * rather than a transcript, and so nothing can be added to it by accident. */
export function rotationReport(body) {
  if (!body?.ok) {
    const lines = [c.red('✘ nothing was rotated'), `  ${body?.reason ?? 'the ingest refused.'}`];
    // The Worker answers the refusal as a state and a code (bead
    // `ro-ujb9.96.6.25`); the steps that open the two-key window are this
    // command's to print, because this is where the operator performs them.
    if (body?.refusal === 'previous-key-missing') lines.push('', ...ROTATION_RUNBOOK.map((step) => `  ${step}`));
    return lines;
  }
  if (body.rows === 0) {
    return [c.dim('· no stored credentials — nothing to rotate')];
  }
  if (body.rotated === 0 && body.unreadable.length === 0 && body.contended.length === 0) {
    return [
      c.green('✓ already current'),
      `  ${body.alreadyCurrent} of ${body.rows} rows are sealed at key version ${body.keyVersion}.`,
    ];
  }
  const lines = [
    c.green('✓ rotated'),
    `  ${body.rotated} re-sealed at key version ${body.keyVersion}` +
      (body.alreadyCurrent > 0 ? `, ${body.alreadyCurrent} already there` : '') +
      ` (${body.rows} rows).`,
  ];
  // NAMED, NOT DROPPED. A row neither key opens keeps its bytes and its
  // version; the operator reconnects that one card from its source system.
  if (body.unreadable.length > 0) {
    lines.push(
      c.red(`✘ ${body.unreadable.length} could not be opened by either key:`),
      `  ${body.unreadable.join(', ')}`,
      '  Reconnect each on /integrations — the stored bytes were left untouched.',
    );
  }
  if (body.contended.length > 0) {
    lines.push(
      c.yellow(`! ${body.contended.length} changed while the sweep ran:`),
      `  ${body.contended.join(', ')}`,
      '  Nothing was lost. Run this again to finish them.',
    );
  }
  return lines;
}

async function main() {
  const originArg = process.argv.indexOf('--ingest');
  const origin = originArg > 0 ? process.argv[originArg + 1] : DEFAULT_INGEST_ORIGIN;

  const { bindings } = await readDevSecretBindings();
  const { status, body } = await requestRotation({
    origin,
    token: bindings?.OPERATOR_TOKEN,
  });
  for (const line of rotationReport(body)) out(line);
  // A refusal is a 409 and a real exit code: a rotation nobody ran must not
  // look like one that succeeded in a script somebody chained this into.
  process.exitCode = status === 200 && (body.unreadable?.length ?? 0) === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${c.red('✘')} ${error.message}\n`);
    process.exitCode = 1;
  });
}
