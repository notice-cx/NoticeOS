import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloseAsMenu, CloseNoteForm, type NotDone } from "@/components/CloseResolution";
import { useInboxAnswer } from "@/hooks/useTasks";

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
