import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import { connectedTaskSource, type TaskSourceId, type TaskSourcePayload } from "@shared/task-source";


/** The query every task screen shares; a config save refreshes it
 * (`CONFIG_BACKED_QUERIES`), since the saved task projects are part of it. */
export const TASK_SOURCE_KEY = ["task-source"] as const;

/** A saved project waits for the runner's first read. */
function collecting(data: TaskSourcePayload | undefined): boolean {
  const sources: unknown = (data as { sources?: unknown } | undefined)?.sources;
  return Array.isArray(sources) && sources.some((source: Partial<TaskSourcePayload["sources"][number]>) =>
    source?.connected === false && typeof source.projects === "number" && source.projects > 0);
}

export interface TaskSourceView {
  /** The actual snapshot connection, never a core feature flag. */
  connected: TaskSourceId | null;
  /** The first health answer has arrived or failed. */
  settled: boolean;
  isError: boolean;
  data: TaskSourcePayload | undefined;
}

/** Shared hub health query. Core navigation never depends on this answer. */
export function useTaskSource(): TaskSourceView {
  const { fetchTaskSource } = useTowerApi();
  const query = useQuery<TaskSourcePayload>({
    queryKey: TASK_SOURCE_KEY,
    queryFn: ({ signal }) => fetchTaskSource(signal),
    // Poll a saved project more often until its first snapshot lands;
    // the status beside Settings → Task projects then reflects that read.
    refetchInterval: (query) => (collecting(query.state.data) ? 5_000 : 60_000),
    staleTime: 30_000,
  });
  return {
    connected: connectedTaskSource(query.data),
    settled: !query.isPending,
    isError: query.isError,
    data: query.data,
  };
}
