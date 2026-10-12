import { ListTodo } from "lucide-react";
import type { AssetCard, OperatorPosture } from "@shared/wall";
import { WorkFlow } from "@/components/viz/WorkFlow";
import { operatorWaiting } from "@/lib/operator-posture";
import { workFlowRows } from "@/lib/viz-adapters";

// The work as flow on the TV: what waits on the operator, what is in
// progress, done this week and blocked, then one row per project, done
// growing left and the open queue right. Read-only: no row links anywhere.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

export interface WallWorkProps {
  assets: readonly AssetCard[];
  /** The core inbox; null or absent stays unknown, never zero. */
  operator: OperatorPosture | null | undefined;
  nowMs: number;
}

export function WallWork({ assets, operator, nowMs }: WallWorkProps) {
  const rows = workFlowRows(assets);
  const waiting = operatorWaiting(operator, nowMs);
  // Nothing read at all (no task source yet, or no snapshot): one quiet line,
  // the words Needs you uses, rather than a chart of unknowns.
  if (rows.length === 0 && waiting === null) {
    return (
      <section
        aria-label="Work this week"
        className="flex min-w-0 items-center gap-3 text-wall-body text-muted-foreground"
        data-wall-work="none"
        data-material-condition="human-gates"
      >
        <ListTodo className="size-6 shrink-0" aria-hidden />
        Tasks unknown
      </section>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-wall-work>
      <WorkFlow rows={rows} waiting={waiting} title="Work this week" compact headingClassName={eyebrow} />
    </div>
  );
}
