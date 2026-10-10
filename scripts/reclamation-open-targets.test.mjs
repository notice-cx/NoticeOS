// `pnpm reclamation:open-targets`: what it asks the
// ingest's door and what it writes. The door's answer is the one the ingest's
// own test reads back from a throwaway store
// (workers/ingest/test/reclamation-targets.test.ts asserts the same file), so
// the two ends read one contract.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultOutFile, main, parseArgs } from './reclamation-open-targets.mjs';
import { buildExecutiveSnapshot, reclamationTargetList } from './signal-insights.mjs';

const ANSWER = JSON.parse(readFileSync(new URL('./fixture-reclamation-import/open-targets.json', import.meta.url), 'utf8'));
const DOOR = 'http://127.0.0.1:65530';
const TOKEN = 'test-operator-token';

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-open-targets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sink() {
  const lines = [];
  return { write: (text) => lines.push(text), text: () => lines.join('') };
}

/** A door that records what it was asked and answers `body` with `status`. */
function door(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  };
  return { calls, fetchImpl };
}

async function run(argv, fetchImpl) {
  const out = sink();
  const err = sink();
  const code = await main(argv, out, err, { token: TOKEN, fetchImpl });
  return { code, out: out.text(), err: err.text() };
}

test('asks the door for the site’s open targets with the operator bearer, and writes them as the reclamation-match rule reads them', async (t) => {
  const file = path.join(scratch(t), 'nested', 'asset.example-open.json');
  const ingest = door(ANSWER);
  const result = await run(['--', '--asset', 'asset.example', '--out', file, '--door', DOOR], ingest.fetchImpl);

  assert.equal(result.code, 0, result.err);
  assert.equal(ingest.calls.length, 1);
  assert.equal(ingest.calls[0].url, `${DOOR}/api/reclamation-targets?asset=asset.example&open=1`);
  assert.equal(ingest.calls[0].init.method, 'GET');
  assert.equal(ingest.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);

  const written = JSON.parse(readFileSync(file, 'utf8'));
  // The rule's own reading of the answer, every target kept…
  assert.deepEqual(written, reclamationTargetList(ANSWER.targets));
  assert.equal(written.length, ANSWER.targets.length);
  // …which the rule reads back unchanged: exactly the shape it reads.
  assert.deepEqual(reclamationTargetList(written), written);
  assert.deepEqual(written.at(-1), {
    domain: 'museum.example.org',
    status: 'opened',
    referringPage: '',
    replaceWith: 'https://asset.example/',
  });
  assert.match(result.out, /^5 open targets for asset\.example → /u);
});

test('the written file is the rule’s input: an open target sending referral visitors raises its card', async (t) => {
  const file = path.join(scratch(t), 'open.json');
  await run(['--asset', 'asset.example', '--out', file, '--door', DOOR], door(ANSWER).fetchImpl);
  const families = new Map([
    ['ga4-traffic-sources', [{ report_date: '2026-07-28', sessionSourceMedium: 'www.museum.example.org / referral', sessions: 4 }]],
  ]);
  const card = buildExecutiveSnapshot({
    asset: 'asset.example',
    families,
    archives: [{}],
    reclamationTargets: JSON.parse(readFileSync(file, 'utf8')),
  }).items.find((item) => item.key === 'reclamation-match');
  assert.match(card?.title ?? '', /museum\.example\.org is sending visitors/u);
  assert.equal(card.evidence.find((row) => row.label === 'Open targets checked').value, '5');
});

test('a site with no open target writes an empty list and says so', async (t) => {
  const file = path.join(scratch(t), 'open.json');
  const result = await run(['--asset', 'asset.example', '--out', file, '--door', DOOR], door({ ok: true, asset: 'asset.example', targets: [] }).fetchImpl);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  assert.match(result.out, /^0 open targets for asset\.example/u);
});

test('a refusal writes nothing and names what the ingest said', async (t) => {
  const dir = scratch(t);
  const cases = [
    [door({ error: 'unknown_asset', detail: 'asset.example' }, 422).fetchImpl, /answered HTTP 422 — .*unknown_asset/u],
    [door({ error: 'too_many', detail: 'asset.example holds more than 5000 open targets' }, 409).fetchImpl, /answered HTTP 409 — .*more than 5000 open targets/u],
    [door({ ok: true, asset: 'asset.example' }).fetchImpl, /did not answer with a list of targets/u],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      /the ingest door did not answer at http:\/\/127\.0\.0\.1:65530/u,
    ],
  ];
  for (const [fetchImpl, said] of cases) {
    const file = path.join(dir, 'open.json');
    const result = await run(['--asset', 'asset.example', '--out', file, '--door', DOOR], fetchImpl);
    assert.equal(result.code, 1);
    assert.match(result.err, /^Nothing was written: /u);
    assert.match(result.err, said);
    assert.equal(existsSync(file), false);
  }
});

test('--asset is required; --out defaults to the site’s file under .local/reclamation', async () => {
  const options = parseArgs(['--asset', 'asset.example']);
  assert.equal(options.out, defaultOutFile('asset.example'));
  assert.match(options.out, /\.local\/reclamation\/asset\.example-open\.json$/u);
  assert.throws(() => parseArgs(['--out', 'x.json']), /--asset is required/u);
  assert.throws(() => parseArgs(['--asset', 'asset.example', '--csv', 'x.csv']), /Unknown option: --csv/u);
  const refused = await run(['--asset'], door(ANSWER).fetchImpl);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--asset needs a value/u);
});
