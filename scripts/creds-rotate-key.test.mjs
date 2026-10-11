import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INGEST_ORIGIN,
  ROTATE_PATH,
  requestRotation,
  rotationReport,
} from './creds-rotate-key.mjs';

// `pnpm creds:rotate-key`.
//
// WHAT IS PINNED HERE, and what deliberately is not. The rotation itself —
// AES-GCM, the two-key read, the atomic per-row update, the resumable pass — is
// inside the ingest Worker and is pinned against REAL D1 and REAL WebCrypto in
// `workers/ingest/test/credentials.test.ts`, which is its only home. What lives
// here is the CLIENT: that it presents the operator token to the loopback door,
// that it refuses rather than guessing when there is no token, and — the
// load-bearing part — that what it PRINTS is counts and provider ids and
// nothing else. A rotation that leaked a key into a terminal scrollback would
// be the one failure this whole store exists to prevent.

const OK = {
  ok: true,
  reason: null,
  keyVersion: 2,
  rows: 3,
  rotated: 2,
  alreadyCurrent: 1,
  unreadable: [],
  contended: [],
};

function stubFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { impl, calls };
}

test('presents the operator token to the loopback door and nothing else', async () => {
  const { impl, calls } = stubFetch(200, OK);
  await requestRotation({ token: 'operator-secret-token', fetchImpl: impl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_INGEST_ORIGIN}${ROTATE_PATH}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer operator-secret-token');
  // No body at all: the sweep takes no arguments, because the only thing that
  // decides what it does is which keys the Worker itself can see.
  assert.equal(calls[0].init.body, undefined);
  // 127.0.0.1 by construction — the door is loopback-bound by the kernel, which
  // is the second guard on the route after the token.
  assert.ok(DEFAULT_INGEST_ORIGIN.startsWith('http://127.0.0.1:'));
});

test('refuses without an operator token rather than sending an unauthenticated POST', async () => {
  const { impl, calls } = stubFetch(200, OK);
  await assert.rejects(
    () => requestRotation({ token: undefined, fetchImpl: impl }),
    /OPERATOR_TOKEN/,
  );
  assert.equal(calls.length, 0);
});

test('turns an unreachable door into the sentence that fixes it', async () => {
  await assert.rejects(
    () =>
      requestRotation({
        token: 't',
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8791');
        },
      }),
    /os:status/,
  );
});

test('names a refused token instead of reporting a rotation that never ran', async () => {
  const { impl } = stubFetch(401, {});
  await assert.rejects(() => requestRotation({ token: 'wrong', fetchImpl: impl }), /operator token/);
});

test('prints counts, and the version rows landed on', () => {
  const lines = rotationReport(OK).join('\n');
  assert.match(lines, /2 re-sealed at key version 2/);
  assert.match(lines, /1 already there/);
  assert.match(lines, /3 rows/);
});

test('says so plainly when there was nothing to do', () => {
  assert.match(rotationReport({ ...OK, rows: 0, rotated: 0, alreadyCurrent: 0 }).join('\n'), /nothing to rotate/);
  assert.match(
    rotationReport({ ...OK, rotated: 0, alreadyCurrent: 3 }).join('\n'),
    /already current/,
  );
});

test('NAMES a row neither key could open, and says the bytes were left alone', () => {
  const lines = rotationReport({ ...OK, unreadable: ['calendar'] }).join('\n');
  assert.match(lines, /calendar/);
  assert.match(lines, /left untouched/);
  assert.match(lines, /Reconnect/);
});

test('tells the operator a contended row lost nothing and to run it again', () => {
  const lines = rotationReport({ ...OK, contended: ['dataforseo'] }).join('\n');
  assert.match(lines, /dataforseo/);
  assert.match(lines, /Nothing was lost/);
});

test('carries the refusal line through verbatim, and prints the runbook for a missing previous key', () => {
  // The Worker answers a state and a code; the steps
  // are printed here, where the operator performs them.
  const lines = rotationReport({
    ok: false,
    refusal: 'previous-key-missing',
    reason: 'Nothing to rotate from · CREDENTIALS_KEY_PREVIOUS not set',
  }).join('\n');
  assert.match(lines, /CREDENTIALS_KEY_PREVIOUS not set/);
  assert.match(lines, /openssl rand -base64 32/);
  assert.match(lines, /pnpm creds:rotate-key again/);
});

test('prints no runbook for a key problem the rotation cannot fix', () => {
  const lines = rotationReport({
    ok: false,
    refusal: 'key-missing',
    reason: 'No encryption key · CREDENTIALS_KEY · openssl rand -base64 32',
  }).join('\n');
  assert.match(lines, /No encryption key/);
  assert.doesNotMatch(lines, /CREDENTIALS_KEY_PREVIOUS/);
});

test('prints no key and no credential, whatever the Worker answered', () => {
  // The rule asserted from the terminal's side: even if a future change made the
  // Worker hand back something it should not, the report is assembled from named
  // fields only and cannot pass an unknown one through.
  const hostile = {
    ...OK,
    unreadable: ['bing-webmaster'],
    contended: ['dataforseo'],
    // Fields the report does not know about must not be printed.
    key: 'SEKRIT-key-do-not-print',
    fields: { BING_WEBMASTER_API_KEY: 'SEKRIT-value-do-not-print' },
  };
  const lines = rotationReport(hostile).join('\n');
  assert.doesNotMatch(lines, /SEKRIT/);
});
