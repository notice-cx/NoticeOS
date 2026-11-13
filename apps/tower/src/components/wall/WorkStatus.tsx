import type { WorkCounts } from "@shared/work";
import { formatInt } from "@/lib/format";
import "./WorkStatus.css";

export type TaskStatusCounts = Pick<WorkCounts, "open" | "inProgress" | "blocked">;

export function WorkStatus({ counts, partial = false }: { counts: TaskStatusCounts | null; partial?: boolean }) {
  const facts = [
    { label: "Open", key: "open", value: counts?.open },
    { label: "Blocked", key: "blocked", value: counts?.blocked },
    { label: "In progress", key: "in-progress", value: counts?.inProgress },
  ];
  const total = counts ? counts.open + counts.inProgress : 0;
  const blocked = counts ? Math.min(counts.blocked, counts.open) : 0;
  return <div className="wall-task-status">
    <dl className="wall-task-status-facts">
      {facts.map(({ label, key, value }) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd data-task-status={key} data-has-blocked={key === "blocked" && !!value ? "" : undefined}>
            {value == null || (partial && value === 0)
              ? <span aria-label="Unavailable">—</span>
              : <>{partial ? <span aria-label="At least">≥</span> : null}{formatInt(value)}</>}
          </dd>
        </div>
      ))}
    </dl>
    {counts && (!partial || total > 0) ? <div className="wall-task-status-track" role="img" aria-label={`${partial ? "Observed tasks. " : ""}${formatInt(counts.open)} open, including ${formatInt(counts.blocked)} blocked. ${formatInt(counts.inProgress)} in progress.`}>
      <span data-task-status-part="open" style={{ flexGrow: counts.open - blocked }} />
      <span data-task-status-part="blocked" style={{ flexGrow: blocked }} />
      <span data-task-status-part="in-progress" style={{ flexGrow: counts.inProgress }} />
    </div> : null}
  </div>;
}
