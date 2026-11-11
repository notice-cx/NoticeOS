import type { Page, Response } from "@playwright/test";
import { test, expect } from "../journey-test";
import { CHOICE_TASK, JOURNEY_CHOICES, PR_SMOKE } from "../fixtures";
import { JOURNEY_NTASKS_CLIENT_ID, JOURNEY_NTASKS_PERSON, type FixtureAppState, type NtasksDecision } from "../ntasks-fixture";
import { JOURNEY_NTASKS_ORIGIN } from "../ntasks-origin.mjs";
import { installFixtureNtasks } from "../ntasks-route.mjs";

// The Tower's /tasks is the Ntasks UI, from the published @notice-cx/ntasks-ui
// package. A person signs in to Ntasks once in this browser, and the pages
// then read and decide as them. The Tower's server keeps the installation's
// service credential, which Ntasks never lets decide. Ntasks here is the
// fixture's (ntasks-fixture.ts).

type Status = { tasks: { id: string; labels: string[]; metadata: Record<string, unknown> | null }[]; ntasksDecisions: NtasksDecision[];
  ntasksRegistrations: number };
const status = async (page: Page) => (await (await page.request.get("/__journey/status")).json()) as Status;
const CHOICE_TITLE = "Retire the synthetic recipe page";
const SETTINGS = "/settings/task-projects";

async function prepare(page: Page, baseURL: string | undefined, { app = "registered", apiVersion }: { app?: FixtureAppState; apiVersion?: number } = {}) {
  expect((await page.request.post("/__journey/reset")).ok()).toBe(true);
  const ntasks = `/__journey/ntasks?app=${app}${apiVersion === undefined ? "" : `&apiVersion=${apiVersion}`}`;
  for (const control of ["/__journey/task-source", "/__journey/choice-task", ntasks]) expect((await page.request.post(control)).ok()).toBe(true);
  await installFixtureNtasks(page.context(), baseURL!);
}

/** Sign in from the Tower's Sign in to Ntasks on a signed-out /tasks page, through Ntasks's approval page, back to where it started. */
async function signIn(page: Page) {
  const started = new URL(page.url());
  await page.getByRole("button", { name: "Sign in to Ntasks" }).click();
  // Ntasks's own page names the app and who it acts as.
  await expect(page.getByRole("heading", { name: "Allow Journey Tower" })).toBeVisible();
  await page.getByRole("link", { name: "Allow" }).click();
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === `${started.pathname}${started.search}`);
}

/** Whether an answer carries the Ntasks UI's code or styles, which every one of them scopes to `[data-ntasks]`. */
async function carriesNtasksUi(response: Response): Promise<boolean> {
  const type = response.headers()["content-type"] ?? "";
  if (!/javascript|css/u.test(type)) return false;
  return (await response.text().catch(() => "")).includes("data-ntasks");
}

test("a person signs in to Ntasks once from /tasks, sees its board from the Ntasks, and a reload keeps the sign-in", { tag: PR_SMOKE }, async ({ page, baseURL }, testInfo) => {
  await prepare(page, baseURL);
  const asked: string[] = [];
  page.on("request", (request) => { if (request.url().startsWith(JOURNEY_NTASKS_ORIGIN)) asked.push(new URL(request.url()).pathname); });
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  // Signed out, the Ntasks UI is not mounted: no task request goes out, only the public version read.
  await expect(page.locator("[data-ntasks]")).toHaveCount(0);
  expect(asked.filter((pathname) => pathname !== "/api/version")).toEqual([]);
  await signIn(page);
  const app = page.locator("[data-ntasks]");
  await expect(app.getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  // One sidebar beside the page: the Ntasks UI keeps its own behind its Sidebar button.
  await expect(app.getByRole("navigation", { name: "Ntasks" })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("ntasks-board.png"), fullPage: true });

  await page.reload();
  await expect(app.getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to Ntasks" })).toHaveCount(0);
});

test("a pick made on a task's page in the Tower is recorded by Ntasks under the signed-in person's name and the Tower's client id", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  await page.goto(`/tasks/${CHOICE_TASK}`);
  await signIn(page);
  const decision = page.locator("[data-task-decision]");
  await expect(decision.getByRole("heading", { name: JOURNEY_CHOICES.question })).toBeVisible();
  await decision.getByRole("radio", { name: /Redirect to the new page/u }).click();
  await decision.getByRole("button", { name: "Answer" }).click();
  // The answer waits out its Undo window before it is sent.
  await expect.poll(async () => (await status(page)).ntasksDecisions, { timeout: 20_000 }).toEqual([
    { task: CHOICE_TASK, action: "choose", option: "b", by: JOURNEY_NTASKS_PERSON, app: JOURNEY_NTASKS_CLIENT_ID, recorded: true },
  ]);
  const picked = (await status(page)).tasks.find((task) => task.id === CHOICE_TASK)!;
  expect(picked.metadata?.noticeos_choice).toMatchObject({ option: "b", by: JOURNEY_NTASKS_PERSON });
  expect(picked.labels).not.toContain("human");
});

test("a decision sent with the installation's service credential is still refused, and Ntasks records nothing", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  await page.goto("/");
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

test("an Ntasks older than the Tower's task pages shows one sentence in place of them", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL, { apiVersion: 1 });
  await page.goto("/tasks");
  await expect(page.getByRole("alert")).toHaveText("This Ntasks is older than the Tower's task pages need; update it.");
  await expect(page.locator("[data-ntasks]")).toHaveCount(0);
});

test("the Ntasks UI's code loads with /tasks and never with Home", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL);
  const answers: Response[] = [];
  page.on("response", (response) => { answers.push(response); });
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const onHome = await Promise.all(answers.splice(0).map(carriesNtasksUi));
  expect(onHome.some(Boolean)).toBe(false);

  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const onTasks = await Promise.all(answers.map(carriesNtasksUi));
  expect(onTasks.some(Boolean)).toBe(true);
});

test("with no Tower client ID saved, one press of Sign in on /tasks registers the Tower in Ntasks, and a later sign-in reuses it", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL, { app: "unregistered" });
  await page.goto("/tasks");
  await signIn(page);
  await expect(page.locator("[data-ntasks]").getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  expect((await status(page)).ntasksRegistrations).toBe(1);

  // Sign out of Ntasks is in Settings, beside who is signed in.
  await page.goto(SETTINGS);
  await page.locator("[data-ntasks-signed-in]").getByRole("button", { name: "Sign out of Ntasks" }).click();
  await page.goto("/tasks");
  await signIn(page);
  await expect(page.locator("[data-ntasks]").getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  expect((await status(page)).ntasksRegistrations).toBe(1);
});

test("each address the Tower is opened at signs in with one press, registers once, and keeps the saved client ID", { tag: PR_SMOKE }, async ({ page, baseURL }) => {
  await prepare(page, baseURL, { app: "unregistered" });
  await page.goto("/tasks");
  await signIn(page);
  await expect(page.locator("[data-ntasks]").getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  expect((await status(page)).ntasksRegistrations).toBe(1);
  const saved = async () => ((await (await page.request.get("/api/tasks/service")).json()) as { app: { clientId: string } | null }).app?.clientId;
  expect(await saved()).toBe(JOURNEY_NTASKS_CLIENT_ID);

  // The same Tower at its other loopback name is another address, with its own app in Ntasks.
  const other = new URL(baseURL!);
  other.hostname = "localhost";
  const elsewhere = await page.context().newPage();
  await installFixtureNtasks(elsewhere, other.origin);
  await elsewhere.goto(`${other.origin}/tasks`);
  await signIn(elsewhere);
  await expect(elsewhere.locator("[data-ntasks]").getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  expect((await status(page)).ntasksRegistrations).toBe(2);

  // Signing in there again reuses its app, and the saved client ID stays the first address's.
  await elsewhere.goto(`${other.origin}${SETTINGS}`);
  await elsewhere.locator("[data-ntasks-signed-in]").getByRole("button", { name: "Sign out of Ntasks" }).click();
  await elsewhere.goto(`${other.origin}/tasks`);
  await signIn(elsewhere);
  await expect(elsewhere.locator("[data-ntasks]").getByRole("link", { name: CHOICE_TITLE })).toBeVisible();
  expect((await status(page)).ntasksRegistrations).toBe(2);
  expect(await saved()).toBe(JOURNEY_NTASKS_CLIENT_ID);
});

test("Settings offers Sign in to Ntasks, never a link to the sign-in address, and a refused registration says why", async ({ page, baseURL }) => {
  await prepare(page, baseURL, { app: "refused" });
  await page.goto(SETTINGS);
  const row = page.locator("[data-ntasks-sign-in-setup]");
  await expect(row.getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
  await expect(page.locator('a[href*="/tasks/signed-in"]')).toHaveCount(0);
  const address = row.locator("[data-ntasks-return-address]");
  await expect(address).toBeHidden();
  await row.getByText("Register the Tower by hand").click();
  await expect(address).toHaveText(new URL("/tasks/signed-in", baseURL).toString());

  await row.getByRole("button", { name: "Sign in to Ntasks" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Not signed in to Ntasks" }).filter({ hasText: "invalid_client_metadata" })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === SETTINGS);
  expect((await status(page)).ntasksRegistrations).toBe(0);
  await expect(row.getByRole("button", { name: "Sign in to Ntasks" })).toBeEnabled();
});
