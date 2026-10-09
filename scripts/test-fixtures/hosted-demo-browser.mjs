// A composed local proof, borrowing the already-owned simulator stores/Dolt.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { actualViteFactory } from './hosted-vite.mjs';
import { startHostedTaskServer } from '../hosted-task-server.mjs';
import { startHostedDemo } from '../hosted-demo-runtime.mjs';
import { secretFreeWorkerConfigs, stopLocalSecretReads } from '../worker-config-folder.mjs';
import { stripJsonc } from '../jsonc.mjs';
import { openTaskCatalogSetup } from '../../packages/postgres/src/task-catalog.mjs';
import { IDENTITY_NAMES } from '../../packages/postgres/src/identity.mjs';
import { configDocumentKey } from '../config-documents.mjs';
import { TOWER_CONFIG_FILES } from '../../packages/contract/src/configuration.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../browser-request-policy.mjs';
import { demoScenarioHash } from '../demo-scenario.mjs';
import { APP_RELEASE_HEADER, validAppRelease } from '../../apps/tower/shared/app-release.ts';
import { startOfflineProxy, installOfflineGuard } from '../../apps/tower/e2e/offline-guard.mjs';
import { bundleWorkerFixture, Miniflare } from '../worker-entry-test-fixture.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const towerRequire = createRequire(path.join(REPO_ROOT, 'apps/tower/package.json'));
const { Pool } = require('pg');
const origin = 'http://127.0.0.1:6448';
const fixtures = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const fixture = file => path.basename(file) === 'beads.json' ? { hub: null, spokes: [] }
  : path.basename(file) === 'integrations.json' ? { catalog: [], assets: {} }
  : JSON.parse(readFileSync(path.join(fixtures, path.basename(file)), 'utf8'));

export function configureDemoWorkers(configs, vars, profile) {
  for (const file of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
    const filename = configs.configPath(file), config = JSON.parse(stripJsonc(readFileSync(filename, 'utf8')));
    delete config.hyperdrive;
    Object.assign(config.vars ??= {}, vars, { NOTICEOS_WORKSPACE_PROFILE: profile });
    writeFileSync(filename, JSON.stringify(config));
  }
}

export async function proveHostedDemoBrowser(t, options) {
  const { root, admin, connection, appUrl, physical, tasks, runtimeOptions, scenario, workspace, customers, serviceId, projects, counts, directoryConnectionString } = options;
  const evidence = process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE;
  const before = Object.fromEntries(['NOTICEOS_WORKSPACE_PROFILE', 'NOTICEOS_VITE_CACHE_DIR', 'OS_UP_PERSIST_STATE'].map(key => [key, process.env[key]]));
  const customerBefore = await Promise.all(customers.map(counts));
  const identityUrl = await connection('noticeos_identity'), platformUrl = await connection('noticeos_platform');
  const secret = randomBytes(48).toString('base64url');
  let db, setup, configs, entry, simulator, browser, proxy, context, guard, rpc;
  const pageErrors = [], checks = [], captures = [], requests = [];
  let outside = 0, release;
  try {
    const { betterAuth } = await import(require.resolve('better-auth/minimal'));
    const { organization } = await import(require.resolve('better-auth/plugins'));
    const { kyselyAdapter } = await import(require.resolve('@better-auth/kysely-adapter'));
    const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: identityUrl, max: 1 }) }) });
    const engine = betterAuth({ database: kyselyAdapter(db.withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })] });
    const signup = await engine.handler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic customer', email: 'customer@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(signup.status, 200); const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const session = (await engine.api.getSession({ headers: new Headers({ cookie }) })).session.id;
    await admin.query('UPDATE noticeos_identity.auth_user SET email_verified=true WHERE id=$1', [person.id]);
    for (const id of customers) {
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, 'customer-' + id]);
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), id, person.id]);
    }
    // The canonical task catalog locks an organization as well as its workspace.
    // Demo visitors need no membership, but its private allocation still has one.
    await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())',
      [workspace, 'synthetic-demo-' + workspace]);
    for (const id of [...customers, workspace]) for (const file of Object.values(TOWER_CONFIG_FILES)) {
      const body = fixture(file);
      if (file === TOWER_CONFIG_FILES.integrations && id === workspace) body.assets = Object.fromEntries(scenario.assets.map(asset => [asset.id, {}]));
      if (path.basename(file) === 'beads.json' && id === workspace) body.spokes = scenario.manifest.taskProjects;
      await admin.query('INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,$2,$3,1,now(),$4)',
        [id, configDocumentKey(file), JSON.stringify(body), 'synthetic-demo-fixture']);
    }
    setup = openTaskCatalogSetup({ connectionString: platformUrl, verifyProject: async (mapping, controls) => {
      const result = await tasks.verifyProject(mapping, controls); tasks.assertVerifiedProject(result, mapping);
    } });
    for (const [i, mapping] of physical.mappings.entries()) {
      const asset = i >= 2 ? scenario.assets.filter(asset => !asset.isOs)[i - 2] : null;
      await setup.configure({ workspaceId: mapping.workspaceId, projectId: mapping.projectId,
        logicalKey: asset?.prefix ?? `customer${i}`, displayName: asset?.name ?? `Customer ${i}`, prefix: asset?.prefix ?? 'tt' });
    }
    const targets = await Promise.all(physical.mappings.map(async mapping => ({ mapping, target: await physical.resolveTarget(mapping) })));
    const runtime = { profile: 'hosted', trustedOrigin: origin, identity: { connectionString: identityUrl, trustedOrigin: origin, sessionSecret: secret },
      directoryConnectionString, targets,
      binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot };
    configs = secretFreeWorkerConfigs({ parent: root }); stopLocalSecretReads();
    process.env.NOTICEOS_VITE_CACHE_DIR = path.join(root, 'demo-vite-cache');
    const vars = { NOTICEOS_WORKSPACE_ORIGIN: origin, NOTICEOS_IDENTITY_DATABASE_URL: identityUrl,
      NOTICEOS_IDENTITY_SESSION_SECRET: secret, NOTICEOS_WORKSPACE_DATABASE_URL: appUrl,
      NOTICEOS_DEMO_WORKSPACE_ID: workspace, NOTICEOS_DEMO_ACTIVITY_SERVICE_ID: serviceId, NOTICEOS_DEMO_SCENARIO_HASH: demoScenarioHash(scenario) };
    const factory = await actualViteFactory(root, requests);
    const start = async profile => {
      process.env.NOTICEOS_WORKSPACE_PROFILE = profile;
      configureDemoWorkers(configs, vars, profile);
      entry = await startHostedTaskServer({ runtime: { ...runtime, profile, ...(profile === 'demo' ? { demoWorkspaceId: workspace } : {}) }, workerConfigRoot: configs.root, createViteServer: factory });
    };
    const call = async (route, init = {}) => {
      const response = await fetch(origin + route, init), body = await response.json();
      const current = response.headers.get(APP_RELEASE_HEADER); assert.ok(validAppRelease(current));
      release ??= current; assert.equal(current, release);
      return { status: response.status, body };
    };
    await start('hosted');
    await t.test('two real customers retain their own stored portfolio and cannot use demo metadata', async () => {
      for (const id of customers) {
        const headers = { cookie, [WORKSPACE_SELECTION_HEADER]: id, [WORKSPACE_SESSION_HEADER]: session };
        const wall = await call('/api/wall', { headers }); assert.equal(wall.status, 200);
        assert.ok(JSON.stringify(wall.body).includes('Customer control'));
        assert.equal(JSON.stringify(wall.body).includes('Light Brief'), false);
        assert.equal((await call('/api/demo/presentation', { headers })).status, 403);
      }
      checks.push('two customer stored reads beside same-release demo, metadata profile refusal');
    });
    await entry.close(); entry = undefined;
    await start('demo');
    await t.test('actual simulator advances the fixed demo and presentation reports its completed attempt', async () => {
      assert.deepEqual((await call('/api/demo/presentation')).body, { generatedAt: null, through: null });
      simulator = await startHostedDemo(await runtimeOptions(() => Date.parse('2026-09-22T12:00:00Z')));
      const started = simulator.status();
      writeFileSync(path.join(evidence, 'simulator-status.json'), JSON.stringify(started, null, 2));
      await simulator.close(); simulator = undefined;
      assert.equal(started.error, null); assert.ok(started.last?.days.length);
      assert.ok(started.last.days.every(day => day.receipt.state === 'succeeded'));
      const facts = await call('/api/demo/presentation'); assert.equal(facts.status, 200);
      const journal = (await admin.query(`SELECT a.finished_at,j.occurrence FROM noticeos.hosted_job_occurrences j
        JOIN noticeos.hosted_job_attempts a USING(workspace_id,lane,occurrence,attempt)
        WHERE j.workspace_id=$1 AND j.service_id=$2 AND j.state='succeeded' AND a.state='succeeded'
        ORDER BY a.finished_at DESC LIMIT 1`, [workspace, serviceId])).rows[0];
      assert.ok(journal); assert.equal(facts.body.generatedAt, journal.finished_at.toISOString());
      assert.equal(facts.body.through, journal.occurrence.slice(-10));
      const unchanged = facts.body;
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [serviceId]);
      simulator = await startHostedDemo(await runtimeOptions(() => Date.parse('2026-09-23T12:00:00Z')));
      const denied = simulator.status();
      await simulator.close(); simulator = undefined;
      assert.equal(denied.error, 'activity-unavailable');
      assert.deepEqual((await call('/api/demo/presentation')).body, unchanged);
      assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
      checks.push('actual tick through normal inputs/tasks/snapshot; exact completed journal timestamp, denied successor retains last success');
    });
    await t.test('signed-in customer cookies never elevate demo HTTP, native tasks or tool effects', async () => {
      const headers = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: workspace };
      assert.equal((await call('/api/config', { headers })).body.writable, false);
      assert.equal((await call('/api/tasks/capabilities', { headers })).body.writable, false);
      for (const [route, method, body] of [
        ['/api/config', 'PUT', { ops: [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: 'Europe/London' }], expectVersions: { 'config/constants.json': 1 } }],
        [`/api/assets/${scenario.assets[0].id}`, 'PATCH', { column: 'display_name', value: 'Refused visitor' }],
        ['/api/tasks', 'POST', { projectId: projects[0].projectId, title: 'Refused visitor' }],
        ['/api/integrations/google/start', 'POST', undefined], ['/api/integrations/google/properties', 'GET', undefined],
        ['/api/integrations/mediavine/sync', 'POST', { asset: scenario.assets[0].id }],
        ['/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'collect', arguments: {} } }],
      ]) assert.equal((await call(route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })).status, 403, route);
      for (const route of ['/api/wall', '/api/demo/presentation', '/api/tasks/projects']) {
        const status = (await call(route, { headers: { ...headers, [WORKSPACE_SELECTION_HEADER]: customers[0] } })).status;
        assert.equal(status, route === '/api/tasks/projects' ? 400 : 403, route);
      }
      assert.ok([400, 403].includes((await call(`/api/tasks?project=${physical.mappings[0].projectId}`, { headers })).status));
      checks.push('customer-cookie non-elevation; config/asset/task/provider/tool/foreign selector denial');
    });
    await t.test('ordinary private Worker RPC also refuses demo effects before outward adapters', async () => {
      const ingest = await bundleWorkerFixture(root, 'demo-rpc', path.join(REPO_ROOT, 'workers/ingest/src/index.ts'));
      const driver = `export default {async fetch(r,e){const a=await r.json();try{const p=new Request(a.url,a.init);const v=await e.INGEST[a.method](...(a.args??[]),p);try{return Response.json({ok:true})}finally{v?.[Symbol.dispose]?.()}}catch{return Response.json({ok:false},{status:403})}}}`;
      rpc = new Miniflare({ workers: [{ name: 'driver', modules: true, script: driver, compatibilityDate: '2026-07-06', serviceBindings: { INGEST: 'ingest' } },
        { name: 'ingest', ...ingest, bindings: { ...vars, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, outboundService: async () => { outside++; throw new Error('No demo provider effects'); } }] });
      for (const [method, route, args, body] of [
        ['applyConfigOps', '/api/config', [{ ops: [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: 'Europe/London' }], expectVersions: { 'config/constants.json': 1 } }], { ops: [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: 'Europe/London' }], expectVersions: { 'config/constants.json': 1 } }],
        ['discoverGoogleProperties', '/api/integrations/google/properties', [], undefined],
        ['collectNow', '/api/integrations/ga4/collect', [{ provider: 'ga4', assets: [scenario.assets[0].id] }], { assets: [scenario.assets[0].id] }],
      ]) {
        const response = await rpc.dispatchFetch('https://owned-driver/', { method: 'POST', body: JSON.stringify({ method, args, url: origin + route,
          init: { method: method === 'discoverGoogleProperties' ? 'GET' : method === 'applyConfigOps' ? 'PUT' : 'POST', headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: workspace, [WORKSPACE_SESSION_HEADER]: session }, ...(body ? { body: JSON.stringify(body) } : {}) } }) });
        assert.equal(response.status, 403); await response.text();
      }
      await rpc.dispose(); rpc = undefined; assert.equal(outside, 0); checks.push('ordinary RPC refusals, zero provider acquisition');
    });
    await t.test('actual desktop and phone explore persistent read-only demo without external traffic', async () => {
      const { chromium, expect } = towerRequire('@playwright/test');
      proxy = await startOfflineProxy(origin);
      assert.ok(path.isAbsolute(process.env.NOTICEOS_TEST_BROWSER_BIN ?? ''));
      browser = await chromium.launch({ executablePath: process.env.NOTICEOS_TEST_BROWSER_BIN, headless: true, proxy: proxy.proxy,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
      const widths = process.env.NOTICEOS_TEST_HOSTED_DEMO_PHONE_ONLY === '1' ? [390] : [1440, 390];
      for (const width of widths) {
        context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', proxy: proxy.proxy });
        guard = await installOfflineGuard(context, origin, { transport: proxy });
        if (width === 1440) await context.addCookies(cookie.split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: origin, httpOnly: true, sameSite: 'Lax' })));
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); page.setDefaultTimeout(20000);
        const main = page.getByRole('main');
        for (const route of ['/', '/assets', `/assets/${scenario.assets[0].id}`, '/tasks', '/settings']) {
          await page.goto(origin + route);
          await expect(page.locator('[data-demo-viewer]')).toContainText('Synthetic demo · Read only');
          await expect(page.locator('[data-demo-viewer]')).toContainText('Generated');
          await expect(page.locator('[data-demo-viewer]')).toContainText('Scenario through');
          await expect(main).toBeVisible();
          if (route === '/') {
            await expect(main.locator('[data-home-brief]')).toBeVisible();
            await expect(main.getByRole('region', { name: 'Sites', exact: true })).toContainText(scenario.assets[0].name);
          }
          if (route === '/assets') await expect(main.getByRole('link', { name: scenario.assets[0].name, exact: true })).toBeVisible();
          if (route === `/assets/${scenario.assets[0].id}`) {
            await expect(main.getByRole('heading', { level: 1 })).toContainText(scenario.assets[0].name);
            await expect(main.locator('[data-financial-snapshot]')).toBeVisible();
          }
          if (route === '/tasks') {
            await expect(main.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
            await expect(main.locator('[data-task-row]').first()).toBeVisible();
            await expect(main.getByRole('button', { name: 'New task', exact: true })).toBeDisabled();
          }
          if (route === '/settings') {
            await expect(main.locator('[data-zone-clock]')).toBeVisible();
            const save = main.getByRole('button', { name: 'Save', exact: true });
            assert.ok(await save.count());
            for (let i = 0; i < await save.count(); i++) await expect(save.nth(i)).toBeDisabled();
          }
          if (route === '/' || route === '/settings' || route === '/assets') {
            const name = `${width}-${route === '/' ? 'home' : route.slice(1)}.png`;
            await page.screenshot({ path: path.join(evidence, name), fullPage: true }); captures.push(name);
          }
        }
        const response = await page.evaluate(async () => { const r = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); return r.status; });
        assert.equal(response, 403);
        assert.equal(guard.check(), null); assert.deepEqual(guard.escapes(), []);
        await guard.close(); assert.equal(guard.check(), null); guard = undefined; context = undefined;
      }
      assert.deepEqual(pageErrors, []);
      checks.push(`${widths.join('/')}px demo: Home/assets/detail/tasks/settings; persistent journal generation/origin; ${widths.includes(1440) ? 'desktop customer cookie plus anonymous phone' : 'anonymous phone supplement'}`);
    });
    assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
    writeFileSync(path.join(evidence, 'demo-browser.json'), JSON.stringify({ checks, captures, release, pageErrors, outside, scenarioHash: demoScenarioHash(scenario), customersUnchanged: true }, null, 2));
  } finally {
    const cleanupErrors = [];
    for (const close of [() => guard?.close(), () => context?.close(), () => browser?.close(), () => proxy?.close(),
      () => rpc?.dispose(), () => entry?.close(), () => simulator?.close(), () => setup?.close(), () => db?.destroy()]) {
      try { await close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (configs && cleanupErrors.length === 0) configs.remove();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (cleanupErrors.length === 0) for (const owned of [path.join(physical.scratchRoot, 'worker-state'), path.join(root, 'demo-vite-cache')]) {
      rmSync(owned, { recursive: true, force: true }); assert.equal(existsSync(owned), false);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned demo browser resources did not finish cleanup');
  }
}
