import type { Page } from "@playwright/test";
import { test, expect } from "../journey-test";
import { CHOICE_TASK, JOURNEY_ASSET, JOURNEY_CHOICES, PR_SMOKE } from "../fixtures";
import { JOURNEY_NTASKS_CLIENT_ID, JOURNEY_NTASKS_PERSON, type NtasksDecision } from "../ntasks-fixture";
import { installFixtureNtasks } from "../ntasks-route.mjs";

// While tasks live in Ntasks, a person signs in to it once in this browser
// from the Tasks page, and their decisions there are sent to Ntasks as them.
// The Tower's server keeps the installation's service credential, which
// Ntasks never lets decide. Ntasks here is the fixture's (ntasks-fixture.ts).

type Status = { tasks: { id: string; labels: string[]; metadata: Record<string, unknown> | null }[]; ntasksDecisions: NtasksDecision[] };
const status = async (page: Page) => (await (await page.request.get("/__journey/status")).json()) as Status;
const BOARD = `/tasks/all?project=${JOURNEY_ASSET}`;

async function prepare(page: Page, baseURL: string | undefined) {
  expect((await page.request.post("/__journey/reset")).ok()).toBe(true);
  for (const control of ["task-source", "choice-task", "ntasks"]) expect((await page.request.post(`/__journey/${control}`)).ok()).toBe(true);
  await installFixtureNtasks(page.context(), baseURL!);
  await page.goto(BOARD);
}

/** The choice's row, with its options while signed in and Sign in to Ntasks while not. */
const choiceRow = (page: Page) => page.locator(`[data-inbox-row="${CHOICE_TASK}"]`);

async function signIn(page: Page) {
  const row = choiceRow(page);
  await row.getByRole("button", { name: "Sign in to Ntasks" }).click();
  // Ntasks's own page names the app and who it acts as.
  await expect(page.getByRole("heading", { name: "Allow Journey Tower" })).toBeVisible();
  await page.getByRole("link", { name: "Allow" }).click();
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === BOARD);
  await expect(row.getByRole("group", { name: JOURNEY_CHOICES.question })).toBeVisible();
}

test("a person signs in to Ntasks once from the Tasks page, a reload keeps it, and Sign out shows the button again", { tag: PR_SMOKE }, async ({ page, baseURL }, testInfo) => {
  await prepare(page, baseURL);
  const row = choiceRow(page);
  await expect(row.getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  await expect(row.getByRole("group", { name: JOURNEY_CHOICES.question })).toHaveCount(0);

  await signIn(page);
  const signedIn = page.locator("[data-ntasks-signed-in]");
  await expect(signedIn).toContainText(JOURNEY_NTASKS_PERSON);
  await expect(row.getByRole("button", { name: "Sign in to Ntasks" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ntasks-signed-in.png"), fullPage: true });

  await page.reload();
  await expect(row.getByRole("group", { name: JOURNEY_CHOICES.question })).toBeVisible();
  await expect(signedIn).toContainText(JOURNEY_NTASKS_PERSON);

  await signedIn.getByRole("button", { name: "Sign out of Ntasks" }).click();
  await expect(row.getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  await expect(row.getByRole("group", { name: JOURNEY_CHOICES.question })).toHaveCount(0);
  await expect(signedIn).toHaveCount(0);
});

test("a pick made in the Tower is recorded by Ntasks under the signed-in person's name and the Tower's client id", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  await signIn(page);
  const row = choiceRow(page);
  await row.getByRole("group", { name: JOURNEY_CHOICES.question }).getByRole("button", { name: "(b) Redirect to the new page", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Chose (b) Redirect to the new page" }).first()).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await status(page)).ntasksDecisions, { timeout: 20_000 }).toEqual([
    { task: CHOICE_TASK, action: "choose", option: "b", by: JOURNEY_NTASKS_PERSON, app: JOURNEY_NTASKS_CLIENT_ID, recorded: true },
  ]);
  const picked = (await status(page)).tasks.find((task) => task.id === CHOICE_TASK)!;
  expect(picked.metadata?.noticeos_choice).toMatchObject({ option: "b", by: JOURNEY_NTASKS_PERSON });
  expect(picked.labels).not.toContain("human");
});

test("a decision sent with the installation's service credential is still refused, and Ntasks records nothing", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  await expect(choiceRow(page).getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  // The Tower's own route, which reaches Ntasks with the service credential.
  const reply = await page.evaluate(async (id) => {
    const answer = await fetch(`/api/tasks/${encodeURIComponent(id)}/choose`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ option: "b" }) });
    return { status: answer.status, body: await answer.json() as { error?: string; detail?: string } };
  }, CHOICE_TASK);
  expect(reply.status).toBe(403);
  expect(reply.body.error).toBe("insufficient_scope");
  const after = await status(page);
  expect(after.ntasksDecisions).toEqual([{ task: CHOICE_TASK, action: "choose", option: "b", by: "service:noticeos", app: null, recorded: false }]);
  const task = after.tasks.find((entry) => entry.id === CHOICE_TASK)!;
  expect(task.labels).toContain("human");
  expect(task.metadata).not.toHaveProperty("noticeos_choice");
});
