import { test, expect } from "../journey-test";
import { blockerFixture, projects } from "./fixtures";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

test("blocker impact: portfolio counts, read-only disclosure and exact project links", async ({ page }, info) => {
  const fixture = blockerFixture();
  const reads: string[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/work", route => route.fulfill({ json: fixture.snapshot }));
  await page.route("**/api/tasks**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 405, json: {} });
    } else if (url.pathname === "/api/tasks/capabilities") {
      await route.fulfill({ json: { live: true, writable: false, projectSelection: true, reason: null } });
    } else if (url.pathname === "/api/tasks/projects") {
      await route.fulfill({ json: { projects } });
    } else if (url.pathname === "/api/tasks") {
      reads.push(`${url.pathname}${url.search}`);
      await route.fulfill({ json: fixture.live.get(url.searchParams.get("project")!) });
    } else if (url.pathname === "/api/tasks/ex-a") {
      const payload = fixture.live.get(url.searchParams.get("project")!)!;
      await route.fulfill({ json: { ...payload, task: payload.tasks.find(task => task.id === "ex-a"), comments: [] } });
    } else await route.continue();
  });
  await page.goto("/tasks/projects");
  const section = page.getByRole("region", { name: "Holding up work" });
  const first = section.locator('[data-blocker-task="ex-a"][data-blocker-project="alpha"]');
  await expect(first).toContainText("6 downstream");
  await expect(first).toContainText("2 could become ready");
  await expect(first).toContainText("Example project Alpha · In progress · Example Builder");
  await expect(section.getByRole("listitem")).toHaveCount(3);
  await expect(section.locator("[data-blocker-task]").first()).toHaveAttribute("data-blocker-project", "alpha");
  await section.getByRole("button", { name: "Show 2 more" }).click();
  await expect(section.getByRole("listitem")).toHaveCount(5);
  const independent = section.locator('[data-blocker-task="ex-a"][data-blocker-project="beta"]');
  await expect(independent).toContainText("1 downstream");
  await expect(independent.getByRole("link")).toHaveAttribute("href", "/tasks/ex-a?project=beta");
  const gate = section.locator('[data-blocker-task="ex-gate"]');
  await expect(gate).toContainText("0 could become ready");
  expect(await section.getByRole("button").allTextContents()).toEqual(["Show fewer"]);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(first).toContainText("6 downstream");
  expect(reads.sort()).toEqual(["/api/tasks?project=alpha", "/api/tasks?project=beta"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await section.scrollIntoViewIfNeeded();
  const screenshot = info.outputPath("blocker-impact.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach("blocker impact", { path: screenshot, contentType: "image/png" });
  await first.getByRole("link").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/ex-a\?project=alpha$/);
  await expect(page.getByRole("heading", { name: /Finish the shared schema/ })).toBeVisible();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("blocker impact: partial, unavailable and empty reads remain qualified", async ({ page }, info) => {
  let mode: "sample" | "unavailable" | "empty" = "sample";
  await page.route("**/api/tasks/capabilities", route => route.fulfill({ json: { live: false, writable: false, reason: "read_only_deployment" } }));
  await page.route("**/api/work", route => {
    const { snapshot } = blockerFixture(mode === "empty");
    if (mode === "unavailable") for (const project of snapshot.projects) project.ok = false;
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/tasks/projects");
  const section = page.getByRole("region", { name: "Holding up work" });
  await expect(section).toContainText("Known work · lower bounds");
  await expect(section.locator('[data-blocker-task="ex-a"][data-blocker-project="alpha"]')).toContainText("≥6 downstream");
  await expect(section).toContainText("— could become ready");
  await expect(page.getByText(/Available reads may omit tasks/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const screenshot = info.outputPath("blocker-impact-partial.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach("partial blocker impact", { path: screenshot, contentType: "image/png" });
  for (const next of ["unavailable", "empty"] as const) {
    mode = next;
    await page.reload();
    await expect(section).toContainText("No blockers found in the available dependencies.");
    await expect(section).toContainText("Known work · lower bounds");
  }
});
