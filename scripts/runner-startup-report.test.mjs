import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configDocumentsUrl,
  configStoreLine,
  integrationProvidersUrl,
  legacyEnvLine,
  reportConfigStore,
  reportLegacyEnvCredentials,
} from './runner/startup-report.mjs';

// scripts/runner/startup-report.mjs: the two startup notes.
// Every answer below is a canned door; nothing reaches the Tower or the ingest.

const UP = { running: true, ready: true };
const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('the credentials note names the providers still on the environment file', () => {
  assert.equal(legacyEnvLine({ providers: [] }), null, 'a first run says nothing');
  const mixed = legacyEnvLine({
    providers: [
      { provider: { id: 'ga4' }, credential: { source: 'env' } },
      { provider: { id: 'gsc' }, credential: { source: 'store' } },
    ],
  });
  assert.match(mixed, /^credentials: 1 of 2 still resolve from the environment file \(ga4\)/u);
  assert.equal(
    legacyEnvLine({ providers: [{ provider: { id: 'gsc' }, credential: { source: 'store' } }] }),
    'credentials: all 1 connected provider(s) resolve from the store',
  );
});

test('the config note tells an unseeded, partly seeded and fully seeded store apart', () => {
  assert.match(configStoreLine({ ready: false }), /no config_documents table yet/u);
  assert.match(configStoreLine({ ready: true, documents: [], unseeded: [] }), /nothing is seeded/u);
  assert.match(configStoreLine({ ready: true, documents: [{}], unseeded: ['config/a.json'] }), /1 still read from the file \(config\/a\.json\)/u);
  assert.equal(configStoreLine({ ready: true, documents: [{}, {}], unseeded: [] }), 'config: all 2 document(s) read from the store');
  assert.equal(configStoreLine(null), null);
});

test('each note is said once from the OS’s answer, and is silent when it cannot ask', async () => {
  const said = [];
  const emit = (level, text) => said.push(`${level} ${text}`);
  const providers = { providers: [{ provider: { id: 'gsc' }, credential: { source: 'env' } }] };
  await reportLegacyEnvCredentials(UP, { emit, fetchImpl: answer(providers) });
  await reportConfigStore(UP, { emit, fetchImpl: answer({ ready: true, documents: [{}], unseeded: [] }), readToken: async () => 'example-bearer' });
  assert.deepEqual(said.map((line) => line.split(':')[0]), ['INFO credentials', 'INFO config']);

  const silent = [];
  const quiet = (level, text) => silent.push(text);
  const refuse = async () => assert.fail('asked a runtime that is not ready');
  assert.equal(await reportLegacyEnvCredentials({ running: false, ready: false }, { emit: quiet, fetchImpl: refuse }), null);
  assert.equal(await reportConfigStore(UP, { emit: quiet, fetchImpl: refuse, readToken: async () => null }), null);
  assert.equal(await reportConfigStore(UP, { emit: quiet, fetchImpl: answer({}, 500), readToken: async () => 'example-bearer' }), null);
  assert.deepEqual(silent, []);
});

test('the notes ask this machine’s own Tower and ingest', () => {
  assert.equal(integrationProvidersUrl({ towerPort: 8854 }), 'http://127.0.0.1:8854/api/integrations/providers');
  assert.equal(configDocumentsUrl({ ingestHost: '127.0.0.1', ingestPort: 8855 }), 'http://127.0.0.1:8855/api/config-documents');
});
