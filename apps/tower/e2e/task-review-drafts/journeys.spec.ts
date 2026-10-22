import type { Page } from '@playwright/test';
import { test, expect } from '../journey-test';
import { fetchToRewrite } from '../rewritten-read.mjs';

const A = 'jt-keep';
const B = 'jt-g1';
async function prepare(page: Page) {
  expect((await page.request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await page.request.get('/__journey/status')).json()).isolated).toBe(true);
  for (const control of ['task-source', 'backlog']) {
    expect((await page.request.post(`/__journey/${control}`)).ok()).toBe(true);
  }
  // Both are ordinary synthetic review tasks. Their descriptions provide
  // direct task-to-task links through the real Markdown task-link renderer.
  await page.route(/\/api\/tasks\/jt-(keep|g1)(?:\?|$)/, async route => {
    const { response, headers } = await fetchToRewrite(route);
    const body = await response.json();
    body.task.labels = [];
    const next = body.task.id === A ? B : A;
    body.task.description = `Review [${next}](/tasks/${next}).`;
    await route.fulfill({ response, headers, json: body });
  });
  await page.goto(`/tasks/${A}`);
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toBeVisible();
}
async function openEvidence(page: Page) {
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Close reason' });
  await expect(box).toBeVisible();
  return box;
}
async function visitTask(page: Page, id: string) {
  await page.getByRole('link', { name: id, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${id}$`));
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toBeVisible();
}

test('task review drafts restore through pages and direct task navigation, with independent discard', async ({ page }, testInfo) => {
  await prepare(page);
  const comment = page.getByRole('textbox', { name: 'Add a comment' });
  await comment.fill('Synthetic A comment');
  await (await openEvidence(page)).fill('Synthetic A evidence in 1a2b3c4');
  await visitTask(page, B);
  await expect(comment).toHaveValue('');
  await expect(await openEvidence(page)).toHaveValue('');
  await comment.fill('Synthetic B comment');
  await visitTask(page, A);
  await expect(comment).toHaveValue('Synthetic A comment');
  await expect(await openEvidence(page)).toHaveValue('Synthetic A evidence in 1a2b3c4');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(await openEvidence(page)).toHaveValue('Synthetic A evidence in 1a2b3c4');
  await page.locator('[data-page-header]').getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(comment).toHaveCount(0);
  await page.goBack();
  await expect(comment).toHaveValue('Synthetic A comment');
  await expect(await openEvidence(page)).toHaveValue('Synthetic A evidence in 1a2b3c4');
  await page.getByRole('button', { name: 'Discard comment' }).click();
  await expect(comment).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Close reason' })).toHaveValue('Synthetic A evidence in 1a2b3c4');
  await page.getByRole('button', { name: 'Discard evidence' }).click();
  await expect(page.getByRole('textbox', { name: 'Close reason' })).toHaveValue('');
  await visitTask(page, B);
  await expect(comment).toHaveValue('Synthetic B comment');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach('restored-task-review-draft', { body: await page.screenshot(), contentType: 'image/png' });
  // A fresh document replaces the runtime and cannot restore an earlier draft.
  await page.reload();
  await expect(comment).toHaveValue('');
});

test('task review drafts retain uncertain sends and newer revisions while a request finishes after navigation', async ({ page }) => {
  await prepare(page);
  const comment = page.getByRole('textbox', { name: 'Add a comment' });
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/tasks/${A}/comments`, async route => {
    calls += 1;
    if (calls === 1) return route.abort('failed');
    if (calls === 2) await held;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  try {
    await comment.fill('Synthetic note 1');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeEnabled();
    expect(calls).toBe(1);
    await expect(comment).toHaveValue('Synthetic note 1');
    // Moving away lets the mobile toast dismiss before it covers the retry.
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await comment.fill('Synthetic note 2');
    await visitTask(page, B);
    await expect(comment).toHaveValue('');
    await visitTask(page, A);
    await expect(comment).toHaveValue('Synthetic note 2');
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    release();
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeEnabled();
    await expect(comment).toHaveValue('Synthetic note 2');
    expect(calls).toBe(2);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(comment).toHaveValue('');
    expect(calls).toBe(3);
  } finally { release(); }
});
