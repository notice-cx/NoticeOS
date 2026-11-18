import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireTower = createRequire(new URL('../../apps/tower/package.json', import.meta.url));

export async function useLanTower({ origin, state, email, liveEdit }) {
  const { chromium } = requireTower('@playwright/test');
  const browser = await chromium.launch({ executablePath: process.env.NOTICEOS_TEST_CHROMIUM_EXECUTABLE,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP fixture-tower.local 127.0.0.1'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    await page.getByLabel('Email *', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Send code', exact: true }).click();
    const input = page.getByLabel('Email code *', { exact: true });
    await input.waitFor();
    const directory = path.join(state, '.local/compose-customer/customer/mail');
    const delivered = readdirSync(directory).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8'))).find(m => m.to === email);
    const code = delivered?.text.match(/\b([0-9]{6})\.$/u)?.[1];
    assert.ok(code, 'a code arrived in the synthetic mailbox');
    await input.fill(code);
    const readWall = response => new URL(response.url()).pathname === '/api/wall' && response.ok();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose a workspace' }).waitFor();
    await Promise.all([page.waitForResponse(readWall), page.getByRole('listitem').getByRole('button', { name: /owner/i }).click()]);
    await page.locator('[data-home-brief], [data-first-run]').waitFor();
    const session = (await context.cookies(origin)).find(cookie => cookie.httpOnly);
    assert.equal(session?.domain, new URL(origin).hostname);
    assert.equal(await page.evaluate(() => fetch('/_noticeos/ready').then(r => r.status)), 404);
    assert.equal(await page.evaluate(() => fetch('/api/pulse', { method: 'POST' }).then(r => r.status)), 404);
    await liveEdit?.(page);
    await Promise.all([page.waitForResponse(readWall), page.goto(origin + '/wall')]);
    await page.locator('[data-wall-screen]').waitFor();
  } finally {
    await browser.close();
  }
}
