import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, CircleDot, Flame, Timer, Trophy, Zap } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { EmptyState } from "@/components/EmptyState";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Badge } from "@/components/ui/badge";
import { formatInt } from "@/lib/format";
import { evidenceParts, formatHours, type AgentEvent, type Trophy as Award, type Worker } from "@/lib/agent-work";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";

/** The page's panels share one frame: flat, on a hairline ring. */
export const PANEL = "flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70";

/** A task's page; a hosted board names its project. */
export type TaskHref = (task: { id: string; project: string }) => string;
export const taskHref = (projectSelection: boolean): TaskHref => (task) => taskPath(task.id, projectSelection ? task.project : undefined);

// --- each worker ----------------------------------------------------------------

/**
 * One ruled row per worker: what it holds now, its last seven days as a
 * strip with the total, how long its work takes from claim to close, and what
 * it holds blocked. Agents first, busiest first.
 */
export function WorkerRows({ workers, nowMs, href }: { workers: readonly Worker[]; nowMs: number; href: TaskHref }) {
  const ceiling = Math.max(1, ...workers.flatMap((worker) => worker.days));
  return (
    <section aria-label="Who's working" data-agent-rows="" className={PANEL}>
      <h2 className={cn("m-0", eyebrowClass)}>Who's working</h2>
      {workers.length === 0 ? <EmptyState size="sm" title="Nobody has claimed a task yet" /> : (
        <div className="@container/rows flex flex-col">
          <div aria-hidden className="hidden gap-4 pb-2 text-micro font-semibold uppercase tracking-[0.06em] text-muted-foreground @2xl/rows:grid @2xl/rows:grid-cols-[minmax(8rem,1fr)_minmax(0,2.2fr)_9rem_5.5rem_4.5rem]">
            <span>Who</span><span>Working on now</span><span>Closed, 7 days</span><span>Claim to close</span><span className="text-right">Blocked</span>
          </div>
          {workers.map((worker) => {
            const first = worker.inHand[0];
            return (
              <div key={worker.id} data-agent-row={worker.id}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-t border-border/70 py-3 first-of-type:border-t-0 @2xl/rows:grid-cols-[minmax(8rem,1fr)_minmax(0,2.2fr)_9rem_5.5rem_4.5rem]">
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold text-foreground [overflow-wrap:anywhere]">{worker.name}</span>
                  <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{worker.models.length ? worker.models.join(" · ") : worker.agent ? "agent" : "no model named"}</span>
                </span>
                <span className="col-span-2 row-start-2 min-w-0 text-sm @2xl/rows:col-span-1 @2xl/rows:row-start-auto">
                  {first ? (
                    <>
                      <Link to={href(first)} className="font-medium text-foreground underline-offset-2 hover:underline [overflow-wrap:anywhere]">{first.title}</Link>
                      <span className="text-muted-foreground"> · {first.projectName}{first.claimedAt ? ` · ${formatAge(ageMs(nowMs, first.claimedAt))}` : ""}</span>
                      {worker.inHand.length > 1 ? <span className="text-muted-foreground"> · +{formatInt(worker.inHand.length - 1)} more</span> : null}
                    </>
                  ) : <span className="text-muted-foreground">Nothing in progress</span>}
                </span>
                <span className="col-start-2 row-start-1 flex items-center justify-end gap-2 @2xl/rows:col-start-auto @2xl/rows:row-start-auto @2xl/rows:justify-start">
                  <span className="text-figure-sm font-semibold tabular-nums text-foreground" data-agent-week={worker.week}>{formatInt(worker.week)}</span>
                  <DayTicks days={worker.days} ceiling={ceiling} label={`${worker.name}: closed a day, last 7 days`} />
                </span>
                <span className="hidden text-sm tabular-nums text-foreground @2xl/rows:inline">
                  {worker.medianHours === null ? <span className="text-muted-foreground">not yet</span> : formatHours(worker.medianHours)}
                </span>
                <span className={cn("hidden text-right text-sm tabular-nums @2xl/rows:inline", worker.blocked.length ? "font-semibold text-warn" : "text-muted-foreground")}>
                  {worker.blocked.length ? formatInt(worker.blocked.length) : "none"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Seven days of closes as a strip: yesterday in the win ink, today outlined while it counts. */
function DayTicks({ days, ceiling, label }: { days: readonly number[]; ceiling: number; label: string }) {
  return (
    <span role="img" aria-label={`${label}: ${days.join(", ")}`} className="flex h-6 w-[4.5rem] items-end gap-0.5 text-milestone">
      {days.map((count, index) => {
        const today = index === days.length - 1;
        return (
          <span key={index} aria-hidden className={cn("w-full rounded-t-[2px]",
            count === 0 ? "h-0.5 bg-muted-foreground/40" : today ? "outline-1 -outline-offset-1 outline-dashed outline-current" : index === days.length - 2 ? "bg-current" : "bg-spark/50")}
            style={count === 0 ? undefined : { height: `${Math.max(15, (count / ceiling) * 100)}%` }} />
        );
      })}
    </span>
  );
}

// --- the receipts ------------------------------------------------------------------

/** A close's evidence as it was given: the sentence, then its commit and links as chips. */
export function EvidenceChips({ reason }: { reason: string }) {
  const parts = evidenceParts(reason);
  const text = parts.filter((part) => part.kind === "text").map((part) => part.text).join(" · ");
  const pointers = parts.filter((part) => part.kind !== "text");
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-evidence="">
      {text ? <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{text}</span> : null}
      {pointers.map((part, index) => part.kind === "commit" ? (
        <Badge key={index} variant="outline" className="font-mono text-foreground" title="Commit" data-evidence-commit="">{part.text}</Badge>
      ) : part.href ? (
        <a key={index} href={part.href} target="_blank" rel="noreferrer noopener" className="text-xs font-medium text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]" data-evidence-link="">{part.text}</a>
      ) : (
        <Badge key={index} variant="outline" className="[overflow-wrap:anywhere]" data-evidence-link="">{part.text}</Badge>
      ))}
    </span>
  );
}

const PAGE = 12;

/** Claims and closes newest first, a day at a time; every close carries its evidence. */
export function AgentFeed({ events, nowMs, href }: { events: readonly AgentEvent[]; nowMs: number; href: TaskHref }) {
  const [shown, setShown] = useState(PAGE);
  const visible = events.slice(0, shown);
  const days = new Map<string, AgentEvent[]>();
  for (const event of visible) {
    const day = event.at.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  const dayName = (day: string) => day === today ? "Today" : day === yesterday ? "Yesterday"
    : new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <section aria-label="Claims and closes" data-agent-feed="" className={PANEL}>
      <h2 className={cn("m-0", eyebrowClass)}>Claims and closes</h2>
      {events.length === 0 ? <EmptyState size="sm" title="No claims or closes in the last 7 days" /> : (
        <div className="flex flex-col gap-3">
          {[...days.entries()].map(([day, list]) => (
            <div key={day} className="flex flex-col">
              <h3 className={cn("m-0 pb-1", eyebrowClass)}>{dayName(day)}</h3>
              <ol className="m-0 flex list-none flex-col p-0">
                {list.map((event) => (
                  <li key={`${event.kind}-${event.task.project}-${event.task.id}`} data-agent-event={event.kind}
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-border/50 py-2.5 first:border-t-0">
                    <span aria-hidden className="mt-0.5 grid size-6 place-items-center rounded-full bg-muted">
                      {event.kind === "closed" ? <Check className="size-3.5 text-milestone" /> : <CircleDot className="size-3.5 text-muted-foreground" />}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm [overflow-wrap:anywhere]">
                        <span className="font-semibold text-foreground">{event.who}</span>{" "}
                        <span className={event.kind === "closed" ? "font-medium text-milestone" : "text-muted-foreground"}>{event.kind}</span>{" "}
                        <Link to={href(event.task)} className="font-medium text-foreground underline-offset-2 hover:underline">{event.task.title}</Link>
                        <span className="text-muted-foreground"> · {event.task.projectName}{event.model ? ` · ${event.model}` : ""}</span>
                      </span>
                      {event.kind === "closed" && event.task.evidence ? <EvidenceChips reason={event.task.evidence} /> : null}
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatAge(ageMs(nowMs, event.at))}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {events.length > shown ? (
            <button type="button" onClick={() => setShown((count) => count + PAGE)} className="self-start text-sm font-medium text-foreground underline-offset-2 hover:underline">
              Show {formatInt(Math.min(PAGE, events.length - shown))} more
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

// --- the contest --------------------------------------------------------------------

const AWARD_ICON = { most: Trophy, fastest: Zap, streak: Flame, urgent: Timer } as const;

/** The last seven days' awards, one figure each. */
export function AgentTrophies({ trophies }: { trophies: readonly Award[] }) {
  return (
    <section aria-label="Leaders" data-agent-trophies="" className={PANEL}>
      <h2 className={cn("m-0", eyebrowClass)}>Leaders · last 7 days</h2>
      {trophies.length === 0 ? <EmptyState size="sm" title="No agent closed a task in the last 7 days" /> : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          {trophies.map((trophy, index) => {
            const Icon = AWARD_ICON[trophy.key];
            return (
              <div key={trophy.key} data-agent-trophy={trophy.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
                <span className={cn("flex items-center gap-1.5", eyebrowClass)}>
                  <Icon aria-hidden className={cn("size-3.5", index === 0 ? "text-milestone" : "text-muted-foreground")} />{trophy.award}
                </span>
                <span className="text-figure-sm font-semibold leading-none tabular-nums text-foreground">
                  {trophy.value}
                  {trophy.detail ? <span className="ms-1.5 text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{trophy.detail}</span> : null}
                </span>
                <span className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{trophy.holder}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
