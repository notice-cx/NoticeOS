// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readSite, readSites } from "../worker/asset-registry";
import { type AssetDetailDeps, buildAssetDetailPayload } from "../worker/asset-detail-payload";
import { buildAlertHistoryPayload } from "../worker/alert-history";
import { handleDecisionsRequest } from "../worker/decision-route";
import { buildIntegrationsMatrix } from "../worker/integrations-payload";
import { loadSitesAssets } from "../worker/site-discovery-route";
import { buildWallFeed } from "../worker/wall-feed";
import { type BuildOptions, buildWallPayload } from "../worker/wall-payload";
import { buildWorkPayload } from "../worker/work-payload";
import { ALERT_HISTORY_PAGE } from "../shared/alert-history";
import { storeAlert } from "./alert-rows";
import { createTestStore, postgresUnavailable } from "./postgres-store";
import { workProject } from "./panel-fixtures";

import { addSites } from "./sites";

const NOW = new Date("2026-09-22T19:30:00.000Z");
const ZONE = "UTC";
const DETAIL: AssetDetailDeps = {
  now: NOW, flagDefaults: {}, pullConfig: [], monthlyCaps: { dataUsd: 25 }, operatorRateUsdPerMin: 2,
  integrations: { catalog: [], assets: {} }, counters: { assets: {} },
  serpPanel: { assets: {} }, signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} },
  osTimeZone: ZONE,
};
const WALL: BuildOptions = {
  now: NOW, constants: { dataUsd: 25 }, integrations: DETAIL.integrations, pullConfig: [], serpPanel: DETAIL.serpPanel,
  dashboard: {}, osTimeZone: ZONE,
};

const unavailable = postgresUnavailable();

/** One real store with one site. */
async function namedSite() {
  const ctx = await createTestStore();
  await addSites(ctx, [{ id: "meals.example", displayName: "Meal Planner", status: "live", senseOnly: 0, createdAt: "2026-07-01T00:00:00.000Z" }]);

  return ctx;
}

describe.skipIf(unavailable !== null)(`the site list is read on Postgres${unavailable === null ? "" : ` (skipped: no Postgres here, ${unavailable})`}`, () => {
  it("lists sites by their stored place: the order they were added in, whatever their instants and ids", async () => {
    const ctx = await createTestStore();
    await addSites(ctx, [
      { id: "zeta.example", displayName: "Zeta", status: "live", createdAt: "2026-08-03T00:00:00.000Z" },
      { id: "beta.example", displayName: "Beta", status: "live", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "beta-2.example", displayName: "Beta two", status: "live", createdAt: "2026-08-02T00:00:00.000Z" },
      { id: "alpha.example", displayName: "Alpha", status: "live", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);
    expect((await readSites(ctx.call)).map((site) => site.id)).toEqual([
      "zeta.example", "beta.example", "beta-2.example", "alpha.example",
    ]);
  });

  // A stored-order fixture: sites that share
  // one instant, placed in the order D1 inserted them, which is not their ids'
  // order. Home, the Sites page and the navigation list the Wall payload's
  // sites as it orders them (`useWall`); the Sites panel reads the list itself.
  it("every reader lists sites that share one instant in the order they were placed", async () => {
    const ctx = await createTestStore();
    const at = "2026-07-05T00:00:00.000Z";
    const placed = ["root.example", "meals.example", "nosh.example", "pacer.example", "areas.example", "fees.example"];
    await addSites(ctx, placed.map((id, index) => ({
      id, displayName: id, status: "live", createdAt: at, ...(index === 0 ? { isOs: 1, domain: null } : {}),
    })));
    const store = ctx.call;
    const sites = placed.slice(1);
    expect((await buildWallPayload(store, WALL)).assets.map((card) => card.id)).toEqual(sites);
    expect((await loadSitesAssets(store, { catalog: [], assets: {} }, [])).map((site) => site.id)).toEqual(sites);
    expect((await readSites(store)).map((site) => site.id)).toEqual(placed);
  });

  it("a moved site is listed at its new place by every reader", async () => {
    const ctx = await createTestStore();
    const inserted = ["first.example", "second.example", "third.example"];
    await addSites(ctx, inserted.map((id) => ({ id, displayName: id, status: "live" })));
    const store = ctx.call;
    // The last site to the top, in the two steps the ingest's move takes.
    await store.write(async (tx) => {
      await tx.execute("UPDATE noticeos.assets SET list_position = list_position + 1000");
      await tx.execute(`UPDATE noticeos.assets SET list_position = CASE asset_id
        WHEN 'third.example' THEN 1 WHEN 'first.example' THEN 2 WHEN 'second.example' THEN 3 END`);
    });

    const moved = ["third.example", "first.example", "second.example"];
    expect((await readSites(store)).map((site) => site.id)).toEqual(moved);
    expect((await buildWallPayload(store, WALL)).assets.map((card) => card.id)).toEqual(moved);
    expect((await loadSitesAssets(store, { catalog: [], assets: {} }, [])).map((site) => site.id)).toEqual(moved);
  });

  it("reads flags as 0/1 and instants as JavaScript writes them", async () => {
    const ctx = await createTestStore();
    await addSites(ctx, [{ id: "os.example", domain: null, displayName: "OS", status: "live", senseOnly: 0, isOs: 1, createdAt: "2026-07-01T00:00:00.000Z" }]);
    expect(await readSite(ctx.call, "os.example")).toEqual({
      id: "os.example", domain: null, displayName: "OS", status: "live", senseOnly: 0, isOs: 1,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await readSite(ctx.call, "never.example")).toBeNull();
  });

  it("the Wall's cards, the asset page and the integrations matrix name the site from Postgres", async () => {
    const ctx = await namedSite();
    const store = ctx.call;
    expect((await buildWallPayload(store, WALL)).assets.map((card) => card.displayName)).toEqual(["Meal Planner"]);
    expect((await buildAssetDetailPayload(store, "meals.example", DETAIL))!.asset.displayName).toBe("Meal Planner");
    const matrix = await buildIntegrationsMatrix(store, {
      now: NOW, integrations: { catalog: [], assets: { "meals.example": {} } }, pullConfig: [], monthlyCaps: { dataUsd: 25 }, serpPanel: { assets: {} },
    });
    expect(matrix.assets.map((asset) => asset.displayName)).toEqual(["Meal Planner"]);
  });

  it("the task board, the alert history and the Wall feed name the site from Postgres", async () => {
    const ctx = await namedSite();
    const store = ctx.call;
    const board = await buildWorkPayload(store, { now: NOW, snapshot: { capturedAt: NOW.toISOString(), projects: [workProject()] } as never });
    expect(board.projects.map((project) => project.name)).toEqual(["Meal Planner"]);

    await storeAlert(store, {
      asset: "meals.example", firedAt: "2026-09-22T10:00:00.000Z", severity: "warn", kind: "anomaly",
      message: "moved", ruleId: "volume-anomaly", resolvedAt: "2026-09-22T11:00:00.000Z",
    });
    const history = await buildAlertHistoryPayload(store,
      { asset: null, severity: null, offset: 0, limit: ALERT_HISTORY_PAGE, malformed: null }, { now: NOW });
    expect(history.rows.map((row) => row.asset.displayName)).toEqual(["Meal Planner"]);

    const feed = await buildWallFeed(store, { now: NOW, osTimeZone: ZONE });
    const named = feed.items.filter((item) => item.asset === "meals.example").map((item) => item.site);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set(["Meal Planner"]));
  });

  it("an asset page, a decision and the connect panel know a site by Postgres alone", async () => {
    const ctx = await createTestStore();
    await addSites(ctx, [{ id: "meals.example", displayName: "Meal Planner", status: "live" }]);

    const store = ctx.call;
    // A live site is listed by the connect panel.
    expect((await loadSitesAssets(store, { catalog: [], assets: {} }, [])).map((site) => site.id)).toEqual(["meals.example"]);

    // An unknown site is refused by both its page and its write route.
    expect(await buildAssetDetailPayload(store, "unknown.example", DETAIL)).toBeNull();
    const url = new URL("https://tower.local/api/assets/unknown.example/decisions");
    const decided = await handleDecisionsRequest(
      new Request(url, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ kind: "finding", key: "k", status: "marked" }) }),
      url, store, "unknown.example", NOW.toISOString(),
    );
    expect(decided.status).toBe(404);
  });
});
