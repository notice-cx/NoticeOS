import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TaskServiceStatus, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// While this installation's tasks live in Ntasks, a decision, an approval or a
// dispute is taken only by a person signed in to Ntasks, so each surface that
// would take one here links to the task's page there instead.

const NTASKS: TaskServiceStatus = { connected: true, origin: "https://ntasks.example.com", projects: null };
const LOCAL_HUB: TaskServiceStatus = { connected: false, origin: null, projects: null };

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  service: undefined as TaskServiceStatus | undefined,
}));
const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async (..._args: unknown[]) => undefined),
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), ...api }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [] } }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isPending: false, isError: false }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useTaskService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTaskService")>();
  return { ...actual, useTaskService: () => ({ data: state.service }), useNtasksTaskPage: () => actual.ntasksTaskPage(state.service) };
});
vi.mock("@/hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTasks")>()),
  useTasksLive: () => state.capabilities,
  useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
  useTasksAcross: (projects: string[]) => projects.map((asset) => ({ data: state.boards[asset], isError: false, error: null })),
}));

import { ntasksTaskPage } from "@/hooks/useTaskService";
import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { closableHere } from "@/routes/tasks/close-actions";
import { FocusRoute } from "@/routes/tasks/FocusRoute";
import { NextTab } from "@/routes/tasks/next/NextTab";
import { scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

function renderAt(element: ReactNode, entry: string) {
  state.work = scenarioPayload();
  state.boards = scenarioBoards();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  state.service = undefined;
  resetAnswerQueue();
  window.localStorage.clear();
  vi.clearAllMocks();
});

/** Approve, Answer, and the options of the scenario's choice. */
const DECIDING = [/^Approve/u, /^Answer/u, /Monday|Tuesday|Friday/u];

describe("a task's page in Ntasks", () => {
  it("is the task's address on the connected Ntasks, and nothing while tasks live in the local hub", () => {
    expect(ntasksTaskPage(NTASKS)?.("md-c1")).toBe("https://ntasks.example.com/tasks/md-c1");
    expect(ntasksTaskPage(LOCAL_HUB)).toBeNull();
    expect(ntasksTaskPage(undefined)).toBeNull();
    expect(ntasksTaskPage({ connected: null, origin: null, projects: null })).toBeNull();
    expect(ntasksTaskPage({ connected: true, origin: null, projects: null })).toBeNull();
  });
});

describe("closing a task from its row", () => {
  it("declines a task waiting on a person here only while tasks live in the local hub", () => {
    const capabilities: TasksCapabilities = { live: true, reason: null };
    const waiting = { labels: ["human"] };
    const plain = { labels: [] };
    expect(closableHere(waiting, capabilities, false)).toBe(true);
    expect(closableHere(waiting, capabilities, true)).toBe(false);
    expect(closableHere(plain, capabilities, true)).toBe(true);
  });
});

describe("deciding while tasks live in Ntasks", () => {
  it("links every decision on the Next tab, and its brief, to the task in Ntasks, with no button that would decide it here", () => {
    state.service = NTASKS;
    renderAt(<NextTab scope={null} />, "/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Read it as a brief" }));
    const links = screen.getAllByRole("link", { name: "Decide in Ntasks" });
    expect(new Set(links.map((link) => link.getAttribute("href")))).toEqual(new Set([
      "https://ntasks.example.com/tasks/md-c1", "https://ntasks.example.com/tasks/md-a1", "https://ntasks.example.com/tasks/md-g1",
    ]));
    for (const link of links) expect(link).toHaveAttribute("target", "_blank");
    for (const name of DECIDING) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
  });

  it("keeps every button on the Next tab while tasks live in the local hub", () => {
    state.service = LOCAL_HUB;
    renderAt(<NextTab scope={null} />, "/tasks");
    expect(screen.queryByRole("link", { name: "Decide in Ntasks" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Approve/u }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Tuesday/u }).length).toBeGreaterThan(0);
  });

  it("in Focus, offers the link and leaves the option keys unbound, so a key press sends nothing", () => {
    state.service = NTASKS;
    const { container } = renderAt(<FocusRoute />, "/tasks/focus?task=md-c1");
    const decision = container.querySelector<HTMLElement>("[data-focus-decision]")!;
    expect(decision).toHaveAttribute("data-focus-decision", "md-c1");
    expect(within(decision).getByRole("link", { name: "Decide in Ntasks" })).toHaveAttribute("href", "https://ntasks.example.com/tasks/md-c1");
    expect(within(decision).queryByRole("button", { name: /Tuesday/u })).toBeNull();
    fireEvent.keyDown(window, { key: "b" });
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
    expect(container.querySelector("[data-focus-decision]")).toHaveAttribute("data-focus-decision", "md-c1");
  });
});
