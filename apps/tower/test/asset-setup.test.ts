// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assetSetupChecklist,
  daysSince,
  isSettingUp,
  SETUP_BASELINE_DAYS,
  type SetupChecklist,
  type SetupChecklistFacts,
  type SetupChecklistItem,
} from "@shared/asset-setup";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function facts(over: Partial<SetupChecklistFacts> = {}): SetupChecklistFacts {
  return {
    id: "pebble.example",
    displayName: "Pebble Works",
    status: "onboarding",
    sources: [
      { id: "nightly-report", kind: "working" },
      { id: "gsc", kind: "working" },
      { id: "ga4", kind: "not-connected" },
    ],
    firstReportAt: daysAgo(9),
    reportDays: 9,
    latestReportAt: daysAgo(0),
    nowMs: NOW,
    ...over,
  };
}

function checklist(over: Partial<SetupChecklistFacts> = {}): SetupChecklist {
  const result = assetSetupChecklist(facts(over));
  if (!result) throw new Error("expected a checklist for a setup-stage asset");
  return result;
}

function item(list: SetupChecklist, id: SetupChecklistItem["id"]): SetupChecklistItem {
  const found = list.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} item`);
  return found;
}

describe("isSettingUp — which stages carry a checklist", () => {
  it("covers exactly onboarding and baselining", () => {
    expect(isSettingUp("onboarding")).toBe(true);
    expect(isSettingUp("baselining")).toBe(true);
    expect(isSettingUp("live")).toBe(false);
    expect(isSettingUp("pre-launch")).toBe(false);
    expect(isSettingUp("retired")).toBe(false);
  });

  it("says no to a stage the store has never held, rather than guessing", () => {
    expect(isSettingUp("mothballed")).toBe(false);
  });
});

describe("assetSetupChecklist — when it exists at all", () => {
  it("returns null for a live asset, which is how the ring disappears", () => {
    expect(assetSetupChecklist(facts({ status: "live" }))).toBeNull();
  });

  it("returns null for pre-launch and retired too", () => {
    expect(assetSetupChecklist(facts({ status: "pre-launch" }))).toBeNull();
    expect(assetSetupChecklist(facts({ status: "retired" }))).toBeNull();
  });

  it("returns four data setup items and the unavailable pause check in flow-A order", () => {
    for (const status of ["onboarding", "baselining"]) {
      const list = checklist({ status });
      expect(list.items.map((entry) => entry.id)).toEqual([
        "identity",
        "sources",
        "first-report",
        "baseline",
        "pause-check",
      ]);
      expect(list.total).toBe(4);
    }
  });

  it.each([0, 9, 28])("leaves data progress unchanged with %s reports and an unavailable pause check", (reportDays) => {
    const list = checklist({ reportDays, sources: [{ id: "gsc", kind: "working" }] });
    expect(item(list, "pause-check")).toEqual({ id: "pause-check", label: "Pause check", state: "unavailable",
      note: "Unavailable · Agent execution is manual.", href: null, progress: null });
    expect(list.total).toBe(4);
    expect(list.done).toBe(reportDays === 28 ? 4 : 3);
    expect(list.remaining).toEqual(reportDays === 28 ? [] : ["28 days of reports"]);
    expect(list.title).not.toContain("Pause check");
  });
});

describe("item 1 — identity", () => {
  it("is done when the asset carries a name of its own", () => {
    const identity = item(checklist(), "identity");
    expect(identity.state).toBe("done");
    expect(identity.note).toContain("Pebble Works");
    expect(identity.href).toBe("/assets/pebble.example/settings");
  });

  it("is pending when the display name is only the id echoed back", () => {
    const identity = item(
      checklist({ displayName: "pebble.example" }),
      "identity",
    );
    expect(identity.state).toBe("pending");
    // The state, not a sentence: no name, and what it shows as instead.
    expect(identity.note).toBe("No name · shows as pebble.example");
  });

  it("is pending on a blank name", () => {
    expect(item(checklist({ displayName: "   " }), "identity").state).toBe("pending");
  });

  it("percent-encodes an id in its link", () => {
    const identity = item(checklist({ id: "a b.co" }), "identity");
    expect(identity.href).toBe("/assets/a%20b.co/settings");
  });
});

describe("item 2 — data sources (read from each source's one status)", () => {
  it("excludes the nightly-report lane, which item 3 already owns", () => {
    const sources = item(checklist({ sources: [{ id: "nightly-report", kind: "not-connected" }, { id: "gsc", kind: "working" }] }), "sources");
    expect(sources.state).toBe("done");
    expect(sources.progress).toEqual({ done: 1, total: 1 });
  });

  it("is pending while any applicable source is not connected", () => {
    const sources = item(checklist(), "sources");
    expect(sources.state).toBe("pending");
    expect(sources.note).toBe("1 of 2 connected, off or not applicable");
    expect(sources.progress).toEqual({ done: 1, total: 2 });
    expect(sources.href).toBe("/assets/pebble.example/sources");
  });

  it("counts a connected source whatever its health, and an off or inapplicable one, as settled", () => {
    const settled: SetupChecklistFacts["sources"] = [
      { id: "nightly-report", kind: "not-connected" },
      { id: "gsc", kind: "working" },
      { id: "ga4", kind: "failing" },
      { id: "posthog", kind: "collecting" },
      { id: "dataforseo", kind: "overdue" },
      { id: "bing-webmaster", kind: "not-using" },
      { id: "clarity", kind: "not-applicable" },
    ];
    const sources = item(checklist({ sources: settled }), "sources");
    expect(sources.state).toBe("done");
    expect(sources.progress).toEqual({ done: 6, total: 6 });
    expect(sources.note).toBe("6 of 6 connected, off or not applicable");
    expect(sources.note).not.toMatch(/working|healthy/u);
  });

  it("never counts an unanswered monitoring read as done", () => {
    const sources = item(checklist({ sources: [{ id: "gsc", kind: "unknown" }, { id: "ga4", kind: "working" }] }), "sources");
    expect(sources.state).toBe("pending");
    expect(sources.progress).toEqual({ done: 1, total: 2 });
  });

  it("never lists each source's status again: that is its Data sources row's", () => {
    expect(Object.keys(item(checklist(), "sources")).sort()).toEqual(["href", "id", "label", "note", "progress", "state"]);
  });

  it("an asset no lane applies to is done, and says so", () => {
    const sources = item(
      checklist({ sources: [{ id: "nightly-report", kind: "working" }] }),
      "sources",
    );
    expect(sources.state).toBe("done");
    expect(sources.note).toBe("No data sources apply to this site.");
  });
});

describe("item 3 — the first nightly report", () => {
  it("is done once one has ever arrived, and goes to /health", () => {
    const report = item(checklist(), "first-report");
    expect(report.state).toBe("done");
    expect(report.href).toBe("/health");
    expect(report.note).toBe("First report arrived 9 days ago.");
  });

  // A site that has never sent a report expects none, so the report is
  // offered, never owed.
  it("is an optional offer when none has, linking to the site's Data collection card", () => {
    const report = item(
      checklist({ id: "new.example.com", latestReportAt: null, firstReportAt: null }),
      "first-report",
    );
    expect(report.state).toBe("optional");
    expect(report.label).toBe("Nightly report");
    expect(report.note).toBe("Optional");
    expect(report.href).toBe("/assets/new.example.com/settings#data-collection");
  });

  it("stays done for an asset whose reports later stopped", () => {
    // Freshness is a different fact with a different owner (the alert). The
    // checklist must not un-tick a step the asset genuinely completed.
    const report = item(
      checklist({ latestReportAt: daysAgo(20), firstReportAt: daysAgo(24) }),
      "first-report",
    );
    expect(report.state).toBe("done");
  });

  it("says a day, singular, on the day after the first report", () => {
    const report = item(checklist({ firstReportAt: daysAgo(1) }), "first-report");
    expect(report.note).toBe("First report arrived 1 day ago.");
  });
});

describe("item 4 — measured 28-day report coverage", () => {
  // The note is the count the step waits on, beside its label, never how
  // coverage is measured.
  it("counts actual report dates as the count the step waits on", () => {
    const baseline = item(checklist(), "baseline");
    expect(baseline.state).toBe("pending");
    expect(baseline.progress).toEqual({ done: 9, total: SETUP_BASELINE_DAYS });
    expect(baseline.note).toBe("9 of 28 days");
  });

  it("requires 28 observed dates and never promises rule eligibility", () => {
    const baseline = item(checklist({ firstReportAt: daysAgo(40), reportDays: 28 }), "baseline");
    expect(baseline.state).toBe("done");
    expect(baseline.progress).toEqual({ done: 28, total: 28 });
    expect(baseline.note).toBe("28 of 28 days");
    expect(baseline.note).not.toMatch(/rules can arm|eligib/u);
  });

  it("one old report never completes coverage", () => {
    const baseline = item(checklist({ firstReportAt: daysAgo(40), reportDays: 0 }), "baseline");
    expect(baseline.state).toBe("pending");
    expect(baseline.progress).toEqual({ done: 0, total: 28 });
  });

  it("keeps gaps visible even when collection resumed after an outage", () => {
    const baseline = item(checklist({ firstReportAt: daysAgo(60), reportDays: 12 }), "baseline");
    expect(baseline.state).toBe("pending");
    expect(baseline.note).toBe("12 of 28 days");
  });

  it("does not complete a stale asset on elapsed time", () => {
    const baseline = item(checklist({ firstReportAt: daysAgo(60), latestReportAt: daysAgo(20), reportDays: 8 }), "baseline");
    expect(baseline.state).toBe("pending");
    expect(baseline.progress?.done).toBe(8);
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 29])(
    "shows unknown for absent or impossible coverage %s rather than inventing completion",
    (reportDays) => {
      const baseline = item(checklist({ firstReportAt: daysAgo(40), reportDays }), "baseline");
      expect(baseline.state).toBe("pending");
      expect(baseline.progress).toBeNull();
      expect(baseline.note).toBe("Unknown");
    },
  );

  it("is not listed for a site that has never reported, however long ago it was added", () => {
    const list = checklist({ firstReportAt: null, latestReportAt: null, reportDays: 0 });
    expect(list.items.map((entry) => entry.id)).not.toContain("baseline");
  });

  it("links to collection health so an outage can be investigated", () => {
    expect(item(checklist(), "baseline").href).toBe("/health");
  });
});

describe("the fraction and the sentence the ring carries", () => {
  it("counts nothing done on a brand-new nameless asset, and never counts the report it was not asked for", () => {
    const list = checklist({
      id: "new.example.com",
      displayName: "new.example.com",
      sources: [{ id: "gsc", kind: "not-connected" }],
      firstReportAt: null,
      latestReportAt: null,
      reportDays: 0,
    });
    expect(list.done).toBe(0);
    expect(list.remaining).toEqual(["Identity", "Data sources"]);
    expect(list.title).toBe("Setup 0 of 2 — still to do: Identity, Data sources");
    // The report is offered; the unavailable pause check is also uncounted.
    expect(list.items.map((entry) => [entry.id, entry.state])).toEqual([
      ["identity", "pending"],
      ["sources", "pending"],
      ["first-report", "optional"],
      ["pause-check", "unavailable"],
    ]);
  });

  it("completes a new site's setup without any nightly report", () => {
    const list = checklist({
      id: "new.example.com",
      displayName: "New Example",
      sources: [{ id: "gsc", kind: "working" }],
      firstReportAt: null,
      latestReportAt: null,
      reportDays: 0,
    });
    expect(list.done).toBe(2);
    expect(list.remaining).toEqual([]);
    expect(list.title).toBe("Setup 2 of 2 — all done");
  });

  it("owes both report steps from the first report on", () => {
    const list = checklist({ firstReportAt: daysAgo(0), latestReportAt: daysAgo(0), reportDays: 0 });
    expect(list.items.map((entry) => [entry.id, entry.state])).toEqual([
      ["identity", "done"],
      ["sources", "pending"],
      ["first-report", "done"],
      ["baseline", "pending"],
      ["pause-check", "unavailable"],
    ]);
    expect(list.total).toBe(4);
  });

  it("counts two of four on the ordinary mid-onboarding asset", () => {
    const list = checklist();
    expect(list.done).toBe(2);
    expect(list.title).toBe(
      "Setup 2 of 4 — still to do: Data sources, 28 days of reports",
    );
  });

  it("counts four of four without claiming that the website was not already live", () => {
    const list = checklist({
      sources: [
        { id: "nightly-report", kind: "working" },
        { id: "gsc", kind: "working" },
      ],
      firstReportAt: daysAgo(30),
      reportDays: 28,
    });
    expect(list.done).toBe(4);
    expect(list.remaining).toEqual([]);
    expect(list.title).toBe("Setup 4 of 4 — all done");
  });
});

describe("daysSince", () => {
  it("floors to whole days", () => {
    expect(daysSince(new Date(NOW - DAY - 1000).toISOString(), NOW)).toBe(1);
    expect(daysSince(new Date(NOW - DAY + 1000).toISOString(), NOW)).toBe(0);
  });

  it("reads an instant in the future as day zero rather than a negative", () => {
    expect(daysSince(new Date(NOW + 5 * DAY).toISOString(), NOW)).toBe(0);
  });

  it("reads an unparseable instant as day zero rather than NaN", () => {
    expect(daysSince("not a date", NOW)).toBe(0);
  });
});

describe("an asset declared as sending no nightly report", () => {
  it("drops both nightly-report steps instead of leaving them pending forever", () => {
    const list = checklist({
      noNightlyReport: true,
      firstReportAt: null,
      reportDays: 0,
      latestReportAt: null,
      sources: [{ id: "nightly-report", kind: "not-using" }, { id: "gsc", kind: "working" }],
    });
    expect(list.items.map((entry) => entry.id)).toEqual(["identity", "sources", "pause-check"]);
    expect(list.total).toBe(2);
    expect(list.remaining).toEqual([]);
    expect(list.title).toBe("Setup 2 of 2 — all done");
  });

  it("keeps both steps for an asset that still owes its report", () => {
    // It sent one, so it expects its report; the latest is three weeks old.
    const list = checklist({ firstReportAt: daysAgo(30), reportDays: 0, latestReportAt: daysAgo(21) });
    expect(list.remaining).toContain("28 days of reports");
    expect(list.items.map((entry) => entry.id)).toContain("first-report");
    expect(list.total).toBe(4);
  });

  it("offers no report step to a declared site that never sent one", () => {
    const list = checklist({ noNightlyReport: true, firstReportAt: null, reportDays: 0, latestReportAt: null });
    expect(list.items.map((entry) => entry.state)).not.toContain("optional");
  });
});
