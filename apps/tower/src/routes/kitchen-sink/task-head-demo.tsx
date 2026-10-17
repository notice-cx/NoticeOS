import { Check, Reply } from "lucide-react";
import type { TaskChoices } from "@noticeos/contract/task-choices";
import { ChoiceButtons } from "@/components/ChoiceButtons";
import { CloseAsMenu } from "@/components/CloseResolution";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button } from "@/components/ui/button";
import type { BoardTask } from "@/lib/task-board-read";
import { EpicTaskList } from "@/routes/tasks/epic-tasks";
import { ChoiceSummary, ClosedSummary, TaskHead, type TaskHeadFacts } from "@/routes/tasks/task-head";

// The task page's header in each state it is read in, with invented tasks:
// an epic with its progress, a task somebody holds, decisions waiting on the
// operator, a pick, a closed task with its reason and closes where nothing
// shipped. Each action is inert here.

const HOUR = 3_600_000;
const CHOICES: TaskChoices = {
  question: "What happens to the retired recipe page?",
  options: [
    { key: "a", label: "Keep the old page", detail: "It stays reachable at its address; nothing links to it." },
    { key: "b", label: "Redirect to the new page", detail: "A permanent redirect keeps its search traffic.", recommended: true },
    { key: "c", label: "Remove it", detail: "Visitors get a not-found page." },
  ],
};
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
          actions={<><Button size="sm"><Reply aria-hidden />Answer</Button><CloseAsMenu subject="Which sentence goes over the close reason box?" onPick={() => undefined} /></>}
        />
      </div>
      {/* A question with choices: the options under the header, Answer and
          Close as under them; then the same task once a person has picked. */}
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.11"
          facts={{ ...base, title: "Retire the old recipe page", ask: "choose", choices: CHOICES }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
        >
          <ChoiceButtons
            choices={CHOICES}
            onChoose={() => undefined}
            footer={<><Button size="sm" variant="outline"><Reply aria-hidden />Answer</Button><CloseAsMenu subject="Retire the old recipe page" onPick={() => undefined} /></>}
          />
        </TaskHead>
      </div>
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.11"
          facts={{ ...base, title: "Retire the old recipe page", choices: CHOICES }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
        >
          <ChoiceSummary
            choice={{ option: "b", label: "Redirect to the new page", by: "Dana", at: new Date(now - 2 * HOUR).toISOString(), note: "Keep the redirect for a year." }}
            choices={CHOICES}
            by="Dana"
            nowMs={now}
          />
        </TaskHead>
      </div>
      {/* One header per remaining type: an open bug wears the alert band, the
          others the neutral one, each with its own mark. */}
      <TaskHead
        id="os-8f7p.6"
        facts={{ ...base, title: "A hover hint covers the Claim button", issueType: "bug", priority: 0 }}
        crumbs={crumbs("Tasks are managed in the Tower")}
        nowMs={now}
        actions={<><Button size="sm">Claim</Button><Button size="sm" variant="outline">Close</Button></>}
      />
      <TaskHead
        id="os-8f7p.8"
        facts={{ ...base, title: "Facts edit in place as chips", issueType: "feature" }}
        crumbs={crumbs("Tasks are managed in the Tower")}
        nowMs={now}
      />
      <TaskHead
        id="os-8f7p.9"
        facts={{ ...base, title: "Move the Markdown renderer into its own module", issueType: "chore", priority: 3 }}
        crumbs={crumbs("Tasks are managed in the Tower")}
        nowMs={now}
      />
      <TaskHead
        id="os-8f7p.10"
        facts={{ ...base, title: "Which epic holds the timeline work?", issueType: "decision" }}
        crumbs={crumbs("Tasks are managed in the Tower")}
        nowMs={now}
      />
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
      {/* Closes where nothing shipped: the resolution leads, with who, when
          and the note; a duplicate links the task it names. */}
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.12"
          facts={{ ...base, title: "Print view for the task board", status: "closed" }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
        >
          <ClosedSummary by="Dana" model={null} at={new Date(now - 2 * HOUR).toISOString()} nowMs={now} resolution="wont-do">
            <p className="m-0 text-sm">Nobody prints the board; the export covers it.</p>
          </ClosedSummary>
        </TaskHead>
      </div>
      <div className="border-t border-border pt-4">
        <TaskHead
          id="os-8f7p.13"
          facts={{ ...base, title: "The board reads the task database", issueType: "bug", status: "closed" }}
          crumbs={crumbs("Tasks are managed in the Tower")}
          nowMs={now}
        >
          <ClosedSummary by="claude" model="Opus 5.5" at={new Date(now - 5 * HOUR).toISOString()} nowMs={now} resolution="duplicate"
            duplicate={<a href="/tasks/os-8f7p.1" className="font-mono text-xs text-foreground underline underline-offset-4">os-8f7p.1</a>} />
        </TaskHead>
      </div>
    </div>
  );
}
