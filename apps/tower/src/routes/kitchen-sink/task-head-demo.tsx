import { Check, Reply } from "lucide-react";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button } from "@/components/ui/button";
import type { BoardTask } from "@/lib/task-board-read";
import { EpicTaskList } from "@/routes/tasks/epic-tasks";
import { ClosedSummary, TaskHead, type TaskHeadFacts } from "@/routes/tasks/task-head";

// The task page's header in each state it is read in, with invented tasks:
// an epic with its progress, a task somebody holds, a decision waiting on the
// operator and a closed task with its reason. Each action is inert here.

const HOUR = 3_600_000;
const crumbs = (parent?: string) => [
  { label: "Tasks", to: "/tasks" },
  { label: "System", to: "/tasks?project=system", icon: <PropertyFavicon domain="system" displayName="System" className="size-4" /> },
  ...(parent ? [{ label: parent, to: "/tasks/os-8f7p" }] : []),
];
const base: Omit<TaskHeadFacts, "title"> = {
  issueType: "task", awaitType: null, status: "open", priority: 2, holder: null, ask: null, progress: null,
};

function row(over: Partial<BoardTask> & Pick<BoardTask, "id" | "title">): BoardTask {
  return {
    status: "open", priority: 2, issueType: "task", assignee: null, updatedAt: null, closedAt: null, parent: "os-8f7p",
    deferUntil: null, project: "system", labels: [], ready: false, awaitType: null, ...over,
  };
}

export function TaskHeadDemo() {
  const now = Date.now();
  return (
    <div className="flex w-full flex-col gap-6">
      <TaskHead
        id="os-8f7p"
        facts={{ ...base, title: "Tasks are managed in the Tower", issueType: "epic", priority: 1, progress: { closed: 2, total: 7 } }}
        crumbs={crumbs()}
        nowMs={now}
        actions={<><Button size="sm">Claim</Button><Button size="sm" variant="outline">Close</Button></>}
      />
      <EpicTaskList
        groups={[
          { word: "In progress", tasks: [row({ id: "os-8f7p.2", title: "A task has a page", status: "in_progress", assignee: "claude", priority: 1 })] },
          { word: "Ready", tasks: [row({ id: "os-8f7p.3", title: "The composer files a task from the board", ready: true })] },
          { word: "Done", tasks: [row({ id: "os-8f7p.1", title: "The Tower reads the task database", status: "closed" })] },
        ]}
        missing="1 more, closed over 7 days ago"
        graphHref="/tasks?epic=os-8f7p"
        taskHref={(id) => `/tasks/${id}`}
      />
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.2"
          facts={{ ...base, title: "A task has a page", status: "in_progress", priority: 1,
            holder: { name: "claude", model: "Opus 5.5", since: new Date(now - 3 * HOUR).toISOString() } }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
          actions={<Button size="sm">Close</Button>}
        />
      </div>
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.4"
          facts={{ ...base, title: "Approve the wording of the close form", issueType: "gate", awaitType: "human", priority: 1, ask: "approve" }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
          actions={<Button size="sm"><Check aria-hidden />Approve</Button>}
        />
      </div>
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.5"
          facts={{ ...base, title: "Which sentence goes over the close reason box?", ask: "answer" }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
          actions={<><Button size="sm"><Reply aria-hidden />Answer</Button><Button size="sm" variant="ghost">Dismiss</Button></>}
        />
      </div>
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.1"
          facts={{ ...base, title: "The Tower reads the task database", status: "closed", priority: 1 }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
        >
          <ClosedSummary by="claude" model="Opus 5.5" at={new Date(now - 30 * HOUR).toISOString()} nowMs={now}>
            <p className="m-0 text-sm">Landed in 1a2b3c4: the board and the task page read the same tasks.</p>
          </ClosedSummary>
        </TaskHead>
      </div>
    </div>
  );
}
