import { CircleDot, CircleCheck } from "lucide-react";
import { Link } from "react-router-dom";
import type { HandoffBead } from "@shared/asset-detail";
import { evidenceInstant } from "@shared/signal-liveness";
import { cn } from "@/lib/utils";

export interface HandoffBeadBadgeProps {
  /** The task filed for this finding, or null, which renders nothing. */
  bead: HandoffBead | null;
  className?: string;
}

/**
 * Whether a finding has already been filed as work, joined by the handoff's
 * `noticeos_key`. The glyph carries the state; the visible text is the task id,
 * linked to `/tasks/<id>`. Both states stay muted so the finding's own severity
 * stays its loudest fact, and nothing is green: a closed task records a
 * decision, not shipment or outcome. No task renders nothing.
 */
export function HandoffBeadBadge({ bead, className }: HandoffBeadBadgeProps) {
  if (!bead) return null;
  const closedAt = evidenceInstant(bead.closedAt, Date.now());

  const face =
    bead.status === "closed"
      ? {
          Icon: CircleCheck,
          tone: "bg-muted/60 text-muted-foreground",
          label: "Task recorded closed; outcome not verified",
          // The badge is the link to the task, so the hover names only what
          // the glyph cannot: when it closed, and what closing does not prove.
          title: `Task ${bead.beadId} ${closedAt ? `closed ${closedAt.slice(0, 10)}` : "recorded closed"} — not proof of shipment or outcome`,
        }
      : {
          Icon: CircleDot,
          tone: "bg-muted text-foreground",
          label: "Filed as work, still open",
          title: "Filed as work, still open",
        };

  return (
    <Link
      to={`/tasks/${encodeURIComponent(bead.beadId)}`}
      aria-label={`${face.label}, task ${bead.beadId}`}
      title={face.title}
      data-handoff-bead={bead.status}
      data-handoff-bead-id={bead.beadId}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        face.tone,
        className,
      )}
    >
      <face.Icon className="size-3" aria-hidden />
      {bead.beadId}
    </Link>
  );
}
