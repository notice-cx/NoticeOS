import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { DEFAULT_DOOR, localDoorFetch } from './ingest-door.mjs';
import { collectSignals, parseArgs, summarize } from './signal-collect.mjs';
import { POSTHOG_FAMILIES } from '../packages/contract/src/posthog-families.mjs';

/** The ingest's answer, as `POST /api/signal-collect` gives it. */
function stubDoor(body = {}) {
  const calls = [];
  const post = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        collected: true,
        asset: 'northwind.example',
        families: ['serp-panel'],
        attempted: 1,
        succeeded: 1,
        unchanged: 0,
        failed: 0,
        costUsd: 0.08,
        retried: [],
        outcomes: [
          {
            report: 'serp-panel',
            reportDate: '2026-08-04',
            status: 'success',
            providerRows: 20,
            objectKey: 'raw/dataforseo/dataforseo/northwind.example/serp-panel/2026-08-04/x.json.gz',
            costUsd: 0.08,
            retries: 0,
            errorCode: null,
          },
        ],
        ...body,
      }),
    };
  };
  return { post, calls };
}

test('parseArgs: one property, every due family, at the loopback door', () => {
  const options = parseArgs(['--asset', 'northwind.example']);
  assert.equal(options.asset, 'northwind.example');
  assert.equal(options.families, null);
  assert.equal(options.door, DEFAULT_DOOR);
});

test('parseArgs: --families is comma-separated and repeatable', () => {
  assert.deepEqual(
    parseArgs(['--asset', 'northwind.example', '--families', 'serp-panel,ranked-keywords']).families,
    ['serp-panel', 'ranked-keywords'],
  );
  assert.deepEqual(
    parseArgs([
      '--asset',
      'northwind.example',
      '--families',
      'serp-panel',
      '--families',
      'backlinks-summary',
    ]).families,
    ['serp-panel', 'backlinks-summary'],
  );
});

// A typo should cost a sentence, not a round trip — and never a billed call for
// the wrong thing.
test('parseArgs: refuses a malformed asset, an unknown family, a repeated one', () => {
  assert.throws(() => parseArgs(['--asset', 'NOT VALID']), /property id/);
  assert.throws(() => parseArgs(['--asset', 'northwind.example', '--families', 'serp']), /Unknown report/);
  assert.throws(
    () => parseArgs(['--asset', 'northwind.example', '--families', 'serp-panel,serp-panel']),
    /repeats serp-panel/,
  );
});

test('asks the operator-authed door for exactly the property and families named', async () => {
  const { post, calls } = stubDoor();
  const result = await collectSignals({
    asset: 'northwind.example',
    families: ['serp-panel'],
    door: 'http://door.test',
    post,
    token: 'op',
  });

  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'http://door.test/api/signal-collect');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer op');
  assert.deepEqual(JSON.parse(init.body), { asset: 'northwind.example', families: ['serp-panel'] });
  assert.equal(result.succeeded, 1);
  assert.equal(result.costUsd, 0.08);
});

// Omitting --families means "everything this property is due", and that decision
// belongs to the collector — the body must not carry an invented list.
test('omitting --families sends no families at all', async () => {
  const { post, calls } = stubDoor();
  await collectSignals({ asset: 'northwind.example', door: 'http://door.test', post, token: 'op' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { asset: 'northwind.example' });
});

test('the summary states what was attempted and what it cost, to the manifest’s precision', () => {
  const summary = summarize({
    asset: 'northwind.example',
    attempted: 2,
    succeeded: 1,
    unchanged: 0,
    failed: 1,
    costUsd: 0.091,
    outcomes: [
      {
        report: 'serp-panel',
        status: 'success',
        providerRows: 20,
        costUsd: 0.08,
        retries: 2,
        errorCode: null,
      },
      {
        report: 'backlinks-summary',
        status: 'error',
        providerRows: 0,
        costUsd: 0.011,
        retries: 0,
        errorCode: 'dataforseo_http_500',
      },
    ],
  });

  assert.match(summary, /2 attempted, 1 collected, 0 unchanged, 1 failed\. Billed \$0\.091000\./);
  assert.match(summary, /serp-panel\s+success\s+20 rows\s+\$0\.080000 \(2 retried\)/);
  // A failed family names the code the manifest row stores, not a paraphrase.
  assert.match(summary, /backlinks-summary\s+error\s+dataforseo_http_500\s+\$0\.011000/);
  assert.match(summary, /wrote an attempt row/);
});

test('a refused request fails loudly and carries the ingest’s reason', async () => {
  const post = async () => ({
    ok: false,
    status: 422,
    text: async () =>
      '{"error":"family_unavailable","detail":"acorn.example has no serp-panel to collect."}',
  });
  await assert.rejects(
    collectSignals({ asset: 'acorn.example', families: ['serp-panel'], post, token: 'op' }),
    /HTTP 422.*family_unavailable/s,
  );
});

test('a door that does not answer names os:up', async () => {
  const post = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(collectSignals({ asset: 'northwind.example', post, token: 'op' }), /os:up/);
});

test('the long-running loopback transport waits for delayed headers and sends once', async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          asset: 'meadow.example',
          families: ['serp-panel'],
          attempted: 1,
          succeeded: 1,
          unchanged: 0,
          failed: 0,
          costUsd: 0.224,
          outcomes: [],
        }),
      );
    }, 75);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const started = Date.now();
    const result = await collectSignals({
      asset: 'meadow.example',
      families: ['serp-panel'],
      door: `http://127.0.0.1:${address.port}`,
      token: 'op',
    });
    assert.ok(Date.now() - started >= 60);
    assert.equal(calls, 1);
    assert.equal(result.succeeded, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the no-header-timeout transport cannot be aimed off the local machine', async () => {
  await assert.rejects(
    localDoorFetch('https://example.com/api/signal-collect'),
    /loopback HTTP only/,
  );
});

// PostHog on demand.
test('parseArgs: PostHog families, with an optional fixed window', () => {
  assert.deepEqual(parseArgs(['--asset', 'meadow.example', '--families', 'posthog-*']), {
    asset: 'meadow.example',
    families: ['posthog-*'],
    door: DEFAULT_DOOR,
  });
  assert.deepEqual(
    parseArgs(['--', '--asset', 'meadow.example', '--families', 'posthog', '--start', '2026-09-08', '--end', '2026-09-22']),
    { asset: 'meadow.example', families: ['posthog'], door: DEFAULT_DOOR, start: '2026-09-08', end: '2026-09-22' },
  );
  assert.deepEqual(parseArgs(['--asset', 'meadow.example', '--families', 'posthog-events,posthog-funnels']).families, [
    'posthog-events',
    'posthog-funnels',
  ]);
});

// The CLI's PostHog names come from the contract's list, so no
// family the ingest collects is refused here first.
test('parseArgs: accepts every contract PostHog family, all at once', () => {
  const tags = POSTHOG_FAMILIES.map((family) => `posthog-${family}`);
  assert.deepEqual(parseArgs(['--asset', 'meadow.example', '--families', tags.join(',')]).families, tags);
});

test('parseArgs: refuses mixed providers and a window that is not PostHog’s or not whole', () => {
  assert.throws(() => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-events,serp-panel']), /one provider per run/);
  assert.throws(() => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-*,posthog-events']), /name it alone/);
  assert.throws(() => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-nope']), /Unknown report/);
  assert.throws(() => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-*', '--start', '2026-09-08']), /together/);
  assert.throws(() => parseArgs(['--asset', 'northwind.example', '--start', '2026-09-08', '--end', '2026-09-22']), /PostHog families only/);
  assert.throws(
    () => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-*', '--start', '2026-09-22', '--end', '2026-09-08']),
    /not be after/,
  );
  assert.throws(
    () => parseArgs(['--asset', 'meadow.example', '--families', 'posthog-*', '--start', '09/08/2026', '--end', '2026-09-22']),
    /YYYY-MM-DD/,
  );
});

test('a PostHog request carries its window, and the summary names what was skipped', async () => {
  const { post, calls } = stubDoor({
    asset: 'meadow.example',
    families: ['posthog-events', 'posthog-funnels'],
    attempted: 1,
    succeeded: 1,
    costUsd: 0,
    budgetStopped: true,
    skipped: [{ report: 'posthog-funnels', reason: 'budget-exhausted', detail: 'PostHog’s hourly query budget is used up.' }],
    outcomes: [
      { report: 'posthog-events', reportDate: '2026-09-22', status: 'success', providerRows: 412, objectKey: 'raw/posthog/x', costUsd: 0, retries: 0, errorCode: null },
    ],
  });
  const result = await collectSignals({
    asset: 'meadow.example',
    families: ['posthog-events', 'posthog-funnels'],
    start: '2026-09-08',
    end: '2026-09-22',
    door: 'http://door.test',
    post,
    token: 'op',
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    asset: 'meadow.example',
    families: ['posthog-events', 'posthog-funnels'],
    start: '2026-09-08',
    end: '2026-09-22',
  });
  const summary = summarize(result);
  assert.match(summary, /posthog-events\s+success\s+412 rows/);
  assert.match(summary, /posthog-funnels\s+skipped\s+budget-exhausted/);
  assert.match(summary, /hourly allowance/);
});
