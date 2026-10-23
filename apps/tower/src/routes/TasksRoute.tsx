import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { TabPanel, Tabs, type TabSpec } from "@/components/Tabs";
import { TaskComposer } from "@/components/TaskComposer";
import { workQueue } from "@/components/viz/WorkFlow";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { boardWorkRows } from "@/lib/task-board-viz";
import { COMPOSE_STATE, NewTaskButton, TasksBoard, composeRequested } from "@/routes/tasks/TasksBoard";
import { NextTab } from "@/routes/tasks/next/NextTab";
import { UNFILTERED } from "@/routes/tasks/next/next-read";
import { ProjectsTab } from "@/routes/tasks/projects/ProjectsTab";

/** `/tasks` is Next; each other view is a segment after it. `/work` is the
 * page's older address and redirects to `/tasks`, query and all. */
const TASK_TABS = ["next", "projects", "all"] as const;
type TasksTab = (typeof TASK_TABS)[number];

const TAB_PATH: Readonly<Record<TasksTab, string>> = { next: "/tasks", projects: "/tasks/projects", all: "/tasks/all" };
const TAB_LABEL: Readonly<Record<TasksTab, string>> = { next: "Next", projects: "Projects", all: "All tasks" };
const TAB_IDS = "tasks-tab";
const TAB_PANEL_ID = "tasks-tab-panel";

/** The query keys that narrow All tasks. A link from before the tabs, such as
 * `/tasks?project=x` or `/tasks?epic=…`, meant the board, so it opens there. */
const BOARD_KEYS = ["project", "status", "priority", "label", "assignee", "epic"] as const;

function tabAt(pathname: string): TasksTab {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return TASK_TABS.find((tab) => TAB_PATH[tab] === path) ?? "next";
}

/**
 * `/tasks`: Next (what to do first, and why), Projects and All tasks (the
 * board, with its filters in the query). The tab is the path, so each view is
 * a link. New task stays in the header on every tab because it is the page's
 * one primary action; the board opens its own composer, and the other tabs
 * open the same one here.
 */
export function TasksRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = tabAt(location.pathname);
  const params = new URLSearchParams(location.search);
  const project = params.get("project") ?? "all";
  const scope = project === "all" ? null : project;
  // The open-task count All tasks carries: the board's own yardstick.
  const { drawn, projects, availableSpokes, selectedProject } = useTaskBoard(null, { ...UNFILTERED, project });
  const open = drawn ? boardWorkRows(projects).reduce((sum, row) => sum + workQueue(row), 0) : null;

  if (tab === "next" && BOARD_KEYS.some((key) => params.has(key))) {
    return <Navigate to={`${TAB_PATH.all}${location.search}${location.hash}`} replace state={location.state} />;
  }

  const composing = tab !== "all" && (params.get("new") === "1" || composeRequested(location.state));
  function closeComposer() {
    const next = new URLSearchParams(location.search);
    next.delete("new");
    const kept = typeof location.state === "object" && location.state !== null
      ? Object.fromEntries(Object.entries(location.state).filter(([key]) => key !== COMPOSE_STATE))
      : null;
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true, state: kept });
  }

  const tabs: TabSpec[] = TASK_TABS.map((key) => ({
    key,
    to: key !== "next" && scope !== null ? `${TAB_PATH[key]}?${new URLSearchParams({ project })}` : TAB_PATH[key],
    label: TAB_LABEL[key],
    end: key === "next",
    ...(key === "all" && open !== null && projects.length > 0 ? { count: open, title: scope === null ? "Open tasks across every project" : "Open tasks in the selected project" } : {}),
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Tasks" actions={<NewTaskButton project={selectedProject === "all" ? null : selectedProject} />} />
      <Tabs label="Task views" tabs={tabs} idBase={TAB_IDS} panelId={TAB_PANEL_ID} />
      <TabPanel id={TAB_PANEL_ID} idBase={TAB_IDS} activeKey={tab}>
        {composing ? <TaskComposer open onClose={closeComposer} prefill={selectedProject === "all" ? null : { project: selectedProject }} projects={availableSpokes} /> : null}
        {tab === "all" ? <TasksBoard /> : tab === "projects" ? <ProjectsTab scope={scope} /> : <NextTab scope={null} />}
      </TabPanel>
    </div>
  );
}

export default TasksRoute;
