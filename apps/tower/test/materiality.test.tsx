import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  ASSET_PAYLOAD_INVENTORY,
  MATERIAL_CONDITIONS,
  MATERIALITY,
  WALL_PAYLOAD_INVENTORY,
  type MaterialCondition,
} from "@shared/materiality";
import type { AttentionItem, SystemBand as SystemData } from "@shared/wall";
import { NeedsYou } from "@/components/wall/NeedsYou";
import { WallStrip } from "@/components/wall/WallStrip";
import { NO_READS } from "@shared/connection-status";
import { wallIssues } from "@/lib/wall-issues";

const NOW = Date.parse("2026-08-05T00:00:00.000Z");
const RECENT = "2026-08-04T23:58:00.000Z";

function renderUi(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function visibleMarkers(container: HTMLElement, condition: MaterialCondition): Element[] {
  const destination = MATERIALITY[condition].wall;
  if (destination.placement === "not-applicable") return [];
  return [...container.querySelectorAll(destination.selector)];
}

function expectVisual(container: HTMLElement, condition: MaterialCondition) {
  const markers = visibleMarkers(container, condition);
  expect(markers.length, `${condition} has no visible marker`).toBeGreaterThan(0);
  expect(
    markers.some((marker) => marker.querySelector("svg, [role='progressbar']") !== null),
    `${condition} is text-only`,
  ).toBe(true);
}

describe("materiality registry", () => {
  it("gives every material condition a visible destination and explicit absence behavior", () => {
    expect(Object.keys(MATERIALITY).sort()).toEqual([...MATERIAL_CONDITIONS].sort());
    for (const condition of MATERIAL_CONDITIONS) {
      const contract = MATERIALITY[condition];
      expect(contract.wall.placement === "not-applicable" && contract.asset.placement === "not-applicable").toBe(false);
      expect(contract.behavior.empty.length).toBeGreaterThan(10);
      expect(contract.behavior.unknown.length).toBeGreaterThan(10);
      expect(contract.behavior.stale.length).toBeGreaterThan(10);
      for (const destination of [contract.wall, contract.asset]) {
        if (destination.placement !== "not-applicable") {
          expect(destination.selector.length).toBeGreaterThan(2);
          expect(destination.component.length).toBeGreaterThan(2);
        }
      }
    }
  });

  it("allows evidence in disclosure but never classifies material current state there", () => {
    const inventory = [
      ...Object.values(WALL_PAYLOAD_INVENTORY),
      ...Object.values(ASSET_PAYLOAD_INVENTORY),
    ];
    expect(
      inventory.some(
        (item) =>
          item.class === "supporting-evidence" &&
          item.placement === "progressive-disclosure",
      ),
    ).toBe(true);
    expect(
      inventory
        .filter((item) => item.class === "material-current")
        .map((item) => String(item.placement)),
    ).not.toContain("progressive-disclosure");
  });
  it("names only current asset screens and leaves no retired payload destination", () => {
    const current = ["AlertsTab", "AssetHeader", "SourcesTab", "OverviewTab", "ActivityTab"];
    for (const condition of MATERIAL_CONDITIONS) {
      const destination = MATERIALITY[condition].asset;
      if (destination.placement !== "not-applicable") {
        expect(current).toContain(destination.component.split(" / ")[0]);
      }
    }
    for (const concern of Object.values(ASSET_PAYLOAD_INVENTORY)) {
      expect(concern.destination).not.toMatch(/PropertyStateHero|CurrentState/);
    }
  });
});

const system: SystemData = {
  assetId: "root-os",
  hasPulse: true,
  spendTodayUsd: 9,
  dailyCapUsd: 3,
  ingest: { fresh: 3, stale: 1, notExpected: 1, expected: 4 },
  scheduledLanes: [
    { job: "backup", outcome: "failed", startedAt: RECENT },
  ],
};

/** This condition's Wall home is the attention rail: one expandable row that
 * owns the fact, while SYSTEM keeps its posture and drops the count. */
const neverReportedAttention: AttentionItem = {
  id: 21,
  asset: "fees.example",
  assetDisplayName: "Fee Codes",
  severity: "error",
  kind: "anomaly",
  message: "no pulse ever received",
  firedAt: RECENT,
  metric: "pulse",
  ruleId: "ingest-freshness",
  ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
  correlatedChanges: [],
  occurrences: 2,
  firstFiredAt: RECENT,
  members: [
    { id: 21, asset: "fees.example", assetDisplayName: "Fee Codes", firedAt: RECENT },
    { id: 22, asset: "areas.info", assetDisplayName: "Area Lookup", firedAt: RECENT },
  ],
};

const rollbackAttention: AttentionItem = {
  id: 7,
  asset: "meals.example",
  assetDisplayName: "Meal Planner",
  severity: "error",
  kind: "anomaly",
  message: "watch window closed with a decline",
  firedAt: RECENT,
  metric: "clicks",
  ruleId: "watch-window-closed",
  ruleInputs: { outcome: "kill_confirmed", deltaPercent: -31 },
  correlatedChanges: [],
  occurrences: 1,
  firstFiredAt: RECENT,
};

/** The Wall's widgets: every Wall destination is one of them or not-applicable. */
const D28_WIDGETS = ["WallStrip", "RevenueHero", "NeedsYou", "SiteRows", "WallFeed"];

describe("the Wall's destinations", () => {
  it("names a Wall widget for every condition the Wall shows, and a reason for each it does not", () => {
    for (const condition of MATERIAL_CONDITIONS) {
      const wall = MATERIALITY[condition].wall;
      if (wall.placement === "not-applicable") {
        expect(wall.reason.length, `${condition} has no reason`).toBeGreaterThan(20);
      } else {
        expect(D28_WIDGETS, `${condition} goes to ${wall.component}`).toContain(wall.component);
        expect(wall.placement).toBe("fixed-horizon");
      }
    }
    expect(
      Object.fromEntries(MATERIAL_CONDITIONS.map((condition) => {
        const wall = MATERIALITY[condition].wall;
        return [condition, wall.placement === "not-applicable" ? "not-applicable" : wall.component];
      })),
    ).toEqual({
      "open-flags": "NeedsYou",
      "signal-freshness": "NeedsYou",
      "os-runner-health": "NeedsYou",
      "scheduled-lane-health": "NeedsYou",
      "budget-guardrail": "NeedsYou",
      "human-gates": "NeedsYou",
      "active-changes": "not-applicable",
      // The asset card's bet line is not drawn, and a watch that closes badly
      // is rollback-failure.
      "outcome-watches": "not-applicable",
      "rollback-failure": "NeedsYou",
    });
    const watches = MATERIALITY["outcome-watches"].wall;
    expect(watches.placement === "not-applicable" ? watches.reason : "").toMatch(/rollback-failure/);
  });

  it("lists no retired widget as a payload key's destination", () => {
    const retired = /AttentionRail|AttentionPanel|PortfolioBand|SystemBand|AssetsBand|DashboardWidgets|ActiveWatchLine|Wall header/;
    for (const [key, concern] of Object.entries(WALL_PAYLOAD_INVENTORY)) {
      expect(concern.destination, key).not.toMatch(retired);
    }
  });
});

describe("material current-state fixtures", () => {
  /** A fresh, healthy OS report; each case below makes one condition the worst. */
  const calm: SystemData = {
    ...system,
    spendTodayUsd: 1,
    ingest: { fresh: 5, stale: 0, notExpected: 0, expected: 5 },
    scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: RECENT }],
  };

  it.each([
    ["os-runner-health", { ...calm, hasPulse: false }],
    ["scheduled-lane-health", system],
    ["signal-freshness", { ...calm, ingest: { ...calm.ingest, stale: 1 } }],
    ["budget-guardrail", { ...calm, spendTodayUsd: 9 }],
  ] as const)("draws %s in Needs you as a specific problem with a glyph", (condition, data) => {
    expect(MATERIALITY[condition].wall).toMatchObject({ placement: "fixed-horizon", component: "NeedsYou" });
    const issues = condition === "signal-freshness" ? [{ key: "report-fixture", severity: "warn" as const, assets: ["fixture.example"], site: "Fixture", line: "No nightly report in 62h", mark: "Report late", since: RECENT, conditions: ["signal-freshness" as const] }] : [];
    const { container } = renderUi(<NeedsYou issues={issues} system={data} nowMs={NOW} />);
    expect(container.querySelector(`[data-needs-row][data-material-condition~="${condition}"]`)).not.toBeNull();
    expectVisual(container, condition);
  });

  it("marks evaluated system conditions on the calm action list", () => {
    const { container } = renderUi(<NeedsYou issues={[]} system={calm} nowMs={NOW} />);
    for (const condition of ["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"] as const) {
      expectVisual(container, condition);
    }
  });

  it("keeps historical alert severity, rollback failure and human gates in Needs you", () => {
    const { container } = renderUi(
      <NeedsYou
        issues={wallIssues({
          assets: [],
          attention: [rollbackAttention, neverReportedAttention],
          connections: NO_READS,
          nowMs: NOW,
        })}
        operator={{
          waiting: 2,
          urgent: 1,
          measuredProjects: 2,
          urgentMeasuredProjects: 2,
          projectCount: 2,
          capturedAt: RECENT,
        }}
        nowMs={NOW}
      />,
    );
    for (const condition of [
      "open-flags",
      "rollback-failure",
      "human-gates",
    ] as const) {
      expect(MATERIALITY[condition].wall).toMatchObject({ placement: "fixed-horizon", component: "NeedsYou" });
      expectVisual(container, condition);
    }
    // Each row carries its own conditions, not only the list around it.
    expect(container.querySelector('[data-needs-row="error"][data-material-condition~="rollback-failure"] svg')).not.toBeNull();
    expect(container.querySelectorAll('[data-needs-row="error"][data-material-condition~="open-flags"]')).toHaveLength(2);
  });

  it("omits the retired condition and keeps unconfigured reporting neutral", () => {
    expect(MATERIAL_CONDITIONS).not.toContain("never-reported-lanes");
    const { container } = renderUi(
      <WallStrip system={{ ...calm, ingest: { fresh: 4, stale: 0, notExpected: 1, expected: 4 } }} assets={[]} nowMs={NOW} />,
    );
    expect(container.textContent).not.toContain("never reported");
  });
});
