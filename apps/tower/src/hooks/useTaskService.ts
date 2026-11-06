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
