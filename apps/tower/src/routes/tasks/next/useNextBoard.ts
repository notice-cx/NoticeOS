import { useNow } from "@/hooks/useNow";
import { useOperatorRate } from "@/hooks/useOperatorRate";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { useOwnerAnswers } from "@/lib/browser-context";
import { rankBoard } from "@/lib/task-ranking";
import { UNFILTERED } from "./next-read";

/**
 * One board read, ranked. A decision answered here or on the board leaves at
 * once and comes back on Undo, exactly as the board's queue does, because both
 * read the same answer queue; it is left out of every list, so a question the
 * operator just answered never reappears as the agents' ready work.
 */
export function useNextBoard(scope: string | null) {
  const now = useNow();
  const read = useTaskBoard(scope, UNFILTERED);
  const operatorRateUsdPerMin = useOperatorRate();
  const { hides } = useOwnerAnswers();
  const inbox = read.inbox.filter(({ project, task }) => !hides(task.id, project.readAt));
  const hidden = new Set(read.inbox.filter((row) => !inbox.includes(row)).map((row) => row.task.id));
  const ranked = rankBoard({
    tasks: hidden.size === 0 ? read.allTasks : read.allTasks.filter((task) => !hidden.has(task.id)),
    inbox: inbox.map((row) => row.task),
    operatorRateUsdPerMin,
    now: new Date(now),
  });
  return { ...read, now, inbox, answered: hidden.size, ranked };
}

export type NextBoard = ReturnType<typeof useNextBoard>;
