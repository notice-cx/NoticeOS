import { useState, type ReactNode } from "react";
import { TASK_RESOLUTION_LABELS, type TaskResolution } from "@noticeos/contract/task-resolution";
import { CloseAsMenu, CloseNoteForm, ResolutionChips, type NotDone } from "@/components/CloseResolution";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { useOwnerToast } from "@/lib/browser-context";

// The ways a close ends, with invented tasks: the task page's chip row over
// its line, a row's Close as menu opening its note, and the menu a read-only
// snapshot draws. A close toasts "Closed as …" with the Undo the Tower carries.

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={eyebrowClass}>{label}</span>
      {children}
    </div>
  );
}

/** The page's form: Done picked first, any other chip turns the box into one line. */
function PageForm() {
  const toast = useOwnerToast();
  const [resolution, setResolution] = useState<TaskResolution>("done");
  return (
    <div className="flex flex-col gap-2.5">
      <ResolutionChips value={resolution} onChange={(next) => setResolution(next)} />
      {resolution === "done" ? (
        <span className="text-sm text-muted-foreground">What shipped, and the commit</span>
      ) : (
        <CloseNoteForm
          key={resolution}
          id="os-8f7p.14"
          resolution={resolution}
          named={false}
          autoFocus={false}
          onCancel={() => setResolution("done")}
          onSend={() => toast.success(`Closed as ${TASK_RESOLUTION_LABELS[resolution]}`, { action: { label: "Undo", onClick: () => undefined } })}
        />
      )}
    </div>
  );
}

/** A row: the menu beside its verbs, and the picked resolution's line under it. */
function RowMenu() {
  const toast = useOwnerToast();
  const [picked, setPicked] = useState<NotDone | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-foreground">Print view for the task board</span>
        <span className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline">Answer</Button>
          <CloseAsMenu subject="Print view for the task board" onPick={setPicked} />
        </span>
      </div>
      {picked ? (
        <CloseNoteForm
          key={picked}
          id="os-8f7p.12"
          resolution={picked}
          autoFocus={false}
          onCancel={() => setPicked(null)}
          onSend={() => {
            toast.success(`Closed as ${TASK_RESOLUTION_LABELS[picked]}`, { action: { label: "Undo", onClick: () => undefined } });
            setPicked(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function CloseResolutionDemo() {
  return (
    <div className="grid w-full gap-6">
      <Example label="The task page's Close">
        <PageForm />
      </Example>
      <Example label="A row's Close as">
        <RowMenu />
      </Example>
      <Example label="A duplicate's line">
        <CloseNoteForm id="os-8f7p.13" resolution="duplicate" autoFocus={false} onCancel={() => undefined} onSend={() => undefined} />
      </Example>
      <Example label="Read-only">
        <CloseAsMenu subject="Print view for the task board" onPick={() => undefined} disabledReason="Make changes from the local NoticeOS." />
      </Example>
    </div>
  );
}
