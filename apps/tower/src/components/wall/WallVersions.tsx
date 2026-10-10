import { Undo2 } from "lucide-react";
import { wallLayoutWidgets, type WallLayoutVersion } from "@shared/wall-layout";
import { ageMs, formatAge } from "@shared/freshness";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "1 row", "3 rows" — a version line that says "1 rows" reads as a bug in the
 * thing it is describing. */
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface WallVersionsProps {
  history: WallLayoutVersion[];
  nowMs: number;
  /** Revert to the version at this index. It is a save like any other. */
  onRevert: (index: number) => void;
  /** The revert in flight, so one row says so instead of every row. */
  reverting: number | null;
  disabled?: boolean;
  className?: string;
}

/**
 * What the Wall used to show, and the way back. A revert is a save, not a pop:
 * the replaced layout joins the history, so a revert can itself be reverted.
 * It asks for no reason; the entry already carries its own.
 */
export function WallVersions({
  history,
  nowMs,
  onRevert,
  reverting,
  disabled = false,
  className,
}: WallVersionsProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} data-wall-versions>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Versions
      </h2>
      {history.length === 0 ? (
        <p className="border border-border bg-card p-3 text-xs leading-snug text-muted-foreground" data-wall-versions-empty>
          No saved versions yet
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {history.map((version, index) => (
            <li
              key={`${version.savedAt}-${index}`}
              data-wall-version={index}
              className="flex items-start justify-between gap-2 border border-border bg-card p-2.5"
            >
              <div className="min-w-0">
                <p className="text-xs leading-snug text-foreground">{version.reason}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  <time dateTime={version.savedAt}>
                    {formatAge(ageMs(nowMs, version.savedAt))} ago
                  </time>
                  {" · "}
                  {countOf(version.layout.rows.length, "row")}
                  {", "}
                  {countOf(wallLayoutWidgets(version.layout).length, "widget")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={disabled || reverting !== null}
                onClick={() => onRevert(index)}
              >
                <Undo2 className="size-4" />
                {reverting === index ? "Reverting…" : "Revert"}
              </Button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
