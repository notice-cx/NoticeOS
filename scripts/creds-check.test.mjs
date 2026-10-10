// creds-check.test.mjs — the pure changeset-suggestion logic.
//
// scripts/ has no vitest (house style: plain Node); this runs on the built-in
// runner:  node --test scripts/creds-check.test.mjs
//
// The rules under test:
// 1. (docs/15 flow C) a probe touches a register cell ONLY for a property it
//    actually proved AND only when that cell is still `needs-setup`.
// 2. A passed preflight probe proves credential + enrollment, not ongoing
//    health. It records proof (note + since) and NEVER edits status; runtime
//    health comes from collector evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  LANES,
  laneSource,
  lanesFor,
  probeStoreLane,
  readStoreCredentials,
  sourceNote,
  storeCredential,
  suggestChangeset,
  probeCalendar,
  probeDiscord,
  probeGA4,
  probeGSC,
  probePull,
} from './creds-check.mjs';

const NOW = '2026-07-22T12:00:00.000Z';
const DAY = '2026-07-22';
const MARKER = `Setup probe passed ${DAY} (creds:check)`;

// A register mirroring config/integrations.json's shape, with mixed states.
const register = {
  assets: {
    'meals.example': {
      gsc: { status: 'needs-setup', note: 'central pull not built', since: '2026-07-06' },
      'bing-webmaster': { status: 'needs-setup', note: 'unverified', since: '2026-07-09' },
      ga4: { status: 'needs-setup', note: '', since: '2026-07-06' },
    },
    'nosh.example': {
      gsc: { status: 'live' }, // already live — must not be touched
      'bing-webmaster': { status: 'needs-setup', note: 'unverified', since: '2026-07-09' },
    },
    'areas.example': {
      gsc: { status: 'not-applicable' }, // never applicable — must be skipped
    },
    'root-os': {
      'discord-webhooks': { status: 'needs-setup', note: 'channel not provisioned', since: '2026-07-06' },
    },
  },
};

test('records proof (one-line note + since) and does not edit status', () => {
  const r = suggestChangeset(
    [{ integrationId: 'gsc', assets: ['meals.example', 'nosh.example', 'areas.example'] }],
    register,
    NOW,
  );
  assert.ok(r, 'a suggestion is produced');
  assert.equal(r.recorded, 1, 'only meals.example/gsc qualifies');
  const cs = r.changeset;
  assert.equal(cs.version, 1);
  assert.equal(cs.createdAt, NOW);
  assert.equal(cs.slug, `probe-proved-${DAY}`);
  assert.equal(cs.ops.length, 2, 'note + since for the one cell');
  assert.deepEqual(cs.ops[0], {
    kind: 'file-json-set',
    file: 'config/integrations.json',
    pointer: '/assets/meals.example/gsc/note',
    expect: 'central pull not built',
    // One line replaces the note; it never grows a log.
    value: MARKER,
  });
  assert.deepEqual(cs.ops[1], {
    kind: 'file-json-set',
    file: 'config/integrations.json',
    pointer: '/assets/meals.example/gsc/since',
    expect: '2026-07-06',
    value: DAY,
  });
  assert.ok(!JSON.stringify(cs.ops).includes('/status'), 'a preflight never edits runtime health');
});

test('empty existing note gets the marker too', () => {
  const r = suggestChangeset([{ integrationId: 'ga4', assets: ['meals.example'] }], register, NOW);
  assert.ok(r);
  const noteOp = r.changeset.ops.find((o) => o.pointer.endsWith('/note'));
  assert.equal(noteOp.value, MARKER);
});

test('already-recorded proof is not re-appended (idempotent re-runs)', () => {
  const recorded = {
    assets: {
      'meals.example': {
        gsc: { status: 'needs-setup', note: `x ${MARKER}`, since: DAY },
      },
    },
  };
  assert.equal(suggestChangeset([{ integrationId: 'gsc', assets: ['meals.example'] }], recorded, NOW), null);
});

test('proved property that is already live yields no op', () => {
  assert.equal(suggestChangeset([{ integrationId: 'gsc', assets: ['nosh.example'] }], register, NOW), null);
});

test('proved property that is not-applicable yields no op', () => {
  assert.equal(suggestChangeset([{ integrationId: 'gsc', assets: ['areas.example'] }], register, NOW), null);
});

test('aggregates multiple lanes and dedupes repeated (asset,lane) proofs', () => {
  const r = suggestChangeset(
    [
      { integrationId: 'bing-webmaster', assets: ['meals.example', 'nosh.example'] },
      { integrationId: 'ga4', assets: ['meals.example'] },
      { integrationId: 'bing-webmaster', assets: ['meals.example'] }, // duplicate
      { integrationId: 'discord-webhooks', assets: ['root-os'] },
    ],
    register,
    NOW,
  );
  assert.ok(r);
  assert.equal(r.recorded, 4, 'four distinct proved cells');
  const notePointers = r.changeset.ops.filter((o) => o.pointer.endsWith('/note')).map((o) => o.pointer).sort();
  assert.deepEqual(notePointers, [
    '/assets/meals.example/bing-webmaster/note',
    '/assets/meals.example/ga4/note',
    '/assets/nosh.example/bing-webmaster/note',
    '/assets/root-os/discord-webhooks/note',
  ]);
});

test('no proofs → null (nothing to stage)', () => {
  assert.equal(suggestChangeset([], register, NOW), null);
});

test('unknown property in proofs is ignored, not thrown', () => {
  assert.equal(suggestChangeset([{ integrationId: 'gsc', assets: ['ghost.example'] }], register, NOW), null);
});

// A delivered Discord test proves the lane on the register's row that carries
// it, read from the register, never an OS id written into the script, and
// records exactly the note it always recorded there.
test('a delivered Discord test proves the discord-webhooks lane on the rows that carry it', async () => {
  const home = {
    assets: {
      'home-os': { 'discord-webhooks': { status: 'needs-setup', note: 'channel not provisioned', since: '2026-07-06' } },
      'shop.example': { gsc: { status: 'needs-setup' }, 'discord-webhooks': { status: 'not-applicable' } },
    },
  };
  const posts = [];
  const result = await withMockFetch(
    async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
    () => probeDiscord({ DISCORD_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/x' }, home),
  );
  assert.equal(posts.length, 1, 'one test message');
  assert.deepEqual(result.proofs, [{ integrationId: 'discord-webhooks', assets: ['home-os'] }]);
  const r = suggestChangeset(result.proofs, home, NOW);
  assert.deepEqual(
    r.changeset.ops.map((op) => [op.pointer, op.value]),
    [
      ['/assets/home-os/discord-webhooks/note', MARKER],
      ['/assets/home-os/discord-webhooks/since', DAY],
    ],
  );
  // A register with no row for the lane proves nothing, and names no one.
  const bare = await withMockFetch(
    async () => new Response(null, { status: 204 }),
    () => probeDiscord({ DISCORD_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/x' }, { assets: {} }),
  );
  assert.deepEqual(bare.proofs, [{ integrationId: 'discord-webhooks', assets: [] }]);
  assert.equal(suggestChangeset(bare.proofs, { assets: {} }, NOW), null);
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  client_email: 'signals@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};
const serviceAccountB64 = Buffer.from(JSON.stringify(serviceAccount)).toString('base64');
const signalVars = {
  GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({
    'portfolio-signals': {
      service_account_b64: serviceAccountB64,
      properties: {
        'meals.example': {
          ga4_property_id: '123456789',
          gsc_site_url: 'sc-domain:meals.example',
        },
        'nosh.example': {
          ga4_property_id: '987654321',
          gsc_site_url: 'https://Nosh.example/Recipes',
        },
      },
    },
  }),
};

function jwtPayload(requestBody) {
  const assertion = new URLSearchParams(requestBody).get('assertion');
  assert.ok(assertion, 'token request includes a JWT assertion');
  const payload = assertion.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function withMockFetch(mock, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('GA4 mints one scoped token per service account and reuses it across properties', async () => {
  const calls = [];
  const result = await withMockFetch(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === serviceAccount.token_uri) {
        assert.equal(
          jwtPayload(init.body).scope,
          'https://www.googleapis.com/auth/analytics.readonly',
        );
        return new Response(JSON.stringify({ access_token: 'ga4-token' }), { status: 200 });
      }
      assert.equal(init.headers.Authorization, 'Bearer ga4-token');
      const sessions = String(url).includes('123456789') ? '42' : '17';
      return new Response(
        JSON.stringify({ rows: [{ metricValues: [{ value: sessions }] }] }),
        { status: 200 },
      );
    },
    () => probeGA4(signalVars),
  );

  assert.equal(calls.filter((call) => call.url === serviceAccount.token_uri).length, 1);
  assert.equal(calls.filter((call) => call.url.includes(':runReport')).length, 2);
  assert.deepEqual(result.proofs, [
    { integrationId: 'ga4', assets: ['meals.example', 'nosh.example'] },
  ]);
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['pass', 'pass'],
  );
  assert.match(result.rows[0].detail, /service account portfolio-signals/);
});

test('GA4 probe resolves the compiled per-account credential binding', async () => {
  const vars = {
    GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({
      'portfolio-signals': {
        service_account_binding: 'GOOGLE_SERVICE_ACCOUNT_PORTFOLIO_SIGNALS',
        properties: {
          'meals.example': { ga4_property_id: '123456789' },
        },
      },
    }),
    GOOGLE_SERVICE_ACCOUNT_PORTFOLIO_SIGNALS: serviceAccountB64,
  };
  const result = await withMockFetch(
    async (url) =>
      String(url) === serviceAccount.token_uri
        ? new Response(JSON.stringify({ access_token: 'ga4-token' }), { status: 200 })
        : new Response(
            JSON.stringify({ rows: [{ metricValues: [{ value: '42' }] }] }),
            { status: 200 },
          ),
    () => probeGA4(vars),
  );

  assert.deepEqual(result.proofs, [
    { integrationId: 'ga4', assets: ['meals.example'] },
  ]);
  assert.equal(result.rows[0].state, 'pass');
});

test('GSC mints one scoped token and proves every exact property assigned to the account', async () => {
  const calls = [];
  const result = await withMockFetch(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === serviceAccount.token_uri) {
        assert.equal(
          jwtPayload(init.body).scope,
          'https://www.googleapis.com/auth/webmasters.readonly',
        );
        return new Response(JSON.stringify({ access_token: 'gsc-token' }), { status: 200 });
      }
      assert.equal(init.headers.Authorization, 'Bearer gsc-token');
      return new Response(
        JSON.stringify({
          siteEntry: [
            { siteUrl: 'sc-domain:meals.example', permissionLevel: 'siteFullUser' },
            { siteUrl: 'https://nosh.example/Recipes/', permissionLevel: 'siteFullUser' },
          ],
        }),
        { status: 200 },
      );
    },
    () => probeGSC(signalVars),
  );

  assert.equal(calls.filter((call) => call.url === serviceAccount.token_uri).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/webmasters/v3/sites')).length, 1);
  assert.deepEqual(result.proofs, [
    { integrationId: 'gsc', assets: ['meals.example', 'nosh.example'] },
  ]);
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['pass', 'pass'],
  );
});

test('a property assigned to two service accounts fails closed before authentication', async () => {
  const vars = {
    GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({
      first: {
        service_account_b64: serviceAccountB64,
        properties: { 'meals.example': { ga4_property_id: '123456789' } },
      },
      second: {
        service_account_b64: serviceAccountB64,
        properties: { 'meals.example': { ga4_property_id: '123456789' } },
      },
    }),
  };
  let fetches = 0;
  const result = await withMockFetch(
    async () => {
      fetches++;
      return new Response('{}', { status: 500 });
    },
    () => probeGA4(vars),
  );

  assert.equal(fetches, 0);
  assert.deepEqual(result.proofs, [{ integrationId: 'ga4', assets: [] }]);
  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /more than one GOOGLE_SIGNAL_ACCOUNTS/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-report (pull) lane — the token source. The outbound scrape presents the
// SAME per-asset map the ingest Worker checks pushes against (ASSET_TOKENS);
// a property holds one secret, so there is no second map to drift from.
// The probe reads scripts/fixture-config/pull.json, a frozen copy, never the
// checkout's config/pull.json: enabling or retiring a pull node there changes
// nothing here.
// ─────────────────────────────────────────────────────────────────────────────

const PULL_FIXTURE = fileURLToPath(new URL('./fixture-config/pull.json', import.meta.url));
const pullConfig = JSON.parse(await fs.readFile(PULL_FIXTURE, 'utf8'));
const enabledPullEntries = pullConfig.filter((e) => e.enabled !== false);
const probeFixturePull = (vars) => probePull(vars, { pullFile: PULL_FIXTURE });

test('pull probe presents each property ASSET_TOKENS entry as its scrape bearer', async () => {
  const tokens = Object.fromEntries(enabledPullEntries.map((e) => [e.asset, `${e.asset}-asset-token`]));
  const calls = [];
  const result = await withMockFetch(
    async (url, init = {}) => {
      calls.push({ url: String(url), authorization: init.headers?.Authorization });
      return new Response('d1_row_count{table="profiles"} 5000\n', { status: 200 });
    },
    () => probeFixturePull({ ASSET_TOKENS: JSON.stringify(tokens) }),
  );

  assert.equal(calls.length, enabledPullEntries.length);
  for (const entry of enabledPullEntries) {
    const call = calls.find((c) => c.url === entry.url);
    assert.ok(call, `${entry.asset} was fetched`);
    assert.equal(call.authorization, `Bearer ${tokens[entry.asset]}`);
  }
  // The sample rows vary with the stub body; what matters is that no property
  // was rejected — the bearer each one presented was its own ASSET_TOKENS entry.
  assert.deepEqual(
    result.rows.filter((row) => row.state === 'fail'),
    [],
  );
});

test('a rejected token names ASSET_TOKENS in the fix, and untokened properties are not fetched', async () => {
  const [first] = enabledPullEntries;
  const calls = [];
  const result = await withMockFetch(
    async (url) => {
      calls.push(String(url));
      return new Response('unauthorized', { status: 401 });
    },
    () => probeFixturePull({ ASSET_TOKENS: JSON.stringify({ [first.asset]: 'wrong-token' }) }),
  );

  assert.deepEqual(calls, [first.url]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].sub[0], /ASSET_TOKENS\["/);
});

test('a mapped counter the endpoint no longer serves warns by name, beside the sample', async () => {
  const prometheus = enabledPullEntries.find((e) => e.format === 'prometheus');
  const mapped = Object.values(prometheus.metrics).map((m) => m.counter);
  const [served, ...gone] = mapped;
  const probeWith = (body) =>
    withMockFetch(
      async () => new Response(body, { status: 200 }),
      () => probeFixturePull({ ASSET_TOKENS: JSON.stringify({ [prometheus.asset]: 't' }) }),
    );

  const result = await probeWith(`d1_row_count{table="${served}"} 5\nd1_row_count{table="extra"} 1\n`);
  assert.deepEqual(result.rows.map((row) => row.state), ['warn', 'pass']);
  assert.equal(result.rows[0].detail, `mapped counters absent from the response: ${gone.join(', ')}`);

  // A body with no table or counter labels samples metric names and judges no mapping.
  const unlabelled = await probeWith('process_uptime_seconds 12\n');
  assert.deepEqual(unlabelled.rows.map((row) => [row.state, row.detail]), [['pass', '1 counters — process_uptime_seconds']]);
});

test('no pullable property yet → one quiet skip row, nothing fetched', async () => {
  let fetches = 0;
  const result = await withMockFetch(
    async () => {
      fetches++;
      return new Response('{}', { status: 200 });
    },
    () => probeFixturePull({ ASSET_TOKENS: JSON.stringify({ 'not-a-pull-asset': 'x' }) }),
  );

  assert.equal(fetches, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].state, 'skip');
  assert.match(result.rows[0].detail, /ASSET_TOKENS/);
  assert.deepEqual(result.proofs, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Calendar feeds lane — the credential that is a URL.
//
// Two rules carry every case below:
// 1. The URL is the credential, so no line the lane emits may contain one —
//    not a fix, not a status detail, and not an error a failed fetch handed us
//    (Node and workerd both put the request url inside some transport errors).
//    `assertNoUrlPrinted` is that rule, asserted on every row of every case.
// 2. The lane and workers/ingest/src/calendar.ts must never disagree: the states
//    here are that module's own codes, and "configured" means what it means
//    there — including a mangled slot and a typo'd entry, which are separate
//    facts from a feed that failed and from no calendar at all.
// ─────────────────────────────────────────────────────────────────────────────

const FEED_URL =
  'https://calendar.google.com/calendar/ical/operator%40example.com/private-9f3c1b7d5e/basic.ics';
const OTHER_FEED_URL =
  'https://outlook.office365.com/owa/calendar/8ac1f0e2d4b6/reach/calendar.ics';

const ICS_BODY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'BEGIN:VEVENT',
  'UID:standup@example.com',
  'SUMMARY:Standup',
  'DTSTART:20260810T160000Z',
  'DTEND:20260810T161500Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:review@example.com',
  'SUMMARY:Roadmap review',
  'DTSTART:20260811T170000Z',
  'DTEND:20260811T180000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const SIGN_IN_PAGE =
  '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head>' +
  '<body><form action="/signin"><input name="identifier"></form></body></html>';

/** Every line the report would put on screen for these rows. */
function reportLines(rows) {
  return rows.flatMap((row) => [`${row.label}  ${row.detail}`, ...(row.sub ?? [])]);
}

/** Rule 1, checked the only way that means anything: over the whole output. */
function assertNoUrlPrinted(rows) {
  for (const line of reportLines(rows)) {
    assert.ok(!line.includes(FEED_URL), `feed url leaked: ${line}`);
    assert.ok(!line.includes(OTHER_FEED_URL), `feed url leaked: ${line}`);
    assert.ok(!line.includes('private-'), `secret path segment leaked: ${line}`);
    assert.ok(!line.includes('://'), `an address leaked: ${line}`);
  }
}

test('the calendar lane is wired into the default sweep, and a mangled slot counts as configured', () => {
  const lane = LANES.find((l) => l.id === 'calendar');
  assert.ok(lane, 'a calendar lane is registered');
  assert.equal(lane.explicit, false, 'a rotated link is silent elsewhere, so this runs unasked');
  assert.equal(lane.slots, 'CALENDAR_FEEDS');
  assert.equal(lane.configured({}), false);
  assert.equal(lane.configured({ CALENDAR_FEEDS: '   ' }), false);
  assert.equal(
    lane.configured({ CALENDAR_FEEDS: 'not json at all' }),
    true,
    'a set-but-broken slot reaches the probe instead of reading as "not configured yet"',
  );
});

test("a healthy feed passes with an event sample, under ingest's request shape, printing no url", async () => {
  const calls = [];
  const result = await withMockFetch(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(ICS_BODY, {
        status: 200,
        headers: { 'content-type': 'text/calendar; charset=UTF-8' },
      });
    },
    () => probeCalendar({ CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL }) }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FEED_URL);
  assert.match(calls[0].init.headers['user-agent'], /^NoticeOS-Calendar\/1\.0 /);
  assert.equal(calls[0].init.headers.accept, 'text/calendar, text/plain;q=0.5');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.ok(calls[0].init.signal, 'the request carries the timeout signal');

  assert.equal(result.rows.length, 1, 'one row per feed, and no blank-panel line');
  assert.equal(result.rows[0].state, 'pass');
  assert.equal(result.rows[0].label, 'Calendar · work');
  assert.match(result.rows[0].detail, /2 events/);
  assert.deepEqual(result.proofs, [], 'a calendar is display state, so it proves no register cell');
  assertNoUrlPrinted(result.rows);
});

test("a rotated link answering 403 fails as ingest's own http_403, with the fresh-link fix", async () => {
  const result = await withMockFetch(
    async () => new Response('Forbidden', { status: 403 }),
    () =>
      probeCalendar({
        CALENDAR_FEEDS: JSON.stringify({ work: { url: FEED_URL, color: '#6ea8fe' } }),
      }),
  );

  assert.equal(result.rows.length, 2, 'the feed row, then the blank-panel line');
  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /^http_403 — /);
  assert.match(result.rows[0].sub[0], /Secret address in iCal format/);
  assert.match(result.rows[0].sub[0], /CALENDAR_FEEDS\["work"\]/);
  assertNoUrlPrinted(result.rows);
});

test('a timing-out feed reports timeout without copying the error that names the url', async () => {
  const result = await withMockFetch(
    async () => {
      // The leak this lane refuses: a transport error holding the request url.
      const error = new Error(`fetch to ${FEED_URL} timed out after 10000ms`);
      error.name = 'TimeoutError';
      throw error;
    },
    () => probeCalendar({ CALENDAR_FEEDS: JSON.stringify({ personal: FEED_URL }) }),
  );

  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /^timeout — no answer within 10s/);
  assertNoUrlPrinted(result.rows);
});

test('a socket failure whose cause names the url reports unreachable and prints neither', async () => {
  const result = await withMockFetch(
    async () => {
      const error = new TypeError('fetch failed');
      error.cause = new Error(`getaddrinfo ENOTFOUND for ${FEED_URL}`);
      throw error;
    },
    () => probeCalendar({ CALENDAR_FEEDS: JSON.stringify({ personal: FEED_URL }) }),
  );

  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /^unreachable — /);
  assertNoUrlPrinted(result.rows);
});

test('HTML behind a 200 is not a calendar — the sign-in page a reset link serves', async () => {
  const result = await withMockFetch(
    async () => new Response(SIGN_IN_PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
    () => probeCalendar({ CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL }) }),
  );

  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /^not_calendar — HTTP 200/);
  assert.match(result.rows[0].sub[0], /Secret address in iCal format/);
  assertNoUrlPrinted(result.rows);
});

test('a missing CALENDAR_FEEDS is a quiet skip and fetches nothing', async () => {
  let fetches = 0;
  const result = await withMockFetch(
    async () => {
      fetches++;
      return new Response(ICS_BODY, { status: 200 });
    },
    () => probeCalendar({}),
  );

  assert.equal(fetches, 0);
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['skip'],
  );
  assert.match(result.rows[0].detail, /not configured yet — set CALENDAR_FEEDS/);
  assert.deepEqual(result.proofs, []);
});

test('a set-but-unreadable CALENDAR_FEEDS is its own state and never echoes the value', async () => {
  let fetches = 0;
  const probe = (raw) =>
    withMockFetch(
      async () => {
        fetches++;
        return new Response(ICS_BODY, { status: 200 });
      },
      () => probeCalendar({ CALENDAR_FEEDS: raw }),
    );

  // The classic: the bare secret url pasted straight into the slot.
  const bare = await probe(FEED_URL);
  assert.equal(bare.rows.length, 1);
  assert.equal(bare.rows[0].state, 'fail', 'not the quiet skip, and not a feed failing');
  assert.match(bare.rows[0].detail, /^config_unparseable — /);
  assertNoUrlPrinted(bare.rows);

  const asArray = await probe(JSON.stringify([FEED_URL]));
  assert.equal(asArray.rows[0].state, 'fail');
  assert.match(asArray.rows[0].detail, /^config_not_a_map — /);
  assertNoUrlPrinted(asArray.rows);

  assert.equal(fetches, 0, 'an unreadable slot names no feed to fetch');
});

test('an empty CALENDAR_FEEDS map is the no-calendars state, not a failing feed', async () => {
  let fetches = 0;
  const result = await withMockFetch(
    async () => {
      fetches++;
      return new Response(ICS_BODY, { status: 200 });
    },
    () => probeCalendar({ CALENDAR_FEEDS: '{}' }),
  );

  assert.equal(fetches, 0);
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['warn'],
  );
  assert.match(result.rows[0].detail, /empty map/);
});

test("a typo'd entry is counted and named, and the healthy feed beside it still passes", async () => {
  const calls = [];
  const result = await withMockFetch(
    async (url) => {
      calls.push(String(url));
      return new Response(ICS_BODY, { status: 200 });
    },
    () =>
      probeCalendar({
        CALENDAR_FEEDS: JSON.stringify({
          work: { color: '#6ea8fe' }, // the url key never got pasted in
          personal: FEED_URL,
        }),
      }),
  );

  assert.deepEqual(calls, [FEED_URL], 'an entry with no url is reported, not fetched');
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['fail', 'pass'],
  );
  assert.equal(result.rows[0].label, 'Calendar · work');
  assert.match(result.rows[0].detail, /^config_missing_url — /);
  assert.match(result.rows[0].sub[0], /CALENDAR_FEEDS\["work"\]/);
  assert.equal(result.rows[1].label, 'Calendar · personal');
  assertNoUrlPrinted(result.rows);
});

test("every feed down adds the line that names the Wall's blank meetings panel", async () => {
  const result = await withMockFetch(
    async (url) => new Response('', { status: String(url) === FEED_URL ? 404 : 500 }),
    () =>
      probeCalendar({
        CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL, personal: OTHER_FEED_URL }),
      }),
  );

  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['fail', 'fail', 'fail'],
  );
  assert.match(result.rows[0].detail, /^http_404 — /);
  assert.match(result.rows[1].detail, /^http_500 — /);
  assert.equal(result.rows[2].label, 'Calendar feeds');
  assert.match(result.rows[2].detail, /0 of 2 feeds answered/);
  assert.match(result.rows[2].detail, /meetings panel/);
  assertNoUrlPrinted(result.rows);
});

test('a label that is really a url is withheld — the map written inside out', async () => {
  let fetches = 0;
  const result = await withMockFetch(
    async () => {
      fetches++;
      return new Response(ICS_BODY, { status: 200 });
    },
    () => probeCalendar({ CALENDAR_FEEDS: JSON.stringify({ [FEED_URL]: 'work' }) }),
  );

  assert.equal(fetches, 0, '"work" is not a url, so nothing is fetched');
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ['fail', 'fail'],
  );
  assert.match(result.rows[0].label, /label withheld/);
  assert.match(result.rows[0].detail, /^invalid_url — /);
  assertNoUrlPrinted(result.rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// The STORE half. A provider connected in the product has no env binding at
// all, and must not read as "not configured yet". What is asserted here is that
// the checker asks the running OS, believes BOTH of Google's ways in, proves a
// store credential through the OS instead of decrypting anything, spends one
// test per provider rather than one per lane, and falls back to the env-only
// check, saying so, when the OS is not running.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGIN = 'http://127.0.0.1:5173';

/** One provider entry as GET /api/integrations/providers serves it. */
function providerEntry(id, credential) {
  return { provider: { id }, credential: { provider: id, missingFields: [], ...credential } };
}

/** A Tower answering the providers read, and the per-provider test route. */
function towerStub(providers, probes = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      if (String(url).endsWith('/api/integrations/providers')) {
        return new Response(JSON.stringify({ providers }), { status: 200 });
      }
      const id = String(url).match(/\/api\/integrations\/([^/]+)\/test$/)?.[1];
      const probe = probes[id];
      if (probe === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(probe), { status: 200 });
    },
  };
}

const laneById = (id) => LANES.find((lane) => lane.id === id);

test('every lane names the catalog provider it belongs to, or says it has none', () => {
  // The pointer is what lets the store half ask about a lane at all, and
  // `--lane google` select both Google lanes. A lane with neither a provider nor
  // a deliberate null would silently stay env-only forever.
  assert.deepEqual(Object.fromEntries(LANES.map((lane) => [lane.id, lane.provider])), {
    pull: null,
    bing: 'bing-webmaster',
    dataforseo: 'dataforseo',
    ga4: 'google',
    gsc: 'google',
    calendar: 'calendar',
    // Clarity is a per-asset credential, so a store-only install stops reading
    // as "not configured". It stays EXPLICIT: proving it from the environment
    // file still spends one of that asset's ten daily calls.
    clarity: 'clarity',
    // PostHog: per-asset like Clarity, but its probe is a free project-settings
    // read, so it runs in a default sweep.
    posthog: 'posthog',
    // Discord has a catalog row, so this lane can be read out of the store and
    // proved by the OS like every other one. It stays EXPLICIT either way: the
    // probe posts a real message whichever half of the move the credential is
    // on.
    discord: 'discord',
  });
});

test('--lane google selects both lanes that one credential powers', () => {
  assert.deepEqual(
    lanesFor('google').map((lane) => lane.id),
    ['ga4', 'gsc'],
  );
  assert.deepEqual(
    lanesFor('gsc').map((lane) => lane.id),
    ['gsc'],
    'a lane id still works',
  );
  assert.deepEqual(
    lanesFor(null).map((lane) => lane.id),
    LANES.map((lane) => lane.id),
  );
  assert.deepEqual(lanesFor('nonsense'), [], 'an unknown selector picks nothing');
});

test('a credential connected in the product counts as configured with no env binding', async () => {
  const tower = towerStub([
    providerEntry('google', {
      source: 'store',
      auth: 'oauth',
      fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'],
    }),
    providerEntry('bing-webmaster', {
      source: 'store',
      auth: null,
      fields: ['BING_WEBMASTER_API_KEY'],
    }),
  ]);
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });

  assert.equal(store.reachable, true);
  // Signed in, no GOOGLE_SIGNAL_ACCOUNTS anywhere: Google is configured.
  assert.equal(laneSource(laneById('gsc'), {}, store), 'store');
  assert.equal(laneSource(laneById('bing'), {}, store), 'store');
  // And with neither, it still says nothing is configured.
  assert.equal(laneSource(laneById('dataforseo'), {}, store), 'none');
});

test('a service-account credential entered in the product counts too — either way in', async () => {
  const tower = towerStub([
    providerEntry('google', {
      source: 'store',
      auth: 'service-account',
      fields: ['GOOGLE_SIGNAL_ACCOUNTS'],
    }),
  ]);
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  assert.equal(laneSource(laneById('ga4'), {}, store), 'store');
  assert.match(
    sourceNote(laneById('ga4'), 'store', store, '.dev.secrets.json'),
    /store — entered in the product \(service account\)/,
  );
});

test('a half-entered store credential is not called configured, and the env binding still answers', async () => {
  // Half-configured is its own state: reporting it as connected would put a
  // green row on a credential the collector cannot run.
  const tower = towerStub([
    providerEntry('dataforseo', {
      source: 'store',
      fields: ['DATAFORSEO_LOGIN'],
      missingFields: ['DATAFORSEO_PASSWORD'],
    }),
  ]);
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  assert.equal(storeCredential(laneById('dataforseo'), store), null);
  assert.equal(
    laneSource(laneById('dataforseo'), { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, store),
    'env',
  );
});

test('a provider still on its binding reads env even while the OS is answering', async () => {
  const tower = towerStub([providerEntry('bing-webmaster', { source: 'env', fields: [] })]);
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  assert.equal(laneSource(laneById('bing'), { BING_WEBMASTER_API_KEY: 'k' }, store), 'env');
  assert.match(
    sourceNote(laneById('bing'), 'env', store, 'workers/ingest/.dev.secrets.json'),
    /source: env — BING_WEBMASTER_API_KEY in workers\/ingest\/\.dev\.secrets\.json/,
  );
});

test('the store lane is proved by the OS, not by decrypting anything here', async () => {
  const tower = towerStub(
    [providerEntry('bing-webmaster', { source: 'store', fields: ['BING_WEBMASTER_API_KEY'] })],
    {
      'bing-webmaster': {
        ok: true,
        message: 'Reached Bing Webmaster — 3 verified sites.',
        checkedAt: NOW,
      },
    },
  );
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  const result = await probeStoreLane(laneById('bing'), store, { fetchImpl: tower.fetchImpl });

  assert.deepEqual(
    result.rows.map((row) => [row.state, row.detail]),
    [['pass', 'Reached Bing Webmaster — 3 verified sites.']],
  );
  // The proof came from the OS's own test route — the credential never left it.
  assert.deepEqual(
    tower.calls.map((call) => `${call.method} ${call.url}`),
    [
      `GET ${ORIGIN}/api/integrations/providers`,
      `POST ${ORIGIN}/api/integrations/bing-webmaster/test`,
    ],
  );
  // A provider-level test proves the credential, not which properties it
  // reaches, so it never suggests a config/integrations.json cell.
  assert.deepEqual(result.proofs, []);
});

test('a refused store credential is that provider error, with the fix that reaches it', async () => {
  const tower = towerStub(
    [providerEntry('bing-webmaster', { source: 'store', fields: ['BING_WEBMASTER_API_KEY'] })],
    { 'bing-webmaster': { ok: false, message: 'The API key was rejected.', checkedAt: NOW } },
  );
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  const result = await probeStoreLane(laneById('bing'), store, { fetchImpl: tower.fetchImpl });

  assert.equal(result.rows[0].state, 'fail');
  assert.equal(result.rows[0].detail, 'The API key was rejected.');
  assert.match(result.rows[0].sub[0], /reconnect bing-webmaster on \/integrations/);
});

test('Google is tested ONCE for the two lanes it powers', async () => {
  const tower = towerStub(
    [
      providerEntry('google', {
        source: 'store',
        auth: 'oauth',
        fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'],
      }),
    ],
    {
      google: {
        ok: true,
        message: 'Signed in — 3 verified sites, 2 GA4 properties.',
        checkedAt: NOW,
      },
    },
  );
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  for (const lane of lanesFor('google')) {
    const result = await probeStoreLane(lane, store, { fetchImpl: tower.fetchImpl });
    assert.equal(result.rows[0].state, 'pass');
  }
  // A probe costs a real call. Two lanes, one credential, one test.
  assert.equal(tower.calls.filter((call) => call.url.endsWith('/test')).length, 1);
});

test('with the OS stopped it is the env-only check, and never turns silence into green', async () => {
  const store = await readStoreCredentials({
    origin: ORIGIN,
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });

  assert.equal(store.reachable, false);
  assert.match(store.reason, /fetch failed/);
  // The env answer is unchanged — the fallback is the OLD behaviour, exactly.
  assert.equal(laneSource(laneById('bing'), { BING_WEBMASTER_API_KEY: 'k' }, store), 'env');
  assert.equal(laneSource(laneById('bing'), {}, store), 'none');
  // And a store-held credential is honestly invisible rather than wrongly green.
  assert.equal(storeCredential(laneById('gsc'), store), null);
});

test('an OS that answers the read but refuses the test says the OS refused', async () => {
  const tower = towerStub(
    [providerEntry('calendar', { source: 'store', fields: ['CALENDAR_FEEDS'] })],
    {},
  );
  const store = await readStoreCredentials({ origin: ORIGIN, fetchImpl: tower.fetchImpl });
  const result = await probeStoreLane(laneById('calendar'), store, { fetchImpl: tower.fetchImpl });
  assert.equal(result.rows[0].state, 'fail');
  assert.match(result.rows[0].detail, /the OS refused the test with HTTP 404/);
});
