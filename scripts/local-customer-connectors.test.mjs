import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { localCustomerOutbound } from './local-customer-egress.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

const NOW = Date.parse('2026-11-17T20:30:00Z');
const DATE = '2026-11-16';
const SITE = { id: 'synthetic-site', title: 'Fixture publisher', domain: 'counts.example.test' };
const ACCOUNT = 'acct_fixture';
const primary = 'fixture-metrics', secondary = 'fixture-report', declined = 'fixture-declined';
const metricsUrl = 'https://counts.example.test/metrics', envelopeUrl = 'https://events.example.test/site-report';
const oldUrl = 'https://events.example.test/changed-report';
const schedules = Object.fromEntries(['mediavine', 'stripe', 'pull'].map(job => [job, { enabled: true, cron: '* * * * *' }]));
const key = () => randomBytes(24).toString('base64url');

const providerRoutes = {
  'https://api-publishers.mediavine.com/graphql': 'POST',
  'https://api.stripe.com/v1/subscriptions?status=all': 'GET',
  'https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=fixture': 'GET',
  [metricsUrl]: 'GET',
};

test('scheduled connector transport selects only the enabled official routes and exact site report URL', async () => {
  const attempts = [];
  const transport = async (url, options) => {
    attempts.push({ url, method: options.method, redirect: options.redirect });
    return new Response(null, { status: 307, headers: { location: oldUrl } });
  };
  for (const [url, method] of Object.entries(providerRoutes)) {
    assert.equal((await localCustomerOutbound({ transport })(new Request(url, { method }))).status, 403);
  }
  assert.deepEqual(attempts, []);
  const active = localCustomerOutbound({ transport, collectorProviders: ['mediavine', 'stripe', 'bing-webmaster'], sitePulls: [{ urls: [metricsUrl] }] });
  for (const [url, method] of Object.entries(providerRoutes)) {
    assert.equal((await active(new Request(url, { method }))).status, 502);
  }
  for (const [url, method] of [[metricsUrl + '?reload=1', 'GET'], [metricsUrl, 'POST'], [oldUrl, 'GET'],
    ['https://api.stripe.com/v1/refunds', 'POST'], ['https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=fixture&extra=1', 'GET']]) {
    assert.equal((await active(new Request(url, { method }))).status, 403);
  }
  assert.deepEqual(attempts, Object.entries(providerRoutes).map(([url, method]) => ({ url, method, redirect: 'manual' })));
});

async function putCredential(db, encryptionKey, workspace, provider, fields) {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, new TextEncoder().encode(JSON.stringify(fields)));
  db.run(`INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at)
    VALUES (:'workspace'::uuid,:'connection'::uuid,:'provider','shared',now(),now());
    INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
    VALUES (:'workspace'::uuid,:'connection'::uuid,1,decode(:'sealed','hex'),decode(:'iv','hex'),1,:'fields'::jsonb,now())`,
  { vars: { workspace, connection: randomUUID(), provider, sealed: Buffer.from(sealed).toString('hex'), iv: iv.toString('hex'),
    fields: JSON.stringify(Object.keys(fields)) } });
}

function setSources(db, east, west) {
  const pulls = [
    { asset: primary, enabled: true, format: 'prometheus', url: metricsUrl, metrics: { signups: { counter: 'signups' } } },
    { asset: secondary, enabled: true, format: 'envelope', url: envelopeUrl },
    { asset: declined, enabled: true, format: 'envelope', url: oldUrl },
  ];
  const register = { assets: {
    [primary]: { 'ad-network': { status: 'live', mediavineSiteId: SITE.id }, 'bing-webmaster': { status: 'live' } },
    [secondary]: { 'bing-webmaster': { status: 'skipped' } },
    [declined]: { 'bing-webmaster': { status: 'skipped' }, 'ad-network': { status: 'skipped', mediavineSiteId: 'declined-site' } },
  }, stripeProducts: { accountId: ACCOUNT, products: { prod_fixture: secondary } } };
  for (const workspace of [east, west]) {
    for (const [asset, domain] of [[primary, SITE.domain], [secondary, 'events.example.test'], [declined, 'declined.example.test']]) {
      db.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
        SELECT :'workspace'::uuid, :'asset', :'domain', :'asset', 'live', coalesce(max(list_position),0)+1
        FROM noticeos.assets WHERE workspace_id=:'workspace'::uuid`, { vars: { workspace, asset, domain } });
    }
    db.run(`UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules}',:'schedules'::jsonb)::json
        WHERE workspace_id=:'workspace'::uuid AND document_key='constants';
      UPDATE noticeos.config_documents SET body=:'register'::json
        WHERE workspace_id=:'workspace'::uuid AND document_key='integrations';
      INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
      VALUES (:'workspace'::uuid,'pull',1,:'pulls'::json,now(),'fixture') ON CONFLICT(workspace_id,document_key)
        DO UPDATE SET body=excluded.body;`,
    { vars: { workspace, schedules: JSON.stringify(workspace === east ? schedules
      : { ...schedules, stripe: { ...schedules.stripe, enabled: false } }), register: JSON.stringify(register), pulls: JSON.stringify(pulls) } });
  }
  db.run(`INSERT INTO noticeos.revenue_observations(workspace_id,asset_id,source,account_ref,revenue_date,amount_minor,currency,run_ref,recorded_at)
    SELECT :'workspace'::uuid,:'asset','mediavine-journey',:'site',day,100,'USD','fixture-history',day
    FROM generate_series('2026-11-01'::date,'2026-11-15'::date,interval '1 day') day`,
  { vars: { workspace: east, asset: primary, site: SITE.id } });
}

function fakeProviders(secrets) {
  const calls = [];
  const paymentTime = Date.parse(DATE + 'T15:00:00Z') / 1000;
  const sale = { id: 'txn_fixture', type: 'charge', amount: 1050, fee: 30, net: 1020, currency: 'usd', created: paymentTime,
    source: { id: 'ch_fixture', balance_transaction: 'txn_fixture', payment_intent: 'pi_fixture', created: paymentTime } };
  const list = data => Response.json({ data, has_more: false });
  return { calls, async transport(input, init) {
    const url = new URL(input), auth = new Headers(init.headers).get('authorization');
    calls.push(url.origin + url.pathname);
    if (url.href === metricsUrl) {
      assert.equal(auth, 'Bearer ' + secrets.metrics);
      return new Response('d1_row_count{table="signups"} 90\nd1_new_rows_count{table="signups",window="24h"} 4');
    }
    if (url.href === envelopeUrl) {
      assert.equal(auth, 'Bearer ' + secrets.envelope);
      return Response.json({ asset: secondary, generatedAt: new Date(NOW).toISOString(), capabilities: ['signups'],
        metrics: { signups: { last24h: 8, avg7d: 6, total: 100 } } });
    }
    if (url.origin === 'https://ssl.bing.com') {
      assert.equal(url.searchParams.get('apikey'), secrets.bing);
      if (url.pathname.endsWith('/GetUserSites')) return Response.json({ d: [{ Url: 'https://' + SITE.domain + '/' }] });
      assert.equal(url.searchParams.get('siteUrl'), 'https://' + SITE.domain + '/');
      return Response.json({ d: [{ Date: '/Date(' + Date.parse(DATE) + ')/', Clicks: 17, Impressions: 135 }] });
    }
    if (url.origin === 'https://api-publishers.mediavine.com') {
      const { query, variables } = JSON.parse(Buffer.from(init.body).toString());
      if (query.includes('unidashSignIn')) {
        assert.equal(variables.data.password, secrets.mediavine);
        return Response.json({ data: { unidashSignIn: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
          expiresIn: 3600, twoFactorRequired: false } } });
      }
      assert.match(query, /NoticeOSDailyRevenue/u);
      assert.equal(variables.date, '11/16/2026');
      return Response.json({ data: { sitesForUser: { pageInfo: { hasNextPage: false },
        edges: [{ node: { ...SITE, daily: { earnings: 12.34 } } }] } } });
    }
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(auth, 'Bearer ' + secrets.stripe);
    switch (url.pathname) {
      case '/v1/account': return Response.json({ id: ACCOUNT });
      case '/v1/balance': return Response.json({ livemode: true, available: [{ currency: 'usd', amount: 1020 }], pending: [] });
      case '/v1/balance_transactions': return list([sale]);
      case '/v1/checkout/sessions': return list([{ id: 'cs_fixture' }]);
      case '/v1/checkout/sessions/cs_fixture/line_items': return list([{ id: 'li_fixture', amount_total: 1050, price: { product: 'prod_fixture' } }]);
      default: assert.fail('Unexpected provider operation');
    }
  } };
}

test('the attached app schedules existing revenue, search and both nightly report producers once in their workspace', { timeout: 150_000 }, async t => {
  const root = testFixtureRoot('n-customer-connectors-');
  const source = startPlan({ dir: path.join(root, 'source'), port: await availableCustomerPort() });
  const attached = startPlan({ dir: path.join(root, 'runtime'), port: source.port });
  let db, app;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(source, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(source, db);
    const [east, west] = app.workspaces;
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const secrets = { mediavine: key(), stripe: 'rk_live_' + key().replace(/[^a-zA-Z0-9]/gu, ''), bing: key(), metrics: key(), envelope: key() };
    const encryption = await crypto.subtle.importKey('raw', Buffer.from(credentialsKey, 'base64'), 'AES-GCM', false, ['encrypt']);
    setSources(db.cluster, east.workspaceId, west.workspaceId);
    await putCredential(db.cluster, encryption, east.workspaceId, 'mediavine', { MEDIAVINE_USER: 'fixture@example.test', MEDIAVINE_PASSWORD: secrets.mediavine });
    await putCredential(db.cluster, encryption, east.workspaceId, 'stripe', { STRIPE_API_KEY: secrets.stripe });
    await putCredential(db.cluster, encryption, east.workspaceId, 'bing-webmaster', { BING_WEBMASTER_API_KEY: secrets.bing });
    await putCredential(db.cluster, encryption, west.workspaceId, 'stripe', { STRIPE_API_KEY: 'rk_live_' + randomBytes(24).toString('hex') });
    const file = path.join(root, 'runtime.json');
    const config = { format: 'noticeos-customer-operating/1', database: {
      app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString,
    }, identitySecret, credentialsKey, workspaces: [east, west].map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })),
    mailRecipients: [east.email, west.email], collectorProviders: ['mediavine', 'stripe', 'bing-webmaster'],
    sitePulls: [{ workspaceId: east.workspaceId, asset: primary, token: secrets.metrics, urls: [metricsUrl] },
      { workspaceId: east.workspaceId, asset: secondary, token: secrets.envelope, urls: [envelopeUrl] },
      { workspaceId: east.workspaceId, asset: declined, token: key(), urls: ['https://declined.example.test/report'] }] };
    const save = overrides => writeFileSync(file, JSON.stringify({ ...config, ...overrides }), { mode: 0o600 });
    await app.close(); app = undefined;
    const providers = fakeProviders(secrets);
    const launch = () => startAttachedCustomer(attached, file, { collectorTransport: providers.transport,
      startSchedules: options => startLocalCustomerSchedules({ ...options, now: () => NOW }) });
    save({ collectorProviders: [], sitePulls: [] });
    app = await launch(); await app.whenIdle();
    assert.deepEqual(providers.calls, []);
    await app.close(); app = undefined;

    save({});
    app = await launch(); await app.whenIdle();
    const revenue = () => db.cluster.sql(`SELECT workspace_id,asset_id,source,amount_minor,currency
       FROM noticeos.current_revenue WHERE revenue_date='${DATE}'::date AND (source='mediavine-journey' OR item_ref='txn_fixture') ORDER BY source`);
    assert.deepEqual(revenue(), [
      { workspace_id: east.workspaceId, asset_id: primary, source: 'mediavine-journey', amount_minor: '1234', currency: 'USD' },
      { workspace_id: east.workspaceId, asset_id: secondary, source: 'stripe', amount_minor: '1020', currency: 'USD' },
    ]);
    const search = () => db.cluster.sql(`SELECT m.workspace_id,m.asset_id,m.metric,o.value::text
      FROM noticeos.signal_observations o JOIN noticeos.measurement_series m USING(workspace_id,series_id)
      WHERE m.integration='bing-webmaster' AND o.observed_date='${DATE}'::date ORDER BY m.metric`);
    const readings = search();
    assert.deepEqual(readings, [
      { workspace_id: east.workspaceId, asset_id: primary, metric: 'clicks', value: '17' },
      { workspace_id: east.workspaceId, asset_id: primary, metric: 'impressions', value: '135' },
    ]);
    const reports = () => db.cluster.sql(`SELECT workspace_id,asset_id,envelope->'metrics'->'signups'->>'last24h' AS signups
      FROM noticeos.current_pulses ORDER BY asset_id`);
    assert.deepEqual(reports(), [
      { workspace_id: east.workspaceId, asset_id: primary, signups: '4' },
      { workspace_id: east.workspaceId, asset_id: secondary, signups: '8' },
    ]);
    const receipts = db.cluster.sql(`SELECT workspace_id,lane,state FROM noticeos.hosted_job_occurrences ORDER BY lane, occurrence`);
    assert.deepEqual(receipts.map(row => row.lane), ['mediavine', 'pull', 'pull', 'pull', 'stripe']);
    assert.ok(receipts.every(row => row.workspace_id === east.workspaceId && row.state === 'succeeded'));
    assert.equal(providers.calls.filter(url => url.endsWith('/GetUserSites')).length, 1);
    const history = () => db.cluster.sql(`SELECT
      (SELECT count(*) FROM noticeos.revenue_observations) AS revenue,
      (SELECT count(*) FROM noticeos.pulses) AS site_reports,
      (SELECT count(*) FROM noticeos.signal_observations) AS search`);
    const totals = { calls: providers.calls.length, revenue: revenue(), reports: reports(), search: readings, history: history() };
    await app.close(); app = undefined;
    app = await launch(); await app.whenIdle();
    assert.deepEqual({ calls: providers.calls.length, revenue: revenue(), reports: reports(), search: search(), history: history() }, totals);
    t.diagnostic(`First collection made ${totals.calls} synthetic requests; same-occurrence restart made zero.`);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    if (!existsSync(path.join(source.home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});
