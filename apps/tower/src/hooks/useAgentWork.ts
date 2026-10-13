import { useClosedHistoryAcross, useTaskProjects, useTasksAcross, useTasksLive } from "./useTasks";
import { useWork } from "./useWork";
import { readAgentWork, type AgentProjectRead, type AgentWork } from "@/lib/agent-work";
import { taskBoardProjects, taskCatalogProjects } from "@/lib/task-board-read";

export interface AgentWorkRead {
  /** The task server reads tasks live; without it there is no history to draw. */
  live: boolean;
  /** Projects to read, as the board lists them. */
  projects: number;
  /** Every project's board and history read answered. */
  complete: boolean;
  pending: boolean;
  /** Projects whose read failed, by name. */
  broken: string[];
  work: AgentWork | null;
}

/**
 * The Agents page's read: each project's board (shared with Tasks, so the
 * two never disagree about what is in hand) and its eight weeks of closed
 * work, read beside it.
 */
export function useAgentWork(nowMs: number): AgentWorkRead {
  const capabilities = useTasksLive();
  const snapshot = useWork();
  const catalog = useTaskProjects();
  const roster = capabilities.projectSelection
    ? taskCatalogProjects(catalog.data ?? [], snapshot.data)
    : taskBoardProjects(snapshot.data, null);
  const keys = roster.map((project) => project.asset);
  const boards = useTasksAcross(keys);
  const histories = useClosedHistoryAcross(keys);
  if (!capabilities.live) return { live: false, projects: roster.length, complete: false, pending: false, broken: [], work: null };
  const reads: AgentProjectRead[] = [];
  const broken: string[] = [];
  roster.forEach((project, index) => {
    const board = boards[index], history = histories[index];
    if (board?.isError || history?.isError) broken.push(project.name);
    const payloads = [board?.data, history?.data].filter((payload) => payload !== undefined && payload.project === project.asset);
    if (payloads.length === 0) return;
    reads.push({
      project: project.asset,
      name: project.name,
      tasks: payloads.flatMap((payload) => payload!.tasks),
      actors: payloads.find((payload) => payload!.actors)?.actors,
    });
  });
  const pending = boards.some((query) => query.isPending) || histories.some((query) => query.isPending)
    || (capabilities.projectSelection ? catalog.isPending : snapshot.isPending);
  const historyComplete = histories.length > 0 && histories.every((query) => query.isSuccess);
  return {
    live: true,
    projects: roster.length,
    complete: historyComplete && boards.every((query) => query.isSuccess),
    pending,
    broken,
    work: reads.length > 0 ? readAgentWork(reads, nowMs, historyComplete) : null,
  };
}
