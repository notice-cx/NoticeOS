import { Children, type ReactNode } from "react";
import { Check, CircleCheck } from "lucide-react";
import { choiceName, type TaskChoice, type TaskChoices } from "@noticeos/contract/task-choices";
import { TASK_RESOLUTION_LABELS, type TaskResolution } from "@noticeos/contract/task-resolution";
import { RESOLUTION_GLYPH } from "@/components/CloseResolution";
import { ageMs, formatAge } from "@shared/freshness";
import { AgentMark } from "@/components/AgentMark";
import { ChoiceButtons } from "@/components/ChoiceButtons";
import { PageHeader, type PageHeaderCrumb } from "@/components/PageHeader";
import { StateChip } from "@/components/StateChip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Card } from "@/components/ui/card";
import type { InboxAsk } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { EpicProgress, type EpicSegment } from "./epic-tasks";
import { PriorityChip, TaskStatusChip, TypeMark, askFace, typeFace } from "./task-face";

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
  /** The options it offers a person, and the one picked once it is. */
  choices?: TaskChoices | null;
  choice?: TaskChoice | null;
}

/** What the header's chip says a decision of the operator's waits on. */
const ASK_LINE: Readonly<Record<InboxAsk, string>> = {
  approve: "Needs your approval",
  answer: "Needs your answer",
  choose: "Needs your choice",
};

/**
 * The top of `/tasks/:id`, read in one look: where the item sits, what kind
 * of item it is (its mark, and its band's tint: an open bug's is the alert
 * surface, every other type's the neutral one) and its id, the title, then
 * its state, priority, holder, progress and what it asks of the operator,
 * with the actions beside it, the primary one first. `children` sits under
 * it, divided from it: a closed task's reason, or the form an action opened.
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
  const face = facts ? typeFace(facts.issueType, facts.awaitType, facts.status) : null;
  return (
    <Card
      kind={face?.surface ?? "neutral"}
      data-task-band={facts?.issueType ?? ""}
      className="viz-arrive rounded-xl px-4 py-4 md:px-5"
    >
      <PageHeader
        documentTitle={facts?.title ?? "Task"}
        breadcrumb={crumbs}
        eyebrow={
          <>
            <span className={eyebrowClass} data-task-type={facts?.issueType ?? ""}>
              {face?.word ?? "Task"}
            </span>
            {/* The id is the string the operator quotes in a commit and types
                into a command, so it stays whole and in its own case. */}
            <span className="font-mono text-xs text-muted-foreground">{id}</span>
            {facts?.awaitType && facts.awaitType !== "human" ? (
              <span className="text-xs text-muted-foreground">waits on {facts.awaitType}</span>
            ) : null}
          </>
        }
        title={
          <span className="flex min-w-0 items-center gap-3">
            {facts ? <TypeMark issueType={facts.issueType} awaitType={facts.awaitType} status={facts.status} /> : null}
            <span className="min-w-0 text-2xl leading-tight [overflow-wrap:anywhere] max-sm:text-xl">{facts?.title ?? "Task"}</span>
          </span>
        }
        meta={
          facts ? (
            <>
              <TaskStatusChip status={facts.status} subject={subject} className="py-1" />
              <PriorityChip priority={facts.priority} subject={subject} />
              {facts.ask ? (
                <StateChip
                  tone="caution"
                  subject={subject}
                  className="py-1"
                  glyph={<span className="text-micro font-bold leading-none">{askFace(facts).glyph}</span>}
                  label={<span data-task-ask={facts.ask}>{ASK_LINE[facts.ask]}</span>}
                />
              ) : null}
              {facts.holder ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-card/70 py-0.5 ps-0.5 pe-2.5 text-xs text-muted-foreground"
                  data-task-holder=""
                >
                  {/* A claim still being worked carries the Wall's slow ring
                      for a series still being counted. */}
                  <span className={cn("inline-flex rounded-[5px] text-muted-foreground", facts.status === "in_progress" && "viz-breathe")} data-task-holder-live={facts.status === "in_progress" ? "" : undefined}>
                    <AgentMark name={facts.holder.name} models={[facts.holder.model]} size="small" />
                  </span>
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
        {Children.toArray(children).length > 0 ? <div className="mt-2 flex flex-col gap-3 border-t border-border/70 pt-3">{children}</div> : null}
      </PageHeader>
    </Card>
  );
}

/**
 * A closed task's evidence, directly under its header: who closed it with the
 * model they named, when, and the reason they gave. Neutral ink: closing
 * records what shipped, not an outcome anyone has measured. A close where
 * nothing shipped leads with its resolution, "Closed as Won't do", and a
 * duplicate links the task it names; its note follows when it has one.
 */
export function ClosedSummary({
  by,
  model,
  at,
  nowMs,
  resolution = "done",
  duplicate = null,
  children,
  className,
}: {
  by: string | null;
  model: string | null;
  at: string | null;
  nowMs: number;
  resolution?: TaskResolution;
  /** A duplicate's other task, as a link the caller renders. */
  duplicate?: ReactNode;
  /** The close reason, rendered by the caller; nothing when a close where
   * nothing shipped has no note. */
  children?: ReactNode;
  className?: string;
}) {
  const age = ageMs(nowMs, at);
  const who = [by, model].filter(Boolean).join(" · ");
  const Glyph = resolution === "done" ? Check : RESOLUTION_GLYPH[resolution];
  const heading = resolution === "done" ? "Close reason" : `Closed as ${TASK_RESOLUTION_LABELS[resolution]}`;
  return (
    <section aria-label={heading} data-task-closed="" data-task-resolution={resolution} className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Glyph className="size-3.5 shrink-0" aria-hidden />
        {resolution === "done" ? (
          <h2 className={cn("m-0", eyebrowClass)}>Close reason</h2>
        ) : (
          <h2 className="m-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]" data-task-resolution-fact="">
            {heading}
            {duplicate ? <> of {duplicate}</> : null}
          </h2>
        )}
        {who ? <span className="font-medium text-foreground">{who}</span> : null}
        {age !== null ? <time className="tabular-nums" dateTime={at ?? undefined}>{formatAge(age)} ago</time> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A person's pick, directly under the header once it is recorded: "Chose (b)
 * <label>", who chose and how long ago, their note, then the options as a
 * record with the chosen one filled. The pick is a fact on the task, so it
 * stays after an agent takes the task back.
 */
export function ChoiceSummary({
  choice,
  choices,
  by,
  nowMs,
}: {
  choice: TaskChoice;
  /** The options the task offered; null when the read no longer carries them. */
  choices: TaskChoices | null;
  /** Who chose, in the words the page names people with. */
  by: string;
  nowMs: number;
}) {
  const age = ageMs(nowMs, choice.at);
  return (
    <section aria-label="Choice" data-task-choice={choice.option} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 shrink-0" aria-hidden />
        <h2 className="m-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]" data-task-choice-fact="">
          Chose {choiceName(choice.option, choice.label)}
        </h2>
        <span className="font-medium text-foreground">{by}</span>
        {age !== null ? <time className="tabular-nums" dateTime={choice.at}>{formatAge(age)} ago</time> : null}
      </div>
      {choice.note ? <p className="m-0 whitespace-pre-line text-sm [overflow-wrap:anywhere]" data-task-choice-note="">{choice.note}</p> : null}
      {choices ? <ChoiceButtons choices={choices} chosen={choice.option} /> : null}
    </section>
  );
}
