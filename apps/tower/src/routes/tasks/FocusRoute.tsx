import { useEffect, useId, useRef, useState } from "react";
import { Check, SendHorizontal, Star } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { TASK_CHOICE_KEYS, TASK_CHOICE_LIMITS, type TaskChoiceKey } from "@noticeos/contract/task-choices";
import { choiceOrder } from "@/components/ChoiceButtons";
import { ReadFailed } from "@/components/ReadFailed";
import { PageSkeleton } from "@/components/Skeleton";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillControlClass } from "@/components/ui/pill";
import { WhyItRanks } from "@/components/viz/WhyItRanks";
import { useInboxAnswer } from "@/hooks/useTasks";
import { useDocumentTitle } from "@/lib/document-title";
import { formatInt } from "@/lib/format";
import type { BoardProject } from "@/lib/task-board-read";
import type { RankedTask } from "@/lib/task-ranking";
import { cn } from "@/lib/utils";
import { useAskReasons } from "./next/NextDecision";
import { ASK_LINE, epicOf, waitedShort, whySentence, type EpicFacts } from "./next/next-read";
import { AskGlyph, SiteMark, TaskTitleLink } from "./next/parts";
import { useNextBoard } from "./next/useNextBoard";

/** Where Leave focus goes when the page was opened without a way back. */
const TASKS_HOME = "/tasks";

function returnPath(state: unknown): string {
  const path = typeof state === "object" && state !== null ? (state as { returnTo?: unknown }).returnTo : undefined;
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : TASKS_HOME;
}

/** A key press meant for a field or an open menu is not a Focus command. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]') !== null;
}

/**
 * `/tasks/focus`: the decisions one at a time, in rank order. A pick, an
 * approval or an answer goes through the board's answer hooks, so it carries
 * the same Undo and leaves every list the same way; Not now passes over a
 * decision without answering it. `?project=` narrows to one site and
 * `?task=` starts at one decision.
 */
export function FocusRoute() {
  useDocumentTitle("Focus");
  const [params] = useSearchParams();
  const location = useLocation();
  const scope = params.get("project");
  const start = params.get("task");
  const next = useNextBoard(scope);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const leave = returnPath(location.state);

  const queue = next.ranked.decisions;
  const at = start === null ? -1 : queue.findIndex((row) => row.task.id === start);
  const ordered = at <= 0 ? queue : [...queue.slice(at), ...queue.slice(0, at)];
  const pending = ordered.filter((row) => !skipped.has(row.task.id));
  const current = pending[0] ?? null;
  const after = pending[1] ?? null;
  const shown = new Set(queue.map((row) => row.task.id));
  // Answered here and gone from the read while its Undo runs: still one of
  // the decisions this sitting went through.
  const gone = [...handled].filter((id) => !shown.has(id)).length;
  const total = queue.length + gone;
  const position = Math.min(total, ordered.length - pending.length + gone + 1);

  const body = !next.data || !next.drawn ? (
    next.isError && !next.data ? (
      <ReadFailed title="Couldn't load tasks" subject="read:tasks" error={next.error} retrying={next.isFetching} onRetry={() => void next.refetch()} />
    ) : (
      <PageSkeleton subject="read:tasks" shape="list" />
    )
  ) : next.spokes.length === 0 ? <TaskHubUnavailable /> : current === null ? (
    <div className="flex flex-col items-start gap-3 py-10" data-focus-done="">
      <p className="m-0 text-figure-sm text-foreground">That's every decision for you.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild><Link to={leave}>Back to Tasks</Link></Button>
        {skipped.size > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setSkipped(new Set())} data-focus-again="">
            Start over
          </Button>
        ) : null}
      </div>
    </div>
  ) : (
    <FocusDecision
      key={current.task.id}
      row={current}
      project={next.byId.get(current.task.project) ?? null}
      epic={epicOf(next, current.task)}
      after={after}
      afterSite={after ? next.byId.get(after.task.project)?.name ?? after.task.project : null}
      of={queue.length}
      onSkip={() => setSkipped((ids) => new Set([...ids, current.task.id]))}
      onSent={() => setHandled((ids) => new Set([...ids, current.task.id]))}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-6" data-tasks-focus="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={eyebrowClass} data-focus-position={`${position}/${total}`}>
          {total > 0 ? `Focus · ${formatInt(position)} of ${formatInt(total)} for you` : "Focus"}
        </span>
        {/* Past two dozen the dots are no longer countable; the words carry the place. */}
        {total > 0 && total <= 24 ? (
          <span aria-hidden className="flex flex-wrap gap-1">
            {Array.from({ length: total }, (_, index) => (
              <span key={index} className={cn("size-1.5 rounded-full", current === null || index < position ? "bg-foreground/80" : "bg-border")} />
            ))}
          </span>
        ) : null}
        <Link to={leave} className={cn("ms-auto text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline", pillControlClass)}>
          Leave focus
        </Link>
      </div>
      {body}
    </div>
  );
}

/** One decision, with every way of answering it as a large press and the
 * keys that do the same. */
function FocusDecision({ row, project, epic, after, afterSite, of, onSkip, onSent }: {
  row: RankedTask;
  project: BoardProject | null;
  epic: EpicFacts | null;
  after: RankedTask | null;
  afterSite: string | null;
  of: number;
  onSkip: () => void;
  onSent: () => void;
}) {
  const { task, card, score, ask } = row;
  const answer = useInboxAnswer();
  const reasons = useAskReasons(row, project);
  const noteId = useId();
  const reasonId = useId();
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const choices = ask === "choose" ? task.choices ?? null : null;
  const options = choices ? choiceOrder(choices) : [];
  const reason = choices ? reasons.choose : reasons.ask;
  const scope = { project: task.project };
  const why = whySentence(row.why);
  const waited = waitedShort(row.ageDays);

  function choose(key: TaskChoiceKey) {
    if (choices === null || reason !== null) return;
    const option = choices.options.find((entry) => entry.key === key);
    if (!option) return;
    const said = note.trim();
    answer({ kind: "choose", id: task.id, title: task.title, option: key, label: option.label, ...(said === "" ? {} : { note: said }), ...scope });
    onSent();
  }
  function approve() {
    if (reason !== null) return;
    answer({ kind: "approve", id: task.id, title: task.title, ...scope });
    onSent();
  }
  function send() {
    const words = text.trim();
    if (words === "" || reason !== null) return;
    answer({ kind: "answer", id: task.id, title: task.title, text: words, ...scope });
    onSent();
  }

  // The latest handlers, for the one listener the page keeps.
  const keys = useRef({ choose, approve, onSkip, ask, keys: options.map((option) => option.key) });
  keys.current = { choose, approve, onSkip, ask, keys: options.map((option) => option.key) };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      const now = keys.current;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        now.onSkip();
        return;
      }
      if (event.key === "Enter" && now.ask === "approve" && !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)) {
        event.preventDefault();
        now.approve();
        return;
      }
      const letter = event.key.toLowerCase();
      const key = TASK_CHOICE_KEYS.find((candidate) => candidate === letter);
      if (key !== undefined && now.keys.includes(key)) {
        event.preventDefault();
        now.choose(key);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hint = choices
    ? `${options.map((option) => option.key.toUpperCase()).join(" ")} choose · → skip`
    : ask === "approve" ? "Enter approve · → skip" : "→ skip";

  return (
    <section className="flex flex-col gap-5" data-focus-decision={task.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SiteMark site={task.project} name={project?.name ?? task.project} showName />
        {epic ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground" data-focus-epic="">
            <TaskTitleLink task={{ id: epic.id, title: epic.title, project: task.project }} />
            {epic.closed !== null && epic.total !== null ? <span className="tabular-nums">{epic.closed} of {epic.total}</span> : null}
          </span>
        ) : null}
        {ask ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warn">
            <AskGlyph ask={ask} />
            {ASK_LINE[ask]}
            {waited ? ` · waiting ${waited}` : ""}
          </span>
        ) : null}
      </div>

      <h1 className="m-0 text-[28px] font-bold leading-[1.1] tracking-[-0.03em] text-foreground md:text-display">
        <TaskTitleLink task={task} />
      </h1>
      {why ? <p className="m-0 text-base text-muted-foreground">{why}</p> : null}
      {card ? <WhyItRanks card={card} score={score} rank={score ? { position: row.rank, of } : null} size="sm" /> : null}

      {choices ? (
        <div role="group" aria-labelledby={`${noteId}-question`} className="flex flex-col gap-3" data-focus-options="">
          <p id={`${noteId}-question`} className="m-0 text-base font-medium text-foreground [overflow-wrap:anywhere]">{choices.question}</p>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-0">
            {options.map((option) => (
              <li key={option.key} className="min-w-0">
                <button
                  type="button"
                  disabled={reason !== null}
                  aria-describedby={reason !== null ? reasonId : undefined}
                  onClick={() => choose(option.key)}
                  className={cn(
                    "flex h-full min-h-16 w-full items-start gap-3 rounded-xl border bg-card px-4 py-3 text-start hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
                    pillControlClass,
                    option.recommended ? "border-foreground/40" : "border-border",
                  )}
                  data-focus-option={option.key}
                >
                  <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-current text-sm font-semibold text-foreground">
                    {option.key.toUpperCase()}
                  </span>
                  <span className="grid min-w-0 gap-1">
                    <span className="text-base font-medium text-foreground [overflow-wrap:anywhere]">{option.label}</span>
                    {option.recommended ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Star aria-hidden className="size-3 fill-current" />
                        Recommended
                      </span>
                    ) : null}
                    {option.detail ? <span className="whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">{option.detail}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <span className="flex items-center gap-2">
            <label htmlFor={noteId} className="shrink-0 text-xs font-medium text-muted-foreground">Note</label>
            <input
              id={noteId}
              type="text"
              className={cn(fieldClass, "h-9 min-w-0 flex-1")}
              maxLength={TASK_CHOICE_LIMITS.note}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              data-focus-note=""
            />
          </span>
        </div>
      ) : ask === "approve" ? (
        <div>
          <Button type="button" size="default" className="min-h-11 px-6 text-base" disabled={reason !== null}
            aria-describedby={reason !== null ? reasonId : undefined} onClick={approve} data-focus-approve="">
            <Check aria-hidden />
            Approve
          </Button>
        </div>
      ) : (
        <form className="flex items-start gap-2 max-sm:flex-wrap" data-focus-answer="" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea
            rows={2}
            className={cn(fieldClass, "min-h-16 w-full flex-1 resize-y max-sm:basis-full")}
            aria-label={`Your answer to ${task.id}`}
            placeholder="Your answer"
            value={text}
            disabled={reason !== null}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
          <Button type="submit" disabled={text.trim() === "" || reason !== null}>
            <SendHorizontal aria-hidden />
            Send
          </Button>
        </form>
      )}
      {reason !== null ? <p id={reasonId} className="m-0 text-xs text-muted-foreground">{reason}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3">
        <Button type="button" variant="ghost" onClick={onSkip} data-focus-skip="">Not now</Button>
        {after ? (
          <span className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-focus-after="">
            After this: <TaskTitleLink task={after.task} />{afterSite ? ` · ${afterSite}` : ""}{after.card ? ` · ${formatInt(after.card.reviewMinutes)} min` : ""}
          </span>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground max-sm:hidden" data-focus-keys="">{hint}</span>
      </div>
    </section>
  );
}

export default FocusRoute;
