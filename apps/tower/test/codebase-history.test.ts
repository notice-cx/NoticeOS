// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AssetDetailDeps } from "../worker/asset-detail-payload";
import { buildAssetDetailView } from "../worker/asset-detail-payload";
import { readFileSync } from "node:fs";
import { parseCodebaseReport, parseMeasures, parseUnmeasured, readCodebaseSlice } from "../worker/codebase-history";
import { CODEBASE_TOOLS, codebaseReport, commitOf, dayBefore, storeCodebaseReports, weeklyMeasures, weeklyStoredReports } from "./codebase-fixture";
import { createTestStore, postgresUnavailable, type TestStore } from "./postgres-store";
import { addSites } from "./sites";

/**
 * One site's codebase reports as its Codebase tab reads them: each day's
 * newest revision over ninety days, oldest first, reduced to measures and
 * tools; the newest report in full whatever its age; and a stored envelope
 * read without trusting it to be well formed.
 */

const NOW = new Date("2026-07-05T12:00:00.000Z");
const TODAY = "2026-07-05";
const ASSET = "meadow.example";

const DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, max_window_days: 14 },
  pullConfig: [],
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: { catalog: [], assets: {} },
  counters: { assets: {} },
  serpPanel: { assets: {} },
  signalPanels: { assets: {} },
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  osTimeZone: "UTC",
};

describe("a stored envelope, read", () => {
  it("keeps only known measures with a non-negative number, so anything else is unmeasured", () => {
    expect(parseMeasures({ code_lines: 10, duplication_percent: 4.5, unknown: 3, files: -1, functions: "12", test_ratio: null }))
      .toEqual({ code_lines: 10, duplication_percent: 4.5 });
    expect(parseMeasures(null)).toEqual({});
    expect(parseMeasures([1, 2])).toEqual({});
  });

  it("reads absent lists as empty and drops a finding it cannot read, keeping the report", () => {
    const report = codebaseReport(ASSET, TODAY);
    const stored = {
      ...report,
      byLanguage: undefined,
      findings: {
        duplicates: [{ lines: 4, files: [{ path: "a.ts", startLine: 1 }] }, { lines: "x", files: [] }],
        complexFunctions: [{ path: "x.ts", name: "f", line: 1 }],
        unused: [{ kind: "file", path: "old.ts" }, { kind: "export", path: "u.ts" }, { kind: "dependency", name: "pad" }, { kind: "other" }],
      },
    };
    const read = parseCodebaseReport(JSON.stringify(stored))!;
    expect(read.byLanguage).toEqual([]);
    expect(read.findings.duplicates).toEqual([{ lines: 4, files: [{ path: "a.ts", startLine: 1 }] }]);
    expect(read.findings.complexFunctions).toEqual([]);
    expect(read.findings.unused).toEqual([{ kind: "file", path: "old.ts" }, { kind: "dependency", name: "pad" }]);
    expect(read.findings.largestFiles).toEqual([]);
    expect(read.measures).toEqual(weeklyMeasures(0));
    expect(read.tools).toEqual(CODEBASE_TOOLS);
  });

  it("reads the sample envelope measured from a real repository in full, its reasons included", () => {
    const sample = readFileSync(new URL("../../../deploy/codebase-report/sample/example.com.json", import.meta.url), "utf8");
    const raw = JSON.parse(sample) as { measures: Record<string, number>; unmeasured: Record<string, string>; findings: Record<string, unknown[]> };
    const read = parseCodebaseReport(sample)!;
    expect(read.measures).toEqual(raw.measures);
    expect(read.unmeasured).toEqual(raw.unmeasured);
    for (const [list, rows] of Object.entries(raw.findings)) {
      expect(read.findings[list as keyof typeof read.findings], list).toHaveLength(rows.length);
    }
  });

  it("keeps only known measures' reasons", () => {
    expect(parseUnmeasured({ unused_files: "Not for Ruby.", nonsense: "x", functions: 3, files: " " })).toEqual({ unused_files: "Not for Ruby." });
  });

  it("is no report when the envelope has no identity", () => {
    expect(parseCodebaseReport("not json")).toBeNull();
    expect(parseCodebaseReport(JSON.stringify({ asset: ASSET, generatedAt: NOW.toISOString() }))).toBeNull();
    expect(parseCodebaseReport("[]")).toBeNull();
  });
});

describe.skipIf(postgresUnavailable() !== null)("readCodebaseSlice on Postgres", () => {
  async function seeded(): Promise<TestStore> {
    const ctx = await createTestStore();
    await addSites(ctx, [
      { id: ASSET, displayName: "Meadow Board", status: "live", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "ferns.example", displayName: "Ferns", status: "live", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    return ctx;
  }

  it("reads each day's newest revision over ninety days, oldest first, and the newest report in full", async () => {
    const ctx = await seeded();
    const weekly = weeklyStoredReports(ASSET, TODAY);
    const old = codebaseReport(ASSET, dayBefore(TODAY, 120), { code_lines: 1 });
    // The day's resend replaces nothing: it is revision 2, and the newer one is read.
    const resend = codebaseReport(ASSET, TODAY, { ...weeklyMeasures(0), code_lines: 48_999 });
    resend.repository.commit = commitOf(99);
    await storeCodebaseReports(ctx.call, [
      { asset: ASSET, date: dayBefore(TODAY, 120), report: old },
      ...weekly,
      { asset: ASSET, date: TODAY, report: resend, receivedAt: `${TODAY}T05:00:00.000Z` },
      { asset: "ferns.example", date: TODAY, report: codebaseReport("ferns.example", TODAY) },
    ]);

    const slice = await readCodebaseSlice(ctx.call, ASSET, NOW);
    expect(slice.history.map((point) => point.date)).toEqual(weekly.map((row) => row.date));
    expect(slice.history[0]).toEqual({
      date: dayBefore(TODAY, 84), commit: commitOf(13), ref: "main", generatedAt: `${dayBefore(TODAY, 84)}T03:12:44.000Z`,
      measures: weeklyMeasures(12), tools: CODEBASE_TOOLS,
    });
    expect(slice.history.at(-1)).toMatchObject({ date: TODAY, commit: commitOf(99), measures: { code_lines: 48_999 } });
    expect(slice.latest).toMatchObject({ date: TODAY, revision: 2, receivedAt: `${TODAY}T05:00:00.000Z` });
    expect(slice.latest!.report.repository.commit).toBe(commitOf(99));
    expect(slice.latest!.report.findings.duplicates).toHaveLength(2);
  });

  it("keeps the newest report when it is older than the window, and is empty for a site that never sent one", async () => {
    const ctx = await seeded();
    await storeCodebaseReports(ctx.call, [{ asset: ASSET, date: dayBefore(TODAY, 100), report: codebaseReport(ASSET, dayBefore(TODAY, 100)) }]);
    const stale = await readCodebaseSlice(ctx.call, ASSET, NOW);
    expect(stale.history).toEqual([]);
    expect(stale.latest?.date).toBe(dayBefore(TODAY, 100));
    expect(await readCodebaseSlice(ctx.call, "ferns.example", NOW)).toEqual({ history: [], latest: null });
  });

  it("rides the Codebase tab's view with the visitors and deploys, and no other tab's", async () => {
    const ctx = await seeded();
    await storeCodebaseReports(ctx.call, weeklyStoredReports(ASSET, TODAY, 2));
    const view = (await buildAssetDetailView(ctx.call, ASSET, DEPS, "codebase"))!;
    expect(view.codebase.history).toHaveLength(2);
    expect(view).toHaveProperty("performance");
    expect(view).toHaveProperty("annotations");
    expect(view).not.toHaveProperty("metrics");
    const overview = (await buildAssetDetailView(ctx.call, ASSET, DEPS, "overview"))!;
    expect(overview).not.toHaveProperty("codebase");
  });
});
