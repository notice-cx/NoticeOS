import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Reply, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useInboxAnswer } from "@/hooks/useTasks";
import type { InboxAsk } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";

/**
 * WHAT A TASK WAITING ON THE OPERATOR OFFERS, defined once for the two places
 * it is met: its row in the Tasks board's Waiting on you and its own page's
 * header (bead `ro-ujb9.243`). A human gate offers ONE verb, Approve
 * (`bd gate resolve`); an ask offers Answer (`bd human respond`) and Dismiss
 * (`bd human dismiss`). Each goes through the inbox's own path — the Undo toast,
 * then the lane call once its window closes (`lib/answer-queue.ts`).
 *
 * The page used to offer Claim and Close here: claiming a gate assigned the
 * operator to a mechanism, and Close ran `bd close` rather than the command the
 * gate or ask was waiting for — two wrong verbs one click from the right one.
 *
 * `buttons` is the verbs and `box` is the answer box Answer opens, returned
 * apart because the row seats them on its line and under it, and the page in
 * its header's actions and under them. Both are null for a task the inbox
 * asks nothing of, so the page can fall back to its own verbs.
 */
export function useAskActions({
  ask,
  id,
  title,
  project,
  disabledReason = null,
  placement,
}: {
  ask: InboxAsk | null;
  id: string;
  title: string;
  /** Explicit row selection; a detail page captures its current query selection. */
  project?: string;
  /** Why the verbs cannot run here (a read-only snapshot), or null. */
  disabledReason?: string | null;
  /** The row indents the box under its title; the header sets it in a panel. */
  placement: "row" | "header";
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const answer = useInboxAnswer();
  // The box opens mid-screen, clear of the corner an Undo toast occupies on a
  // phone (a previous answer's toast would otherwise cover Send).
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (answering) form.current?.scrollIntoView?.({ block: "center" });
  }, [answering]);
  const disabled = disabledReason !== null;
  const blockedTitle = disabledReason ?? undefined;

  function send() {
    const words = text.trim();
    if (words === "") return;
    answer({ kind: "answer", id, title, text: words, ...(project === undefined ? {} : { project }) });
    setText("");
    setAnswering(false);
  }

  if (ask === null) return { buttons: null, box: null };

  const buttons =
    ask === "approve" ? (
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        title={blockedTitle}
        onClick={() => answer({ kind: "approve", id, title, ...(project === undefined ? {} : { project }) })}
        data-task-action="approve"
      >
        <Check aria-hidden />
        Approve
      </Button>
    ) : (
      <>
        <Button
          type="button"
          size="sm"
          variant={answering ? "outline" : "default"}
          aria-expanded={answering}
          disabled={disabled}
          title={blockedTitle}
          onClick={() => setAnswering((open) => !open)}
          data-task-action="answer"
        >
          <Reply aria-hidden />
          Answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={disabled}
          title={blockedTitle}
          onClick={() => answer({ kind: "dismiss", id, title, ...(project === undefined ? {} : { project }) })}
          data-task-action="dismiss"
        >
          Dismiss
        </Button>
      </>
    );

  const box = answering ? (
    <form
      ref={form}
      className={cn(
        "flex items-start gap-2 max-sm:flex-wrap",
        placement === "row" ? "pb-2 pe-2 ps-9" : "rounded-lg border border-border bg-muted/30 p-3",
      )}
      data-task-form="answer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        // The box exists because Answer was pressed: typing starts at once.
        autoFocus
        rows={1}
        className={cn(fieldClass, "min-h-9 w-full flex-1 resize-y max-sm:basis-full")}
        aria-label={`Your answer to ${id}`}
        placeholder="Your answer"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setAnswering(false);
            return;
          }
          // Enter sends; Shift+Enter is a new line (Slack, Linear comments).
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <Button type="submit" size="sm" disabled={text.trim() === ""} data-task-confirm="answer">
        <SendHorizontal aria-hidden />
        Send
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(false)}>
        Cancel
      </Button>
    </form>
  ) : null;

  return { buttons, box };
}
