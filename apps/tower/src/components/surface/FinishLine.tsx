import { ageMs, formatAge } from "@shared/freshness";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The end of a list the eye can finish: one line that says the list is done,
 * then how old the reading is. On an empty queue it is the whole list, so an
 * empty state and a finished state read the same way.
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

/** "data as of 4m ago": how old the reading behind a finished list is. */
export function readingAge(generatedAt: string | null, nowMs: number): string {
  const age = generatedAt ? ageMs(nowMs, generatedAt) : null;
  return `data as of ${age === null ? "unknown" : `${formatAge(age)} ago`}`;
}
