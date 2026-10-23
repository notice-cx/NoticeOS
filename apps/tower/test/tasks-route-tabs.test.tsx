import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// `/tasks` is tabbed and the tab is the path: the app's own route table is
// rendered here, so the addresses asserted are the ones the Tower answers.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [] } }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isPending: false, isError: false }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTasks")>()),
  useTasksLive: () => state.capabilities,
  useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
  useTasksAcross: (projects: string[]) => projects.map((asset) => ({ data: state.boards[asset], isError: false, error: null })),
}));

import { deskRoutes } from "@/App";
import { resetAnswerQueue } from "@/lib/answer-queue";
import { board, liveTask, project, scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

/** The Tasks routes from the app's table, and a stand-in for one task's page. */
function renderAt(entry: string, multiple = false) {
  state.work = scenarioPayload();
  state.boards = scenarioBoards();
  if (multiple) {
    state.work.projects.push(project({ asset: "northwind.example", prefix: "nw", name: "Northwind" }));
    state.boards["northwind.example"] = board([liveTask({ id: "nw-1", title: "Northwind work" })], "northwind.example");
  }
  const table = deskRoutes
    .filter((route) => route.path?.startsWith("/tasks") || route.path === "/work")
    .map((route) => (route.path === "/tasks/:id" ? { ...route, lazy: undefined, element: <output data-testid="task-page" /> } : route));
  const router = createMemoryRouter(table, { initialEntries: [entry] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const at = (router: ReturnType<typeof renderAt>) => `${router.state.location.pathname}${router.state.location.search}`;

// The screens load through the router's lazy; fetch their code once up front
// so each case waits on the route, not on the first transform.
beforeAll(async () => {
  await import("@/routes/TasksRoute");
  await import("@/routes/tasks/FocusRoute");
}, 60_000);

afterEach(() => {
  resetAnswerQueue();
  vi.clearAllMocks();
});

describe("the Tasks page's tabs", () => {
  it("opens on Next, with the three tabs and the open-task count on All tasks", async () => {
    renderAt("/tasks");
    const next = await screen.findByRole("tab", { name: "Next" });
    expect(next).toHaveAttribute("aria-selected", "true");
    expect(next).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("href", "/tasks/projects");
    const all = screen.getByRole("tab", { name: /^All tasks/u });
    expect(all).toHaveAttribute("href", "/tasks/all");
    expect(all).toHaveAttribute("aria-selected", "false");
    // Six not-started work items include the two blocked tasks; one is in
    // progress. The approval and parked task are outside the active total.
    expect(all).toHaveTextContent("All tasks7");
    expect(document.querySelector("[data-tasks-next]")).not.toBeNull();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tasks-tab-next");
  });

  it("selects All tasks by its path and draws the board there", async () => {
    renderAt("/tasks/all");
    expect(await screen.findByRole("tab", { name: /^All tasks/u })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector("[data-tasks-board]")).not.toBeNull();
    expect(document.querySelector("[data-tasks-next]")).toBeNull();
  });

  it("selects Projects by its path", async () => {
    renderAt("/tasks/projects");
    expect(await screen.findByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tasks-tab-projects");
  });

  it("moves between tabs by their links", async () => {
    const router = renderAt("/tasks");
    fireEvent.click(await screen.findByRole("tab", { name: /^All tasks/u }));
    await vi.waitFor(() => expect(screen.getByRole("tab", { name: /^All tasks/u })).toHaveAttribute("aria-selected", "true"));
    expect(at(router)).toBe("/tasks/all");
  });

  it("keeps project scope and counts when moving between All tasks and Projects", async () => {
    const router = renderAt("/tasks/all?project=northwind.example", true);
    const all = await screen.findByRole("tab", { name: /^All tasks/u });
    expect(all).toHaveTextContent("All tasks1");
    expect(screen.queryByText("Newsletter launch")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    await vi.waitFor(() => expect(document.querySelector("[data-tasks-projects]")).toHaveAttribute("data-tasks-projects", "northwind.example"));
    expect(at(router)).toBe("/tasks/projects?project=northwind.example");
    expect(screen.queryByText("Newsletter launch")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^All tasks/u }));
    await vi.waitFor(() => expect(document.querySelector("[data-tasks-board]")).not.toBeNull());
    expect(at(router)).toBe("/tasks/all?project=northwind.example");
    expect(screen.queryByText("Newsletter launch")).toBeNull();
  });

  it("honors project scope on a direct Projects link", async () => {
    renderAt("/tasks/projects?project=northwind.example", true);
    await vi.waitFor(() => expect(document.querySelector("[data-tasks-projects]")).toHaveAttribute("data-tasks-projects", "northwind.example"));
    expect(screen.queryByText("Newsletter launch")).toBeNull();
    expect(screen.getByRole("tab", { name: /^All tasks/u })).toHaveTextContent("All tasks1");
  });

  it("forwards a filtered /tasks link to All tasks with the same query, in place", async () => {
    const router = renderAt("/tasks?project=meadow.example&status=open");
    expect(await screen.findByRole("tab", { name: /^All tasks/u })).toHaveAttribute("aria-selected", "true");
    expect(at(router)).toBe("/tasks/all?project=meadow.example&status=open");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("keeps /work landing on the board with its filters", async () => {
    const router = renderAt("/work?status=blocked");
    expect(await screen.findByRole("tab", { name: /^All tasks/u })).toHaveAttribute("aria-selected", "true");
    expect(at(router)).toBe("/tasks/all?status=blocked");
  });

  it("opens a task id as its page, and any other word after /tasks/ as the index", async () => {
    const task = renderAt("/tasks/md-c1");
    expect(await screen.findByTestId("task-page")).toBeInTheDocument();
    expect(at(task)).toBe("/tasks/md-c1");
    const other = renderAt("/tasks/nonsense");
    await vi.waitFor(() => expect(at(other)).toBe("/tasks"));
  });

  it("opens Focus at its own address", async () => {
    renderAt("/tasks/focus");
    expect(await screen.findByText("Focus · 1 of 3 for you")).toBeInTheDocument();
  });
});
