import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DATABASE_URL,
  compileWorkerBindings,
  credentialImportPlan,
  migrateDevVars,
  normalizeSecretBindings,
  parseDevVars,
  readDevSecretBindings,
  runCredentialImport,
  syncDevVars,
} from './dev-secrets.mjs';

test('nested JSON values become the string bindings Workers receive', () => {
  assert.deepEqual(
    normalizeSecretBindings({
      OPERATOR_TOKEN: 'secret',
      GOOGLE_SIGNAL_ACCOUNTS: {
        portfolio: {
          service_account_b64: 'encoded-key',
          properties: { 'northwind.example': { ga4_property_id: '123' } },
        },
      },
    }),
    {
      OPERATOR_TOKEN: 'secret',
      GOOGLE_SIGNAL_ACCOUNTS:
        '{"portfolio":{"service_account_b64":"encoded-key","properties":{"northwind.example":{"ga4_property_id":"123"}}}}',
    },
  );
});

test('Google service-account payloads compile into bounded per-account bindings', () => {
  assert.deepEqual(
    compileWorkerBindings({
      OPERATOR_TOKEN: 'secret',
      GOOGLE_SIGNAL_ACCOUNTS: {
        'studio-signals': {
          service_account_b64: 'studio-key',
          properties: { 'meadow.example': { ga4_property_id: '123' } },
        },
        'example-signals': {
          service_account_b64: 'example-key',
          properties: { 'ferns.example': { gsc_site_url: 'sc-domain:ferns.example' } },
        },
      },
    }),
    {
      OPERATOR_TOKEN: 'secret',
      GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({
        'studio-signals': {
          properties: { 'meadow.example': { ga4_property_id: '123' } },
          service_account_binding: 'GOOGLE_SERVICE_ACCOUNT_STUDIO_SIGNALS',
        },
        'example-signals': {
          properties: { 'ferns.example': { gsc_site_url: 'sc-domain:ferns.example' } },
          service_account_binding: 'GOOGLE_SERVICE_ACCOUNT_EXAMPLE_SIGNALS',
        },
      }),
      GOOGLE_SERVICE_ACCOUNT_STUDIO_SIGNALS: 'studio-key',
      GOOGLE_SERVICE_ACCOUNT_EXAMPLE_SIGNALS: 'example-key',
    },
  );
});

test('Google account labels cannot collide with generated bindings', () => {
  const account = {
    service_account_b64: 'encoded',
    properties: {},
  };
  assert.throws(
    () =>
      compileWorkerBindings({
        GOOGLE_SIGNAL_ACCOUNTS: {
          'signals-one': account,
          signals_one: account,
        },
      }),
    /collide/,
  );
});

test('invalid top-level shapes and binding names fail closed', () => {
  assert.throws(() => normalizeSecretBindings([]), /top-level JSON object/);
  assert.throws(() => normalizeSecretBindings({ 'bad-name': 'x' }), /invalid secret binding/);
  assert.throws(() => normalizeSecretBindings({ NULL_SECRET: null }), /must be a string/);
});

test('migration structures legacy JSON maps and generated dotenv round-trips', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-dev-secrets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const varsFile = path.join(dir, '.dev.vars');
  const secretsFile = path.join(dir, '.dev.secrets.json');
  await fs.writeFile(
    varsFile,
    [
      '# comment',
      'OPERATOR_TOKEN=contains=equals',
      'ASSET_TOKENS={"northwind.example":"nw-token"}',
      'QUOTED_TOKEN="hash#and\\nnewline"',
      '',
    ].join('\n'),
  );

  const migrated = await migrateDevVars({ varsFile, secretsFile });
  assert.deepEqual(migrated.keys, ['OPERATOR_TOKEN', 'ASSET_TOKENS', 'QUOTED_TOKEN']);
  assert.deepEqual(JSON.parse(await fs.readFile(secretsFile, 'utf8')), {
    OPERATOR_TOKEN: 'contains=equals',
    ASSET_TOKENS: { 'northwind.example': 'nw-token' },
    QUOTED_TOKEN: 'hash#and\nnewline',
  });

  const generated = parseDevVars(await fs.readFile(varsFile, 'utf8'));
  assert.deepEqual(generated, {
    OPERATOR_TOKEN: 'contains=equals',
    ASSET_TOKENS: '{"northwind.example":"nw-token"}',
    QUOTED_TOKEN: 'hash#and\nnewline',
  });
});

test('structured source wins and sync never prints or changes secret values', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-dev-secrets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const varsFile = path.join(dir, '.dev.vars');
  const secretsFile = path.join(dir, '.dev.secrets.json');
  await fs.writeFile(varsFile, 'OPERATOR_TOKEN=legacy\n');
  await fs.writeFile(
    secretsFile,
    JSON.stringify({
      OPERATOR_TOKEN: 'structured',
      GOOGLE_SIGNAL_ACCOUNTS: { account: { properties: {} } },
    }),
  );

  const loaded = await readDevSecretBindings({ varsFile, secretsFile });
  assert.equal(loaded.structured, true);
  assert.equal(loaded.bindings.OPERATOR_TOKEN, 'structured');

  await syncDevVars({ varsFile, secretsFile });
  assert.deepEqual(parseDevVars(await fs.readFile(varsFile, 'utf8')), {
    OPERATOR_TOKEN: 'structured',
    GOOGLE_SIGNAL_ACCOUNTS: '{"account":{"properties":{}}}',
  });
});

test('the database address is read from the secrets file but never becomes a Worker binding', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-dev-secrets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const varsFile = path.join(dir, '.dev.vars');
  const secretsFile = path.join(dir, '.dev.secrets.json');
  const address = 'postgresql://noticeos_app:planted-password@127.0.0.1:5432/noticeos?sslmode=disable';
  await fs.writeFile(secretsFile, JSON.stringify({ OPERATOR_TOKEN: 'structured', [DATABASE_URL]: address }));

  assert.equal(DATABASE_URL, 'DATABASE_URL');
  // The runner and `pnpm start` read it where the other bootstrap secrets are…
  assert.equal((await readDevSecretBindings({ varsFile, secretsFile })).bindings[DATABASE_URL], address);
  // …and the file wrangler hands the Workers never holds it.
  assert.deepEqual(compileWorkerBindings({ OPERATOR_TOKEN: 'structured', [DATABASE_URL]: address }), { OPERATOR_TOKEN: 'structured' });
  const synced = await syncDevVars({ varsFile, secretsFile });
  assert.deepEqual(synced.keys, ['OPERATOR_TOKEN']);
  const written = await fs.readFile(varsFile, 'utf8');
  assert.doesNotMatch(written, /planted-password|DATABASE_URL/u);
  assert.deepEqual(parseDevVars(written), { OPERATOR_TOKEN: 'structured' });
});

// ---------------------------------------------------------------------------
// `pnpm dev:secrets:import` — the one-way door from these local files into the
// credential store. The operator's existing secrets move
// without being retyped into a form; the bindings stay as the fallback.
// ---------------------------------------------------------------------------

/** The provider catalog exactly as GET /api/integrations/providers serves it.
 * It is NOT duplicated in dev-secrets.mjs — the script reads it off the wire,
 * so a provider added in packages/contract is importable with no edit here. */
const PROVIDERS = [
  {
    provider: {
      id: 'bing-webmaster',
      fields: [{ name: 'BING_WEBMASTER_API_KEY', required: true }],
    },
  },
  {
    provider: {
      id: 'dataforseo',
      fields: [
        { name: 'DATAFORSEO_LOGIN', required: true },
        { name: 'DATAFORSEO_PASSWORD', required: true },
      ],
    },
  },
];

/** Google as the contract now ships it: TWO ways in, and
 * neither field `required`, because "required" cannot express *either a sign-in
 * or a service account*. */
const GOOGLE_PROVIDER = {
  provider: {
    id: 'google',
    authPaths: [
      { kind: 'oauth', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'] },
      { kind: 'service-account', fields: ['GOOGLE_SIGNAL_ACCOUNTS'] },
    ],
    fields: [
      { name: 'GOOGLE_OAUTH_REFRESH_TOKEN', required: false, managed: true },
      { name: 'GOOGLE_SIGNAL_ACCOUNTS', required: false },
    ],
  },
};

test('a two-way-in provider is complete on EITHER path, and never on neither', () => {
  // Reading only `required` would call an empty Google credential complete and
  // PUT a row with no fields — which then shadows a working env binding. This
  // is the case that rule exists for.
  assert.deepEqual(credentialImportPlan({}, [GOOGLE_PROVIDER]).skipped, [
    // The PREFERRED path is what an operator is told to go and do.
    { provider: 'google', missing: ['GOOGLE_OAUTH_REFRESH_TOKEN'] },
  ]);
  assert.deepEqual(credentialImportPlan({}, [GOOGLE_PROVIDER]).planned, []);

  const withMap = credentialImportPlan(
    { GOOGLE_SIGNAL_ACCOUNTS: '{"portfolio":{}}' },
    [GOOGLE_PROVIDER],
  );
  assert.deepEqual(withMap.skipped, []);
  assert.deepEqual(withMap.planned.map((entry) => entry.names), [
    ['GOOGLE_SIGNAL_ACCOUNTS'],
  ]);
});

test('the import plan skips a provider whose bindings are incomplete', () => {
  const { planned, skipped } = credentialImportPlan(
    { BING_WEBMASTER_API_KEY: 'bing-key', DATAFORSEO_LOGIN: 'login-only' },
    PROVIDERS,
  );
  assert.deepEqual(
    planned.map((entry) => entry.provider),
    ['bing-webmaster'],
  );
  // Half-importing would put an incomplete credential in the store, which then
  // SHADOWS a complete one in the env — worse than not importing at all.
  assert.deepEqual(skipped, [
    { provider: 'dataforseo', missing: ['DATAFORSEO_PASSWORD'] },
  ]);
});

test('a blank binding counts as absent, not as a value worth storing', () => {
  const { planned, skipped } = credentialImportPlan(
    { BING_WEBMASTER_API_KEY: '   ' },
    PROVIDERS,
  );
  assert.deepEqual(planned, []);
  assert.equal(skipped.length, 2);
});

/** Clarity as the providers route sends it: the legacy binding carries the
 * asset the register gives it. */
const clarityProvider = (asset) => ({
  provider: {
    id: 'clarity',
    fields: [{
      name: 'CLARITY_TOKENS',
      kind: 'asset-map',
      required: true,
      legacyAssetBinding: { name: 'CLARITY_PROJECT_API_TOKEN', lane: 'clarity', ...(asset ? { asset } : {}) },
    }],
  },
});
const clarityFields = (bindings, asset = 'shop.example.com') =>
  credentialImportPlan(bindings, [clarityProvider(asset)]).planned[0]?.fields.CLARITY_TOKENS;

test('a legacy single-project Clarity binding is imported as its asset entry in the map', () => {
  assert.equal(clarityFields({ CLARITY_PROJECT_API_TOKEN: ' single ' }), '{"shop.example.com":"single"}');
  assert.equal(
    clarityFields({ CLARITY_TOKENS: '{"blog.example.com":"b"}', CLARITY_PROJECT_API_TOKEN: 'single' }),
    '{"blog.example.com":"b","shop.example.com":"single"}',
  );
  // The map wins where both name the asset.
  assert.equal(
    clarityFields({ CLARITY_TOKENS: '{"shop.example.com":"mapped"}', CLARITY_PROJECT_API_TOKEN: 'single' }),
    '{"shop.example.com":"mapped"}',
  );
  // A map that does not parse goes as written, for the route to refuse.
  assert.equal(clarityFields({ CLARITY_TOKENS: '{nope', CLARITY_PROJECT_API_TOKEN: 'single' }), '{nope');
  // No asset in the register, no fold.
  assert.equal(clarityFields({ CLARITY_PROJECT_API_TOKEN: 'single' }, null), undefined);
});

test('import PUTs each complete provider once and reports by NAME', async () => {
  const calls = [];
  const result = await runCredentialImport({
    bindings: {
      BING_WEBMASTER_API_KEY: 'SEKRIT-bing',
      DATAFORSEO_LOGIN: 'op@example.test',
      DATAFORSEO_PASSWORD: 'SEKRIT-dfs',
    },
    origin: 'http://127.0.0.1:5173',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (String(url).endsWith('/api/integrations/providers')) {
        return new Response(
          JSON.stringify({ keyPresent: true, providers: PROVIDERS }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(
    result.imported.map((entry) => entry.provider),
    ['bing-webmaster', 'dataforseo'],
  );
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'PUT', 'PUT'],
  );
  assert.match(calls[1].url, /\/api\/integrations\/bing-webmaster\/credential$/);
  // The report names field NAMES, never values.
  assert.deepEqual(result.imported[0].names, ['BING_WEBMASTER_API_KEY']);
  assert.equal(JSON.stringify(result.imported).includes('SEKRIT'), false);
});

test('import refuses up front when the install has no bootstrap key', async () => {
  await assert.rejects(
    () =>
      runCredentialImport({
        bindings: { BING_WEBMASTER_API_KEY: 'bing-key' },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              keyPresent: false,
              keyReason:
                'CREDENTIALS_KEY is not set. Generate one with `openssl rand -base64 32`.',
              providers: PROVIDERS,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      }),
    /openssl rand -base64 32/,
  );
});

test('import makes no writes when the credential store cannot answer', async () => {
  const calls = [];
  await assert.rejects(
    () => runCredentialImport({
      bindings: { BING_WEBMASTER_API_KEY: 'bing-key' },
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        return new Response(JSON.stringify({ error: 'integration_credentials_unavailable' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      },
    }),
    /503/,
  );
  assert.deepEqual(calls.map(call => call.method), ['GET']);
});

test('import says to start the OS when the Tower is not answering', async () => {
  await assert.rejects(
    () =>
      runCredentialImport({
        bindings: {},
        fetchImpl: async () => new Response('nope', { status: 502 }),
      }),
    /os:up/,
  );
});

test('a route refusal is reported per provider without stopping the rest', async () => {
  const result = await runCredentialImport({
    bindings: {
      BING_WEBMASTER_API_KEY: 'bing-key',
      DATAFORSEO_LOGIN: 'op@example.test',
      DATAFORSEO_PASSWORD: 'dfs-password',
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/integrations/providers')) {
        return new Response(
          JSON.stringify({ keyPresent: true, providers: PROVIDERS }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(url).includes('bing-webmaster')) {
        return new Response(
          JSON.stringify({ error: 'invalid_credential', detail: 'API key is blank.' }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(result.failed, [
    { provider: 'bing-webmaster', detail: 'API key is blank.' },
  ]);
  assert.deepEqual(
    result.imported.map((entry) => entry.provider),
    ['dataforseo'],
  );
});
