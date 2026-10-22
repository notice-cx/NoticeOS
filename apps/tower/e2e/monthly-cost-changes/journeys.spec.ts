import { test, expect } from "../journey-test";
import { costMonth } from "./fixtures";

test.beforeEach(async ({ request, baseURL }) => {
  if (!baseURL) throw new Error("This worker has no fixture server");
  const reset = await request.post("/__journey/reset");
  expect(reset.ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

for (const theme of ["dark", "light"] as const) {
  test(`monthly cost changes preserve recorded amounts and reuse history in ${theme} mode`, async ({ page }, testInfo) => {
    await page.addInitScript((color) => localStorage.setItem("noticeos:theme", color), theme);
    const reads: Array<string | null> = [];
    const writes: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method());
    });
    await page.route("**/api/financials*", async (route) => {
      const period = new URL(route.request().url()).searchParams.get("period");
      reads.push(period);
      await route.fulfill({ json: costMonth(period ?? "2026-09") });
    });
    await page.goto("/financials?period=2026-09");
    if (theme === "light") await expect(page.locator("html")).toHaveClass(/light/);
    const panel = page.locator("[data-cost-composition]");
    await expect(panel).toBeVisible();
    const toggle = panel.getByRole("button", { name: "Compare with previous month" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(reads).toEqual(["2026-09"]);
    await toggle.focus();
    await page.keyboard.press("Enter");
    const comparison = panel.locator("[data-cost-comparison]");
    await expect(comparison).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(reads).toEqual(["2026-09", "2026-08"]);
    await expect(comparison).toContainText("Previous: August 2026. Current: September 2026.");
    await expect(comparison).toContainText("Month-to-date costs against the complete previous calendar month");
    const rows = comparison.getByRole("list", { name: "Cost changes by source" }).getByRole("listitem");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText("+$2.11");
    await expect(rows.nth(1)).toContainText("−$2.03");
    await expect(rows.nth(2)).toContainText("unknown-family");
    await expect(rows.nth(2).getByText("$0.00", { exact: true })).toHaveCount(3);
    for (const name of ["added", "absent"]) {
      const row = rows.filter({ hasText: name });
      await expect(row).toContainText("No record");
      await expect(row).toContainText("Unavailable");
    }
    await expect(comparison.locator('[aria-label="Recorded cost totals"]')).toContainText("+$1.09");
    await expect(comparison).not.toContainText(/saving|performance|improvement/i);
    await toggle.click();
    await expect(comparison).toHaveCount(0);
    await toggle.click();
    await expect(comparison).toBeVisible();
    expect(reads).toEqual(["2026-09", "2026-08"]);
    expect(writes).toEqual([]);

    const geometry = await comparison.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const overflowing = [...element.querySelectorAll("li, dt, dd, p, button")].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent);
      return { viewport, pageWidth: document.documentElement.scrollWidth, left: box.left, right: box.right, overflowing };
    });
    expect([390, 1440]).toContain(geometry.viewport);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.overflowing).toEqual([]);
    await testInfo.attach("comparison geometry and requests", { body: JSON.stringify({ theme, ...geometry, reads, writes }, null, 2), contentType: "application/json" });
    await testInfo.attach(`monthly-cost-changes-${theme}`, { body: await panel.screenshot(), contentType: "image/png" });
  });

  test(`monthly cost changes keep unavailable history unknown in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((color) => localStorage.setItem("noticeos:theme", color), theme);
    await page.route("**/api/financials*", async (route) => {
      const period = new URL(route.request().url()).searchParams.get("period");
      if (period === "2026-08") {
        await route.fulfill({ status: 404, json: { error: "period_not_found", periods: ["2026-09"] } });
      } else await route.fulfill({ json: costMonth() });
    });
    await page.goto("/financials?period=2026-09");
    const panel = page.locator("[data-cost-composition]");
    await panel.getByRole("button", { name: "Compare with previous month" }).click();
    await expect(panel.getByRole("status")).toContainText("Previous month unavailable");
    await expect(panel.getByRole("list", { name: "Cost changes by source" })).toHaveCount(0);
  });
}
