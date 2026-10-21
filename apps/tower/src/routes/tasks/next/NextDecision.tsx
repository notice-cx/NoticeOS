import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { DEMO_READ_ONLY } from "@shared/demo-viewer";
import { READ_ONLY_TASKS_HINT, taskOperationAvailable } from "@shared/tasks";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { pillControlClass } from "@/components/ui/pill";
import { WhyItRanks } from "@/components/viz/WhyItRanks";
import { useTasksLive } from "@/hooks/useTasks";
import { useDemoReadonly } from "@/lib/browser-context";
import { isGate, type BoardProject } from "@/lib/task-board-read";
import type { RankedTask } from "@/lib/task-ranking";
import { cn } from "@/lib/utils";
import { useAskActions } from "../ask-actions";
import { ASK_LINE, cameFrom, cardDefinitions, waitedShort, whySentence, type EpicFacts } from "./next-read";
import { SiteMark, TaskTitleLink, useTaskHref } from "./parts";

/** The reason a decision's verbs cannot run here, or null when they can: a
 * read-only board, or a workspace that does not offer the verb. The same
 * words the task page writes. */
export function useAskReasons(row: RankedTask, project: BoardProject | null): { ask: string | null; choose: string | null } {
  const capabilities = useTasksLive();
  const demoReadonly = useDemoReadonly();
  const blocked = project?.actionable ? null : demoReadonly ? DEMO_READ_ONLY : READ_ONLY_TASKS_HINT;
  const unavailable = "Unavailable in this workspace.";
  return {
    ask: blocked ?? (taskOperationAvailable(capabilities, isGate(row.task) ? "resolve" : "respond") ? null : unavailable),
    choose: blocked ?? (taskOperationAvailable(capabilities, "choose") ? null : unavailable),
  };
}

/**
 * The one decision to take next, whole: where it sits, what it asks, why it
 * is first and the figures its card holds, then the same verbs its row on the
 * board carries. Every press goes through the board's answer hooks, so the
 * Undo window and what leaves the list are the board's.
 */
export function NextDecision({ row, project, epic, of }: {
  row: RankedTask;
  project: BoardProject | null;
  epic: EpicFacts | null;
  /** How many decisions the ranking holds. */
  of: number;
}) {
  const { task, card, score, ask } = row;
  const headingId = useId();
  const reasonId = useId();
  const reasons = useAskReasons(row, project);
  const choosing = ask === "choose" && (task.choices ?? null) !== null;
  const reason = choosing ? reasons.choose ?? reasons.ask : reasons.ask;
  const actions = useAskActions({
    ask,
    id: task.id,
    title: task.title,
    project: task.project,
    choices: task.choices ?? null,
    disabledReason: reasons.ask,
    chooseDisabledReason: reasons.choose,
    describedBy: reason === null ? undefined : reasonId,
    placement: "header",
  });
  const href = useTaskHref()(task);
  const why = whySentence(row.why);
  const waited = waitedShort(row.ageDays);
  const siteName = project?.name ?? task.project;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-raised md:p-5"
      data-next-decision={task.id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className={cn("m-0", eyebrowClass)}>Next for you</h2>
        <SiteMark site={task.project} name={siteName} showName />
        {epic ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground" data-next-epic="">
            <span className="text-foreground [overflow-wrap:anywhere]">{epic.title}</span>
            {epic.closed !== null && epic.total !== null ? <span className="tabular-nums">{epic.closed} of {epic.total}</span> : null}
          </span>
        ) : null}
        {ask ? (
          <span className="ms-auto text-xs font-medium text-warn" data-next-ask={ask}>
            {ASK_LINE[ask]}
            {waited ? ` · waiting ${waited}` : ""}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 id={headingId} className="m-0 text-figure-sm text-foreground">
          <TaskTitleLink task={task} />
        </h3>
        {why ? <p className="m-0 text-sm text-muted-foreground" data-next-why="">{why}</p> : null}
      </div>

      {card ? (
        <div className="flex flex-col gap-2">
          <WhyItRanks card={card} score={score} rank={score ? { position: row.rank, of } : null} size="md" />
          <WhyFirst row={row} of={of} href={href} />
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground" data-next-unranked="">
          Not ranked: no card says what it is worth.{" "}
          <Link to={href.to} state={href.state} className={cn("font-medium text-foreground underline-offset-4 hover:underline", pillControlClass)}>
            Open the task to add one.
          </Link>
        </p>
      )}

      {project?.actionable || reason !== null ? (
        <div className="flex flex-col gap-2.5" data-next-actions="">
          {actions.buttons ? <div className="flex flex-wrap items-center gap-2">{actions.buttons}</div> : null}
          {reason !== null ? <p id={reasonId} className="m-0 text-xs text-muted-foreground">{reason}</p> : null}
          {actions.box}
        </div>
      ) : null}
    </section>
  );
}

/** The ranking's working, opened on request: where the decision stands, and
 * every figure on its card the strip does not draw. */
function WhyFirst({ row, of, href }: { row: RankedTask; of: number; href: { to: string; state: { returnTo: string } } }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (row.card === null) return null;
  const origin = cameFrom(row.task);
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="self-start text-muted-foreground"
        data-next-why-first=""
      >
        Why first?
        <ChevronDown aria-hidden className={cn("motion-safe:transition-transform", open && "rotate-180")} />
      </Button>
      {open ? (
        <dl id={listId} className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs max-sm:grid-cols-1" data-next-why-list="">
          {row.score ? <Definition label="Rank">{row.rank} of {of} · policy {row.score.policy}</Definition> : null}
          {cardDefinitions(row.card).map((entry) => (
            <Definition key={entry.label} label={entry.label}>{entry.value}</Definition>
          ))}
          {origin ? (
            <Definition label="Evidence">
              <Link to={origin.to} className="text-foreground underline-offset-4 hover:underline">{origin.label}</Link>
            </Definition>
          ) : null}
          <dd className="m-0 col-span-full">
            <Link to={href.to} state={href.state} className={cn("font-medium text-foreground underline-offset-4 hover:underline", pillControlClass)}>
              Open the task →
            </Link>
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 tabular-nums text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}
