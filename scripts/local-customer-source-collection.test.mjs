import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyComposeCustomerCollection } from '../deploy/compose/customer-entry.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { localCustomerOutbound } from './local-customer-egress.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { sealedProviderSql } from './test-fixtures/customer-backup.mjs';

const property = '123456', project = '424242', laterProject = '525252', site = 'https://fixture.example/', asset = 'fixture-site', laterAsset = 'later-site';
const counterUrl = 'https://fixture.example/metrics';
const changedUrl = 'https://fixture.example/new-metrics';
const bg = 'https://ssl.bing.com/webmaster/api.svc/json/';
const posthog = 'https://us.posthog.com';
const clarity = 'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL';
const funnel = 'https://analyticsdata.googleapis.com/v1alpha/properties/' + property + ':runFunnelReport';
const ga4 = 'https://analyticsdata.googleapis.com/v1beta/properties/' + property + ':runReport';
const gsc = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
const now = Date.parse('2026-11-17T12:00:00Z');

test('extended archive transport permits only the opted-in read operations', async () => {
  const calls = [];
  const transport = async (url, { method, redirect }) => {
    assert.equal(redirect, 'manual');
    calls.push([method, url]);
    return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } });
  };
  const requests = [['POST', funnel], ['GET', bg + 'GetFeeds?apikey=synthetic&siteUrl=' + encodeURIComponent(site)],
    ['POST', posthog + '/api/projects/' + project + '/query/'], ['GET', clarity]];
  const core = localCustomerOutbound({ googleDaily: true, collectorProviders: ['bing-webmaster'], transport });
  for (const [method, url] of requests) assert.equal((await core(new Request(url, { method }))).status, 403);
  const enabled = localCustomerOutbound({ googleDaily: true, extendedArchives: true, collectorProviders: ['bing-webmaster', 'posthog', 'clarity'], transport });
  for (const [method, url] of requests) assert.equal((await enabled(new Request(url, { method }))).status, 502);
  for (const [method, url] of [
    ['POST', ga4.replace('runReport', 'runRealtimeReport')], ['GET', clarity + '&dimension2=Country'],
    ['POST', posthog + '/api/projects/' + project + '/'], ['GET', bg + 'SubmitUrl?apikey=synthetic&siteUrl=' + encodeURIComponent(site)],
    ['POST', funnel.replace('analyticsdata.googleapis.com', 'elsewhere.example')],
  ]) assert.equal((await enabled(new Request(url, { method }))).status, 403);
  assert.deepEqual(calls, requests);
});

const schedules = {
  freshness: { enabled: false, cron: '0 * * * *' },
  counters: { enabled: false, cron: '0 * * * *' },
  'site-counters': { enabled: true, cron: '* * * * *' },
  'signal-dumps': { enabled: true, cron: '0 * * * *' },
  pull: { enabled: false, cron: '30 2 * * *' },
  'panel-refresh': { enabled: false, cron: '10 13 * * *' },
  posthog: { enabled: true, cron: '0 * * * *' },
  clarity: { enabled: true, cron: '0 * * * *' },
};
const definition = {
  id: 'signup', label: 'Signup', kind: 'funnel', status: 'active', goal: 'Create an account', version: 1,
  steps: [
    { id: 'view', label: 'View', alternatives: [{ eventName: 'page_view', pagePath: '/join' }] },
    { id: 'complete', label: 'Complete', alternatives: [{ eventName: 'sign_up' }] },
  ],
};
const quota = { tokensPerDay: { consumed: 1, remaining: 100000 }, tokensPerHour: { consumed: 1, remaining: 20000 } };
const countConfig = (url, enabled = true) => ({ assets: { [asset]: { source: { kind: 'prometheus', url, enabled },
  cards: [{ metric: 'signups', counter: 'signups', label: 'Signups' }, { metric: 'recipes', counter: 'recipes', label: 'Recipes' }] } } });

test('the native customer schedule continues scoped counters and free archive families once per occurrence', { timeout: 150_000 }, async t => {
  const root = testFixtureRoot('n-customer-archives-');
  const source = startPlan({ dir: path.join(root, 'source'), port: await availableCustomerPort() });
  const attached = startPlan({ dir: path.join(root, 'runtime'), port: source.port });
  let db, app, archiveBucket, clock = now, counterFailure = false;
  const requests = [];
  let unexpected = 0;
  const key = () => randomBytes(24).toString('base64url');
  const tokens = { access: key(), bing: key(), posthog: key(), clarity: key(), counters: key() };
  const transport = async (input, init) => {
    const url = new URL(input);
    const bearer = new Headers(init.headers).get('authorization');
    if (url.href === counterUrl) {
      assert.equal(bearer, 'Bearer ' + tokens.counters);
      requests.push('counter');
      return new Response(counterFailure ? null : 'd1_row_count{table="signups"} 90\nd1_row_count{table="recipes"} 12',
        { status: counterFailure ? 503 : 200 });
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const claims = new URLSearchParams(Buffer.from(init.body).toString()).get('assertion')?.split('.')[1];
      assert.ok(claims);
      const scope = JSON.parse(Buffer.from(claims, 'base64url')).scope;
      assert.ok(scope.endsWith('analytics.readonly') || scope.endsWith('webmasters.readonly'));
      requests.push('token');
      return Response.json({ access_token: tokens.access, expires_in: 3600 });
    }
    if ([ga4, funnel, gsc].includes(url.href)) {
      assert.equal(bearer, 'Bearer ' + tokens.access);
      const body = JSON.parse(Buffer.from(init.body).toString());
      if (url.href === funnel) {
        requests.push('funnel');
        return Response.json({ propertyQuota: quota, funnelTable: { dimensionHeaders: [{ name: 'funnelStepName' }],
          metricHeaders: [{ name: 'activeUsers' }], rows: definition.steps.map(({ id }, i) => ({
            dimensionValues: [{ value: (i + 1) + '. ' + id }], metricValues: [{ value: i === 0 ? '100' : '25' }],
          })) } });
      }
      if (url.href === gsc) {
        const family = body.dimensions.join('/');
        requests.push('gsc/' + family);
        if (family === 'page/country') return Response.json({ error: { message: 'Synthetic temporary error' } }, { status: 503 });
        return Response.json({ rows: [] });
      }
      requests.push('ga4');
      return Response.json({ propertyQuota: quota, metadata: { currencyCode: 'USD', timeZone: 'UTC' },
        dimensionHeaders: body.dimensions ?? [], metricHeaders: body.metrics ?? [], rowCount: 0, rows: [] });
    }
    if (url.origin === 'https://ssl.bing.com') {
      const method = url.pathname.split('/').at(-1);
      assert.equal(url.searchParams.get('apikey'), tokens.bing);
      requests.push(method);
      if (method === 'GetUserSites') return Response.json({ d: [{ Url: site }] });
      assert.equal(url.searchParams.get('siteUrl'), site);
      return Response.json({ d: [] });
    }
    if (url.href === posthog + '/api/projects/' + project + '/') {
      assert.equal(bearer, 'Bearer ' + tokens.posthog);
      requests.push('posthog-project');
      return Response.json({ timezone: 'UTC' });
    }
    if (url.href === posthog + '/api/projects/' + project + '/query/') {
      assert.equal(bearer, 'Bearer ' + tokens.posthog);
      const family = JSON.parse(Buffer.from(init.body).toString()).name;
      requests.push(family);
      if (family === 'noticeos:posthog-web-daily') {
        return Response.json({ results: [], columns: ['date', 'pageviews', 'people', 'sessions', 'estimated_pageviews', 'sampled_events', 'estimated_sessions'] });
      }
      return Response.json({ type: 'throttled_error', code: 'api_queries_budget_exceeded' },
        { status: 429, headers: { 'retry-after': '1800' } });
    }
    if (url.href === clarity) {
      assert.equal(bearer, 'Bearer ' + tokens.clarity);
      requests.push('clarity');
      return Response.json([{ metricName: 'Traffic', information: [{ Url: site, totalSessionCount: '2' }] }]);
    }
    unexpected++;
    throw new Error('Unexpected synthetic provider operation');
  };
  const write = (workspaceId, name, body) => db.cluster.run(
    "UPDATE noticeos.config_documents SET body=:'body'::json WHERE workspace_id=:'workspace'::uuid AND document_key=:'name'",
    { vars: { workspace: workspaceId, name, body: JSON.stringify(body) } });
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(source, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(source, db);
    const [east, west] = app.workspaces;
    const keys = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const register = { assets: { [asset]: { ga4: { status: 'live', propertyId: property, timeZone: 'UTC' },
      gsc: { status: 'live', siteUrl: site }, 'bing-webmaster': { status: 'live' }, posthog: { host: 'us', projectId: project } } } };
    for (const { workspaceId } of app.workspaces) {
      db.cluster.run("INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,domain,status,list_position) VALUES (:'workspace'::uuid,:'asset','Fixture','fixture.example','live',1)",
        { vars: { workspace: workspaceId, asset } });
      write(workspaceId, 'constants', { schedules });
      write(workspaceId, 'integrations', register);
      write(workspaceId, 'counters', countConfig(counterUrl));
    }
    db.cluster.run("INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,domain,status,list_position) VALUES (:'workspace'::uuid,:'asset','Later','later.example','live',2)",
      { vars: { workspace: east.workspaceId, asset: laterAsset } });
    register.assets[laterAsset] = { 'bing-webmaster': { status: 'skipped' }, posthog: { host: 'us', projectId: laterProject } };
    write(east.workspaceId, 'integrations', register);
    write(east.workspaceId, 'value-events', { assets: { [asset]: { journeys: [definition] } } });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const [provider, fields] of [
      ['google', { GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({ archive: {
        service_account_b64: Buffer.from(JSON.stringify({ client_email: 'fixture@example.test',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64'),
        properties: { [asset]: { ga4_property_id: property, gsc_site_url: site, time_zone: 'UTC' } },
      } }) }],
      ['bing-webmaster', { BING_WEBMASTER_API_KEY: tokens.bing }],
      ['posthog', { POSTHOG_KEYS: JSON.stringify({ [asset]: tokens.posthog, [laterAsset]: tokens.posthog }) }],
      ['clarity', { CLARITY_TOKENS: JSON.stringify({ [asset]: tokens.clarity }) }],
    ]) db.cluster.run(sealedProviderSql(east.workspaceId, keys.credentialsKey, provider, fields));
    const check = (workspaceId, collectorProviders) => verifyComposeCustomerCollection({ address: db.address, workspaces: [{ workspaceId }], collectorProviders });
    await assert.rejects(check(west.workspaceId, ['clarity']), /Connect Microsoft Clarity/u);
    await check(west.workspaceId, []);
    await check(east.workspaceId, ['clarity']);
    const file = path.join(root, 'settings.json');
    writeFileSync(file, JSON.stringify({
      format: 'noticeos-customer-operating/1', database: { app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString },
      identitySecret: keys.identitySecret, credentialsKey: keys.credentialsKey, workspaces: app.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })),
      mailRecipients: app.workspaces.map(({ email }) => email), googleDaily: true, extendedArchives: true,
      collectorProviders: ['bing-webmaster', 'posthog', 'clarity'], sitePulls: [{ workspaceId: west.workspaceId, asset, token: tokens.counters, urls: [counterUrl] }],
    }), { mode: 0o600 });
    const restart = async () => {
      await app.close(); app = undefined;
      app = await startAttachedCustomer(attached, file, { collectorTransport: transport,
        startSchedules(options) {
          archiveBucket = options.bucket;
          return startLocalCustomerSchedules({ ...options, now: () => clock });
        } });
      await app.whenIdle();
    };
    const archives = () => db.cluster.sql("SELECT r.workspace_id,integration,report,status,object_key FROM noticeos.archive_runs r LEFT JOIN noticeos.archive_objects USING(workspace_id,object_seq) ORDER BY r.run_seq");
    const readings = () => db.cluster.sql('SELECT workspace_id,metric,value,observed_at FROM noticeos.counter_readings ORDER BY metric');
    await restart();
    const collected = archives(), savedCounters = readings(), count = requests.length;
    const families = new Set(collected.filter(row => row.status === 'success').map(row => row.integration + '/' + row.report));
    for (const family of ['ga4/traffic-sources', 'gsc/device', 'bing-webmaster/feeds', 'bing-webmaster/queries',
      'bing-webmaster/pages', 'bing-webmaster/crawl-stats', 'posthog/web-daily', 'clarity/url-3d']) assert.ok(families.has(family), family);
    assert.ok([...families].some(family => family.startsWith('ga4/journeys-')));
    assert.ok(collected.some(row => row.integration === 'gsc' && row.report === 'page-country' && row.status === 'error'));
    assert.ok(collected.some(row => row.integration === 'posthog' && row.status === 'error'));
    assert.ok(collected.every(row => row.workspace_id === east.workspaceId &&
      (row.status === 'error' || row.object_key?.startsWith('workspaces/' + east.workspaceId + '/raw/'))));
    for (const integration of ['ga4', 'gsc', 'bing-webmaster', 'posthog', 'clarity']) {
      const published = collected.find(row => row.integration === integration && row.status === 'success');
      const object = await archiveBucket.head(published.object_key);
      assert.ok(object?.size > 0, integration);
    }
    assert.equal(requests.filter(call => call === 'token').length, 2);
    assert.equal(requests.filter(call => call === 'posthog-project').length, 1);
    assert.equal(requests.filter(call => call.startsWith('noticeos:posthog-')).length, 2);
    assert.equal(requests.filter(call => call === 'clarity').length, 1);
    assert.deepEqual(savedCounters.map(row => [row.workspace_id, row.metric, row.value]),
      [[west.workspaceId, 'recipes', '12'], [west.workspaceId, 'signups', '90']]);
    assert.deepEqual(db.cluster.sql('SELECT pulse_id FROM noticeos.pulses'), []);
    await restart();
    assert.equal(requests.length, count);
    assert.deepEqual(archives(), collected);
    assert.deepEqual(readings(), savedCounters);
    counterFailure = true; clock += 60_000;
    await restart();
    assert.deepEqual(requests.slice(count), ['counter']);
    assert.deepEqual(readings(), savedCounters);
    write(west.workspaceId, 'counters', countConfig(changedUrl));
    clock += 60_000;
    await restart();
    assert.equal(requests.length, count + 1);
    write(west.workspaceId, 'counters', countConfig(counterUrl, false));
    clock += 60_000;
    await restart();
    assert.equal(requests.length, count + 1);
    assert.deepEqual(readings(), savedCounters);
    register.assets[laterAsset].posthog.status = 'skipped';
    write(east.workspaceId, 'integrations', register);
    clock = now + 3_600_000;
    await restart();
    assert.equal(requests.slice(count).filter(call => call === 'GetQueryStats' || call === 'GetPageStats').length, 0);
    const recent = archives().slice(collected.length);
    assert.ok(recent.some(row => row.integration === 'bing-webmaster' && row.status === 'unchanged'
      && collected.some(old => old.object_key === row.object_key)));
    assert.ok(recent.some(row => row.integration === 'clarity' && row.status === 'unchanged'
      && collected.some(old => old.object_key === row.object_key)));
    assert.deepEqual(readings(), savedCounters);
    assert.equal(unexpected, 0);
    t.diagnostic(`Initial collection made ${count} synthetic requests and published ${collected.filter(row => row.status === 'success').length} archives. Completed-occurrence restart made zero requests.`);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    if (!existsSync(path.join(source.home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});

