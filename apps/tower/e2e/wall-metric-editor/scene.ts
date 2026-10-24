import type { Page } from "@playwright/test";
import type { WallLayout } from "../../shared/wall-layout";
import { expect } from "../journey-test";
import { wallFixturePayload } from "../wall-fixture";
import { wallScene } from "../wall-scene";
import { fetchToRewrite } from "../rewritten-read.mjs";

/** Synthetic readings with the fixture store's real saved layout and guard. */
export async function persistedMetricScene(page: Page, layout?: WallLayout) {
  await wallScene(page, "four");
  if (layout) {
    const status = await page.request.get("/__journey/status");
    const saved = await page.request.put("/api/config", { headers: { origin: new URL(status.url()).origin }, data: { slug: "fixture-wall-layout", ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/wall", expectAbsent: true, value: { layout, history: [] } }] } });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  await page.route("**/api/wall", async route => {
    const { response, headers } = await fetchToRewrite(route);
    const actual = await response.json();
    const fixture = wallFixturePayload("four");
    await route.fulfill({ response, headers, json: { ...fixture, dashboard: { ...actual.dashboard, countdown: fixture.dashboard.countdown } } });
  });
}
