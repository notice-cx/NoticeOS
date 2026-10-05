import { Check, Circle, CircleDashed, Minus } from "lucide-react";
import { Link } from "react-router-dom";
import type { SetupChecklist, SetupChecklistItem } from "@shared/asset-setup";

/**
 * Setup and historical-report progress on Sources, below the Data sources
 * rows. `assetSetupChecklist` controls which manual lifecycle stages show it;
 * completing a step does not verify current health. Each source's status is
 * its Data sources row above, so the sources step states only its count
 * (bead `ro-ujb9.96.7.16`: one status per subject per screen). Rows link to
 * their destination rather than offering editable checkboxes.
 *
 * ONE NAME, ONE COUNT (bead `ro-ujb9.164`). It is closed on arrival (bead
 * `ro-ujb9.96.7.5`: each source row above carries its own Connect, so the
 * checklist is the count, not the next step), and the disclosure IS the panel:
 * its summary carries the name the Overview's banner uses, "Data setup", and
 * the count once. It used to be a disclosure saying "Data setup · 1 of 2 checks
 * complete" around a panel saying "Setting up · 1 of 2 done" — two names and
 * the same count twice for one subject.
 */
export function SetupChecklistPanel({ setup, open = false }: { setup: SetupChecklist; open?: boolean }) {
  return (
    <details
      id="setup"
      open={open || undefined}
      className="scroll-mt-4 rounded-[10px] border border-border bg-card px-4"
      data-setup
    >
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
        Data setup · <span className="tabular-nums">{setup.done} of {setup.total} done</span>
      </summary>
      <ol className="m-0 flex list-none flex-col gap-3 p-0 pb-4" data-setup-checklist>
        {setup.items.map((item) => (
          <SetupChecklistRow key={item.id} item={item} />
        ))}
      </ol>
    </details>
  );
}

function SetupChecklistRow({ item }: { item: SetupChecklistItem }) {
  const done = item.state === "done";
  return (
    <li className="m-0 flex gap-2.5" data-setup-item={item.id} data-setup-state={item.state}>
      {/* The two shapes a task's status already uses for the same pair
          (`routes/tasks/task-face.tsx`): a tick for finished, an open circle
          for something nobody has taken yet. Neither is severity-colored — an unfinished setup step is
          not an alert. An optional step (bead `ro-ujb9.121`) is the dashed
          circle: offered, owed by nobody. An unavailable capability is a
          neutral dash, never a pending task or a successful check (D43). */}
      {done ? (
        <Check className="mt-0.5 size-4 shrink-0 text-connected" aria-hidden />
      ) : item.state === "optional" ? (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : item.state === "unavailable" ? (
        <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          {item.href ? (
            <Link
              to={item.href}
              // The 44px floor is CLAIMED rather than added (bead `ro-9smi`):
              // the box grows under a thumb and the negative margin hands the
              // height back to the line, so the list keeps its rhythm.
              className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-sm:-my-2.5 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
            >
              {item.label}
            </Link>
          ) : (
            <span className="font-medium">{item.label}</span>
          )}
          {item.state === "optional" || item.state === "unavailable" ? null : <span className="sr-only">{done ? "done" : "still to do"}</span>}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{item.note}</span>
      </div>
    </li>
  );
}
