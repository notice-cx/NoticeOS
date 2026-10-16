import { type ComponentType, type CSSProperties, type ReactNode } from "react";
import { Check, CircleDot, MessageSquare, Plus } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { AgentMark } from "@/components/AgentMark";
import { EventTimeline, type TimelineEvent } from "@/components/viz/EventTimeline";
import { agentMaker, evidenceParts } from "@/lib/agent-work";
import { cn } from "@/lib/utils";

// What happened to one task, and when: a strip on a time axis that ends at
// now (EventTimeline, one track), then the same moments as a column in time
// order, each with who did it, and the box for the next comment at the end.

export type TaskTimelineKind = "filed" | "claimed" | "comment" | "closed";

export interface TaskTimelineEntry {
  id: string;
  /** When it happened; an entry nobody dated is listed last and said so. */
  at: string | null;
  kind: TaskTimelineKind;
  /** Who did it, and the model they named. */
  who?: { name: string; model: string | null } | null;
  /** The line itself, e.g. "Claimed by claude · Opus 5.5". */
  label: ReactNode;
  /** The same line as plain words, for the strip's marks. */
  said: string;
  /** What was written: a comment's text, a close's reason. */
  body?: ReactNode;
  /** A close's reason, whose commits and links are drawn as chips. */
  evidence?: string | null;
}

export interface TaskTimelineProps {
  entries: readonly TaskTimelineEntry[];
  nowMs: number;
  /** The box for the next comment, drawn as the column's last item. */
  composer?: ReactNode;
  /** How a moment's time is written; the page passes its own, so an absent
   * or unreadable time reads the same everywhere on it. */
  age?: (at: string | null) => ReactNode;
  ariaLabel: string;
  className?: string;
}

const GLYPH: Record<TaskTimelineKind, ComponentType<{ className?: string }>> = {
  filed: Plus,
  claimed: CircleDot,
  comment: MessageSquare,
  closed: Check,
};

const STRIP_KIND: Record<TaskTimelineKind, TimelineEvent["kind"]> = {
  filed: "note",
  claimed: "note",
  comment: "note",
  // A close records what shipped, drawn as the strip's shipped mark; it is
  // never a resolved or healthy mark, because nothing is measured yet.
  closed: "shipped",
};

const HOUR = 3_600_000;

/** Dated entries in time order, then the undated ones in the order given. */
export function timelineOrder<T extends { at: string | null }>(entries: readonly T[]): T[] {
  const time = (entry: T) => (entry.at === null ? Number.NaN : Date.parse(entry.at));
  const dated = entries.filter((entry) => !Number.isNaN(time(entry))).sort((a, b) => time(a) - time(b));
  return [...dated, ...entries.filter((entry) => Number.isNaN(time(entry)))];
}

export function TaskTimeline({ entries, nowMs, composer, age, ariaLabel, className }: TaskTimelineProps) {
  const ordered = timelineOrder(entries);
  const dated = ordered.filter((entry) => entry.at !== null && !Number.isNaN(Date.parse(entry.at)));
  const first = dated[0] ? Date.parse(dated[0].at!) : null;
  // The window starts a little before the first moment, so its mark is not
  // drawn on the axis's edge, and ends at now.
  const span = first === null ? HOUR : Math.max(HOUR, nowMs - first);
  const from = first === null ? nowMs - HOUR : first - span * 0.04;
  const latest = dated.at(-1)?.id ?? null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-task-timeline="">
      {dated.length > 0 ? (
        <EventTimeline
          compact
          lanes={[{ id: "task", label: ariaLabel }]}
          events={dated.map((entry) => ({ id: entry.id, lane: "task", at: entry.at!, kind: STRIP_KIND[entry.kind], label: entry.said }))}
          window={{ from: new Date(from).toISOString(), to: new Date(nowMs).toISOString() }}
          nowMs={nowMs}
          ariaLabel={`${ariaLabel}, on a time axis`}
        />
      ) : null}
      <ol className="relative m-0 flex list-none flex-col p-0" data-task-activity="">
        {ordered.map((entry, index) => (
          <Entry key={entry.id} entry={entry} nowMs={nowMs} age={age} index={index} latest={entry.id === latest} last={index === ordered.length - 1 && !composer} />
        ))}
        {composer ? (
          <li className="relative flex gap-3" data-task-timeline-composer="">
            <span aria-hidden className="relative z-10 grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-border bg-card text-muted-foreground">
              <MessageSquare className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">{composer}</div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function Entry({ entry, nowMs, age, index, latest, last }: {
  entry: TaskTimelineEntry;
  nowMs: number;
  age?: (at: string | null) => ReactNode;
  index: number;
  latest: boolean;
  last: boolean;
}) {
  const Glyph = GLYPH[entry.kind];
  const maker = entry.who ? agentMaker(entry.who.name, [entry.who.model]) : null;
  const ms = ageMs(nowMs, entry.at);
  const pointers = entry.evidence ? evidenceParts(entry.evidence).filter((part) => part.kind !== "text") : [];
  return (
    <li
      className="viz-arrive relative flex gap-3 pb-4"
      style={{ "--viz-i": index } as CSSProperties}
      data-entry={entry.kind}
      data-entry-id={entry.id}
    >
      {/* The rail joining this moment to the next. */}
      {last ? null : <span aria-hidden className="absolute bottom-0 left-3.5 top-7 w-px -translate-x-1/2 bg-viz-grid" />}
      {entry.who && maker ? (
        <span className="relative z-10 shrink-0 self-start" data-entry-agent={maker}>
          <AgentMark name={entry.who.name} models={[entry.who.model]} />
          <span aria-hidden className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-muted-foreground text-background ring-2 ring-card">
            <Glyph className="size-2.5" />
          </span>
        </span>
      ) : (
        <span
          aria-hidden
          className={cn(
            "relative z-10 grid size-7 shrink-0 place-items-center rounded-full border border-border bg-muted text-muted-foreground",
            // The newest moment carries the halo the Wall gives now.
            latest && "ring-4 ring-foreground/10",
          )}
        >
          <Glyph className="size-3.5" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm text-foreground" data-entry-label="">{entry.label}</span>
          {age ? age(entry.at) : ms === null ? (
            <span className="text-xs text-muted-foreground" data-age={entry.at === null ? "missing" : "unreadable"}>
              at an unknown time
            </span>
          ) : (
            <time dateTime={entry.at ?? undefined} className="text-xs tabular-nums text-muted-foreground" data-age="aged">
              {formatAge(ms)} ago
            </time>
          )}
        </div>
        {entry.body ? (
          <div className={cn("min-w-0 text-sm", entry.kind === "comment" && "border-s-2 border-border ps-3")}>{entry.body}</div>
        ) : null}
        {pointers.length > 0 ? (
          <span className="flex flex-wrap gap-1.5" data-entry-evidence="">
            {pointers.map((part, i) =>
              part.href ? (
                <a key={i} href={part.href} target="_blank" rel="noreferrer noopener"
                  className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground underline-offset-4 hover:underline">
                  {part.text}
                </a>
              ) : (
                <span key={i} className={cn("rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground", part.kind === "commit" && "font-mono")}>
                  {part.text}
                </span>
              ),
            )}
          </span>
        ) : null}
      </div>
    </li>
  );
}
