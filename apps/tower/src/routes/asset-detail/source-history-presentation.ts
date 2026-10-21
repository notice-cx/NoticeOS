import { CONNECTION_LABELS } from "@shared/connection-status";
import { ageMs, formatAge } from "@shared/freshness";
import { dateRange, formatSeriesDate } from "@/lib/format";
import type { SourceHistoryHeadline } from "@/components/viz/source-history";
import type { SourceDays } from "./overview-measures";

const range = (dates: readonly string[]) => dateRange(dates[0]!, dates.at(-1)!);

/** A row in words, for a reader who cannot see its cells. */
export function sourceHistoryRowSummary(row: SourceDays): string {
  if (!row.days) return `${row.label}: no daily record`;
  const owed = row.days.filter((day) => day.state !== "before");
  const reported = owed.filter((day) => day.state === "reported" || day.state === "counting").length;
  const missed = row.days.filter((day) => day.state === "missed").map((day) => day.t);
  return [
    `${row.label}, ${formatSeriesDate(row.days[0]!.t)} to ${formatSeriesDate(row.days.at(-1)!.t)}: reported ${reported} of ${owed.length} days`,
    missed.length > 0 ? `missed ${range(missed)}` : null,
    row.state ? CONNECTION_LABELS[row.state].toLowerCase() : null,
  ].filter(Boolean).join("; ");
}

/** The one thing the strip leads with: a source failing or late now, else
 * the longest hole in the window, else that every source delivered. */
export function sourceHistoryHeadline(rows: readonly SourceDays[], nowMs: number): SourceHistoryHeadline | null {
  const now = rows.find((row) => row.state === "failing") ?? rows.find((row) => row.state === "overdue");
  if (now) {
    const age = ageMs(nowMs, now.since);
    return {
      tone: now.state === "failing" ? "error" : "warn",
      text: `${now.name} ${CONNECTION_LABELS[now.state!].toLowerCase()}${age === null ? "" : ` · ${formatAge(age)}`}`,
    };
  }
  const holes = rows
    .map((row) => ({ row, missed: (row.days ?? []).filter((day) => day.state === "missed").map((day) => day.t) }))
    .filter(({ missed }) => missed.length > 0)
    .sort((a, b) => b.missed.length - a.missed.length);
  const worst = holes[0];
  if (worst) {
    const count = worst.missed.length;
    return { tone: "gap", text: `${worst.row.name} missed ${count} ${count === 1 ? "day" : "days"} · ${range(worst.missed)}` };
  }
  return rows.some((row) => row.days) ? { tone: "clear", text: "Every source reported every day" } : null;
}
