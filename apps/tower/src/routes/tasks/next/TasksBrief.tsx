import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { ageMs, formatAge } from "@shared/freshness";
import { taskActorLabel, taskOperationAvailable } from "@shared/tasks";
import type { WeekMove } from "@shared/work";
import { AGENTS_ROUTE } from "@/components/nav-items";
import { Button } from "@/components/ui/button";
import { pillControlClass } from "@/components/ui/pill";
import { useInboxAnswer, useTasksLive } from "@/hooks/useTasks";
import { useOwnerPreferences } from "@/lib/browser-context";
import type { BoardProject } from "@/lib/task-board-read";
import type { RankedBoard, RankedTask } from "@/lib/task-ranking";
import { cn } from "@/lib/utils";
import { ASK_VERB, briefClause, doneSentence, endSentence, heldSince, plural } from "./next-read";
import { NOT_NOW_ID } from "./NotNow";
import { useTaskHref } from "./parts";

/** The one preference this brief keeps: whether it is open. */
const BRIEF_PREFERENCE = "tasks-brief-open";

type Tone = "decision" | "urgent" | "ready" | "done";

/** One line of the brief: the sentence and the one press it offers. */
interface BriefLine {
  key: string;
  tone: Tone;
  text: string;
  action: ReactNode;
}

const DOT: Readonly<Record<Tone, string>> = {
  decision: "bg-warn",
  urgent: "bg-urgent",
  ready: "border border-muted-foreground",
  done: "bg-muted-foreground/60",
};

function readOpen(preferences: ReturnType<typeof useOwnerPreferences>): boolean {
  try {
    return preferences.read(BRIEF_PREFERENCE) === "open";
  } catch {
    return false;
  }
}

function writeOpen(preferences: ReturnType<typeof useOwnerPreferences>, open: boolean): void {
  try {
    preferences.write(BRIEF_PREFERENCE, open ? "open" : "closed");
  } catch {
    /* Storage is off or full: the brief still opens, it only forgets. */
  }
}

/** The decision sentence: which site has waited how long, on what, and the
 * first fact behind it. */
export function decisionLine(row: RankedTask, site: string): string {
  const wait = row.ageDays !== null && row.ageDays >= 1
    ? `${site} has waited ${plural(row.ageDays, "day", "days")} for your call`
    : `${site} is waiting for your call`;
  const clause = briefClause(row);
  return `${wait}: ${endSentence(row.task.title)}${clause ? ` ${clause}` : ""}`;
}

/**
 * The Next tab read as sentences, on request: the two decisions at the top,
 * the urgent work in hand, what the agents take next and the week's done,
 * each with the one press it calls for. A fact the board does not hold
 * leaves its sentence out rather than filling it.
 */
export function TasksBrief({ ranked, projects, done, focusTo, nowMs }: {
  ranked: RankedBoard;
  projects: ReadonlyMap<string, BoardProject>;
  /** This week's done count and its move, when the read holds them. */
  done: { count: number; move: WeekMove | null } | null;
  /** Focus, for a decision that needs typing or a pick. */
  focusTo: (id: string) => string;
  nowMs: number;
}) {
  const preferences = useOwnerPreferences();
  const [open, setOpen] = useState(() => readOpen(preferences));
  const listId = useId();
  const answer = useInboxAnswer();
  const capabilities = useTasksLive();
  const taskHref = useTaskHref();
  const { pathname, search } = useLocation();
  const siteOf = (row: { task: { project: string } }) => projects.get(row.task.project)?.name ?? row.task.project;

  const openLink = (task: RankedTask["task"]) => {
    const href = taskHref(task);
    return <Button asChild size="sm" variant="outline"><Link to={href.to} state={href.state}>Open</Link></Button>;
  };

  const lines: BriefLine[] = [];
  for (const row of ranked.decisions.slice(0, 2)) {
    if (row.ask === null) continue;
    const project = projects.get(row.task.project);
    const approvable = row.ask === "approve" && project?.actionable === true && taskOperationAvailable(capabilities, "resolve");
    lines.push({
      key: `decision-${row.task.id}`,
      tone: "decision",
      text: decisionLine(row, siteOf(row)),
      action: row.ask === "approve" ? (
        <Button type="button" size="sm" variant="outline" disabled={!approvable}
          onClick={() => answer({ kind: "approve", id: row.task.id, title: row.task.title, project: row.task.project })}
          data-brief-action="approve">
          <Check aria-hidden />
          Approve
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link to={focusTo(row.task.id)} state={{ returnTo: `${pathname}${search}` }} data-brief-action={row.ask}>{ASK_VERB[row.ask]}</Link>
        </Button>
      ),
    });
  }
  const urgent = ranked.agents.find((row) => row.state === "in-progress" && row.task.priority <= 1);
  if (urgent) {
    const who = urgent.task.assignee ? taskActorLabel(urgent.task.assignee, urgent.task.actors) : null;
    const since = ageMs(nowMs, heldSince(urgent.task));
    lines.push({
      key: `urgent-${urgent.task.id}`,
      tone: "urgent",
      text: who && since !== null
        ? `${siteOf(urgent)}: ${urgent.task.title.trim()} is urgent; ${who} has been on it for ${formatAge(since)}.`
        : `${siteOf(urgent)}: ${urgent.task.title.trim()} is urgent and in progress.`,
      action: openLink(urgent.task),
    });
  }
  const ready = ranked.agents.find((row) => row.state === "ready");
  if (ready) {
    const who = ready.task.assignee ? taskActorLabel(ready.task.assignee, ready.task.actors) : null;
    lines.push({
      key: `ready-${ready.task.id}`,
      tone: "ready",
      text: `${siteOf(ready)}: ${ready.task.title.trim()} is next for ${who ?? "the agents"}.`,
      action: openLink(ready.task),
    });
  }
  if (done) {
    lines.push({
      key: "done",
      tone: "done",
      text: doneSentence(done.count, done.move),
      action: <Button asChild size="sm" variant="outline"><Link to={AGENTS_ROUTE}>Agents →</Link></Button>,
    });
  }
  if (lines.length === 0) return null;
  const held = ranked.notNow.length;

  function toggle() {
    const next = !open;
    setOpen(next);
    writeOpen(preferences, next);
  }

  function showHeldBack() {
    const target = document.getElementById(NOT_NOW_ID);
    target?.scrollIntoView?.({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  return (
    <div className="flex flex-col gap-2" data-tasks-brief={open ? "open" : "closed"}>
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={listId} onClick={toggle}
        className="self-start text-muted-foreground" data-tasks-brief-toggle="">
        Read it as a brief
        <ChevronDown aria-hidden className={cn("motion-safe:transition-transform", open && "rotate-180")} />
      </Button>
      {open ? (
        <div id={listId} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-1">
          <ul className="m-0 flex list-none flex-col p-0">
            {lines.map((line) => (
              <li key={line.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 py-2" data-brief-line={line.tone}>
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
                <span className="min-w-0 flex-1 basis-64 text-sm text-foreground [overflow-wrap:anywhere]">{line.text}</span>
                <span className="ms-auto shrink-0">{line.action}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2 py-2 text-sm text-muted-foreground">
            <span>Everything else can wait.</span>
            {held > 0 ? (
              <button type="button" onClick={showHeldBack}
                className={cn("font-medium text-foreground underline-offset-4 hover:underline", pillControlClass)}
                data-brief-held-back="">
                {held === 1 ? "1 task is held back, for one reason →" : `${plural(held, "task", "tasks")} are held back, each for one reason →`}
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
