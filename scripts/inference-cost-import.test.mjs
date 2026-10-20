import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OS_PLACEHOLDER,
  inferenceExternalId,
  inferenceRows,
  main,
  parseUsageCsv,
  splitCsvLine,
} from './inference-cost-import.mjs';

const EXPORT = [
  'month,provider,amount,asset,ref',
  '2026-09,Anthropic,12.004,,task-1',
  '2026-09,anthropic,"1,000.50",,task-2',
  '2026-09,anthropic,3.10,example.com,task-3',
  '',
  '2026-10,openai,$0.40,example.com,',
].join('\n');

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

test('splits quoted cells that hold commas and doubled quotes', () => {
  assert.deepEqual(splitCsvLine('a, "b,c" ,"say ""hi"""'), ['a', 'b,c', 'say "hi"']);
  assert.throws(() => splitCsvLine('a,"b'), /unterminated quote/);
});

test('parses each line, lowercasing the provider and leaving a blank asset to the OS', () => {
  const entries = parseUsageCsv(EXPORT);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { line: 2, period: '2026-09', provider: 'anthropic', asset: null, amount: 12.004, ref: 'task-1' });
  assert.equal(entries[1].amount, 1000.5);
  assert.deepEqual(entries[3], { line: 6, period: '2026-10', provider: 'openai', asset: 'example.com', amount: 0.4, ref: null });
});

test('reads the columns in any order and without the optional ones', () => {
  const entries = parseUsageCsv('Amount,Month,Provider\r\n5,2026-01,openai\r\n');
  assert.deepEqual(entries, [{ line: 2, period: '2026-01', provider: 'openai', asset: null, amount: 5, ref: null }]);
});

test('sums lines into one estimated inference row per month, provider and asset', () => {
  const rows = inferenceRows(parseUsageCsv(EXPORT), 'os-asset');
  assert.deepEqual(rows.map((row) => [row.period, row.asset, row.source, row.amount, row.external_id]), [
    ['2026-09', 'example.com', 'inference:anthropic', 3.1, '2026-09/anthropic/example.com'],
    ['2026-09', 'os-asset', 'inference:anthropic', 1012.5, '2026-09/anthropic/os-asset'],
    ['2026-10', 'example.com', 'inference:openai', 0.4, '2026-10/openai/example.com'],
  ]);
  for (const row of rows) {
    assert.equal(row.kind, 'cost');
    assert.equal(row.family, 'inference');
    assert.equal(row.booking_state, 'estimated');
  }
  // One ref rides on the row; several are listed in the note instead.
  assert.equal(rows[0].ref, 'task-3');
  assert.equal(rows[1].ref, undefined);
  assert.match(rows[1].note, /2 line\(s\); refs: task-1, task-2$/);
});

test('gives the same rows the same ids however the export is ordered', () => {
  const [header, ...body] = EXPORT.split('\n');
  const reversed = [header, ...body.reverse()].join('\n');
  const ids = (text) => inferenceRows(parseUsageCsv(text), 'os-asset').map((row) => row.external_id);
  assert.deepEqual(ids(reversed), ids(EXPORT));
  assert.equal(inferenceExternalId('2026-09', 'anthropic', 'os-asset'), '2026-09/anthropic/os-asset');
});

test('books nothing for a group that rounds to zero cents', () => {
  assert.deepEqual(inferenceRows(parseUsageCsv('month,provider,amount\n2026-01,openai,0.004\n'), 'os-asset'), []);
});

test('refuses a malformed line and names its line number', () => {
  const cases = [
    ['month,provider,amount\n2026-1,openai,5\n', /^line 2: month '2026-1' is not YYYY-MM$/],
    ['month,provider,amount\n2026-01,openai,5\n\n2026-02,openai,-3\n', /^line 4: amount '-3'/],
    ['month,provider,amount\n2026-01,open ai,5\n', /^line 2: provider 'open ai'/],
    ['month,provider,amount\n2026-01,openai\n', /^line 2: 2 cell\(s\) where the header has 3$/],
    ['month,provider,amount,asset\n2026-01,openai,5,a b\n', /^line 2: asset 'a b'/],
    ['month,provider,amount\n2026-01,"openai,5\n', /^line 2: unterminated quote$/],
    ['month,provider\n2026-01,openai\n', /^line 1: missing column 'amount'$/],
    ['month,provider,amount,currency\n', /^line 1: unknown column 'currency'/],
    ['\n\n', /the file is empty/],
  ];
  for (const [text, message] of cases) assert.throws(() => parseUsageCsv(text), { message });
});

test('a dry run prints the rows and contacts nothing', async () => {
  const io = capture();
  const code = await main(['--file', 'usage.csv', '--dry-run'], {
    env: { OPERATOR_TOKEN: 'test-operator-token' },
    readText: () => EXPORT,
    fetchImpl: () => assert.fail('a dry run must not contact the ingest route'),
    ...io,
  });
  assert.equal(code, 0);
  const printed = io.out.join('\n');
  assert.match(printed, new RegExp(`2026-09  ${OS_PLACEHOLDER.replace(/[()]/g, '\\$&')}\\s+inference:anthropic\\s+\\$\\s+1012\\.50  2026-09/anthropic/\\(OS asset\\)`));
  assert.match(printed, /2026-10  example\.com\s+inference:openai\s+\$\s+0\.40/);
  assert.match(printed, /3 row\(s\), \$1016\.00/);
  assert.match(printed, /--dry-run — nothing sent\./);
  assert.deepEqual(io.err, []);
});

test('a malformed file posts nothing and exits 1 with the line number', async () => {
  const io = capture();
  const code = await main(['--file', 'usage.csv'], {
    env: { OPERATOR_TOKEN: 'test-operator-token' },
    readText: () => 'month,provider,amount\n2026-01,openai,abc\n',
    fetchImpl: () => assert.fail('a refused file must not be posted'),
    ...io,
  });
  assert.equal(code, 1);
  assert.deepEqual(io.err, ["usage.csv: line 2: amount 'abc' is not a USD figure of at least 0"]);
});

test('requires --file', async () => {
  const io = capture();
  assert.equal(await main(['--dry-run'], { ...io }), 2);
  assert.match(io.err.at(-1), /usage: pnpm cost:import-inference -- --file <csv>/);
});

test('posts the rows with the OS asset the store names, under the operator bearer', async () => {
  const io = capture();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/api/os-asset')
      ? { asset: 'os-asset' }
      : { inserted: 3, alreadyImported: 0, failed: 0, results: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const code = await main(['--', '--file', 'usage.csv'], {
    env: { OPERATOR_TOKEN: 'test-operator-token', INGEST_URL: 'http://ingest.test' },
    readText: () => EXPORT,
    fetchImpl,
    ...io,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.url), ['http://ingest.test/api/os-asset', 'http://ingest.test/api/revenue']);
  assert.equal(calls[1].init.headers.authorization, 'Bearer test-operator-token');
  const posted = JSON.parse(calls[1].init.body);
  assert.deepEqual(posted.map((row) => row.external_id),
    ['2026-09/anthropic/example.com', '2026-09/anthropic/os-asset', '2026-10/openai/example.com']);
  assert.match(io.out.at(-1), /booked 3 · replayed 0 · failed 0/);
});

test('refuses to post OS rows when the store has no OS asset', async () => {
  const io = capture();
  const code = await main(['--file', 'usage.csv'], {
    env: { OPERATOR_TOKEN: 'test-operator-token', INGEST_URL: 'http://ingest.test' },
    readText: () => EXPORT,
    fetchImpl: async () => new Response(JSON.stringify({ asset: null }), { status: 200 }),
    ...io,
  });
  assert.equal(code, 1);
  assert.match(io.err[0], /no OS asset/);
});
