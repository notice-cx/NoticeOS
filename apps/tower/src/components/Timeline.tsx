import { MoreHorizontal } from "lucide-react";
import {
  lifecycleMoveSentence,
  parseLifecycleMoveRef,
  type AnnotationKind,
  type HandoffBead,
} from "@shared/asset-detail";
import { ageMs, formatAge } from "@shared/freshness";
import { ANNOTATION_KIND } from "@/components/annotation-kind";
import { EmptyState } from "@/components/EmptyState";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { cn } from "@/lib/utils";

export interface TimelineItem {
  id: number | string;
  at: string;
  kind: AnnotationKind;
  ref: string | null;
  note: string | null;
}

export interface TimelineProps {
  items: TimelineItem[];
  nowMs: number;
  /**
   * Beads filed against this asset, so an event whose `ref` IS one renders
   * the task that caused it rather than an opaque id (bead `ro-4ko`).
   *
   * `null` — the register could not be asked — falls back to the plain ref,
   * exactly as an unmatched one does. An event is never presented as
   * task-less; it is presented as an event whose ref we could not resolve.
   */
  beads?: HandoffBead[] | null;
  /** Older events the payload did not carry. Rendered as the last node, so a
   * timeline that stops early says so instead of passing itself off as the whole
   * history (ro-5e8.1). Absent or 0 means these ARE all the events. */
  olderCount?: number;
  className?: string;
}

/**
 * The annotation timeline (doc 10 asset-detail: the visual "did it help?"
 * surface — deploys, model changes, incidents, external events). Neutral by
 * design; the events are history, not attention. Times are relative with the
 * absolute on hover (doc 15 principle 7).
 */
export function Timeline({
  items,
  nowMs,
  beads = null,
  olderCount = 0,
  className,
}: TimelineProps) {
  const byId = new Map((beads ?? []).map((bead) => [bead.beadId, bead]));
  if (items.length === 0) {
    return (
      <EmptyState
        title="No timeline events yet"
        hint="Deploys, model changes, and external events land here as they happen."
      />
    );
  }
  const truncated = olderCount > 0;
  return (
    <ol className={cn("flex flex-col", className)}>
      {items.map((it, i) => {
        const meta = ANNOTATION_KIND[it.kind];
        const Icon = meta.icon;
        const isLast = !truncated && i === items.length - 1;
        // A lifecycle move (bead `ro-3085`) stores the two stages in its `ref`,
        // because that is the row's identity and the field Restore reads. The
        // ref is MACHINE text, so the row renders the sentence instead of it —
        // one representation of the move, in words (doc 14, doc 17).
        const move = parseLifecycleMoveRef(it.ref);
        return (
          <li key={it.id} className="flex gap-3 pb-4 last:pb-0">
            <div className="flex flex-col items-center">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
                <Icon className="size-3" />
              </span>
              {isLast ? null : <span aria-hidden className="mt-1 w-px flex-1 bg-border" />}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 pb-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-foreground">{meta.label}</span>
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  title={new Date(it.at).toISOString()}
                >
                  {formatAge(ageMs(nowMs, it.at))} ago
                </span>
              </div>
              {it.note ? <span className="text-sm text-foreground">{it.note}</span> : null}
              {/* ONE representation of the ref (doc 14). When it resolves to a
                  bead, the badge IS the ref rendered richer — id plus filed or
                  shipped — and never a second marker beside a mono string. A
                  commit sha, or a bead this snapshot does not carry, stays the
                  mono string it always was.

                  A CLOSED bead here is still not a measured outcome: the badge
                  says shipped-not-proven in its own hover, and the verdict comes
                  from a watch window carrying the same id
                  (docs/playbooks/task-key-chain.md). Nothing on this row may be
                  read as "and it worked". */}
              {move ? (
                <span className="text-sm text-foreground">{lifecycleMoveSentence(move)}</span>
              ) : it.ref && byId.has(it.ref) ? (
                <HandoffBeadBadge bead={byId.get(it.ref)!} />
              ) : it.ref ? (
                <span className="break-all font-mono text-xs text-muted-foreground">{it.ref}</span>
              ) : null}
            </div>
          </li>
        );
      })}
      {truncated ? (
        // The end of the read, said out loud. A history that simply stops reads
        // as a history that ends — so the cut names its own size, on a dashed
        // node that continues the line. "Not shown" already says the rows
        // exist; the sentence that restated it is gone (doc 21 principle 3a).
        <li className="flex gap-3" data-timeline-older={olderCount}>
          <div className="flex flex-col items-center">
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
              <MoreHorizontal className="size-3" />
            </span>
          </div>
          <span className="min-w-0 self-center text-sm font-medium text-foreground">
            {olderCount} older {olderCount === 1 ? "change" : "changes"} not shown
          </span>
        </li>
      ) : null}
    </ol>
  );
}
