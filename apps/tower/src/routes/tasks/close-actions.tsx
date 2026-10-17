import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloseAsMenu, CloseNoteForm, type NotDone } from "@/components/CloseResolution";
import { useInboxAnswer, useInboxAnswers } from "@/hooks/useTasks";

/** A task waiting on a person (labelled `human`) is declined with the
 * resolution, the operation its Dismiss ran; any other task is closed with it. */
export function declinedOnClose(task: { readonly labels: readonly string[] }): boolean {
  return task.labels.includes("human");
}

/** The task operation a workspace must offer for that close. */
export function closeOperation(task: { readonly labels: readonly string[] }): "dismiss" | "close" {
  return declinedOnClose(task) ? "dismiss" : "close";
}

/**
 * A close where nothing shipped, on a task's row: the Close as menu beside the
 * row's verbs and, once one is pressed, its one-line note under the row, sent
 * on Enter through the inbox's Undo window (`lib/answer-queue.ts`). A question
 * waiting on the operator is declined with the resolution (`via: "dismiss"`),
 * the operation its Dismiss ran.
 */
export function useCloseAs({
  id,
  title,
  project,
  via,
  disabledReason = null,
  describedBy,
  onOpen,
  boxClassName,
}: {
  id: string;
  title: string;
  /** Explicit row selection, as an ask's verbs take it. */
  project?: string;
  via?: "dismiss";
  /** Why the menu cannot be pressed here, written beside it, or null. */
  disabledReason?: string | null;
  /** Where the surface already writes `disabledReason`. */
  describedBy?: string;
  /** The note opened: the caller closes whatever else it had open under the row. */
  onOpen?: () => void;
  boxClassName?: string;
}): { menu: ReactNode; box: ReactNode; cancel: () => void } {
  const [picked, setPicked] = useState<NotDone | null>(null);
  const answer = useInboxAnswer();
  // The note opens mid-screen, clear of the corner an Undo toast occupies on a phone.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picked !== null) box.current?.scrollIntoView?.({ block: "center" });
  }, [picked]);

  const menu = (
    <CloseAsMenu
      subject={title}
      disabledReason={disabledReason}
      describedBy={describedBy}
      onPick={(resolution) => {
        setPicked(resolution);
        onOpen?.();
      }}
    />
  );
  const form = picked === null ? null : (
    <div ref={box} className={boxClassName}>
      <CloseNoteForm
        // A new pick starts a new line.
        key={picked}
        id={id}
        resolution={picked}
        onCancel={() => setPicked(null)}
        onSend={(close) => {
          answer({ kind: "close", id, title, resolution: picked, ...close, ...(via === undefined ? {} : { via }),
            ...(project === undefined ? {} : { project }) });
          setPicked(null);
        }}
      />
    </div>
  );
  return { menu, box: form, cancel: () => setPicked(null) };
}

/** One selected task a selection's close sends. */
export interface SelectedClose {
  id: string;
  title: string;
  /** Explicit row selection, as an ask's verbs take it. */
  project?: string;
  via?: "dismiss";
}

/**
 * A selection's close where nothing shipped: Close N as over the four
 * resolutions, then one line for every selected task (one Note, and a
 * duplicate's other task), and each task's own close through one Undo
 * (`useInboxAnswers`). Never Done: a done close carries its own evidence.
 * `closedAlready` are selected tasks that were closed when the selection was
 * read; the close leaves them as they are and its message names them.
 */
export function useCloseSelected({
  tasks,
  closedAlready = [],
  onOpen,
  onSent,
}: {
  tasks: readonly SelectedClose[];
  closedAlready?: readonly string[];
  /** The line opened: the caller closes whatever else it had open under the bar. */
  onOpen?: () => void;
  /** The closes were handed to the Undo window; the caller leaves selecting. */
  onSent: () => void;
}): { menu: ReactNode; line: ReactNode; cancel: () => void } {
  const [picked, setPicked] = useState<NotDone | null>(null);
  const answerAll = useInboxAnswers();
  const count = tasks.length;
  const menu = count > 0 ? (
    <CloseAsMenu
      subject={`${count} ${count === 1 ? "task" : "tasks"}`}
      count={count}
      variant="outline"
      onPick={(resolution) => {
        setPicked(resolution);
        onOpen?.();
      }}
    />
  ) : null;
  const line = picked === null || count === 0 ? null : (
    <CloseNoteForm
      key={picked}
      id={tasks.map((task) => task.id)}
      resolution={picked}
      onCancel={() => setPicked(null)}
      onSend={(close) => {
        answerAll(tasks.map((task) => ({ kind: "close" as const, id: task.id, title: task.title, resolution: picked, ...close,
          ...(task.via === undefined ? {} : { via: task.via }), ...(task.project === undefined ? {} : { project: task.project }) })),
        { closedAlready });
        setPicked(null);
        onSent();
      }}
    />
  );
  return { menu, line, cancel: () => setPicked(null) };
}
