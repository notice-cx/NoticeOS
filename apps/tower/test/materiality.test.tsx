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
import { DEFAULT_WALL_LAYOUT, wallLayoutWidgets } from "@shared/wall-layout";
import { NeedsYou } from "@/components/wall/NeedsYou";
import { WallStrip } from "@/components/wall/WallStrip";
import { WallTimeline } from "@/components/wall/WallTimeline";
import { WallWork } from "@/components/wall/WallWork";
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
  asset: "ferns.example",
  assetDisplayName: "Fern Index",
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
    { id: 21, asset: "ferns.example", assetDisplayName: "Fern Index", firedAt: RECENT },
    { id: 22, asset: "acorn.example.net", assetDisplayName: "Acorn Atlas", firedAt: RECENT },
  ],
};

const rollbackAttention: AttentionItem = {
  id: 7,
  asset: "meadow.example",
  assetDisplayName: "Meadow Board",
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
const WALL_WIDGETS = ["WallStrip", "WallLoop", "RevenueHero", "SiteRows", "WallTimeline", "WallWork", "NeedsYou", "WallFeed"];

describe("the Wall's destinations", () => {
  it("names a Wall widget for every condition the Wall shows, and a reason for each it does not", () => {
    for (const condition of MATERIAL_CONDITIONS) {
      const wall = MATERIALITY[condition].wall;
      if (wall.placement === "not-applicable") {
        expect(wall.reason.length, `${condition} has no reason`).toBeGreaterThan(20);
      } else {
        expect(WALL_WIDGETS, `${condition} goes to ${wall.component}`).toContain(wall.component);
        expect(wall.placement).toBe("fixed-horizon");
      }
    }
    // The default Wall's widgets: problems on the timeline, the inbox on the
    // work chart. Needs attention is in the library, not on the default.
    expect(
      Object.fromEntries(MATERIAL_CONDITIONS.map((condition) => {
        const wall = MATERIALITY[condition].wall;
        return [condition, wall.placement === "not-applicable" ? "not-applicable" : wall.component];
      })),
    ).toEqual({
      "open-flags": "WallTimeline",
      "signal-freshness": "WallTimeline",
      "os-runner-health": "WallTimeline",
      "scheduled-lane-health": "WallTimeline",
      "budget-guardrail": "WallTimeline",
      "human-gates": "WallWork",
      "active-changes": "not-applicable",
      // The asset card's bet line is not drawn, and a watch that closes badly
      // is rollback-failure.
      "outcome-watches": "not-applicable",
      "rollback-failure": "WallTimeline",
    });
    const watches = MATERIALITY["outcome-watches"].wall;
    expect(watches.placement === "not-applicable" ? watches.reason : "").toMatch(/rollback-failure/);
  });

  it("puts every Wall destination on the default layout", () => {
    const placed = new Set(wallLayoutWidgets(DEFAULT_WALL_LAYOUT).map((widget) => widget.type));
    const drawnBy: Record<string, string> = { WallTimeline: "timeline", WallWork: "work" };
    for (const condition of MATERIAL_CONDITIONS) {
      const wall = MATERIALITY[condition].wall;
      if (wall.placement === "not-applicable") continue;
      expect(placed.has(drawnBy[wall.component] as never), `${condition}: ${wall.component} is on the default Wall`).toBe(true);
    }
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
  const reportLate = { key: "report-fixture", severity: "warn" as const, assets: ["fixture.example"], site: "Fixture", line: "No nightly report in 62h", mark: "Report late", since: RECENT, conditions: ["signal-freshness" as const] };
  const cases = [
    ["os-runner-health", { ...calm, hasPulse: false }],
    ["scheduled-lane-health", system],
    ["signal-freshness", { ...calm, ingest: { ...calm.ingest, stale: 1 } }],
    ["budget-guardrail", { ...calm, spendTodayUsd: 9 }],
  ] as const;

  function timeline(issues: Parameters<typeof WallTimeline>[0]["issues"], data: SystemData | undefined) {
    return renderUi(<WallTimeline assets={[]} issues={issues} system={data} feed={[]} since={null} nowMs={NOW} />);
  }

  it.each(cases)("draws %s on the Wall's timeline as a bar of its own, with a glyph", (condition, data) => {
    expect(MATERIALITY[condition].wall).toMatchObject({ placement: "fixed-horizon", component: "WallTimeline" });
    const { container } = timeline(condition === "signal-freshness" ? [reportLate] : [], data);
    expect(container.querySelector(`[data-span][data-material-condition~="${condition}"]`)).not.toBeNull();
    expect(container.querySelector("[data-wall-timeline]")).toHaveAttribute("data-wall-timeline", "problems");
    expectVisual(container, condition);
  });

  it("states the System's evaluated calm on the timeline's own line", () => {
    const { container } = timeline([], calm);
    expect(container.querySelector("[data-wall-timeline]")).toHaveAttribute("data-wall-timeline", "calm");
    expect(container.querySelector("[data-timeline-status]")).toHaveTextContent("Nothing broken");
    for (const condition of ["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"] as const) {
      expectVisual(container, condition);
    }
  });

  it("claims no System condition it was not given", () => {
    const { container } = timeline([], undefined);
    for (const condition of ["os-runner-health", "scheduled-lane-health", "budget-guardrail"] as const) {
      expect(visibleMarkers(container, condition)).toEqual([]);
    }
  });

  it("keeps historical alert severity and rollback failure on the timeline, each bar carrying its own", () => {
    const { container } = timeline(
      wallIssues({ assets: [], attention: [rollbackAttention, neverReportedAttention], connections: NO_READS, nowMs: NOW }),
      undefined,
    );
    for (const condition of ["open-flags", "rollback-failure"] as const) {
      expect(MATERIALITY[condition].wall).toMatchObject({ placement: "fixed-horizon", component: "WallTimeline" });
      expectVisual(container, condition);
    }
    expect(container.querySelector('[data-span][data-severity="error"][data-material-condition~="rollback-failure"]')).not.toBeNull();
    // One bar per site the alert names: the rollback's one and the two silent sites.
    expect(container.querySelectorAll('[data-span][data-severity="error"][data-material-condition~="open-flags"]')).toHaveLength(3);
  });

  it("puts human gates on the Wall's work chart, and never a zero it did not count", () => {
    expect(MATERIALITY["human-gates"].wall).toMatchObject({ placement: "fixed-horizon", component: "WallWork" });
    const operator = { waiting: 2, urgent: 1, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: RECENT };
    const counted = renderUi(<WallWork assets={[]} operator={operator} nowMs={NOW} />);
    expectVisual(counted.container, "human-gates");
    expect(counted.container.querySelector('[data-material-condition~="human-gates"]')).toHaveTextContent("21 urgent");
    counted.unmount();
    const partial = renderUi(<WallWork assets={[]} operator={{ ...operator, waiting: 0, urgent: 0, measuredProjects: 1, urgentMeasuredProjects: 1 }} nowMs={NOW} />);
    expect(partial.container.querySelector('[data-material-condition~="human-gates"]')).toHaveTextContent("unknown");
    partial.unmount();
    const unread = renderUi(<WallWork assets={[]} operator={null} nowMs={NOW} />);
    expect(unread.container.querySelector('[data-material-condition~="human-gates"]')).toHaveTextContent("Tasks unknown");
    expectVisual(unread.container, "human-gates");
  });
});

// Needs attention is no longer on the default Wall but stays in the library; a Wall
// that places it still draws every condition it names.
describe("Needs attention, when a layout places it", () => {
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
  ] as const)("draws %s as a specific problem with a glyph", (condition, data) => {
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

  it("keeps historical alert severity, rollback failure and human gates", () => {
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
    for (const condition of ["open-flags", "rollback-failure", "human-gates"] as const) {
      expectVisual(container, condition);
    }
    // Each row carries its own conditions, not only the list around it.
    expect(container.querySelector('[data-needs-row="error"][data-material-condition~="rollback-failure"] svg')).not.toBeNull();
    expect(container.querySelectorAll('[data-needs-row="error"][data-material-condition~="open-flags"]')).toHaveLength(2);
  });
});

describe("the strip", () => {
  it("omits the retired condition and keeps unconfigured reporting neutral", () => {
    expect(MATERIAL_CONDITIONS).not.toContain("never-reported-lanes");
    const calm: SystemData = { ...system, spendTodayUsd: 1, scheduledLanes: [] };
    const { container } = renderUi(
      <WallStrip system={{ ...calm, ingest: { fresh: 4, stale: 0, notExpected: 1, expected: 4 } }} assets={[]} nowMs={NOW} />,
    );
    expect(container.textContent).not.toContain("never reported");
  });
});
