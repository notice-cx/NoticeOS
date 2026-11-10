import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

/** A task's state, as the Ntasks UI on /tasks draws it (Ntasks docs/design.md, Symbols). */
export type TaskStatusKey = "waiting" | "in-progress" | "open" | "blocked" | "parked" | "done";

const LABEL: Readonly<Record<TaskStatusKey, string>> = {
  waiting: "Waiting for you",
  "in-progress": "In progress",
  open: "Open",
  blocked: "Blocked",
  parked: "Parked",
  done: "Done",
};

const SHAPE: Readonly<Record<TaskStatusKey, ReactElement>> = {
  open: <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" />,
  "in-progress": (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-primary" strokeWidth="1.5" />
      <path d="M7 3.75a3.25 3.25 0 0 1 0 6.5z" className="fill-primary" />
    </>
  ),
  blocked: (
    <>
      <circle cx="7" cy="7" r="6" className="fill-task-block" />
      <rect x="3.6" y="6.15" width="6.8" height="1.7" rx=".85" className="fill-background" />
    </>
  ),
  waiting: (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-task-wait" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2.4" className="fill-task-wait" />
    </>
  ),
  parked: <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="2.4 1.72" />,
  done: (
    <>
      <circle cx="7" cy="7" r="6" className="fill-task-done" />
      <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" className="stroke-background" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

/**
 * One of Precise's six status circles, 14px in a row. Its accessible name is
 * the state, or `label`; `label={null}` hides it beside words that say the
 * same.
 */
export function TaskStatusMark({ status, label, size = 14, className }: {
  status: TaskStatusKey;
  label?: string | null;
  size?: number;
  className?: string;
}) {
  const name = label === undefined ? LABEL[status] : label;
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn("block shrink-0", className)}
      data-task-status={status}
      {...(name === null ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      {SHAPE[status]}
    </svg>
  );
}
