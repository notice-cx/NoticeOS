import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTask, LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "@shared/tasks";
import { emptyWorkHistory, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";

// `/tasks` — doc 14's index template over the task database (bead `ro-78qo.12`).
//
// WHAT THE REBUILD KEPT, and therefore what this file is mostly about: the five
// filters are still the URL, claim / close / defer / respond / dismiss / resolve
// still run through the local read as the operator, every row still opens at
// `/tasks/:id`, and the same component still draws the asset page's Tasks tab
// with one prop set. What changed is the SHAPE — a KPI strip, a five-row inbox
// panel and one paged table instead of a card per project, a card per epic and a
// heading per lane — so every assertion about layout is new and every assertion
// about behaviour is the one that was here before.
//
// WHAT IS MOCKED AND WHY. The two READS are hooks (`useWork`, `useTasksLive`,
// `useTasksAcross`), so they are stubbed with fixtures — this file is about what
// the page does with a payload, not about react-query. The WRITES are not: the
// real mutation hooks run, over a real QueryClient, against a mocked
// `src/lib/api`. That is deliberate — "Claim calls the local read with --claim"
// is only an assertion if the argv-shaped call is what gets asserted, and
// mocking the hook instead would have tested that a button calls a function this
// test wrote.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  isPending: false,
  capabilities: { live: false, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  errors: {} as Record<string, string>,
  /** Every project list `useTasksAcross` was asked for, in order. */
  acrossCalls: [] as string[][],
}));

const api = vi.hoisted(() => ({
  updateTask: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
  respondToTask: vi.fn(async () => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  createTask: vi.fn(async () => ({ id: "mp-new", project: "meals.example" })),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));

vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({ data: state.work, isPending: state.isPending, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-08-01T12:00:00.000Z"),
}));

vi.mock("@/hooks/useTasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTasks")>();
  return {
    ...actual,
    useTasksLive: () => state.capabilities,
    useTasksAcross: (projects: string[]) => {
      state.acrossCalls.push(projects);
      return projects.map((project) => ({
        data: state.capabilities.live ? state.boards[project] : undefined,
        isError: state.errors[project] !== undefined,
        error: state.errors[project] ? new Error(state.errors[project]) : null,
      }));
    },
  };
});

import { deskRoutes } from "@/App";
import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { TasksRoute } from "@/routes/TasksRoute";
import { TasksBoard } from "@/routes/tasks/TasksBoard";
import { statusFace } from "@/routes/tasks/task-face";
import { STATE_TONE } from "@/components/StateChip";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

// ── fixtures ─────────────────────────────────────────────────────────────────

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "mp-1w2",
    title: "Fix the recipe schema",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-08-01T11:55:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
    ...overrides,
  };
}

function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    asset: "meals.example",
    prefix: "mp",
    name: "Meal Planner",
    ok: true,
    error: null,
    counts: {
      open: 3,
      highPriority: 1,
      ready: 2,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
      deferred: 0,
      waiting: 0,
    },
    priorities: [1, 0, 3, 0, 0],
    epics: null,
    deferred: [],
    waiting: [],
    ready: [item(), item({ id: "mp-88x", title: "Rewrite the FAQ", priority: 0 })],
    inProgress: [
      item({ id: "mp-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" }),
    ],
    recentlyClosed: [],
    history: emptyWorkHistory(),
    ...overrides,
  };
}

function payload(overrides: Partial<WorkPayload> = {}): WorkPayload {
  return {
    generatedAt: "2026-08-01T12:00:00.000Z",
    capturedAt: "2026-08-01T11:59:00.000Z",
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects: [project()],
    historyDays: 0,
    ...overrides,
  };
}

/** One project whose daily rollup holds `days` days of every count — the shape
 * `/api/work` carries once migration 0032 has been applied and has run. */
function withHistory(days = 4): WorkProject {
  const series = (base: number) =>
    Array.from({ length: days }, (_unused, index) => ({
      t: `2026-07-${String(28 + index).padStart(2, "0")}`,
      v: base + index,
    }));
  return project({
    history: {
      waiting: series(1),
      urgent: series(2),
      open: series(3),
      inProgress: series(1),
      blocked: series(0),
      closed: series(2),
    },
  });
}

function liveTask(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    ...item(),
    description: "",
    acceptance: "",
    labels: [],
    ready: false,
    dependencies: [],
    comments: 0,
    metadata: null,
    createdAt: null,
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...overrides,
  };
}

function board(
  tasks: LiveTask[],
  epics: LiveTasksPayload["epics"] = null,
  asset = "meals.example",
): LiveTasksPayload {
  return {
    project: asset,
    prefix: "mp",
    repo: "../meals.example",
    readAt: "2026-08-01T11:59:30.000Z",
    tasks,
    epics,
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

/** The current query string, so "the filter is the URL" is asserted against the
 * URL rather than against what the control happens to look like. */
function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function TaskDestination() {
  const location = useLocation();
  return <output data-testid="task-destination" data-return-to={location.state?.returnTo}>{location.pathname}</output>;
}

interface Options {
  data?: WorkPayload | null;
  live?: boolean;
  boards?: Record<string, LiveTasksPayload>;
  errors?: Record<string, string>;
  entry?: string;
  isPending?: boolean;
}

function renderBoard({
  data = payload(),
  live = false,
  boards = {},
  errors = {},
  entry = "/tasks",
  isPending = false,
}: Options = {}) {
  state.work = data;
  state.isPending = isPending;
  state.capabilities = live
    ? { live: true, reason: null }
    : { live: false, reason: READ_ONLY_DEPLOYMENT };
  state.boards = boards;
  state.errors = errors;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDestination />} />
          <Route
            path="/tasks"
            element={
              <>
                <TasksRoute />
                <Search />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** One row of the table, by the id it renders. */
function row(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`tr[data-task-row="${id}"]`);
  expect(found, `row ${id}`).not.toBeNull();
  return found!;
}

/** Open a row in place and hand back what it revealed — the claim/close/defer
 * verbs live behind the same press that shows the evidence (doc 14). */
function open(container: HTMLElement, id: string): HTMLElement {
  fireEvent.click(within(row(container, id)).getByRole("button", { expanded: false }));
  const detail = container.querySelector<HTMLElement>(`[data-task-detail="${id}"]`);
  expect(detail, `expanded row ${id}`).not.toBeNull();
  return detail!;
}

it('shows the selected workspace member name in an expanded board row without changing its assignee ID', () => {
  const principal = '11111111-1111-4111-8111-111111111111';
  const value = board([liveTask({ id: 'mp-1w2', assignee: principal, status: 'in_progress' })]);
  value.actors = [{ principalId: principal, displayName: 'Current operator' }];
  const { container } = renderBoard({ live: true, boards: { 'meals.example': value } });
  const detail = open(container, 'mp-1w2');
  expect(screen.getByRole('option', { name: 'Current operator · 1' })).toHaveValue(principal);
  expect(within(detail).getByText('Claimed by Current operator')).toBeInTheDocument();
  expect(within(detail).queryByText(principal)).not.toBeInTheDocument();
  expect(value.tasks[0].assignee).toBe(principal);
});

/** The answer's figures (D45), by label, in the order they are drawn. */
function figures(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-page-answer-figures] dt")].map((node) => node.textContent ?? "");
}

/** One figure beside the answer, by its mark: Urgent, Blocked, Closed this week. */
function fig(container: HTMLElement, mark: "urgent" | "blocked" | "closed"): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-tasks-${mark}]`);
  if (found === null) throw new Error(`no ${mark} figure beside the answer`);
  return found;
}

/** The page's one sentence. */
function answerLine(container: HTMLElement): string {
  return container.querySelector("[data-tasks-answer] h2")?.textContent ?? "";
}

afterEach(() => {
  resetTaskSourceMock();
  state.work = null;
  state.isPending = false;
  state.capabilities = { live: false, reason: null };
  state.boards = {};
  state.errors = {};
  state.acrossCalls = [];
  resetAnswerQueue();
  vi.clearAllMocks();
});

// ── the first screen ─────────────────────────────────────────────────────────

describe("/tasks — the first screen answers the page's one question", () => {
  it("is the answer and the inbox, and nothing else is above the fold", () => {
    const { container } = renderBoard();

    expect(screen.getByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector("[data-tasks-answer]")).not.toBeNull();
    expect(hero.querySelector("[data-kpi-strip]")).toBeNull();
    // The table and its filters are BELOW the answer, never above or in it.
    expect(hero.compareDocumentPosition(container.querySelector("#tasks-status")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hero.querySelector("table")).toBeNull();
  });

  it("answers what waits on you, with the three counts that change what you do next", () => {
    const { container } = renderBoard();
    expect(answerLine(container)).toBe("Nothing waits on you");
    expect(figures(container)).toEqual(["Urgent", "Blocked", "Closed this week"]);
  });

  it("counts over the whole board rather than over the current filter", () => {
    const { container } = renderBoard({
      entry: "/tasks?status=blocked",
      data: payload({
        projects: [
          project({
            counts: {
              open: 3,
              highPriority: 1,
              ready: 2,
              inProgress: 1,
              blocked: 4,
              closedRecent: 6,
              deferred: 0,
              waiting: 0,
            },
          }),
        ],
      }),
    });

    // "how much is blocked" is a fact about the portfolio and stays true
    // whatever the table below has been narrowed to.
    expect(fig(container, "blocked")).toHaveTextContent("4");
    expect(fig(container, "closed")).toHaveTextContent("6");
  });



  it("says a count nobody measured is unknown rather than zero", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            counts: {
              open: 3,
              highPriority: null,
              ready: 2,
              inProgress: 1,
              blocked: 0,
              closedRecent: 0,
              deferred: null,
              waiting: null,
            },
          }),
        ],
      }),
    });

    expect(fig(container, "urgent")).toHaveTextContent("—");
  });

  it("needs no paragraph: no About, and no line over the label budget", () => {
    // Bead ro-ujb9.96.6.11: every fact the old About carried is now the state
    // that owns it — the strip, the banners, the empty-state links.
    const { container } = renderBoard();
    expect(container.querySelector("[data-about]")).toBeNull();
    for (const node of container.querySelectorAll("p, [role=status]")) {
      expect(node.textContent!.trim().split(/\s+/).length, node.textContent!).toBeLessThanOrEqual(12);
    }
  });

  it("shows no owner chip and no config path — this is a view surface", () => {
    const { container } = renderBoard();
    expect(container.querySelector("[data-owner-chip]")).toBeNull();
    expect(container.textContent).not.toContain("config/beads.json");
  });
});

// ── the board ────────────────────────────────────────────────────────────────

describe("/tasks — the board is one table", () => {
  it("draws every project's work in one table, one line each", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project(),
          project({
            asset: "root-os",
            prefix: "ro",
            name: "NoticeOS",
            ready: [item({ id: "ro-9zz", title: "Somebody else's queue" })],
            inProgress: [],
          }),
        ],
      }),
    });

    // One table, not one section per project.
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(row(container, "mp-1w2")).toBeInTheDocument();
    expect(row(container, "ro-9zz")).toBeInTheDocument();
    // The project is a COLUMN now, not a card heading.
    expect(within(row(container, "ro-9zz")).getByText("NoticeOS")).toBeInTheDocument();
  });

  it("leads with what is urgent, then with what has gone longest untouched", () => {
    const { container } = renderBoard();
    const ids = [...container.querySelectorAll("tr[data-task-row]")].map((node) =>
      node.getAttribute("data-task-row"),
    );
    // mp-88x is P0; the rest are P2 and sort by last activity.
    expect(ids[0]).toBe("mp-88x");
  });

  it("sinks parked work below live work and closed work below that", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            deferred: [
              item({ id: "mp-park", title: "Wait for the season", status: "deferred", priority: 0 }),
            ],
            recentlyClosed: [
              item({ id: "mp-done", title: "Shipped the redirect", status: "closed", priority: 0 }),
            ],
          }),
        ],
      }),
    });

    const ids = [...container.querySelectorAll("tr[data-task-row]")].map((node) =>
      node.getAttribute("data-task-row"),
    );
    // Both are P0 and would otherwise lead the board; neither is hidden.
    expect(ids.indexOf("mp-park")).toBeGreaterThan(ids.indexOf("mp-1w2"));
    expect(ids.indexOf("mp-done")).toBe(ids.length - 1);
  });

  it("draws closed, in progress and an unknown status from the task page's own status face (bead ro-ujb9.202)", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            ready: [item({ id: "mp-odd", status: "triaged" })],
            recentlyClosed: [item({ id: "mp-done", title: "Shipped the redirect", status: "closed" })],
          }),
        ],
      }),
    });

    for (const [id, stored] of [["mp-done", "closed"], ["mp-33j", "in_progress"], ["mp-odd", "triaged"]] as const) {
      const face = statusFace(stored);
      const word = within(row(container, id)).getAllByText(face.label)[0]!;
      expect(word, id).toHaveAttribute("data-task-status", face.key);
      // The word and its glyph wear the face's own ink — the chip's ink on the
      // task page — so a closed task is grey here exactly as it is there.
      expect(word.className, id).toContain(STATE_TONE[face.tone].text);
      const glyph = row(container, id).querySelector(`[data-task-status-glyph="${face.key}"]`)!;
      expect(glyph, id).not.toBeNull();
      expect(glyph.getAttribute("class"), id).toContain(STATE_TONE[face.tone].text);
    }
    // A closed task wears no green anywhere on its row, the mark included.
    const closed = row(container, "mp-done");
    expect(closed.innerHTML).not.toContain("healthy");
    expect(closed.querySelector("[data-task-rest-mark]")).toHaveAttribute("data-task-rest-mark", "closed");
    expect(statusFace("closed").tone).toBe("na");
    expect(statusFace("in_progress").tone).toBe("affirmative");
    expect(statusFace("triaged")).toMatchObject({ key: "unknown", label: "triaged", tone: "neutral" });
    // Neither does the week's count of closings.
    expect(fig(container, "closed").innerHTML).not.toContain("healthy");
  });

  it("renders a state this build has never seen, without inventing one for it", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [project({ ready: [item({ id: "mp-odd", status: "triaged" })], inProgress: [] })],
      }),
    });

    // Twice per row: the desk's State column and the summary line a stacked
    // phone row shows in its place. Both say the raw value, neither invents one.
    const words = within(row(container, "mp-odd")).getAllByText("triaged");
    expect(words).toHaveLength(2);
    for (const word of words) expect(word.getAttribute("data-task-status")).toBe("unknown");
  });

  it("pages 25 rows at a time and says how many are left", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      item({ id: `mp-${index}`, title: `Task ${index}` }),
    );
    const { container } = renderBoard({
      data: payload({ projects: [project({ ready: many, inProgress: [] })] }),
    });

    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    // The count is the board's; how many are left is the button's to say.
    expect(container.querySelector("[data-tasks-summary]")!.textContent).toBe("60");
    expect(container.querySelector("[data-tasks-more]")!.textContent).toContain("35 left");

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(50);

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(60);
    // Nothing left to load, so nothing to press.
    expect(container.querySelector("[data-tasks-more]")).toBeNull();
  });

  it("starts a narrowed board at its own first page", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      item({ id: `mp-${index}`, title: `Task ${index}`, status: index < 30 ? "open" : "blocked" }),
    );
    const { container } = renderBoard({
      data: payload({ projects: [project({ ready: many, inProgress: [] })] }),
    });

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(50);

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "blocked" },
    });
    // 30 blocked rows, and the reader is back on the first 25 of them rather
    // than looking at 50 rows of a filter they have just applied.
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
  });

  it("expands a row in place instead of navigating away from the board", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            epics: [
              {
                id: "mp-epic",
                title: "Recipe schema overhaul",
                status: "open",
                priority: 1,
                total: 8,
                closed: 3,
                counts: { open: 4, inProgress: 1, blocked: 0, deferred: 0 },
                priorities: [0, 1, 4, 0, 0],
              },
            ],
            ready: [item({ id: "mp-1w2", parent: "mp-epic" })],
            inProgress: [],
          }),
        ],
      }),
    });

    const detail = open(container, "mp-1w2");
    // The epic is a fact ABOUT a task now, not thirty containers above the work.
    expect(detail.textContent).toContain("Part of Recipe schema overhaul");
    expect(detail.querySelector('[data-task-action="claim"]')).not.toBeNull();
  });
});

// ── the filters ──────────────────────────────────────────────────────────────

describe("/tasks — the filters are the URL", () => {
  const many = payload({
    projects: [
      project({
        counts: {
          open: 2,
          highPriority: 1,
          ready: 1,
          inProgress: 1,
          blocked: 1,
          closedRecent: 1,
          deferred: 1,
          waiting: 0,
        },
        ready: [item(), item({ id: "mp-88x", title: "Rewrite the FAQ", priority: 0 })],
        inProgress: [item({ id: "mp-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" })],
        deferred: [item({ id: "mp-zzz", title: "Wait for the season", status: "deferred" })],
        recentlyClosed: [item({ id: "mp-old", title: "Shipped the redirect", status: "closed" })],
      }),
    ],
  });
  // The project filter is drawn only when there is a second project to pick.
  const twoProjects = payload({
    projects: [
      ...many.projects,
      project({ asset: "nosh.example", prefix: "nom", name: "Nosh", ready: [], inProgress: [],
      }),
    ],
  });

  it("is five controls and no more — the counts moved to the strip", () => {
    const { container } = renderBoard({ data: twoProjects, live: true,
    });
    const filters = container.querySelector("[data-tasks-filters]")!;
    // doc 14's "avoid overwhelming": twelve status/priority chips became two
    // selects, because the strip two lines above already answers "how much".
    expect(filters.querySelectorAll("select")).toHaveLength(4);
    expect(filters.querySelectorAll("input")).toHaveLength(1);
    // The one button is the phone's fold (bead ro-ujb9.13), hidden from `sm` up;
    // the controls themselves hold none.
    expect(filters.querySelector("[data-filter-controls]")!.querySelectorAll("button")).toHaveLength(0);
    const fold = within(filters as HTMLElement).getByRole("button", { name: "Filters" });
    expect(fold).toHaveClass("sm:hidden");
    expect(fold).toHaveAttribute("aria-expanded", "false");
  });

  it("folds the five controls behind one Filters press on a phone, counting those narrowing the board", () => {
    const { container } = renderBoard({ data: twoProjects, live: true, entry: "/tasks?status=open&priority=high&label=seo" });
    const filters = container.querySelector("[data-tasks-filters]")!;
    const controls = filters.querySelector("[data-filter-controls]")!;
    expect(controls).toHaveClass("max-sm:hidden");
    const fold = within(filters as HTMLElement).getByRole("button", { name: "Filters, 3 on" });
    expect(fold).toHaveAttribute("aria-controls", controls.id);
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(controls).not.toHaveClass("max-sm:hidden");
    // The board's age is a fact about the list, not a filter: never folded.
    expect(filters.lastElementChild).not.toBe(controls);
  });

  it("names each filter, and does not print the same total four times", () => {
    const { container } = renderBoard({ data: twoProjects });
    // The closed label of a select IS its selected option, and four controls
    // each reading "· 206" was the same number stated four times across one row
    // (doc 14). The count stays on every option a reader opens the list to see.
    for (const id of ["tasks-project", "tasks-status", "tasks-priority", "tasks-assignee"]) {
      const select = container.querySelector<HTMLSelectElement>(`#${id}`)!;
      expect(select.options[0]!.textContent).not.toContain("·");
    }
    expect(
      container.querySelector<HTMLSelectElement>("#tasks-status")!.options[0]!.textContent,
    ).toBe("Any status");
  });

  it("carries every option's own count, over the whole board", () => {
    const { container } = renderBoard({ data: many });
    const status = container.querySelector<HTMLSelectElement>("#tasks-status")!;
    const labels = [...status.options].map((option) => option.textContent);
    expect(labels).toContain("Open · 2");
    expect(labels).toContain("In progress · 1");
    expect(labels).toContain("Parked · 1");
    expect(labels).toContain("Closed this week · —");
  });

  it("puts a picked status in the query string and narrows the table to it", () => {
    const { container } = renderBoard({ data: many });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "in-progress" },
    });
    expect(screen.getByTestId("search").textContent).toBe("?status=in-progress");
    expect(container.querySelector('tr[data-task-row="mp-33j"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-1w2"]')).toBeNull();
  });

  it("reads the whole filter vocabulary back out of the URL", () => {
    const { container } = renderBoard({
      data: many,
      entry: "/tasks?project=meals.example&status=open&priority=top&assignee=agent-x&label=ux",
    });

    expect(container.querySelector<HTMLSelectElement>("#tasks-project")!.value).toBe(
      "meals.example",
    );
    expect(container.querySelector<HTMLSelectElement>("#tasks-status")!.value).toBe("open");
    expect(container.querySelector<HTMLSelectElement>("#tasks-priority")!.value).toBe("top");
    expect(container.querySelector<HTMLSelectElement>("#tasks-assignee")!.value).toBe("agent-x");
    expect(container.querySelector<HTMLInputElement>("#tasks-label")!.value).toBe("ux");
  });

  it("narrows to one project, and the default never occupies the query string", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project(),
          project({ asset: "nosh.example", prefix: "nom", name: "Nosh", ready: [], inProgress: [] }),
        ],
      }),
    });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-project")!, {
      target: { value: "nosh.example" },
    });
    expect(screen.getByTestId("search").textContent).toBe("?project=nosh.example");

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-project")!, {
      target: { value: "all" },
    });
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it("offers every assignee it has actually seen, with its count", () => {
    const { container } = renderBoard({ data: many });
    const assignee = container.querySelector<HTMLSelectElement>("#tasks-assignee")!;
    expect([...assignee.options].map((option) => option.value)).toEqual(["all", "agent-x"]);
    expect(assignee.options[1]!.textContent).toBe("agent-x · 1");
  });

  it("filters by label on the live read", () => {
    const { container } = renderBoard({
      live: true,
      boards: {
        "meals.example": board([
          liveTask({ id: "mp-1w2", labels: ["ux"] }),
          liveTask({ id: "mp-88x", title: "Rewrite the FAQ", labels: ["copy"] }),
        ]),
      },
      entry: "/tasks?label=ux",
    });

    expect(container.querySelector('tr[data-task-row="mp-1w2"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-88x"]')).toBeNull();
  });

  it("offers no label filter on the photograph, whose rows carry no labels", () => {
    // A field that can never match is not drawn — rather than drawn disabled
    // with a sentence explaining why.
    const { container } = renderBoard();
    expect(container.querySelector("#tasks-label")).toBeNull();
    // One project is not a choice either (bead ro-ujb9.130).
    expect(container.querySelector("#tasks-project")).toBeNull();
    expect(container.querySelector("[data-tasks-filters]")!.querySelectorAll("select")).toHaveLength(3);
  });

  it("clears every filter with one link", () => {
    const { container } = renderBoard({ data: many, entry: "/tasks?status=open&priority=top" });
    fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
    expect(screen.getByTestId("search").textContent).toBe("");
    expect(container.querySelector("[data-tasks-filters]")!.textContent).not.toContain(
      "Clear filters",
    );
  });
});

// ── the inbox ────────────────────────────────────────────────────────────────

describe("/tasks — Waiting on you leads, and it can be answered", () => {
  const withInbox = payload({
    projects: [
      project({
        counts: {
          open: 3,
          highPriority: 1,
          ready: 2,
          inProgress: 1,
          blocked: 0,
          closedRecent: 0,
          deferred: 0,
          waiting: 2,
        },
        waiting: [
          item({ id: "mp-gate", title: "Gate: human — approve the spend", issueType: "gate", priority: 2 }),
          item({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1 }),
        ],
      }),
    ],
  });

  it("puts the gate first, above everything else on the page", () => {
    const { container } = renderBoard({ data: withInbox });
    const inbox = container.querySelector("[data-waiting-list]")!;
    const titles = [...inbox.querySelectorAll("li")].map((node) => node.textContent ?? "");
    expect(titles[0]).toContain("approve the spend");
    expect(titles[1]).toContain("Decide the Korea trip");
    // The project is the row's caption; the id is on the task's own page
    // (doc 14 altitude, as Home's Decide row says it).
    expect(titles[1]).toContain("Meal Planner");
    expect(titles[1]).not.toContain("mp-9k1");
    expect(titles[0]).toContain("needs your approval");
  });

  it("wears warn on a top-priority ask like every other ask, never error (bead ro-ujb9.200)", () => {
    // A task's priority is not a severity (doc 14): the operator being the
    // blocker is a call for attention at every priority, a gate included.
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            waiting: [
              item({ id: "mp-gate", title: "Gate: human — approve the spend", issueType: "gate", priority: 0 }),
              item({ id: "mp-top", title: "Pick the launch date", priority: 0 }),
              item({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1 }),
              item({ id: "mp-low", title: "Name the newsletter", priority: 3 }),
            ],
          }),
        ],
      }),
    });
    for (const id of ["mp-gate", "mp-top", "mp-9k1", "mp-low"]) {
      const ring = container.querySelector(`[data-inbox-row="${id}"] span[aria-hidden]`)!;
      expect(ring.className, id).toContain("text-warn");
      expect(ring.className, id).not.toContain("text-error");
    }
  });

  it("ranks the board's rows and the Urgent count by ink, never by an attention hue (bead ro-ujb9.200)", () => {
    const { container } = renderBoard();
    const top = container.querySelector('[data-task-row="mp-88x"] [data-priority-mark]')!;
    expect(top.getAttribute("data-priority-mark")).toBe("top");
    expect(top.className).toContain("bg-foreground");
    expect(container.querySelector('[data-task-row="mp-1w2"] [data-priority-mark]')).toHaveAttribute(
      "data-priority-mark",
      "normal",
    );
    for (const mark of container.querySelectorAll("[data-task-row] [data-priority-mark]")) {
      expect(mark.className).not.toMatch(/\btext-(error|warn|info)\b/);
    }
    expect(fig(container, "urgent").innerHTML).not.toContain("text-error");
  });

  it("keeps approval and saved-sample status visible while moving definitions on demand", () => {
    const { container } = renderBoard({ data: withInbox });
    // The approval is said in the answer's own words, never "gate".
    const answer = container.querySelector("[data-tasks-answer]")!;
    expect(answer).toHaveTextContent("1 needs your approval");
    expect(answer).not.toHaveTextContent(/gate/);
    // The saved sample is said ONCE, by the Read-only snapshot banner; the
    // tile keeps only its period.
    expect(container.querySelector("[data-tasks-readonly]")).toHaveTextContent("Read-only snapshot");
    expect(container.querySelector("button button, a button")).toBeNull();
  });

  it("keeps a human gate through live refresh and removes only the resolved ask, excluding timer gates", () => {
    const { container } = renderBoard({
      data: withInbox,
      live: true,
    });
    const inbox = within(container.querySelector("[data-waiting-list]") as HTMLElement);
    expect(inbox.getByRole("button", { name: /approve the spend/ })).toBeTruthy();

    const gateTask = liveTask({ id: "mp-gate", title: "Approve the spend", issueType: "gate", awaitType: "human" });
    const otherTasks = [
      liveTask({ id: "mp-timer", title: "Wait for tomorrow", issueType: "gate", awaitType: "timer" }),
      liveTask({ id: "mp-9k1", title: "Decide the Korea trip", labels: ["human"], ready: true }),
    ];
    state.boards = { "meals.example": board([gateTask, ...otherTasks]) };
    // A URL change rerenders the mocked live read without remounting the panel.
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "open" } });
    expect(inbox.getByText("2 asks")).toBeTruthy();
    expect(inbox.queryByText("Wait for tomorrow")).toBeNull();
    expect(container.querySelector('[data-task-row="mp-timer"]')).toBeNull();
    const gate = within(container.querySelector('[data-inbox-row="mp-gate"]') as HTMLElement);
    expect(gate.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(gate.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(api.resolveGate).not.toHaveBeenCalled();

    state.boards = { "meals.example": board([
      { ...gateTask, status: "closed", closedAt: "2026-08-01T11:59:45.000Z" }, ...otherTasks,
    ]) };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "all" },
    });
    expect(inbox.getByText("1 ask")).toBeTruthy();
    expect(inbox.queryByRole("button", { name: /Approve the spend/ })).toBeNull();
    expect(inbox.getByRole("button", { name: /Decide the Korea trip/ })).toBeTruthy();
  });

  it("puts each decision on its row, and keeps the evidence behind the press that opens it", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meals.example": board([
        liveTask({ id: "mp-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human",
          description: "Spend $40 on the launch ads." }),
        liveTask({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
      ]),
    } });
    // Bead ro-ujb9.96.7.11 (Linear Triage): one press per decision, without
    // opening the row. A gate is approved; an ask is answered or dismissed.
    const gate = within(container.querySelector('[data-inbox-row="mp-gate"]') as HTMLElement);
    const ask = within(container.querySelector('[data-inbox-row="mp-9k1"]') as HTMLElement);
    expect(gate.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(ask.getByRole("button", { name: "Answer" })).toBeEnabled();
    expect(ask.getByRole("button", { name: "Dismiss" })).toBeEnabled();
    // No row opens on arrival — `ListRow` reads `defaultExpanded` once, at
    // mount, and this panel mounts on the photograph and is reordered by the
    // live read. The evidence is one press away.
    expect(container.querySelector("[data-inbox-evidence]")).toBeNull();
    fireEvent.click(gate.getByRole("button", { name: /approve the spend/ }));
    expect(container.querySelector("[data-inbox-evidence]")).toHaveTextContent("Spend $40 on the launch ads.");
  });

  it("lists a waiting task once: in Waiting on you, not again in All tasks", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meals.example": board([
        liveTask({ id: "mp-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human" }),
        liveTask({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
        liveTask({ id: "mp-1w2", title: "Fix the recipe schema" }),
      ]),
    } });
    expect(container.querySelector('[data-inbox-row="mp-9k1"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-9k1"]')).toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-gate"]')).toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-1w2"]')).not.toBeNull();
  });

  it("says nothing else is queued when every task is waiting on you", () => {
    renderBoard({ data: withInbox, live: true, boards: {
      "meals.example": board([
        liveTask({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
      ]),
    } });
    expect(screen.getByText("Nothing else is queued.")).toBeInTheDocument();
    expect(screen.queryByText("No task matches these filters.")).toBeNull();
  });

  it("holds five rows and discloses the rest in place", () => {
    const asks = Array.from({ length: 9 }, (_, index) =>
      item({ id: `mp-ask-${index}`, title: `Ask ${index}` }),
    );
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            counts: {
              open: 3,
              highPriority: 1,
              ready: 2,
              inProgress: 1,
              blocked: 0,
              closedRecent: 0,
              deferred: 0,
              waiting: 9,
            },
            waiting: asks,
          }),
        ],
      }),
    });

    const inbox = container.querySelector("[data-waiting-list]")!;
    expect(inbox.querySelectorAll("li")).toHaveLength(5);
    // The panel says how many it is keeping back rather than silently keeping
    // five of nine (doc 14's "As built").
    fireEvent.click(within(inbox as HTMLElement).getByRole("button", { name: "Show 4 more" }));
    expect(inbox.querySelectorAll("li")).toHaveLength(9);
  });

  const liveInbox = () => ({
    "meals.example": board([
      liveTask({ id: "mp-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human" }),
      liveTask({ id: "mp-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
    ]),
  });

  it("answers an ask with the operator's own words: Answer, type, Enter — and never an empty one", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const ask = within(container.querySelector('[data-inbox-row="mp-9k1"]') as HTMLElement);

    fireEvent.click(ask.getByRole("button", { name: "Answer" }));
    const box = screen.getByLabelText("Your answer to mp-9k1");
    expect(box).toHaveFocus();
    expect(ask.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toasts.success).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "Book it for October." } });
    fireEvent.keyDown(box, { key: "Enter" });

    // The row leaves at once, the toast names the task and carries Undo, and
    // the lane is called when the window closes (here: flushed).
    expect(container.querySelector('[data-inbox-row="mp-9k1"]')).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Answered", expect.objectContaining({
      description: "Decide the Korea trip",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    expect(api.respondToTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledOnce());
    expect(api.respondToTask).toHaveBeenCalledWith("mp-9k1", "Book it for October.");
  });

  it("approves a gate in one press on its row — a wait is released, not answered", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const gate = within(container.querySelector('[data-inbox-row="mp-gate"]') as HTMLElement);

    fireEvent.click(gate.getByRole("button", { name: "Approve" }));
    expect(container.querySelector('[data-inbox-row="mp-gate"]')).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Approved", expect.anything());
    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledOnce());
    expect(api.resolveGate).toHaveBeenCalledWith("mp-gate");
    expect(api.respondToTask).not.toHaveBeenCalled();
  });

  it("takes a dismissal back inside its window, and sends nothing", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const ask = within(container.querySelector('[data-inbox-row="mp-9k1"]') as HTMLElement);

    fireEvent.click(ask.getByRole("button", { name: "Dismiss" }));
    expect(container.querySelector('[data-inbox-row="mp-9k1"]')).toBeNull();
    // The panel's count follows the rows it shows.
    expect(within(container.querySelector("[data-waiting-list]") as HTMLElement).getByText("1 ask")).toBeTruthy();

    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(container.querySelector('[data-inbox-row="mp-9k1"]')).not.toBeNull();
    act(() => flushAnswers());
    expect(api.dismissTask).not.toHaveBeenCalled();

    // Declined for real this time: the permanent decline, with no reason asked.
    fireEvent.click(within(container.querySelector('[data-inbox-row="mp-9k1"]') as HTMLElement).getByRole("button", { name: "Dismiss" }));
    act(() => flushAnswers());
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledWith("mp-9k1"));
  });

  it("takes the newest answer back with ⌘Z while no field has focus", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    fireEvent.click(within(container.querySelector('[data-inbox-row="mp-gate"]') as HTMLElement).getByRole("button", { name: "Approve" }));
    expect(container.querySelector('[data-inbox-row="mp-gate"]')).toBeNull();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(container.querySelector('[data-inbox-row="mp-gate"]')).not.toBeNull();
    act(() => flushAnswers());
    expect(api.resolveGate).not.toHaveBeenCalled();
  });

  it("hands back the local read's own words when bd refuses, and the row returns", async () => {
    api.dismissTask.mockRejectedValueOnce(new Error("bd: no such issue mp-9k1"));
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    fireEvent.click(within(container.querySelector('[data-inbox-row="mp-9k1"]') as HTMLElement).getByRole("button", { name: "Dismiss" }));
    act(() => flushAnswers());

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("bd: no such issue mp-9k1"),
    );
    expect(container.querySelector('[data-inbox-row="mp-9k1"]')).not.toBeNull();
  });

  it("says nothing is waiting once, in the answer, rather than drawing an empty panel", () => {
    const { container } = renderBoard();
    expect(answerLine(container)).toBe("Nothing waits on you");
    expect(container.querySelector("[data-waiting-list]")).toBeNull();
  });
});

// ── the row's verbs ──────────────────────────────────────────────────────────

describe("/tasks — claim, close and defer in place", () => {
  it("claims atomically, the way the local read spells it", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
    });

    fireEvent.click(open(container, "mp-1w2").querySelector<HTMLElement>('[data-task-action="claim"]')!);
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(api.updateTask).toHaveBeenCalledWith("mp-1w2", { claim: true });
    expect(toasts.success).toHaveBeenCalledWith("Claimed mp-1w2");
  });

  it("will not close a task without the evidence that closes it", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
    });

    const detail = open(container, "mp-1w2");
    fireEvent.click(detail.querySelector<HTMLElement>('[data-task-action="close"]')!);
    const confirm = container.querySelector<HTMLButtonElement>('[data-task-confirm="close"]')!;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Why mp-1w2 is closed"), {
      target: { value: "shipped in 6b08798" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.closeTask).toHaveBeenCalledOnce());
    expect(api.closeTask).toHaveBeenCalledWith("mp-1w2", "shipped in 6b08798");
  });

  it("parks a task until a date it is given", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
    });

    const detail = open(container, "mp-1w2");
    fireEvent.click(detail.querySelector<HTMLElement>('[data-task-action="defer"]')!);
    fireEvent.change(screen.getByLabelText("Park mp-1w2 until"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.click(container.querySelector<HTMLElement>('[data-task-confirm="defer"]')!);

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(api.updateTask).toHaveBeenCalledWith("mp-1w2", { defer: "2026-09-30" });
  });

  it("offers no verbs on a closed row — momentum asks nothing of anyone", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            ready: [],
            inProgress: [],
            recentlyClosed: [item({ id: "mp-old", title: "Shipped the redirect", status: "closed" })],
          }),
        ],
      }),
    });

    const detail = open(container, "mp-old");
    expect(detail.querySelector('[data-task-action="claim"]')).toBeNull();
    expect(detail.querySelector('[data-task-open="mp-old"]')).not.toBeNull();
  });

  it("links every row at its own task page, from the row and from inside it", () => {
    const { container } = renderBoard();
    const link = within(row(container, "mp-1w2")).getByRole("link", { name: "mp-1w2" });
    expect(link.getAttribute("href")).toBe("/tasks/mp-1w2");
    expect(
      open(container, "mp-1w2").querySelector('[data-task-open="mp-1w2"]')!.getAttribute("href"),
    ).toBe("/tasks/mp-1w2");
  });

  it.each([
    { scope: "portfolio", link: "id" },
    { scope: "portfolio", link: "open" },
    { scope: "asset", link: "id" },
    { scope: "asset", link: "open" },
  ])("preserves $scope board filters through the $link task link", ({ scope, link }) => {
    const entry = scope === "asset"
      ? "/assets/meals.example/tasks?range=90&status=open"
      : "/tasks?status=open&project=meals.example";
    const { container } = scope === "asset"
      ? renderScoped("meals.example", { entry })
      : renderBoard({ entry });
    const target = link === "id"
      ? within(row(container, "mp-1w2")).getByRole("link", { name: "mp-1w2" })
      : within(open(container, "mp-1w2")).getByRole("link", { name: "Open task" });
    fireEvent.click(target);
    expect(screen.getByTestId("task-destination")).toHaveTextContent("/tasks/mp-1w2");
    expect(screen.getByTestId("task-destination")).toHaveAttribute("data-return-to", entry);
  });
});

// ── the two reads ────────────────────────────────────────────────────────────

describe("/tasks — live where the local read is, the photograph where it is not", () => {
  it("uses every recent closed task for the KPI, filter and paged history", () => {
    const closed = Array.from({ length: 60 }, (_, index) => liveTask({
      id: `mp-closed${index}`,
      title: `Completed task ${index}`,
      status: "closed",
      priority: 0,
      closedAt: "2026-08-01T09:00:00.000Z",
    }));
    const { container } = renderBoard({
      live: true,
      entry: "/tasks?status=closed",
      boards: { "meals.example": { ...board([liveTask(), ...closed]), closedSince: "2026-07-25" } },
      data: payload({ projects: [project({ recentlyClosed: closed.slice(0, 5) })] }),
    });
    expect(fig(container, "closed")).toHaveTextContent("60");
    expect(screen.getByRole("option", { name: "Closed this week · 60" })).toBeInTheDocument();
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(60);
    expect(container.querySelector("[data-tasks-summary]")?.textContent).toBe("60 of 61");
    expect(container.querySelector("[data-task-history-status]")).toBeNull();
    // Closed P0s never inflate the active urgent queue.
    expect(fig(container, "urgent").textContent).not.toContain("60");
  });

  it.each([false, true])("never presents an incomplete local history as complete (error=%s)", (failed) => {
    const { container } = renderBoard({
      live: true,
      entry: "/tasks?status=closed",
      errors: failed ? { "meals.example": "database unavailable" } : {},
      data: payload({ projects: [project({ recentlyClosed: [item({ id: "mp-done", status: "closed" })] })] }),
    });
    // Still arriving: a spinner beside the age. Failed: one banner naming the
    // project, with a Retry. Either way the week's total is a dash, not the
    // sample's count.
    if (failed) {
      expect(container.querySelector("[data-lane-error]")!.textContent).toContain("Meal Planner");
      expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
      expect(container.querySelector("[data-task-history-status]")).toBeNull();
    } else {
      expect(container.querySelector('[data-task-history-status="loading"]')).not.toBeNull();
      expect(container.querySelector("[data-lane-error]")).toBeNull();
    }
    expect(fig(container, "closed")).toHaveTextContent("—");
    expect(screen.getByRole("option", { name: "Closed this week · —" })).toBeInTheDocument();
  });

  it("asks for every project the photograph names, in its order", () => {
    renderBoard({
      live: true,
      data: payload({
        projects: [
          project(),
          project({ asset: "nosh.example", prefix: "nom", name: "Nosh", ready: [], inProgress: [] }),
        ],
      }),
    });

    expect(state.acrossCalls.at(-1)).toEqual(["meals.example", "nosh.example"]);
  });

  it("renders the live rows, including the states the photograph never sent", () => {
    const { container } = renderBoard({
      live: true,
      boards: {
        "meals.example": board([
          liveTask({ id: "mp-blk", title: "Waiting on the schema", status: "blocked" }),
          liveTask({ id: "mp-1w2" }),
        ]),
      },
    });

    const state = within(row(container, "mp-blk")).getAllByText("Blocked")[0]!;
    expect(state).toBeInTheDocument();
    // Doc 14: the state is read as colour before it is read as a word, so the
    // dot in front of it carries the same meaning the word does.
    expect(state.previousElementSibling?.getAttribute("aria-label")).toBe("State — Blocked");
    // Epic containers are grouping, not claimable work, and never become rows.
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(2);
  });

  it("keeps the photograph's rows and says so when one project's live read fails", () => {
    const { container } = renderBoard({
      live: true,
      errors: { "meals.example": "bd: could not open the repository" },
    });

    expect(container.querySelector("[data-lane-error]")!.textContent).toContain("Meal Planner");
    expect(row(container, "mp-1w2")).toBeInTheDocument();
  });

  it("names a project neither read could reach, once, above the board", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [project({ ok: false, error: "no repository at ../meals.example" })],
      }),
    });
    expect(screen.getByText(/1 project could not be read/)).toBeInTheDocument();
  });
});

// ── the read-only fallback ───────────────────────────────────────────────────

describe("/tasks — the read-only fallback", () => {
  it("states the reason once, at the top, and disables every action", () => {
    const { container } = renderBoard();

    // What happened as the lead, what to do as the one line — no paragraph.
    const banner = container.querySelector("[data-tasks-readonly]")!;
    expect(banner.textContent).toContain("Read-only snapshot");
    expect(banner.textContent).toContain(READ_ONLY_TASKS_HINT);
    expect(container.querySelector("[data-about]")).toBeNull();
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New task" })).not.toHaveAttribute("title");
    fireEvent.focus(screen.getByRole("button", { name: "Why New task is unavailable" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(READ_ONLY_TASKS_HINT);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      open(container, "mp-1w2").querySelector<HTMLButtonElement>('[data-task-action="claim"]')!
        .disabled,
    ).toBe(true);
  });

  it("still shows the board — the fallback is a degradation, not a dead end", () => {
    const { container } = renderBoard();
    expect(row(container, "mp-1w2")).toBeInTheDocument();
    expect(container.querySelector("[data-tasks-answer]")).not.toBeNull();
  });
});

// ── new task ─────────────────────────────────────────────────────────────────

describe("/tasks — filing one", () => {
  it("is the page's one primary action, and opens the composer in place", () => {
    renderBoard({ live: true, boards: { "meals.example": board([liveTask()]) }, entry: "/tasks?status=open" });

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    // The page does not change under the composer (bead ro-ujb9.96.7.11: the
    // URL change was the flow's one empty step); the filters stay.
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
    expect(screen.getByRole("dialog", { name: "File a task" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
  });

  it("offers exactly the projects the board's own filter offers", () => {
    renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
      entry: "/tasks?new=1",
    });

    const select = within(screen.getByRole("dialog")).getByLabelText(
      "Project",
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      ...(state.work?.projects ?? []).map((project) => project.asset),
    ]);
  });

  it("inherits the project filter, so a narrowed board does not ask again", () => {
    renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
      entry: "/tasks?project=meals.example&new=1",
    });

    const composer = within(screen.getByRole("dialog"));
    expect((composer.getByLabelText("Project") as HTMLSelectElement).value).toBe("meals.example");
  });

  it("keeps the filters when the composer is closed", () => {
    renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
      entry: "/tasks?status=open&new=1",
    });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("files through the local read and names the id it minted", async () => {
    renderBoard({
      live: true,
      boards: { "meals.example": board([liveTask()]) },
      entry: "/tasks?project=meals.example&new=1",
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Rewrite the recipes hub" },
    });
    fireEvent.click(screen.getByRole("button", { name: "File task" }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledOnce());
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "meals.example",
        title: "Rewrite the recipes hub",
        type: "task",
      }),
    );
    expect(toasts.success).toHaveBeenCalledWith("Filed mp-new", expect.anything());
  });
});

// ── core hub availability (D32) ─────────────────────────────────────────────

describe("/tasks — core hub availability", () => {
  it("keeps core navigation and points an unread project list to Task projects", () => {
    taskSourceMock.connected = null;
    const { container } = renderBoard({ data: payload({ capturedAt: null, projects: [] }) });
    expect(screen.getByRole("heading", { name: "Tasks", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("No task projects available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manage task projects/ })).toHaveAttribute("href", "/settings#task-hub");
    expect(container.querySelector("[data-new-task]")).not.toBeNull();
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });

  it("shows a missing site's project without hiding the core Tasks tab", () => {
    taskSourceMock.connected = null;
    const { container } = renderScoped("example.com");
    expect(screen.getByText("No task project for this site")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add a task project/ })).toHaveAttribute("href", "/settings#task-hub");
    expect(container.querySelector("[data-new-task]")).not.toBeNull();
  });

  it("keeps recorded tasks while the independent hub status is pending", () => {
    taskSourceMock.connected = null;
    taskSourceMock.settled = false;
    const { container } = renderBoard();
    expect(container.querySelector("[data-tasks-filters]")).not.toBeNull();
    expect(screen.queryByText("No task projects available")).toBeNull();
    expect(container.querySelector("[data-new-task]")).not.toBeNull();
  });
});

// ── empty and first-run ──────────────────────────────────────────────────────

describe("/tasks — designed empty states", () => {
  it("distinguishes no project reading from an empty task queue", () => {
    for (const capturedAt of [null, "2026-08-01T11:59:00.000Z"]) {
      const { container, unmount } = renderBoard({ data: payload({ capturedAt, projects: [] }) });
      expect(screen.queryByText("No tasks yet")).toBeNull();
      expect(screen.getByText("No task projects available")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Manage task projects/ })).toHaveAttribute("href", "/settings#task-hub");
      expect(container.querySelector("[data-tasks-filters]")).toBeNull();
      expect(container.querySelector("[data-new-task]")).not.toBeNull();
      unmount();
    }
  });

  it("shows a loading state rather than an empty board", () => {
    renderBoard({ data: null, isPending: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says no task matches the filters rather than drawing an empty table", () => {
    const { container } = renderBoard({ entry: "/tasks?status=blocked" });
    expect(screen.getByText("No task matches these filters.")).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });
});

// ── the route table ──────────────────────────────────────────────────────────

describe("/work is the old address and still answers", () => {
  it("redirects to /tasks in place and keeps the link's filters and anchor (bead ro-ujb9.198)", async () => {
    const legacy = deskRoutes.find((route) => route.path === "/work");
    expect(legacy?.element).toBeDefined();
    expect(deskRoutes.some((route) => route.path === "/tasks")).toBe(true);
    expect(deskRoutes.some((route) => route.path === "/tasks/:id")).toBe(true);

    // The board's filters ARE the query, so a redirect that dropped it would
    // open the unfiltered board instead of the view the old link was written for.
    const router = createMemoryRouter(
      [
        { path: "/work", element: legacy!.element },
        { path: "/tasks", element: <output data-testid="board" /> },
      ],
      { initialEntries: ["/work?status=blocked&priority=0#top"] },
    );
    render(<RouterProvider router={router} />);

    await screen.findByTestId("board");
    const { pathname, search, hash } = router.state.location;
    expect(`${pathname}${search}${hash}`).toBe("/tasks?status=blocked&priority=0#top");
    // Replaced, not pushed: Back goes where the operator came from.
    expect(router.state.historyAction).toBe("REPLACE");
  });
});

// ── the same board, scoped to one asset (bead `ro-l1ed.5`) ───────────────────
//
// `/assets/:id/tasks` renders THIS component with `project` set, so the asset
// page's Tasks tab is the index with one prop rather than a second board that
// has to be kept in agreement with it by hand. What is asserted here is the
// scoping and nothing else: everything above already covers the rest.

function renderScoped(
  asset: string,
  {
    data = payload(),
    live = false,
    entry = `/assets/${asset}/tasks`,
  }: { data?: WorkPayload | null; live?: boolean; entry?: string } = {},
) {
  state.work = data;
  state.isPending = false;
  state.capabilities = live
    ? { live: true, reason: null }
    : { live: false, reason: READ_ONLY_DEPLOYMENT };
  state.boards = {};
  state.errors = {};
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDestination />} />
          <Route
            path="/assets/:id/tasks"
            element={
              <>
                <TasksBoard project={asset} newTask />
                <Search />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the asset page's Tasks tab", () => {
  const two = payload({
    projects: [
      project(),
      project({
        asset: "root-os",
        prefix: "ro",
        name: "NoticeOS",
        ready: [item({ id: "ro-9zz", title: "Somebody else's queue" })],
        inProgress: [],
      }),
    ],
  });

  it("pins the project and drops every control the page already answers", () => {
    const { container } = renderScoped("meals.example", { data: two });

    expect(container.textContent).not.toContain("Somebody else's queue");
    expect(container.querySelector("#tasks-project")).toBeNull();
    // The asset page's header already names the asset, so the table drops the
    // column that would state it on every row.
    expect(container.querySelector("th")!.textContent).toBe("Task");
    expect(
      [...container.querySelectorAll("th")].map((node) => node.textContent),
    ).not.toContain("Project");
    // THE BOARD DECLARES ITS OWN FIRST SCREEN, scoped or not (`ro-78qo.32`).
    // The asset tab used to declare it with a wrapper, which could only span the
    // whole board — so the audit measured the bottom of the 25-row table and
    // reported the first screen 973px over. The mark belongs on the strip and
    // the Waiting-on-you panel, which is the answer, and only the board knows
    // where that ends.
    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero.querySelector("[data-tasks-answer]")).not.toBeNull();
    expect(hero.querySelector("table")).toBeNull();
  });

  it("keeps every other filter working, and the URL is still the state", () => {
    const { container } = renderScoped("meals.example", { data: two });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "in-progress" },
    });
    // A pinned project never occupies the query string — it is the page, not a
    // control — so the link an operator copies from here is exactly one clause.
    expect(screen.getByTestId("search").textContent).toBe("?status=in-progress");
    expect(container.querySelector('tr[data-task-row="mp-33j"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="mp-1w2"]')).toBeNull();
  });

  it("does not name the project on an inbox row either", () => {
    const { container } = renderScoped("meals.example", {
      data: payload({
        projects: [
          project({
            waiting: [item({ id: "mp-9k1", title: "Decide the Korea trip", issueType: "gate" })],
          }),
        ],
      }),
    });

    const inbox = container.querySelector("[data-waiting-list]")!;
    expect(inbox.textContent).toContain("Decide the Korea trip");
    expect(inbox.textContent).not.toContain("Meal Planner");
  });

  it("offers New task here, and the composer opens pinned to this project", () => {
    const { container } = renderScoped("meals.example", { live: true, data: two });

    const button = container.querySelector("[data-new-task]")!;
    expect(button.getAttribute("data-new-task-project")).toBe("meals.example");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByTestId("search").textContent).toBe("");

    const composer = within(screen.getByRole("dialog", { name: "File a task" }));
    const select = composer.getByLabelText("Project") as HTMLSelectElement;
    expect(select.value).toBe("meals.example");
    expect([...select.options].map((option) => option.value)).toEqual(["", "meals.example"]);
  });

  it("says how to wire a project for an asset the task database has never heard of", () => {
    const { container } = renderScoped("areas.example", { data: two });

    expect(screen.getByText("No task project for this site")).toBeInTheDocument();
    expect(container.querySelector("[data-tasks-unwired]")).not.toBeNull();
    // The fix is a door, not a paragraph about the projects file.
    expect(screen.getByRole("link", { name: /Add a task project/ })).toHaveAttribute("href", "/settings#task-hub");
    // Not an empty board: no filters, no table, no "0 tasks".
    expect(container.querySelector("[data-tasks-filters]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });
});


describe("/tasks — per-project source and action guarantees", () => {
  it("keeps failed-project sample actions disabled while successful projects remain actionable", () => {
    const nom = project({ asset: "nosh.example", prefix: "nom", name: "Nosh", ready: [item({ id: "nom-sample", title: "Saved Nosh task" })], inProgress: [] });
    const { container } = renderBoard({ live: true, data: payload({ projects: [project(), nom] }), boards: { "meals.example": board([liveTask()]) }, errors: { "nosh.example": "Cannot read Nosh" } });
    const saved = open(container, "nom-sample");
    expect(within(saved).getByRole("button", { name: "Claim" })).toBeDisabled();
    expect(within(saved).getByRole("button", { name: "Close…" })).toBeDisabled();
    expect(within(saved).getByRole("button", { name: "Defer…" })).toBeDisabled();
    const current = open(container, "mp-1w2");
    expect(within(current).getByRole("button", { name: "Claim" })).toBeEnabled();
    expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Nosh");
    expect(fig(container, "closed")).toHaveTextContent("—");
  });

  it.each(["failed refresh", "read-only capability"])("disables an already-open confirmation after %s", (transition) => {
    const { container } = renderBoard({ live: true, boards: { "meals.example": board([liveTask()]) } });
    const detail = open(container, "mp-1w2");
    fireEvent.click(within(detail).getByRole("button", { name: "Close…" }));
    fireEvent.change(screen.getByLabelText("Why mp-1w2 is closed"), { target: { value: "Verified result" } });
    expect(screen.getByRole("button", { name: "Close task" })).toBeEnabled();
    if (transition === "failed refresh") state.errors = { "meals.example": "Read failed" };
    else state.capabilities = { live: false, reason: READ_ONLY_DEPLOYMENT };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "open" } });
    expect(screen.getByRole("button", { name: "Close task" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(api.closeTask).not.toHaveBeenCalled();
  });

  it("does not allow a saved human ask to be answered while its local read is pending", () => {
    const ask = item({ id: "mp-ask", title: "Choose launch date" });
    const { container } = renderBoard({ live: true, data: payload({ projects: [project({ waiting: [ask] })] }) });
    fireEvent.click(within(container.querySelector("[data-waiting-list]") as HTMLElement).getByRole("button", { name: /Choose launch date/ }));
    // No verbs at all on a row the live read has not confirmed — the saved
    // sample is not something an answer can be sent against.
    const row = within(container.querySelector('[data-inbox-row="mp-ask"]') as HTMLElement);
    expect(row.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(row.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});


it("shows unavailable project totals as unknown and never declares an empty queue", () => {
  const { container } = renderBoard({ live: true, data: payload({ projects: [project({ ok: false, error: "Snapshot failed" })] }), errors: { "meals.example": "Local read failed" } });
  for (const mark of ["urgent", "blocked", "closed"] as const) {
    // Nothing was read at all, so nothing is bounded: a dash, never "0+".
    expect(fig(container, mark)).toHaveTextContent("—");
    expect(fig(container, mark)).not.toHaveTextContent("0+");
  }
  expect(answerLine(container)).toBe("Couldn't read what waits on you");
  // Which project, once, in the banner — not under each of the figures.
  expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Meal Planner");
  expect(screen.getByText("Waiting work is unknown for unread projects.")).toBeInTheDocument();
  expect(screen.getByText("Task availability is unknown for unread projects.")).toBeInTheDocument();
  expect(screen.queryByText("Nothing is waiting on you.")).not.toBeInTheDocument();
  expect(screen.queryByText("Nothing is queued.")).not.toBeInTheDocument();
});

it("labels observed counts as partial when another project's totals are unavailable", () => {
  const { container } = renderBoard({ live: true, data: payload({ projects: [project(), project({ asset: "nosh.example", prefix: "nom", name: "Nosh", ok: false, error: "No snapshot" })] }), boards: { "meals.example": board([liveTask()]) }, errors: { "nosh.example": "Cannot read Nosh" } });
  const blocked = fig(container, "blocked");
  // A lower bound in the count's own digits; the banner names what is missing.
  expect(blocked).toHaveTextContent("0+");
  expect(blocked).not.toHaveTextContent("observed");
  expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Nosh");
  expect(row(container, "mp-1w2")).toBeInTheDocument();
});


describe("Task reasons support focus and tap (ro-ujb9.241)", () => {
  it("explains unavailable creation without enabling it or calling a write", () => {
    renderBoard();
    expect(screen.getByRole("button", { name: "New task", exact: true })).toBeDisabled();
    const reason = screen.getByRole("button", { name: "Why New task is unavailable" });
    fireEvent.focus(reason);
    expect(screen.getByRole("tooltip")).toHaveTextContent(READ_ONLY_TASKS_HINT);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(reason);
    expect(screen.getByRole("tooltip")).toHaveTextContent(READ_ONLY_TASKS_HINT);
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it("exposes a project's refused read and the expanded task's parent meaning", () => {
    const first = renderBoard({ data: payload({ projects: [project({ ok: false, error: "Task refresh unavailable" })] }) });
    fireEvent.focus(screen.getByRole("button", { name: "Meal Planner: task read failed" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Task refresh unavailable");
    first.unmount();
    const { container } = renderBoard({ data: payload({ projects: [project({
      epics: [{ id: "mp-epic", title: "Recipe schema overhaul", status: "open", priority: 1,
        total: 1, closed: 0, counts: { open: 1, inProgress: 0, blocked: 0, deferred: 0 }, priorities: [0, 1, 0, 0, 0] }],
      ready: [item({ parent: "mp-epic" })],
    })] }) });
    fireEvent.click(within(row(container, "mp-1w2")).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Parent epic" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("The epic this task hangs off");
  });
});
