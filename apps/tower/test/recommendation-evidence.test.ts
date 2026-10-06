// @vitest-environment node
import type { WorkspaceStore } from "@noticeos/postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "./postgres-store";
import { writeArchiveRuns, type TestArchiveRun } from "./provider-reports";
import { addSites } from "./sites";
import { readRecommendationSources } from "../worker/recommendation-evidence";
import { signalEvidenceFloor } from "../worker/integration-evidence";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const since = signalEvidenceFloor(NOW);

/** A store whose every read fails, or counts its reads. */
function failingStore(onRead: () => void = () => {}): WorkspaceStore {
  return { read: async () => { onRead(); throw new Error("fixture store failure"); } } as unknown as WorkspaceStore;
}

describe("recommendation source read model against the real schema", () => {
  let fixture: TestStore;
  beforeEach(async () => {
    fixture = await createTestStore();
    await addSites(fixture, ["nosh.example", "meals.example"].map((id) => ({ id, domain: null, displayName: id, status: "live", senseOnly: 1, createdAt: "2026-01-01" })));
  });
  afterEach(() => fixture.close());

  /** Search Console report runs, on Postgres where the collector writes them
   * (bead ro-ujb9.76.5.4), in the order given. */
  async function insert(...runs: [id: string, report: string, date: string, at: string, status?: TestArchiveRun["status"], asset?: string][]) {
    await writeArchiveRuns(fixture.call, runs.map(([id, report, date, at, status = "success", asset = "nosh.example"]) => ({
      id, asset, integration: "gsc", report, credential_ref: "fixture-account-reference", property_ref: "fixture-property",
      report_date: date, finished_at: at, status, data_state: "provider-final", provider_rows: 3, request_count: 1,
      object_key: `fixture/${id}`, object_bytes: 3, error_code: "fixture-failure", error_message: "Test collection failed",
    })));
  }

  async function storedRuns(): Promise<number> {
    const [row] = await (fixture.call).read((tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM noticeos.archive_runs"));
    return row!.n;
  }

  it("keeps family dates separate and scopes exactly to the requested asset", async () => {
    await insert(
      ["query", "query", "2026-08-31", "2026-09-05T10:00:00.000Z"],
      ["page", "page", "2026-09-04", "2026-09-05T11:00:00.000Z"],
      ["other", "page-query", "2026-09-04", "2026-09-05T11:00:00.000Z", "success", "meals.example"],
    );
    expect(await readRecommendationSources(fixture.call, "nosh.example", NOW)).toEqual({ available: true, truncated: false, since, reports: [
      { source: "gsc/page", reportDate: "2026-09-04", collectedAt: "2026-09-05T11:00:00.000Z", status: "success" },
      { source: "gsc/query", reportDate: "2026-08-31", collectedAt: "2026-09-05T10:00:00.000Z", status: "success" },
    ] });
  });
  it("the newest error cannot borrow an older success or erase history", async () => {
    await insert(
      ["old", "query", "2026-09-03", "2026-09-04T10:00:00.000Z"],
      ["new", "query", "2026-09-04", "2026-09-05T10:00:00.000Z", "error"],
    );
    const result = await readRecommendationSources(fixture.call, "nosh.example", NOW);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.status).toBe("error");
    expect(await storedRuns()).toBe(2);
  });
  it("equal-time attempts use the stable latest insertion and preserve unchanged", async () => {
    await insert(
      ["first", "query", "2026-09-03", "2026-09-05T10:00:00.000Z"],
      ["second", "query", "2026-09-04", "2026-09-05T10:00:00.000Z", "unchanged"],
    );
    expect((await readRecommendationSources(fixture.call, "nosh.example", NOW)).reports[0]?.status).toBe("unchanged");
  });
  it("empty read is distinct from a failed read and does not leak DB details", async () => {
    expect(await readRecommendationSources(fixture.call, "nosh.example", NOW)).toEqual({ available: true, truncated: false, reports: [], since });
    expect(await readRecommendationSources(failingStore(), "nosh.example", NOW)).toEqual({ available: false, truncated: false, reports: [], since });
  });
  it("discloses the bounded family inventory", async () => {
    await insert(...Array.from({ length: 201 }, (_, n) => [`row-${n}`, `family-${n}`, "2026-09-04", "2026-09-05T10:00:00.000Z"] as [string, string, string, string]));
    const result = await readRecommendationSources(fixture.call, "nosh.example", NOW);
    expect(result.truncated).toBe(true);
    expect(result.reports).toHaveLength(200);
  });
  it("an invalid clock is unavailable before deriving a date or querying the store", async () => {
    for (const nowMs of [NaN, Infinity, -Infinity, 1e20]) {
      let reads = 0;
      const result = await readRecommendationSources(failingStore(() => { reads++; }), "nosh.example", nowMs);
      expect(result).toEqual({ available: false, truncated: false, reports: [] });
      expect(reads).toBe(0);
    }
  });
  it("retains old history without presenting attempts outside the disclosed lookback", async () => {
    await insert(["old", "query", "2024-01-01", "2024-01-02T10:00:00.000Z"]);
    expect(await readRecommendationSources(fixture.call, "nosh.example", NOW)).toEqual({ available: true, truncated: false, reports: [], since });
    expect(await storedRuns()).toBe(1);
  });
});
