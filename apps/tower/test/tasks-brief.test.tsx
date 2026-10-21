import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// The brief is the Next tab read as sentences: closed until asked for, then
// one line per fact the board holds, each with its one press.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
}));
const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async () => undefined),
  chooseOnTask: vi.fn(async () => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), ...api }));
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

import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { NextTab } from "@/routes/tasks/next/NextTab";
import { board, liveTask, scenario, scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

function renderNext(boards = scenarioBoards()) {
  state.work = scenarioPayload();
  state.boards = boards;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tasks"]}><NextTab scope={null} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resetAnswerQueue();
  window.localStorage.clear();
  vi.clearAllMocks();
});

const toggle = () => screen.getByRole("button", { name: "Read it as a brief" });

describe("Read it as a brief", () => {
  it("is closed until asked for, then lists one sentence per fact with its press", () => {
    const { container } = renderNext();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-brief-line]")).toBeNull();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const lines = [...container.querySelectorAll<HTMLElement>("[data-brief-line]")];
    expect(lines.map((line) => line.getAttribute("data-brief-line"))).toEqual(["decision", "decision", "urgent", "ready"]);
    expect(lines[0]).toHaveTextContent("Meadow Board has waited 7 days for your call: Pick the newsletter day. About $770 a month is at stake.");
    expect(within(lines[0]!).getByRole("link", { name: "Choose" })).toHaveAttribute("href", "/tasks/focus?task=md-c1");
    expect(lines[1]).toHaveTextContent("Meadow Board has waited 12 days for your call: Name the newsletter. 2 tasks wait on this answer.");
    expect(within(lines[1]!).getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/tasks/focus?task=md-a1");
    expect(lines[2]).toHaveTextContent("Meadow Board: Ship the sitemap fix is urgent; agent-x has been on it for 3h.");
    expect(within(lines[2]!).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/tasks/md-w1");
    expect(lines[3]).toHaveTextContent("Meadow Board: Write the welcome email is next for the agents.");
    const end = container.querySelector<HTMLElement>("[data-tasks-brief]")!;
    expect(end).toHaveTextContent("Everything else can wait.");
    expect(within(end).getByRole("button", { name: "4 tasks are held back, each for one reason →" })).toBeInTheDocument();
  });

  it("brings the held-back list into view from its last line", () => {
    const { container } = renderNext();
    fireEvent.click(toggle());
    const target = container.querySelector<HTMLElement>("[data-not-now]")!;
    const scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    fireEvent.click(screen.getByRole("button", { name: /held back, each for one reason/ }));
    expect(scrolled).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
  });

  it("approves a gate from its sentence through the board's answer queue", async () => {
    const gateFirst = scenario().filter((task) => task.id !== "md-c1" && task.id !== "md-a1");
    const { container } = renderNext({ "meadow.example": board(gateFirst) });
    fireEvent.click(toggle());
    const line = container.querySelector<HTMLElement>('[data-brief-line="decision"]')!;
    expect(line).toHaveTextContent("Meadow Board has waited 1 day for your call: Approve the spend.");
    fireEvent.click(within(line).getByRole("button", { name: "Approve" }));
    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledOnce());
  });

  it("remembers that it was opened", () => {
    const first = renderNext();
    fireEvent.click(toggle());
    first.unmount();
    renderNext();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves out a sentence whose fact the board does not hold", () => {
    const { container } = renderNext({ "meadow.example": board([liveTask({ id: "md-n1", title: "Write the welcome email", ready: true })]) });
    fireEvent.click(toggle());
    expect([...container.querySelectorAll("[data-brief-line]")].map((line) => line.getAttribute("data-brief-line"))).toEqual(["ready"]);
    expect(screen.queryByRole("button", { name: /held back/ })).toBeNull();
  });
});
