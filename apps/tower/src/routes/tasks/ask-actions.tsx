import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Reply, SendHorizontal } from "lucide-react";
import type { TaskChoiceKey, TaskChoices } from "@noticeos/contract/task-choices";
import { ChoiceButtons } from "@/components/ChoiceButtons";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useInboxAnswer } from "@/hooks/useTasks";
import type { InboxAsk } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { useCloseAs } from "./close-actions";

/**
 * What a task waiting on the operator offers, for its board row and its own
 * page: Approve on a gate (`bd gate resolve`), Answer and Close as on an ask
 * (`bd human respond`, and `dismiss` with the resolution picked: Won't do,
 * Duplicate, Can't reproduce or Already handled), and on an ask that carries
 * choices one button per option (the choose operation) with Answer and Close
 * as under them, each after the Undo window (`lib/answer-queue.ts`). `buttons`
 * sit beside the title and `box` under it, because each surface seats them
 * differently; both are null when nothing is asked.
 */
export function useAskActions({
  ask,
  id,
  title,
  project,
  choices = null,
  disabledReason = null,
  chooseDisabledReason = disabledReason,
  describedBy,
  placement,
  onChosen,
}: {
  ask: InboxAsk | null;
  id: string;
  title: string;
  /** Explicit row selection; a detail page captures its current query selection. */
  project?: string;
  /** The options a choose ask offers. */
  choices?: TaskChoices | null;
  /** Why the verbs cannot run here (a read-only snapshot), or null. */
  disabledReason?: string | null;
  /** Why the options cannot be pressed here, when it differs from the verbs'. */
  chooseDisabledReason?: string | null;
  /** The header writes the reason as text beside the buttons; this is that
   * text's id. A row, which has no room for it, keeps it as the hover title. */
  describedBy?: string;
  /** The row indents the box under its title; the header sets it in a panel. */
  placement: "row" | "header";
  /** An option was pressed: the page holds it while the Undo window runs. */
  onChosen?: (option: TaskChoiceKey) => void;
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const answer = useInboxAnswer();
  // Declining is a close where nothing shipped: Won't do, or the resolution that says why.
  const closeAs = useCloseAs({
    id,
    title,
    ...(project === undefined ? {} : { project }),
    via: "dismiss",
    disabledReason,
    describedBy: placement === "header" ? describedBy : undefined,
    onOpen: () => setAnswering(false),
    boxClassName: placement === "row" ? "pb-2 pe-2 ps-9" : undefined,
  });
  // The box opens mid-screen, clear of the corner an Undo toast occupies on a
  // phone (a previous answer's toast would otherwise cover Send).
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (answering) form.current?.scrollIntoView?.({ block: "center" });
  }, [answering]);
  const disabled = disabledReason !== null;
  const blockedTitle = placement === "row" ? disabledReason ?? undefined : undefined;
  const describes = disabled && placement === "header" ? describedBy : undefined;
  const scope = project === undefined ? {} : { project };

  function send() {
    const words = text.trim();
    if (words === "") return;
    answer({ kind: "answer", id, title, text: words, ...scope });
    setText("");
    setAnswering(false);
  }

  if (ask === null) return { buttons: null, box: null };

  const choosing = ask === "choose" && choices !== null;
  // Under a set of options the free-text verbs step back: the options are
  // what this ask wants first.
  const answerVerbs = (
    <>
      <Button
        type="button"
        size="sm"
        variant={choosing || answering ? "outline" : "default"}
        aria-expanded={answering}
        disabled={disabled}
        title={blockedTitle}
        aria-describedby={describes}
        onClick={() => {
          setAnswering((open) => !open);
          closeAs.cancel();
        }}
        data-task-action="answer"
      >
        <Reply aria-hidden />
        Answer
      </Button>
      {closeAs.menu}
    </>
  );

  const buttons = ask === "approve" ? (
    <Button
      type="button"
      size="sm"
      disabled={disabled}
      title={blockedTitle}
      aria-describedby={describes}
      onClick={() => answer({ kind: "approve", id, title, ...scope })}
      data-task-action="approve"
    >
      <Check aria-hidden />
      Approve
    </Button>
  ) : choosing ? null : answerVerbs;

  const options = choosing ? (
    <ChoiceButtons
      choices={choices}
      className={placement === "row" ? "pb-2 pe-2 ps-9" : undefined}
      disabledReason={chooseDisabledReason}
      // A row has no reason text of its own to point at, so the options write it.
      describedBy={placement === "header" ? describedBy : undefined}
      onChoose={(option, note) => {
        const label = choices.options.find((entry) => entry.key === option)?.label;
        answer({ kind: "choose", id, title, option, ...(label === undefined ? {} : { label }), ...(note === undefined ? {} : { note }), ...scope });
        setAnswering(false);
        onChosen?.(option);
      }}
      footer={answerVerbs}
    />
  ) : null;

  const answerBox = answering ? (
    <form
      ref={form}
      className={cn(
        "flex items-start gap-2 max-sm:flex-wrap",
        placement === "row" ? "pb-2 pe-2 ps-9" : null,
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

  const box = options || answerBox || closeAs.box ? <>{options}{answerBox}{closeAs.box}</> : null;
  return { buttons, box };
}
