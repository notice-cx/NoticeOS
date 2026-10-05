import { describe, expect, it } from "vitest";
import type { PullConfigEntry } from "../worker/asset-config";
import {
  BEADS_OWNER,
  PULL_OWNER,
  buildSettingsPayload,
  type SettingsDeps,
} from "../worker/settings-payload";
import type { IntegrationsConfig } from "../shared/integrations";
import { parseDashboardConfig } from "../shared/dashboard";

// GET /api/settings, built over a fixture config.
//
// The point of these cases is that the settings page is a VIEW OF THE FILES and
// nothing else: no store is consulted, every section names the file that owns
// it, and the two knob families the asset page already rendered come out of the
// SAME builders rather than a second spelling of them (bead `ro-pbzu.2`).
//
// What is editable is not a taste decision either — it is what the write lane
// licenses (D18). `config/constants.json` is wholesale-editable, so budget and
// alert rules are fields. The collection cadence is a set of DECLARED KNOBS
// (bead `ro-x5gu.8`), so the payload carries their VALUES keyed by declaration
// and nothing else — the label, the rule and the consequence stay in
// `scripts/config-registers.mjs`, where one copy of each lives. The catalog is a
// declared register, so its rows come through VERBATIM: an edit guards on the
// value it was rendered from, and a helpfully-defaulted field would be a guard
// the file never agreed with. `config/beads.json` is still neither.

const signalPanels = {
  refresh: { windowDays: 35, freshnessMaxAgeDays: 7, providerCallsPerPass: 0 },
};

const pullConfig: PullConfigEntry[] = [
  {
    asset: "meals.example",
    url: "https://meals.example/api/internal/metrics",
    enabled: true,
    format: "prometheus",
  },
  { asset: "nosh.example", url: "https://nosh.example/api/admin/overview", enabled: false, format: "envelope" },
];

const integrations: IntegrationsConfig = {
  catalog: [
    {
      id: "ga4",
      label: "Google Analytics 4",
      docRef: "docs/11#ga4",
      scope: "property",
      layer: "provider",
      credential: "shared",
    },
    {
      id: "operator-notify",
      label: "Operator notifications",
      docRef: "docs/11#notify",
      scope: "portfolio",
      layer: "os",
    },
  ],
  assets: {},
};

const dashboard = parseDashboardConfig({
  countdown: {
    emoji: "🚀",
    label: "Launch",
    targetAt: "2027-01-01T00:00:00.000Z",
  },
});

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    now: new Date("2026-09-04T12:00:00.000Z"),
    osTimeZone: "America/Los_Angeles",
    monthlyCaps: { dataUsd: 25 },
    operatorRateUsdPerMin: 2,
    flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
    signalPanels,
    pullConfig,
    integrations,
    dashboard,
    entities: [
      { slug: "reindex-ventures", name: "Reindex Ventures LLC", assets: ["meals.example"] },
    ],
    beads: {
      spokes: [
        { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
        { asset: "meals.example", prefix: "mp", database: "mp", repo: "../meals.example" },
      ],
      hub: { host: "127.0.0.1", port: 3308, user: "root", dataDir: ".local/beads-dolt" },
    },
    ...overrides,
  };
}

describe("buildSettingsPayload", () => {
  it("stamps the read and carries the shared TV config verbatim", () => {
    const payload = buildSettingsPayload(deps());
    expect(payload.generatedAt).toBe("2026-09-04T12:00:00.000Z");
    expect(payload.dashboard.countdown?.label).toBe("Launch");
    expect(payload.dashboard.countdown?.targetAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("carries the operator's clock with the file that owns it", () => {
    const { clock } = buildSettingsPayload(deps());
    expect(clock.timeZone).toBe("America/Los_Angeles");
    // The owner is what the page's Save writes to; a wrong path here would
    // send the write lane at a file that does not hold the key (ro-py40).
    expect(clock.owner).toBe("config/constants.json");
  });

  it("passes a configured zone through rather than assuming the operator's", () => {
    const { clock } = buildSettingsPayload(deps({ osTimeZone: "Europe/Warsaw" }));
    expect(clock.timeZone).toBe("Europe/Warsaw");
  });

  it("carries a TV config with no countdown, so a fresh install has a payload", () => {
    const payload = buildSettingsPayload(deps({ dashboard: parseDashboardConfig({}) }));
    expect(payload.dashboard.countdown).toBeUndefined();
    // Everything else still builds: the countdown is one optional card, not a
    // precondition for reading the settings page.
    expect(payload.budget.knobs.length).toBeGreaterThan(0);
  });

  it("carries the two budget knobs with the pointers the write lane needs", () => {
    const { budget } = buildSettingsPayload(deps());
    expect(budget.owner).toBe("config/constants.json");
    // NO INFERENCE CAP (D6 amended 2026-09-05, bead `ro-uj7x`). Nothing in the
    // OS calls a model, so that row could only state a ceiling and admit it was
    // not instrumented. Asserted as an exact list so it cannot come back by
    // accident: it comes back with a meter or not at all.
    expect(budget.knobs.map((k) => k.key)).toEqual([
      "monthly_caps.data_usd",
      "operator_rate_usd_per_min",
    ]);
    // The exact pointer and the effective value: the field writes one and sends
    // the other as its `expect`, so a wrong pointer is a silent no-op edit.
    expect(budget.knobs[0]).toMatchObject({
      pointer: "/monthly_caps/data_usd",
      value: 25,
      unit: "usd",
    });
    expect(budget.knobs[1]).toMatchObject({
      pointer: "/operator_rate_usd_per_min",
      value: 2,
      unit: "usd_per_min",
    });
  });

  it("carries the alert-rule defaults as editable rows with their explainers", () => {
    const { alertRules } = buildSettingsPayload(deps());
    expect(alertRules.owner).toBe("config/constants.json");
    expect(alertRules.knobs.map((k) => k.key)).toEqual([
      "alpha",
      "min_baseline_per_day",
      "low_volume_window_hours",
    ]);
    const alpha = alertRules.knobs[0]!;
    expect(alpha.pointer).toBe("/flag_defaults/alpha");
    expect(alpha.raw).toBe(0.01);
    expect(alpha.label).toBe("Anomaly sensitivity");
    // The one-line "what this means" is the page's whole defence against a
    // settings form nobody dares touch.
    expect(alpha.explain.length).toBeGreaterThan(0);
  });

  it("resolves every declared knob by its own pointer, and names the pull owner", () => {
    const { collection } = buildSettingsPayload(deps());
    // Keyed by DECLARATION, in declaration order — one file, two knobs, and
    // no label or rule restated here.
    expect(collection.knobs).toEqual([
      { key: "panel-refresh-window", value: 35 },
      { key: "panel-freshness-bar", value: 7 },
    ]);
    expect(collection.pullOwner).toBe(PULL_OWNER);
    expect(collection.pullAssets).toEqual([
      { asset: "meals.example", url: "https://meals.example/api/internal/metrics", enabled: true },
      { asset: "nosh.example", url: "https://nosh.example/api/admin/overview", enabled: false },
    ]);
  });

  // Absent is a real state: a config with no `/refresh` block renders no rows
  // rather than two zeros nobody configured.
  it("leaves out a knob whose block the config does not carry", () => {
    const { collection } = buildSettingsPayload(deps({ signalPanels: {} }));
    expect(collection.knobs).toEqual([]);
  });

  it("reads a missing pull switch as running, never as paused", () => {
    const payload = buildSettingsPayload(
      deps({
        pullConfig: [
          { asset: "areas.example", url: "https://areas.example/pulse", format: "envelope" } as PullConfigEntry,
        ],
      }),
    );
    expect(payload.collection.pullAssets[0]!.enabled).toBe(true);
  });

  it("carries the source catalog exactly as the file holds it, so an edit can guard on it", () => {
    const { sources } = buildSettingsPayload(deps());
    expect(sources.owner).toBe("config/integrations.json");
    // Verbatim, prose fields and all: these are the register's columns now, and
    // the `expect` an edit sends has to be the value the file actually has.
    expect(sources.rows[0]).toEqual(integrations.catalog[0]);
    // Nothing is filled in. The second lane declares no credential, and the
    // payload says so rather than inventing the matrix's conservative default —
    // which would be a guard the file has never agreed with.
    expect(sources.rows[1]!.credential).toBeUndefined();
    // Lane STATE is /health's, off collector evidence. Nothing here may claim it.
    expect(Object.keys(sources.rows[0]!)).not.toContain("status");
  });

  it("carries the task-hub projects, their owner file and the connection", () => {
    const { taskHub } = buildSettingsPayload(deps());
    expect(taskHub.owner).toBe(BEADS_OWNER);
    expect(taskHub.spokes).toEqual([
      { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
      { asset: "meals.example", prefix: "mp", database: "mp", repo: "../meals.example" },
    ]);
    // Read-only, and only so the onboarding command an operator copies after an
    // Add carries the real host and port rather than a fourth typed copy of a
    // value three files already have to agree on (bead ro-x5gu.5).
    expect(taskHub.hub).toEqual({
      host: "127.0.0.1",
      port: 3308,
      user: "root",
      dataDir: ".local/beads-dolt",
    });
  });

  it("says the connection is absent rather than inventing one, on a build without it", () => {
    // `vite build` compiles the hub out with the runner lane, and that is also
    // the build where nothing here is editable — so the checklist that needs the
    // command can never appear in it.
    const { taskHub } = buildSettingsPayload(deps({ beads: { spokes: [] } }));
    expect(taskHub.hub).toBeNull();
  });

  it("returns a fully-formed payload when every list is empty", () => {
    const payload = buildSettingsPayload(
      deps({
        pullConfig: [],
        integrations: { catalog: [], assets: {} },
        beads: { spokes: [] },
        flagDefaults: {},
      }),
    );
    expect(payload.collection.pullAssets).toEqual([]);
    expect(payload.sources.rows).toEqual([]);
    expect(payload.taskHub.spokes).toEqual([]);
    expect(payload.alertRules.knobs).toEqual([]);
    // The budget is two constants, not a list, so it never empties.
    expect(payload.budget.knobs).toHaveLength(2);
  });
});
