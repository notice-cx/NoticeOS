#!/usr/bin/env node
// Re-seal every stored credential under a new CREDENTIALS_KEY.
//
// The sweep itself is `rotateCredentialKeys()` in
// `workers/ingest/src/credentials.ts`, behind `POST /api/credentials/rotate-key`,
// because plaintext exists inside the ingest Worker and nowhere else; this
// file presents the operator token and prints counts and provider ids,
// nothing else. It rotates a local host only: the only door that answers is
// the loopback one `pnpm os:up` opens, and `--ingest` chooses a different
// local door. The runbook is in workers/ingest/README.md § Rotating
// CREDENTIALS_KEY: both keys readable at once, restart, run, remove the
// previous key, restart again.
//
//   pnpm creds:rotate-key
//   pnpm creds:rotate-key --ingest http://127.0.0.1:8791

import { readDevSecretBindings } from './dev-secrets.mjs';

/** Where `pnpm os:up` puts the loopback-only ingest door
 * (scripts/runner/config.mjs CONFIG.ingestPort). */
export const DEFAULT_INGEST_ORIGIN = 'http://127.0.0.1:8791';

export const ROTATE_PATH = '/api/credentials/rotate-key';

/** The lines printed when the Worker refuses for want of the previous key. */
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

/** POST the sweep and hand back what the Worker answered. */
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
    // The useful sentence is about the OS being down, not the socket.
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

/** The lines this command prints, as data. */
export function rotationReport(body) {
  if (!body?.ok) {
    const lines = [c.red('✘ nothing was rotated'), `  ${body?.reason ?? 'the ingest refused.'}`];
    // The steps that open the two-key window are this command's to print,
    // because this is where the operator performs them.
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
  // A row neither key opens keeps its bytes and its version; the operator
  // reconnects that one card.
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
  // A refusal is a 409 and a real exit code.
  process.exitCode = status === 200 && (body.unreadable?.length ?? 0) === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${c.red('✘')} ${error.message}\n`);
    process.exitCode = 1;
  });
}
