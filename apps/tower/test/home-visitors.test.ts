import { describe, expect, it } from "vitest";
import type { SignalTrend } from "@shared/wall";
import { assetContributors } from "@/lib/asset-contributors";
import { peopleInLast28Days } from "@/lib/home-brief";

const site = (id: string, series: SignalTrend["series"], provisionalFrom: string | null = null, contextSeries: SignalTrend["series"] = []) => ({
  id, displayName: id,
  activeUsers: { series, contextSeries, provisionalFrom, collectedAt: null, timeZoneChanges: [] },
});

describe("Home's last 28 days of visitors", () => {
  it("bounds calendar days, fills gaps, includes context and late sites, and excludes provisional readings", () => {
    const result = peopleInLast28Days([
      site("a.example", [{ t: "2026-10-28", v: 10 }, { t: "2026-10-29", v: 999 }], "2026-10-29", [{ t: "2026-09-30", v: 999 }, { t: "2026-10-01", v: 3 }]),
      site("b.example", [{ t: "2026-10-01", v: 5 }, { t: "2026-10-27", v: 0 }]),
    ])!;
    expect(result.total).toBe(18);
    expect(result.date).toBe("2026-10-28");
    expect(result.series).toHaveLength(28);
    expect(result.series[0]).toEqual({ t: "2026-10-01", v: 8, contributions: { "a.example": 3, "b.example": 5 } });
    expect(result.series[1]).toEqual({ t: "2026-10-02", v: null, contributions: {} });
    expect(result.series.at(-2)).toEqual({ t: "2026-10-27", v: 0, contributions: { "b.example": 0 } });
    expect(result.partial).toEqual(["2026-10-27", "2026-10-28"]);
  });

  it("distinguishes a measured zero from no settled data", () => {
    expect(peopleInLast28Days([])).toBeNull();
    expect(peopleInLast28Days([site("a.example", [{ t: "2026-10-28", v: 5 }], "2026-10-28")])).toBeNull();
    expect(peopleInLast28Days([site("a.example", [{ t: "2026-10-28", v: 0 }])])?.total).toBe(0);
  });

  it("keeps asset colours independent of input order and contribution rank", () => {
    const assets = [site("b.example", []), site("a.example", [])];
    expect(assetContributors(assets)).toEqual(assetContributors([...assets].reverse()));
    expect(new Set(assetContributors(assets).map((source) => source.tone)).size).toBe(2);
  });
});
