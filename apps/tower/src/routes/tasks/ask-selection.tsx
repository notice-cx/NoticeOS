import { useState } from "react";
import { Check, Reply, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useInboxAnswers, type InboxAnswer } from "@/hooks/useTasks";
import { askVerb, isGate } from "@/lib/task-board-read";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Ask } from "./ask-queue";

/**
 * The verbs for every selected decision at once. Each is the call that row's
 * own verb makes, so approvals take Approve and questions take Answer or
 * Dismiss, and a press sends only the rows it names (`useInboxAnswers`: one
 * Undo, then the calls one at a time). A question with choices is left out of
 * Answer and counted beside the selection instead, so a batch never answers
 * one of those for the owner; its pick is made on its own row. A person makes
 * every decision here: a selection is a person's clicks, and no agent tool
 * reaches it.
 */
export function AskSelection({ chosen, selectable, onPick, onSent }: {
  chosen: readonly Ask[];
  selectable: readonly Ask[];
  onPick: (ids: ReadonlySet<string>) => void;
  /** The selection was handed to the queue; the caller leaves selecting. */
  onSent: () => void;
}) {
  const answerAll = useInboxAnswers();
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const approvals = chosen.filter((ask) => isGate(ask.task));
  const questions = chosen.filter((ask) => !isGate(ask.task));
  const picks = questions.filter((ask) => askVerb(ask.task) === "choose");
  const answerable = questions.filter((ask) => askVerb(ask.task) !== "choose");
  const of = ({ task }: Ask) => ({ id: task.id, title: task.title, project: task.project });

  function send(answers: InboxAnswer[]) {
    answerAll(answers);
    setAnswering(false);
    setText("");
    onSent();
  }
  function sendAnswer() {
    const words = text.trim();
    if (words !== "") send(answerable.map((ask) => ({ kind: "answer", ...of(ask), text: words })));
  }

  return (
    <div role="group" aria-label="Selected decisions" className="flex flex-col gap-2 border-t border-border/60 px-5 py-2.5" data-inbox-selection>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tabular-nums text-muted-foreground" role="status" data-status-for="selection:decisions">
          {formatInt(chosen.length)} selected
          {picks.length > 0 ? <span data-selection-picks=""> · {formatInt(picks.length)} {picks.length === 1 ? "needs" : "need"} a choice</span> : null}
        </span>
        {chosen.length < selectable.length ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onPick(new Set(selectable.map((ask) => ask.task.id)))} data-inbox-select-all>
            Select all {formatInt(selectable.length)}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => onPick(new Set())} data-inbox-select-none>
            Clear
          </Button>
        )}
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {approvals.length > 0 ? (
            <Button type="button" size="sm" onClick={() => send(approvals.map((ask) => ({ kind: "approve", ...of(ask) })))} data-bulk-action="approve">
              <Check aria-hidden />
              Approve {formatInt(approvals.length)}
            </Button>
          ) : null}
          {answerable.length > 0 ? (
            <Button type="button" size="sm" variant={answering ? "outline" : "default"} aria-expanded={answering}
              onClick={() => setAnswering((open) => !open)} data-bulk-action="answer">
              <Reply aria-hidden />
              Answer {formatInt(answerable.length)}
            </Button>
          ) : null}
          {questions.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" className="text-muted-foreground"
              onClick={() => send(questions.map((ask) => ({ kind: "dismiss", ...of(ask) })))} data-bulk-action="dismiss">
              Dismiss {formatInt(questions.length)}
            </Button>
          ) : null}
        </span>
      </div>
      {answering && answerable.length > 0 ? (
        <form
          className="flex items-start gap-2 max-sm:flex-wrap"
          data-bulk-form="answer"
          onSubmit={(event) => {
            event.preventDefault();
            sendAnswer();
          }}
        >
          <textarea
            autoFocus
            rows={1}
            className={cn(fieldClass, "min-h-9 w-full flex-1 resize-y max-sm:basis-full")}
            aria-label={`Your answer to ${formatInt(answerable.length)} questions`}
            placeholder="One answer for each"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setAnswering(false);
                return;
              }
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              sendAnswer();
            }}
          />
          <Button type="submit" size="sm" disabled={text.trim() === ""} data-bulk-confirm="answer">
            <SendHorizontal aria-hidden />
            Send
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}
