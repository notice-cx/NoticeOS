import type { DailyMeasureLandmarks, DailyMeasureSeries } from "@/components/viz/daily-measure";
import type { SourceHistoryHeadline, SourceHistoryRow } from "@/components/viz/source-history";

const dates = Array.from({ length: 14 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
const days = [80, 100, 160, 110, 90, null, 95, 70, 60, 50, 45, 40, 35, 20].map((v, index) => ({
  t: dates[index]!, v, missing: index === 5 || index === 6 ? ["Search"] : [],
}));

/** Synthetic evidence includes a partial day, a missing day and an unfinished tail. */
export const DAILY_MEASURE_DEMO: DailyMeasureSeries = {
  key: "specimen", name: "Search clicks a day", days, unit: "clicks",
  provisionalFrom: dates[13]!, format: String, axis: String, sources: ["Search", "Bing"],
  usual: { value: 100, label: "Prior 14 days · 100 / day" },
  normal: { low: 75, high: 125 },
  alert: { severity: "warn", since: dates[8]!, onset: dates[8]!, headline: "Search clicks below normal" },
  gaps: [
    { start: dates[5]!, end: dates[5]!, days: 1, who: "Search", partial: false },
    { start: dates[6]!, end: dates[6]!, days: 1, who: "Search", partial: true },
  ],
};

export const DAILY_MEASURE_LANDMARKS: DailyMeasureLandmarks = { best: days[2]!, worst: days[12]!, newest: days[12]! };
export const SOURCE_HISTORY_DOMAIN = dates;
export const SOURCE_HISTORY_NOW = Date.parse("2026-09-15T12:00:00Z");
const row = (id: string, state: SourceHistoryRow["state"]): SourceHistoryRow => ({
  id, name: id, label: `${id} daily reports`, state, stateLabel: null,
  since: "2026-09-13T12:00:00Z", through: dates[11]!,
  summary: `${id}, Sep 1 to Sep 14: reported 8 of 12 days; missed Sep 6–7`,
  days: dates.map((t, index) => ({ t, state: index < 2 ? "before" : index === 5 || index === 6 ? "missed" : index > 11 ? "late" : index === 11 ? "counting" : "reported" })),
});
export const SOURCE_HISTORY_ROWS: SourceHistoryRow[] = [
  row("Search", "failing"), row("Analytics", "overdue"), row("Revenue", null),
  { ...row("Uptime", "working"), days: null, summary: "Uptime: no daily record" },
];
export const SOURCE_HISTORY_HEADLINE: SourceHistoryHeadline = { tone: "error", text: "Search failing · 2d" };
