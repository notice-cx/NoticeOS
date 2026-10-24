import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene } from "../wall-scene";
import { WALL_FIXTURE_NOW, wallFixturePayload } from "../wall-fixture";

test("Wall traffic colors follow visible direction across timezone changes", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four");
  const payload = structuredClone(wallFixturePayload("four"));
  const changes = [23, -5, -15, -30];
  for (const [index, asset] of payload.assets.entries()) {
    const points = Array.from({ length: 56 }, (_, day) => ({ t: new Date(Date.parse(WALL_FIXTURE_NOW.slice(0, 10)) - (56 - day) * 86_400_000).toISOString().slice(0, 10), v: day < 28 ? 100 : 100 + changes[index]! }));
    asset.activeUsers = { ...asset.activeUsers, contextSeries: points.slice(0, 28), series: points.slice(28), provisionalFrom: null,
      timeZoneChanges: [{ effectiveOn: points[30]!.t, from: "Etc/UTC", to: "Europe/London" }] };
  }
  await page.route("**/api/wall", route => route.fulfill({ json: payload }));
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const tones = ["pace-on", "pace-behind", "wall-traffic-decline", "pace-far-behind"];
  const tokens = ["--trend-positive", "--warn", "--urgent", "--trend-negative"];
  for (const [index, asset] of payload.assets.entries()) {
    const chip = page.locator(`[data-site-row="${asset.id}"] [data-site-trend] [data-tone]`);
    await expect(chip).toHaveAttribute("data-tone", tones[index]!);
    await expect(chip).toContainText(`${Math.abs(changes[index]!)}%`);
    const expectedColor = await chip.evaluate((element, token) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      element.parentElement!.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, tokens[index]!);
    await expect(chip).toHaveCSS("color", expectedColor);
  }
  await page.screenshot({ path: testInfo.outputPath("wall-traffic-direction-colors.png") });
});
