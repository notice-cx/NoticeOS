import { SelectionBar } from "@/components/SelectionBar";
import { formatInt } from "@/lib/format";
import type { BoardTask } from "@/lib/task-board-read";
import { declinedOnClose, useCloseSelected } from "./close-actions";

/**
 * The All tasks table's Select: one verb, Close N as, which closes every
 * selected open task with one resolution and one note through one Undo, the
 * same close a row's Close as sends. A selected task that is closed already
 * is counted beside the selection, left as it is, and named in the message.
 * The rows are whatever the board's filters show.
 */
export function TaskSelection({ chosen, selectable, onPick, onSent }: {
  chosen: readonly BoardTask[];
  selectable: readonly BoardTask[];
  onPick: (ids: ReadonlySet<string>) => void;
  /** The closes were handed to the Undo window; the caller leaves selecting. */
  onSent: () => void;
}) {
  const open = chosen.filter((task) => task.status !== "closed");
  const closed = chosen.filter((task) => task.status === "closed");
  const closeAs = useCloseSelected({
    tasks: open.map((task) => ({ id: task.id, title: task.title, project: task.project,
      ...(declinedOnClose(task) ? { via: "dismiss" as const } : {}) })),
    closedAlready: closed.map((task) => task.id),
    onSent,
  });
  return (
    <SelectionBar
      label="Selected tasks"
      subject="selection:tasks"
      marks={{ "data-tasks-selection": "" }}
      chosen={chosen.length}
      selectable={selectable.length}
      detail={closed.length > 0 ? `${formatInt(closed.length)} closed already` : null}
      onAll={() => onPick(new Set(selectable.map((task) => task.id)))}
      onNone={() => onPick(new Set())}
      actions={closeAs.menu}
      className="border-b px-4"
    >
      {closeAs.line}
    </SelectionBar>
  );
}
