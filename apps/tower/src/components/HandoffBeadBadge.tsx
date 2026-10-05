import { CircleDot, CircleCheck } from "lucide-react";
import { Link } from "react-router-dom";
import type { HandoffBead } from "@shared/asset-detail";
import { evidenceInstant } from "@shared/signal-liveness";
import { cn } from "@/lib/utils";

export interface HandoffBeadBadgeProps {
  /** The bead filed for this finding, or null — which renders nothing. */
  bead: HandoffBead | null;
  className?: string;
}

/**
 * Has this finding already been filed as work? (bead `ro-248`)
 *
 * The register knew and the finding could not see it: once an operator copied a
 * handoff and an agent ran the `bd create`, the card still presented the finding
 * as untouched open work, so the only way to answer "did I already file this?"
 * was to go and read the hub. This badge is that answer, joined by the
 * handoff's own `noticeos_key` (docs/playbooks/task-key-chain.md).
 *
 * TWO encodings and never a status word (doc 14): the GLYPH carries the state —
 * filled dot open, circle-check recorded closed. The visible text is the BEAD ID, because that is the one
 * thing the operator can act on: it is what `bd show` takes, what the commit
 * quotes, and what a watch window is keyed to.
 *
 * Both states stay MUTED, which is the whole design constraint. A finding's own
 * severity is its loudest fact and this must not rival it — a warning that has
 * been filed is still a warning. So the badge is a small gray pill either way,
 * and the finding's red rail keeps saying what it always said.
 *
 * A closed task records a decision, not shipment or a resolved finding. It may
 * have been declined; only separate evidence can establish what changed and
 * its outcome. Nothing here is green.
 *
 * Absence renders literally nothing — no pill, no dash, no "not filed". Most
 * findings have no bead, and a marker on every card announcing that would be
 * noise on the entire page to say nothing about any of it.
 *
 * THE ID IS A LINK, since 2026-09-04 (bead `ro-l1ed.3`). It always claimed to
 * be the actionable string, and until the task page existed the only thing an
 * operator could do with it was select it and paste it into `bd show` in a
 * terminal. Now it opens `/tasks/<id>` — the whole bead, its conversation, and
 * the finding it came from. One change here reaches every surface that renders
 * this badge: the findings list, the query and page decision tables, and the
 * asset timeline's resolved refs.
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
