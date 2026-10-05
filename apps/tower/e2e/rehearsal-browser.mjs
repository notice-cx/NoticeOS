import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { JOURNEY_BROWSERS } from './journey-browsers.mjs';
import { installOfflineGuard } from './offline-guard.mjs';

/** Preserve the check that failed, while guarded teardown drains late routes. */
export async function withOfflineContext(browser, origin, action, verify = true) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let boundary, primary;
  try {
    boundary = await installOfflineGuard(context, origin, { strict: true });
    await action(context, boundary);
  } catch (error) { primary = error; }
  finally {
    try { await (boundary ? boundary.close() : context.close()); }
    catch (error) { primary ??= error; }
  }
  if (!primary && verify && boundary.check()) {
    primary = Object.assign(new Error(boundary.check()), { code: 'OFFLINE_BROWSER_BOUNDARY_FAILED' });
  }
  if (primary) throw primary;
}

/** Guard installation precedes pages and requests. No fixture/reset adapter. */
export async function exerciseCopiedStoreBrowser({ origin, rateLabel, rateValue = 7, provider, onStep = () => {} }) {
  let browser, primary, currentStep = 'input';
  const step = name => { currentStep = name; onStep(name); };
  try {
    step('input');
    if (!Number.isFinite(rateValue) || rateValue < 0) throw new Error('Copied rate is not an editable finite number');
    process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;
    const { chromium, expect } = await import('@playwright/test');
    step('launch');
    browser = await chromium.launch({ headless: true });
    step('offline-boundary');
    // Prove all redirect methods and WS against a second owned loopback sink.
    let contacted = 0;
    const sink = http.createServer((req, res) => { contacted++; res.end(); });
    sink.on('upgrade', (req, socket) => { contacted++; socket.destroy(); });
    sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
    const foreign = `http://127.0.0.1:${sink.address().port}`;
    const source = http.createServer((req, res) => {
      if (req.url.startsWith('/redirect')) { res.writeHead(303, { location: `${foreign}/copied-secret-sentinel` }); res.end(); }
      else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Offline boundary proof</title>'); }
    });
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const proofOrigin = `http://127.0.0.1:${source.address().port}`;
    try {
      await withOfflineContext(browser, proofOrigin, async (proofContext, boundary) => {
        const proofPage = await proofContext.newPage();
        await proofPage.goto(proofOrigin);
        await proofPage.evaluate(async foreign => {
          await fetch(`${foreign}/copied-secret-sentinel`).catch(() => {});
          for (const method of ['GET', 'POST']) await fetch('/redirect', { method }).catch(() => {});
          await new Promise(resolve => {
            const ws = new WebSocket(foreign.replace('http:', 'ws:'));
            ws.onerror = ws.onclose = () => resolve();
          });
        }, foreign);
        assert.equal(contacted, 0, 'all foreign redirect and WebSocket attempts stop before contacting even a local sink');
        assert.equal(boundary.check(), 'The offline browser refused an external request.');
        assert.equal(boundary.check().includes('copied-secret-sentinel'), false);
      }, false); // This context deliberately proves refusal of foreign requests.
    } finally {
      await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => sink.close(resolve))]);
    }
    await withOfflineContext(browser, origin, async (context, boundary) => {
      const page = await context.newPage();
      let pageErrors = 0;
      page.on('pageerror', () => { pageErrors++; });
      step('settings-navigation');
      await page.goto(`${origin}/settings`);
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const rate = page.getByLabel(rateLabel, { exact: true });
      step('settings-value');
      await expect(rate).toHaveValue(String(rateValue));
      await rate.fill(String(rateValue + 1));
      const row = rate.locator('xpath=ancestor::div[.//label][1]');
      step('settings-save');
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row.locator('[data-save-state="saved"]')).toBeVisible();
      step('settings-undo');
      await row.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(rate).toHaveValue(String(rateValue));
      step('integrations-navigation');
      await page.goto(`${origin}/integrations`);
      await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
      if (provider !== undefined) {
        step('integrations-credential');
        const tile = page.locator(`[data-integration-tile="${provider}"]`);
        await expect(tile).toBeVisible();
        await expect(tile).not.toHaveAttribute('data-integration-status', 'not-connected');
      }
      step('browser-assertions');
      assert.equal(pageErrors, 0, 'actual imported-copy UI runs without browser errors');
      assert.equal(boundary.check(), null, 'actual internal journeys attempt no external redirect or WebSocket');
    });
  } catch (error) {
    const codes = ['OFFLINE_BROWSER_REQUEST_FAILED', 'OFFLINE_BROWSER_CLEANUP_FAILED', 'OFFLINE_BROWSER_BOUNDARY_FAILED'];
    primary = Object.assign(new Error('The copied browser stopped at a required check.'), {
      code: codes.includes(error?.code) ? error.code : 'COPIED_BROWSER_CHECK_FAILED', step: currentStep,
    });
  } finally {
    if (browser) try { await browser.close(); }
    catch { primary ??= Object.assign(new Error('The copied browser could not finish cleanup.'), { code: 'OFFLINE_BROWSER_CLEANUP_FAILED', step: currentStep }); }
  }
  if (primary) throw primary;
}
