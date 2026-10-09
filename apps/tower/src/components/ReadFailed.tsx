import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { SeverityDot } from "@/components/SeverityDot";
import type { StatusSubject } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Why a read failed, in two words: the status the Tower answered with, or no
 * answer at all (the browser's fetch itself failed). */
export function readFailureReason(error: unknown): string {
  return error instanceof ApiError ? `HTTP ${error.status}` : "No answer";
}

export interface ReadFailedProps {
  /** What could not be loaded, as the page's own noun: "Couldn't load alerts". */
  title: string;
  /** What this state is about, drawn as `data-status-for`. */
  subject: StatusSubject;
  /** A fact naming WHICH one, ahead of the reason (the asset page's id). */
  detail?: ReactNode;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  /** `desk` sits where the page's first answer would; `wall` is the whole TV. */
  surface?: "desk" | "wall";
}

/**
 * A PAGE WHOSE FIRST READ FAILED (bead `ro-ujb9.218`; the asset page's since
 * bead `ro-78qo.2`).
 *
 * Home, Sites, Alerts, Tasks and the Wall said "Waiting for the store…" when
 * their read failed — a patient wait over a problem (the 2026-07 audit's finding 15: a failed read
 * never looks like loading or empty). This is the one state every page draws
 * instead: the error dot, what could not be loaded, why as a fact (the HTTP
 * status, or no answer), and Try again. No sentence. The asset page drew the
 * same state privately; it uses this one now.
 *
 * A page that already HAS a reading keeps it through a failed poll (TanStack
 * keeps `data`), so this is only ever the first read — and the TV's own poll
 * keeps trying underneath it, so the Wall recovers by itself.
 */
export function ReadFailed({
  title,
  subject,
  detail,
  error,
  retrying,
  onRetry,
  surface = "desk",
}: ReadFailedProps) {
  const wall = surface === "wall";
  return (
    <div
      className={
        wall
          ? "wall-root grid min-h-screen place-items-center bg-background p-6"
          : "grid min-h-[40vh] flex-1 place-items-center"
      }
    >
      {/* The dot rides the title's line; the reason and the button hang under
          the title, so the eye reads mark → what → why → what to do. The TV's
          copy is read from across a room, so it is a step larger. */}
      <div
        role="status"
        data-read-failed={surface}
        data-status-for={subject}
        className={cn("grid grid-cols-[auto_1fr] items-center gap-x-2", wall ? "gap-y-2" : "gap-y-1")}
      >
        <SeverityDot severity="error" size={wall ? "lg" : "md"} title="Read failed" />
        <span className={cn("font-medium text-foreground", wall ? "text-2xl" : "text-base")}>{title}</span>
        <span className={cn("col-start-2 tabular-nums text-muted-foreground", wall ? "text-lg" : "text-sm")}>
          {detail ? <>{detail} · </> : null}
          {readFailureReason(error)}
        </span>
        <div className="col-start-2 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={cn("size-4", retrying && "animate-spin")} />
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        </div>
      </div>
    </div>
  );
}
