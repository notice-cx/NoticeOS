import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { watchQueryHistoryRange } from '../packages/contract/src/watch-series.mjs';
import path from 'node:path';
import test from 'node:test';
import { findPostgres, PostgresUnavailable, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { IDENTITY_NAMES } from '../packages/postgres/src/identity.mjs';
import { INTEGRATION_PROVIDER_IDS } from '../packages/contract/src/integrations.ts';
import { configDocumentKey } from './config-documents.mjs';
import { TOWER_CONFIG_FILES } from '../packages/contract/src/configuration.mjs';
import { CLOUDFLARE_D1_PATH, CLOUDFLARE_D1_BACKUP_PATH } from '../packages/contract/src/cloudflare-d1.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture as bundle, Miniflare } from './worker-entry-test-fixture.mjs';

const identityRequire = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = identityRequire('pg');
const { betterAuth } = await import(identityRequire.resolve('better-auth/minimal'));
const { organization } = await import(identityRequire.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(identityRequire.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(identityRequire.resolve('kysely'));
const fixtureDir = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const fixture = name => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));

test('original config HTTP and private RPC select fresh authorized workspaces in workerd', { timeout: 120000 }, async t => {
  let tools;
  try { tools = findPostgres(); } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') return t.skip(error.message);
    throw error;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-config-entry-'));
  let owner, admin, enginePool, runtime;
  try {
    const ingest = await bundle(root, 'ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts'));
    const tower = await bundle(root, 'tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts'));
    owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    applyMigrations(owner);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    const appUrl = owner.applicationLogin().url();
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(appUrl); url.username = 'noticeos_identity'; url.password = password;
    const manualBrowser = process.env.NOTICEOS_TEST_HOSTED_MANUAL_BROWSER === '1';
    const origin = manualBrowser ? 'http://127.0.0.1:6748' : 'https://fixture.example.test';
    const secret = randomBytes(48).toString('base64url');
    enginePool = new Pool({ connectionString: url.href, max: 1 });
    const engine = betterAuth({
      database: kyselyAdapter(new Kysely({ dialect: new PostgresDialect({ pool: enginePool }) }).withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })],
    });
    const personPassword = randomBytes(24).toString('base64url');
    const signup = await engine.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Generated person', email: 'person@example.test', password: personPassword }) }));
    assert.equal(signup.status, 200);
    const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const otherSignup = await engine.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Generated successor', email: 'successor@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(otherSignup.status, 200);
    const otherPerson = (await otherSignup.json()).user;
    if (manualBrowser) await enginePool.query('UPDATE noticeos_identity.auth_user SET email_verified=true WHERE id=$1', [otherPerson.id]);
    const otherCookie = otherSignup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const otherSession = (await engine.api.getSession({ headers: new Headers({ cookie: otherCookie }) })).session.id;
    const expectedSession = (await engine.api.getSession({ headers: new Headers({ cookie }) })).session.id;
    const keyBytes = randomBytes(32);
    const credentialsKey = keyBytes.toString('base64');
    const aes = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const privateValue = randomBytes(24).toString('base64url');
    const legacyCanary = randomBytes(24).toString('base64url');
    const [a, b, demo] = [randomUUID(), randomUUID(), randomUUID()];
    const googleGrants = new Map(), googleAccess = new Map();
    const bingKeys = new Map(), discordHooks = new Map();
    const calendarFeeds = new Map();
    const mediavineLogins = new Map(), mediavineAccess = new Map();
    const bingConnection = randomUUID(), discordConnection = randomUUID();
    const googleConnection = randomUUID(), googleAppConnection = randomUUID();
    const googleScopes = ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'];
    const googleApp = { GOOGLE_OAUTH_CLIENT_ID: randomBytes(24).toString('base64url'), GOOGLE_OAUTH_CLIENT_SECRET: randomBytes(24).toString('base64url') };
    for (const [id, slug, version] of [[a, 'tenant-a', 1], [b, 'tenant-b', 2], [demo, 'demo', 3]]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, slug]);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'example.test','example.test',$2,'live',1)", [id, `${slug} private asset`]);
      await enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, `identity-${slug}`]);
      const connectionId = bingConnection, iv = randomBytes(12);
      const bingKey = id === a ? privateValue : randomBytes(24).toString('base64url');
      bingKeys.set(bingKey, slug);
      const ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes,
        new TextEncoder().encode(JSON.stringify({ BING_WEBMASTER_API_KEY: bingKey }))));
      await admin.query("INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at,account) VALUES($1,$2,'bing-webmaster','shared',now(),now(),$3)", [id, connectionId, `${slug} generated account`]);
      await admin.query("INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at) VALUES($1,$2,1,$3,$4,1,'[\"BING_WEBMASTER_API_KEY\"]',now())", [id, connectionId, ciphertext, iv]);
      const refresh = randomBytes(24).toString('base64url'), access = randomBytes(24).toString('base64url');
      googleGrants.set(refresh, { slug, access }); googleAccess.set(access, slug);
      const hook = `https://discord.com/api/webhooks/123456789/${randomBytes(24).toString('base64url')}`;
      discordHooks.set(hook, slug);
      for (const [provider, connection, fields] of [
        ['google', googleConnection, { GOOGLE_OAUTH_REFRESH_TOKEN: refresh }],
        ['google-oauth-app', googleAppConnection, googleApp],
        ['discord', discordConnection, { DISCORD_WEBHOOK_URL: hook }],
      ]) {
        const nonce = randomBytes(12), sealed = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes,
          new TextEncoder().encode(JSON.stringify(fields))));
        await admin.query("INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at,account,scopes) VALUES($1,$2,$3,'shared',now(),now(),$4,$5)",
          [id, connection, provider, `${slug}@example.test`, JSON.stringify(googleScopes)]);
        await admin.query('INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at) VALUES($1,$2,1,$3,$4,1,$5,now())',
          [id, connection, sealed, nonce, JSON.stringify(Object.keys(fields))]);
      }
      await admin.query('INSERT INTO noticeos.connection_status_daily_counts(workspace_id,day,observed_at,sites_failing,sites_overdue,reports_missing,sites_working) VALUES($1,current_date,now(),$2,0,0,0)', [id, version]);
      for (const file of Object.values(TOWER_CONFIG_FILES)) {
        const name = path.basename(file, '.json');
        const body = name === 'beads' ? { hub: { host: 'private.example.test' }, spokes: [] } : fixture(name);
        if (name === 'constants') { body.os_time_zone = 'UTC'; body.operator_rate_usd_per_min = version * 101; body.monthly_caps.data_usd = version * 101; }
        if (name === 'integrations') body.assets['example.test'] = {
          'bing-webmaster': { status: 'live', siteUrl: `https://${slug}.example.test/` },
          ga4: { status: 'needs-setup', since: new Date().toISOString().slice(0, 10) },
          'ad-network': { status: 'needs-setup', since: new Date().toISOString().slice(0, 10) },
        };
        await admin.query('INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,$2,$3,$4,now(),$5)', [id, configDocumentKey(file), JSON.stringify(body), version, slug]);
      }
    }
    for (const [id, role] of [[a, 'owner'], [b, 'operator']]) await enginePool.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), id, person.id, role]);
    for (const id of [a, b]) await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), id, otherPerson.id]);
    const common = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin, NOTICEOS_WORKSPACE_DATABASE_URL: appUrl, NOTICEOS_IDENTITY_DATABASE_URL: url.href, NOTICEOS_IDENTITY_SESSION_SECRET: secret };
    let outside = 0;
    const outsideDetails = [];
    let revoke = false;
    let failReceiver = false;
    let revokeSummary = false;
    let revokeDiscovery = false, suspendDiscovery = false;
    let revokeReadiness = false, suspendReadiness = false;
    let revokeCredential = false, suspendCredential = false;
    let revokeCollection = false, suspendCollection = false, refuseBingCollection = false;
    let revokePanel = false, suspendPanel = false;
    let revokeResearch = false, suspendResearch = false;
    let revokeMutation = false, suspendMutation = false;
    let revokeWatch = false, suspendWatch = false;
    const candidateAnswers = new Map();
    let refuseGoogleRevocation = false;
    const providerCalls = [];
    const capturedGoogle = async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://ssl.bing.com' && url.pathname === '/webmaster/api.svc/json/GetUserSites') {
        const slug = bingKeys.get(url.searchParams.get('apikey'));
        assert.ok(slug); assert.equal(request.method, 'GET');
        providerCalls.push({ slug, family: 'bing-list' });
        const answer = candidateAnswers.get(url.searchParams.get('apikey'));
        if (answer === 'refused') return Response.json({ ErrorCode: 3, Message: 'Generated refused candidate' }, { status: 401 });
        if (answer === 'unreachable') return new Response(null, { status: 503 });
        return Response.json({ d: [{ Url: `https://${slug}.example.test/`, IsVerified: true }] });
      }
      if (url.origin === 'https://ssl.bing.com' && url.pathname === '/webmaster/api.svc/json/GetRankAndTrafficStats') {
        const slug = bingKeys.get(url.searchParams.get('apikey'));
        assert.ok(slug); assert.equal(url.searchParams.get('siteUrl'), `https://${slug}.example.test/`);
        providerCalls.push({ slug, family: 'bing-collect' });
        if (refuseBingCollection) return Response.json({ ErrorCode: 3, Message: 'Generated refused collection' }, { status: 401 });
        const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        return Response.json({ d: [{ Date: date, Clicks: slug === 'tenant-a' ? 12 : 24, Impressions: 340 }] });
      }
      if (url.href === 'https://api-publishers.mediavine.com/graphql') {
        const body = await request.json();
        if (body.query.includes('unidashSignIn')) {
          const selected = mediavineLogins.get(body.variables.data.email);
          assert.ok(selected); assert.equal(body.variables.data.password, selected.password);
          providerCalls.push({ slug: selected.slug, family: 'mediavine-login' });
          return Response.json({ data: { unidashSignIn: { accessToken: selected.access, refreshToken: selected.refresh, expiresIn: 3600, twoFactorRequired: false } } });
        }
        const selected = mediavineAccess.get(request.headers.get('authorization')?.replace(/^Bearer /u, ''));
        assert.ok(selected); assert.equal(body.variables.id ?? body.variables.siteId, 'shared-site');
        providerCalls.push({ slug: selected.slug, family: 'mediavine-collect' });
        const date = value => `${value.slice(6)}-${value.slice(0, 2)}-${value.slice(3, 5)}`;
        const start = date(body.variables.startDate), end = date(body.variables.endDate), days = [];
        for (let next = start; next <= end; next = new Date(Date.parse(next) + 86400000).toISOString().slice(0, 10)) days.push(next);
        const amount = selected.slug === 'tenant-a' ? 1.25 : 2.5;
        return Response.json({ data: { internalSite: { id: 'shared-site', title: 'Generated publisher', domain: 'example.test' },
          metricsSummary: { summary: { earnings: days.length * amount } },
          earningsReport: { earnings: days.map(day => ({ date: day.replaceAll('-', '/'), revenue: amount })) } } });
      }
      if (discordHooks.has(url.href)) {
        const slug = discordHooks.get(url.href);
        assert.equal(request.method, 'POST');
        const body = await request.json();
        assert.equal(body.content, 'NoticeOS connection test — nothing is wrong, you can ignore this.');
        assert.deepEqual(Object.keys(body), ['content']);
        providerCalls.push({ slug, family: 'discord-labelled-message' });
        return new Response(null, { status: 204 });
      }
      if (url.href === 'https://oauth2.googleapis.com/revoke') {
        assert.equal(request.method, 'POST');
        const body = await request.formData(), selected = googleGrants.get(body.get('token'));
        assert.ok(selected, 'only the selected generated grant can be revoked');
        providerCalls.push({ slug: selected.slug, family: 'google-revoke' });
        return new Response(null, { status: refuseGoogleRevocation ? 503 : 200 });
      }
      if (url.href === 'https://oauth2.googleapis.com/token') {
        const body = await request.formData(), selected = googleGrants.get(body.get('refresh_token'));
        assert.ok(selected, 'only generated selected-workspace grants may reach token exchange');
        assert.equal(body.get('client_id') === googleApp.GOOGLE_OAUTH_CLIENT_ID, true);
        assert.equal(body.get('client_secret') === googleApp.GOOGLE_OAUTH_CLIENT_SECRET, true);
        providerCalls.push({ slug: selected.slug, family: 'token' });
        return Response.json({ access_token: selected.access, expires_in: 3600, token_type: 'Bearer' });
      }
      const slug = googleAccess.get(request.headers.get('authorization')?.replace(/^Bearer /u, ''));
      if (slug && url.href === 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200') {
        providerCalls.push({ slug, family: 'ga4' });
        return Response.json({ accountSummaries: [{ displayName: `${slug} account`, propertySummaries: [{ property: 'properties/12345', displayName: `${slug} property` }] }] });
      }
      if (slug && url.href === 'https://analyticsadmin.googleapis.com/v1beta/properties/12345/dataStreams') {
        providerCalls.push({ slug, family: 'ga4-stream' });
        return Response.json({ dataStreams: [{ webStreamData: { defaultUri: `https://${slug}.example.test/` } }] });
      }
      if (slug && url.href === 'https://www.googleapis.com/webmasters/v3/sites') {
        providerCalls.push({ slug, family: 'gsc' });
        return Response.json({ siteEntry: [{ siteUrl: `https://${slug}.example.test/`, permissionLevel: 'siteOwner' }] });
      }
      if (slug && url.origin === 'https://analyticsdata.googleapis.com' && /^\/v1beta\/properties\/\d+\/metadata$/u.test(url.pathname)) {
        providerCalls.push({ slug, family: 'ga4-metadata' });
        return Response.json({ dimensions: [], metrics: [] });
      }
      if (slug && url.origin === 'https://analyticsdata.googleapis.com' && url.pathname === '/v1beta/properties/12345:runRealtimeReport') {
        const body = await request.json(), count = slug === 'tenant-a' ? 7 : 14;
        providerCalls.push({ slug, family: 'ga4-realtime' });
        assert.equal(request.method, 'POST');
        if (body.dimensions?.[0]?.name === 'minutesAgo') return Response.json({
          dimensionHeaders: [{ name: 'minutesAgo' }], metricHeaders: [{ name: 'activeUsers' }],
          rows: [{ dimensionValues: [{ value: '00' }], metricValues: [{ value: String(count) }] }],
        });
        assert.deepEqual(body.minuteRanges.map(row => [row.name, row.startMinutesAgo, row.endMinutesAgo]),
          [['last_5_minutes', 4, 0], ['last_30_minutes', 29, 0]]);
        return Response.json({ dimensionHeaders: [{ name: 'dateRange' }], metricHeaders: [{ name: 'activeUsers' }],
          rows: ['last_5_minutes', 'last_30_minutes'].map(value => ({ dimensionValues: [{ value }], metricValues: [{ value: String(count) }] })) });
      }
      if (slug && url.origin === 'https://analyticsdata.googleapis.com' && url.pathname === '/v1beta/properties/12345:runReport') {
        providerCalls.push({ slug, family: 'ga4-hourly' });
        assert.equal(request.method, 'POST');
        return Response.json({ metadata: { timeZone: 'UTC' }, dimensionHeaders: [{ name: 'dateRange' }, { name: 'dateHour' }],
          metricHeaders: [{ name: 'activeUsers' }], rows: [] });
      }
      if (calendarFeeds.has(url.href)) {
        const selected = calendarFeeds.get(url.href);
        providerCalls.push({ slug: selected, family: 'calendar' });
        const instant = value => new Date(value).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
        return new Response(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:shared-event',
          'DTSTART:' + instant(Date.now() + 3600000), 'DTEND:' + instant(Date.now() + 7200000),
          'SUMMARY:' + selected + ' meeting', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
          { headers: { 'content-type': 'text/calendar' } });
      }
      outsideDetails.push({ host: url.hostname, method: request.method });
      outside++; throw new Error('No outside HTTP in config fixture');
    };
    const relay = `import { WorkerEntrypoint } from 'cloudflare:workers';
      export default class extends WorkerEntrypoint {
        async getConfigDocuments(files, proof) { const control = await this.env.CONTROL.fetch('https://fixture-control/'); if (!control.ok) throw new Error('Synthetic receiver failure'); return this.env.INGEST.getConfigDocuments(files, proof); }
        applyConfigOps(input, proof) { return this.env.INGEST.applyConfigOps(input, proof); }
        async listCredentialSummaries(proof) { await this.env.CONTROL.fetch('https://fixture-control/summary'); return this.env.INGEST.listCredentialSummaries(proof); }
        async integrationHealth(proof) { await this.env.CONTROL.fetch('https://fixture-control/summary'); return this.env.INGEST.integrationHealth(proof); }
        async discoverGoogleProperties(proof) { await this.env.CONTROL.fetch('https://fixture-control/discovery'); return this.env.INGEST.discoverGoogleProperties(proof); }
        async discoverSites(provider, proof) { await this.env.CONTROL.fetch('https://fixture-control/readiness'); return this.env.INGEST.discoverSites(provider, proof); }
        async probeCredential(provider, proof) { await this.env.CONTROL.fetch('https://fixture-control/readiness'); return this.env.INGEST.probeCredential(provider, proof); }
        async putCredential(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/credential'); return this.env.INGEST.putCredential(input, proof); }
        async deleteCredential(provider, proof) { await this.env.CONTROL.fetch('https://fixture-control/credential'); return this.env.INGEST.deleteCredential(provider, proof); }
        async setCredentialExpiry(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/credential'); return this.env.INGEST.setCredentialExpiry(input, proof); }
        async connectCredential(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/credential'); return this.env.INGEST.connectCredential(input, proof); }
        async putSiteToken(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/credential'); return this.env.INGEST.putSiteToken(input, proof); }
        async collectNow(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/collection'); return this.env.INGEST.collectNow(input, proof); }
        async syncMediavine(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/collection'); return this.env.INGEST.syncMediavine(input, proof); }
        async ga4Realtime(proof) { await this.env.CONTROL.fetch('https://fixture-control/panel'); return this.env.INGEST.ga4Realtime(proof); }
        async calendarUpcoming(proof) { await this.env.CONTROL.fetch('https://fixture-control/panel'); return this.env.INGEST.calendarUpcoming(proof); }
        async researchLookup(query, proof) { await this.env.CONTROL.fetch('https://fixture-control/research'); return this.env.INGEST.researchLookup(query, proof); }
        async backtestRule(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/research'); return this.env.INGEST.backtestRule(input, proof); }
        async watchQueryHistory(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/watch'); return this.env.INGEST.watchQueryHistory(input, proof); }
        async createAsset(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/mutation'); return this.env.INGEST.createAsset(input, proof); }
        async readAssetState(asset, proof) { await this.env.CONTROL.fetch('https://fixture-control/mutation'); return this.env.INGEST.readAssetState(asset, proof); }
        async writeAssetColumn(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/mutation'); return this.env.INGEST.writeAssetColumn(input, proof); }
        async moveAsset(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/mutation'); return this.env.INGEST.moveAsset(input, proof); }
        async createAnnotation(input, proof) { await this.env.CONTROL.fetch('https://fixture-control/mutation'); return this.env.INGEST.createAnnotation(input, proof); }


      }`;
    const driver = `export default {async fetch(request, env) {
      const asked = await request.json();
      if (asked.target) return env[asked.target].fetch(new Request(asked.url, asked.init));
      const proof = asked.proof ? new Request(asked.proof.url, asked.proof.init) : undefined;
      try {
        const result = await env[asked.receiver ?? 'INGEST'][asked.method](...(asked.args ?? []), ...(asked.proof ? [proof] : []));
        if (result instanceof Response) return result;
        try { return Response.json({ok:true,result}); }
        finally { result?.[Symbol.dispose]?.(); }
      }
      catch { return Response.json({ok:false}, {status:403}); }
    }};`;
    const worker = (name, options, bindings, serviceBindings) => ({ name, ...options, bindings, serviceBindings,
      outboundService: name === 'ingest' ? capturedGoogle : async request => {
        const url = new URL(request.url);
        if (name === 'tower' && url.href === 'https://example.com/') {
          providerCalls.push({ slug: 'public', family: 'site-name' });
          assert.equal(request.method, 'GET'); assert.equal(request.headers.has('cookie'), false);
          assert.equal(request.headers.has('authorization'), false);
          return new Response('<title>Generated public website</title>', { headers: { 'content-type': 'text/html' } });
        }
        outside++; throw new Error('No outside HTTP in config fixture');
      } });
    runtime = new Miniflare({ workers: [
      worker('driver', { modules: true, script: driver, compatibilityDate: '2026-07-06' }, {}, { INGEST: 'ingest', TOWER: 'tower', DEMO: 'demo', DEMO_INGEST: 'demo-ingest' }),
      worker('tower', tower, common, { INGEST: 'relay' }),
      worker('ingest', { ...ingest, r2Buckets: { RAW_SIGNALS: 'retained-watch-fixture' } }, { ...common, CREDENTIALS_KEY: credentialsKey, MEDIAVINE_USER: legacyCanary, MEDIAVINE_PASSWORD: legacyCanary }, {}),
      worker('relay', { modules: true, script: relay, compatibilityDate: '2026-07-06' }, {}, { INGEST: 'ingest', CONTROL: async request => {
        if (new URL(request.url).pathname === '/summary' && revokeSummary) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeSummary = false; }
        if (new URL(request.url).pathname === '/discovery' && revokeDiscovery) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeDiscovery = false; }
        if (new URL(request.url).pathname === '/discovery' && suspendDiscovery) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendDiscovery = false; }
        if (new URL(request.url).pathname === '/readiness' && revokeReadiness) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeReadiness = false; }
        if (new URL(request.url).pathname === '/readiness' && suspendReadiness) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendReadiness = false; }
        if (new URL(request.url).pathname === '/credential' && revokeCredential) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeCredential = false; }
        if (new URL(request.url).pathname === '/credential' && suspendCredential) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendCredential = false; }
        if (new URL(request.url).pathname === '/collection' && revokeCollection) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeCollection = false; }
        if (new URL(request.url).pathname === '/collection' && suspendCollection) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendCollection = false; }
        if (new URL(request.url).pathname === '/panel' && revokePanel) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokePanel = false; }
        if (new URL(request.url).pathname === '/panel' && suspendPanel) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendPanel = false; }
        if (new URL(request.url).pathname === '/research' && revokeResearch) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeResearch = false; }
        if (new URL(request.url).pathname === '/research' && suspendResearch) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendResearch = false; }
        if (new URL(request.url).pathname === '/watch' && revokeWatch) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeWatch = false; }
        if (new URL(request.url).pathname === '/watch' && suspendWatch) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendWatch = false; }
        if (new URL(request.url).pathname === '/mutation' && revokeMutation) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revokeMutation = false; }
        if (new URL(request.url).pathname === '/mutation' && suspendMutation) { await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]); suspendMutation = false; }
        if (failReceiver) return new Response(null, { status: 503 });
        if (revoke) { await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a, person.id]); revoke = false; }
        return new Response(null, { status: 204 });
      } }),
      worker('demo', tower, { ...common, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: demo }, { INGEST: 'demo-ingest' }),
      worker('demo-ingest', { ...ingest, r2Buckets: { RAW_SIGNALS: 'retained-watch-fixture' } }, { ...common, CREDENTIALS_KEY: credentialsKey, MEDIAVINE_USER: legacyCanary, MEDIAVINE_PASSWORD: legacyCanary, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: demo }, {}),
    ] });
    const dispatch = async asked => {
      const response = await runtime.dispatchFetch('https://fixture-driver/', { method: 'POST', body: JSON.stringify(asked) });
      // Complete the actual HTTP body even when an assertion needs only its
      // status. The reconstructed response preserves the bytes for later reads.
      const body = response.body === null ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const towerFetch = { fetch: (url, init) => dispatch({ target: 'TOWER', url, init }) };
    const demoFetch = { fetch: (url, init) => dispatch({ target: 'DEMO', url, init }) };
    const headers = workspace => ({ cookie, origin, 'x-noticeos-workspace-id': workspace, [WORKSPACE_SESSION_HEADER]: expectedSession });
    const get = async (workspace, client = towerFetch) => client.fetch(`${origin}/api/config`, { headers: headers(workspace) });
    const ops = [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: 'Europe/London' }];
    let collectionConfigAuditBoundary = 0;
    let collectionConstantsVersion = 1;
    const put = async (workspace, client = towerFetch, extra = {}) => client.fetch(`${origin}/api/config`, { method: 'PUT', headers: { ...headers(workspace), 'content-type': 'application/json' }, body: JSON.stringify({ ops, expectVersions: { 'config/constants.json': workspace === a ? collectionConstantsVersion : 2 }, ...extra }) });
    const rpc = async (method, args, proof) => dispatch({ method, args, proof });
    const proof = (workspace, init = {}) => ({ url: `${origin}/api/config`, init: { headers: headers(workspace), ...init } });
    const summaryPaths = ['/api/integrations/providers', '/api/integrations/health'];
    const summaryProof = (workspace, pathname, evidence = headers(workspace)) => ({ url: origin + pathname, init: { headers: evidence } });
    const credentialReadCount = async () => Number((await admin.query(
      'SELECT COALESCE(sum(calls),0) n FROM pg_stat_statements WHERE query LIKE $1 OR query LIKE $2',
      ['%FROM noticeos.integration_connections%', '%FROM noticeos.connection_secrets%'],
    )).rows[0].n);
    const discoveryPath = '/api/integrations/google/properties';
    const discoveryHeaders = workspace => {
      const evidence = { ...headers(workspace), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
      delete evidence.origin;
      return evidence;
    };
    const discovery = (workspace, evidence = discoveryHeaders(workspace)) => towerFetch.fetch(origin + discoveryPath, { headers: evidence });
    await t.test('Google discovery resolves only the selected grant and persists its own technical health', async () => {
      for (const [workspace, slug] of [[a, 'tenant-a'], [b, 'tenant-b']]) {
        const before = providerCalls.length, response = await discovery(workspace);
        assert.equal(response.status, 200, await response.clone().text());
        const text = await response.text(), payload = JSON.parse(text);
        assert.equal(payload.ok, true); assert.equal(payload.account, `${slug}@example.test`);
        assert.equal(payload.properties.find(row => row.lane === 'ga4').ref, '12345');
        assert.equal(payload.properties.find(row => row.lane === 'ga4').label, `${slug} property`);
        assert.equal(payload.properties.find(row => row.lane === 'gsc').ref, `https://${slug}.example.test/`);
        assert.deepEqual(providerCalls.slice(before).map(call => call.slug), [slug, slug, slug, slug]);
        for (const secretValue of [...googleGrants.keys(), ...googleAccess.keys(), ...Object.values(googleApp)]) assert.equal(text.includes(secretValue), false);
        const rows = (await admin.query("SELECT workspace_id,connection_revision FROM noticeos.capability_targets WHERE provider='google' AND capability='google-discovery' AND workspace_id=$1", [workspace])).rows;
        assert.equal(rows.length, 2); assert.ok(rows.every(row => row.workspace_id === workspace));
      }
      const rows = (await admin.query("SELECT workspace_id,connection_revision FROM noticeos.capability_targets WHERE provider='google' AND capability='google-discovery' ORDER BY workspace_id")).rows;
      assert.equal(new Set(rows.map(row => row.connection_revision)).size, 2, 'same physical connection IDs remain workspace-owned revisions');
      assert.equal(rows.some(row => row.workspace_id === demo), false);
      const result = await rpc('discoverGoogleProperties', [], { url: origin + discoveryPath, init: { headers: discoveryHeaders(b) } });
      assert.equal(result.status, 200); assert.equal((await result.json()).result.account, 'tenant-b@example.test');
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('discovery browser evidence, role, fixed route and successor-session failures precede credentials and providers', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      const missingSession = discoveryHeaders(a); delete missingSession[WORKSPACE_SESSION_HEADER];
      const absentEvidence = headers(a); delete absentEvidence.origin;
      for (const evidence of [missingSession, absentEvidence,
        { ...discoveryHeaders(a), cookie: otherCookie },
        { ...discoveryHeaders(a), 'x-noticeos-workspace-id': randomUUID() },
        { ...discoveryHeaders(a), origin: 'https://foreign.example.test' },
        { ...discoveryHeaders(a), origin, 'sec-fetch-site': 'cross-site' },
        { ...discoveryHeaders(a), 'sec-fetch-mode': 'navigate' }]) {
        assert.equal((await discovery(a, evidence)).status, 403);
        assert.equal((await rpc('discoverGoogleProperties', [], { url: origin + discoveryPath, init: { headers: evidence } })).status, 403);
      }
      for (const [path, method] of [[discoveryPath + '?workspace=' + b, 'GET'], [discoveryPath, 'POST'], ['/api/integrations/google/collect', 'GET']]) {
        const selected = { url: origin + path, init: { method, headers: discoveryHeaders(a) } };
        assert.equal((await towerFetch.fetch(selected.url, selected.init)).status, 403);
        assert.equal((await rpc('discoverGoogleProperties', [], selected)).status, 403);
      }
      assert.equal((await rpc('discoverGoogleProperties', [], { url: origin + '/api/integrations/google/sites', init: { headers: discoveryHeaders(a) } })).status, 403);
      assert.equal((await rpc('discoverGoogleProperties', [])).status, 403);
      assert.equal((await rpc('discoverGoogleProperties', [{}], { url: origin + discoveryPath, init: { headers: discoveryHeaders(a) } })).status, 403);
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { assert.equal((await discovery(b)).status, 403); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.equal((await demoFetch.fetch(origin + discoveryPath, { headers: discoveryHeaders(demo) })).status, 403);
      assert.equal((await dispatch({ receiver: 'DEMO_INGEST', method: 'discoverGoogleProperties', proof: { url: origin + discoveryPath, init: { headers: discoveryHeaders(demo) } } })).status, 403);
      assert.equal(await credentialReadCount(), 0);
      assert.equal(providerCalls.length, before); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('discovery receiver reloads membership and lifecycle after sender admission', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      revokeDiscovery = true;
      assert.equal((await discovery(a)).status, 403);
      await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
      suspendDiscovery = true;
      try { assert.equal((await discovery(a)).status, 403); }
      finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, before); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    const readinessProof = (workspace, provider, operation, evidence = discoveryHeaders(workspace)) => ({
      url: `${origin}/api/integrations/${provider}/${operation === 'probeCredential' ? 'test' : 'sites'}`,
      init: { headers: { ...evidence, ...(operation === 'probeCredential' ? { 'content-type': 'application/json' } : {}) },
        ...(operation === 'probeCredential' ? { method: 'POST', body: '{}' } : {}) },
    });
    const readiness = (workspace, provider, operation, evidence, client = towerFetch) => {
      const selected = readinessProof(workspace, provider, operation, evidence);
      return client.fetch(selected.url, selected.init);
    };
    await t.test('readiness calls use selected grants and keep site mappings and technical health workspace-owned', async () => {
      for (const [workspace, slug] of [[a, 'tenant-a'], [b, 'tenant-b']]) {
        for (const provider of ['bing-webmaster', 'google']) {
          const before = providerCalls.length;
          const response = await readiness(workspace, provider, 'discoverSites');
          assert.equal(response.status, 200, await response.clone().text());
          const text = await response.text(), payload = JSON.parse(text);
          assert.equal(payload.discovery.ok, true);
          assert.ok(payload.discovery.sites.some(site => site.host === `${slug}.example.test`));
          assert.equal(payload.assets.length, 1); assert.equal(payload.assets[0].label, `${slug} private asset`);
          if (provider === 'bing-webmaster') assert.equal(payload.assets[0].cells['bing-webmaster'].mapping.siteUrl, `https://${slug}.example.test/`);
          assert.ok(providerCalls.length > before); assert.ok(providerCalls.slice(before).every(call => call.slug === slug));
          for (const value of [...bingKeys.keys(), ...googleGrants.keys(), ...googleAccess.keys(), ...discordHooks.keys(), ...Object.values(googleApp)]) assert.equal(text.includes(value), false);
        }
        for (const provider of ['bing-webmaster', 'google', 'discord']) {
          const before = providerCalls.length;
          const response = await readiness(workspace, provider, 'probeCredential');
          assert.equal(response.status, 200, await response.clone().text());
          const payload = await response.json(); assert.equal(payload.ok, true);
          assert.ok(providerCalls.length > before); assert.ok(providerCalls.slice(before).every(call => call.slug === slug));
          if (provider === 'discord') assert.deepEqual(providerCalls.slice(before), [{ slug, family: 'discord-labelled-message' }]);
          const rows = (await admin.query('SELECT workspace_id,connection_revision FROM noticeos.capability_targets WHERE workspace_id=$1 AND provider=$2', [workspace, provider])).rows;
          assert.ok(rows.length > 0); assert.ok(rows.every(row => row.workspace_id === workspace));
        }
        for (const provider of INTEGRATION_PROVIDER_IDS.filter(id => !['google', 'google-oauth-app', 'bing-webmaster', 'discord'].includes(id))) {
          const before = providerCalls.length;
          for (const operation of ['discoverSites', 'probeCredential']) {
            const response = await readiness(workspace, provider, operation);
            assert.equal(response.status, 200, await response.clone().text());
            const payload = await response.json();
            assert.equal(operation === 'discoverSites' ? payload.discovery.ok : payload.ok, false);
            if (provider === 'dataforseo' && operation === 'discoverSites') {
              assert.equal(payload.spend.capUsd, workspace === a ? 101 : 202);
              assert.equal(payload.spend.spentUsd, 0);
            }
          }
          assert.equal(providerCalls.length, before, 'unconnected/unsupported providers cannot use environment fallback');
        }
      }
      for (const provider of ['bing-webmaster', 'discord']) {
        const rows = (await admin.query('SELECT workspace_id,connection_revision FROM noticeos.capability_targets WHERE provider=$1', [provider])).rows;
        assert.equal(new Set(rows.map(row => row.connection_revision)).size, 2);
        assert.equal(rows.some(row => row.workspace_id === demo), false);
      }
      for (const operation of ['discoverSites', 'probeCredential']) {
        const answer = await rpc(operation, ['bing-webmaster'], readinessProof(b, 'bing-webmaster', operation));
        assert.equal(answer.status, 200);
      }
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('readiness refusals do not read credentials, post messages, or touch provider accounts', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      const missingSession = discoveryHeaders(a); delete missingSession[WORKSPACE_SESSION_HEADER];
      const missingEvidence = headers(a); delete missingEvidence.origin;
      for (const operation of ['discoverSites', 'probeCredential']) {
        for (const evidence of [missingSession, missingEvidence, { ...discoveryHeaders(a), cookie: otherCookie },
          { ...discoveryHeaders(a), origin: 'https://foreign.example.test' },
          { ...discoveryHeaders(a), origin, 'sec-fetch-site': 'cross-site' },
          { ...discoveryHeaders(a), 'x-noticeos-workspace-id': randomUUID() }]) {
          assert.equal((await readiness(a, 'discord', operation, evidence)).status, 403);
          assert.equal((await rpc(operation, ['discord'], readinessProof(a, 'discord', operation, evidence))).status, 403);
        }
        assert.equal((await rpc(operation, ['google'], readinessProof(a, 'discord', operation))).status, 403);
        assert.equal((await rpc(operation, ['discord'])).status, 403);
        assert.equal((await rpc(operation, ['discord'], readinessProof(a, 'discord', operation === 'discoverSites' ? 'probeCredential' : 'discoverSites'))).status, 403);
        assert.equal((await readiness(demo, 'discord', operation, discoveryHeaders(demo), demoFetch)).status, 403);
        assert.equal((await dispatch({ receiver: 'DEMO_INGEST', method: operation, args: ['discord'], proof: readinessProof(demo, 'discord', operation) })).status, 403);
        const extra = readinessProof(a, 'discord', operation); extra.url += '?workspace=' + b;
        assert.equal((await towerFetch.fetch(extra.url, extra.init)).status, 403);
        assert.equal((await rpc(operation, ['discord'], extra)).status, 403);
        assert.equal((await readiness(a, 'unknown-provider', operation)).status, 403);
      }
      for (const body of ['{"provider":"google"}', '{', '[]', ' '.repeat(65537)]) {
        const selected = readinessProof(a, 'discord', 'probeCredential'); selected.init.body = body;
        assert.equal((await towerFetch.fetch(selected.url, selected.init)).status, 403);
        assert.equal((await rpc('probeCredential', ['discord'], selected)).status, 403);
      }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try {
        for (const operation of ['discoverSites', 'probeCredential']) assert.equal((await readiness(b, 'discord', operation)).status, 403);
      } finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      // The maintained reader can delete an expired session. Use a distinct
      // maintained signed session so later assertions retain their real owner.
      const login = await engine.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@example.test', password: personPassword }) }));
      assert.equal(login.status, 200);
      const expiringCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      await login.body?.cancel();
      const expiringSession = (await engine.api.getSession({ headers: new Headers({ cookie: expiringCookie }) })).session.id;
      await enginePool.query('UPDATE noticeos_identity.auth_session SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiringSession]);
      for (const operation of ['discoverSites', 'probeCredential']) {
        const evidence = { ...discoveryHeaders(a), cookie: expiringCookie, [WORKSPACE_SESSION_HEADER]: expiringSession };
        assert.equal((await readiness(a, 'discord', operation, evidence)).status, 403);
        assert.equal((await rpc(operation, ['discord'], readinessProof(a, 'discord', operation, evidence))).status, 403);
      }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, before); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('both readiness receivers reload membership and lifecycle after sender admission', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const operation of ['discoverSites', 'probeCredential']) {
        revokeReadiness = true;
        assert.equal((await readiness(a, 'discord', operation)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
        suspendReadiness = true;
        try { assert.equal((await readiness(a, 'discord', operation)).status, 403); }
        finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
      }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, before); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('integration summaries and daily health belong to the selected customer or fixed demo', async () => {
      for (const [workspace, slug, count] of [[a, 'tenant-a', 1], [b, 'tenant-b', 2], [demo, 'demo', 3]]) {
        const client = workspace === demo ? demoFetch : towerFetch;
        const evidence = workspace === demo ? { cookie: otherCookie } : headers(workspace);
        for (const pathname of summaryPaths) {
          const response = await client.fetch(origin + pathname, { headers: evidence });
          assert.equal(response.status, 200, `${slug} ${pathname}: ${await response.clone().text()}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const text = await response.text(), payload = JSON.parse(text);
          assert.equal(text.includes(privateValue), false);
          assert.equal(text.includes(legacyCanary), false);
          if (pathname.endsWith('/providers')) {
            const bing = payload.providers.find(row => row.provider.id === 'bing-webmaster').credential;
            assert.equal(bing.metadata.account, `${slug} generated account`);
            assert.equal(bing.source, 'store');
            assert.equal(payload.providers.find(row => row.provider.id === 'mediavine').credential.source, 'none');
          } else assert.equal(payload.countsHistory.series.sitesFailing[0].v, count);
        }
      }
      for (const pathname of summaryPaths) {
        assert.equal((await demoFetch.fetch(origin + pathname, { headers: headers(a) })).status, 403);
      }
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('fixed summary RPCs require their corresponding original path and fresh signed session', async () => {
      for (const [method, pathname] of [['listCredentialSummaries', summaryPaths[0]], ['integrationHealth', summaryPaths[1]]]) {
        assert.equal((await rpc(method, [], summaryProof(a, pathname))).status, 200);
        await admin.query('SELECT pg_stat_statements_reset()');
        const otherPath = pathname === summaryPaths[0] ? summaryPaths[1] : summaryPaths[0];
        assert.equal((await rpc(method, [], summaryProof(a, otherPath))).status, 403);
        assert.equal((await rpc(method, [])).status, 403);
        assert.equal((await rpc(method, [{}], summaryProof(a, pathname))).status, 403);
        const mismatch = { ...headers(a), cookie: otherCookie };
        assert.equal((await rpc(method, [], summaryProof(a, pathname, mismatch))).status, 403);
        assert.equal((await towerFetch.fetch(origin + pathname, { headers: mismatch })).status, 403);
        assert.equal(await credentialReadCount(), 0, 'refused session/method proofs cannot query stored credentials');
      }
    });
    await t.test('receiver rechecks revoked membership before either integration status read', async () => {
      for (const pathname of summaryPaths) {
        await admin.query('SELECT pg_stat_statements_reset()');
        revokeSummary = true;
        assert.equal((await towerFetch.fetch(origin + pathname, { headers: headers(a) })).status, 403);
        assert.equal(await credentialReadCount(), 0, 'sender admission does not survive receiver membership removal');
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
      }
    });
    await t.test('owner/operator read exact workspace versions, without host or secret settings', async () => {
      for (const [workspace, version] of [[a, 1], [b, 2]]) {
        const response = await get(workspace); assert.equal(response.status, 200);
        const body = await response.json(); assert.equal(body.writable, true); assert.equal(body.versions['config/constants.json'], version);
        assert.equal(JSON.stringify(body).includes('private.example.test'), false); assert.equal(JSON.stringify(body).includes(secret), false);
      }
      const answer = await rpc('getConfigDocuments', [Object.values(TOWER_CONFIG_FILES)], proof(b));
      assert.equal(answer.status, 200);
      assert.ok((await answer.json()).result.every(row => row.version === 2));
      assert.equal((await rpc('getConfigDocuments', [['config/constants.json']], proof(a))).status, 403);
      assert.equal((await rpc('getConfigDocuments', [['../../private.json']], proof(a))).status, 403);
    });
    await t.test('same-workspace successor cookie cannot issue predecessor reads or writes at Tower or receiver', async () => {
      const count = async () => (await admin.query('SELECT count(*)::int n FROM noticeos.config_changes')).rows[0].n;
      const before = await count();
      for (const expected of [undefined, 'malformed', `${expectedSession}, ${expectedSession}`, expectedSession]) {
        const evidence = { ...headers(a), cookie: otherCookie };
        if (expected === undefined) delete evidence[WORKSPACE_SESSION_HEADER]; else evidence[WORKSPACE_SESSION_HEADER] = expected;
        assert.equal((await towerFetch.fetch(`${origin}/api/config`, { headers: evidence })).status, 403);
        const readProof = { url: `${origin}/api/config`, init: { headers: evidence } };
        assert.equal((await rpc('getConfigDocuments', [Object.values(TOWER_CONFIG_FILES)], readProof)).status, 403);
        const init = { method: 'PUT', headers: { ...evidence, 'content-type': 'application/json' }, body: JSON.stringify({ ops, reason: null }) };
        assert.equal((await towerFetch.fetch(`${origin}/api/config`, init)).status, 403);
        assert.equal((await rpc('applyConfigOps', [{ ops, reason: null, expectVersions: null, actor: person.id }], { url: `${origin}/api/config`, init })).status, 403);
      }
      assert.equal(await count(), before);
      const matched = { ...headers(a), cookie: otherCookie, [WORKSPACE_SESSION_HEADER]: otherSession };
      assert.equal((await towerFetch.fetch(`${origin}/api/config`, { headers: matched })).status, 200);
      assert.equal((await rpc('getConfigDocuments', [Object.values(TOWER_CONFIG_FILES)], { url: `${origin}/api/config`, init: { headers: matched } })).status, 200);
    });
    await t.test('stored dashboard and Settings reads use one selected workspace across HTTP and config RPC', async () => {
      const routes = ['/api/settings', '/api/wall', '/api/wall/feed', '/api/financials', '/api/alerts/history', '/api/alerts/rules', '/api/work', '/api/task-source', '/api/integrations'];
      for (const [workspace, marker] of [[a, 'tenant-a'], [b, 'tenant-b']]) {
        for (const pathname of routes) {
          const response = await towerFetch.fetch(origin + pathname, { headers: headers(workspace) });
          assert.equal(response.status, 200, `${marker} ${pathname}: ${await response.clone().text()}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const payload = await response.text();
          for (const foreign of ['tenant-a', 'tenant-b', 'demo'].filter(value => value !== marker)) assert.equal(payload.includes(`${foreign} private asset`), false);
          assert.equal(payload.includes('private.example.test'), false);
          if (pathname === '/api/wall') assert.equal(payload.includes(`${marker} private asset`), true);
          if (pathname === '/api/settings') assert.equal(JSON.parse(payload).taskHub.hub, null);
        }
        const readProof = { url: origin + '/api/settings', init: { headers: headers(workspace) } };
        const read = await rpc('getConfigDocuments', [Object.values(TOWER_CONFIG_FILES)], readProof);
        assert.equal(read.status, 200); assert.ok((await read.json()).result.every(row => row.version === (workspace === a ? 1 : 2)));
      }
      for (const pathname of routes) {
        for (const evidence of [headers(randomUUID()), { ...headers(a), cookie: otherCookie }, { ...headers(a), [WORKSPACE_SESSION_HEADER]: 'malformed' }]) {
          assert.equal((await towerFetch.fetch(origin + pathname, { headers: evidence })).status, 403);
        }
        assert.equal((await towerFetch.fetch(origin + pathname, { method: 'POST', headers: headers(a) })).status, 403);
      }
      failReceiver = true;
      try {
        const response = await towerFetch.fetch(origin + '/api/settings', { headers: headers(a) });
        assert.equal(response.status, 403, 'receiver refusal cannot become a successful compiled-default response');
      } finally { failReceiver = false; }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.config_changes')).rows[0].n, 0);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('asset details and every tab retain one workspace for identical asset IDs', async () => {
      const views = ['', 'overview', 'growth', 'financials', 'search', 'alerts', 'tasks', 'activity', 'sources', 'settings'];
      for (const [client, workspace, marker] of [[towerFetch, a, 'tenant-a'], [towerFetch, b, 'tenant-b'], [demoFetch, demo, 'demo']]) {
        const evidence = client === demoFetch ? { cookie: otherCookie } : headers(workspace);
        for (const view of views) {
          const response = await client.fetch(origin + '/api/assets/example.test' + (view ? `?view=${view}` : ''), { headers: evidence });
          assert.equal(response.status, 200, `${marker} ${view}: ${await response.clone().text()}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const body = await response.json();
          assert.equal(body.asset.displayName, `${marker} private asset`);
          const text = JSON.stringify(body);
          for (const foreign of ['tenant-a', 'tenant-b', 'demo'].filter(value => value !== marker)) assert.equal(text.includes(`${foreign} private asset`), false);
          assert.equal(text.includes(secret), false);
          assert.equal(text.includes('private.example.test'), false);
        }
      }
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'foreign.test','foreign.test','Only tenant B','live',2)", [b]);
      assert.equal((await towerFetch.fetch(origin + '/api/assets/foreign.test', { headers: headers(b) })).status, 200);
      assert.equal((await towerFetch.fetch(origin + '/api/assets/foreign.test', { headers: headers(a) })).status, 404);
      assert.equal((await demoFetch.fetch(origin + '/api/assets/foreign.test', { headers: { cookie: otherCookie } })).status, 404);
      for (const view of ['wrong', '../../private']) assert.equal((await towerFetch.fetch(origin + `/api/assets/example.test?view=${encodeURIComponent(view)}`, { headers: headers(a) })).status, 400);
      for (const path of ['/api/assets/', '/api/assets/example.test/more', '/api/assets/example%2etest', '/api/assets/%FF']) assert.equal((await towerFetch.fetch(origin + path, { headers: headers(a) })).status, 403);
      for (const evidence of [headers(randomUUID()), { ...headers(a), cookie: otherCookie }, { ...headers(a), [WORKSPACE_SESSION_HEADER]: 'malformed' }]) {
        assert.equal((await towerFetch.fetch(origin + '/api/assets/example.test', { headers: evidence })).status, 403);
      }
      assert.equal((await demoFetch.fetch(origin + '/api/assets/example.test', { headers: headers(a) })).status, 403);
      failReceiver = true;
      try {
        const response = await towerFetch.fetch(origin + '/api/assets/example.test', { headers: headers(a) });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'workspace_entry_unavailable' });
      } finally { failReceiver = false; }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.config_changes')).rows[0].n, 0);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    const credentialProof = (workspace, provider, method, body, evidence = headers(workspace)) => ({
      url: `${origin}/api/integrations/${provider}/${method === 'setCredentialExpiry' ? 'expiry' : method === 'putSiteToken' ? 'site-token' : method === 'connectCredential' ? 'connect' : 'credential'}`,
      init: { method: method === 'deleteCredential' ? 'DELETE' : method === 'connectCredential' ? 'POST' : 'PUT',
        headers: { ...evidence, ...(method === 'deleteCredential' ? {} : { 'content-type': 'application/json' }) },
        ...(method === 'deleteCredential' ? {} : { body: JSON.stringify(body) }) },
    });
    const credentialWrite = (workspace, provider, method, body, evidence, client = towerFetch) => {
      const selected = credentialProof(workspace, provider, method, body, evidence);
      return client.fetch(selected.url, selected.init);
    };
    const credentialRows = async workspace => (await admin.query(`SELECT c.provider,c.connection_id,c.account,c.expires_at,c.expiry_source,
      s.secret_version,encode(s.ciphertext,'hex') ciphertext,encode(s.iv,'hex') iv
      FROM noticeos.integration_connections c JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
      WHERE c.workspace_id=$1 ORDER BY c.provider`, [workspace])).rows;
    const plaintext = async (workspace, provider) => {
      const row = (await credentialRows(workspace)).find(value => value.provider === provider);
      if (!row) return null;
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
      return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.iv, 'hex') }, key, Buffer.from(row.ciphertext, 'hex'))));
    };
    const collectionConfigWrite = async (workspace, file, pointer, value, held) => {
      const row = (await admin.query('SELECT version FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key=$2', [workspace, configDocumentKey(file)])).rows[0];
      const op = value === undefined
        ? { kind: 'file-json-delete', file, pointer, expect: held }
        : { kind: 'file-json-set', file, pointer, value, ...(held === undefined ? { expectAbsent: true } : { expect: held }) };
      const response = await towerFetch.fetch(`${origin}/api/config`, { method: 'PUT', headers: { ...headers(workspace), 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [op], expectVersions: { [file]: row.version }, reason: 'Synthetic collection setup' }) });
      assert.equal(response.status, 200, `${pointer}: ${await response.clone().text()}`);
      assert.equal((await response.json()).applied, 1);
    };
    const collectionProof = (workspace, method, body, evidence = discoveryHeaders(workspace), provider = 'bing-webmaster') => ({
      url: method === 'collectNow' ? `${origin}/api/integrations/${provider}/collect` : `${origin}/api/integrations/mediavine/sync`,
      init: { method: 'POST', headers: { ...evidence, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    });
    const collect = (workspace, method, body, evidence, client = towerFetch, provider) => {
      const proof = collectionProof(workspace, method, body, evidence, provider);
      return client.fetch(proof.url, proof.init);
    };
    await t.test('manual collections persist selected signals and history for colliding asset identifiers', async () => {
      for (const [workspace, slug, clicks] of [[a, 'tenant-a', 12], [b, 'tenant-b', 24]]) {
        const before = providerCalls.length;
        const response = await collect(workspace, 'collectNow', { assets: ['example.test'] });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json(); assert.equal(payload.ok, true);
        assert.deepEqual(payload.sites.map(site => site.asset), ['example.test']);
        assert.ok(providerCalls.slice(before).every(call => call.slug === slug));
        assert.equal(providerCalls.slice(before).filter(call => call.family === 'bing-collect').length, 1);
        const stored = (await admin.query("SELECT o.value::int value FROM noticeos.signal_observations o JOIN noticeos.measurement_series s USING(workspace_id,series_id) WHERE o.workspace_id=$1 AND s.asset_id='example.test' AND s.metric='clicks' AND s.integration='bing-webmaster'", [workspace])).rows;
        assert.ok(stored.some(row => row.value === clicks));
        assert.ok((await admin.query('SELECT * FROM noticeos.job_runs WHERE workspace_id=$1', [workspace])).rows.length > 0);
      }
      const { proveHostedManualHistory } = await import('./test-fixtures/hosted-manual-history.mjs');
      await proveHostedManualHistory({ admin, towerFetch, demoFetch, origin, headers, workspaces: [a, b] });
      assert.equal((await admin.query('SELECT * FROM noticeos.job_runs WHERE workspace_id=$1', [demo])).rows.length, 0);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('Mediavine sync keeps identical publisher IDs and booked amounts in the selected workspace', async () => {
      const connection = randomUUID();
      const start = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
      const end = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      for (const [workspace, slug, total] of [[a, 'tenant-a', 250], [b, 'tenant-b', 500]]) {
        const password = randomBytes(24).toString('base64url'), access = randomBytes(24).toString('base64url'), refresh = randomBytes(24).toString('base64url');
        const email = `${slug}@example.test`, selected = { slug, password, access, refresh };
        mediavineLogins.set(email, selected); mediavineAccess.set(access, selected);
        const fields = { MEDIAVINE_USER: email, MEDIAVINE_PASSWORD: password };
        // Keep the same connection identifier across tenants, then let the
        // ordinary encrypted writer establish the actual secret revision.
        await admin.query("INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at,account) VALUES($1,$2,'mediavine','shared',now(),now(),$3)", [workspace, connection, email]);
        const stored = await credentialWrite(workspace, 'mediavine', 'putCredential', { fields });
        assert.equal(stored.status, 204, await stored.clone().text());
        assert.deepEqual(await plaintext(workspace, 'mediavine'), fields);
        assert.equal((await credentialRows(workspace)).find(row => row.provider === 'mediavine').connection_id, connection);
        for (const [field, value] of [['mediavineSiteId', 'shared-site'], ['mediavineEnabled', true]]) {
          await collectionConfigWrite(workspace, 'config/integrations.json', `/assets/example.test/ad-network/${field}`, value, undefined);
        }
        const before = providerCalls.length;
        const response = await collect(workspace, 'syncMediavine', { asset: 'example.test', start, end });
        assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).ok, true);
        assert.deepEqual(providerCalls.slice(before).map(call => call.slug), [slug, slug]);
        const rows = (await admin.query('SELECT sum(amount_minor)::int total FROM noticeos.mediavine_current_daily WHERE workspace_id=$1 AND asset_id=$2 AND site_id=$3', [workspace, 'example.test', 'shared-site'])).rows;
        assert.equal(rows[0].total, total);
        const again = providerCalls.length;
        const busy = await collect(workspace, 'syncMediavine', { asset: 'example.test', start, end });
        assert.equal(busy.status, 422); assert.equal((await busy.json()).ok, false);
        assert.equal(providerCalls.length, again, 'existing recent-attempt control prevents another provider sync');
      }
      assert.equal((await admin.query('SELECT * FROM noticeos.mediavine_runs WHERE workspace_id=$1', [demo])).rows.length, 0);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('schedule pause and provider refusal keep their ordinary bounded collection outcomes', async () => {
      const key = configDocumentKey('config/constants.json');
      const saved = (await admin.query('SELECT body FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key=$2', [a, key])).rows[0].body;
      let before = providerCalls.length;
      const paused = { ...saved.schedules, pull: { enabled: false, cron: '30 2 * * *' } };
      await collectionConfigWrite(a, 'config/constants.json', '/schedules', paused, saved.schedules);
      try {
        const response = await collect(a, 'collectNow', { assets: ['example.test'] });
        assert.equal(response.status, 200); assert.equal((await response.json()).error, 'paused');
        assert.equal(providerCalls.length, before);
      } finally { await collectionConfigWrite(a, 'config/constants.json', '/schedules', saved.schedules, paused); }
      refuseBingCollection = true; before = providerCalls.length;
      try {
        const response = await collect(a, 'collectNow', { assets: ['example.test'] });
        assert.equal(response.status, 200); assert.equal((await response.json()).sites[0].outcome, 'failed');
        assert.equal(providerCalls.slice(before).filter(call => call.family === 'bing-collect').length, 1, 'no automatic adopted retry');
      } finally { refuseBingCollection = false; }
    });
    await t.test('both collection RPCs reject foreign assets and fabricated payload authority before credential reads', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const [method, body, input] of [
        ['collectNow', { assets: ['example.test'] }, { provider: 'bing-webmaster', assets: ['example.test'] }],
        ['syncMediavine', { asset: 'example.test' }, { asset: 'example.test' }],
      ]) {
        const proof = collectionProof(a, method, body);
        const changed = method === 'collectNow' ? { ...input, assets: ['foreign.test'] } : { asset: 'foreign.test' };
        assert.equal((await rpc(method, [changed], proof)).status, 403);
        assert.equal((await rpc(method, [input])).status, 403);
        for (const key of ['actor', 'workspaceId', 'lane', 'serviceId', 'action']) {
          assert.equal((await rpc(method, [{ ...input, [key]: 'forged' }], proof)).status, 403);
          assert.equal((await collect(a, method, { ...body, [key]: 'forged' })).status, 403);
        }
        const foreign = method === 'collectNow' ? { assets: ['foreign.test'] } : { asset: 'foreign.test' };
        assert.equal((await collect(a, method, foreign)).status, 403);
        assert.equal((await collect(demo, method, body, discoveryHeaders(demo), demoFetch)).status, 403);
        for (const evidence of [{ ...discoveryHeaders(a), cookie: otherCookie },
          { ...discoveryHeaders(a), origin: 'https://foreign.example.test' },
          { ...discoveryHeaders(a), 'sec-fetch-site': 'cross-site' },
          { ...discoveryHeaders(a), 'x-noticeos-workspace-id': randomUUID() }]) {
          assert.equal((await collect(a, method, body, evidence)).status, 403);
          assert.equal((await rpc(method, [input], collectionProof(a, method, body, evidence))).status, 403);
        }
      }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, before);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('collection receivers reload current membership and lifecycle before effects', async () => {
      const before = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const [method, body] of [['collectNow', { assets: ['example.test'] }], ['syncMediavine', { asset: 'example.test' }]]) {
        revokeCollection = true; assert.equal((await collect(a, method, body)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
        suspendCollection = true;
        try { assert.equal((await collect(a, method, body)).status, 403); }
        finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
        await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
        try { assert.equal((await collect(b, method, body)).status, 403); }
        finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, before);
    });
    const panelPaths = ['/api/ga4/realtime', '/api/calendar/upcoming', '/api/site-name?domain=example.com'];
    const panelMethods = ['ga4Realtime', 'calendarUpcoming'];
    const panelEvidence = workspace => ({ ...discoveryHeaders(workspace), referer: origin + '/wall' });
    const panelProof = (workspace, index, evidence = panelEvidence(workspace)) => ({ url: origin + panelPaths[index], init: { headers: evidence } });
    const panel = (workspace, index, evidence, client = towerFetch) => {
      const selected = panelProof(workspace, index, evidence);
      return client.fetch(selected.url, selected.init);
    };
    await t.test('live panels retain colliding provider identifiers, cached data and health in the selected workspace', async () => {
      const calendarConnection = randomUUID();
      for (const [workspace, slug, expected] of [[a, 'tenant-a', 7], [b, 'tenant-b', 14]]) {
        await collectionConfigWrite(workspace, 'config/integrations.json', '/assets/example.test/ga4/propertyId', '12345', undefined);
        const feed = `https://calendar.example.com/${randomBytes(24).toString('base64url')}`;
        calendarFeeds.set(feed, slug);
        await admin.query("INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at,account) VALUES($1,$2,'calendar','shared',now(),now(),$3)", [workspace, calendarConnection, `${slug} calendar`]);
        assert.equal((await credentialWrite(workspace, 'calendar', 'putCredential', { fields: { CALENDAR_FEEDS: JSON.stringify({ Shared: feed }) } })).status, 204);
        const before = providerCalls.length;
        const realtime = await panel(workspace, 0);
        assert.equal(realtime.status, 200, await realtime.clone().text());
        const value = await realtime.json();
        assert.equal(value.assets.length, 1); assert.equal(value.assets[0].asset, 'example.test');
        assert.equal(value.assets[0].activeUsers5m, expected); assert.equal(value.assets[0].activeUsers30m, expected);
        for (const secretValue of [...googleGrants.keys(), ...googleAccess.keys(), ...Object.values(googleApp)]) assert.equal(JSON.stringify(value).includes(secretValue), false);
        assert.equal(value.assets[0].errorCode, null); assert.equal(value.assets[0].timeZone, 'UTC');
        const upcoming = await panel(workspace, 1);
        assert.equal(upcoming.status, 200, await upcoming.clone().text());
        const text = await upcoming.text(), calendar = JSON.parse(text);
        assert.equal(calendar.feedsConfigured, 1); assert.equal(calendar.feedsOk, 1);
        assert.equal(calendar.calendars[0].id, 'Shared');
        assert.equal(calendar.meetings[0].title, `${slug} meeting`);
        assert.equal(text.includes(feed), false);
        assert.ok(providerCalls.slice(before).length >= 4);
        assert.ok(providerCalls.slice(before).every(call => call.slug === slug));
        const cachedBoundary = providerCalls.length;
        for (const [index, method] of panelMethods.entries()) {
          const cached = await rpc(method, [], panelProof(workspace, index));
          assert.equal(cached.status, 200);
          const answer = (await cached.json()).result;
          if (index === 0) assert.equal(answer.assets[0].activeUsers5m, expected);
          else assert.equal(answer.meetings[0].title, `${slug} meeting`);
        }
        assert.equal(providerCalls.length, cachedBoundary, 'same-owner read reuses its own cache');
        const site = await panel(workspace, 2);
        assert.equal(site.status, 200); assert.deepEqual(await site.json(), { name: 'Generated public website' });
      }
      const rows = (await admin.query("SELECT workspace_id,provider,connection_revision FROM noticeos.capability_targets WHERE capability IN ('ga4-realtime','calendar-feed')")).rows;
      for (const provider of ['google', 'calendar']) {
        const targets = rows.filter(row => row.provider === provider);
        assert.ok(targets.some(row => row.workspace_id === a)); assert.ok(targets.some(row => row.workspace_id === b));
        assert.equal(new Set(targets.map(row => row.connection_revision)).size, 2);
      }
      assert.equal(rows.some(row => row.workspace_id === demo), false);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('live panel original evidence, fixed routes, role and session refusals precede credentials and outbound calls', async () => {
      await admin.query('SELECT pg_stat_statements_reset()');
      const before = providerCalls.length;
      const variants = [
        { ...panelEvidence(a), origin: 'https://foreign.example.test' },
        { ...panelEvidence(a), 'sec-fetch-site': 'cross-site' },
        headers(a),
        { ...panelEvidence(a), cookie: otherCookie },
        { ...panelEvidence(a), [WORKSPACE_SESSION_HEADER]: randomUUID() },
        { ...panelEvidence(a), 'x-noticeos-workspace-id': demo },
      ];
      // Origin alone is legitimate; this variant has neither Origin nor Fetch Metadata.
      delete variants[2].origin;
      for (const evidence of variants) for (let index = 0; index < panelPaths.length; index++) {
        assert.equal((await panel(a, index, evidence)).status, 403);
        if (index < 2) assert.equal((await rpc(panelMethods[index], [], panelProof(a, index, evidence))).status, 403);
      }
      for (let index = 0; index < panelPaths.length; index++) {
        assert.equal((await panel(demo, index, panelEvidence(demo), demoFetch)).status, 403);
        assert.equal((await towerFetch.fetch(origin + panelPaths[index], { method: 'POST', headers: panelEvidence(a) })).status, 403);
      }
      for (const [index, method] of panelMethods.entries()) {
        assert.equal((await rpc(method, [], panelProof(a, 1 - index))).status, 403);
        assert.equal((await rpc(method, [], { url: origin + panelPaths[index] + '?property=12345', init: { headers: panelEvidence(a) } })).status, 403);
        assert.equal((await rpc(method, [])).status, 403);
        assert.equal((await dispatch({ receiver: 'DEMO_INGEST', method, args: [], proof: panelProof(demo, index) })).status, 403);
      }
      for (const suffix of ['/api/site-name', '/api/site-name?domain=example.com&domain=other.example.com', '/api/ga4/realtime?property=12345', '/api/calendar/upcoming?feed=Shared']) {
        assert.equal((await towerFetch.fetch(origin + suffix, { headers: panelEvidence(a) })).status, 403);
      }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='unknown-role' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { for (let index = 0; index < panelPaths.length; index++) assert.equal((await panel(b, index)).status, 403); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.equal(providerCalls.length, before); assert.equal(await credentialReadCount(), 0);
    });
    await t.test('both live provider receivers reload membership and lifecycle after sender admission', async () => {
      for (let index = 0; index < panelMethods.length; index++) {
        const before = providerCalls.length;
        await admin.query('SELECT pg_stat_statements_reset()');
        revokePanel = true;
        assert.equal((await panel(a, index)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
        suspendPanel = true;
        try { assert.equal((await panel(a, index)).status, 403); }
        finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
        assert.equal(providerCalls.length, before); assert.equal(await credentialReadCount(), 0);
      }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try {
        for (let index = 0; index < panelPaths.length; index++) assert.equal((await panel(b, index)).status, 403);
      } finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
    });

    await t.test('owner and operator rotate only their selected connection and validate catalogue fields', async () => {
      const foreignBefore = await credentialRows(demo), beforeCalls = providerCalls.length;
      for (const [workspace, slug] of [[a, 'tenant-a'], [b, 'tenant-b']]) {
        const before = (await credentialRows(workspace)).find(row => row.provider === 'bing-webmaster');
        const key = randomBytes(24).toString('base64url'); bingKeys.set(key, slug);
        const response = await credentialWrite(workspace, 'bing-webmaster', 'putCredential', { fields: { BING_WEBMASTER_API_KEY: key } });
        assert.equal(response.status, 204, await response.clone().text()); assert.equal(await response.text(), '');
        const after = (await credentialRows(workspace)).find(row => row.provider === 'bing-webmaster');
        assert.equal(after.connection_id, before.connection_id); assert.equal(after.secret_version, before.secret_version + 1);
        assert.notEqual(after.ciphertext, before.ciphertext);
        assert.deepEqual(await plaintext(workspace, 'bing-webmaster'), { BING_WEBMASTER_API_KEY: key });
      }
      assert.deepEqual(await credentialRows(demo), foreignBefore); assert.equal(providerCalls.length, beforeCalls);
      const before = await credentialRows(a);
      for (const fields of [{}, { BING_WEBMASTER_API_KEY: '' }, { BING_WEBMASTER_API_KEY: randomUUID(), unexpected: randomUUID() }]) {
        const response = await credentialWrite(a, 'bing-webmaster', 'putCredential', { fields });
        assert.equal(response.status, 422, await response.clone().text());
      }
      assert.deepEqual(await credentialRows(a), before); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('candidate connect stores only provider-accepted secrets and preserves refused replacements', async () => {
      const foreign = await credentialRows(b);
      for (const verdict of ['refused', 'unreachable', 'accepted']) {
        const key = randomBytes(24).toString('base64url'); bingKeys.set(key, 'tenant-a'); candidateAnswers.set(key, verdict);
        const before = await credentialRows(a), calls = providerCalls.length;
        const response = await credentialWrite(a, 'bing-webmaster', 'connectCredential', { fields: { BING_WEBMASTER_API_KEY: key } });
        assert.equal(response.status, 200, await response.clone().text());
        const text = await response.text(), payload = JSON.parse(text);
        assert.equal(payload.verdict, verdict); assert.equal(text.includes(key), false);
        assert.deepEqual(providerCalls.slice(calls), [{ slug: 'tenant-a', family: 'bing-list' }]);
        if (verdict === 'accepted') assert.deepEqual(await plaintext(a, 'bing-webmaster'), { BING_WEBMASTER_API_KEY: key });
        else assert.deepEqual(await credentialRows(a), before);
      }
      assert.deepEqual(await credentialRows(b), foreign); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('expiry changes only selected metadata and site tokens merge only selected owned assets', async () => {
      const foreign = await credentialRows(b), before = (await credentialRows(a)).find(row => row.provider === 'google');
      const expiry = new Date(Date.now() + 86_400_000).toISOString();
      for (const expiresAt of [expiry, null]) {
        const response = await credentialWrite(a, 'google', 'setCredentialExpiry', { expiresAt });
        assert.equal(response.status, 204, await response.clone().text());
        const after = (await credentialRows(a)).find(row => row.provider === 'google');
        assert.equal(after.expires_at?.toISOString() ?? null, expiresAt); assert.equal(after.expiry_source, 'operator');
        assert.equal(after.secret_version, before.secret_version); assert.equal(after.ciphertext, before.ciphertext);
      }
      assert.equal((await credentialWrite(a, 'google', 'setCredentialExpiry', { expiresAt: 'not-a-date' })).status, 422);
      assert.equal((await credentialWrite(a, 'discord', 'setCredentialExpiry', { expiresAt: expiry })).status, 409);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'second.test','second.test','Second own site','live',3)", [a]);
      const foreignToken = randomBytes(24).toString('base64url');
      assert.equal((await credentialWrite(b, 'clarity', 'putSiteToken', { asset: 'example.test', token: foreignToken })).status, 204);
      const foreignWithToken = await credentialRows(b);
      const tokens = {};
      for (const asset of ['example.test', 'second.test']) {
        tokens[asset] = randomBytes(24).toString('base64url');
        const response = await credentialWrite(a, 'clarity', 'putSiteToken', { asset, token: tokens[asset] });
        assert.equal(response.status, 204, await response.clone().text());
        assert.deepEqual(JSON.parse((await plaintext(a, 'clarity')).CLARITY_TOKENS), tokens);
      }
      const beforeRefusal = await credentialRows(a);
      assert.equal((await credentialWrite(a, 'clarity', 'putSiteToken', { asset: 'foreign.test', token: randomUUID() })).status, 422);
      assert.deepEqual(await credentialRows(a), beforeRefusal);
      assert.deepEqual((await credentialRows(b)).filter(row => row.provider !== 'clarity'), foreign);
      assert.deepEqual(await credentialRows(b), foreignWithToken);
      assert.deepEqual(JSON.parse((await plaintext(b, 'clarity')).CLARITY_TOKENS), { 'example.test': foreignToken });
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('all credential RPCs bind the original envelope and reject roles, sessions, origins and demo before effects', async () => {
      const cases = [
        ['putCredential', 'bing-webmaster', { fields: { BING_WEBMASTER_API_KEY: randomUUID() } }],
        ['connectCredential', 'bing-webmaster', { fields: { BING_WEBMASTER_API_KEY: randomUUID() } }],
        ['deleteCredential', 'google', undefined],
        ['setCredentialExpiry', 'google', { expiresAt: null }],
        ['putSiteToken', 'clarity', { asset: 'example.test', token: randomUUID() }],
      ];
      const login = await engine.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@example.test', password: personPassword }) }));
      assert.equal(login.status, 200);
      const expiredCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      await login.body?.cancel();
      const expiredSession = (await engine.api.getSession({ headers: new Headers({ cookie: expiredCookie }) })).session.id;
      await enginePool.query("UPDATE noticeos_identity.auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [expiredSession]);
      const before = await credentialRows(a), foreign = await credentialRows(b), calls = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const [method, provider, body] of cases) {
        const selected = credentialProof(a, provider, method, body);
        const input = method === 'deleteCredential' ? provider : { provider, ...body };
        assert.equal((await rpc(method, [method === 'deleteCredential' ? 'discord' : { ...input, provider: 'discord' }], selected)).status, 403);
        assert.equal((await rpc(method, [input])).status, 403);
        if (typeof input === 'object') for (const extra of [{ actor: person.id }, { workspaceId: b }, { metadata: { account: 'forged' } }, { action: 'integrations.write' }]) {
          assert.equal((await rpc(method, [{ ...input, ...extra }], selected)).status, 403);
          assert.equal((await credentialWrite(a, provider, method, { ...body, ...extra })).status, 403);
        }
        for (const evidence of [{ ...headers(a), cookie: otherCookie },
          { ...headers(a), cookie: expiredCookie, [WORKSPACE_SESSION_HEADER]: expiredSession },
          { ...headers(a), origin: 'https://foreign.example.test' },
          { ...headers(a), 'sec-fetch-site': 'cross-site' }, { ...headers(a), 'x-noticeos-workspace-id': randomUUID() },
          (() => { const value = headers(a); delete value[WORKSPACE_SESSION_HEADER]; return value; })()]) {
          const changed = credentialProof(a, provider, method, body, evidence);
          assert.equal((await towerFetch.fetch(changed.url, changed.init)).status, 403);
          assert.equal((await rpc(method, [input], changed)).status, 403);
        }
        const query = credentialProof(a, provider, method, body); query.url += '?workspace=' + b;
        assert.equal((await towerFetch.fetch(query.url, query.init)).status, 403);
        assert.equal((await rpc(method, [input], query)).status, 403);
        assert.equal((await credentialWrite(demo, provider, method, body, headers(demo), demoFetch)).status, 403);
        assert.equal((await dispatch({ receiver: 'DEMO_INGEST', method, args: [input], proof: credentialProof(demo, provider, method, body) })).status, 403);
      }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { for (const [method, provider, body] of cases) assert.equal((await credentialWrite(b, provider, method, body)).status, 403); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.equal(await credentialReadCount(), 0); assert.equal(providerCalls.length, calls);
      assert.deepEqual(await credentialRows(a), before); assert.deepEqual(await credentialRows(b), foreign);
    });
    await t.test('all credential receivers recheck membership and lifecycle immediately before writes and provider calls', async () => {
      const calls = providerCalls.length;
      for (const [method, provider, body] of [
        ['putCredential', 'bing-webmaster', { fields: { BING_WEBMASTER_API_KEY: randomUUID() } }],
        ['connectCredential', 'bing-webmaster', { fields: { BING_WEBMASTER_API_KEY: randomUUID() } }],
        ['deleteCredential', 'google', undefined], ['setCredentialExpiry', 'google', { expiresAt: null }],
        ['putSiteToken', 'clarity', { asset: 'example.test', token: randomUUID() }],
      ]) {
        await admin.query('SELECT pg_stat_statements_reset()');
        const before = await credentialRows(a);
        await admin.query('SELECT pg_stat_statements_reset()');
        revokeCredential = true;
        assert.equal((await credentialWrite(a, provider, method, body)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
        suspendCredential = true;
        try { assert.equal((await credentialWrite(a, provider, method, body)).status, 403); }
        finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
        assert.equal(await credentialReadCount(), 0); assert.deepEqual(await credentialRows(a), before);
      }
      assert.equal(providerCalls.length, calls); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('disconnect revokes only the selected Google grant then removes only selected secrets', async () => {
      const foreign = await credentialRows(b), calls = providerCalls.length;
      const response = await credentialWrite(a, 'google', 'deleteCredential');
      assert.equal(response.status, 204, await response.clone().text());
      assert.deepEqual(providerCalls.slice(calls), [{ slug: 'tenant-a', family: 'google-revoke' }]);
      assert.equal(await plaintext(a, 'google'), null); assert.deepEqual(await credentialRows(b), foreign);
      assert.equal((await credentialWrite(a, 'bing-webmaster', 'deleteCredential')).status, 204);
      assert.equal(await plaintext(a, 'bing-webmaster'), null); assert.deepEqual(await credentialRows(b), foreign);
      const aAfter = await credentialRows(a), beforeBestEffort = providerCalls.length;
      refuseGoogleRevocation = true;
      try { assert.equal((await credentialWrite(b, 'google', 'deleteCredential')).status, 204); }
      finally { refuseGoogleRevocation = false; }
      assert.deepEqual(providerCalls.slice(beforeBestEffort), [{ slug: 'tenant-b', family: 'google-revoke' }]);
      assert.equal(await plaintext(b, 'google'), null); assert.deepEqual(await credentialRows(a), aAfter);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    const questionParams = { country: 1, target: 'example.test' };
    const questionHash = createHash('sha256').update(JSON.stringify(questionParams)).digest('hex');
    for (const [workspace, marker, expected] of [[a, 'tenant-a', 3], [b, 'tenant-b', 0], [demo, 'demo', 1]]) {
      await admin.query("INSERT INTO noticeos.research_log (workspace_id,research_number,asset_id,provider,endpoint,params_sha256,question,cost_usd,cost_state,object_key,actor,bought_at) VALUES($1,1,'example.test','dataforseo','fixture/report',$2,$3,$4,'reported',$5,$6,now()-interval '2 days')",
        [workspace, questionHash, marker + ' stored question', expected + 1, marker + '/stored-answer', marker + ' recorded buyer']);
      const days = [];
      for (let ms = Date.parse('2026-05-01T00:00:00Z'); ms <= Date.parse('2026-07-05T00:00:00Z'); ms += 86400000) {
        const date = new Date(ms).toISOString().slice(0, 10), at = date + 'T03:00:00Z';
        const last24h = date >= '2026-07-01' && date <= '2026-07-0' + expected ? 0 : 10;
        days.push({ date, at, envelope: { asset: 'example.test', generatedAt: at,
          capabilities: ['signups'], metrics: { signups: { last24h, avg7d: 9.3, total: 4210 } } } });
      }
      await admin.query("INSERT INTO noticeos.pulses (workspace_id,asset_id,pulse_date,revision,generated_at,received_at,capabilities,envelope) SELECT $1,'example.test',(d->>'date')::date,1,(d->>'at')::timestamptz,(d->>'at')::timestamptz,'[\"signups\"]'::jsonb,d->'envelope' FROM jsonb_array_elements($2::jsonb) d",
        [workspace, JSON.stringify(days)]);
    }
    const mcpQuestion = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const researchArgs = { endpoint: 'fixture/report', params: { target: 'example.test', country: 1 }, windowDays: 7 };
    const researchQuery = { provider: 'dataforseo', ...researchArgs };
    const replay = { asset: 'example.test', ruleId: 'flow-poisson-low', metric: 'signups', through: '2026-07-05',
      config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 } };
    const storedInit = (workspace, body, evidence = headers(workspace)) => ({ method: 'POST',
      headers: { ...evidence, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const stored = (workspace, path, body, evidence = headers(workspace), client = towerFetch) =>
      client.fetch(origin + path, storedInit(workspace, body, evidence));
    const storedProof = (workspace, path, body, evidence = headers(workspace)) =>
      ({ url: origin + path, init: storedInit(workspace, body, evidence) });
    const researchReadCount = async () => Number((await admin.query(
      "SELECT COALESCE(sum(calls),0) n FROM pg_stat_statements WHERE query LIKE '%FROM noticeos.research_log%' OR query LIKE '%FROM noticeos.pulses%'")).rows[0].n);
    const storedWrites = async () => (await admin.query("SELECT (SELECT count(*) FROM noticeos.flags)::int flags,(SELECT count(*) FROM noticeos.config_changes)::int audit,(SELECT count(*) FROM noticeos.config_documents)::int documents,(SELECT count(*) FROM noticeos.research_log)::int purchases,(SELECT count(*) FROM noticeos.annotations)::int annotations")).rows;
    await t.test('MCP and real seasonal replay read colliding evidence only in their selected customer or fixed demo', async () => {
      const before = await storedWrites(), calls = providerCalls.length;
      for (const [workspace, marker, expected] of [[a, 'tenant-a', 3], [b, 'tenant-b', 0], [demo, 'demo', 1]]) {
        const client = workspace === demo ? demoFetch : towerFetch;
        // An unrelated customer's cookie never becomes demo authority.
        const evidence = workspace === demo ? { origin, cookie: otherCookie } : headers(workspace);
        for (const name of ['list_properties', 'property_report', 'research_lookup']) {
          const args = name === 'property_report' ? { asset: 'example.test' } : name === 'research_lookup' ? researchArgs : {};
          const response = await stored(workspace, '/api/mcp', mcpQuestion(name, args), evidence, client);
          assert.equal(response.status, 200, await response.clone().text());
          const text = await response.text(), body = JSON.parse(text);
          assert.equal(body.error, undefined, text); assert.equal(body.result.isError, undefined, text);
          const result = body.result.structuredContent;
          if (name === 'research_lookup') {
            assert.equal(result.found, true); assert.equal(result.prior.question, marker + ' stored question');
            assert.equal(result.prior.objectKey, marker + '/stored-answer'); assert.equal(result.prior.costUsd, expected + 1);
            assert.equal(result.prior.actor, marker + ' recorded buyer');
          } else assert.ok(text.includes(marker + ' private asset'), text);
          for (const foreign of ['tenant-a', 'tenant-b', 'demo'].filter(value => value !== marker))
            assert.equal(text.includes(foreign + ' private asset') || text.includes(foreign + ' stored question'), false);
        }
        for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
          const response = await stored(workspace, '/api/mcp', { jsonrpc: '2.0', id: 2, method }, evidence, client);
          assert.ok([200, 202].includes(response.status), await response.text());
        }
        const response = await stored(workspace, '/api/alerts/backtest', replay, evidence, client);
        assert.equal(response.status, 200, await response.clone().text());
        const backtest = await response.json();
        assert.equal(backtest.wouldFire, expected); assert.equal(backtest.judged, 30);
        assert.deepEqual(backtest.config, replay.config);
        const miss = await stored(workspace, '/api/mcp', mcpQuestion('research_lookup', { ...researchArgs, windowDays: 1 }), evidence, client);
        assert.equal((await miss.json()).result.structuredContent.found, false);
        const otherQuestion = await stored(workspace, '/api/mcp', mcpQuestion('research_lookup', { ...researchArgs, params: { ...questionParams, country: 2 } }), evidence, client);
        assert.equal((await otherQuestion.json()).result.structuredContent.found, false);
        assert.equal((await stored(workspace, '/api/alerts/backtest', { ...replay, asset: 'absent.test' }, evidence, client)).status, 404);
        const thresholdCandidate = await stored(workspace, '/api/alerts/backtest', { ...replay, config: { ...replay.config, alpha: 0 } }, evidence, client);
        assert.equal(thresholdCandidate.status, 422, 'candidate validation does not save thresholds');
      }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try {
        assert.equal((await stored(b, '/api/mcp', mcpQuestion('research_lookup', researchArgs))).status, 200);
        assert.equal((await stored(b, '/api/alerts/backtest', replay)).status, 200);
      } finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.deepEqual(await storedWrites(), before); assert.equal(providerCalls.length, calls);
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    await t.test('stored research receivers compare every duplicated field and reject forged authority before evidence reads', async () => {
      const calls = providerCalls.length, writes = await storedWrites();
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const input of [{ ...researchQuery, provider: 'other' }, { ...researchQuery, endpoint: 'other' },
        { ...researchQuery, windowDays: 8 }, { ...researchQuery, nowMs: Date.now() }, { ...researchQuery, params: { country: 2 } },
        { ...researchQuery, workspaceId: b }, { ...researchQuery, actor: person.id }])
        assert.equal((await rpc('researchLookup', [input], storedProof(a, '/api/mcp', mcpQuestion('research_lookup', researchArgs)))).status, 403);
      for (const input of [{ ...replay, asset: 'foreign.test' }, { ...replay, ruleId: 'other' },
        { ...replay, config: { ...replay.config, alpha: 0.05 } }, { ...replay, through: '2026-07-04' },
        { ...replay, metric: null }, { ...replay, workspaceId: b }, { ...replay, actor: person.id }])
        assert.equal((await rpc('backtestRule', [input], storedProof(a, '/api/alerts/backtest', replay))).status, 403);
      assert.equal((await rpc('researchLookup', [researchQuery], storedProof(a, '/api/mcp', mcpQuestion('list_properties')))).status, 403);
      assert.equal((await rpc('backtestRule', [replay], storedProof(a, '/api/mcp', mcpQuestion('research_lookup', researchArgs)))).status, 403);
      for (const method of ['researchLookup', 'backtestRule']) assert.equal((await rpc(method, [method === 'researchLookup' ? researchQuery : replay])).status, 403);
      assert.equal(await researchReadCount(), 0); assert.equal(await credentialReadCount(), 0);
      assert.deepEqual(await storedWrites(), writes); assert.equal(providerCalls.length, calls);
    });
    await t.test('original browser evidence, selectors and exact stored grammar refuse before evidence access', async () => {
      const calls = providerCalls.length;
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const changed of [{ origin: 'https://foreign.example.test' }, { origin: 'null' },
        { origin: undefined }, { 'sec-fetch-site': 'cross-site' }, { cookie: otherCookie },
        { [WORKSPACE_SESSION_HEADER]: randomUUID() }, { 'x-noticeos-workspace-id': demo }]) {
        const evidence = { ...headers(a), ...changed };
        for (const key of Object.keys(evidence)) if (evidence[key] === undefined) delete evidence[key];
        for (const [path, body, method, input] of [['/api/mcp', mcpQuestion('research_lookup', researchArgs), 'researchLookup', researchQuery], ['/api/alerts/backtest', replay, 'backtestRule', replay]]) {
          assert.equal((await stored(a, path, body, evidence)).status, 403);
          assert.equal((await rpc(method, [input], storedProof(a, path, body, evidence))).status, 403);
        }
      }
      for (const [path, body] of [['/api/mcp', { ...mcpQuestion('research_lookup', researchArgs), actor: person.id }],
        ['/api/mcp', mcpQuestion('research_lookup', { ...researchArgs, provider: 'other' })],
        ['/api/mcp', mcpQuestion('collect', {})], ['/api/alerts/backtest', { ...replay, workspaceId: a }],
        ['/api/alerts/backtest', { ...replay, config: { ...replay.config, saved: true } }],
        ['/api/alerts/backtest?', replay]]) assert.equal((await stored(a, path, body)).status, 403);
      for (const [path, body] of [['/api/mcp', mcpQuestion('research_lookup', researchArgs)], ['/api/alerts/backtest', replay]])
        assert.equal((await stored(a, path, body, headers(a), demoFetch)).status, 403);
      assert.equal(await researchReadCount(), 0); assert.equal(await credentialReadCount(), 0);
      assert.equal(providerCalls.length, calls);
      const sameOrigin = { ...headers(a), referer: origin + '/alerts', 'sec-fetch-site': 'same-origin' }; delete sameOrigin.origin;
      assert.equal((await stored(a, '/api/alerts/backtest', replay, sameOrigin)).status, 200);
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='unknown-role' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { assert.equal((await stored(b, '/api/mcp', mcpQuestion('list_properties'))).status, 403); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
    });
    await t.test('both stored receivers recheck revocation and canonical lifecycle after sender admission', async () => {
      const calls = providerCalls.length;
      for (const [path, body] of [['/api/mcp', mcpQuestion('research_lookup', researchArgs)], ['/api/alerts/backtest', replay]]) {
        await admin.query('SELECT pg_stat_statements_reset()'); revokeResearch = true;
        assert.equal((await stored(a, path, body)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
        suspendResearch = true;
        try { assert.equal((await stored(a, path, body)).status, 403); }
        finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
        assert.equal(await researchReadCount(), 0); assert.equal(await credentialReadCount(), 0);
      }
      assert.equal(providerCalls.length, calls); assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    collectionConfigAuditBoundary = (await admin.query('SELECT COALESCE(max(change_id),0)::int n FROM noticeos.config_changes')).rows[0].n;
    collectionConstantsVersion = (await admin.query("SELECT version FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key='constants'", [a])).rows[0].version;
    await t.test('PUT preserves original body across RPC and writes only admitted workspace/principal', async () => {
      for (const changed of [{ origin: 'https://foreign.example.test' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' }]) {
        const evidence = { ...headers(a), ...changed, 'content-type': 'application/json' };
        for (const key of Object.keys(evidence)) if (evidence[key] === undefined) delete evidence[key];
        assert.equal((await towerFetch.fetch(`${origin}/api/config`, { method: 'PUT', headers: evidence, body: JSON.stringify({ ops }) })).status, 403);
      }
      for (const override of [{ actor: 'foreign-actor' }, { profile: 'standalone' }, { action: 'settings.write' }, { workspaceId: b }]) assert.equal((await put(a, towerFetch, override)).status, 403);
      const protectedOps = [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/flag_defaults/alpha', expect: 0.01, value: 0.02 }];
      assert.equal((await put(a, towerFetch, { ops: protectedOps })).status, 403);
      const response = await put(a); assert.equal(response.status, 200, await response.clone().text());
      const rows = (await admin.query("SELECT workspace_id,body->>'os_time_zone' zone,version FROM noticeos.config_documents WHERE document_key='constants' ORDER BY workspace_id")).rows;
      assert.equal(rows.find(row => row.workspace_id === a).zone, 'Europe/London');
      assert.equal(rows.find(row => row.workspace_id === b).zone, 'UTC');
      const audits = (await admin.query('SELECT workspace_id,actor FROM noticeos.config_changes WHERE change_id>$1', [collectionConfigAuditBoundary])).rows;
      assert.deepEqual(audits, [{ workspace_id: a, actor: person.id }]);
      const input = { ops, reason: null, expectVersions: null, actor: 'foreign-actor' };
      const forged = proof(b, { method: 'PUT', headers: { ...headers(b), 'content-type': 'application/json' }, body: JSON.stringify({ ops, reason: null }) });
      assert.equal((await rpc('applyConfigOps', [{ ...input, workspaceId: a }], forged)).status, 403);
      assert.equal((await rpc('applyConfigOps', [{ ...input, ops: [] }], forged)).status, 403);
    });
    const mutate = (workspace, path, method, body, evidence = headers(workspace), client = towerFetch) =>
      client.fetch(origin + path, { method, headers: { ...evidence, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const mutationProof = (workspace, path, method, body, evidence = headers(workspace)) => ({ url: origin + path,
      init: { method, headers: { ...evidence, 'content-type': 'application/json' }, body: JSON.stringify(body) } });
    const mutationAudit = async workspace => (await admin.query('SELECT event,asset_id,subject,actor_person_id AS principal_id,actor_session_id AS session_id FROM noticeos.workspace_mutation_audit WHERE workspace_id=$1 ORDER BY mutation_id', [workspace])).rows;
    for (const workspace of [a, b, demo]) {
      await admin.query("INSERT INTO noticeos.flags(workspace_id,flag_number,asset_id,fired_at,severity,kind,metric,message,rule_id,rule_inputs) VALUES($1,900,'example.test',now(),'warn','anomaly','pageviews','Generated action flag','fixture-action','{}')", [workspace]);
      await admin.query("INSERT INTO noticeos.flags(workspace_id,flag_number,asset_id,fired_at,severity,kind,metric,message,rule_id,rule_inputs) VALUES($1,901,'example.test',now(),'warn','anomaly','pageviews','Generated acknowledgement flag','fixture-ack','{}')", [workspace]);
    }
    await t.test('hosted asset create and column saves affect only the selected colliding asset and record its maintained actor', async () => {
      for (const [workspace, label] of [[a, 'Tenant A created'], [b, 'Tenant B created']]) {
        const create = await mutate(workspace, '/api/assets', 'POST', { id: 'mutation.test', displayName: label, status: 'pre-launch' });
        assert.equal(create.status, 201, await create.clone().text());
        assert.equal((await create.json()).asset.displayName, label);
        const patch = await mutate(workspace, '/api/assets/mutation.test', 'PATCH', { column: 'display_name', value: label + ' saved', expect: label });
        assert.equal(patch.status, 200, await patch.clone().text());
        assert.equal((await mutate(workspace, '/api/assets/mutation.test', 'PATCH', { column: 'display_name', value: 'Stale overwrite', expect: label })).status, 409);
        assert.equal((await mutate(workspace, '/api/assets', 'POST', { id: 'mutation.test', displayName: 'Duplicate' })).status, 409);
        const rows = await mutationAudit(workspace);
        assert.deepEqual(rows.map(row => row.event), ['asset.create', 'asset.column']);
        for (const row of rows) { assert.equal(row.principal_id, person.id); assert.equal(row.session_id, expectedSession); assert.equal(JSON.stringify(row.subject).includes(label), false); }
      }
      assert.equal((await admin.query("SELECT display_name FROM noticeos.assets WHERE workspace_id=$1 AND asset_id='mutation.test'", [a])).rows[0].display_name, 'Tenant A created saved');
      assert.equal((await admin.query("SELECT display_name FROM noticeos.assets WHERE workspace_id=$1 AND asset_id='mutation.test'", [b])).rows[0].display_name, 'Tenant B created saved');
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos.assets WHERE workspace_id=$1 AND asset_id='mutation.test'", [demo])).rows[0].n, 0);
    });
    await t.test('concurrent hosted saves have one winner and one conflict with only one new audit', async () => {
      for (const [workspace, initial] of [[a, 'Tenant A created saved'], [b, 'Tenant B created saved']]) {
        const before = (await mutationAudit(workspace)).length;
        const results = await Promise.all(['first', 'second'].map(suffix => mutate(workspace,
          '/api/assets/mutation.test', 'PATCH', { column: 'display_name', value: initial + ' ' + suffix, expect: initial })));
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        const winner = await results.find(result => result.status === 200).json();
        const conflict = await results.find(result => result.status === 409).json();
        assert.deepEqual(conflict, { error: 'expect_mismatch', column: 'display_name', current: winner.value });
        assert.equal((await mutationAudit(workspace)).length, before + 1);
        assert.equal((await admin.query("SELECT display_name FROM noticeos.assets WHERE workspace_id=$1 AND asset_id='mutation.test'", [workspace])).rows[0].display_name, winner.value);
        // Undo is another guarded save, based on the value this operation wrote.
        assert.equal((await mutate(workspace, '/api/assets/mutation.test', 'PATCH',
          { column: 'display_name', value: initial, expect: winner.value })).status, 200);
      }
      assert.equal((await mutationAudit(demo)).length, 0);
    });
    await t.test('hosted annotations decisions and flag actions keep identical IDs and private notes in their selected workspace', async () => {
      for (const [workspace, label] of [[a, 'A private note'], [b, 'B private note']]) {
        const annotation = { kind: 'external', at: '2026-01-01T00:00:00Z', ref: 'same-reference', note: label };
        assert.equal((await mutate(workspace, '/api/assets/example.test/annotations', 'POST', annotation)).status, 201);
        assert.equal((await mutate(workspace, '/api/assets/example.test/annotations', 'POST', annotation)).status, 200);
        const decision = { kind: 'query', key: 'same-query', status: 'marked', note: label };
        assert.equal((await mutate(workspace, '/api/assets/example.test/decisions', 'POST', decision)).status, 200);
        assert.equal((await mutate(workspace, '/api/assets/example.test/decisions', 'POST', decision)).status, 200);
        assert.equal((await mutate(workspace, '/api/assets/example.test/decisions', 'DELETE', { kind: 'query', key: 'same-query' })).status, 200);
        assert.equal((await mutate(workspace, '/api/assets/example.test/decisions', 'DELETE', { kind: 'query', key: 'same-query' })).status, 200);
        for (const [number, action] of [[900,{ action: 'snooze', until: new Date(Date.now()+86400000).toISOString() }], [900,{ action: 'unsnooze' }], [900,{ action: 'resolve' }], [901,{ action: 'acknowledge' }]]) {
          const result = await mutate(workspace, '/api/flags/'+number, 'PATCH', action);
          assert.equal(result.status, 200, await result.clone().text());
        }
        const rows = (await mutationAudit(workspace)).filter(row => row.asset_id === 'example.test');
        assert.deepEqual(rows.map(row => row.event), ['annotation.create','decision.set','decision.clear','flag.snooze','flag.unsnooze','flag.resolve','flag.acknowledge']);
        for (const row of rows) { assert.equal(row.principal_id, person.id); assert.equal(row.session_id, expectedSession); assert.equal(JSON.stringify(row.subject).includes(label), false); }
        assert.equal((await admin.query("SELECT note FROM noticeos.annotations WHERE workspace_id=$1 AND asset_id='example.test' AND ref='same-reference'", [workspace])).rows[0].note, label);
        assert.ok((await admin.query('SELECT resolved_at FROM noticeos.flags WHERE workspace_id=$1 AND flag_number=900', [workspace])).rows[0].resolved_at);
      }
      assert.equal((await mutationAudit(demo)).length, 0);
      assert.equal((await admin.query('SELECT resolved_at FROM noticeos.flags WHERE workspace_id=$1 AND flag_number=900', [demo])).rows[0].resolved_at, null);
    });
    await t.test('site moves and guarded Undo affect only the admitted tenant and audit the real person', async () => {
      const order = async workspace => (await admin.query('SELECT asset_id FROM noticeos.assets WHERE workspace_id=$1 ORDER BY list_position,asset_id', [workspace])).rows.map(row => row.asset_id);
      const untouched = await order(b), demoOrder = await order(demo), original = await order(a);
      const before = (await mutationAudit(a)).length;
      const response = await mutate(a, '/api/assets/mutation.test/order', 'PATCH', { to: 'example.test' });
      assert.equal(response.status, 200, await response.clone().text());
      const moved = await response.json();
      assert.deepEqual(moved.order, await order(a)); assert.equal(moved.order[0], 'mutation.test');
      assert.match(moved.revision, /^[a-f0-9]{64}$/u);
      assert.deepEqual(await order(b), untouched); assert.deepEqual(await order(demo), demoOrder);
      assert.equal((await mutate(a, '/api/assets/mutation.test/order', 'PATCH', { to: moved.undoTo, expectRevision: '0'.repeat(64) })).status, 409);
      assert.deepEqual(await order(a), moved.order);
      assert.equal((await mutate(a, '/api/assets/mutation.test/order', 'PATCH', { to: moved.undoTo, expectRevision: moved.revision })).status, 200);
      assert.deepEqual(await order(a), original);
      const audits = (await mutationAudit(a)).slice(before);
      assert.deepEqual(audits.map(row => row.event), ['asset.move', 'asset.move']);
      for (const row of audits) { assert.equal(row.principal_id, person.id); assert.equal(row.session_id, expectedSession); }
      const proof = mutationProof(a, '/api/assets/mutation.test/order', 'PATCH', { to: 'example.test', expectRevision: moved.revision });
      for (const input of [{ asset: 'mutation.test', to: 'second.test', expectRevision: moved.revision },
        { asset: 'mutation.test', to: 'example.test' }, { asset: 'mutation.test', to: 'example.test', expectRevision: '0'.repeat(64) }]) {
        assert.equal((await rpc('moveAsset', [input], proof)).status, 403);
      }
      assert.equal((await mutationAudit(a)).length, before + 2);
    });
    const mutationCases = [
      ['/api/assets', 'POST', { id: 'refused.test', displayName: 'Refused' }],
      ['/api/assets/example.test', 'PATCH', { column: 'status', value: 'retired', expect: 'live' }],
      ['/api/assets/example.test/order', 'PATCH', { to: 'mutation.test' }],
      ['/api/assets/example.test/annotations', 'POST', { kind: 'external', note: 'Refused' }],
      ['/api/assets/example.test/decisions', 'POST', { kind: 'query', key: 'refused', status: 'marked' }],
      ['/api/flags/900', 'PATCH', { action: 'acknowledge' }],
    ];
    await t.test('mutation browser evidence session selectors role and demo refusals leave effects and audits unchanged', async () => {
      const before = await mutationAudit(a), outbound = providerCalls.length;
      for (const [path, method, body] of mutationCases) {
        for (const evidence of [{ ...headers(a), origin: 'https://foreign.example.test' }, { ...headers(a), origin: 'null' },
          { ...headers(a), 'sec-fetch-site': 'cross-site' }, { ...headers(a), [WORKSPACE_SESSION_HEADER]: otherSession },
          { ...headers(a), cookie: otherCookie }, { ...headers(a), 'x-noticeos-workspace-id': randomUUID() }]) {
          assert.equal((await mutate(a, path, method, body, evidence)).status, 403);
        }
        const missing = { ...headers(a) }; delete missing.origin;
        assert.equal((await mutate(a, path, method, body, missing)).status, 403);
        assert.equal((await mutate(a, path, method, { ...body, actor: person.id })).status, 403);
        assert.equal((await mutate(demo, path, method, body, headers(demo), demoFetch)).status, 403);
        assert.equal((await mutate(a, path+'?workspace='+b, method, body)).status, 403);
      }
      for (const [path, method, body] of [
        ['/api/assets/foreign.test', 'PATCH', { column: 'display_name', value: 'Foreign overwrite', expect: 'Only tenant B' }],
        ['/api/assets/example.test/order', 'PATCH', { to: 'foreign.test' }],
        ['/api/assets/foreign.test/order', 'PATCH', { to: 'example.test' }],
        ['/api/assets/foreign.test/annotations', 'POST', { kind: 'external', note: 'Foreign note' }],
        ['/api/assets/foreign.test/decisions', 'POST', { kind: 'query', key: 'foreign', status: 'marked' }],
      ]) assert.equal((await mutate(a,path,method,body)).status,404);
      assert.equal((await admin.query("SELECT display_name FROM noticeos.assets WHERE workspace_id=$1 AND asset_id='foreign.test'",[b])).rows[0].display_name,'Only tenant B');
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { for (const [path, method, body] of mutationCases) assert.equal((await mutate(b, path, method, body)).status, 403); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.deepEqual(await mutationAudit(a), before); assert.equal(providerCalls.length, outbound);
    });
    await t.test('fixed asset receivers refuse substituted paths bodies selectors and actor fields before any writer', async () => {
      const cases = [
        ['moveAsset', '/api/assets/example.test/order', 'PATCH', { to: 'mutation.test' }, { asset: 'example.test', to: 'mutation.test' }],
        ['moveAsset', '/api/assets/example.test/order', 'PATCH', { to: 'mutation.test', expectRevision: 'a'.repeat(64) }, { asset: 'example.test', to: 'mutation.test', expectRevision: 'a'.repeat(64) }],
        ['createAsset', '/api/assets', 'POST', { id: 'refused.test', displayName: 'Refused' }, { id: 'refused.test', displayName: 'Refused' }],
        ['readAssetState', '/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'live' }, 'example.test'],
        ['writeAssetColumn', '/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'live' }, { asset: 'example.test', column: 'status', value: 'live', expect: 'live' }],
        ['createAnnotation', '/api/assets/example.test/annotations', 'POST', { kind: 'external', note: 'Receiver' }, { asset: 'example.test', kind: 'external', at: undefined, ref: undefined, note: 'Receiver' }],
      ];
      const before = await mutationAudit(a);
      for (const [method, path, verb, body, input] of cases) {
        for (const changed of [typeof input === 'string' ? 'foreign.test' : { ...input, actor: person.id },
          typeof input === 'string' ? 'foreign.test' : { ...input, asset: 'foreign.test' }])
          assert.equal((await rpc(method, [changed], mutationProof(a,path,verb,body))).status, 403);
        assert.equal((await rpc(method,[input],proof(a))).status, 403);
        assert.equal((await rpc(method,[input])).status, 403);
        assert.equal((await dispatch({ receiver: 'DEMO_INGEST', method, args: [input], proof: mutationProof(demo,path,verb,body) })).status, 403);
      }
      assert.deepEqual(await mutationAudit(a), before);
    });
    await t.test('mutation receivers reload late revocation and lifecycle before actual effects', async () => {
      const before = await mutationAudit(a);
      for (const [path, method, body] of mutationCases.slice(0,4)) {
        revokeMutation = true;
        assert.equal((await mutate(a,path,method,body)).status, 403);
        await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(),a,person.id]);
        suspendMutation = true;
        assert.equal((await mutate(a,path,method,body)).status, 403);
        await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]);
      }
      assert.deepEqual(await mutationAudit(a), before);
    });
    const watchDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const watchQuery = 'Shared café query';
    const watchPath = (asset = 'example.test', metric = 'clicks', query = watchQuery) =>
      `/api/assets/${asset}/watch-query-history?query=${encodeURIComponent(query)}&metric=${metric}`;
    const watchProof = (workspace, path = watchPath(), evidence = headers(workspace)) => ({ url: origin + path, init: { headers: evidence } });
    const watchRead = (workspace, client = towerFetch, asset = 'example.test', metric = 'clicks', query = watchQuery) => {
      const selected = watchProof(workspace, watchPath(asset, metric, query));
      return client.fetch(selected.url, selected.init);
    };
    const retainedBucket = await runtime.getR2Bucket('RAW_SIGNALS', 'ingest');
    const watchKeys = new Map();
    const seedWatch = async (workspace, asset, value, { key, storeObject = true } = {}) => {
      const objectKey = key ?? `workspaces/${workspace}/raw/google/gsc/${asset}/query/${watchDay}/generated.json.gz`;
      const bytes = gzipSync(JSON.stringify({ schemaVersion: 1, provider: 'google', integration: 'gsc', report: 'query',
        asset, credentialRef: 'generated-retained-account', propertyRef: `sc-domain:${asset}`, reportDate: watchDay,
        collectedAt: `${watchDay}T12:00:00Z`, dataState: 'provider-final', providerRows: 1, providerTruncated: false,
        pages: [{ request: { startDate: watchDay, endDate: watchDay, dimensions: ['query'], dataState: 'final' },
          response: { rows: [{ keys: [watchQuery], clicks: value, impressions: value * 10, ctr: value / 100, position: value + 1 }] } }] }));
      if (storeObject) await retainedBucket.put(objectKey, bytes);
      const object = (await admin.query('INSERT INTO noticeos.archive_objects(workspace_id,object_key,content_sha256,object_bytes,first_stored_at) VALUES($1,$2,$3,$4,now()) RETURNING object_seq',
        [workspace, objectKey, createHash('sha256').update(bytes).digest('hex'), bytes.length])).rows[0];
      await admin.query(`INSERT INTO noticeos.archive_runs(workspace_id,run_id,asset_id,integration,report,credential_ref,property_ref,report_date,requested_at,finished_at,status,data_state,schema_version,provider_rows,request_count,provider_truncated,object_seq,cost_state)
        VALUES($1,$2,$3,'gsc','query','generated-retained-account',$4,$5,now(),now(),'success','provider-final',1,1,1,false,$6,'unknown')`,
        [workspace, randomUUID(), asset, `sc-domain:${asset}`, watchDay, object.object_seq]);
      return objectKey;
    };
    for (const [workspace, value] of [[a, 11], [b, 22], [demo, 33]]) watchKeys.set(workspace, await seedWatch(workspace, 'example.test', value));
    for (const [workspace, asset, position] of [[a, 'empty-history.test', 100], [a, 'foreign-manifest.test', 101], [a, 'missing-object.test', 102], [b, 'history-only.test', 100]]) {
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,$2,$2,$2,'live',$3)", [workspace, asset, position]);
    }
    await seedWatch(a, 'foreign-manifest.test', 999, { key: watchKeys.get(b), storeObject: false });
    await seedWatch(a, 'missing-object.test', 999, { storeObject: false });
    await t.test('retained watch archives stay separate across customers, demo and interleaved cache misses', async () => {
      const before = providerCalls.length;
      const expectedMetrics = value => ({ clicks: value, impressions: value * 10, ctr: value / 100, position: value + 1 });
      for (const [workspace, value, client] of [[a, 11, towerFetch], [b, 22, towerFetch], [demo, 33, demoFetch], [a, 11, towerFetch]]) {
        for (const [metric, expected] of Object.entries(expectedMetrics(value))) {
          const response = await watchRead(workspace, client, 'example.test', metric);
          assert.equal(response.status, 200, await response.clone().text());
          const result = await response.json(), range = watchQueryHistoryRange(Date.now());
          assert.equal(result.query, watchQuery); assert.equal(result.metric, metric);
          assert.equal(result.firstDay, range.first_day); assert.equal(result.values.length, 180);
          assert.deepEqual(result.values.filter(value => value !== null), [expected]);
          assert.equal(result.archiveDays, 1); assert.equal(result.observedDays, 1);
          assert.equal(result.archiveFirstDay, watchDay); assert.equal(result.archiveLastDay, watchDay);
          assert.equal(result.recordedChanges.complete, true);
        }
      }
      const demoResponse = await watchRead(a, demoFetch);
      assert.equal(demoResponse.status, 403);
      const anonymousDemo = await demoFetch.fetch(origin + watchPath(), { headers: { cookie: otherCookie } });
      assert.equal(anonymousDemo.status, 200); assert.deepEqual((await anonymousDemo.json()).values.filter(value => value !== null), [33]);
      for (const asset of ['empty-history.test', 'foreign-manifest.test']) {
        const response = await watchRead(a, towerFetch, asset);
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.equal(result.observedDays, 0); assert.equal(result.archiveDays, 0);
        assert.ok(result.values.every(value => value === null));
      }
      const noQuery = await watchRead(a, towerFetch, 'example.test', 'clicks', 'unretained query');
      assert.equal(noQuery.status, 200); assert.equal((await noQuery.json()).observedDays, 0);
      assert.equal((await watchRead(a, towerFetch, 'history-only.test')).status, 403);
      const missing = await watchRead(a, towerFetch, 'missing-object.test');
      assert.equal(missing.status, 403); assert.equal((await missing.text()).includes('999'), false);
      assert.equal(providerCalls.length, before); assert.equal(outside, 0);
    });
    await t.test('watch RPC compares every supplied field before archive access and reloads current admission', async () => {
      const before = providerCalls.length;
      const input = { asset: 'example.test', metric: 'clicks', query: watchQuery, ...watchQueryHistoryRange(Date.now()) };
      const result = await rpc('watchQueryHistory', [input], watchProof(b));
      assert.equal(result.status, 200); assert.deepEqual((await result.json()).result.values.filter(value => value !== null), [22]);
      await admin.query('SELECT pg_stat_statements_reset()');
      for (const patch of [{ asset: 'history-only.test' }, { query: 'foreign query' }, { metric: 'position' },
        { first_day: '2020-01-01' }, { last_day: '2030-01-01' }, { workspaceId: b }, { actor: 'owner' }]) {
        assert.equal((await rpc('watchQueryHistory', [{ ...input, ...patch }], watchProof(a))).status, 403);
      }
      for (const selected of [watchProof(a, watchPath() + '&workspace=' + b),
        watchProof(a, watchPath(), { ...headers(a), cookie: otherCookie }),
        watchProof(a, watchPath(), { ...headers(a), 'x-noticeos-workspace-id': randomUUID() }),
        { url: origin + watchPath(), init: { headers: { cookie, origin, 'x-noticeos-workspace-id': a } } }]) {
        assert.equal((await rpc('watchQueryHistory', [input], selected)).status, 403);
      }
      assert.equal((await rpc('watchQueryHistory', [input])).status, 403);
      const archiveReads = (await admin.query("SELECT COALESCE(sum(calls),0)::int n FROM pg_stat_statements WHERE query LIKE '%FROM noticeos.archive_runs%' OR query LIKE '%FROM noticeos.archive_objects%'")).rows[0].n;
      assert.equal(archiveReads, 0);
      assert.equal((await towerFetch.fetch(origin + watchPath(), { headers: { ...headers(a), origin: 'https://foreign.example.test' } })).status, 403);
      revokeWatch = true;
      assert.equal((await watchRead(a)).status, 403);
      await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), a, person.id]);
      suspendWatch = true;
      try { assert.equal((await watchRead(a)).status, 403); }
      finally { await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]); }
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [b, person.id]);
      try { assert.equal((await watchRead(b)).status, 200); }
      finally { await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1 AND user_id=$2", [b, person.id]); }
      assert.equal((await towerFetch.fetch(origin + '/api/assets/example.test/watch-windows', { method: 'POST', headers: headers(a), body: '{}' })).status, 403);
      assert.equal((await demoFetch.fetch(origin + '/api/assets/example.test/watch-windows', { method: 'POST', headers: headers(demo), body: '{}' })).status, 403);
      assert.equal(providerCalls.length, before); assert.equal(outside, 0);
    });
    await t.test('protected threshold and watch changes stay refused for hosted/demo', async () => {
      const before = await mutationAudit(a);
      for (const [workspace, client] of [[a,towerFetch],[demo,demoFetch]]) {
        assert.equal((await mutate(workspace,'/api/flags/900','PATCH',{ action:'tune',tuned:{} },headers(workspace),client)).status,403);
        assert.equal((await mutate(workspace,'/api/assets/example.test/watch-windows','POST',{},headers(workspace),client)).status,403);
      }
      assert.deepEqual(await mutationAudit(a),before);
    });
    await t.test('fresh permission changes, revoked member and inactive lifecycle refuse before writes', async () => {
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1", [b]);
      assert.equal((await (await get(b)).json()).writable, false);
      assert.equal((await put(b)).status, 403);
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1", [b]);
      assert.equal((await (await get(b)).json()).writable, true);
      for (const status of ['suspended', 'provisioning']) {
        await admin.query('UPDATE noticeos.workspaces SET status=$2 WHERE workspace_id=$1', [b, status]);
        assert.equal((await get(b)).status, 403);
        assert.equal((await towerFetch.fetch(origin + '/api/wall', { headers: headers(b) })).status, 403);
        assert.equal((await towerFetch.fetch(origin + '/api/assets/example.test', { headers: headers(b) })).status, 403);
        for (const pathname of summaryPaths) assert.equal((await towerFetch.fetch(origin + pathname, { headers: headers(b) })).status, 403);
      }
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [b]);
      revoke = true; assert.equal((await get(a)).status, 403, 'receiver must reload membership after Tower admitted it');
      assert.equal((await towerFetch.fetch(origin + '/api/settings', { headers: headers(a) })).status, 403);
      await enginePool.query("UPDATE noticeos_identity.auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [person.id]);
      assert.equal((await get(b)).status, 403, 'the original signed cookie cannot retain an expired session');
      assert.equal((await towerFetch.fetch(origin + '/api/wall', { headers: headers(b) })).status, 403);
        assert.equal((await towerFetch.fetch(origin + '/api/assets/example.test', { headers: headers(b) })).status, 403);
        for (const pathname of summaryPaths) assert.equal((await towerFetch.fetch(origin + pathname, { headers: headers(b) })).status, 403);
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.config_changes WHERE change_id>$1', [collectionConfigAuditBoundary])).rows[0].n, 1);
    });
    await t.test('anonymous demo uses fixed UUID and cannot mutate or switch tenants', async () => {
      const response = await demoFetch.fetch(`${origin}/api/config`); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.writable, false); assert.equal(body.versions['config/constants.json'], 3);
      assert.equal((await get(a, demoFetch)).status, 403); assert.equal((await put(demo, demoFetch)).status, 403);
      const wall = await demoFetch.fetch(origin + '/api/wall', { headers: { cookie: otherCookie } });
      assert.equal(wall.status, 200); const text = await wall.text();
      assert.equal(text.includes('demo private asset'), true);
      assert.equal(text.includes('tenant-a private asset'), false); assert.equal(text.includes('tenant-b private asset'), false);
      assert.equal((await demoFetch.fetch(origin + '/api/wall', { headers: headers(a) })).status, 403);
      assert.equal((await demoFetch.fetch(origin + '/api/settings', { method: 'POST' })).status, 403);
    });
    await t.test('matching successor session is audited only as that maintained person', async () => {
      const evidence = { ...headers(b), cookie: otherCookie, [WORKSPACE_SESSION_HEADER]: otherSession, 'content-type': 'application/json' };
      const init = { method: 'PUT', headers: evidence, body: JSON.stringify({ ops, reason: null, expectVersions: { 'config/constants.json': 2 } }) };
      const input = { ops, reason: null, expectVersions: { 'config/constants.json': 2 }, actor: person.id };
      const response = await rpc('applyConfigOps', [input], { url: `${origin}/api/config`, init });
      assert.equal(response.status, 200);
      const audits = (await admin.query('SELECT workspace_id,actor FROM noticeos.config_changes WHERE change_id>$1 ORDER BY workspace_id', [collectionConfigAuditBoundary])).rows;
      assert.ok(audits.some(row => row.workspace_id === a && row.actor === person.id));
      assert.ok(audits.some(row => row.workspace_id === b && row.actor === otherPerson.id));
      assert.equal(audits.length, 2);
    });
    await t.test('uncovered HTTP/cron/RPC and missing proof do not enter legacy capabilities', async () => {
      for (const pathname of ['/api/wall', '/api/tasks', '/api/ga4/realtime', '/api/integrations/google/start', '/api/health', '/api/runner/cron']) assert.equal((await towerFetch.fetch(`${origin}${pathname}`, { headers: headers(b) })).status, 403);
      const source = readFileSync(path.join(REPO_ROOT, 'workers/ingest/src/index.ts'), 'utf8');
      const methods = [...source.matchAll(/^  async (\w+)\(/gmu)].map(match => match[1]);
      assert.ok(methods.includes('getConfigDocuments') && methods.includes('applyConfigOps'), 'the walk finds the known public RPCs');
      assert.ok(methods.includes('cloudflareD1') && methods.includes('backupCloudflareD1'), 'Request-only receivers are included');
      for (const method of methods) {
        if (method === 'getConfigDocuments' || method === 'applyConfigOps') continue;
        if (method === 'cloudflareD1' || method === 'backupCloudflareD1') {
          const pathname = method === 'cloudflareD1' ? CLOUDFLARE_D1_PATH : CLOUDFLARE_D1_BACKUP_PATH;
          assert.equal((await rpc(method, [], { url: origin + pathname })).status, 403, method);
          continue;
        }
        assert.equal((await rpc(method, [{}])).status, 403, method);
      }
      assert.equal((await rpc('getConfigDocuments', [Object.values(TOWER_CONFIG_FILES)])).status, 403);
      assert.equal((await rpc('applyConfigOps', [{}])).status, 403);
      const ingestFetch = await runtime.getWorker('ingest');
      await assert.rejects(ingestFetch.fetch(`${origin}/pulse`, { method: 'POST', body: '{}' }), /Workspace entry is unavailable/u);
      assert.equal((await ingestFetch.scheduled({ cron: '0 * * * *' })).outcome, 'exception');
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
    if (manualBrowser) await t.test('manual collection is visible in the real browser without confirming scheduler health', async () => {
      const { seedBrowserSettings, proveHostedWorkflowBrowser } = await import('./test-fixtures/hosted-workflow-browser.mjs');
      await seedBrowserSettings(admin, [a, b]);
      const runs = [];
      for (const workspace of [a, b]) {
        const response = await towerFetch.fetch(origin + '/api/workflows', { headers: {
          ...headers(workspace), cookie: otherCookie, [WORKSPACE_SESSION_HEADER]: otherSession,
        } });
        assert.equal(response.status, 200);
        runs.push((await response.json()).workflows.find(row => row.id === 'pull').latest.id);
      }
      await proveHostedWorkflowBrowser({ runtime, origin, cookie: otherCookie, workspaces: [a, b], runs, manual: true });
      assert.equal(outside, 0, JSON.stringify(outsideDetails));
    });
  } finally {
    const cleanup = await Promise.allSettled([...(runtime ? [runtime.dispose()] : []), ...(enginePool ? [enginePool.end()] : []), ...(admin ? [admin.end()] : [])]);
    if (owner) owner.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false, 'uncertain server cleanup retains fixture');
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
    t.diagnostic(JSON.stringify({ cleanup: { runtimeDisposed: runtime !== undefined, poolsClosed: true, ownedPostgresStopped: true, ownedFixtureAbsent: true } }));
  }
});
