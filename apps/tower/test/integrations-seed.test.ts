// Check the shipped empty catalog and an explicit synthetic register. The
// matrix assertions run on every checkout and read no installation files.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_LAYERS,
  INTEGRATION_STATES,
  type IntegrationsConfig,
  derivedNotApplicable,
  unblockers,
} from "@shared/integrations";
import type { PullConfigEntry } from "../worker/asset-config";
import { buildIntegrationsMatrix } from "../worker/integrations-payload";
import { createTestStore } from "./postgres-store";
import { addSites } from "./sites";
import inventedSites from "../../../db/fixtures/invented-sites.json";
import { readSites } from "../worker/asset-registry";
import fixtureRegister from "./fixture-config/integrations.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipped = JSON.parse(
  readFileSync(path.resolve(here, "../../../config/integrations.json"), "utf8"),
) as IntegrationsConfig;
const committed = fixtureRegister as IntegrationsConfig;

// Synthetic sites preserve the pull/envelope/disabled-pull mix.
const pullConfig = (sites: string[]): PullConfigEntry[] => [
  { asset: sites[0]!, url: `https://${sites[0]}/api/internal/metrics`, enabled: true, format: "prometheus" },
  { asset: sites[1]!, url: `https://${sites[1]}/api/admin/overview`, enabled: true, format: "envelope" },
  { asset: sites[3]!, url: `https://${sites[3]}/api/metrics`, enabled: false, format: "envelope" },
];
const deps = (integrations: IntegrationsConfig, sites: string[]) => ({
  now: new Date("2026-07-05T12:00:00.000Z"),
  integrations,
  pullConfig: pullConfig(sites),
  monthlyCaps: { dataUsd: 25 },
  serpPanel: { assets: { [sites[0]!]: {} } } });
async function matrix() {
  const ctx = await createTestStore();
  await addSites(ctx, [inventedSites.os, ...inventedSites.sites]);
  const store = ctx.call;
  const sites = (await readSites(store)).filter((site) => site.isOs === 0).map((site) => site.id);
  return buildIntegrationsMatrix(store, deps(committed, sites));
}

describe("the shipped data-source catalog", () => {
  it("names no asset: the per-asset register starts empty", () => {
    expect(shipped.assets).toEqual({});
    expect(shipped.catalog.length).toBeGreaterThanOrEqual(11);
  });

  it("declares a layer on every catalog row rather than leaning on the default", () => {
    // The default exists so a missing key cannot break a page, not so the file
    // can leave the question open — a lane that lands in a layer by omission is
    // still claiming whose failure it reports.
    for (const row of shipped.catalog) {
      expect(INTEGRATION_LAYERS, `layer for ${row.id}`).toContain(row.layer);
    }
    // And it is not `credential` under another name. Clarity is a provider lane
    // that happens to issue one token per project, which is the one row where
    // deriving the layer from the credential scope would have been wrong.
    const clarity = shipped.catalog.find((r) => r.id === "clarity")!;
    expect(clarity.layer).toBe("provider");
    expect(clarity.credential).toBe("per-property");
    // The only lane where nothing outside the asset is involved at all.
    expect(
      shipped.catalog.filter((r) => r.layer === "property").map((r) => r.id),
    ).toEqual(["deploy-annotations"]);
  });
});

describe("the synthetic integrations register", () => {
  it("covers every registered asset × every catalog lane, with usage and failure facts for each lane", async () => {
    const m = await matrix();

    // Every saved asset is represented; asset #0 leads the installation order.
    expect(m.assets.map((asset) => asset.id).sort()).toEqual(Object.keys(committed.assets).sort());
    expect(m.assets[0]!.isOs).toBe(true);
    expect(m.assets.filter((asset) => asset.isOs)).toHaveLength(1);

    // full matrix: every asset carries every lane, every effective state is valid.
    expect(m.catalog.length).toBeGreaterThanOrEqual(11);
    for (const a of m.assets) {
      expect(m.cells[a.id]).toHaveLength(m.catalog.length);
      for (const c of m.cells[a.id]!) {
        expect(INTEGRATION_STATES).toContain(c.effective);
      }
    }
    // +2 lanes per asset: the two derived rows (nightly report, OS egress),
    // neither of which has a catalog entry.
    expect(m.summary.total).toBe(m.assets.length * (m.catalog.length + 2));

    // LANE_FACTS must cover EVERY catalog lane — a lane with no cost or no
    // failure posture would mean its id drifted out of the Worker's facts map.
    for (const row of m.catalog) {
      expect(row.usage.cost, `cost for ${row.id}`).toBeDefined();
      expect(row.onFailure, `failure posture for ${row.id}`).not.toBeNull();
      // credential scope: every lane declares one — as a value, with no prose
      // beside it (bead `ro-ujb9.96.6.1`).
      expect(["shared", "per-property"], `credential scope for ${row.id}`).toContain(row.credential);
    }
  });

  it("stores obligations and exceptions, and DERIVES the obvious not-applicable cells", async () => {
    // doc 19 finding 12 / bead `ro-9mx`: the register was a full matrix, and 27
    // of its 84 cells said "not applicable" in prose — fifteen of them two rules
    // written out fifteen times. The rule is now `scope` on the catalog row, so
    // a new asset arrives owing decisions rather than paragraphs.
    const m = await matrix();
    const laneIndex = (id: string) => m.catalog.findIndex((lane) => lane.id === id);

    let derived = 0;
    for (const lane of committed.catalog) {
      for (const asset of m.assets) {
        const rule = derivedNotApplicable(lane.scope ?? "property", asset.isOs);
        if (!rule) continue;
        derived += 1;
        // ABSENT from the stored register…
        expect(
          committed.assets[asset.id]?.[lane.id],
          `${asset.id}/${lane.id} is derivable and must not be written down`,
        ).toBeUndefined();
        // …and present in what the Tower renders, as the rule's state with no
        // sentence riding it — the surfaces draw the rule as a chip from the
        // lane's scope (beads `ro-ujb9.96.6.4`, `ro-ujb9.96.6.1`).
        const cell = m.cells[asset.id]![laneIndex(lane.id)]!;
        expect(cell.laneId).toBe(lane.id);
        expect(cell.effective).toBe("not-applicable");
        expect(["content-only", "system-only"]).toContain(rule);
        expect(cell.note).toBeNull();
        expect(cell.since).toBe("");
      }
    }
    // The System's ten content-asset lanes (PostHog joined in bead
    // ro-ghis.1), plus the operator-notification lane on each other asset.
    expect(derived).toBe(10 + (m.assets.length - 1));

    // What is left in the file is decisions: nothing not-applicable there is a
    // restatement of the two rules above.
    const stored = Object.values(committed.assets).flatMap((lanes) =>
      Object.values(lanes),
    );
    expect(stored.filter((c) => c.status === "not-applicable")).toHaveLength(6);
    for (const c of stored) expect(c.note).not.toBe("");
  });

  // THE INVARIANT IS CHECKED NOW, NOT ASSUMED (bead `ro-qodp`).
  //
  // config/integrations.README.md requires every asset to carry an entry for
  // every data source the scope rule does not answer, and it ships a validation
  // snippet that reports `ASSET missing LANE`. Nothing in this repo ran that
  // snippet — so once /settings could add a catalog row in one changeset (bead
  // `ro-x5gu.6`), an operator could put the file into the state its own README
  // forbids with a click, and the gap stayed invisible until somebody opened
  // the file. This is that snippet, as a gate and as a payload field.
  it("declares every source on every asset", async () => {
    // The whole point of a gate: this is the failure an operator would
    // otherwise only meet by reading the file. Each row names the source and
    // every asset owing it an entry.
    expect((await matrix()).undeclared).toEqual([]);
  });

  it("reads into an unblock list an operator could work through (bead ro-9mx)", async () => {
    const m = await matrix();
    const list = unblockers(m);

    // Blocked cells in the register (no collector runs in this fixture)
    // collapse to a list an operator can actually read.
    expect(list.length).toBeLessThan(m.summary.needsAttention / 2);
    // Every entry names at least one thing it moves, and nothing is a cell.
    for (const item of list) {
      expect(item.unlocks.length).toBeGreaterThan(0);
      expect(item.cells).toBe(item.unlocks.length);
      expect(item.action).not.toBe("");
    }
  });
});
