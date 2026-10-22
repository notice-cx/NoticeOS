import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, useLocation, useSearchParams } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTask, LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import { emptyWorkHistory, type WorkPayload, type WorkProject } from "@shared/work";

// The Projects tab over the board's own read: `useTaskBoard` is stubbed with
// `readTaskBoard` itself over invented live reads, so the tab draws exactly
// what the board would. A card's verb is the board's: the same answer hook.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
}));
const answer = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-10-21T12:00:00.000Z") }));

vi.mock("@/hooks/useTaskBoard", async () => {
  const { readTaskBoard } = await import("@/lib/task-board-read");
  return {
    useTaskBoard: (scope: string | null) => ({
      data: state.work, drawn: true, isPending: false, isError: false, error: null, isFetching: false, refetch: vi.fn(), scopeKey: scope,
      ...readTaskBoard({
        capabilities: state.capabilities,
        snapshot: state.work,
        scope,
        reads: new Map(Object.entries(state.boards).map(([asset, data]) => [asset, { data, isError: false, error: null }])),
        filters: { project: "all", status: "all", priority: "all", label: "", assignee: "all" },
      }),
    }),
  };
});

vi.mock("@/hooks/useTasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTasks")>();
  return {
    ...actual,
    useTasksLive: () => state.capabilities,
    useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
    useInboxAnswer: () => answer,
    useInboxAnswers: () => vi.fn(),
  };
});

import { epicGraphs } from "@/lib/task-board-viz";
import { readTaskBoard } from "@/lib/task-board-read";
import { EpicPanel } from "@/routes/tasks/board-pictures";
import { ProjectsTab } from "@/routes/tasks/projects/ProjectsTab";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function liveTask(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    id: "md-1", title: "A task", status: "open", priority: 2, issueType: "task", assignee: null,
    updatedAt: daysAgo(1), closedAt: null, parent: null, deferUntil: null,
    description: "", acceptance: "", labels: [], ready: false, dependencies: [], comments: 0, metadata: null,
    createdAt: daysAgo(2), startedAt: null, closeReason: null, awaitType: null,
    ...overrides,
  };
}

const blocks = (id: string) => [{ id, type: "blocks", title: null, status: null }];

function snapshotRow(asset: string, prefix: string, name: string): WorkProject {
  return {
    asset, prefix, name, ok: true, error: null,
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    history: emptyWorkHistory(), priorities: null, epics: null,
    ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [],
  };
}

function liveBoard(asset: string, prefix: string, tasks: LiveTask[], epics: { id: string; title: string }[]): LiveTasksPayload {
  return {
    project: asset, prefix, repo: `../${asset}`, readAt: "2026-10-21T11:59:00.000Z", tasks,
    epics: epics.map((epic) => ({ ...epic, status: "open", priority: 2, total: 0, closed: 0, eligibleForClose: false })),
  };
}

const meadow = liveBoard("meadow.example", "md", [
  liveTask({ id: "md-1", title: "Draft the schema", parent: "md-e", status: "closed", closedAt: daysAgo(5) }),
  liveTask({ id: "md-2", title: "Load the recipes", parent: "md-e", dependencies: blocks("md-g") }),
  liveTask({ id: "md-g", title: "Approve the new schema", parent: "md-e", issueType: "gate", awaitType: "human", createdAt: daysAgo(9) }),
  liveTask({ id: "md-f.1", title: "Compress the images", parent: "md-f", priority: 1, ready: true }),
  liveTask({ id: "md-f.2", title: "Lazy-load the gallery", parent: "md-f", dependencies: blocks("md-f.1") }),
], [{ id: "md-e", title: "Recipe overhaul" }, { id: "md-f", title: "Faster pages" }]);

const northwind = liveBoard("northwind.example", "nw", [
  liveTask({ id: "nw-1", title: "Cache the cart", parent: "nw-e", status: "in_progress", assignee: "claude-code", startedAt: daysAgo(3) }),
  liveTask({ id: "nw-2", title: "Trim the form", parent: "nw-e", ready: true }),
  liveTask({ id: "nw-3", title: "Fix the footer link", ready: true }),
], [{ id: "nw-e", title: "Checkout" }]);

function setUp(boards: Record<string, LiveTasksPayload> = { "meadow.example": meadow, "northwind.example": northwind }) {
  state.boards = boards;
  state.work = {
    generatedAt: "2026-10-21T12:00:00.000Z", capturedAt: "2026-10-21T11:59:00.000Z", pollCadenceHours: 1 / 60,
    owner: "config/beads.json", historyDays: 0,
    projects: [snapshotRow("meadow.example", "md", "Meadow"), snapshotRow("northwind.example", "nw", "Northwind")]
      .filter((row) => boards[row.asset] !== undefined),
  };
}

function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderTab(scope: string | null = null, entry = "/tasks/projects") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ProjectsTab scope={scope} />
        <Search />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-project-card="${id}"]`)!;

afterEach(() => {
  answer.mockReset();
});

describe("the Projects tab", () => {
  it("counts the assets and projects, then what waits on you and what is urgent, each in its colour", () => {
    setUp();
    const { container } = renderTab();
    const sentence = container.querySelector("[data-projects-answer] h2")!;
    expect(sentence).toHaveTextContent("2 assets, 3 projects. 1 waits on you, 1 urgent.");
    expect(sentence.querySelector('[data-clause="waits"]')).toHaveClass("text-warn");
    expect(sentence.querySelector('[data-clause="urgent"]')).toHaveClass("text-urgent");
    expect(sentence.querySelector('[data-clause="blocked"]')).toBeNull();
  });

  it("says nothing waits on you when nothing does, and counts only projects on an asset's own tab", () => {
    setUp({ "northwind.example": northwind });
    const { container } = renderTab("northwind.example");
    expect(container.querySelector("[data-projects-answer] h2")).toHaveTextContent("1 project. Nothing waits on you.");
    // Scoped, the cards stand alone: no site rows.
    expect(container.querySelector("[data-site-row]")).toBeNull();
    expect(card(container, "nw-e")).not.toBeNull();
  });

  it("splits the open work by state, with who is working now", () => {
    setUp();
    const { container } = renderTab();
    const work = container.querySelector<HTMLElement>("[data-projects-open-work]")!;
    expect(within(work).getByRole("img")).toHaveAccessibleName(/1 in progress/);
    expect(work.querySelector('[data-open-work="in-progress"]')).toHaveTextContent("1 in progress");
    expect(work.querySelector("[data-tasks-working]")).toHaveTextContent(/Working now\s*claude-code 1/);
  });

  it("draws an asset's cards with their state, progress and the question waiting on you", () => {
    setUp();
    const { container } = renderTab();
    const meadowRow = container.querySelector<HTMLElement>('[data-site-row="meadow.example"]')!;
    expect(meadowRow).toHaveTextContent("1 for you");
    const recipes = card(container, "md-e");
    expect(recipes.querySelector("[data-project-chip]")).toHaveTextContent("Needs you · 9d");
    expect(recipes.querySelector("[data-project-rule]")).toHaveClass("bg-warn");
    expect(within(recipes).getByRole("img", { name: "3 tasks: 1 done, 1 needs you, 1 waiting" })).toBeInTheDocument();
    expect(recipes.querySelector("[data-project-facts]")).toHaveTextContent("1 of 3 done");
    expect(within(recipes).getByRole("link", { name: "Recipe overhaul" })).toHaveAttribute("href", "/tasks/md-e");
    expect(within(recipes).getByRole("link", { name: "Approve the new schema" })).toHaveAttribute("href", "/tasks/md-g");

    const pages = card(container, "md-f");
    expect(pages.querySelector("[data-project-chip]")).toHaveTextContent("Urgent");
    expect(pages.querySelector('[data-project-next="nobody"]')).toHaveTextContent("Compress the images · nobody yet");

    const checkout = card(container, "nw-e");
    expect(checkout.querySelector("[data-project-chip]")).toHaveTextContent("In progress");
    expect(container.querySelector('[data-site-loose="1"]')).toHaveTextContent("Not in a project · 1 open");
  });

  it("approves from the card through the board's own answer", () => {
    setUp();
    const { container } = renderTab();
    fireEvent.click(within(card(container, "md-e")).getByRole("button", { name: "Approve" }));
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ kind: "approve", id: "md-g", title: "Approve the new schema", project: "meadow.example" }));
  });

  it("orders the cards by the pressed pill", () => {
    setUp();
    const { container } = renderTab();
    const order = () => [...container.querySelectorAll('[data-site-row="meadow.example"] [data-project-card]')].map((node) => node.getAttribute("data-project-card"));
    expect(screen.getByRole("button", { name: "Needs attention first" })).toHaveAttribute("aria-pressed", "true");
    expect(order()).toEqual(["md-e", "md-f"]);
    fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
    expect(screen.getByRole("button", { name: "A–Z" })).toHaveAttribute("aria-pressed", "true");
    expect(order()).toEqual(["md-f", "md-e"]);
  });

  it("keeps the timeline view in the URL, and ends every view with the work in no project", () => {
    setUp();
    const { container } = renderTab();
    expect(container.querySelector("[data-project-journeys]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByTestId("search").textContent).toBe("?view=timeline");
    expect(container.querySelector("[data-project-journeys]")).toHaveAttribute("data-project-journeys", "3");
    // The rows are in the cards' default order.
    expect([...container.querySelectorAll("[data-journey-row]")].map((node) => node.getAttribute("data-journey-row"))).toEqual(["md-e", "md-f", "nw-e"]);
    expect(screen.getByText("That's every project.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 open task sits in no project →" })).toHaveAttribute("href", "/tasks/all");
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(screen.getByTestId("search").textContent).toBe("");
  });
});

describe("the project rail on All tasks", () => {
  function Harness() {
    const [params, setParams] = useSearchParams();
    const board = readTaskBoard({
      capabilities: state.capabilities, snapshot: state.work,
      reads: new Map(Object.entries(state.boards).map(([asset, data]) => [asset, { data, isError: false, error: null }])),
      filters: { project: "all", status: "all", priority: "all", label: "", assignee: "all" },
    });
    const graphs = epicGraphs({ projects: board.projects, snapshots: [], nowMs: NOW, href: (task) => `/tasks/${task.id}` });
    return <EpicPanel graphs={graphs} selected={params.get("epic")} onSelect={(id) => setParams({ epic: id }, { replace: true })} nowMs={NOW} />;
  }

  function renderRail() {
    setUp();
    const client = new QueryClient();
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tasks/all"]}>
          <Harness />
          <Search />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("picks an epic from its card, keeps it in the URL and redraws the graph", () => {
    const { container } = renderRail();
    const rail = screen.getByRole("radiogroup", { name: "Epics" });
    const radios = within(rail).getAllByRole("radio");
    // Needs attention first: the epic waiting on you leads.
    expect(radios.map((radio) => radio.getAttribute("data-rail-item"))).toEqual(["md-e", "md-f"]);
    expect(within(radios[0]!).getByText("Needs you · 9d")).toHaveClass("text-warn");
    const panel = () => container.querySelector<HTMLElement>("[data-tasks-epic]")!;
    const first = panel().getAttribute("data-tasks-epic");
    const other = first === "md-e" ? "md-f" : "md-e";
    const otherTitle = other === "md-e" ? "Recipe overhaul" : "Faster pages";
    fireEvent.click(within(rail).getByRole("radio", { name: new RegExp(otherTitle) }));
    expect(screen.getByTestId("search").textContent).toBe(`?epic=${other}`);
    expect(panel()).toHaveAttribute("data-tasks-epic", other);
    expect(within(panel()).getAllByText(otherTitle)[0]).toHaveClass("text-base");
    expect(within(rail).getByRole("radio", { name: new RegExp(otherTitle) })).toHaveAttribute("aria-checked", "true");
  });

  it("moves the pick with the arrow keys", () => {
    renderRail();
    const rail = screen.getByRole("radiogroup", { name: "Epics" });
    const checked = () => within(rail).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")!;
    const before = checked().getAttribute("data-rail-item");
    fireEvent.keyDown(checked(), { key: "ArrowRight" });
    const after = checked().getAttribute("data-rail-item");
    expect(after).not.toBe(before);
    expect(screen.getByTestId("search").textContent).toBe(`?epic=${after}`);
    expect(document.activeElement).toBe(checked());
  });
});
