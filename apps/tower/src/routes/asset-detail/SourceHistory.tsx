import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, Clock3 } from "lucide-react";
import { CONNECTION_LABELS } from "@shared/connection-status";
import { ageMs, formatAge } from "@shared/freshness";
import type { HealthState } from "@/components/viz/HealthGrid";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dateRange, type SourceDayState, type SourceDays } from "@/routes/asset-detail/overview-measures";

// Each data source on the site, one cell per day over the last thirty days.
// Home's grid says whether a source works now; this says whether it delivered
// every day, so a three-day hole last week is as visible as a failure today.
// Delivered days recede; a missed day is hatched in the failure's ink; a
// source that is late now owes its last days in its own state's ink.

const STATE_INK: Partial<Record<HealthState, string>> = {
  working: "text-healthy",
  collecting: "text-healthy",
  failing: "text-error",
  overdue: "text-warn",
};

const STATE_GLYPH: Partial<Record<HealthState, typeof Check>> = {
  working: Check,
  collecting: CircleDashed,
  failing: CircleAlert,
  overdue: Clock3,
};

function cellClass(state: SourceDayState, row: HealthState | null, lit: boolean): string {
  switch (state) {
    case "reported":
      return lit ? "bg-muted-foreground/70" : "bg-muted-foreground/30";
    case "counting":
      return "border border-muted-foreground/60";
    case "missed":
      return "viz-hatch border border-error/60 text-error";
    case "late":
      return row === "failing" ? "bg-error" : row === "overdue" ? "bg-warn" : "border border-dashed border-muted-foreground/45";
    case "before":
      return "bg-viz-track";
  }
}

const DAY_WORDS: Record<SourceDayState, string> = {
  reported: "reported",
  counting: "still counting",
  missed: "not reported",
  late: "not in yet",
  before: "before this source began",
};

function dayWords(row: SourceDays, state: SourceDayState): string {
  if (state === "late" && (row.state === "failing" || row.state === "overdue")) return "not reported";
  return DAY_WORDS[state];
}

const range = (dates: readonly string[]) => dateRange(dates[0]!, dates.at(-1)!);

/** A row in words, for a reader who cannot see its cells. */
function rowSummary(row: SourceDays): string {
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

interface Headline {
  tone: "error" | "warn" | "clear" | "gap";
  text: string;
}

/** The one thing the strip leads with: a source failing or late now, else
 * the longest hole in the window, else that every source delivered. */
function headlineOf(rows: readonly SourceDays[], nowMs: number): Headline | null {
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

export interface SourceHistoryProps {
  rows: readonly SourceDays[];
  notConnected: readonly string[];
  domain: readonly string[];
  nowMs: number;
  /** The header's one link out. */
  action?: ReactNode;
  className?: string;
}

export function SourceHistory({ rows, notConnected, domain, nowMs, action, className }: SourceHistoryProps) {
  const titleId = useId();
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const headline = headlineOf(rows, nowMs);
  const length = domain.length;
  const daily = rows.map((row, r) => ({ row, r })).filter(({ row }) => row.days !== null);
  const undaily = rows.filter((row) => row.days === null);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setActive(null);
    const at = active ?? { r: daily[0]?.r ?? 0, c: length - 1 };
    const index = Math.max(0, daily.findIndex(({ r }) => r === at.r));
    if (event.key === "Home") return setActive({ r: at.r, c: 0 });
    if (event.key === "End") return setActive({ r: at.r, c: length - 1 });
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      return setActive({ r: at.r, c: Math.max(0, Math.min(length - 1, at.c + (event.key === "ArrowLeft" ? -1 : 1))) });
    }
    const next = daily[Math.max(0, Math.min(daily.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)))];
    if (next) setActive({ r: next.r, c: at.c });
  };

  return (
    <section aria-labelledby={titleId} data-source-history="" className={cn("@container flex min-w-0 flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-border/70", className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="grid min-w-0 gap-1.5">
          <h2 id={titleId} className={cn("m-0", eyebrowClass)}>Data sources · last {length} days</h2>
          {headline ? (
            <div data-source-history-headline={headline.tone} className="flex min-w-0 items-start gap-2 text-sm font-semibold text-foreground">
              {headline.tone === "clear" ? (
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-healthy" strokeWidth={2.75} />
              ) : headline.tone === "warn" ? (
                <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2.5} />
              ) : (
                <CircleAlert aria-hidden className={cn("mt-0.5 size-4 shrink-0", headline.tone === "error" ? "text-error" : "text-error/70")} strokeWidth={2.5} />
              )}
              <span className="min-w-0">{headline.text}</span>
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>

      {rows.length === 0 ? (
        <span className="text-sm text-muted-foreground">No data source in use yet</span>
      ) : null}
      {daily.length > 0 ? (
        <div
          role="group"
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-keys`}
          tabIndex={0}
          onKeyDown={move}
          onFocus={(event) => { if (event.target === event.currentTarget) setActive((current) => current ?? { r: daily[0]!.r, c: length - 1 }); }}
          onBlur={() => setActive(null)}
          className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring @xl:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto]"
        >
          {daily.map(({ row, r }) => (
            <div key={row.id} data-source-row={row.id} data-state={row.state ?? "derived"} className="col-span-full grid grid-cols-subgrid items-center">
              <span title={row.label} className="truncate text-xs font-medium text-foreground">{row.name}</span>
              <div role="img" aria-label={rowSummary(row)} className="relative grid h-4 gap-[2px]" style={{ gridTemplateColumns: `repeat(${length}, minmax(0,1fr))` }}
                onPointerLeave={() => setActive(null)}>
                {row.days!.map((day, c) => (
                  <span key={day.t} aria-hidden data-source-day={day.t} data-state={day.state}
                    onPointerEnter={() => setActive({ r, c })}
                    className={cn("h-full rounded-[2px]", cellClass(day.state, row.state, active?.r === r && active.c === c))} />
                ))}
                {active?.r === r && row.days![active.c] ? (
                  <span role="status" className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-56 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground shadow-sm"
                    style={{ left: `${Math.min(80, Math.max(20, ((active.c + 0.5) / length) * 100))}%` }}>
                    <span className="font-medium">{row.label}</span> · {formatSeriesDate(row.days![active.c]!.t)} · {dayWords(row, row.days![active.c]!.state)}
                  </span>
                ) : null}
              </div>
              <StateNow row={row} nowMs={nowMs} />
            </div>
          ))}
          <span aria-hidden />
          <span aria-hidden className="flex justify-between text-micro tabular-nums text-muted-foreground">
            <time dateTime={domain[0]!}>{formatSeriesDate(domain[0]!)}</time>
            <time dateTime={domain.at(-1)!}>{formatSeriesDate(domain.at(-1)!)}</time>
          </span>
          <span aria-hidden />
        </div>
      ) : null}

      <div id={`${titleId}-keys`} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-muted-foreground">
        {daily.length > 0 ? (
          <>
            <Key className="bg-muted-foreground/30">reported</Key>
            <Key className="viz-hatch border border-error/60 text-error">not reported</Key>
            <Key className="border border-dashed border-muted-foreground/45">not in yet</Key>
          </>
        ) : null}
        {/* Sources this read holds no day-by-day record for keep their state
            now, on one line, rather than a row of nothing each. */}
        {undaily.length > 0 ? (
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1" data-source-undaily="">
            <span>No daily record:</span>
            {undaily.map((row) => (
              <span key={row.id} data-source-row={row.id} data-state={row.state ?? "derived"} className="inline-flex items-center gap-1 whitespace-nowrap">
                <span title={row.label} className="text-foreground">{row.name}</span>
                <StateNow row={row} nowMs={nowMs} compact />
              </span>
            ))}
          </span>
        ) : null}
        {notConnected.length > 0 ? <span className="whitespace-nowrap">Not connected: {notConnected.join(" · ")}</span> : null}
      </div>
    </section>
  );
}

/** A source's state now: quiet while it works, in its own ink when it fails
 * or is late, with how long. */
function StateNow({ row, nowMs, compact = false }: { row: SourceDays; nowMs: number; compact?: boolean }) {
  if (!row.state) {
    return row.through ? <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">through {formatSeriesDate(row.through)}</span> : null;
  }
  const Glyph = STATE_GLYPH[row.state];
  const age = row.state === "failing" || row.state === "overdue" ? ageMs(nowMs, row.since) : null;
  const words = `${row.stateLabel ?? CONNECTION_LABELS[row.state]}${age !== null ? ` ${formatAge(age)}` : ""}`;
  const trouble = row.state === "failing" || row.state === "overdue";
  return (
    <span className={cn("inline-flex items-center justify-end gap-1 whitespace-nowrap tabular-nums", compact ? "text-micro" : "text-xs", trouble ? STATE_INK[row.state] : "text-muted-foreground")}>
      {Glyph ? <Glyph aria-hidden className={cn("size-3.5 shrink-0", trouble ? undefined : STATE_INK[row.state])} strokeWidth={2.5} /> : null}
      {compact && !trouble ? <span className="sr-only">{words}</span> : (
        <>
          <span className={trouble ? undefined : "hidden @md:inline"}>{words}</span>
          {trouble ? null : <span className="sr-only @md:hidden">{words}</span>}
        </>
      )}
    </span>
  );
}

function Key({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cn("size-2.5 rounded-[2px]", className)} />
      {children}
    </span>
  );
}
