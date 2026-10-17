import { useState, type ReactNode } from "react";
import { TASK_RESOLUTION_LABELS } from "@noticeos/contract/task-resolution";
import { CloseAsMenu, CloseNoteForm, type NotDone } from "@/components/CloseResolution";
import { SelectBox, SelectionBar, SelectToggle, useSelection } from "@/components/SelectionBar";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { useOwnerToast } from "@/lib/browser-context";

// A list's Select with invented tasks: the toggle, a box on each row, the bar
// with its count, Select all or Clear, Close N as and the line it opens, and
// a duplicate's line with the sentence under its field.

const TASKS = [
  { id: "os-8f7p.21", title: "Retire the old FAQ page", closed: false },
  { id: "os-8f7p.22", title: "Move the sitemap to the new host", closed: false },
  { id: "os-8f7p.23", title: "Rename the weekly newsletter", closed: false },
  { id: "os-8f7p.24", title: "Fix the footer links", closed: true },
];

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={eyebrowClass}>{label}</span>
      {children}
    </div>
  );
}

/** The whole piece, pressable: Select, pick rows, Close N as, the line. */
function Live() {
  const toast = useOwnerToast();
  const selection = useSelection();
  const [picked, setPicked] = useState<NotDone | null>(null);
  const chosen = TASKS.filter((task) => selection.picked.has(task.id));
  const open = chosen.filter((task) => !task.closed);
  const closed = chosen.filter((task) => task.closed);
  return (
    <div className="flex flex-col rounded-md border border-border">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className={eyebrowClass}>All tasks</span>
        <SelectToggle selection={selection} />
      </div>
      {selection.selecting ? (
        <SelectionBar
          label="Selected tasks"
          subject="demo:selection"
          chosen={chosen.length}
          selectable={TASKS.length}
          detail={closed.length > 0 ? `${closed.length} closed already` : null}
          onAll={() => selection.pick(new Set(TASKS.map((task) => task.id)))}
          onNone={() => selection.pick(new Set())}
          actions={open.length > 0 ? <CloseAsMenu subject={`${open.length} tasks`} count={open.length} variant="outline" onPick={setPicked} /> : null}
          className="border-b px-4"
        >
          {picked !== null && open.length > 0 ? (
            <CloseNoteForm
              key={picked}
              id={open.map((task) => task.id)}
              resolution={picked}
              autoFocus={false}
              onCancel={() => setPicked(null)}
              onSend={() => {
                toast.success(`Closed as ${TASK_RESOLUTION_LABELS[picked]} · ${open.length}`, { action: { label: "Undo", onClick: () => undefined } });
                setPicked(null);
                selection.leave();
              }}
            />
          ) : null}
        </SelectionBar>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {TASKS.map((task) => (
          <li key={task.id} className="flex items-center gap-1 border-b border-border/40 px-2 py-0.5 text-sm last:border-b-0">
            {selection.selecting ? (
              <SelectBox checked={selection.picked.has(task.id)} onToggle={() => selection.flip(task.id)} label={task.title} className="size-8 max-sm:size-11" />
            ) : null}
            <span className="min-w-0 flex-1 py-1.5 text-foreground">{task.title}</span>
            <span className="text-xs text-muted-foreground">{task.closed ? "Closed" : "Open"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SelectionBarDemo() {
  return (
    <div className="grid w-full gap-6">
      <Example label="Select, then a verb for the picked rows">
        <Live />
      </Example>
      <Example label="Nothing picked">
        <SelectionBar label="Selected tasks" subject="demo:selection-none" chosen={0} selectable={4} onAll={() => undefined} onNone={() => undefined} actions={null} />
      </Example>
      <Example label="All picked, one closed already">
        <SelectionBar label="Selected tasks" subject="demo:selection-all" chosen={4} selectable={4} detail="1 closed already" onAll={() => undefined} onNone={() => undefined}
          actions={<CloseAsMenu subject="3 tasks" count={3} variant="outline" onPick={() => undefined} />} />
      </Example>
      <Example label="A duplicate's line for three tasks">
        <SelectionBar label="Selected tasks" subject="demo:selection-duplicate" chosen={3} selectable={4} onAll={() => undefined} onNone={() => undefined}
          actions={<CloseAsMenu subject="3 tasks" count={3} variant="outline" onPick={() => undefined} />}>
          <CloseNoteForm id={TASKS.slice(0, 3).map((task) => task.id)} resolution="duplicate" autoFocus={false} onCancel={() => undefined} onSend={() => undefined} />
        </SelectionBar>
      </Example>
    </div>
  );
}
