import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// Focus is the Next tab's decisions one at a time: the same ranking, the same
// answer queue, a key for each press.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
}));
const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async (..._args: unknown[]) => undefined),
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
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
import { FocusRoute } from "@/routes/tasks/FocusRoute";
import { EPIC, board, scenario, scenarioPayload } from "./tasks-next-fixtures";

/** The scenario's two questions, without its gate: two decisions to step through. */
function twoDecisions() {
  return { "meadow.example": board(scenario().filter((task) => task.id !== "md-g1")) };
}

function renderFocus(entry = "/tasks/focus", boards = twoDecisions()) {
  state.work = scenarioPayload();
  state.boards = boards;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}><FocusRoute /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resetAnswerQueue();
  vi.clearAllMocks();
});

const decision = (container: HTMLElement) => container.querySelector("[data-focus-decision]")?.getAttribute("data-focus-decision") ?? null;
const position = () => screen.getByText(/^Focus/u).textContent;

describe("Focus", () => {
  it("names the decision's epic as the link to its page", () => {
    const { container } = renderFocus("/tasks/focus", {
      "meadow.example": board(scenario().filter((task) => task.id !== "md-g1"), "meadow.example", [{ ...EPIC, eligibleForClose: false }]),
    });
    const chip = container.querySelector<HTMLElement>("[data-focus-epic]")!;
    expect(chip).toHaveTextContent("Newsletter launch2 of 6");
    expect(within(chip).getByRole("link", { name: "Newsletter launch" })).toHaveAttribute("href", "/tasks/md-e");
  });

  it("steps through the decisions with the arrow key and ends on the finish line", () => {
    const { container } = renderFocus();
    expect(position()).toBe("Focus · 1 of 2 for you");
    expect(decision(container)).toBe("md-c1");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pick the newsletter day");
    expect(container.querySelector("[data-focus-after]")).toHaveTextContent("After this: Name the newsletter · Meadow Board");
    expect(within(container.querySelector<HTMLElement>("[data-focus-after]")!).getByRole("link", { name: "Name the newsletter" }))
      .toHaveAttribute("href", "/tasks/md-a1");
    expect(container.querySelector("[data-focus-keys]")).toHaveTextContent("B A C choose · → skip");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(position()).toBe("Focus · 2 of 2 for you");
    expect(decision(container)).toBe("md-a1");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("That's every decision for you.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Tasks" })).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("link", { name: "Leave focus" })).toHaveAttribute("href", "/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(decision(container)).toBe("md-c1");
  });

  it("picks an option with its letter through the board's answer queue, and moves to the next decision", async () => {
    const { container } = renderFocus();
    const options = within(container.querySelector<HTMLElement>("[data-focus-options]")!);
    expect(options.getByText("Recommended")).toBeInTheDocument();
    fireEvent.change(options.getByLabelText("Note"), { target: { value: "Start next week." } });
    // A letter typed into a field is the field's.
    fireEvent.keyDown(options.getByLabelText("Note"), { key: "c" });
    expect(decision(container)).toBe("md-c1");
    fireEvent.keyDown(window, { key: "c" });
    expect(decision(container)).toBe("md-a1");
    expect(position()).toBe("Focus · 2 of 2 for you");
    act(() => flushAnswers());
    await waitFor(() => expect(api.chooseOnTask).toHaveBeenCalledOnce());
    expect(api.chooseOnTask.mock.calls[0]!.slice(0, 3)).toEqual(["md-c1", "c", "Start next week."]);
  });

  it("answers a question in its box and sends it with Enter", async () => {
    const { container } = renderFocus("/tasks/focus?task=md-a1");
    expect(decision(container)).toBe("md-a1");
    const box = screen.getByLabelText("Your answer to md-a1");
    fireEvent.change(box, { target: { value: "The Weekly Meadow" } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledOnce());
    expect(api.respondToTask.mock.calls[0]!.slice(0, 2)).toEqual(["md-a1", "The Weekly Meadow"]);
  });

  it("passes over a decision with Not now without answering it", () => {
    const { container } = renderFocus();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(decision(container)).toBe("md-a1");
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });
});
