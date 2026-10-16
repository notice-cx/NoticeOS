import { useState } from "react";
import { TaskTimeline } from "@/components/TaskTimeline";
import { DependencyGraph } from "@/components/viz/DependencyGraph";
import { fieldClass } from "@/components/ui/field";
import { EpicProgress, epicSegments } from "@/routes/tasks/epic-tasks";
import { TaskStatusGlyph } from "@/routes/tasks/task-face";
import type { BoardTask } from "@/lib/task-board-read";

// The task page's drawn pieces with invented tasks: who blocks whom, what
// happened when, and a task among its siblings on its epic's bar.

const HOUR = 3_600_000;

function row(id: string, status: string): BoardTask {
  return {
    id, title: id, status, priority: 2, issueType: "task", assignee: null, updatedAt: null, closedAt: null,
    parent: "os-8f7p", deferUntil: null, project: "system", labels: [], ready: status === "open", awaitType: null,
  };
}

export function DependencyGraphDemo() {
  return (
    <div className="flex w-full flex-col gap-6">
      <DependencyGraph
        subject={{ id: "os-8f7p.2", title: "A task has a page", caption: "This task", mark: <TaskStatusGlyph status="in_progress" /> }}
        before={[
          { id: "os-8f7p.1", title: "The Tower reads the task database", mark: <TaskStatusGlyph status="closed" />, href: "/tasks/os-8f7p.1", edge: "idle", said: "Closed" },
          { id: "os-8f7p.7", title: "Comments carry their author", mark: <TaskStatusGlyph status="blocked" />, href: "/tasks/os-8f7p.7", edge: "broken", said: "Blocked" },
        ]}
        after={[
          { id: "os-8f7p.4", title: "Fields are edited where they are read", mark: <TaskStatusGlyph status="open" />, href: "/tasks/os-8f7p.4", edge: "flowing", said: "Open" },
        ]}
        beforeLabel="Blocked by"
        afterLabel="Blocks"
        ariaLabel="What os-8f7p.2 waits on and what waits on it"
      />
      <div className="max-w-sm">
        <DependencyGraph
          subject={{ id: "os-8f7p.4", caption: "This task", mark: <TaskStatusGlyph status="open" /> }}
          before={[{ id: "os-8f7p.2", title: "A task has a page", mark: <TaskStatusGlyph status="in_progress" />, href: "/tasks/os-8f7p.2", edge: "flowing" }]}
          after={[]}
          beforeLabel="Blocked by"
          afterLabel="Blocks"
          ariaLabel="What os-8f7p.4 waits on, in a narrow column"
        />
      </div>
    </div>
  );
}

export function TaskTimelineDemo() {
  const [now] = useState(() => Date.now());
  const at = (hours: number) => new Date(now - hours * HOUR).toISOString();
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <TaskTimeline
        nowMs={now}
        ariaLabel="What happened to os-8f7p.2"
        entries={[
          { id: "filed", at: at(50), kind: "filed", label: "Filed", said: "Filed" },
          { id: "claimed", at: at(6), kind: "claimed", who: { name: "claude", model: "Opus 5.5" }, label: <>Claimed by <b className="font-semibold">claude</b><span className="text-muted-foreground"> · Opus 5.5</span></>, said: "Claimed by claude · Opus 5.5" },
          { id: "c1", at: at(4), kind: "comment", who: { name: "Example Operator", model: null }, label: <>Comment from <b className="font-semibold">Example Operator</b></>, said: "Comment from Example Operator", body: <p className="m-0">Ship the facts first; the timeline can follow.</p> },
          { id: "closed", at: at(1), kind: "closed", who: { name: "claude", model: "Opus 5.5" }, label: <>Closed by <b className="font-semibold">claude</b><span className="text-muted-foreground"> · Opus 5.5</span></>, said: "Closed by claude · Opus 5.5", body: <p className="m-0">The page draws its facts</p>, evidence: "The page draws its facts · 1a2b3c4" },
        ]}
        composer={<textarea aria-label="Add a comment" rows={2} placeholder="What you found, decided, or need." className={`${fieldClass} w-full`} />}
      />
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">A task among its epic's tasks: two closed before the read's window, this task ringed, the next ready one dotted.</span>
        <EpicProgress
          closed={3}
          total={8}
          segments={epicSegments({
            children: [row("os-8f7p.1", "closed"), row("os-8f7p.2", "in_progress"), row("os-8f7p.3", "open"), row("os-8f7p.4", "open"), row("os-8f7p.5", "blocked"), row("os-8f7p.6", "deferred")],
            self: "os-8f7p.2", next: "os-8f7p.3", closed: 3, total: 8,
          })}
        />
      </div>
    </div>
  );
}
