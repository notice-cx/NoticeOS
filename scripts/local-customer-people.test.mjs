import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JOURNEY_BROWSERS } from '../apps/tower/e2e/journey-browsers.mjs';
import { installOfflineGuard, startOfflineProxy } from '../apps/tower/e2e/offline-guard.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { MEMBERSHIP_PATH } from './identity-protocol.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { startPlan } from './start.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';

const requireTower = createRequire(new URL('../apps/tower/package.json', import.meta.url));
const enabled = process.env.NOTICEOS_TEST_CUSTOMER_PEOPLE === '1';
const asset = 'shared-site';
const assetPath = `/api/assets/${asset}`;
const chooser = page => page.getByRole('heading', { name: 'Choose a workspace', exact: true });
const switcher = (page, label) => page.getByRole('button', { name: `Switch workspace: ${label}`, exact: true });

function received(outbox, email, pattern, before = new Set()) {
  const matches = readdirSync(outbox).filter(file => !before.has(file)).flatMap(file => {
    const message = JSON.parse(readFileSync(path.join(outbox, file), 'utf8'));
    const match = message.to === email && pattern.exec(message.text);
    return match ? [match[1]] : [];
  });
  assert.equal(matches.length, 1, 'one message arrived in this fixture mailbox');
  return matches[0];
}

async function enroll(page, workspace, outbox) {
  const before = new Set(readdirSync(outbox));
  await page.goto(workspace.url);
  await page.getByLabel('Email *', { exact: true }).fill(workspace.email);
  await page.getByRole('button', { name: 'Send code', exact: true }).click();
  const input = page.getByLabel('Email code *', { exact: true });
  await input.waitFor();
  await input.fill(received(outbox, workspace.email, /\b([0-9]{6})\.$/u, before));
  await page.getByRole('button', { name: 'Sign in and join', exact: true }).click();
  await chooser(page).waitFor();
}

async function select(page, workspace, role) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/session'
      && response.request().headers()[WORKSPACE_SELECTION_HEADER] === workspace.workspaceId),
    page.getByRole('button', { name: `${workspace.label} ${role}`, exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  const selected = await response.json();
  assert.equal(selected.selectedWorkspace.workspaceId, workspace.workspaceId);
  assert.equal(selected.selectedWorkspace.role, role);
  await switcher(page, workspace.label).waitFor();
  return { [WORKSPACE_SELECTION_HEADER]: workspace.workspaceId, [WORKSPACE_SESSION_HEADER]: selected.session.sessionId };
}

function assetRequest(page, headers, rename) {
  return page.evaluate(async ({ assetPath, headers, rename }) => {
    const response = await fetch(assetPath, rename ? {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(rename),
    } : { headers });
    return rename ? response.status : { status: response.status, name: response.ok ? (await response.json()).asset.displayName : null };
  }, { assetPath, headers, rename });
}

test('customers can invite, change access, remove and switch workspaces in the Tower', { skip: !enabled, timeout: 120_000 }, async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'noticeos-people-browser-'));
  const resources = new AsyncDisposableStack();
  const guards = [];
  t.after(async () => {
    await resources.disposeAsync();
    assert.equal(existsSync(path.join(home, '.local', 'customer-postgres', 'data', 'postmaster.pid')), false);
    rmSync(home, { recursive: true, force: true });
  });
  process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;
  const { chromium, expect } = requireTower('@playwright/test');
  const plan = startPlan({ dir: home, port: await availableCustomerPort() });
  const db = openDevelopmentStart(plan, { profile: 'hosted' });
  resources.defer(() => db.close());
  const app = await startLocalCustomer(plan, db);
  resources.defer(() => app.close());
  const origin = app.publicOrigin;
  const [east, west] = app.workspaces.map((entry, index) => index === 0
    ? { ...entry, label: 'East workspace', assetName: 'East only' }
    : { ...entry, label: 'West workspace', assetName: 'West only' });
  for (const workspace of [east, west]) {
    db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
      VALUES (:'workspace'::uuid, :'asset', :'name', 'live', 1)`,
    { vars: { workspace: workspace.workspaceId, asset, name: workspace.assetName } });
  }

  const proxy = await startOfflineProxy(origin);
  resources.defer(() => proxy.close());
  const browser = await chromium.launch({ executablePath: process.env.NOTICEOS_TEST_CHROMIUM_EXECUTABLE, proxy: proxy.proxy,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
  resources.defer(() => browser.close());
  async function openPage() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const guard = await installOfflineGuard(context, origin, { transport: proxy });
    resources.defer(() => guard.close());
    guards.push(guard);
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    return page;
  }
  const owner = await openPage(), teammate = await openPage();
  await enroll(owner, west, app.outbox);
  await select(owner, west, 'owner');
  await enroll(teammate, east, app.outbox);
  const eastSession = await select(teammate, east, 'owner');

  await owner.goto(`${origin}/settings/members`);
  const lastOwner = owner.getByRole('listitem').filter({ has: owner.getByRole('combobox', { name: `Role for ${west.email}`, exact: true }) });
  await expect(lastOwner.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  const before = new Set(readdirSync(app.outbox));
  await owner.getByLabel('Email *', { exact: true }).fill(east.email);
  await owner.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(owner.getByRole('heading', { name: 'Pending invitations', exact: true })).toBeVisible();
  await expect(owner.getByText(east.email, { exact: true })).toBeVisible();
  const invitation = received(app.outbox, east.email, /^Join your workspace: (\S+)$/u, before);
  assert.equal(new URL(invitation).origin, origin);
  await teammate.goto(invitation);
  await teammate.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  const viewer = await select(teammate, west, 'viewer');
  assert.equal(viewer[WORKSPACE_SESSION_HEADER], eastSession[WORKSPACE_SESSION_HEADER]);
  await expect(teammate.getByRole('link', { name: west.assetName, exact: true }).first()).toBeVisible();
  await expect(teammate.getByRole('link', { name: east.assetName, exact: true })).toHaveCount(0);
  assert.deepEqual(await assetRequest(teammate, viewer), { status: 200, name: west.assetName });

  const rename = { column: 'display_name', value: 'West renamed by operator', expect: west.assetName };
  assert.equal(await assetRequest(teammate, viewer, rename), 403);
  await teammate.goto(`${origin}/settings/members`);
  await expect(teammate).toHaveURL(`${origin}/settings`);
  await expect(teammate.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
  await switcher(teammate, west.label).click();
  const eastAgain = await select(teammate, east, 'owner');
  assert.deepEqual(eastAgain, eastSession);
  await expect(teammate.getByRole('link', { name: east.assetName, exact: true }).first()).toBeVisible();
  await expect(teammate.getByRole('link', { name: west.assetName, exact: true })).toHaveCount(0);
  assert.deepEqual(await assetRequest(teammate, eastAgain), { status: 200, name: east.assetName });

  await owner.getByRole('button', { name: 'Refresh access', exact: true }).click();
  const role = owner.getByRole('combobox', { name: `Role for ${east.email}`, exact: true });
  await expect(role).toHaveValue('viewer');
  await expect(owner.getByRole('region', { name: 'Pending invitations', exact: true }).getByText(east.email, { exact: true })).toHaveCount(0);
  const member = owner.getByRole('listitem').filter({ has: role });
  await role.selectOption('operator');
  const [saved] = await Promise.all([
    owner.waitForResponse(response => new URL(response.url()).pathname === MEMBERSHIP_PATH
      && response.request().postDataJSON()?.kind === 'change-role'),
    member.getByRole('button', { name: 'Save role', exact: true }).click(),
  ]);
  assert.equal(saved.status(), 200);
  await switcher(teammate, east.label).click();
  const operator = await select(teammate, west, 'operator');
  assert.equal(operator[WORKSPACE_SESSION_HEADER], eastSession[WORKSPACE_SESSION_HEADER]);
  assert.equal(await assetRequest(teammate, operator, rename), 200);
  assert.deepEqual(await assetRequest(teammate, operator), { status: 200, name: rename.value });
  await teammate.goto(`${origin}/settings/members`);
  await expect(teammate).toHaveURL(`${origin}/settings`);

  await member.getByRole('button', { name: 'Remove', exact: true }).click();
  await member.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(role).toHaveCount(0);
  assert.deepEqual(await assetRequest(teammate, operator), { status: 403, name: null });
  await switcher(teammate, west.label).click();
  await chooser(teammate).waitFor();
  await expect(teammate.getByRole('button', { name: /West workspace/u })).toHaveCount(0);
  const remaining = await select(teammate, east, 'owner');
  assert.deepEqual(remaining, eastSession);
  assert.deepEqual(await assetRequest(teammate, remaining), { status: 200, name: east.assetName });
  await teammate.goto(`${origin}/settings/members`);
  await expect(teammate.getByRole('combobox', { name: `Role for ${east.email}`, exact: true })).toBeVisible();
  await expect(teammate.getByText(west.email, { exact: true })).toHaveCount(0);
  for (const guard of guards) assert.equal(guard.check(), null);
});
