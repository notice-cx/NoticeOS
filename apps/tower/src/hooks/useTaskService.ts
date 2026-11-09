import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { TaskServiceStatus } from "@shared/tasks";

/** A connect or a disconnect in the Ntasks panel refreshes it. */
export const TASK_SERVICE_KEY = ["task-service"] as const;

/** Whether this installation's tasks live in Ntasks, and each saved project's Ntasks project. */
export function useTaskService() {
  const { fetchTaskService } = useTowerApi();
  return useQuery<TaskServiceStatus>({
    queryKey: TASK_SERVICE_KEY,
    queryFn: ({ signal }) => fetchTaskService(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * A task's page in the Ntasks web app, while this installation's tasks live in
 * Ntasks; null while they live in the local hub, or where the status is unread
 * or names no address. Ntasks takes a decision, an approval or a dispute only
 * from a person signed in to it, never from the installation's credential, so
 * there the Tower links to the task instead of drawing those buttons.
 */
export function ntasksTaskPage(status: TaskServiceStatus | undefined): ((id: string) => string) | null {
  if (status?.connected !== true || !status.origin) return null;
  const origin = status.origin;
  return (id) => `${origin}/tasks/${encodeURIComponent(id)}`;
}

/** Whether this installation has no task service connected: its tasks live
 * only there, so its Tasks pages lead to connecting Ntasks. False while the
 * status is unread or the ingest cannot say. */
export function needsNtasks(status: TaskServiceStatus | undefined): boolean {
  return status?.required === true && status.connected === false;
}

export function useNeedsNtasks(): boolean {
  return needsNtasks(useTaskService().data);
}

export function useNtasksTaskPage(): ((id: string) => string) | null {
  const { data } = useTaskService();
  return useMemo(() => ntasksTaskPage(data), [data]);
}
