import {
  CODEBASE_COMPARISON_TARGET_DAYS,
  CODEBASE_MEASURES,
  daysBetween,
  pickComparisonReport,
  type CodebaseDuplicate,
  type CodebaseComplexFunction,
  type CodebaseHistoryPoint,
  type CodebaseLanguage,
  type CodebaseReport,
  type CodebaseMeasureKey,
  type CodebaseMeasures,
  type CodebaseSlice,
  type CodebaseUnusedItem,
} from "@shared/codebase";
import { shiftLabel, type SurfaceAnnotation } from "@shared/surface";
import type { SeriesPoint, SignalTrend } from "@shared/wall";
import { formatInt, formatPercent, formatSeriesDate } from "@/lib/format";
import { metricWindow } from "@/routes/asset-detail/overview-metrics";

/**
 * The Codebase tab's derivations, read once from the site's reports: each
 * widget's figure, its 30-day change and its daily line; why a figure is
 * missing; the one-sentence answer that sets the code's growth beside its
 * visitors; and the findings as tasks. A report holds the code as it was at
 * one commit, so between two reports a line carries the earlier report's
 * value and every such day says which report it came from.
 */

/** The window every change on the tab is measured over. */
export const CHANGE_DAYS = CODEBASE_COMPARISON_TARGET_DAYS;

export const CODEBASE_RANGES = [30, 90] as const;
export type CodebaseRange = (typeof CODEBASE_RANGES)[number];

/** The first seven characters of a commit: what a person can match in git. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

const MEANING = new Map(CODEBASE_MEASURES.map((spec) => [spec.key, spec]));

function specOf(key: CodebaseMeasureKey) {
  return MEANING.get(key)!;
}

// --- the widgets ----------------------------------------------------------------

export type WidgetKey = "size" | "repeated" | "unused" | "complex" | "tests" | "build" | "testRun" | "vulnerable";

/** `code`: the five figures counted from the files. `checks`: the three the
 * site's own workflow sends from its build, test and package-audit steps. */
export type WidgetStrip = "code" | "checks";

/** Which way is good for the figure; `none` colours nothing. */
export type Improvement = "up" | "down" | "none";

/** `pass`: 1 is passed, 0 is failed. */
export type WidgetUnit = "count" | "percent" | "ratio" | "pass";

interface WidgetSpec {
  key: WidgetKey;
  strip: WidgetStrip;
  label: string;
  /** The tooltip: one plain sentence on what it is and why it matters. */
  meaning: string;
  unit: WidgetUnit;
  improvement: Improvement;
  /** The measures the figure is made of, for the reason it is missing. */
  keys: readonly CodebaseMeasureKey[];
  /** The figure from one report's measures, or null when unmeasured. */
  pick: (measures: CodebaseMeasures) => number | null;
  /** Words after the figure: "1.0× the code". */
  note?: string;
}

const measure = (key: CodebaseMeasureKey) => (measures: CodebaseMeasures) => measures[key] ?? null;

const UNUSED_KEYS = ["unused_files", "unused_exports", "unused_dependencies"] as const;

/** Unused files, shared pieces and packages added together: whichever of the three
 * the report measured. None measured is unmeasured, never zero. */
function unusedTotal(measures: CodebaseMeasures): number | null {
  const parts = UNUSED_KEYS.map((key) => measures[key]).filter((value): value is number => value !== undefined);
  return parts.length === 0 ? null : parts.reduce((sum, value) => sum + value, 0);
}

export const WIDGETS: readonly WidgetSpec[] = [
  {
    key: "size", strip: "code", label: specOf("code_lines").label,
    meaning: "Code without comments or tests. More code is more to fix.",
    unit: "count", improvement: "none", keys: ["code_lines"], pick: measure("code_lines"),
  },
  {
    key: "repeated", strip: "code", label: specOf("duplication_percent").label,
    meaning: "Code copied in more than one place. Each copy needs fixing.",
    unit: "percent", improvement: "down", keys: ["duplication_percent"], pick: measure("duplication_percent"),
  },
  {
    key: "unused", strip: "code", label: "Unused code",
    meaning: "Files, shared pieces and packages nothing uses. Each still needs upkeep.",
    unit: "count", improvement: "down", keys: UNUSED_KEYS, pick: unusedTotal,
  },
  {
    key: "complex", strip: "code", label: specOf("complex_functions").label,
    meaning: "So many branches that one change can break another.",
    unit: "count", improvement: "down", keys: ["complex_functions"], pick: measure("complex_functions"),
  },
  {
    key: "tests", strip: "code", label: specOf("test_ratio").label,
    meaning: "Test lines compared with code lines. Tests catch mistakes early.",
    unit: "ratio", improvement: "up", keys: ["test_ratio"], pick: measure("test_ratio"), note: "the code",
  },
  {
    key: "build", strip: "checks", label: specOf("build_passed").label,
    meaning: "Whether the code built without errors last time. A failed build cannot be released.",
    unit: "pass", improvement: "up", keys: ["build_passed"], pick: measure("build_passed"),
  },
  {
    key: "testRun", strip: "checks", label: specOf("tests_passed").label,
    meaning: "Whether every test passed last time. A failed test is a mistake caught before visitors see it.",
    unit: "pass", improvement: "up", keys: ["tests_passed"], pick: measure("tests_passed"),
  },
  {
    key: "vulnerable", strip: "checks", label: specOf("vulnerable_dependencies").label,
    meaning: "Outside packages with a publicly known security flaw. Updating a package usually removes it.",
    unit: "count", improvement: "down", keys: ["vulnerable_dependencies"], pick: measure("vulnerable_dependencies"),
  },
];

/** A ratio has no ceiling (more test lines than code lines is 1.2×), so it
 * reads as a multiple rather than a percent that passes 100. */
export function formatFigure(unit: WidgetUnit, value: number): string {
  if (unit === "pass") return value >= 1 ? "Passed" : "Failed";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "ratio") return `${value.toFixed(1)}×`;
  return formatInt(value);
}

/** What "Not measured" says beside it when the report gives no reason. */
export const UNMEASURED_FALLBACK = "Not in the latest report.";

/**
 * Why a figure is missing: the report's own sentence for the first of its
 * measures it did not measure (`unmeasured`), else the generic one.
 */
export function unmeasuredReason(
  keys: readonly CodebaseMeasureKey[],
  report: Pick<CodebaseReport, "measures" | "unmeasured"> | null,
): string {
  for (const key of keys) {
    if (report?.measures[key] !== undefined) continue;
    const said = report?.unmeasured[key];
    if (said) return said;
  }
  return UNMEASURED_FALLBACK;
}

export interface MeasureChange {
  /** The comparison report's date and figure. */
  from: { date: string; value: number };
  to: { date: string; value: number };
  /** Days between the two reports. */
  days: number;
  change: number;
  /** Relative change; null when the earlier figure is zero. */
  percent: number | null;
}

/** The report a change is measured from: the one nearest 30 days before
 * `latest` that measured the figure, 28 to 45 days back, a tie going to the
 * older; the same choice the codebase alert rules make. */
export function baselineReport(
  history: readonly CodebaseHistoryPoint[],
  latest: string,
  pick: (measures: CodebaseMeasures) => number | null,
): CodebaseHistoryPoint | null {
  const measured = history
    .filter((point) => pick(point.measures) !== null)
    .map((point) => ({ reportDate: point.date, point }));
  return pickComparisonReport(latest, measured)?.point ?? null;
}

/** The newest report's figure against the comparison report's, or null when
 * either has none. */
export function measureChange(
  history: readonly CodebaseHistoryPoint[],
  pick: (measures: CodebaseMeasures) => number | null,
): MeasureChange | null {
  const latest = history.at(-1);
  if (!latest) return null;
  const now = pick(latest.measures);
  const base = baselineReport(history, latest.date, pick);
  const then = base ? pick(base.measures) : null;
  if (now === null || base === null || then === null) return null;
  const change = now - then;
  return {
    from: { date: base.date, value: then },
    to: { date: latest.date, value: now },
    days: daysBetween(base.date, latest.date),
    change,
    percent: then === 0 ? null : (change / then) * 100,
  };
}

/** The change as a chip prints it: a count in percent, a share in points. */
export function changeText(unit: WidgetUnit, change: MeasureChange): string {
  if (unit === "pass") return `${formatFigure(unit, change.from.value)} → ${formatFigure(unit, change.to.value)}`;
  if (unit === "percent") return `${formatPercent(Math.abs(change.change))} pts`;
  if (unit === "ratio") return `${Math.abs(change.change).toFixed(1)}×`;
  return change.percent === null ? formatInt(Math.abs(change.change)) : `${formatPercent(Math.abs(change.percent))}%`;
}

/** What the change compares, in words: "vs Sep 14, 31 days before". */
export function changeAgainst(change: MeasureChange): string {
  return `vs ${formatSeriesDate(change.from.date)}, ${change.days} days before`;
}

/** One calendar day of a widget's or the chart's line. */
export interface AlignedDay {
  t: string;
  /** null: before the first report, after the last, or unmeasured that day. */
  v: number | null;
  /** The report the value came from, when it is not that day's own. */
  from: string | null;
  commit: string | null;
}

/**
 * Every day from `end - days + 1` to `end`, each with the figure of the
 * newest report on or before it. A day after the last report has no value: a
 * line that stops there is how a late report shows. A report that did not
 * measure the figure ends the carried value.
 */
export function alignedSeries(
  history: readonly CodebaseHistoryPoint[],
  pick: (measures: CodebaseMeasures) => number | null,
  end: string,
  days: number,
): AlignedDay[] {
  const last = history.at(-1)?.date ?? null;
  const out: AlignedDay[] = [];
  let at = 0;
  let current: CodebaseHistoryPoint | null = null;
  const start = shiftLabel(end, -(days - 1));
  for (let day = start; day <= end; day = shiftLabel(day, 1)) {
    while (at < history.length && history[at]!.date <= day) current = history[at++]!;
    const value = current && last !== null && day <= last ? pick(current.measures) : null;
    out.push({
      t: day,
      v: value,
      from: value !== null && current && current.date !== day ? current.date : null,
      commit: value !== null && current ? current.commit : null,
    });
  }
  return out;
}

/** The days that have a value, as a chart series. */
export function seriesOf(days: readonly AlignedDay[]): SeriesPoint[] {
  return days.flatMap((day) => (day.v === null ? [] : [{ t: day.t, v: day.v }]));
}

/** What a chart's readout says about each day beside its value: the commit,
 * and which report a carried day came from. */
export function dayNotes(days: readonly AlignedDay[]): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const day of days) {
    if (day.commit === null) continue;
    notes[day.t] = day.from === null
      ? `Commit ${shortCommit(day.commit)}`
      : `Measured ${formatSeriesDate(day.from)} · commit ${shortCommit(day.commit)}`;
  }
  return notes;
}

export interface CodebaseWidget {
  key: WidgetKey;
  strip: WidgetStrip;
  label: string;
  meaning: string;
  unit: WidgetUnit;
  improvement: Improvement;
  /** The newest report's figure; null is "Not measured". */
  value: number | null;
  /** Why there is no figure. */
  unmeasured: string | null;
  note: string | null;
  change: MeasureChange | null;
  /** The last 90 days, one point a day, for the widget's line. */
  spark: SeriesPoint[];
  /** A pass or fail figure's record over the newest report's 30 days; null for any other unit. */
  passes: PassRecord | null;
}

export interface PassRecord {
  passed: number;
  /** Reports in the window that sent a result. */
  measured: number;
  days: number;
}

/** How many of the reports in the `CHANGE_DAYS` up to the newest one passed:
 * a pass or fail has no size to compare a month back, so the tab counts. */
export function passRecord(
  history: readonly CodebaseHistoryPoint[],
  pick: (measures: CodebaseMeasures) => number | null,
): PassRecord | null {
  const latest = history.at(-1);
  if (!latest) return null;
  const from = shiftLabel(latest.date, -(CHANGE_DAYS - 1));
  const results = history.filter((point) => point.date >= from).map((point) => pick(point.measures)).filter((value): value is number => value !== null);
  if (results.length === 0) return null;
  return { passed: results.filter((value) => value >= 1).length, measured: results.length, days: CHANGE_DAYS };
}

/** "4 of 5 reports passed in 30 days". */
export function passText(record: PassRecord): string {
  return `${formatInt(record.passed)} of ${formatInt(record.measured)} ${record.measured === 1 ? "report" : "reports"} passed in ${record.days} days`;
}

export function codebaseWidgets(slice: CodebaseSlice): CodebaseWidget[] {
  const latest = slice.latest;
  const end = slice.history.at(-1)?.date ?? latest?.date ?? null;
  return WIDGETS.map((spec) => {
    const value = latest ? spec.pick(latest.report.measures) : null;
    return {
      key: spec.key,
      strip: spec.strip,
      label: spec.label,
      meaning: spec.meaning,
      unit: spec.unit,
      improvement: spec.improvement,
      value,
      unmeasured: value === null ? unmeasuredReason(spec.keys, latest?.report ?? null) : null,
      note: spec.note ?? null,
      change: measureChange(slice.history, spec.pick),
      spark: end === null ? [] : seriesOf(alignedSeries(slice.history, spec.pick, end, 90)),
      passes: spec.unit === "pass" ? passRecord(slice.history, spec.pick) : null,
    };
  });
}

/** What the unused figure counts: only the parts the report measured. */
export function unusedParts(measures: CodebaseMeasures): string | null {
  const nouns: Record<(typeof UNUSED_KEYS)[number], [string, string]> = {
    unused_files: ["file", "files"],
    unused_exports: ["shared piece", "shared pieces"],
    unused_dependencies: ["package", "packages"],
  };
  const parts = UNUSED_KEYS.flatMap((key) => {
    const value = measures[key];
    return value === undefined ? [] : [`${formatInt(value)} ${nouns[key][value === 1 ? 0 : 1]}`];
  });
  return parts.length === 0 ? null : parts.join(", ");
}

// --- the answer ----------------------------------------------------------------

/** Visitors a day over the last `CHANGE_DAYS` against the days before, the
 * Overview's own derivation; null when the two windows cannot be compared. */
export function visitorsChange(activeUsers: SignalTrend): number | null {
  if (activeUsers.series.length === 0) return null;
  const delta = metricWindow([activeUsers], CHANGE_DAYS, "mean").delta;
  return delta && delta.comparable && delta.percent !== null ? delta.percent : null;
}

function moved(percent: number, up: string, down: string): string {
  if (percent === 0) return "";
  const size = Math.abs(percent) < 1 ? "under 1%" : `${formatPercent(Math.abs(percent))}%`;
  return `${percent > 0 ? up : down} ${size}`;
}

export interface CodebaseAnswer {
  answer: string;
  detail: string | null;
}

/**
 * The tab's one sentence. With a comparison report: how much the code grew
 * or shrank between the two reports, beside how visitors moved over the same
 * thirty days when they can be compared. Without one: the size alone.
 */
export function codebaseAnswer(slice: CodebaseSlice, visitorsPercent: number | null): CodebaseAnswer {
  const latest = slice.latest;
  if (!latest) return { answer: "The code has not been measured yet.", detail: null };
  const lines = latest.report.measures.code_lines;
  const measured = `Measured ${formatSeriesDate(latest.date)} · commit ${shortCommit(latest.report.repository.commit)}`;
  if (lines === undefined) return { answer: "The latest report has no line count.", detail: measured };
  const change = measureChange(slice.history, measure("code_lines"));
  if (!change || change.to.date !== latest.date) {
    return { answer: `The code has ${formatInt(lines)} lines.`, detail: `${measured} · no report from a month before yet` };
  }
  const code = change.change === 0
    ? `The code is unchanged in ${change.days} days`
    : change.percent === null
      ? `The code grew ${formatInt(change.change)} lines in ${change.days} days`
      : `The code ${moved(change.percent, "grew", "shrank")} in ${change.days} days`;
  const visitors = visitorsPercent === null
    ? ""
    : visitorsPercent === 0 ? " while visitors stayed the same" : ` while visitors ${moved(visitorsPercent, "grew", "fell")}`;
  return {
    answer: `${code}${visitors}.`,
    detail: `${formatInt(change.from.value)} → ${formatInt(change.to.value)} lines · ${measured}`,
  };
}

// --- the chart -----------------------------------------------------------------

/** Days whose report was made by different tool versions than the report
 * before it: a step on such a day may be the tools, not the code. */
export function toolChanges(history: readonly CodebaseHistoryPoint[]): SurfaceAnnotation[] {
  const marks: SurfaceAnnotation[] = [];
  for (let index = 1; index < history.length; index++) {
    const before = history[index - 1]!.tools;
    const after = history[index]!.tools;
    const changed = (["scc", "jscpd", "lizard"] as const).filter((tool) => before[tool] !== after[tool]);
    if (changed.length === 0) continue;
    marks.push({
      date: history[index]!.date,
      glyph: "◆",
      label: "Measuring tools updated",
      detail: `The measuring tools changed here: ${changed.map((tool) => `${tool} ${before[tool] || "?"} → ${after[tool] || "?"}`).join(", ")}.`,
    });
  }
  return marks;
}

// --- languages -------------------------------------------------------------------

export interface LanguageShare {
  name: string;
  lines: number;
  /** 0..1 of the code lines the report lists by language. */
  share: number;
}

/** The languages with the most code, the rest added together as "Other". */
export function languageShares(byLanguage: readonly CodebaseLanguage[], shown = 5): LanguageShare[] {
  const sorted = [...byLanguage].filter((one) => one.code_lines > 0).sort((a, b) => b.code_lines - a.code_lines);
  const total = sorted.reduce((sum, one) => sum + one.code_lines, 0);
  if (total === 0) return [];
  const head = sorted.slice(0, shown).map((one) => ({ name: one.language, lines: one.code_lines, share: one.code_lines / total }));
  const rest = sorted.slice(shown).reduce((sum, one) => sum + one.code_lines, 0);
  return rest > 0 ? [...head, { name: "Other", lines: rest, share: rest / total }] : head;
}

// --- findings as tasks -------------------------------------------------------------

/** Two files by name, more by count. */
export function duplicateFiles(duplicate: CodebaseDuplicate): string {
  const paths = [...new Set(duplicate.files.map((file) => file.path))];
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  return `${paths[0]} and ${paths.length - 1} other files`;
}

export function duplicateTaskTitle(duplicate: CodebaseDuplicate): string {
  return `Merge the repeated code in ${duplicateFiles(duplicate)}`;
}

export function complexTaskTitle(fn: CodebaseComplexFunction): string {
  return `Simplify ${fn.name} in ${fn.path}`;
}

export function vulnerableTaskTitle(count: number, site: string): string {
  return `Fix ${formatInt(count)} vulnerable ${count === 1 ? "package" : "packages"} in ${site}`;
}

export function unusedTaskTitle(item: CodebaseUnusedItem): string {
  if (item.kind === "file") return `Remove the unused file ${item.path}`;
  if (item.kind === "export") return `Remove the unused ${item.name} from ${item.path}`;
  return `Remove the unused package ${item.name}`;
}

/** The line every task filed from a finding carries: where it was found. */
export function findingSource(slice: CodebaseSlice): string {
  const latest = slice.latest;
  if (!latest) return "";
  return `Found by the codebase report of ${formatSeriesDate(latest.date)}, commit ${shortCommit(latest.report.repository.commit)}.`;
}

// --- sending the first report ---------------------------------------------------

/** The repository secret the workflow reads the site's report token from. */
export const TOKEN_SECRET = "NOTICEOS_ASSET_TOKEN";

/**
 * The repository secret the workflow reads the installation's ingest address
 * from. The Tower's own address does not receive reports: the ingest answers
 * `POST /api/pulse` and `POST /api/codebase-report` at an address of its own,
 * and a standalone installation answers them only on its app container's
 * loopback, so this page cannot fill the address in.
 */
export const INGEST_SECRET = "NOTICEOS_INGEST_URL";

/** The workflow file, filled in for one site: on every push to main, every
 * Monday, and on demand. The full history is checked out because the report
 * counts the last 30 days of changes. */
export function actionWorkflow(asset: string): string {
  // The action's inputs by their names in its action.yml.
  const inputs: [string, string][] = [
    ["asset", JSON.stringify(asset)],
    ["ingest-url", "${{ secrets." + INGEST_SECRET + " }}"],
    ["token", "${{ secrets." + TOKEN_SECRET + " }}"],
  ];
  return [
    "name: Codebase report",
    "on:",
    "  push:",
    "    branches: [main]",
    "  schedule:",
    "    - cron: \"17 4 * * 1\"",
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  codebase-report:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: notice-cx/NoticeOS/.github/actions/codebase-report@main",
    "        with:",
    ...inputs.map(([name, value]) => `          ${name}: ${value}`),
    "",
  ].join("\n");
}

/** The command that measures a folder on this machine and sends the report. */
export function localCommand(asset: string): string {
  return `pnpm os:codebase-report -- --asset ${asset} --repo /path/to/your/code`;
}
