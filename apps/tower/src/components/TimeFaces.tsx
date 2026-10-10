import { CalendarDays } from "lucide-react";
import type { ReactNode } from "react";
import type { JsonValue } from "@shared/changeset";
import type { CountdownConfig } from "@shared/dashboard";
import { countdownParts, countdownProximity } from "@/lib/countdown";
import { cn } from "@/lib/utils";

// The countdown's face and nothing that edits it; `CountdownWidget`
// (DashboardWidgets.tsx) wraps it with its Configure button and form.

function deadline(value: JsonValue): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return "Invalid date";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

/** The countdown as it is configured. This file imports nothing that saves. */
export function CountdownFace({
  config,
  nowMs,
  className,
  action,
  editor,
}: {
  config: CountdownConfig;
  nowMs: number;
  /** Placement from the page that owns it. */
  className?: string;
  /** The desk's header control, in place of the read-only "Countdown" word. */
  action?: ReactNode;
  /** The desk's settings form, drawn under the measures while it is open. */
  editor?: ReactNode;
}) {
  const { emoji, label, targetAt } = config;
  const remaining = countdownParts(nowMs, targetAt);
  const proximity = countdownProximity(nowMs, targetAt);
  const units = ([
    ["Months", remaining.months],
    ["Days", remaining.days],
    ["Hours", remaining.hours],
    ["Minutes", remaining.minutes],
  ] as const).filter(([, value]) => value > 0);

  const body = (
    <>
      <div className="flex flex-row items-center justify-between gap-3 pb-1.5">
        <h2 className="min-w-0 break-words text-base font-semibold text-foreground">
          {label}
        </h2>
        {action ?? (
          <span className="shrink-0 text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
            Countdown
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <div
          className={cn(
            "grid min-h-0 grid-rows-[6rem_auto] grid-cols-[minmax(5.5rem,0.85fr)_minmax(0,3.15fr)] items-stretch gap-x-2 gap-y-2 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,3fr)] sm:gap-x-3",
          )}
          data-countdown-layout
        >
          <div
            className="row-span-2 row-start-1 flex items-center justify-center overflow-hidden"
            data-countdown-emoji
          >
            <span
              className="select-none text-[clamp(5rem,20vw,8rem)] leading-none"
              role="img"
              aria-label={`Countdown symbol: ${emoji}`}
            >
              {emoji}
            </span>
          </div>
          <div
            className="col-start-2 row-start-1 flex h-full min-w-0 items-stretch gap-1.5 sm:gap-2"
            aria-label="Time remaining"
            data-countdown-measures
          >
            {remaining.complete ? (
              // Wears the band rather than a fixed tint: a target that has
              // passed comes back gray and unfilled, while a target we could
              // not parse stays hot, because that one is still broken.
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center px-4 text-center font-mono text-4xl font-bold uppercase tracking-wide md:text-5xl",
                  proximity.valueClassName,
                  proximity.surfaceClassName,
                )}
                data-countdown-reached
              >
                Reached
              </div>
            ) : units.length === 0 ? (
              <div
                className="flex min-w-0 flex-1 flex-col items-center justify-center bg-error-soft px-4 text-center text-error"
                data-countdown-primary
              >
                <span className="font-mono text-5xl font-bold leading-none tabular-nums" data-countdown-value>
                  &lt;1
                </span>
                <span className="mt-2 text-wall-label font-semibold uppercase tracking-widest">
                  Minute
                </span>
              </div>
            ) : (
              units.map(([unit, value], index) => {
                const primary = index === 0;
                const fineMeasure = unit === "Hours" || unit === "Minutes";
                return (
                  <div
                    key={unit}
                    className={cn(
                      "relative isolate flex h-full min-w-0 flex-col justify-center overflow-hidden text-center",
                      primary
                        ? "flex-[1.75]"
                        : fineMeasure
                          ? "flex-[0.72] border-l border-border/60"
                          : "flex-1 border-l border-border/60",
                      primary ? proximity.surfaceClassName : null,
                    )}
                    data-countdown-unit={unit.toLowerCase()}
                    data-countdown-primary={primary ? "true" : undefined}
                  >
                    <div
                      className={cn(
                        "px-1 font-mono font-bold leading-none tabular-nums",
                        primary
                          ? "text-5xl md:text-6xl"
                          : fineMeasure
                            ? "text-2xl text-muted-foreground md:text-3xl"
                            : "text-3xl text-foreground/80 md:text-4xl",
                        primary ? proximity.valueClassName : null,
                      )}
                      data-countdown-value
                    >
                      {String(value)}
                    </div>
                    <div
                      className={`mt-1 px-1 font-semibold uppercase text-muted-foreground ${
                        primary
                          ? "text-wall-label tracking-[0.15em]"
                          : "text-wall-axis tracking-[0.12em]"
                      }`}
                    >
                      {fineMeasure ? (
                        <>
                          <span className="sm:hidden" aria-hidden>
                            {unit === "Hours" ? "HR" : "MIN"}
                          </span>
                          <span className="sr-only sm:not-sr-only">{unit}</span>
                        </>
                      ) : (
                        unit
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div
            className="col-start-2 row-start-2 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
            data-countdown-target
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              {remaining.complete ? "Reached" : "Target"}
            </span>
            <time dateTime={targetAt} className="min-w-0 text-foreground">
              {deadline(targetAt)}
            </time>
          </div>
        </div>

        {editor}
      </div>
    </>
  );
  return (
    <section
      aria-label={`Countdown: ${label}`}
      className={cn(
        "flex h-full min-w-0 flex-col justify-center overflow-hidden",
        className,
      )}
      data-widget-shell="frameless"
      data-proximity={proximity.id}
    >
      {body}
    </section>
  );
}
