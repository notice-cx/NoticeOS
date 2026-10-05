import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { createTestViteServer } from '../test-vite-server.mjs';
import { configDocumentKey } from '../config-documents.mjs';
import { TOWER_CONFIG_FILES } from '../../packages/contract/src/configuration.mjs';
import { startOfflineProxy, installOfflineGuard } from '../../apps/tower/e2e/offline-guard.mjs';

const fixture = name => JSON.parse(readFileSync(path.join(REPO_ROOT, 'workers/ingest/test/fixture-config', name), 'utf8'));
const synthetic = () => Object.fromEntries(Object.values(TOWER_CONFIG_FILES).map(file => {
  const name = path.basename(file);
  const body = name === 'beads.json' ? { hub: null, spokes: [] } : fixture(name);
  if (name === 'constants.json') { body.os_time_zone = 'UTC'; body.schedules = { freshness: { enabled: true, cron: '* * * * *' } }; }
  return [name, body];
}));

export async function seedBrowserSettings(admin, workspaces) {
  const bodies = synthetic();
  for (const workspace of workspaces) for (const file of Object.values(TOWER_CONFIG_FILES)) {
    await admin.query(`INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by)
      VALUES($1,$2,$3,1,now(),'fixture') ON CONFLICT(workspace_id,document_key)
      DO UPDATE SET body=excluded.body,version=noticeos.config_documents.version+1`,
    [workspace, configDocumentKey(file), JSON.stringify(bodies[path.basename(file)])]);
  }
}

/** The API bridge preserves actual browser headers and uses the ordinary
 * Worker. Only the selected deployment (customer or fixed demo) is private
 * fixture composition; no workflow response is mocked. */
export async function proveHostedWorkflowBrowser({ runtime, origin, cookie, workspaces, runs, manual = false }) {
  const evidence = process.env.NOTICEOS_TEST_EVIDENCE_DIR;
  const binary = process.env.NOTICEOS_TEST_BROWSER_BIN;
  assert.ok(path.isAbsolute(evidence ?? '') && path.isAbsolute(binary ?? ''), 'Explicit evidence and qualified testing binary');
  mkdirSync(evidence, { recursive: true });
  const require = createRequire(path.join(REPO_ROOT, 'apps/tower/package.json'));
  const { createServer } = await import(require.resolve('vite'));
  const { default: react } = await import(require.resolve('@vitejs/plugin-react'));
  const { default: tailwindcss } = await import(require.resolve('@tailwindcss/vite'));
  const { chromium, expect } = require('@playwright/test');
  const appRoot = path.join(REPO_ROOT, 'apps/tower'), bodies = synthetic();
  const requests = [], failures = [], checks = [], cleanup = [];
  let vite, proxy, browser, context, guard, target = 'TOWER';
  try {
    vite = await createTestViteServer(createServer, {
      configFile: false, envDir: false, root: appRoot, define: { __DEMO_VIEWER__: 'null' },
      plugins: [{ name: 'synthetic-browser-config', enforce: 'pre', resolveId(source, importer) {
        if (!importer || !source.split('?')[0].endsWith('.json')) return null;
        const file = path.resolve(path.dirname(importer.split('?')[0]), source.split('?')[0]);
        return path.dirname(file) === path.join(REPO_ROOT, 'config') ? '\0scheduler-fixture:' + path.basename(file) : null;
      }, load(id) {
        if (!id.startsWith('\0scheduler-fixture:')) return null;
        const name = id.slice('\0scheduler-fixture:'.length); assert.ok(name in bodies);
        return 'export default ' + JSON.stringify(bodies[name]) + ';';
      } }, { name: 'ordinary-worker-api', configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith('/api/')) return next();
          try {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]));
            const response = await runtime.dispatchFetch('https://browser-driver/', { method: 'POST',
              body: JSON.stringify({ target, url: origin + req.url, init: { method: req.method, headers,
                ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}) } }), signal: AbortSignal.timeout(15000) });
            requests.push({ path: req.url, method: req.method, target, status: response.status,
              workspace: headers['x-noticeos-workspace-id'] ?? null });
            res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) { failures.push(error.message); res.writeHead(500); res.end(); }
        });
      } }, react(), tailwindcss()],
      resolve: { alias: { '@': path.join(appRoot, 'src'), '@shared': path.join(appRoot, 'shared') } },
      server: { host: '127.0.0.1', port: Number(new URL(origin).port), strictPort: true, hmr: false }, logLevel: 'warn',
    }, { pages: true });
    await vite.listen(); proxy = await startOfflineProxy(origin);
    browser = await chromium.launch({ executablePath: binary, headless: true, proxy: proxy.proxy,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', proxy: proxy.proxy });
    guard = await installOfflineGuard(context, origin, { transport: proxy });
    context.on('page', page => { page.on('pageerror', error => failures.push(error.message)); page.setDefaultTimeout(20000); });
    await context.addCookies(cookie.split('; ').map(item => ({ name: item.slice(0, item.indexOf('=')),
      value: item.slice(item.indexOf('=') + 1), url: origin, httpOnly: true, sameSite: 'Lax' })));
    for (const index of manual ? [0, 1] : [0, 1, 2]) {
      if (index === 2) { await context.clearCookies(); target = 'DEMO'; }
      const page = await context.newPage();
      if (index === 2 || (manual && index === 1)) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(origin + '/health/operations');
      if (index < 2) {
        await page.getByRole('heading', { name: 'Choose a workspace', exact: true }).waitFor();
        const name = manual ? new RegExp(index === 0 ? 'tenant-a owner' : 'tenant-b operator') : new RegExp(`generated-${index} viewer`);
        await page.getByRole('button', { name }).click();
      }
      const label = manual ? 'Nightly reports' : 'Data freshness checks';
      await page.getByRole('link', { name: new RegExp(label) }).click();
      await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Run', exact: true })).toHaveValue(runs[index]);
      if (manual) {
        await expect(page.getByRole('region', { name: 'Workflow execution', exact: true }).getByText('Manual', { exact: true })).toBeVisible();
        await expect(page.getByText('Live operation is unconfirmed. The scheduler has not reported recently.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /Refresh Bing signals Not observed$/ })).toBeVisible();
        assert.equal(await page.getByRole('region', { name: 'Step output', exact: true }).count(), 0);
      } else {
        await page.getByRole('button', { name: /Check report freshness Succeeded$/ }).click();
        const output = page.getByRole('region', { name: 'Step output', exact: true });
        await expect(output.getByText('Rows written', { exact: true })).toBeVisible();
        await expect(output.getByText(String(index + 1), { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Edit schedule', exact: true })).toBeDisabled();
      }
      assert.equal(await page.getByText('generated-private-output', { exact: false }).count(), 0);
      await page.screenshot({ path: path.join(evidence, `workspace-${index}.png`), fullPage: true });
      checks.push({ workspace: workspaces[index], ...(manual ? { manual: true, schedulerUnconfirmed: true } : { metric: index + 1 }),
        run: runs[index], anonymousDemo: index === 2 });
      await page.close();
    }
    assert.deepEqual(failures, []); assert.equal(await guard.check(), null);
    const history = requests.filter(request => request.path.startsWith('/api/workflows'));
    for (const workspace of workspaces.slice(0, 2)) assert.ok(history.some(request => request.workspace === workspace && request.status === 200));
    if (!manual) assert.ok(history.some(request => request.target === 'DEMO' && request.workspace === workspaces[2] && request.status === 200));
    assert.ok(history.every(request => request.method === 'GET'));
  } finally {
    for (const [index, page] of (context?.pages() ?? []).entries()) {
      try {
        writeFileSync(path.join(evidence, `failure-page-${index}.html`), await page.content());
        await page.screenshot({ path: path.join(evidence, `failure-page-${index}.png`), fullPage: true, timeout: 5000 });
      } catch { /* Preserve cleanup even if the failed page cannot be captured. */ }
    }
    for (const [name, close] of [['guard', () => guard?.close()], ['browser', () => browser?.close()],
      ['proxy', () => proxy?.close()], ['vite', () => vite?.close()]]) {
      try { await close(); cleanup.push({ name, closed: true }); }
      catch (error) { cleanup.push({ name, closed: false, error: error.message }); }
    }
    writeFileSync(path.join(evidence, 'browser.json'), JSON.stringify({ checks, requests, failures, cleanup }, null, 2) + '\n');
    assert.ok(cleanup.every(result => result.closed), JSON.stringify(cleanup));
  }
}
