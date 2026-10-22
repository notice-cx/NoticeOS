import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_TASKS_HINT, type LiveTasksPayload, type TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";
import type { AssetDetailFor } from "@shared/asset-detail-views";

// The Next tab ranks the board the Tasks page already reads: the reads are
// stubbed as the board's own tests stub them, the answer queue and the lane
// calls under it are real, so a press here is asserted on the call the board
// makes for the same press.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  /** Settings' "Value of your time", USD a minute; the default when unset. */
  rate: null as number | null,
}));

const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async () => undefined),
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));

vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), ...api }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [] } }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isPending: false, isError: false }) }));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: state.rate === null ? undefined : { budget: { knobs: [{ key: "operator_rate_usd_per_min", value: state.rate }] } } }),
}));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTasks")>()),
  useTasksLive: () => state.capabilities,
  useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
  useTasksAcross: (projects: string[]) => projects.map((asset) => ({
    data: state.capabilities.live ? state.boards[asset] : undefined, isError: false, error: null,
  })),
}));

import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { rankBoard } from "@/lib/task-ranking";
import type { BoardTask } from "@/lib/task-board-read";
import { TasksTab } from "@/routes/asset-detail/TasksTab";
import { NextTab } from "@/routes/tasks/next/NextTab";
import { heldBackLine, nextSentence, whyLine, whySentence } from "@/routes/tasks/next/next-read";
import { CARD, board, item, liveTask, payload, project, scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

function renderNext({ work = scenarioPayload(), boards = scenarioBoards(), live = true, ui = <NextTab scope={null} /> }: {
  work?: WorkPayload; boards?: Record<string, LiveTasksPayload>; live?: boolean; ui?: React.ReactElement;
} = {}) {
  state.work = work;
  state.boards = boards;
  state.capabilities = live ? { live: true, reason: null } : { live: false, reason: "read_only_deployment" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tasks"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resetAnswerQueue();
  state.rate = null;
  vi.clearAllMocks();
});

/** The marked sections, in the order they are drawn. */
function sections(container: HTMLElement): string[] {
  const marks = ["data-tasks-brief", "data-next-decision", "data-then-for-you", "data-agents-next", "data-not-now"];
  return [...container.querySelectorAll(marks.map((mark) => `[${mark}]`).join(","))]
    .map((node) => marks.find((mark) => node.hasAttribute(mark))!);
}

describe("the Next tab", () => {
  it("leads with the top decision: its sentence carries the kind of decision and the money its card puts on it, never the title", () => {
    const { container } = renderNext();
    expect(container.querySelector("[data-next-answer] h2")).toHaveTextContent(
      "Choose one option first: it holds about $770 a month.",
    );
    expect(container.querySelector("[data-next-answer] h2")).not.toHaveTextContent("Pick the newsletter day");
    const region = container.querySelector<HTMLElement>("[data-next-decision]")!;
    expect(region).toHaveAttribute("data-next-decision", "md-c1");
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent("Pick the newsletter day");
    expect(region).toHaveTextContent("Needs your choice · waiting 7d");
    expect(region.querySelector("[data-next-epic]")).toHaveTextContent("Newsletter launch2 of 6");
    expect(region.querySelector("[data-why-it-ranks]")).toHaveTextContent("Rank1of 3 · policy v1.0");
  });

  it("draws one fact under the sentence, the decisions and the oldest wait; the board's other counts and Working now stay on All tasks", () => {
    const { container } = renderNext();
    const facts = container.querySelector<HTMLElement>("[data-next-facts]")!;
    expect(facts.querySelector('[data-next-fact="decisions"]')).toHaveTextContent("3 decisions for you · oldest 12d");
    expect(facts.querySelector('[data-next-fact="decisions"]')).toHaveClass("text-warn");
    expect(facts.querySelectorAll("[data-next-fact]")).toHaveLength(1);
    expect(facts.textContent).not.toMatch(/urgent|blocked|done this week/u);
    expect(container.querySelector("[data-tasks-working]")).toBeNull();
    expect(facts.textContent).not.toContain("—");
  });

  it("says the work a decision releases when it carries no card", () => {
    const tasks = [
      liveTask({ id: "md-a1", title: "Name the newsletter", labels: ["human"], ready: true }),
      liveTask({ id: "md-r1", title: "Draft the first issue", status: "blocked", dependencies: [{ id: "md-a1", type: "blocks", title: "Name the newsletter", status: "open" }] }),
      liveTask({ id: "md-r2", title: "Design the header", status: "blocked", dependencies: [{ id: "md-a1", type: "blocks", title: "Name the newsletter", status: "open" }] }),
    ];
    const { container } = renderNext({ boards: { "meadow.example": board(tasks) } });
    expect(container.querySelector("[data-next-answer] h2")).toHaveTextContent("Answer one question first: 2 tasks wait on it.");
    const region = container.querySelector<HTMLElement>("[data-next-decision]")!;
    expect(region.querySelector("[data-next-why]")).toHaveTextContent("2 tasks wait on this answer.");
    // No figures and no "not ranked": one link to where a card is written.
    expect(region.querySelector("[data-why-it-ranks]")).toBeNull();
    expect(region.textContent).not.toMatch(/not ranked/iu);
    expect(within(region).getByRole("link", { name: "Add why it ranks" })).toHaveAttribute("href", "/tasks/md-a1");
  });

  it("keeps a board without a card quiet: rows carry one button and no money line, and the caption names the board's own order", () => {
    const paragraph = "Use the existing login once to push the branch, open a PR and read its CI. After the merge, rebase the checkout to the merged tree and restart with health waits. No merge, migration, export or credential changes.";
    const tasks = [
      liveTask({ id: "md-a1", title: "Name the newsletter", labels: ["human"], ready: true, priority: 1 }),
      liveTask({ id: "md-a2", title: paragraph, labels: ["human"], ready: true }),
      liveTask({ id: "md-a3", title: "Create the ads account", labels: ["human"], ready: true }),
    ];
    const { container } = renderNext({ boards: { "meadow.example": board(tasks) } });
    const then = container.querySelector<HTMLElement>("[data-then-for-you]")!;
    expect(then).toHaveTextContent("by what each answer releases, then the longest wait");
    expect(then.textContent).not.toContain("ranked by what each decision is worth");
    const rows = [...then.querySelectorAll<HTMLElement>("[data-then-row]")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector("[data-money]")).toBeNull();
      expect(row.textContent).not.toMatch(/not ranked/iu);
      expect(within(row).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Answer"]);
      expect(within(row).getByRole("link", { name: /./u })).toHaveClass("line-clamp-2");
    }
    // The region keeps Close as, as the task page does.
    const region = within(container.querySelector<HTMLElement>("[data-next-decision]")!);
    expect(region.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Answer", "Close as"]);
    expect(region.getByRole("heading", { level: 3 }).querySelector("a")).toHaveClass("line-clamp-3");
  });

  it("draws the five sections in order", () => {
    const { container } = renderNext();
    expect(sections(container)).toEqual(["data-tasks-brief", "data-next-decision", "data-then-for-you", "data-agents-next", "data-not-now"]);
    const then = container.querySelector<HTMLElement>("[data-then-for-you]")!;
    expect([...then.querySelectorAll("[data-then-row]")].map((row) => row.getAttribute("data-then-row"))).toEqual(["md-a1", "md-g1"]);
    expect(then).toHaveTextContent("That's every decision for you.");
    expect(within(then).getByRole("link", { name: "Focus →" })).toHaveAttribute("href", "/tasks/focus");
    const agents = container.querySelector<HTMLElement>("[data-agents-next]")!;
    expect(agents.querySelector('[data-agent-row="md-w1"]')).toHaveTextContent("In progress · agent-x · 3h");
    expect(agents.querySelector('[data-agent-row="md-n1"]')).toHaveTextContent("Ready · nobody yet");
    expect(agents.querySelector('[data-agent-row="md-n1"]')).toHaveTextContent("≈ +$400 /mo");
  });

  it("holds back each task for one reason, three rows first, then Show all", () => {
    const { container } = renderNext();
    const held = container.querySelector<HTMLElement>("[data-not-now]")!;
    expect(held).toHaveTextContent("4 open tasks are held back · each for one reason");
    expect(held.querySelectorAll("[data-not-now-row]")).toHaveLength(3);
    fireEvent.click(within(held).getByRole("button", { name: "Show all 4" }));
    expect([...held.querySelectorAll("[data-not-now-row]")].map((row) => [row.getAttribute("data-not-now-row"), row.getAttribute("data-not-now-reason")])).toEqual([
      ["md-r1", "blocked"], ["md-r2", "blocked"], ["md-p1", "parked"], ["md-x1", "below-cost"],
    ]);
    expect(held.querySelector('[data-not-now-row="md-r1"]')).toHaveTextContent("Waits on Name the newsletter");
    expect(held.querySelector('[data-not-now-row="md-p1"]')).toHaveTextContent("Parked until Sep 1");
    expect(held.querySelector('[data-not-now-row="md-x1"]')).toHaveTextContent("≈ $7 /mo, under the $60 its review costs");
    expect(within(held).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("prices the operator's minutes at the rate Settings holds", () => {
    state.rate = 0.1;
    const { container } = renderNext();
    // At $0.10 a minute the footer's 30 minutes cost $3, under its $7: it is the agents' work now.
    expect(container.querySelector('[data-not-now-row="md-x1"]')).toBeNull();
    expect(container.querySelector('[data-agents-next]')).toHaveTextContent("Tidy the footer");
  });

  it("sends a pick through the board's answer queue: the decision leaves, Undo is offered, and choose goes when the window closes", async () => {
    const { container } = renderNext();
    const region = within(container.querySelector<HTMLElement>("[data-next-decision]")!);
    expect(region.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim()))
      .toEqual(["Why first?", "(b) Tuesday", "(a) Monday", "(c) Friday", "Answer", "Close as"]);
    fireEvent.click(region.getByRole("button", { name: "(c) Friday" }));
    expect(toasts.success).toHaveBeenCalledWith("Chose (c) Friday", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
    // The next decision moves up at once, as the board's row leaves at once.
    expect(container.querySelector("[data-next-decision]")).toHaveAttribute("data-next-decision", "md-a1");
    expect(api.chooseOnTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.chooseOnTask).toHaveBeenCalledOnce());
    expect(api.chooseOnTask.mock.calls[0]!.slice(0, 2)).toEqual(["md-c1", "c"]);
  });

  it("approves a gate from its row with the board's own Approve", async () => {
    const { container } = renderNext();
    const row = container.querySelector<HTMLElement>('[data-then-row="md-g1"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    expect(container.querySelector('[data-then-row="md-g1"]')).toBeNull();
    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledOnce());
  });

  it("opens why the decision is first", () => {
    const { container } = renderNext();
    fireEvent.click(screen.getByRole("button", { name: "Why first?" }));
    const list = container.querySelector<HTMLElement>("[data-next-why-list]")!;
    expect(list).toHaveTextContent("Rank1 of 3 · policy v1.0");
    expect(list).toHaveTextContent("Predicted change≈ +$1,100 /mo · 70% likely");
    expect(list).toHaveTextContent("Fully loaded cost10 min of you");
    expect(list).toHaveTextContent("Measured asHoldout");
    expect(within(list).getByRole("link", { name: "Open the task →" })).toHaveAttribute("href", "/tasks/md-c1");
  });

  it("says nothing waits on the operator when the agents hold the queue, and nothing is queued when nothing is open", () => {
    const agentsOnly = renderNext({ boards: { "meadow.example": board([liveTask({ id: "md-n1", title: "Write the welcome email", ready: true })]) } });
    expect(agentsOnly.container.querySelector("[data-next-answer] h2")).toHaveTextContent("Nothing waits on you. Write the welcome email is next for the agents.");
    expect(agentsOnly.container.querySelector("[data-next-decision]")).toBeNull();
    agentsOnly.unmount();
    const empty = renderNext({ boards: { "meadow.example": board([]) } });
    expect(empty.container.querySelector("[data-next-answer] h2")).toHaveTextContent("Nothing is queued.");
  });

  it("draws a read-only snapshot with the board's banner, and the verbs off with the reason beside them", () => {
    const work = payload([project({ waiting: [item({ id: "md-q1", title: "Name the newsletter" })], ready: [item({ id: "md-n1", title: "Write the welcome email" })] })]);
    const { container } = renderNext({ work, live: false });
    expect(container.querySelector("[data-tasks-readonly]")).toHaveTextContent("Read-only snapshot");
    const region = container.querySelector<HTMLElement>("[data-next-decision]")!;
    expect(region).toHaveAttribute("data-next-decision", "md-q1");
    expect(within(region).getByRole("button", { name: "Answer" })).toBeDisabled();
    expect(region).toHaveTextContent(READ_ONLY_TASKS_HINT);
  });

  it("shows the board's empty state with no task projects", () => {
    renderNext({ work: payload([]) });
    expect(screen.getByText("No task projects available")).toBeInTheDocument();
  });
});

describe("an asset's Tasks tab", () => {
  it("opens on that asset's next decision and its other decisions, above the scoped board", () => {
    const work = payload([
      project({ epics: null }),
      project({ asset: "northwind.example", prefix: "nw", name: "Northwind" }),
    ]);
    const boards = {
      ...scenarioBoards(),
      "northwind.example": board([liveTask({ id: "nw-q1", title: "Somebody else's question", labels: ["human"], ready: true, card: CARD })], "northwind.example"),
    };
    const data = { asset: { id: "meadow.example" } } as unknown as AssetDetailFor<"tasks">;
    const { container } = renderNext({ work, boards, ui: <TasksTab data={data} /> });
    const region = container.querySelector<HTMLElement>("[data-next-decision]")!;
    const boardRoot = container.querySelector<HTMLElement>("[data-tasks-board]")!;
    expect(region).toHaveAttribute("data-next-decision", "md-c1");
    expect(region.compareDocumentPosition(boardRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[data-then-for-you]")).not.toBeNull();
    expect(container.querySelector('[data-then-row="nw-q1"]')).toBeNull();
    // Compact: no sentence, brief, agents or held-back list of its own.
    expect(container.querySelector("[data-next-answer]")).toBeNull();
    expect(container.querySelector("[data-tasks-brief]")).toBeNull();
    expect(container.querySelector("[data-agents-next]")).toBeNull();
    expect(container.querySelector("[data-not-now]")).toBeNull();
    expect(within(container.querySelector<HTMLElement>("[data-then-for-you]")!).getByRole("link", { name: "Focus →" }))
      .toHaveAttribute("href", "/tasks/focus?project=meadow.example");
  });
});

describe("the Next tab's words", () => {
  const row = (over: Partial<BoardTask> & { id: string }): BoardTask => ({
    title: over.id, status: "open", priority: 2, issueType: "task", assignee: null, updatedAt: "2026-07-31T12:00:00Z",
    closedAt: null, createdAt: "2026-07-22T12:00:00Z", parent: null, deferUntil: null, project: "example", labels: ["human"],
    ready: true, awaitType: null, ...over,
  });
  const NOW = new Date("2026-08-01T12:00:00Z");

  it("falls back to the wait when a decision holds no money and releases nothing", () => {
    const ranked = rankBoard({ tasks: [], inbox: [row({ id: "ex-q", title: "Pick a name" })], operatorRateUsdPerMin: 2, now: NOW });
    expect(nextSentence(ranked, { complete: true })).toBe("Answer one question first: it has waited 10 days.");
    const gate = rankBoard({ tasks: [], inbox: [row({ id: "ex-g", title: "Spend $40", issueType: "gate", awaitType: "human", createdAt: NOW.toISOString() })], operatorRateUsdPerMin: 2, now: NOW });
    expect(nextSentence(gate, { complete: true })).toBe("Approve one request first.");
    expect(nextSentence({ decisions: [], agents: [] }, { complete: false })).toBe("Couldn't read your decisions");
  });

  it("builds the why from the note, the work released and the priority, never from an invented figure", () => {
    expect(whySentence([{ kind: "note", text: "Opens drop on Mondays" }, { kind: "releases", count: 1, titles: ["A"] }, { kind: "priority", band: "high" }]))
      .toBe("Opens drop on Mondays. 1 task waits on this answer. High priority.");
    expect(whySentence([{ kind: "no-card" }, { kind: "waiting", days: 3 }])).toBeNull();
    expect(whyLine([{ kind: "releases", count: 2, titles: [] }, { kind: "priority", band: "top" }], "it")).toBe("2 tasks wait on it · Top priority");
  });

  it("names what a held-back task waits on, or says it waits on another task", () => {
    expect(heldBackLine({ kind: "blocked", by: [{ id: "a", title: "A" }, { id: "b", title: "B" }] })).toBe("Waits on A and 1 more");
    expect(heldBackLine({ kind: "blocked", by: [{ id: "a", title: null }] })).toBe("Waits on another task");
    expect(heldBackLine({ kind: "parked", until: null })).toBe("Parked");
  });
});
