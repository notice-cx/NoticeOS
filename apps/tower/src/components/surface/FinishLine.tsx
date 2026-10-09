import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * THE END OF A LIST THE EYE CAN FINISH (D44; Home's brief was the first
 * caller — Intuit's and Pivotlog's empty-state guidance in
 * docs/briefs/2026-10-08-home-overview-redesign.md). One line that says the
 * list is done ("That's every open alert."), then how old the reading is. On
 * an empty queue it is the whole list ("Nothing waits on you."), so an empty
 * state and a finished state read the same way.
 *
 * *Registry justification:* `StatusBanner` asks for an action; a `ListPanel`'s
 * empty line is a muted sentence inside a panel. Neither marks the end of a
 * queue a person has just worked through.
 */
export interface FinishLineProps {
  /** The one sentence. */
  line: string;
  /** "data as of 4m ago", "read 1m ago"; null when there is no reading age. */
  age?: string | null;
  /** The list was empty from the start: the line is the whole list. */
  quiet?: boolean;
  className?: string;
  marks?: Record<`data-${string}`, string>;
}

export function FinishLine({ line, age, quiet = false, className, marks }: FinishLineProps) {
  return (
    <Card
      kind="neutral"
      data-finish-line={quiet ? "quiet" : ""}
      className={cn("flex min-h-20 flex-col items-center justify-center gap-1 border-dashed p-4 text-center", className)}
      {...marks}
    >
      <span className="text-sm font-medium text-foreground">{line}</span>
      {age ? <span className="text-xs tabular-nums text-muted-foreground">{age}</span> : null}
    </Card>
  );
}
