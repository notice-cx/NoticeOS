// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  recommendationDate, recommendationValidity, recommendationHandoffCaveat, sharedValidity,
  type RecommendationContext, type RecommendationSourceReport, type RecommendationSubject,
} from "@shared/recommendation-validity";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const subject: RecommendationSubject = {
  kind: "finding", key: "search-opportunity",
  sources: [{ source: "bing-webmaster/queries", windowStart: "2026-07-25", windowEnd: "2026-07-31" }],
};
const report: RecommendationSourceReport = { source: "bing-webmaster/queries", reportDate: "2026-09-04", collectedAt: "2026-09-06T11:00:00Z", status: "success" };
function context(over: Partial<RecommendationContext> = {}): RecommendationContext {
  return { generatedAt: "2026-08-05T00:00:00Z", sources: { available: true, truncated: false, reports: [report] },
    handoffs: [], taskSnapshotAt: "2026-09-06T11:59:30Z", decisions: [], annotations: { items: [], olderCount: 0 }, ...over };
}
function withReport(over: Partial<RecommendationSourceReport>): RecommendationContext {
  return context({ sources: { available: true, truncated: false, reports: [{ ...report, ...over }] } });
}

describe("recommendation applicability is an evidence review, never a current verdict", () => {
  it("identifies an exact newer report family without declaring the old finding false", () => {
    const result = recommendationValidity(subject, context(), NOW);
    expect(result.state).toBe("newer-evidence");
    expect(result.sources).toEqual([{
      source: "bing-webmaster/queries", window: { start: "2026-07-25", end: "2026-07-31" },
      latest: { reportDate: "2026-09-04", collectedAt: "2026-09-06T11:00:00.000Z", status: "success" },
      newer: true, failedSinceAnalysis: false,
    }]);
    expect(result.evidenceThrough).toBe("2026-07-31");
  });
  it("does not lend another family or provider's new report to this finding", () => {
    for (const source of ["bing-webmaster/pages", "gsc/queries", "bing-webmaster"]) {
      const result = recommendationValidity(subject, withReport({ source }), NOW);
      expect(result.state).toBe("unverified");
      expect(result.sources[0]).toMatchObject({ source: "bing-webmaster/queries", latest: null, newer: false });
      expect(recommendationHandoffCaveat(result)).toContain("bing-webmaster/queries: analyzed 2026-07-25–2026-07-31; latest report unavailable.");
    }
  });
  it("does not count a recollected unchanged export predating analysis as a new report", () => {
    const result = recommendationValidity(subject, withReport({ reportDate: "2026-08-04", status: "unchanged" }), NOW);
    expect(result.state).toBe("unverified");
  });
  it("does not mistake same-day collection or report-window lag for unseen input", () => {
    expect(recommendationValidity(subject, withReport({ reportDate: "2026-08-05" }), NOW).state).toBe("unverified");
    expect(recommendationValidity(subject, withReport({ collectedAt: "2026-08-04T12:00:00Z", reportDate: "2026-08-04" }), NOW).state).toBe("unverified");
  });
  it("a later failure does not borrow success or refute the finding", () => {
    const result = recommendationValidity(subject, withReport({ status: "error" }), NOW);
    expect(result.state).toBe("unverified");
    expect(result.sources[0]).toMatchObject({ failedSinceAnalysis: true, newer: false, latest: { status: "error", reportDate: "2026-09-04" } });
    expect(recommendationHandoffCaveat(result)).toContain("latest report 2026-09-04 failed at");
  });
  it.each(["2026-09-07T00:00:00Z", "2026-09-05", "2026-02-30T12:00:00Z", "bad"])("rejects invalid/future collection timestamp %s", (collectedAt) => {
    expect(recommendationValidity(subject, withReport({ collectedAt }), NOW).state).toBe("unverified");
  });
  it.each(["2026-09-07", "2026-02-30", "2026-09-04T00:00:00Z", ""])("rejects invalid/future report date %s", (reportDate) => {
    expect(recommendationValidity(subject, withReport({ reportDate }), NOW).state).toBe("unverified");
  });
  it.each([null, "2026-08-05", "2026-02-30T12:00:00Z", "2027-01-01T00:00:00Z"])("does not infer validity without valid analysis instant %s", (generatedAt) => {
    const result = recommendationValidity(subject, context({ generatedAt }), NOW);
    expect(result.state).toBe("unverified");
    expect(result.generatedAt).toBeNull();
  });
  it("requires valid ordered item-specific windows", () => {
    const result = recommendationValidity({ ...subject, sources: [{ source: report.source, windowStart: "2026-08-01", windowEnd: "2026-07-31" }] }, context(), NOW);
    expect(result.state).toBe("unverified");
    expect(result.evidenceThrough).toBeNull();
  });
  it("does not treat a fresh replacement analysis as verified-current", () => {
    const result = recommendationValidity(subject, context({ generatedAt: "2026-09-06T11:30:00Z" }), NOW);
    expect(result.state).toBe("unverified");
    expect(result.label).toBe("Not rechecked");
    expect(recommendationHandoffCaveat(result)).toMatch(/Recheck the latest reports, linked work and the site before acting\.$/);
  });
  it("only labels replacement when an explicitly older analysis is supplied", () => {
    const result = recommendationValidity({ ...subject, generatedAt: "2026-07-31T23:00:00Z" }, context(), NOW);
    expect(result.state).toBe("replaced");
    expect(recommendationValidity(subject, context(), NOW).state).not.toBe("replaced");
  });
  it("unknown and truncated reads never establish no newer inputs or no linked work", () => {
    const result = recommendationValidity(subject, context({ sources: { available: false, truncated: true, reports: [] }, handoffs: null, taskSnapshotAt: null }), NOW);
    expect(result.state).toBe("unverified");
    expect(result.sourceList).toEqual({ available: false, truncated: true, since: null });
    expect(result.tasks).toEqual({ capturedAt: null, outdated: false, linked: [] });
    const caveat = recommendationHandoffCaveat(result);
    expect(caveat).toContain("Source report list: partial.");
    expect(caveat).toContain("Task snapshot: date unknown.");
  });
  it("invalid clocks fail closed", () => {
    expect(recommendationValidity(subject, context(), Number.NaN).state).toBe("unverified");
    expect(recommendationDate("2026-09-05", Number.NaN)).toBeNull();
  });
});

describe("linked work is recorded history, never a resolution inference", () => {
  const task = { kind: "finding" as const, key: subject.key, beadId: "ro-example", status: "closed" as const, closedAt: "2026-09-05T12:00:00Z" };
  const base = () => context({ sources: null, handoffs: [task] });
  it("flags a dated closure after analysis as a review, not solved or shipped", () => {
    const result = recommendationValidity(subject, base(), NOW);
    expect(result.state).toBe("linked-work");
    expect(result.tasks.linked).toEqual([{ beadId: "ro-example", status: "closed", closedAt: "2026-09-05T12:00:00.000Z", closedSinceAnalysis: true, releases: [] }]);
    expect(recommendationHandoffCaveat(result)).toContain("Review after linked work");
    expect(recommendationHandoffCaveat(result)).toContain("Task ro-example: closed 2026-09-05T12:00:00.000Z, after the analysis.");
  });
  it.each([null, "bad", "2026-07-30T12:00:00Z", "2026-09-07T12:00:00Z"])("undated/older/invalid closure %s does not supersede analysis", (closedAt) => {
    expect(recommendationValidity(subject, { ...base(), handoffs: [{ ...task, closedAt }] }, NOW).state).toBe("unverified");
  });
  it("does not claim a task status newer than the snapshot that supplied it", () => {
    expect(recommendationValidity(subject, { ...base(), taskSnapshotAt: "2026-08-05T01:00:00Z" }, NOW).state).toBe("unverified");
  });
  it("states outdated task snapshots even when they retain a known closure", () => {
    const result = recommendationValidity(subject, { ...base(), taskSnapshotAt: "2026-09-05T13:00:00Z" }, NOW);
    expect(result.state).toBe("linked-work");
    expect(result.tasks.outdated).toBe(true);
    expect(recommendationHandoffCaveat(result)).toContain("(outdated)");
  });
  it("matches kind and key exactly", () => {
    for (const handoffs of [[{ ...task, key: `${subject.key}-other` }], [{ ...task, kind: "query" as const }]]) {
      expect(recommendationValidity(subject, { ...base(), handoffs }, NOW).state).toBe("unverified");
    }
  });
  it("only an exact task reference makes a deploy relevant", () => {
    const ctx = { ...base(), handoffs: [{ ...task, status: "open" as const, closedAt: null }], annotations: { items: [{ id: 1, at: "2026-09-05T12:00:00Z", kind: "deploy" as const, ref: "ro-example", note: "Recorded release" }], olderCount: 0 } };
    const linked = recommendationValidity(subject, ctx, NOW);
    expect(linked.state).toBe("linked-work");
    expect(linked.tasks.linked[0]!.releases).toEqual(["2026-09-05T12:00:00.000Z"]);
    ctx.annotations.items[0]!.ref = "ro-other";
    ctx.annotations.items[0]!.note = "Mentions ro-example only in prose";
    expect(recommendationValidity(subject, ctx, NOW).state).toBe("unverified");
  });
  it("marking is not validation and dismissal is not successful work", () => {
    const decision = { kind: "finding" as const, key: subject.key, status: "marked" as const, decidedAt: "2026-09-05T10:00:00Z", updatedAt: "2026-09-05T10:00:00Z" };
    expect(recommendationValidity(subject, context({ sources: null, decisions: [decision] }), NOW).state).toBe("unverified");
    const result = recommendationValidity(subject, context({ decisions: [{ ...decision, status: "dismissed" }] }), NOW);
    expect(result.state).toBe("dismissed");
    expect(result.decision).toEqual({ status: "dismissed", at: "2026-09-05T10:00:00.000Z" });
  });
});

describe("a list says its shared applicability once", () => {
  it("returns the state most rows share, ties to the first row, and null when empty", () => {
    const newer = recommendationValidity(subject, context(), NOW);
    const plain = recommendationValidity(subject, withReport({ source: "gsc/other" }), NOW);
    expect(newer.state).toBe("newer-evidence");
    expect(plain.state).toBe("unverified");
    expect(sharedValidity([plain, newer, newer])?.state).toBe("newer-evidence");
    expect(sharedValidity([plain, newer])?.state).toBe("unverified");
    expect(sharedValidity([])).toBeNull();
  });
});
