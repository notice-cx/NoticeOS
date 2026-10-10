// The task hub's health as the Tower reads it. Tasks is always part of
// NoticeOS: these readings describe hub availability and never gate navigation.

import { isAmber } from "./freshness";
import type { ConnectionKind } from "./connection-status";
import { TASK_PROJECTS_PATH } from "./tasks";
import { WORK_POLL_CADENCE_HOURS } from "./work";

/** The Dolt-backed task hub. An id, never a label: what a person reads is
 * `TASK_SOURCES[id].name`. */
export const BEADS = "beads" as const;

/** The core hub adapters whose health this Tower can read. */
export const TASK_SOURCE_IDS = [BEADS] as const;
export type TaskSourceId = (typeof TASK_SOURCE_IDS)[number];

/** The hub name and its existing project management surface. */
export const TASK_SOURCES: Readonly<Record<TaskSourceId, { name: string; setupPath: string }>> = {
  beads: { name: "Beads", setupPath: TASK_PROJECTS_PATH },
};

/**
 * The task prefix a new project is offered for a site: the letters of the
 * domain's first label, two to eight of them (`task-hub-spokes`' own rule), or
 * nothing when it has fewer than two. An existing project keeps its own prefix
 * by typing over it.
 */
export function suggestedTaskPrefix(domain: string): string {
  const letters = (domain.split(".")[0] ?? "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 8);
  return letters.length >= 2 ? letters : "";
}

/** Where core task projects are managed. */
export const TASK_SOURCES_PATH = TASK_PROJECTS_PATH;

/** Core task database health beside the saved project mappings. */
export interface TaskSourceStatus {
  id: TaskSourceId;
  /** The latest snapshot listed at least one project, including failed reads. */
  connected: boolean;
  /** Saved task projects. */
  projects: number;
  /** When the source was last read; null when it never has been. */
  readAt: string | null;
  /** Projects that read could not open. */
  failing: number;
}

/** `GET /api/task-source`. */
export interface TaskSourcePayload {
  /** The hub whose snapshot listed projects, or null when none were read. */
  connected: TaskSourceId | null;
  sources: TaskSourceStatus[];
}

/**
 * The one word a task source's row wears, in the connection vocabulary every
 * Integrations row uses: Not connected until a project is saved, Collecting
 * until the first read lands, then Working, Overdue once the runner's read is
 * older than twice its cadence, or Failing when no project could be read.
 */
export function taskSourceConnection(status: TaskSourceStatus, nowMs: number): ConnectionKind {
  if (!status.connected) return status.projects > 0 ? "collecting" : "not-connected";
  if (isAmber(nowMs, status.readAt, WORK_POLL_CADENCE_HOURS)) return "overdue";
  return status.failing > 0 && status.failing >= status.projects ? "failing" : "working";
}

/** Read an actual snapshot answer; an unknown reply cannot prove a connection. */
export function connectedTaskSource(payload: unknown): TaskSourceId | null {
  if (payload === null || typeof payload !== "object") return null;
  const connected = (payload as { connected?: unknown }).connected;
  if (connected === null) return null;
  return (TASK_SOURCE_IDS as readonly unknown[]).includes(connected) ? (connected as TaskSourceId) : null;
}
