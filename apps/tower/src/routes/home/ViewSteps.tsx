import { useId, useState, type CSSProperties } from "react";
import { VIEW_LIBRARY, type ViewId } from "@shared/views";
import { Button } from "@/components/ui/button";
import { pillControlClass } from "@/components/ui/pill";
import { useView } from "@/hooks/useView";
import { cn } from "@/lib/utils";

/** One option's box: a 44 px target at least, its label over its detail. */
const optionBox = cn(
  "flex h-full min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-start",
  pillControlClass,
  "motion-safe:transition-colors",
);

const grid = "m-0 grid list-none gap-2 p-0";

/** A personal Home purpose, chosen in one press without changing workspace settings. */
export function ViewQuestions() {
  const { choice, source, setChoice } = useView();
  const [skipped, setSkipped] = useState(false);
  const headingId = useId();

  if (skipped || source === "person") return null;

  function pickView(view: ViewId) {
    setChoice({ view, focus: choice.focus });
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-foreground/40 p-4"
      data-first-run-question="view"
    >
      <h3 id={headingId} className="m-0 text-sm font-semibold text-foreground">
        What do you want to focus on?
      </h3>
      <ViewChoices onPick={pickView} labelledBy={headingId} />
      <Button type="button" size="sm" variant="ghost" className="self-start" data-view-skip="" onClick={() => setSkipped(true)}>
        Skip
      </Button>
    </section>
  );
}

/** The view question's options: one press per view. */
function ViewChoices({ onPick, labelledBy }: { onPick: (view: ViewId) => void; labelledBy: string }) {
  return (
    <ul className={cn(grid, "grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))]")} aria-labelledby={labelledBy}>
      {VIEW_LIBRARY.map((spec, index) => (
        <li key={spec.id} className="viz-arrive min-w-0" style={{ "--viz-i": index } as CSSProperties}>
          <button
            type="button"
            className={cn(optionBox, "border-border bg-card text-foreground hover:border-foreground/30 hover:bg-muted/60 active:bg-muted")}
            data-view-choice={spec.id}
            onClick={() => onPick(spec.id)}
          >
            <span className="text-sm font-medium">{spec.label}</span>
            <span className="text-xs text-muted-foreground">{spec.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
