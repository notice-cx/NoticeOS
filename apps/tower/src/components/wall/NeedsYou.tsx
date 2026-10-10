import { CircleCheck, UserRoundCheck } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { unreadOperatorPosture, type OperatorPosture, type SystemBand } from "@shared/wall";
import { SEVERITY_SHAPE } from "@/components/SeverityDot";
import { operatorState } from "@/lib/operator-posture";
import { withSystemIssues } from "@/lib/wall-system-state";
import { needsYouRows, type WallIssue, type WallIssueSeverity } from "@/lib/wall-issues";

// The top three things that need the operator, errors first then newest, each
// with its site, one line and its age, staying put until it resolves. The list
// is `lib/wall-issues`, the same one a site row's issue mark reads, so the two
// never disagree.

export interface NeedsYouProps {
  /** Every open problem, in `wallIssues` order. */
  issues: readonly WallIssue[];
  /** The core inbox's counts; null/absent remains unknown, never all-clear. */
  operator?: OperatorPosture | null;
  /** Specific OS/scheduler/spend problems share the action list. */
  system?: SystemBand;
  nowMs: number;
}

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

/** The severity as a shape, not only a colour: a circle for an error,
 * a triangle for a warning — the desk's `SeverityDot` shapes, one map. */
export function IssueGlyph({ severity, className }: { severity: WallIssueSeverity; className?: string }) {
  const Glyph = SEVERITY_SHAPE[severity];
  return (
    <Glyph
      className={`${severity === "error" ? "text-error" : "text-warn"} ${className ?? ""}`}
      aria-label={severity === "error" ? "Error" : "Warning"}
      role="img"
    />
  );
}

/** The human-gate count beside the heading, as the rail's own inbox rule reads
 * it: a zero is calm only when every project was counted and the count is
 * fresh; anything less says so rather than printing 0. */
function urgentLabel(operator: OperatorPosture | null | undefined, nowMs: number): string | null {
  const state = operatorState(operator, nowMs);
  if (!state || !operator) return null;
  if (!state.urgentComplete) {
    return operator.urgentMeasuredProjects > 0 ? `${operator.urgent}+ urgent tasks` : "Tasks unknown";
  }
  // A count is a count however old the photograph (`operatorLabel`); only a
  // stale zero is unknown rather than calm.
  if (operator.urgent > 0) return `${operator.urgent} urgent ${operator.urgent === 1 ? "task" : "tasks"}`;
  return state.stale ? "Tasks stale" : null;
}

export function NeedsYou({ issues, operator, system, nowMs }: NeedsYouProps) {
  const { shown, total } = needsYouRows(withSystemIssues(issues, system, nowMs));
  const urgent = urgentLabel(operator ?? unreadOperatorPosture(), nowMs);
  const conditions = new Set<string>(["open-flags", "human-gates"]);
  if (system) for (const condition of ["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"]) conditions.add(condition);
  for (const issue of shown) for (const condition of issue.conditions) conditions.add(condition);

  return (
    <section
      aria-label="Needs you"
      className="flex min-w-0 flex-col gap-3"
      data-wall-needs={total > 0 ? "rows" : "calm"}
      data-material-condition={[...conditions].join(" ")}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Needs you</h2>
        {total > 0 || urgent ? (
          <span className="inline-flex items-center gap-1.5 text-wall-micro text-muted-foreground tabular-nums" data-needs-meta>
            {total > 0 ? `${shown.length} of ${total}` : null}
            {total > 0 && urgent ? " · " : null}
            {urgent ? (
              <span className="inline-flex items-center gap-1" data-material-condition="human-gates">
                <UserRoundCheck className="size-4" aria-hidden />
                {urgent}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <div
          className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground"
          data-needs-calm
        >
          <CircleCheck className="size-6 shrink-0 text-healthy" aria-hidden />
          {/* An urgent task is still something that needs the operator; the
              calm line then only says nothing is broken. */}
          {urgent ? "Nothing broken" : "Nothing needs you"}
        </div>
      ) : (
        <ol className="flex min-w-0 flex-col gap-3">
          {shown.map((issue) => {
            const age = issue.since ? ageMs(nowMs, issue.since) : null;
            return (
              <li
                key={issue.key}
                role={issue.key === "calendar-read" ? "alert" : undefined}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg bg-muted/60 px-4 py-3"
                data-needs-row={issue.severity}
                data-material-condition={issue.conditions.join(" ") || undefined}
              >
                <IssueGlyph severity={issue.severity} className="size-5 shrink-0" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-wall-list-label font-semibold text-muted-foreground" data-needs-site>
                    {issue.site}
                  </span>
                  <span className="line-clamp-2 text-wall-list-line font-medium" data-needs-line>
                    {issue.line}
                  </span>
                </div>
                <span className="text-wall-list-meta text-muted-foreground tabular-nums" data-needs-age>
                  {age === null ? "" : formatAge(Math.max(0, age))}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
