import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
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

/** Whether this installation has no task service connected: its tasks live
 * only there, so its Tasks pages lead to connecting Ntasks. False while the
 * status is unread or the ingest cannot say. */
export function needsNtasks(status: TaskServiceStatus | undefined): boolean {
  return status?.required === true && status.connected === false;
}

export function useNeedsNtasks(): boolean {
  return needsNtasks(useTaskService().data);
}
