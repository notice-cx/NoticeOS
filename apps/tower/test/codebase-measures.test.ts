import { describe, expect, it } from "vitest";
import type { CodebaseHistoryPoint, CodebaseSlice } from "@shared/codebase";
import { shiftLabel } from "@shared/surface";
import {
  actionWorkflow,
  alignedSeries,
  baselineReport,
  changeAgainst,
  changeText,
  codebaseAnswer,
  codebaseWidgets,
  dayNotes,
  formatFigure,
  duplicateFiles,
  duplicateTaskTitle,
  languageShares,
  localCommand,
  measureChange,
  toolChanges,
  unmeasuredReason,
  unusedParts,
  unusedTaskTitle,
  UNMEASURED_FALLBACK,
  visitorsChange,
} from "@/routes/asset-detail/codebase-measures";
import { CODEBASE_TOOLS, codebaseReport, codebaseSlice, commitOf, dayBefore, weeklyHistory } from "./codebase-fixture";

/**
 * The Codebase tab's numbers as data: which report a change is measured from,
 * how a line carries between reports, why a figure is missing, and the one
 * sentence the tab opens with. The tab's own suite checks how they are drawn.
 */

const TODAY = "2026-07-05";
const ASSET = "meadow.example";

const point = (date: string, measures: CodebaseHistoryPoint["measures"], n = 1): CodebaseHistoryPoint => ({
  date, commit: commitOf(n), ref: "main", generatedAt: `${date}T03:00:00.000Z`, measures, tools: CODEBASE_TOOLS,
});

const trend = (series: { t: string; v: number }[]) => ({ series, provisionalFrom: null, collectedAt: null, timeZoneChanges: [] });

/** Visitors a day over 60 days: `prior` a day for the first 30, `recent` for the last 30. */
function visitors(prior: number, recent: number) {
  return trend(Array.from({ length: 60 }, (_, index) => ({ t: shiftLabel(TODAY, index - 59), v: index < 30 ? prior : recent })));
}

describe("the comparison report", () => {
  it("is the report nearest 30 days before the newest", () => {
    const history = weeklyHistory(TODAY);
    expect(baselineReport(history, TODAY, (m) => m.code_lines ?? null)?.date).toBe(dayBefore(TODAY, 28));
    const lumpy = [point(dayBefore(TODAY, 40), { code_lines: 1 }), point(dayBefore(TODAY, 31), { code_lines: 2 }), point(TODAY, { code_lines: 3 })];
    expect(baselineReport(lumpy, TODAY, (m) => m.code_lines ?? null)?.date).toBe(dayBefore(TODAY, 31));
  });

  it("is never nearer than 28 days or farther than 45, and a tie goes to the older report", () => {
    const pick = (m: CodebaseHistoryPoint["measures"]) => m.code_lines ?? null;
    expect(baselineReport([point(dayBefore(TODAY, 25), { code_lines: 1 }), point(TODAY, { code_lines: 2 })], TODAY, pick)).toBeNull();
    const tie = [point(dayBefore(TODAY, 32), { code_lines: 1 }), point(dayBefore(TODAY, 28), { code_lines: 2 }), point(TODAY, { code_lines: 3 })];
    expect(baselineReport(tie, TODAY, pick)?.date).toBe(dayBefore(TODAY, 32));
    expect(baselineReport([point(dayBefore(TODAY, 60), { code_lines: 1 }), point(TODAY, { code_lines: 2 })], TODAY, pick)).toBeNull();
  });

  it("skips a report that did not measure the figure", () => {
    const history = [point(dayBefore(TODAY, 30), {}), point(dayBefore(TODAY, 35), { duplication_percent: 3 })]
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(baselineReport([...history, point(TODAY, { duplication_percent: 4 })], TODAY, (m) => m.duplication_percent ?? null)?.date)
      .toBe(dayBefore(TODAY, 35));
  });
});

describe("a figure's 30-day change", () => {
  it("is the newest report against the comparison report, in percent for a count and points for a share", () => {
    const history = weeklyHistory(TODAY);
    const lines = measureChange(history, (m) => m.code_lines ?? null)!;
    expect(lines).toMatchObject({ from: { date: dayBefore(TODAY, 28), value: 45_810 }, to: { date: TODAY, value: 48_210 }, days: 28, change: 2_400 });
    expect(changeText("count", lines)).toBe("5.2%");
    expect(changeAgainst(lines)).toBe("vs Jun 7, 28 days before");

    const share = measureChange([point(dayBefore(TODAY, 30), { duplication_percent: 3.6, test_ratio: 0.2 }), point(TODAY, { duplication_percent: 4, test_ratio: 0.17 })], (m) => m.duplication_percent ?? null)!;
    expect(changeText("percent", share)).toBe("0.4 pts");
    const ratio = measureChange([point(dayBefore(TODAY, 30), { test_ratio: 0.9 }), point(TODAY, { test_ratio: 1.03 })], (m) => m.test_ratio ?? null)!;
    expect(changeText("ratio", ratio)).toBe("0.1×");
    expect(formatFigure("ratio", 1.03)).toBe("1.0×");
  });

  it("is a plain count when the earlier figure is zero", () => {
    const change = measureChange([point(dayBefore(TODAY, 30), { unused_files: 0 }), point(TODAY, { unused_files: 4 })], (m) => m.unused_files ?? null)!;
    expect(change.percent).toBeNull();
    expect(changeText("count", change)).toBe("4");
  });

  it("is absent with no comparison report or no figure in the newest", () => {
    expect(measureChange([point(TODAY, { code_lines: 10 })], (m) => m.code_lines ?? null)).toBeNull();
    expect(measureChange([point(dayBefore(TODAY, 30), { code_lines: 10 }), point(TODAY, {})], (m) => m.code_lines ?? null)).toBeNull();
    expect(measureChange([], (m) => m.code_lines ?? null)).toBeNull();
  });
});

describe("a line between reports", () => {
  it("carries each report's value until the next, says which report a carried day came from, and stops after the last", () => {
    const history = [point(dayBefore(TODAY, 4), { code_lines: 100 }, 1), point(dayBefore(TODAY, 2), { code_lines: 120 }, 2)];
    const days = alignedSeries(history, (m) => m.code_lines ?? null, TODAY, 6);
    expect(days.map((day) => day.v)).toEqual([null, 100, 100, 120, null, null]);
    expect(days[2]).toMatchObject({ from: dayBefore(TODAY, 4), commit: commitOf(1) });
    expect(days[3]).toMatchObject({ from: null, commit: commitOf(2) });
    expect(dayNotes(days)).toEqual({
      [dayBefore(TODAY, 4)]: "Commit 0001c0d",
      [dayBefore(TODAY, 3)]: "Measured Jul 1 · commit 0001c0d",
      [dayBefore(TODAY, 2)]: "Commit 0002c0d",
    });
  });

  it("carries a report from before the window into its first day", () => {
    const history = [point(dayBefore(TODAY, 40), { code_lines: 90 }), point(TODAY, { code_lines: 95 })];
    const days = alignedSeries(history, (m) => m.code_lines ?? null, TODAY, 30);
    expect(days[0]).toMatchObject({ v: 90, from: dayBefore(TODAY, 40) });
    expect(days.at(-1)).toMatchObject({ v: 95, from: null });
  });

  it("ends the carried value at a report that did not measure it", () => {
    const history = [point(dayBefore(TODAY, 3), { complex_functions: 5 }), point(dayBefore(TODAY, 1), {}), point(TODAY, { complex_functions: 6 })];
    expect(alignedSeries(history, (m) => m.complex_functions ?? null, TODAY, 4).map((day) => day.v)).toEqual([5, 5, null, 6]);
  });
});

describe("the unmeasured rule", () => {
  it("shows the report's own sentence for a measure it did not measure", () => {
    const report = { measures: {}, unmeasured: { unused_dependencies: "Unused packages are not measured yet." } };
    expect(unmeasuredReason(["unused_dependencies"], report)).toBe("Unused packages are not measured yet.");
  });

  it("falls back to a generic sentence when the report gives none", () => {
    expect(unmeasuredReason(["complex_functions"], { measures: {}, unmeasured: {} })).toBe(UNMEASURED_FALLBACK);
    expect(unmeasuredReason(["complex_functions"], null)).toBe(UNMEASURED_FALLBACK);
  });

  it("reads an absent measure as Not measured and never as zero; a zero stays a zero", () => {
    const report = codebaseReport(ASSET, TODAY, { code_lines: 900, duplication_percent: 0 });
    report.unmeasured = { unused_files: "Unused code is checked in JavaScript, TypeScript and Python only." };
    const slice: CodebaseSlice = { history: [point(TODAY, report.measures)], latest: { date: TODAY, revision: 1, receivedAt: `${TODAY}T03:00:00.000Z`, report } };
    const widgets = Object.fromEntries(codebaseWidgets(slice).map((widget) => [widget.key, widget]));
    expect(widgets.repeated).toMatchObject({ value: 0, unmeasured: null });
    expect(widgets.unused).toMatchObject({ value: null, unmeasured: "Unused code is checked in JavaScript, TypeScript and Python only." });
    expect(widgets.complex).toMatchObject({ value: null, unmeasured: UNMEASURED_FALLBACK });
    expect(widgets.tests).toMatchObject({ value: null });
  });

  it("adds up and names only the unused parts the report measured", () => {
    expect(unusedParts({ unused_files: 9, unused_exports: 28 })).toBe("9 files, 28 shared pieces");
    expect(unusedParts({ unused_files: 1, unused_exports: 1, unused_dependencies: 3 })).toBe("1 file, 1 shared piece, 3 packages");
    expect(unusedParts({})).toBeNull();
    const widgets = codebaseWidgets(codebaseSlice(ASSET, TODAY));
    expect(widgets.find((widget) => widget.key === "unused")?.value).toBe(53);
  });
});

describe("the five widgets", () => {
  it("each has its label, figure, change and a 90-day line, in reading order", () => {
    const widgets = codebaseWidgets(codebaseSlice(ASSET, TODAY));
    expect(widgets.map((widget) => widget.label)).toEqual([
      "Lines of code", "Repeated code", "Unused code", "Hard-to-change functions", "Test coverage by size",
    ]);
    expect(widgets[0]).toMatchObject({ value: 48_210, improvement: "none" });
    expect(widgets[4]).toMatchObject({ value: 1.03, note: "the code", meaning: "Test lines compared with code lines. Tests catch mistakes early." });
    expect(widgets[0]!.change?.change).toBe(2_400);
    expect(widgets[0]!.spark).toHaveLength(85);
    expect(widgets[0]!.spark.at(-1)).toEqual({ t: TODAY, v: 48_210 });
    expect(widgets[1]!.meaning).toBe("Code copied in more than one place. Each copy needs fixing.");
    expect(widgets[3]!.change?.change).toBe(4);
  });

  it("is all Not measured before the first report", () => {
    for (const widget of codebaseWidgets({ history: [], latest: null })) {
      expect(widget).toMatchObject({ value: null, change: null, spark: [] });
    }
  });
});

describe("the answer", () => {
  it("says the code has not been measured before the first report", () => {
    expect(codebaseAnswer({ history: [], latest: null }, null).answer).toBe("The code has not been measured yet.");
  });

  it("sets the code's growth beside visitors over the same 30 days", () => {
    const slice = codebaseSlice(ASSET, TODAY);
    const grew = visitorsChange(visitors(100, 103));
    expect(grew).toBeCloseTo(3);
    expect(codebaseAnswer(slice, grew)).toEqual({
      answer: "The code grew 5.2% in 28 days while visitors grew 3%.",
      detail: "45,810 → 48,210 lines · Measured Jul 5 · commit 0001c0d",
    });
    expect(codebaseAnswer(slice, visitorsChange(visitors(100, 88))).answer).toBe("The code grew 5.2% in 28 days while visitors fell 12%.");
    expect(codebaseAnswer(slice, 0.4).answer).toBe("The code grew 5.2% in 28 days while visitors grew under 1%.");
  });

  it("leaves visitors out when the site has none to compare", () => {
    expect(visitorsChange(trend([]))).toBeNull();
    expect(codebaseAnswer(codebaseSlice(ASSET, TODAY), null).answer).toBe("The code grew 5.2% in 28 days.");
  });

  it("says shrank, unchanged, or the size alone", () => {
    const at = (before: number, after: number): CodebaseSlice => {
      const report = codebaseReport(ASSET, TODAY, { code_lines: after });
      return { history: [point(dayBefore(TODAY, 30), { code_lines: before }), point(TODAY, { code_lines: after })], latest: { date: TODAY, revision: 1, receivedAt: `${TODAY}T03:00:00.000Z`, report } };
    };
    expect(codebaseAnswer(at(1000, 900), null).answer).toBe("The code shrank 10% in 30 days.");
    expect(codebaseAnswer(at(1000, 1000), null).answer).toBe("The code is unchanged in 30 days.");
    const once = codebaseSlice(ASSET, TODAY);
    once.history = once.history.slice(-1);
    expect(codebaseAnswer(once, 3)).toEqual({
      answer: "The code has 48,210 lines.",
      detail: "Measured Jul 5 · commit 0001c0d · no report from a month before yet",
    });
  });

  it("says when the newest report has no line count", () => {
    const slice = codebaseSlice(ASSET, TODAY);
    slice.latest!.report.measures = { duplication_percent: 4 };
    expect(codebaseAnswer(slice, null).answer).toBe("The latest report has no line count.");
  });

  it("stays under twelve words", () => {
    const answer = codebaseAnswer(codebaseSlice(ASSET, TODAY), 3).answer;
    expect(answer.split(/\s+/).length).toBeLessThan(12);
  });
});

describe("the chart, languages and findings", () => {
  it("marks a day the measuring tools changed", () => {
    const history = weeklyHistory(TODAY, 3);
    history[2] = { ...history[2]!, tools: { ...CODEBASE_TOOLS, jscpd: "5.4.0" } };
    expect(toolChanges(history)).toEqual([{
      date: TODAY, glyph: "◆", label: "Measuring tools updated",
      detail: "The measuring tools changed here: jscpd 5.3.2 → 5.4.0.",
    }]);
    expect(toolChanges(weeklyHistory(TODAY))).toEqual([]);
  });

  it("splits the code by language, the smallest added together as Other", () => {
    const shares = languageShares([
      { language: "A", files: 1, code_lines: 50 }, { language: "B", files: 1, code_lines: 30 },
      { language: "C", files: 1, code_lines: 15 }, { language: "D", files: 1, code_lines: 5 },
    ], 2);
    expect(shares).toEqual([
      { name: "A", lines: 50, share: 0.5 }, { name: "B", lines: 30, share: 0.3 }, { name: "Other", lines: 20, share: 0.2 },
    ]);
    expect(languageShares([])).toEqual([]);
  });

  it("titles a task after each finding", () => {
    const report = codebaseReport(ASSET, TODAY);
    expect(duplicateTaskTitle(report.findings.duplicates[0]!)).toBe("Merge the repeated code in src/a.ts and src/b.ts");
    expect(duplicateFiles(report.findings.duplicates[1]!)).toBe("src/c.ts and 2 other files");
    expect(report.findings.unused.map(unusedTaskTitle)).toEqual([
      "Remove the unused file src/old.ts",
      "Remove the unused helper from src/u.ts",
      "Remove the unused package left-pad",
    ]);
  });
});

describe("the first report", () => {
  it("fills the workflow file and the command with the site, and reads the address and token from secrets", () => {
    const workflow = actionWorkflow(ASSET);
    expect(workflow).toContain('asset: "meadow.example"');
    expect(workflow).toContain("ingest-url: ${{ secrets.NOTICEOS_INGEST_URL }}");
    expect(workflow).not.toContain("/api/codebase-report");
    expect(workflow).toContain("token: ${{ secrets.NOTICEOS_ASSET_TOKEN }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(localCommand(ASSET)).toBe("pnpm os:codebase-report -- --asset meadow.example --repo /path/to/your/code");
  });
});
