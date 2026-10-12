import { Check, CircleAlert, Clock3, Minus } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { localDate, runWeekTally, type JobRunRow, type JobRunWeek, type RunDay, type RunDayState } from "@/lib/health-job-runs";
import { cn } from "@/lib/utils";

/** Each day's mark. Calm by default: a day that ran recedes to a quiet slot so
 * a failure is the one thing coloured; a missed day is the warn ink; a day the
 * read did not keep is hatched, never a blank that reads as "did not run". */
const TILE: Record<RunDayState, string> = {
  ran: "bg-muted/50 text-healthy/70",
  failed: "bg-error text-error-foreground",
  skipped: "border border-border text-muted-foreground",
  missed: "border border-warn/45 bg-warn-soft text-warn",
  none: "text-muted-foreground",
  "not-kept": "viz-hatch border border-border/60 text-muted-foreground/60",
};

const WORD: Record<RunDayState, string> = {
  ran: "ran",
  failed: "failed",
  skipped: "skipped",
  missed: "missed",
  none: "nothing due",
  "not-kept": "older runs not kept",
};

/** The legend: the five marks a reader has to tell apart. */
const LEGEND: readonly RunDayState[] = ["ran", "failed", "skipped", "missed", "not-kept"];

function dayHeading(date: string, today: string): string {
  if (date === today) return "Today";
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "short" })} ${day}`;
}

function dayWords(date: string, today: string): string {
  return date === today ? "today" : formatSeriesDate(date);
}

/** The day's runs in words, for its tooltip and its accessible name. */
function daySentence(row: JobRunRow, day: RunDay, today: string): string {
  const counts = [
    day.ran ? `${formatInt(day.ran)} ran` : null,
    day.failed ? `${formatInt(day.failed)} failed` : null,
    day.skipped ? `${formatInt(day.skipped)} skipped` : null,
  ].filter(Boolean);
  const what = counts.length > 0 ? counts.join(", ") : day.state === "missed" ? "no run, one was due" : WORD[day.state];
  return [row.label, dayWords(day.date, today), what, day.partial ? "earlier runs that day not kept" : null].filter(Boolean).join(" · ");
}

/**
 * Every System job's last seven days as one grid: a row per job, a column per
 * day ending today, each cell the day's runs by outcome. The newest failure is
 * named over it and lit where it sits; a press on a cell opens that day's run.
 */
export function JobRunGrid({ week, nowMs, state }: { week: JobRunWeek | null; nowMs: number; state: "ready" | "loading" | "unavailable" }) {
  const titleId = useId();
  const today = localDate(nowMs);
  const tally = week ? runWeekTally(week) : null;
  const truncated = week?.rows.some((row) => row.truncated) ?? false;

  return (
    <section aria-labelledby={titleId} data-job-runs="" className="@container grid gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1.5">
          <h2 id={titleId} className={cn("m-0", eyebrowClass)}>
            Scheduled jobs · last 7 days
          </h2>
          {week && tally ? <Headline tally={tally} today={today} /> : null}
          {tally && tally.runs > 0 ? (
            <p className="m-0 text-xs tabular-nums text-muted-foreground" data-job-runs-tally="">
              {formatInt(tally.runs)} {tally.runs === 1 ? "run" : "runs"}
              {tally.failed > 0 ? ` · ${formatInt(tally.failed)} failed` : ""}
              {tally.missed > 0 ? ` · ${formatInt(tally.missed)} missed ${tally.missed === 1 ? "day" : "days"}` : ""}
            </p>
          ) : null}
        </div>
        <Link to="/health/operations" className="text-xs font-medium whitespace-nowrap text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
          Background operations →
        </Link>
      </div>

      {!week || week.rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground" data-job-runs-empty={state}>
          {state === "loading" ? "Reading run history…" : state === "unavailable" ? "Run history could not be read" : "No scheduled jobs on this installation"}
        </p>
      ) : (
        <div role="table" aria-label={`Scheduled jobs, ${formatSeriesDate(week.days[0]!)} to ${formatSeriesDate(week.days.at(-1)!)}`} className="grid gap-y-1">
          <div role="row" className="grid items-end gap-x-3 @lg:grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)]">
            <span role="columnheader" className="hidden @lg:block">
              <span className="sr-only">Job</span>
            </span>
            <span className="grid grid-cols-7 gap-1 @lg:gap-1.5">
              {week.days.map((date) => (
                <span
                  key={date}
                  role="columnheader"
                  className={cn("text-center text-micro font-medium whitespace-nowrap tabular-nums", date === today ? "text-foreground" : "text-muted-foreground")}
                >
                  {dayHeading(date, today)}
                </span>
              ))}
            </span>
          </div>
          {week.rows.map((row, index) => (
            <JobRow key={row.id} row={row} today={today} index={index} />
          ))}
          {/* The week's first and last day again under the last row, so a row
              far from the header is still placed in time. */}
          <div aria-hidden className="grid gap-x-3 @lg:grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)]" data-job-runs-dates="">
            <span className="hidden @lg:block" />
            <span className="flex justify-between text-micro whitespace-nowrap tabular-nums text-muted-foreground">
              <time dateTime={week.days[0]}>{formatSeriesDate(week.days[0]!)}</time>
              <time dateTime={week.days.at(-1)}>{formatSeriesDate(week.days.at(-1)!)}</time>
            </span>
          </div>
        </div>
      )}

      {week && week.rows.length > 0 ? (
        <ul aria-hidden className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
          {LEGEND.filter((state) => state !== "not-kept" || truncated).map((state) => (
            <li key={state} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className={cn("grid size-4 place-items-center rounded-[4px] [&_svg]:size-2.5", TILE[state])}>
                <DayMark day={{ date: "", state, ran: 1, failed: 1, skipped: 1, runId: null, today: false, partial: false }} runs={1} />
              </span>
              {WORD[state]}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Headline({ tally, today }: { tally: ReturnType<typeof runWeekTally>; today: string }) {
  const lead = tally.latestFailure;
  if (lead) {
    const more = tally.failedDays - 1;
    return (
      <p data-job-runs-headline="failed" className="m-0 flex min-w-0 items-start gap-2 text-base font-semibold text-foreground @2xl:text-lg">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-error @2xl:mt-1" strokeWidth={2.5} aria-hidden />
        <span className="min-w-0">
          <Link to={lead.day.runId ? `${lead.row.href}?run=${encodeURIComponent(lead.day.runId)}` : lead.row.href} className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {lead.row.label} failed <span className="whitespace-nowrap">{dayWords(lead.day.date, today)}</span>
          </Link>
          {more > 0 ? <span className="ms-2 text-sm font-normal whitespace-nowrap text-muted-foreground">and {more} more failed {more === 1 ? "day" : "days"}</span> : null}
        </span>
      </p>
    );
  }
  if (tally.missed > 0) {
    return (
      <p data-job-runs-headline="missed" className="m-0 flex items-center gap-1.5 text-base font-semibold text-foreground">
        <Clock3 className="size-4 shrink-0 text-warn" strokeWidth={2.5} aria-hidden />
        {tally.missed} {tally.missed === 1 ? "day" : "days"} without a due run
      </p>
    );
  }
  if (tally.runs === 0) return null;
  return (
    <p data-job-runs-headline="clear" className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">
      <Check className="size-4 text-healthy" strokeWidth={2.75} aria-hidden />
      Nothing failed or missed
    </p>
  );
}

function JobRow({ row, today, index }: { row: JobRunRow; today: string; index: number }) {
  return (
    <div
      role="row"
      data-job-row={row.id}
      className="viz-arrive grid items-center gap-x-3 gap-y-1 rounded-lg py-1 @lg:grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)]"
      style={{ "--viz-i": index } as CSSProperties}
    >
      <span role="rowheader" className="flex min-w-0 items-baseline gap-2 @lg:flex-col @lg:items-start @lg:gap-0">
        <Link to={row.href} title={row.label} className="min-w-0 break-words text-sm font-medium text-foreground hover:underline">
          {row.label}
        </Link>
        <span className="text-micro text-muted-foreground">
          {row.paused ? "Paused" : row.schedule}
        </span>
      </span>
      <span className="grid grid-cols-7 gap-1 @lg:gap-1.5">
        {row.days.map((day) => (
          <DayCell key={day.date} row={row} day={day} today={today} />
        ))}
      </span>
    </div>
  );
}

function DayCell({ row, day, today }: { row: JobRunRow; day: RunDay; today: string }) {
  const sentence = daySentence(row, day, today);
  const runs = day.ran + day.failed + day.skipped;
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex h-7 w-full items-center justify-center gap-0.5 rounded-md text-micro font-medium tabular-nums @lg:h-8",
          TILE[day.state],
          day.partial && "border-l-2 border-dashed border-l-muted-foreground/60",
        )}
      >
        <DayMark day={day} runs={runs} />
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-60 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs text-card-foreground shadow-lg group-hover/cell:block group-focus-visible/cell:block"
      >
        {sentence}
      </span>
    </>
  );
  const frame = "group/cell relative block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <span role="cell" data-job-day={`${row.id}:${day.date}`} data-state={day.state} className="min-w-0">
      {day.runId ? (
        <Link to={`${row.href}?run=${encodeURIComponent(day.runId)}`} aria-label={sentence} className={frame}>
          {body}
        </Link>
      ) : (
        <span role="img" aria-label={sentence} tabIndex={0} className={frame}>
          {body}
        </span>
      )}
    </span>
  );
}

/** What the cell prints: a failure's count (or its glyph when there was one
 * run), a busy day's run count, a glyph for a skipped or missed day. */
function DayMark({ day, runs }: { day: RunDay; runs: number }) {
  switch (day.state) {
    case "failed":
      return runs > 1 ? <span>{formatInt(day.failed)}</span> : <CircleAlert className="size-3.5" strokeWidth={2.5} />;
    case "ran":
      return runs > 1 ? <span className="text-muted-foreground">{formatInt(runs)}</span> : <Check className="size-3.5" strokeWidth={2.75} />;
    case "skipped":
      return <Minus className="size-3.5" strokeWidth={2.5} />;
    case "missed":
      return <Clock3 className="size-3.5" strokeWidth={2.5} />;
    case "none":
      return <span className="size-1 rounded-full bg-muted-foreground/40" />;
    case "not-kept":
      return null;
  }
}
