import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { AgentMark } from "@/components/AgentMark";
import { PageHeader, type PageHeaderCrumb } from "@/components/PageHeader";
import { StateChip } from "@/components/StateChip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import type { InboxAsk } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { EpicProgress, type EpicSegment } from "./epic-tasks";
import { PriorityChip, TaskStatusChip, askFace, taskTypeWord } from "./task-face";

/** What a task page's header states, from whichever read the page has. */
export interface TaskHeadFacts {
  title: string;
  issueType: string;
  awaitType: string | null;
  status: string;
  priority: number;
  /** Who holds it, the model they named when they claimed it, and when. */
  holder: { name: string; model: string | null; since: string | null } | null;
  /** What the operator's inbox asks of it, or null. */
  ask: InboxAsk | null;
  /** An epic's closed of total. */
  progress: { closed: number; total: number; segments?: readonly EpicSegment[] } | null;
}

/**
 * The top of `/tasks/:id`, read in one look: where the item sits, what kind
 * of item it is and its id, the title, then its state, priority, holder,
 * progress and what it asks of the operator, with the actions beside it,
 * the primary one first. `children` sits under it: a closed task's reason, or
 * the form an action opened.
 */
export function TaskHead({
  id,
  facts,
  crumbs,
  actions,
  nowMs,
  children,
}: {
  id: string;
  /** Null while the first read is on its way. */
  facts: TaskHeadFacts | null;
  crumbs: PageHeaderCrumb[];
  actions?: ReactNode;
  nowMs: number;
  children?: ReactNode;
}) {
  const subject = `task:${id}` as const;
  const holderAge = facts?.holder ? ageMs(nowMs, facts.holder.since) : null;
  return (
    <PageHeader
      documentTitle={facts?.title ?? "Task"}
      breadcrumb={crumbs}
      eyebrow={
        <>
          <span className={eyebrowClass} data-task-type={facts?.issueType ?? ""}>
            {facts ? taskTypeWord(facts.issueType, facts.awaitType) : "Task"}
          </span>
          {/* The id is the string the operator quotes in a commit and types
              into a command, so it stays whole and in its own case. */}
          <span className="font-mono text-xs text-muted-foreground">{id}</span>
          {facts?.awaitType && facts.awaitType !== "human" ? (
            <span className="text-xs text-muted-foreground">waits on {facts.awaitType}</span>
          ) : null}
        </>
      }
      title={<span className="min-w-0 [overflow-wrap:anywhere]">{facts?.title ?? "Task"}</span>}
      meta={
        facts ? (
          <>
            <TaskStatusChip status={facts.status} subject={subject} />
            <PriorityChip priority={facts.priority} subject={subject} />
            {facts.ask ? (
              <StateChip
                tone="caution"
                subject={subject}
                glyph={<span className="text-[11px] font-bold leading-none">{askFace(facts).glyph}</span>}
                label={<span data-task-ask={facts.ask}>{facts.ask === "approve" ? "Needs your approval" : "Needs your answer"}</span>}
              />
            ) : null}
            {facts.holder ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-task-holder="">
                <AgentMark name={facts.holder.name} models={[facts.holder.model]} size="small" />
                <span className="font-medium text-foreground">{facts.holder.name}</span>
                {facts.holder.model ? <span>· {facts.holder.model}</span> : null}
                {holderAge !== null ? (
                  <time className="tabular-nums" dateTime={facts.holder.since ?? undefined}>· claimed {formatAge(holderAge)} ago</time>
                ) : null}
              </span>
            ) : null}
            {facts.progress ? <EpicProgress closed={facts.progress.closed} total={facts.progress.total} segments={facts.progress.segments} /> : null}
          </>
        ) : null
      }
      actions={actions}
    >
      {children}
    </PageHeader>
  );
}

/**
 * A closed task's evidence, directly under its header: who closed it with the
 * model they named, when, and the reason they gave. Neutral ink: closing
 * records what shipped, not an outcome anyone has measured.
 */
export function ClosedSummary({
  by,
  model,
  at,
  nowMs,
  children,
  className,
}: {
  by: string | null;
  model: string | null;
  at: string | null;
  nowMs: number;
  /** The close reason, rendered by the caller. */
  children: ReactNode;
  className?: string;
}) {
  const age = ageMs(nowMs, at);
  const who = [by, model].filter(Boolean).join(" · ");
  return (
    <section aria-label="Close reason" data-task-closed="" className={cn("flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Check className="size-3.5 shrink-0" aria-hidden />
        <h2 className={cn("m-0", eyebrowClass)}>Close reason</h2>
        {who ? <span className="font-medium text-foreground">{who}</span> : null}
        {age !== null ? <time className="tabular-nums" dateTime={at ?? undefined}>{formatAge(age)} ago</time> : null}
      </div>
      {children}
    </section>
  );
}
