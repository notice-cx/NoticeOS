// Synthetic snapshot health for component tests; never a core feature flag.
// Cases can keep it pending or unavailable without hiding Tasks.

import type { TaskSourceId } from "@shared/task-source";
import type { TaskSourceView } from "@/hooks/useTaskSource";

export const TASK_SOURCE_KEY = ["task-source"] as const;

export const taskSourceMock: { connected: TaskSourceId | null; settled: boolean } = {
  connected: "beads",
  settled: true,
};

export function resetTaskSourceMock(): void {
  taskSourceMock.connected = "beads";
  taskSourceMock.settled = true;
}

export function useTaskSource(): TaskSourceView {
  return { connected: taskSourceMock.connected, settled: taskSourceMock.settled, isError: false, data: undefined };
}
