import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JOURNEY_BROWSERS } from '../../apps/tower/e2e/journey-browsers.mjs';
import { installOfflineGuard, startOfflineProxy } from '../../apps/tower/e2e/offline-guard.mjs';

const requireTower = createRequire(new URL('../../apps/tower/package.json', import.meta.url));

export async function useCustomerProfileBrowser({ origin, outbox, email, workspaceLabel, role, initialName, newName, otherWorkspace }) {
  const { chromium, expect } = requireTower('@playwright/test');
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= JOURNEY_BROWSERS;
  await using resources = new AsyncDisposableStack();
  const proxy = await startOfflineProxy(origin);
  resources.defer(() => proxy.close());
  const browser = await chromium.launch({ executablePath: process.env.NOTICEOS_TEST_CHROMIUM_EXECUTABLE,
    proxy: proxy.proxy, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  resources.defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const guard = await installOfflineGuard(context, origin, { transport: proxy });
  resources.defer(() => guard.close());
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const before = new Set(readdirSync(outbox));
  await page.goto(origin + '/sign-in');
  await page.getByLabel('Email *', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send code', exact: true }).click();
  const input = page.getByLabel('Email code *', { exact: true });
  await input.waitFor();
  const codes = readdirSync(outbox).filter(file => !before.has(file)).flatMap(file => {
    const mail = JSON.parse(readFileSync(path.join(outbox, file), 'utf8'));
    const code = mail.to === email && mail.text.match(/\b(\d{6})\.$/u);
    return code ? [code[1]] : [];
  });
  assert.equal(codes.length, 1, 'One code arrived in the synthetic mailbox.');
  await input.fill(codes[0]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const choose = (label = workspaceLabel, membership = role) =>
    page.getByRole('button', { name: `${label} ${membership}`, exact: true }).click();
  await choose();
  const account = page.getByRole('button', { name: 'Account menu', exact: true });
  await account.focus();
  await page.keyboard.press('Enter');
  const profile = page.getByRole('link', { name: 'Profile', exact: true });
  await expect(profile).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(profile).toBeFocused();
  await page.keyboard.press('Enter');
  const details = page.getByRole('region', { name: 'Personal details', exact: true });
  const workspace = page.getByRole('region', { name: 'Current workspace', exact: true });
  await expect(details.getByText(email, { exact: true })).toBeVisible();
  await expect(workspace.getByText(workspaceLabel, { exact: true })).toBeVisible();
  await expect(workspace.getByText(role, { exact: true })).toBeVisible();
  const displayName = details.getByRole('textbox', { name: 'Display name *', exact: true });
  const save = details.getByRole('button', { name: 'Save name', exact: true });
  if (newName !== undefined) {
    await expect(displayName).toHaveValue(initialName);
    await displayName.fill(newName);
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/profile' && response.request().method() === 'PATCH'),
      save.click(),
    ]);
    assert.equal(saved.status(), 200);
    await expect(details.getByRole('status')).toBeVisible();
    await page.reload();
    await expect(displayName).toHaveValue(newName);
  } else {
    await expect(details.getByText(initialName, { exact: true })).toBeVisible();
    await expect(save).toHaveCount(0);
    await expect(displayName).toHaveCount(0);
  }
  const screenshotDir = process.env.NOTICEOS_TEST_CUSTOMER_PROFILE_SCREENSHOTS;
  const kind = newName === undefined ? 'backup-profile' : 'customer-profile';
  if (screenshotDir) {
    await page.locator('#boot-splash').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(screenshotDir, kind + '-desktop.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(account).toBeVisible();
  await expect(details.getByText(email, { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, kind + '-phone.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Account menu', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
  await expect(page).toHaveURL(origin + '/');
  await account.click();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, kind + '-account-menu.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await choose(otherWorkspace?.label, otherWorkspace?.role);
  await account.click();
  if (otherWorkspace) {
    await profile.click();
    await expect(workspace.getByText(otherWorkspace.label, { exact: true })).toBeVisible();
    await expect(workspace.getByText(otherWorkspace.role, { exact: true })).toBeVisible();
    await expect(displayName).toHaveValue(newName);
    await account.click();
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email *', { exact: true })).toBeVisible();
  assert.equal(guard.check(), null);
}
