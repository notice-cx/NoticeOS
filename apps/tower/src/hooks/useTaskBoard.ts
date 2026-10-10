import { useTasksAcross, useTasksLive, useTaskProjects } from "./useTasks";
import { useWork } from "./useWork";
import { catalogScope, readTaskBoard, taskBoardProjects, taskCatalogProjects, type TaskBoardFilters } from "@/lib/task-board-read";

/** The route receives one read with source limits and row actions already
 * decided — and the snapshot read's own state, so a failed first read is drawn
 * as a failure rather than a wait. */
export function useTaskBoard(scope: string | null, filters: TaskBoardFilters) {
  const capabilities = useTasksLive();
  const { data, isPending, isError, error, isFetching, refetch } = useWork();
  const catalog = useTaskProjects();
  const roster = capabilities.projectSelection ? taskCatalogProjects(catalog.data ?? [], data) : undefined;
  // A catalog board is addressed by logical key; an asset page scopes by site id.
  const key = roster === undefined ? scope : catalogScope(catalog.data ?? [], data, scope);
  const projects = roster === undefined ? taskBoardProjects(data, scope) : roster.filter(row => key === null || row.asset === key);
  const queries = useTasksAcross(projects.map(project => project.asset));
  const reads = new Map(projects.map((project, index) => [project.asset, queries[index]!]));
  return {
    data, scopeKey: key, isPending: capabilities.projectSelection ? catalog.isPending : isPending,
    isError: capabilities.projectSelection ? catalog.isError : isError,
    error: capabilities.projectSelection ? catalog.error : error,
    isFetching: isFetching || catalog.isFetching,
    refetch: capabilities.projectSelection ? catalog.refetch : refetch,
    ...readTaskBoard({ capabilities, snapshot: data, scope: key, reads, filters, roster }),
  };
}
