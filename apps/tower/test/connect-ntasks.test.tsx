import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TaskServiceStatus, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// An installation's tasks live only in its task service, so while none is
// connected each Tasks page leads to Settings → Task projects instead of a board.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  service: undefined as TaskServiceStatus | undefined,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [] } }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isPending: false, isError: false }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useTaskService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTaskService")>();
  return { ...actual, useTaskService: () => ({ data: state.service }), useNeedsNtasks: () => actual.needsNtasks(state.service) };
});
vi.mock("@/hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTasks")>()),
  useTasksLive: () => state.capabilities,
  useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
  useTasksAcross: (projects: string[]) => projects.map((asset) => ({ data: state.boards[asset], isError: false, error: null })),
}));

import { deskRoutes } from "@/App";
import { resetAnswerQueue } from "@/lib/answer-queue";
import { scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

const NOT_CONNECTED: TaskServiceStatus = { connected: false, origin: null, projects: null, required: true };

function renderAt(entry: string) {
  state.work = scenarioPayload();
  state.boards = scenarioBoards();
  const table = [
    ...deskRoutes.filter((route) => route.path?.startsWith("/tasks")),
    { path: "/settings/task-projects", element: <output data-testid="task-projects" /> },
  ];
  const router = createMemoryRouter(table, { initialEntries: [entry] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeAll(async () => {
  await import("@/routes/TasksRoute");
  await import("@/routes/tasks/FocusRoute");
  await import("@/routes/TaskRoute");
}, 60_000);

afterEach(() => {
  state.service = undefined;
  resetAnswerQueue();
  vi.clearAllMocks();
});

describe("the Tasks pages of an installation with no task service connected", () => {
  it.each(["/tasks", "/tasks/projects", "/tasks/all", "/tasks/focus", "/tasks/md-c1"])("lead from %s to Settings → Task projects", async (entry) => {
    state.service = NOT_CONNECTED;
    const router = renderAt(entry);
    const step = await screen.findByRole("link", { name: /Task projects/u });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(document.querySelector("[data-tasks-board], [data-tasks-next], [data-tasks-focus] [data-focus-decision]")).toBeNull();
    fireEvent.click(step);
    expect(await screen.findByTestId("task-projects")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/task-projects");
  });

  it.each([
    ["a Tower whose tasks come from elsewhere", { connected: false, origin: null, projects: null }],
    ["a connected installation", { connected: true, origin: "https://ntasks.example.com", projects: null, required: true }],
    ["an installation whose ingest cannot say", { connected: null, origin: null, projects: null, required: true }],
  ] as [string, TaskServiceStatus][])("draws the board for %s", async (_label, service) => {
    state.service = service;
    renderAt("/tasks");
    expect(await screen.findByRole("tab", { name: "Next" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector("[data-connect-ntasks]")).toBeNull();
  });
});
