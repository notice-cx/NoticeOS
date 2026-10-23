import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTask, LiveTasksPayload, TasksCapabilities } from "@shared/tasks";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "@shared/tasks";
import { emptyWorkHistory, workWeeks, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import type { TaskChoices } from "@noticeos/contract/task-choices";

// `/tasks`: the filters are the URL, every row opens at `/tasks/:id`, and the
// same component draws the asset page's Tasks tab with one prop set. The reads
// (`useWork`, `useTasksLive`, `useTasksAcross`) are stubbed; the writes are not:
// the real mutation hooks run over a real QueryClient against a mocked
// `src/lib/api`, so each verb is asserted on the argv-shaped call.

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  isPending: false,
  capabilities: { live: false, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  errors: {} as Record<string, string>,
  /** Every project list `useTasksAcross` was asked for, in order. */
  acrossCalls: [] as string[][],
  /** The sites read the sidebar keeps, as far as the board needs it. */
  sites: [] as { id: string; status: string }[],
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: { assets: state.sites } }),
}));

const api = vi.hoisted(() => ({
  updateTask: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
  respondToTask: vi.fn(async () => undefined),
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  createTask: vi.fn(async () => ({ id: "md-new", project: "meadow.example" })),
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
    useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
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
import { WallWork } from "@/components/wall/WallWork";
import { sitesInWork } from "@/lib/wall-widgets";
import { buildWallPayload } from "../worker/wall-payload";
import { buildWorkPayload } from "../worker/work-payload";
import { seedSnapshot, workProject } from "./panel-fixtures";
import { createTestStore } from "./postgres-store";
import { addSites } from "./sites";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "md-1w2",
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
    asset: "meadow.example",
    prefix: "md",
    name: "Meadow Board",
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
    ready: [item(), item({ id: "md-88x", title: "Rewrite the FAQ", priority: 0 })],
    inProgress: [
      item({ id: "md-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" }),
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

/** One project whose daily rollup holds `days` days of every count. */
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
  asset = "meadow.example",
): LiveTasksPayload {
  return {
    project: asset,
    prefix: "md",
    repo: "../meadow.example",
    readAt: "2026-08-01T11:59:30.000Z",
    tasks,
    epics,
  };
}

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
  /** The task operations a live workspace offers; every one when absent. */
  operations?: string[];
}

function renderBoard({
  data = payload(),
  live = false,
  boards = {},
  errors = {},
  entry = "/tasks/all",
  isPending = false,
  operations,
}: Options = {}) {
  state.work = data;
  state.isPending = isPending;
  state.capabilities = live
    ? { live: true, reason: null, ...(operations === undefined ? {} : { operations }) }
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
          {/* The board is the All tasks tab; a filtered `/tasks` link forwards there. */}
          {["/tasks", "/tasks/all"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <>
                  <TasksRoute />
                  <Search />
                </>
              }
            />
          ))}
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

/** A close where nothing shipped from a row: Close as, the resolution, then
 * the note line sent as Enter sends it. */
function closeAs(container: HTMLElement, scope: HTMLElement, word: string, line: { note?: string; duplicateOf?: string } = {}) {
  fireEvent.click(within(scope).getByRole("button", { name: "Close as" }));
  closeAsPicked(container, word, line);
}

/** The same, once the menu is open. */
function closeAsPicked(container: HTMLElement, word: string, { note, duplicateOf }: { note?: string; duplicateOf?: string } = {}) {
  fireEvent.click(screen.getByRole("menuitem", { name: word }));
  const form = container.querySelector<HTMLFormElement>('[data-task-form="close-as"]');
  expect(form, "the note line under the row").not.toBeNull();
  if (duplicateOf !== undefined) fireEvent.change(within(form!).getByLabelText("Duplicate of"), { target: { value: duplicateOf } });
  if (note !== undefined) fireEvent.change(within(form!).getByLabelText("Note"), { target: { value: note } });
  fireEvent.submit(form!);
}

/** The press on a row's title that opens it in place; the row's Close as menu
 * is the other button with an expanded state. */
function rowFold(container: HTMLElement, id: string): HTMLElement {
  const fold = row(container, id).querySelector<HTMLElement>("td:first-child button[aria-expanded]");
  expect(fold, `row ${id}'s fold`).not.toBeNull();
  return fold!;
}

/** Open a row in place and hand back what it revealed: the claim/close/defer
 * verbs live behind the same press that shows the evidence. */
function open(container: HTMLElement, id: string): HTMLElement {
  fireEvent.click(rowFold(container, id));
  const detail = container.querySelector<HTMLElement>(`[data-task-detail="${id}"]`);
  expect(detail, `expanded row ${id}`).not.toBeNull();
  return detail!;
}

it('shows the selected workspace member name in an expanded board row without changing its assignee ID', () => {
  const principal = '11111111-1111-4111-8111-111111111111';
  const value = board([liveTask({ id: 'md-1w2', assignee: principal, status: 'in_progress' })]);
  value.actors = [{ principalId: principal, displayName: 'Current operator' }];
  const { container } = renderBoard({ live: true, boards: { 'meadow.example': value } });
  const detail = open(container, 'md-1w2');
  expect(screen.getByRole('option', { name: 'Current operator · 1' })).toHaveValue(principal);
  expect(within(detail).getByText('Claimed by Current operator')).toBeInTheDocument();
  expect(within(detail).queryByText(principal)).not.toBeInTheDocument();
  expect(value.tasks[0].assignee).toBe(principal);
});

/** The answer's figures, by label, in the order they are drawn. */
function figures(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-page-answer-figures] dt")].map((node) => node.textContent ?? "");
}

/** One figure beside the answer, by its mark: Urgent, Blocked, Done this week. */
function fig(container: HTMLElement, mark: "urgent" | "blocked" | "closed"): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-tasks-${mark}]`);
  if (found === null) throw new Error(`no ${mark} figure beside the answer`);
  return found;
}

/** The queue's size, as its header draws it beside "for you to decide". */
function waitingCount(container: HTMLElement): string | null {
  const header = container.querySelector("[data-waiting-list] [data-decision-queue] header");
  expect(header?.textContent).toContain("for you to decide");
  return header?.querySelector(".text-figure")?.textContent ?? null;
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
  state.sites = [];
  resetAnswerQueue();
  vi.clearAllMocks();
});

describe("/tasks — the first screen answers the page's one question", () => {
  it("is the answer and the inbox, and nothing else is above the fold", () => {
    const { container } = renderBoard();

    expect(screen.getByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector("[data-tasks-answer]")).not.toBeNull();
    expect(hero.querySelector("[data-kpi-strip]")).toBeNull();
    expect(hero.compareDocumentPosition(container.querySelector("#tasks-status")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hero.querySelector("table")).toBeNull();
  });

  it("answers what waits on you, with the three counts that change what you do next", () => {
    const { container } = renderBoard();
    expect(answerLine(container)).toBe("No decisions for you");
    expect(figures(container)).toEqual(["Urgent", "Blocked", "Done this week"]);
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
            weeks: workWeeks(emptyWorkHistory(), { since: "2026-07-17", items: Array.from({ length: 5 }, () => ({ at: "2026-07-28T10:00:00.000Z" })) },
              new Date("2026-08-01T12:00:00.000Z"), "UTC"),
          }),
        ],
      }),
    });

    // "how much is blocked" is a fact about the portfolio and stays true
    // whatever the table below has been narrowed to.
    expect(fig(container, "blocked")).toHaveTextContent("4");
    expect(fig(container, "closed")).toHaveTextContent("5");
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

describe("/tasks — the board is one table", () => {
  it("draws every project's work in one table, one line each", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project(),
          project({
            asset: "root-os",
            prefix: "ro",
            name: "System",
            ready: [item({ id: "ro-9zz", title: "Somebody else's queue" })],
            inProgress: [],
          }),
        ],
      }),
    });

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(row(container, "md-1w2")).toBeInTheDocument();
    expect(row(container, "ro-9zz")).toBeInTheDocument();
    expect(within(row(container, "ro-9zz")).getByText("System")).toBeInTheDocument();
  });

  it("leads with what is urgent, then with what has gone longest untouched", () => {
    const { container } = renderBoard();
    const ids = [...container.querySelectorAll("tr[data-task-row]")].map((node) =>
      node.getAttribute("data-task-row"),
    );
    // md-88x is P0; the rest are P2 and sort by last activity.
    expect(ids[0]).toBe("md-88x");
  });

  it("sinks parked work below live work and closed work below that", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            deferred: [
              item({ id: "md-park", title: "Wait for the season", status: "deferred", priority: 0 }),
            ],
            recentlyClosed: [
              item({ id: "md-done", title: "Shipped the redirect", status: "closed", priority: 0 }),
            ],
          }),
        ],
      }),
    });

    const ids = [...container.querySelectorAll("tr[data-task-row]")].map((node) =>
      node.getAttribute("data-task-row"),
    );
    expect(ids.indexOf("md-park")).toBeGreaterThan(ids.indexOf("md-1w2"));
    expect(ids.indexOf("md-done")).toBe(ids.length - 1);
  });

  it("draws closed, in progress and an unknown status from the task page's own status face", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            ready: [item({ id: "md-odd", status: "triaged" })],
            recentlyClosed: [item({ id: "md-done", title: "Shipped the redirect", status: "closed" })],
          }),
        ],
      }),
    });

    for (const [id, stored] of [["md-done", "closed"], ["md-33j", "in_progress"], ["md-odd", "triaged"]] as const) {
      const face = statusFace(stored);
      const word = within(row(container, id)).getAllByText(face.label)[0]!;
      expect(word, id).toHaveAttribute("data-task-status", face.key);
      expect(word.className, id).toContain(STATE_TONE[face.tone].text);
      const glyph = row(container, id).querySelector(`[data-task-status-glyph="${face.key}"]`)!;
      expect(glyph, id).not.toBeNull();
      expect(glyph.getAttribute("class"), id).toContain(STATE_TONE[face.tone].text);
    }
    const closed = row(container, "md-done");
    expect(closed.innerHTML).not.toContain("healthy");
    expect(closed.querySelector("[data-task-rest-mark]")).toHaveAttribute("data-task-rest-mark", "closed");
    expect(statusFace("closed").tone).toBe("na");
    expect(statusFace("in_progress").tone).toBe("affirmative");
    expect(statusFace("triaged")).toMatchObject({ key: "unknown", label: "triaged", tone: "neutral" });
    expect(fig(container, "closed").innerHTML).not.toContain("healthy");
  });

  it("renders a state this build has never seen, without inventing one for it", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [project({ ready: [item({ id: "md-odd", status: "triaged" })], inProgress: [] })],
      }),
    });

    // Twice per row: the desk's State column and the summary line a stacked
    // phone row shows in its place.
    const words = within(row(container, "md-odd")).getAllByText("triaged");
    expect(words).toHaveLength(2);
    for (const word of words) expect(word.getAttribute("data-task-status")).toBe("unknown");
  });

  it("pages 25 rows at a time and says how many are left", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      item({ id: `md-${index}`, title: `Task ${index}` }),
    );
    const { container } = renderBoard({
      data: payload({ projects: [project({ ready: many, inProgress: [] })] }),
    });

    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    expect(container.querySelector("[data-tasks-summary]")!.textContent).toBe("60");
    expect(container.querySelector("[data-tasks-more]")!.textContent).toContain("35 left");

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(50);

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(60);
    expect(container.querySelector("[data-tasks-more]")).toBeNull();
  });

  it("starts a narrowed board at its own first page", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      item({ id: `md-${index}`, title: `Task ${index}`, status: index < 30 ? "open" : "blocked" }),
    );
    const { container } = renderBoard({
      data: payload({ projects: [project({ ready: many, inProgress: [] })] }),
    });

    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(50);

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "blocked" },
    });
    // 30 blocked rows, and the reader is back on the first 25 of them.
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
  });

  it("expands a row in place instead of navigating away from the board", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            epics: [
              {
                id: "md-epic",
                title: "Recipe schema overhaul",
                status: "open",
                priority: 1,
                total: 8,
                closed: 3,
                counts: { open: 4, inProgress: 1, blocked: 0, deferred: 0 },
                priorities: [0, 1, 4, 0, 0],
              },
            ],
            ready: [item({ id: "md-1w2", parent: "md-epic" })],
            inProgress: [],
          }),
        ],
      }),
    });

    const detail = open(container, "md-1w2");
    expect(detail.textContent).toContain("Part of Recipe schema overhaul");
    expect(detail.querySelector('[data-task-action="claim"]')).not.toBeNull();
  });
});

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
        ready: [item(), item({ id: "md-88x", title: "Rewrite the FAQ", priority: 0 })],
        inProgress: [item({ id: "md-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" })],
        deferred: [item({ id: "md-zzz", title: "Wait for the season", status: "deferred" })],
        recentlyClosed: [item({ id: "md-old", title: "Shipped the redirect", status: "closed" })],
      }),
    ],
  });
  // The project filter is drawn only when there is a second project to pick.
  const twoProjects = payload({
    projects: [
      ...many.projects,
      project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [], inProgress: [],
      }),
    ],
  });

  it("names a retired asset's project Retired in the project list, and keeps it there", () => {
    state.sites = [{ id: "meadow.example", status: "live" }, { id: "northwind.example", status: "retired" }];
    const { container } = renderBoard({ data: twoProjects });
    const labels = [...container.querySelector<HTMLSelectElement>("#tasks-project")!.options].map((option) => option.textContent);
    expect(labels.find((label) => label?.startsWith("Northwind"))).toMatch(/^Northwind · Retired · \d+$/u);
    expect(labels.find((label) => label?.startsWith("Meadow"))).not.toContain("Retired");
  });

  it("is five controls and no more — the counts moved to the strip", () => {
    const { container } = renderBoard({ data: twoProjects, live: true,
    });
    const filters = container.querySelector("[data-tasks-filters]")!;
    expect(filters.querySelectorAll("select")).toHaveLength(4);
    expect(filters.querySelectorAll("input")).toHaveLength(2);
    // The one button is the phone's fold, hidden from `sm` up; the controls
    // themselves hold none.
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
    expect(filters.lastElementChild).not.toBe(controls);
  });

  it("names each filter, and does not print the same total four times", () => {
    const { container } = renderBoard({ data: twoProjects });
    // The closed label of a select is its selected option; the count stays on
    // every option a reader opens the list to see.
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
    expect(labels).toContain("Closed, last 7 days · —");
  });

  it("puts a picked status in the query string and narrows the table to it", () => {
    const { container } = renderBoard({ data: many });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "in-progress" },
    });
    expect(screen.getByTestId("search").textContent).toBe("?status=in-progress");
    expect(container.querySelector('tr[data-task-row="md-33j"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).toBeNull();
  });

  it("reads the whole filter vocabulary back out of the URL", () => {
    const { container } = renderBoard({
      data: many,
      entry: "/tasks?project=meadow.example&status=open&priority=top&assignee=agent-x&label=ux",
    });

    expect(container.querySelector<HTMLSelectElement>("#tasks-project")!.value).toBe(
      "meadow.example",
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
          project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [], inProgress: [] }),
        ],
      }),
    });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-project")!, {
      target: { value: "northwind.example" },
    });
    expect(screen.getByTestId("search").textContent).toBe("?project=northwind.example");

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-project")!, {
      target: { value: "all" },
    });
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it.each([true, false])("filters the hero, agents, epics and rows together, and restores them on Clear (live=%s)", live => {
    const epic = { id: "nw-epic", title: "Northwind launch", status: "open", priority: 1, total: 1, closed: 0,
      counts: { open: 1, inProgress: 0, blocked: 0, deferred: 0 }, priorities: [0, 1, 0, 0, 0] };
    const task = liveTask({ id: "nw-task", title: "Northwind work", parent: epic.id, status: "in_progress", assignee: "other-agent" });
    const dependent = liveTask({ id: "nw-dependent", title: "Ship Northwind", parent: epic.id,
      dependencies: [{ id: task.id, type: "blocks", title: task.title, status: task.status }] });
    const other = project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [], inProgress: [task], epics: [epic],
      waiting: [item({ id: "nw-ask", title: "Northwind decision" })], counts: { ...project().counts, waiting: 1, highPriority: 8 } });
    const { container } = renderBoard({ live, entry: "/tasks/all?project=meadow.example", data: payload({ projects: [project(), other] }),
      boards: { "meadow.example": board([liveTask()]), "northwind.example": board([task, dependent, liveTask({ id: "nw-ask", title: "Northwind decision", labels: ["human"], ready: true })], [{ ...epic, eligibleForClose: false }], other.asset) } });
    expect(answerLine(container)).toBe("No decisions for you");
    expect(fig(container, "urgent")).toHaveTextContent(live ? "0" : "1");
    expect(container.querySelector('[data-work-row="northwind.example"]')).toBeNull();
    expect(container.querySelector('[data-tasks-epic="nw-epic"]')).toBeNull();
    expect(screen.queryByText("Northwind work")).toBeNull();
    expect(screen.queryByText("Northwind decision")).toBeNull();
    expect(screen.queryByText("other-agent")).toBeNull();
    expect(screen.getByRole("option", { name: /^Northwind ·/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
    expect(answerLine(container)).toBe("1 decision for you");
    if (live) expect(container.querySelector('[data-tasks-epic="nw-epic"]')).not.toBeNull();
    expect(screen.getAllByText("Northwind work").length).toBeGreaterThan(0);
    expect(screen.getAllByText("other-agent").length).toBeGreaterThan(0);
  });

  it("keeps an unknown project visible in the filter without showing other projects' tasks", () => {
    const { container } = renderBoard({ entry: "/tasks/all?project=unknown.example" });
    expect(screen.getByLabelText("Project")).toHaveValue("unknown.example");
    expect(screen.getByText("No task project matches this filter")).toBeInTheDocument();
    expect(container.querySelector("[data-task-row]")).toBeNull();
    expect(container.querySelector("[data-surface-hero]")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
    expect(row(container, "md-1w2")).toBeInTheDocument();
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
        "meadow.example": board([
          liveTask({ id: "md-1w2", labels: ["ux"] }),
          liveTask({ id: "md-88x", title: "Rewrite the FAQ", labels: ["copy"] }),
        ]),
      },
      entry: "/tasks?label=ux",
    });

    expect(container.querySelector('tr[data-task-row="md-1w2"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="md-88x"]')).toBeNull();
  });

  it("offers no label filter on the photograph, whose rows carry no labels", () => {
    const { container } = renderBoard();
    expect(container.querySelector("#tasks-label")).toBeNull();
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

describe("/tasks — Your decisions leads, and it can be answered", () => {
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
          item({ id: "md-gate", title: "Gate: human — approve the spend", issueType: "gate", priority: 2 }),
          item({ id: "md-9k1", title: "Decide the Korea trip", priority: 1 }),
        ],
      }),
    ],
  });

  it("puts the more urgent decision before a lower-priority approval", () => {
    const { container } = renderBoard({ data: withInbox });
    const inbox = container.querySelector("[data-waiting-list]")!;
    const titles = [...inbox.querySelectorAll("li")].map((node) => node.textContent ?? "");
    expect(titles[0]).toContain("Decide the Korea trip");
    expect(titles[1]).toContain("approve the spend");
    expect(titles[0]).toContain("Meadow Board");
    expect(titles[0]).not.toContain("md-9k1");
    expect(titles[1]).toContain("needs your approval");
  });

  it("wears warn on a top-priority ask like every other ask, never error", () => {
    // A task's priority is not a severity: the operator being the blocker is
    // a call for attention at every priority, a gate included.
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            waiting: [
              item({ id: "md-gate", title: "Gate: human — approve the spend", issueType: "gate", priority: 0 }),
              item({ id: "md-top", title: "Pick the launch date", priority: 0 }),
              item({ id: "md-9k1", title: "Decide the Korea trip", priority: 1 }),
              item({ id: "md-low", title: "Name the newsletter", priority: 3 }),
            ],
          }),
        ],
      }),
    });
    for (const id of ["md-gate", "md-top", "md-9k1", "md-low"]) {
      const ring = container.querySelector(`[data-inbox-row="${id}"] span[aria-hidden]`)!;
      expect(ring.className, id).toContain("text-warn");
      expect(ring.className, id).not.toContain("text-error");
    }
  });

  it("ranks the board's rows and the Urgent count by ink, never by an attention hue", () => {
    const { container } = renderBoard();
    const top = container.querySelector('[data-task-row="md-88x"] [data-priority-mark]')!;
    expect(top.getAttribute("data-priority-mark")).toBe("top");
    expect(top.className).toContain("bg-foreground");
    expect(container.querySelector('[data-task-row="md-1w2"] [data-priority-mark]')).toHaveAttribute(
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
    const answer = container.querySelector("[data-tasks-answer]")!;
    expect(answer).toHaveTextContent("1 needs your approval");
    expect(answer).not.toHaveTextContent(/gate/);
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

    const gateTask = liveTask({ id: "md-gate", title: "Approve the spend", issueType: "gate", awaitType: "human" });
    const otherTasks = [
      liveTask({ id: "md-timer", title: "Wait for tomorrow", issueType: "gate", awaitType: "timer" }),
      liveTask({ id: "md-9k1", title: "Decide the Korea trip", labels: ["human"], ready: true }),
    ];
    state.boards = { "meadow.example": board([gateTask, ...otherTasks]) };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "open" } });
    expect(waitingCount(container)).toBe("2");
    expect(inbox.queryByText("Wait for tomorrow")).toBeNull();
    expect(container.querySelector('[data-task-row="md-timer"]')).toBeNull();
    const gate = within(container.querySelector('[data-inbox-row="md-gate"]') as HTMLElement);
    expect(gate.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(gate.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(api.resolveGate).not.toHaveBeenCalled();

    state.boards = { "meadow.example": board([
      { ...gateTask, status: "closed", closedAt: "2026-08-01T11:59:45.000Z" }, ...otherTasks,
    ]) };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "all" },
    });
    expect(waitingCount(container)).toBe("1");
    expect(inbox.queryByRole("button", { name: /Approve the spend/ })).toBeNull();
    expect(inbox.getByRole("button", { name: /Decide the Korea trip/ })).toBeTruthy();
  });

  it("puts each decision on its row, and keeps the evidence behind the press that opens it", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meadow.example": board([
        liveTask({ id: "md-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human",
          description: "Spend $40 on the launch ads." }),
        liveTask({ id: "md-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
      ]),
    } });
    // One press per decision, without opening the row.
    const gate = within(container.querySelector('[data-inbox-row="md-gate"]') as HTMLElement);
    const ask = within(container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement);
    expect(gate.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(ask.getByRole("button", { name: "Answer" })).toBeEnabled();
    expect(ask.getByRole("button", { name: "Close as" })).toBeEnabled();
    expect(ask.queryByRole("button", { name: "Dismiss" })).toBeNull();
    // No row opens on arrival: `ListRow` reads `defaultExpanded` once, at
    // mount, and this panel mounts on the photograph and is reordered by the
    // live read.
    expect(container.querySelector("[data-inbox-evidence]")).toBeNull();
    fireEvent.click(gate.getByRole("button", { name: /approve the spend/ }));
    expect(container.querySelector("[data-inbox-evidence]")).toHaveTextContent("Spend $40 on the launch ads.");
  });

  it("lists a waiting task once: in Your decisions, not again in All tasks", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meadow.example": board([
        liveTask({ id: "md-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human" }),
        liveTask({ id: "md-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
        liveTask({ id: "md-1w2", title: "Fix the recipe schema" }),
      ]),
    } });
    expect(container.querySelector('[data-inbox-row="md-9k1"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="md-9k1"]')).toBeNull();
    expect(container.querySelector('tr[data-task-row="md-gate"]')).toBeNull();
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).not.toBeNull();
  });

  it("shows the work released by an answer without expanding its history", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meadow.example": board([
        liveTask({ id: "md-decision", title: "Choose the sender", issueType: "decision", labels: ["human"], ready: true }),
        liveTask({ id: "md-build", title: "Build the digest sender", dependencies: [
          { id: "md-decision", type: "blocks", title: null, status: null },
        ] }),
        liveTask({ id: "md-plain", title: "Choose the heading", labels: ["human"], ready: true }),
      ]),
    } });
    const proceeds = container.querySelector<HTMLElement>('[data-inbox-row="md-decision"] [data-inbox-proceeds]')!;
    expect(proceeds).toHaveTextContent("After your answer: Build the digest sender");
    expect(within(proceeds).getByRole("link", { name: "Build the digest sender" })).toHaveAttribute("href", "/tasks/md-build");
    expect(container.querySelector('[data-inbox-row="md-plain"] [data-inbox-proceeds]'))
      .toHaveTextContent("After your answer: An agent can continue this task.");
  });

  it("keeps a decision that releases many tasks to two titles and a count", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: {
      "meadow.example": board([
        liveTask({ id: "md-decision", title: "Choose the sender", issueType: "decision", labels: ["human"], ready: true }),
        ...Array.from({ length: 8 }, (_, index) => liveTask({ id: `md-build-${index}`, title: `Sender step ${index}`,
          dependencies: [{ id: "md-decision", type: "blocks", title: null, status: null }] })),
      ]),
    } });
    const consequence = container.querySelector<HTMLElement>('[data-inbox-row="md-decision"] [data-inbox-proceeds]')!;
    expect(consequence).toHaveTextContent("After your answer: Sender step 0; Sender step 1; 6 more tasks");
    expect(consequence).not.toHaveTextContent("Sender step 2");
    expect(within(consequence).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/tasks/md-build-0", "/tasks/md-build-1"]);
  });

  it("says nothing else is queued when every task is for you to decide", () => {
    renderBoard({ data: withInbox, live: true, boards: {
      "meadow.example": board([
        liveTask({ id: "md-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
      ]),
    } });
    expect(screen.getByText("Nothing else is queued.")).toBeInTheDocument();
    expect(screen.queryByText("No task matches these filters.")).toBeNull();
  });

  it("holds five rows and discloses the rest in place", () => {
    const asks = Array.from({ length: 9 }, (_, index) =>
      item({ id: `md-ask-${index}`, title: `Ask ${index}` }),
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
    fireEvent.click(within(inbox as HTMLElement).getByRole("button", { name: "Show 4 more" }));
    expect(inbox.querySelectorAll("li")).toHaveLength(9);
  });

  const liveInbox = () => ({
    "meadow.example": board([
      liveTask({ id: "md-gate", title: "Gate: human — approve the spend", issueType: "gate", awaitType: "human" }),
      liveTask({ id: "md-9k1", title: "Decide the Korea trip", priority: 1, labels: ["human"], ready: true }),
    ]),
  });

  it("answers an ask with the operator's own words: Answer, type, Enter — and never an empty one", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const ask = within(container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement);

    fireEvent.click(ask.getByRole("button", { name: "Answer" }));
    const box = screen.getByLabelText("Your answer to md-9k1");
    expect(box).toHaveFocus();
    expect(ask.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toasts.success).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "Book it for October." } });
    fireEvent.keyDown(box, { key: "Enter" });

    // The row leaves at once, the toast names the task and carries Undo, and
    // the lane is called when the window closes (here: flushed).
    expect(container.querySelector('[data-inbox-row="md-9k1"]')).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Answered", expect.objectContaining({
      description: "Decide the Korea trip",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    expect(api.respondToTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledOnce());
    expect(api.respondToTask).toHaveBeenCalledWith("md-9k1", "Book it for October.");
  });

  it("approves a gate in one press on its row — a wait is released, not answered", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const gate = within(container.querySelector('[data-inbox-row="md-gate"]') as HTMLElement);

    fireEvent.click(gate.getByRole("button", { name: "Approve" }));
    expect(container.querySelector('[data-inbox-row="md-gate"]')).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Approved", expect.anything());
    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledOnce());
    expect(api.resolveGate).toHaveBeenCalledWith("md-gate");
    expect(api.respondToTask).not.toHaveBeenCalled();
  });

  it("takes a dismissal back inside its window, and sends nothing", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    const ask = container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement;

    // Dismiss is the Close as menu's Won't do: one pick, then Enter on its note.
    closeAs(container, ask, "Won't do");
    expect(container.querySelector('[data-inbox-row="md-9k1"]')).toBeNull();
    expect(waitingCount(container)).toBe("1");
    expect(vi.mocked(toasts.success).mock.calls.at(-1)![0]).toBe("Closed as Won't do");

    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(container.querySelector('[data-inbox-row="md-9k1"]')).not.toBeNull();
    act(() => flushAnswers());
    expect(api.dismissTask).not.toHaveBeenCalled();

    closeAs(container, container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement, "Won't do");
    act(() => flushAnswers());
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledWith("md-9k1"));
  });

  it("declines a question with the resolution picked, the note as its reason and a duplicate's other task", async () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    closeAs(container, container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement, "Duplicate", { note: "Asked twice", duplicateOf: "md-1w2" });
    expect(vi.mocked(toasts.success).mock.calls.at(-1)![0]).toBe("Closed as Duplicate");
    act(() => flushAnswers());
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledWith("md-9k1", "Asked twice", { resolution: "duplicate", duplicateOf: "md-1w2" }));
    expect(api.closeTask).not.toHaveBeenCalled();
  });

  it("takes the newest answer back with ⌘Z while no field has focus", () => {
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    fireEvent.click(within(container.querySelector('[data-inbox-row="md-gate"]') as HTMLElement).getByRole("button", { name: "Approve" }));
    expect(container.querySelector('[data-inbox-row="md-gate"]')).toBeNull();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(container.querySelector('[data-inbox-row="md-gate"]')).not.toBeNull();
    act(() => flushAnswers());
    expect(api.resolveGate).not.toHaveBeenCalled();
  });

  it("hands back the local read's own words when bd refuses, and the row returns", async () => {
    api.dismissTask.mockRejectedValueOnce(new Error("bd: no such issue md-9k1"));
    const { container } = renderBoard({ data: withInbox, live: true, boards: liveInbox() });
    closeAs(container, container.querySelector('[data-inbox-row="md-9k1"]') as HTMLElement, "Won't do");
    act(() => flushAnswers());

    // The refusal names the task, and offers Open on it.
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("bd: no such issue md-9k1", { action: { label: "Open", onClick: expect.any(Function) } }),
    );
    expect(container.querySelector('[data-inbox-row="md-9k1"]')).not.toBeNull();
  });

  it("says nothing is waiting once, in the answer, rather than drawing an empty panel", () => {
    const { container } = renderBoard();
    expect(answerLine(container)).toBe("No decisions for you");
    expect(container.querySelector("[data-waiting-list]")).toBeNull();
  });
});

describe("/tasks — claim, close and defer in place", () => {
  it("claims atomically, the way the local read spells it", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
    });

    fireEvent.click(open(container, "md-1w2").querySelector<HTMLElement>('[data-task-action="claim"]')!);
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(api.updateTask).toHaveBeenCalledWith("md-1w2", { claim: true });
    expect(toasts.success).toHaveBeenCalledWith("Claimed md-1w2", { action: { label: "Open", onClick: expect.any(Function) } });
    // The toast names the task, and its Open opens the task's page.
    const options = toasts.success.mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => options.action.onClick());
    expect(screen.getByTestId("task-destination")).toHaveTextContent("/tasks/md-1w2");
  });

  it("will not close a task without the evidence that closes it", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
    });

    const detail = open(container, "md-1w2");
    fireEvent.click(detail.querySelector<HTMLElement>('[data-task-action="close"]')!);
    const confirm = container.querySelector<HTMLButtonElement>('[data-task-confirm="close"]')!;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Why md-1w2 is closed"), {
      target: { value: "shipped in 6b08798" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.closeTask).toHaveBeenCalledOnce());
    expect(api.closeTask).toHaveBeenCalledWith("md-1w2", "shipped in 6b08798");
  });

  it("closes a task nobody holds as Won't do from its row in one pick and Enter, with Undo", async () => {
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board([liveTask({ assignee: null })]) } });
    const line = row(container, "md-1w2");
    fireEvent.click(within(line).getByRole("button", { name: "Close as" }));
    const menu = screen.getByRole("menu", { name: "Close Fix the recipe schema as" });
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Won't do", "Duplicate", "Can't reproduce", "Already handled"]);
    closeAsPicked(container, "Won't do", { note: "Nobody asked for it" });
    // The row leaves at once, and the toast carries the Undo.
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).toBeNull();
    expect(toasts.success).toHaveBeenLastCalledWith("Closed as Won't do", expect.objectContaining({
      description: "Fix the recipe schema", action: expect.objectContaining({ label: "Undo" }) }));
    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).not.toBeNull();
    act(() => flushAnswers());
    expect(api.closeTask).not.toHaveBeenCalled();

    closeAs(container, row(container, "md-1w2"), "Won't do", { note: "Nobody asked for it" });
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledWith("md-1w2", "Nobody asked for it", { resolution: "wont-do" }));
  });

  it("sends a duplicate with the other task's id, and its words as the reason when no note is written", async () => {
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board([liveTask()]) } });
    fireEvent.click(within(row(container, "md-1w2")).getByRole("button", { name: "Close as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    const form = container.querySelector<HTMLFormElement>('[data-task-form="close-as"]')!;
    const send = within(form).getByRole("button", { name: "Close task" });
    // The other task is named before the line sends, and is never this one.
    expect(send).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Duplicate of"), { target: { value: "md-1w2" } });
    expect(send).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Duplicate of"), { target: { value: "md-9x1" } });
    expect(send).toBeEnabled();
    fireEvent.submit(form);
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledWith("md-1w2", "Duplicate of md-9x1", { resolution: "duplicate", duplicateOf: "md-9x1" }));
  });

  it("includes every close in Done this week and the Status filter", () => {
    // The same three closes as the snapshot carries them, on Tuesday of the week the board reads.
    const closes = { since: "2026-07-17", items: [
      { at: "2026-07-28T10:00:00.000Z" },
      { at: "2026-07-28T11:00:00.000Z", resolution: "wont-do" as const },
      { at: "2026-07-28T12:00:00.000Z", resolution: "duplicate" as const },
    ] };
    const data = payload({ projects: [project({ weeks: workWeeks(emptyWorkHistory(), closes, new Date("2026-08-01T12:00:00.000Z"), "UTC") })] });
    const { container } = renderBoard({ data, live: true, boards: { "meadow.example": board([
      liveTask({ id: "md-a1", status: "closed", closedAt: "2026-09-21T10:00:00.000Z" }),
      liveTask({ id: "md-a2", status: "closed", closedAt: "2026-09-21T11:00:00.000Z", resolution: "wont-do" }),
      liveTask({ id: "md-a3", status: "closed", closedAt: "2026-09-21T12:00:00.000Z", resolution: "duplicate", duplicateOf: "md-a1" }),
      liveTask({ id: "md-a4" }),
    ]) } });
    const figure = container.querySelector("[data-tasks-closed]")!;
    const done = figure.querySelector("dd")!;
    expect(done.firstChild?.textContent).toBe("3");
    expect(figure).not.toHaveTextContent("not done");
    expect(screen.getByRole("option", { name: /^Closed, last 7 days · 3/ })).toBeInTheDocument();
    // A closed row offers no Close as.
    expect(within(row(container, "md-a2")).queryByRole("button", { name: "Close as" })).toBeNull();
    expect(within(row(container, "md-a4")).getByRole("button", { name: "Close as" })).toBeEnabled();
  });

  it("parks a task until a date it is given", async () => {
    const { container } = renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
    });

    const detail = open(container, "md-1w2");
    fireEvent.click(detail.querySelector<HTMLElement>('[data-task-action="defer"]')!);
    fireEvent.change(screen.getByLabelText("Park md-1w2 until"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.click(container.querySelector<HTMLElement>('[data-task-confirm="defer"]')!);

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(api.updateTask).toHaveBeenCalledWith("md-1w2", { defer: "2026-09-30" });
  });

  it("offers no verbs on a closed row — momentum asks nothing of anyone", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [
          project({
            ready: [],
            inProgress: [],
            recentlyClosed: [item({ id: "md-old", title: "Shipped the redirect", status: "closed" })],
          }),
        ],
      }),
    });

    const detail = open(container, "md-old");
    expect(detail.querySelector('[data-task-action="claim"]')).toBeNull();
    expect(detail.querySelector('[data-task-open="md-old"]')).not.toBeNull();
  });

  it("links every row at its own task page, from the row and from inside it", () => {
    const { container } = renderBoard();
    const link = within(row(container, "md-1w2")).getByRole("link", { name: "md-1w2" });
    expect(link.getAttribute("href")).toBe("/tasks/md-1w2");
    expect(
      open(container, "md-1w2").querySelector('[data-task-open="md-1w2"]')!.getAttribute("href"),
    ).toBe("/tasks/md-1w2");
  });

  it.each([
    { scope: "portfolio", link: "id" },
    { scope: "portfolio", link: "open" },
    { scope: "asset", link: "id" },
    { scope: "asset", link: "open" },
  ])("preserves $scope board filters through the $link task link", ({ scope, link }) => {
    const entry = scope === "asset"
      ? "/assets/meadow.example/tasks?range=90&status=open&q=recipe"
      : "/tasks/all?status=open&project=meadow.example&q=recipe";
    const { container } = scope === "asset"
      ? renderScoped("meadow.example", { entry })
      : renderBoard({ entry });
    const target = link === "id"
      ? within(row(container, "md-1w2")).getByRole("link", { name: "md-1w2" })
      : within(open(container, "md-1w2")).getByRole("link", { name: "Open task" });
    fireEvent.click(target);
    expect(screen.getByTestId("task-destination")).toHaveTextContent("/tasks/md-1w2");
    expect(screen.getByTestId("task-destination")).toHaveAttribute("data-return-to", entry);
  });
});

describe("/tasks — the shape of the work, drawn", () => {
  const northwind = project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [item({ id: "nw-1", title: "Northwind's queue" })], inProgress: [] });
  const blocks = (...ids: string[]) => ids.map((id) => ({ id, type: "blocks", title: null, status: null }));
  const epicTasks = [
    liveTask({ id: "md-e", issueType: "epic", title: "Recipe overhaul" }),
    liveTask({ id: "md-e.1", title: "Draft the schema", parent: "md-e", status: "closed", closedAt: "2026-07-30T10:00:00.000Z" }),
    liveTask({ id: "md-e.2", title: "Load-test the schema", parent: "md-e", status: "blocked", dependencies: blocks("md-e.1") }),
    liveTask({ id: "md-e.3", title: "Ship the schema", parent: "md-e", dependencies: blocks("md-e.2") }),
    liveTask({ id: "md-f", issueType: "epic", title: "Faster pages" }),
    liveTask({ id: "md-f.1", title: "Compress the images", parent: "md-f", ready: true }),
    liveTask({ id: "md-f.2", title: "Lazy-load the gallery", parent: "md-f", dependencies: blocks("md-f.1") }),
  ];
  const epics = [
    { id: "md-e", title: "Recipe overhaul", status: "open", priority: 1, total: 3, closed: 1, eligibleForClose: false },
    { id: "md-f", title: "Faster pages", status: "open", priority: 2, total: 2, closed: 0, eligibleForClose: false },
  ];

  it("states the open work the three figures are read against", () => {
    const { container } = renderBoard();
    expect(container.querySelector("[data-page-answer-detail]")).toHaveTextContent("4 open tasks");
  });

  it("compares each project's week when there are two, and a project's name narrows the list", () => {
    const { container } = renderBoard({ data: payload({ projects: [project(), northwind] }) });
    const work = container.querySelector<HTMLElement>("[data-tasks-work]")!;
    expect([...work.querySelectorAll("[data-work-row]")].map((node) => node.getAttribute("data-work-row"))).toEqual(["meadow.example", "northwind.example"]);
    // Its figures are the answer's, which say when a count is partial.
    expect(work.closest("[data-surface-hero]")).not.toBeNull();
    fireEvent.click(within(work).getByRole("link", { name: "Northwind" }));
    expect(screen.getByTestId("search").textContent).toBe("?project=northwind.example");
    expect(container.querySelector('tr[data-task-row="nw-1"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).toBeNull();
  });

  it("draws no project chart for one project, whose figures the answer already states", () => {
    const { container } = renderBoard();
    expect(container.querySelector("[data-tasks-work]")).toBeNull();
  });

  it("counts the days in and out from the live read, and says the snapshot cannot count filings", () => {
    const live = renderBoard({ live: true, boards: { "meadow.example": { ...board([
      liveTask({ id: "md-a", status: "closed", closedAt: "2026-07-31T09:00:00.000Z", createdAt: "2026-07-30T09:00:00.000Z" }),
      liveTask({ id: "md-b", createdAt: "2026-07-31T10:00:00.000Z" }),
      liveTask({ id: "md-c", createdAt: "2026-07-31T11:00:00.000Z" }),
    ]), closedSince: "2026-07-25" } } });
    const panel = live.container.querySelector<HTMLElement>("[data-tasks-in-out]")!;
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent("Filed 2 more than closed, last 7 days");
    expect(panel.querySelector('[data-tasks-strip="closed"] [data-bar="2026-07-31"]')).toHaveAttribute("data-state", "now");
    // Before the live window nobody counted a filing: unmeasured, not zero.
    expect(panel.querySelector('[data-tasks-strip="filed"] [data-bar="2026-07-24"]')).toHaveAttribute("data-state", "unreported");
    // Each strip says the period it covers, under it and to a screen reader.
    for (const strip of ["closed", "filed"]) {
      const drawn = panel.querySelector<HTMLElement>(`[data-tasks-strip="${strip}"] [data-bar-strip]`)!;
      expect(drawn).toHaveTextContent(/Jul 19.*Aug 1/);
      expect(drawn.querySelector('[role="img"]')!.getAttribute("aria-label")).toContain("Jul 19 to Aug 1");
    }
    live.unmount();

    const history = { ...emptyWorkHistory(), closed: [{ t: "2026-07-30", v: 2 }, { t: "2026-07-31", v: 1 }] };
    const { container } = renderBoard({ data: payload({ projects: [project({ history })] }) });
    expect(container.querySelector('[data-tasks-strip="closed"]')).toHaveTextContent("3 in 2 days");
    expect(container.querySelector('[data-tasks-strip="filed"]')).toHaveTextContent("not in the saved snapshot");
  });

  it("draws an epic's tasks and what holds them from the live read, and picks another epic from the URL", () => {
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board(epicTasks, epics) } });
    const graph = container.querySelector<HTMLElement>("[data-tasks-epic]")!;
    // The most stuck epic leads: a blocked task holds the next one.
    expect(graph).toHaveAttribute("data-tasks-epic", "md-e");
    expect(graph).toHaveTextContent("1 stuck");
    // The header names the epic as the link to its page.
    expect(graph.querySelector("header a")).toHaveAttribute("href", "/tasks/md-e");
    expect(graph.querySelector('[data-flow-edge="md-e.2->md-e.3"]')).toHaveAttribute("data-state", "broken");
    expect(graph.querySelector('[data-flow-node="md-e.2"]')).toHaveAttribute("data-state", "warn");
    expect(graph.querySelector('[data-flow-node="md-e.3"]')).toHaveAttribute("href", "/tasks/md-e.3");

    fireEvent.change(within(graph).getByLabelText("Epic"), { target: { value: "md-f" } });
    expect(screen.getByTestId("search").textContent).toBe("?epic=md-f");
    expect(container.querySelector("[data-tasks-epic]")).toHaveAttribute("data-tasks-epic", "md-f");
  });

  it("draws no epic from the saved snapshot, which carries no dependencies", () => {
    const { container } = renderBoard({ data: payload({ projects: [project({
      epics: [{ id: "md-e", title: "Recipe overhaul", status: "open", priority: 1, total: 3, closed: 1, counts: { open: 2, inProgress: 0, blocked: 0, deferred: 0 }, priorities: [0, 1, 1, 0, 0] }],
      ready: [item({ id: "md-e.3", parent: "md-e" })],
    })] }) });
    expect(container.querySelector("[data-tasks-epic]")).toBeNull();
  });
});

describe("/tasks — live where the local read is, the photograph where it is not", () => {
  it("uses every recent closed task for the filter and paged history, and none for Done this week", () => {
    const closed = Array.from({ length: 60 }, (_, index) => liveTask({
      id: `md-closed${index}`,
      title: `Completed task ${index}`,
      status: "closed",
      priority: 0,
      closedAt: "2026-08-01T09:00:00.000Z",
    }));
    const { container } = renderBoard({
      live: true,
      entry: "/tasks?status=closed",
      boards: { "meadow.example": { ...board([liveTask(), ...closed]), closedSince: "2026-07-25" } },
      data: payload({ projects: [project({ recentlyClosed: closed.slice(0, 5) })] }),
    });
    // Done this week is counted from the snapshot's closes, which this one does not carry.
    expect(fig(container, "closed").querySelector("dd")).toHaveTextContent("—");
    expect(screen.getByRole("option", { name: "Closed, last 7 days · 60" })).toBeInTheDocument();
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    fireEvent.click(container.querySelector<HTMLElement>("[data-tasks-more]")!);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(60);
    expect(container.querySelector("[data-tasks-summary]")?.textContent).toBe("60 of 61");
    expect(container.querySelector("[data-task-history-status]")).toBeNull();
    expect(fig(container, "urgent").textContent).not.toContain("60");
  });

  it.each([false, true])("never presents an incomplete local history as complete (error=%s)", (failed) => {
    const { container } = renderBoard({
      live: true,
      entry: "/tasks?status=closed",
      errors: failed ? { "meadow.example": "database unavailable" } : {},
      data: payload({ projects: [project({ recentlyClosed: [item({ id: "md-done", status: "closed" })] })] }),
    });
    // Still arriving: a spinner beside the age. Failed: one banner naming the
    // project, with a Retry. Either way the week's total is a dash.
    if (failed) {
      expect(container.querySelector("[data-lane-error]")!.textContent).toContain("Meadow Board");
      expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
      expect(container.querySelector("[data-task-history-status]")).toBeNull();
    } else {
      expect(container.querySelector('[data-task-history-status="loading"]')).not.toBeNull();
      expect(container.querySelector("[data-lane-error]")).toBeNull();
    }
    expect(fig(container, "closed")).toHaveTextContent("—");
    expect(screen.getByRole("option", { name: "Closed, last 7 days · —" })).toBeInTheDocument();
  });

  it("asks for every project the photograph names, in its order", () => {
    renderBoard({
      live: true,
      data: payload({
        projects: [
          project(),
          project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [], inProgress: [] }),
        ],
      }),
    });

    expect(state.acrossCalls.at(-1)).toEqual(["meadow.example", "northwind.example"]);
  });

  it("renders the live rows, including the states the photograph never sent", () => {
    const { container } = renderBoard({
      live: true,
      boards: {
        "meadow.example": board([
          liveTask({ id: "md-blk", title: "Waiting on the schema", status: "blocked" }),
          liveTask({ id: "md-1w2" }),
        ]),
      },
    });

    const state = within(row(container, "md-blk")).getAllByText("Blocked")[0]!;
    expect(state).toBeInTheDocument();
    expect(state.previousElementSibling?.getAttribute("aria-label")).toBe("State — Blocked");
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(2);
  });

  it("keeps the photograph's rows and says so when one project's live read fails", () => {
    const { container } = renderBoard({
      live: true,
      errors: { "meadow.example": "bd: could not open the repository" },
    });

    expect(container.querySelector("[data-lane-error]")!.textContent).toContain("Meadow Board");
    expect(row(container, "md-1w2")).toBeInTheDocument();
  });

  it("names a project neither read could reach, once, above the board", () => {
    const { container } = renderBoard({
      data: payload({
        projects: [project({ ok: false, error: "no repository at ../meadow.example" })],
      }),
    });
    expect(screen.getByText(/1 project could not be read/)).toBeInTheDocument();
  });
});

describe("/tasks — the read-only fallback", () => {
  it("states the reason once, at the top, and disables every action", () => {
    const { container } = renderBoard();

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
      open(container, "md-1w2").querySelector<HTMLButtonElement>('[data-task-action="claim"]')!
        .disabled,
    ).toBe(true);
    // A row's Close as is drawn and cannot be pressed; its reason is the banner's sentence.
    const closeAsButton = within(row(container, "md-1w2")).getByRole("button", { name: "Close as" });
    expect(closeAsButton).toBeDisabled();
    expect(closeAsButton).toHaveAccessibleDescription(READ_ONLY_TASKS_HINT);
  });

  it("still shows the board — the fallback is a degradation, not a dead end", () => {
    const { container } = renderBoard();
    expect(row(container, "md-1w2")).toBeInTheDocument();
    expect(container.querySelector("[data-tasks-answer]")).not.toBeNull();
  });
});

describe("/tasks — filing one", () => {
  it("is the page's one primary action, and opens the composer in place", () => {
    renderBoard({ live: true, boards: { "meadow.example": board([liveTask()]) }, entry: "/tasks?status=open" });

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    // The page does not change under the composer; the filters stay.
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
    expect(screen.getByRole("dialog", { name: "File a task" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
  });

  it("offers exactly the projects the board's own filter offers", () => {
    renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
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
      boards: { "meadow.example": board([liveTask()]) },
      entry: "/tasks?project=meadow.example&new=1",
    });

    const composer = within(screen.getByRole("dialog"));
    expect((composer.getByLabelText("Project") as HTMLSelectElement).value).toBe("meadow.example");
  });

  it("keeps the filters when the composer is closed", () => {
    renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
      entry: "/tasks?status=open&new=1",
    });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("search").textContent).toBe("?status=open");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("files through the local read and names the id it minted", async () => {
    renderBoard({
      live: true,
      boards: { "meadow.example": board([liveTask()]) },
      entry: "/tasks?project=meadow.example&new=1",
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Rewrite the recipes hub" },
    });
    fireEvent.click(screen.getByRole("button", { name: "File task" }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledOnce());
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "meadow.example",
        title: "Rewrite the recipes hub",
        type: "task",
      }),
    );
    expect(toasts.success).toHaveBeenCalledWith("Filed md-new", expect.anything());
  });
});

// ── core hub availability ────────────────────────────────────────────────────

describe("/tasks — core hub availability", () => {
  it("keeps core navigation and points an unread project list to Task projects", () => {
    taskSourceMock.connected = null;
    const { container } = renderBoard({ data: payload({ capturedAt: null, projects: [] }) });
    expect(screen.getByRole("heading", { name: "Tasks", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("No task projects available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manage task projects/ })).toHaveAttribute("href", "/settings/task-projects");
    expect(container.querySelector("[data-new-task]")).not.toBeNull();
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });

  it("shows a missing asset's project without hiding the core Tasks tab", () => {
    taskSourceMock.connected = null;
    const { container } = renderScoped("example.com");
    expect(screen.getByText("No task project for this asset")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add a task project/ })).toHaveAttribute("href", "/settings/task-projects");
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

describe("/tasks — designed empty states", () => {
  it("distinguishes no project reading from an empty task queue", () => {
    for (const capturedAt of [null, "2026-08-01T11:59:00.000Z"]) {
      const { container, unmount } = renderBoard({ data: payload({ capturedAt, projects: [] }) });
      expect(screen.queryByText("No tasks yet")).toBeNull();
      expect(screen.getByText("No task projects available")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Manage task projects/ })).toHaveAttribute("href", "/settings/task-projects");
      expect(container.querySelector("[data-tasks-filters]")).toBeNull();
      expect(container.querySelector("[data-new-task]")).not.toBeNull();
      unmount();
    }
  });

  it("shows a loading state rather than an empty board", () => {
    renderBoard({ data: null, isPending: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("keeps the whole decision count when a label hides every decision, and restores them when cleared", () => {
    const { container } = renderBoard({ live: true, boards: {
      "meadow.example": board([liveTask({ id: "md-ask", title: "Choose a launch date", labels: ["human"], ready: true })]),
    }, entry: "/tasks/all?label=seo" });
    expect(answerLine(container)).toBe("1 decision for you");
    expect(screen.getByText("No decisions match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No decisions for you.")).toBeNull();
    expect(container.querySelector("[data-inbox-row]")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
    expect(container.querySelector('[data-inbox-row="md-ask"]')).toHaveTextContent("Choose a launch date");
    expect(screen.queryByText("No decisions match these filters.")).toBeNull();
    expect(answerLine(container)).toBe("1 decision for you");
  });

  it("keeps missing request details distinct from an empty queue or a filtered queue", () => {
    const { unmount } = renderBoard({ data: payload({ projects: [project({ counts: { ...project().counts, waiting: 3 }, waiting: [] })] }) });
    expect(screen.getByText("No decision details read.")).toBeInTheDocument();
    expect(screen.queryByText("No decisions for you.")).toBeNull();
    unmount();
    renderBoard({ data: payload({ projects: [
      project({ counts: { ...project().counts, waiting: 3 }, waiting: [] }),
      project({ asset: "unread.example", ok: false }),
    ] }) });
    expect(screen.getByText("Waiting work is unknown for unread projects.")).toBeInTheDocument();
    expect(screen.queryByText("No decisions match these filters.")).toBeNull();
  });

  it("says no task matches the filters rather than drawing an empty table", () => {
    const { container } = renderBoard({ entry: "/tasks?status=blocked" });
    expect(screen.getByText("No task matches these filters.")).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });
});

describe("/work is the old address and still answers", () => {
  it("redirects to /tasks in place and keeps the link's filters and anchor", async () => {
    const legacy = deskRoutes.find((route) => route.path === "/work");
    expect(legacy?.element).toBeDefined();
    expect(deskRoutes.some((route) => route.path === "/tasks")).toBe(true);
    expect(deskRoutes.some((route) => route.path === "/tasks/:id")).toBe(true);

    // The board's filters are the query, so a redirect that dropped it would
    // open the unfiltered board.
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
    expect(router.state.historyAction).toBe("REPLACE");
  });
});

// `/assets/:id/tasks` renders this component with `project` set. What is
// asserted here is the scoping and nothing else.

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
        name: "System",
        ready: [item({ id: "ro-9zz", title: "Somebody else's queue" })],
        inProgress: [],
      }),
    ],
  });

  it("pins the project and drops every control the page already answers", () => {
    const { container } = renderScoped("meadow.example", { data: two });

    expect(container.textContent).not.toContain("Somebody else's queue");
    expect(container.querySelector("#tasks-project")).toBeNull();
    expect(container.querySelector("th")!.textContent).toBe("Task");
    expect(
      [...container.querySelectorAll("th")].map((node) => node.textContent),
    ).not.toContain("Project");
    // The board declares its own first screen, scoped or not: the mark belongs
    // on the strip and the Waiting-on-you panel, and only the board knows
    // where that ends.
    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero.querySelector("[data-tasks-answer]")).not.toBeNull();
    expect(hero.querySelector("table")).toBeNull();
  });

  it("keeps every other filter working, and the URL is still the state", () => {
    const { container } = renderScoped("meadow.example", { data: two });

    fireEvent.change(container.querySelector<HTMLSelectElement>("#tasks-status")!, {
      target: { value: "in-progress" },
    });
    // A pinned project never occupies the query string: it is the page, not a control.
    expect(screen.getByTestId("search").textContent).toBe("?status=in-progress");
    expect(container.querySelector('tr[data-task-row="md-33j"]')).not.toBeNull();
    expect(container.querySelector('tr[data-task-row="md-1w2"]')).toBeNull();
  });

  it("does not name the project on an inbox row either", () => {
    const { container } = renderScoped("meadow.example", {
      data: payload({
        projects: [
          project({
            waiting: [item({ id: "md-9k1", title: "Decide the Korea trip", issueType: "gate" })],
          }),
        ],
      }),
    });

    const inbox = container.querySelector("[data-waiting-list]")!;
    expect(inbox.textContent).toContain("Decide the Korea trip");
    expect(inbox.textContent).not.toContain("Meadow Board");
  });

  it("offers New task here, and the composer opens pinned to this project", () => {
    const { container } = renderScoped("meadow.example", { live: true, data: two });

    const button = container.querySelector("[data-new-task]")!;
    expect(button.getAttribute("data-new-task-project")).toBe("meadow.example");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByTestId("search").textContent).toBe("");

    const composer = within(screen.getByRole("dialog", { name: "File a task" }));
    const select = composer.getByLabelText("Project") as HTMLSelectElement;
    expect(select.value).toBe("meadow.example");
    expect([...select.options].map((option) => option.value)).toEqual(["", "meadow.example"]);
  });

  it("says how to wire a project for an asset the task database has never heard of", () => {
    const { container } = renderScoped("acorn.example", { data: two });

    expect(screen.getByText("No task project for this asset")).toBeInTheDocument();
    expect(container.querySelector("[data-tasks-unwired]")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Add a task project/ })).toHaveAttribute("href", "/settings/task-projects");
    expect(container.querySelector("[data-tasks-filters]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });
});


describe("/tasks — per-project source and action guarantees", () => {
  it("keeps failed-project sample actions disabled while successful projects remain actionable", () => {
    const nom = project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ready: [item({ id: "nw-sample", title: "Saved Northwind task" })], inProgress: [] });
    const { container } = renderBoard({ live: true, data: payload({ projects: [project(), nom] }), boards: { "meadow.example": board([liveTask()]) }, errors: { "northwind.example": "Cannot read Northwind" } });
    const saved = open(container, "nw-sample");
    expect(within(saved).getByRole("button", { name: "Claim" })).toBeDisabled();
    expect(within(saved).getByRole("button", { name: "Close…" })).toBeDisabled();
    expect(within(saved).getByRole("button", { name: "Defer…" })).toBeDisabled();
    const current = open(container, "md-1w2");
    expect(within(current).getByRole("button", { name: "Claim" })).toBeEnabled();
    expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Northwind");
    expect(fig(container, "closed")).toHaveTextContent("—");
  });

  it.each(["failed refresh", "read-only capability"])("disables an already-open confirmation after %s", (transition) => {
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board([liveTask()]) } });
    const detail = open(container, "md-1w2");
    fireEvent.click(within(detail).getByRole("button", { name: "Close…" }));
    fireEvent.change(screen.getByLabelText("Why md-1w2 is closed"), { target: { value: "Verified result" } });
    expect(screen.getByRole("button", { name: "Close task" })).toBeEnabled();
    if (transition === "failed refresh") state.errors = { "meadow.example": "Read failed" };
    else state.capabilities = { live: false, reason: READ_ONLY_DEPLOYMENT };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "open" } });
    expect(screen.getByRole("button", { name: "Close task" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(api.closeTask).not.toHaveBeenCalled();
  });

  it("does not allow a saved human ask to be answered while its local read is pending", () => {
    const ask = item({ id: "md-ask", title: "Choose launch date" });
    const { container } = renderBoard({ live: true, data: payload({ projects: [project({ waiting: [ask] })] }) });
    fireEvent.click(within(container.querySelector("[data-waiting-list]") as HTMLElement).getByRole("button", { name: /Choose launch date/ }));
    // No verbs on a row the live read has not confirmed: the saved sample is
    // not something an answer can be sent against.
    const row = within(container.querySelector('[data-inbox-row="md-ask"]') as HTMLElement);
    expect(row.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(row.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});


it("shows unavailable project totals as unknown and never declares an empty queue", () => {
  const { container } = renderBoard({ live: true, data: payload({ projects: [project({ ok: false, error: "Snapshot failed" })] }), errors: { "meadow.example": "Local read failed" } });
  for (const mark of ["urgent", "blocked", "closed"] as const) {
    expect(fig(container, mark)).toHaveTextContent("—");
    expect(fig(container, mark)).not.toHaveTextContent("at least 0");
  }
  expect(answerLine(container)).toBe("Couldn't read your decisions");
  expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Meadow Board");
  expect(screen.getByText("Waiting work is unknown for unread projects.")).toBeInTheDocument();
  expect(screen.getByText("Task availability is unknown for unread projects.")).toBeInTheDocument();
  expect(screen.queryByText("No decisions for you.")).not.toBeInTheDocument();
  expect(screen.queryByText("Nothing is queued.")).not.toBeInTheDocument();
});

it("labels observed counts as partial when another project's totals are unavailable", () => {
  const { container } = renderBoard({ live: true, data: payload({ projects: [project(), project({ asset: "northwind.example", prefix: "nw", name: "Northwind", ok: false, error: "No snapshot" })] }), boards: { "meadow.example": board([liveTask()]) }, errors: { "northwind.example": "Cannot read Northwind" } });
  const blocked = fig(container, "blocked");
  expect(blocked).toHaveTextContent("at least 0");
  expect(blocked).not.toHaveTextContent("observed");
  expect(container.querySelector("[data-lane-error]")).toHaveTextContent("Northwind");
  expect(row(container, "md-1w2")).toBeInTheDocument();
});


describe("Task reasons support focus and tap", () => {
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

  it("exposes a project's refused read and opens the expanded task's parent epic", () => {
    const first = renderBoard({ data: payload({ projects: [project({ ok: false, error: "Task refresh unavailable" })] }) });
    fireEvent.focus(screen.getByRole("button", { name: "Meadow Board: task read failed" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Task refresh unavailable");
    first.unmount();
    const { container } = renderBoard({ data: payload({ projects: [project({
      epics: [{ id: "md-epic", title: "Recipe schema overhaul", status: "open", priority: 1,
        total: 1, closed: 0, counts: { open: 1, inProgress: 0, blocked: 0, deferred: 0 }, priorities: [0, 1, 0, 0, 0] }],
      ready: [item({ parent: "md-epic" })],
    })] }) });
    fireEvent.click(rowFold(container, "md-1w2"));
    const part = container.querySelector<HTMLElement>('[data-task-epic="md-epic"]')!;
    expect(part).toHaveTextContent("Part of Recipe schema overhaul");
    expect(within(part).getByRole("link", { name: "Recipe schema overhaul" })).toHaveAttribute("href", "/tasks/md-epic");
  });
});

describe("/tasks — several decisions taken in one action", () => {
  const waiting = (ids: string[]) => payload({ projects: [project({ waiting: ids.map((id) => item({ id, title: id })) })] });
  const gate = (id: string, title: string) => liveTask({ id, title, issueType: "gate", awaitType: "human" });
  const ask = (id: string, title: string) => liveTask({ id, title, labels: ["human"], ready: true });
  const mixed = () => ({
    "meadow.example": board([
      gate("md-g1", "Approve the spend"),
      gate("md-g2", "Approve the launch"),
      ask("md-a1", "Pick the launch date"),
      ask("md-a2", "Name the newsletter"),
    ]),
  });
  const rowOf = (container: HTMLElement, id: string) => container.querySelector(`[data-inbox-row="${id}"]`) as HTMLElement | null;
  const pick = (container: HTMLElement, ...ids: string[]) => {
    for (const id of ids) fireEvent.click(within(rowOf(container, id)!).getByRole("checkbox"));
  };
  const selection = (container: HTMLElement) => within(container.querySelector("[data-inbox-selection]") as HTMLElement);

  it("offers Select only where two or more decisions can be answered, and keeps each row's verbs until it is pressed", () => {
    // A read-only snapshot answers nothing, so nothing is selectable.
    const snapshot = renderBoard({ data: waiting(["md-g1", "md-g2"]) });
    expect(within(snapshot.container).queryByRole("button", { name: "Select" })).toBeNull();
    snapshot.unmount();

    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    expect(container.querySelector("[data-inbox-select]")).toBeNull();
    expect(within(rowOf(container, "md-g1")!).getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    expect(container.querySelectorAll("[data-inbox-select]")).toHaveLength(4);
    // While selecting, the selection's verbs stand in for the rows' own.
    expect(within(rowOf(container, "md-g1")!).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(selection(container).getByRole("status")).toHaveTextContent("0 selected");
    fireEvent.click(within(container).getByRole("button", { name: "Done" }));
    expect(container.querySelector("[data-inbox-select]")).toBeNull();
  });

  it("approves every selected approval in one action: one Undo, then one call at a time", async () => {
    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    pick(container, "md-g1", "md-g2", "md-a1");
    const bar = selection(container);
    expect(bar.getByRole("status")).toHaveTextContent("3 selected");
    // Each verb names how many rows it would send, and only rows it fits.
    expect(bar.getByRole("button", { name: "Approve 2" })).toBeEnabled();
    expect(bar.getByRole("button", { name: "Answer 1" })).toBeEnabled();
    expect(bar.getByRole("button", { name: "Close 1 as" })).toBeEnabled();

    let release: () => void = () => undefined;
    api.resolveGate.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
    fireEvent.click(bar.getByRole("button", { name: "Approve 2" }));
    expect(rowOf(container, "md-g1")).toBeNull();
    expect(rowOf(container, "md-g2")).toBeNull();
    expect(rowOf(container, "md-a1")).not.toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Approved 2", expect.objectContaining({
      description: "Approve the spend and 1 more",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    // The selection ends with the action; the ask's own verbs are back.
    expect(container.querySelector("[data-inbox-selection]")).toBeNull();
    expect(within(rowOf(container, "md-a1")!).getByRole("button", { name: "Answer" })).toBeEnabled();

    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledTimes(1));
    // The second call waits for the first to settle.
    expect(api.resolveGate).toHaveBeenCalledWith("md-g1");
    await act(async () => release());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledTimes(2));
    expect(api.resolveGate).toHaveBeenLastCalledWith("md-g2");
    await waitFor(() => expect(toasts.dismiss).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("takes the whole batch back with its one Undo, or with ⌘Z, and sends nothing", () => {
    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    pick(container, "md-a1", "md-a2");
    // Dismiss is the selection's Close as: Won't do, then Enter on its one line.
    fireEvent.click(selection(container).getByRole("button", { name: "Close 2 as" }));
    closeAsPicked(container, "Won't do");
    expect(rowOf(container, "md-a1")).toBeNull();
    expect(rowOf(container, "md-a2")).toBeNull();
    expect(vi.mocked(toasts.success).mock.calls.at(-1)![0]).toBe("Closed as Won't do · 2");
    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(rowOf(container, "md-a1")).not.toBeNull();
    expect(rowOf(container, "md-a2")).not.toBeNull();

    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    pick(container, "md-g1", "md-g2");
    fireEvent.click(selection(container).getByRole("button", { name: "Approve 2" }));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(rowOf(container, "md-g1")).not.toBeNull();
    expect(rowOf(container, "md-g2")).not.toBeNull();
    act(() => flushAnswers());
    expect(api.dismissTask).not.toHaveBeenCalled();
    expect(api.resolveGate).not.toHaveBeenCalled();
  });

  it("answers every selected question with one text, and never an empty one", async () => {
    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    pick(container, "md-a1", "md-a2", "md-g1");
    fireEvent.click(selection(container).getByRole("button", { name: "Answer 2" }));
    const box = screen.getByLabelText("Your answer to 2 questions");
    expect(box).toHaveFocus();
    expect(selection(container).getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "Go ahead, as agreed today." } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toasts.success).toHaveBeenCalledWith("Answered 2", expect.anything());
    // The approval picked with them is untouched: Answer sends questions only.
    expect(rowOf(container, "md-g1")).not.toBeNull();
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledTimes(2));
    expect(api.respondToTask).toHaveBeenCalledWith("md-a1", "Go ahead, as agreed today.");
    expect(api.respondToTask).toHaveBeenCalledWith("md-a2", "Go ahead, as agreed today.");
    expect(api.resolveGate).not.toHaveBeenCalled();
  });

  it("names the decisions that were not sent, brings back their rows, and keeps the rest", async () => {
    api.resolveGate.mockImplementation(async (id: string) => {
      if (id === "md-g2") throw new Error("bd: md-g2 is not open");
      return undefined;
    });
    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    pick(container, "md-g1", "md-g2");
    fireEvent.click(selection(container).getByRole("button", { name: "Approve 2" }));
    act(() => flushAnswers());
    // One task not sent: the toast offers Open on it.
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Not sent: md-g2", {
      description: "bd: md-g2 is not open", action: { label: "Open", onClick: expect.any(Function) } }));
    expect(api.resolveGate).toHaveBeenCalledWith("md-g1");
    expect(rowOf(container, "md-g2")).not.toBeNull();
    expect(rowOf(container, "md-g1")).toBeNull();
    api.resolveGate.mockReset();
    api.resolveGate.mockImplementation(async () => undefined);
  });

  it("shows every row while selecting, and Select all reaches the rows past the first five", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `md-a${index}`);
    const { container } = renderBoard({
      data: waiting(ids), live: true,
      boards: { "meadow.example": board(ids.map((id) => ask(id, `Ask ${id}`))) },
    });
    expect(container.querySelectorAll("[data-inbox-row]")).toHaveLength(5);
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    expect(container.querySelectorAll("[data-inbox-row]")).toHaveLength(7);
    fireEvent.click(selection(container).getByRole("button", { name: "Select all 7" }));
    expect(selection(container).getByRole("status")).toHaveTextContent("7 selected");
    expect(selection(container).getByRole("button", { name: "Clear" })).toBeEnabled();
    fireEvent.click(selection(container).getByRole("button", { name: "Close 7 as" }));
    closeAsPicked(container, "Won't do");
    expect(container.querySelectorAll("[data-inbox-row]")).toHaveLength(0);
    act(() => flushAnswers());
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledTimes(7));
    expect(api.dismissTask).toHaveBeenCalledWith("md-a6");
  });

  it("offers no selection in a workspace that does not let this person decide", () => {
    const { container } = renderBoard({ data: waiting(["md-g1", "md-g2", "md-a1", "md-a2"]), live: true, boards: mixed() });
    expect(within(container).getByRole("button", { name: "Select" })).toBeTruthy();
    state.capabilities = { live: true, reason: null, operations: ["create", "update", "comment", "close"] };
    fireEvent.change(container.querySelector("#tasks-status")!, { target: { value: "open" } });
    expect(within(container).queryByRole("button", { name: "Select" })).toBeNull();
  });
});

describe("/tasks — a decision with choices is one press from Your decisions", () => {
  const CHOICES: TaskChoices = {
    question: "Which day does the newsletter go out?",
    options: [
      { key: "a", label: "Monday" },
      { key: "b", label: "Tuesday", detail: "Opens were highest on Tuesdays.", recommended: true },
      { key: "c", label: "Friday" },
    ],
  };
  const waiting = (ids: string[]) => payload({ projects: [project({ waiting: ids.map((id) => item({ id, title: id })) })] });
  const choice = (id: string, title: string) => liveTask({ id, title, labels: ["human"], ready: true, choices: CHOICES });
  const one = () => ({ "meadow.example": board([choice("md-c1", "Pick the newsletter day")]) });
  const rowOf = (container: HTMLElement, id: string) => container.querySelector(`[data-inbox-row="${id}"]`) as HTMLElement | null;
  const names = (scope: HTMLElement) => within(scope).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());

  it("draws the question and one button per option on the row, the recommended first, with Answer and Close as under them", () => {
    const { container } = renderBoard({ data: waiting(["md-c1"]), live: true, boards: one() });
    const row = rowOf(container, "md-c1")!;
    expect(row).toHaveTextContent("Meadow Board · needs your choice");
    const group = within(row).getByRole("group", { name: CHOICES.question });
    expect(names(group)).toEqual(["(b) Tuesday", "(a) Monday", "(c) Friday", "Answer", "Close as"]);
    expect(within(group).getByText("Recommended")).toBeInTheDocument();
    expect(within(group).getByText("Opens were highest on Tuesdays.")).toBeInTheDocument();
    expect(within(group).getByLabelText("Note")).toBeInTheDocument();
  });

  it("picks in one press: the row leaves, the toast names the pick with Undo, and choose is sent when the window closes", async () => {
    const { container } = renderBoard({ data: waiting(["md-c1"]), live: true, boards: one() });
    const row = within(rowOf(container, "md-c1")!);
    fireEvent.change(row.getByLabelText("Note"), { target: { value: "Start next week." } });
    fireEvent.click(row.getByRole("button", { name: "(c) Friday" }));
    expect(rowOf(container, "md-c1")).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Chose (c) Friday", expect.objectContaining({
      description: "Pick the newsletter day",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    expect(api.chooseOnTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.chooseOnTask).toHaveBeenCalledOnce());
    expect(api.chooseOnTask).toHaveBeenCalledWith("md-c1", "c", "Start next week.");
    expect(api.respondToTask).not.toHaveBeenCalled();
  });

  it("takes a pick back inside its window, and the row returns with its options", () => {
    const { container } = renderBoard({ data: waiting(["md-c1"]), live: true, boards: one() });
    fireEvent.click(within(rowOf(container, "md-c1")!).getByRole("button", { name: "(b) Tuesday" }));
    expect(rowOf(container, "md-c1")).toBeNull();
    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(within(rowOf(container, "md-c1")!).getByRole("button", { name: "(b) Tuesday" })).toBeEnabled();
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("gives a second pick its own toast and ignores the first pick's late Undo", async () => {
    const { container } = renderBoard({ data: waiting(["md-c1"]), live: true, boards: one() });
    const pick = () => fireEvent.click(within(rowOf(container, "md-c1")!).getByRole("button", { name: "(b) Tuesday" }));
    const lastToast = () => vi.mocked(toasts.success).mock.calls.at(-1)![1] as { id: string; action: { onClick: () => void } };
    pick();
    const first = lastToast();
    act(() => first.action.onClick());
    pick();
    const second = lastToast();
    expect(second.id).not.toBe(first.id);
    act(() => first.action.onClick());
    expect(rowOf(container, "md-c1")).toBeNull();
    act(() => second.action.onClick());
    expect(rowOf(container, "md-c1")).not.toBeNull();
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("answers a decision with choices in free text too, from under its options", async () => {
    const { container } = renderBoard({ data: waiting(["md-c1"]), live: true, boards: one() });
    fireEvent.click(within(rowOf(container, "md-c1")!).getByRole("button", { name: "Answer" }));
    const box = screen.getByLabelText("Your answer to md-c1");
    fireEvent.change(box, { target: { value: "Thursday, after the launch." } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledWith("md-c1", "Thursday, after the launch."));
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("leaves decisions with choices out of Answer in Select, names them in the count, and still dismisses them", async () => {
    const { container } = renderBoard({
      data: waiting(["md-g1", "md-a1", "md-c1", "md-c2"]), live: true,
      boards: { "meadow.example": board([
        liveTask({ id: "md-g1", title: "Approve the spend", issueType: "gate", awaitType: "human" }),
        liveTask({ id: "md-a1", title: "Name the newsletter", labels: ["human"], ready: true }),
        choice("md-c1", "Pick the newsletter day"),
        choice("md-c2", "Pick the newsletter hour"),
      ]) },
    });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    // While selecting, the selection's verbs stand in for a row's options too.
    expect(within(rowOf(container, "md-c1")!).queryByRole("button", { name: "(b) Tuesday" })).toBeNull();
    fireEvent.click(within(container.querySelector("[data-inbox-selection]") as HTMLElement).getByRole("button", { name: "Select all 4" }));
    const bar = within(container.querySelector("[data-inbox-selection]") as HTMLElement);
    expect(bar.getByRole("status")).toHaveTextContent("4 selected · 2 need a choice");
    expect(bar.getByRole("button", { name: "Approve 1" })).toBeEnabled();
    expect(bar.getByRole("button", { name: "Answer 1" })).toBeEnabled();
    expect(bar.getByRole("button", { name: "Close 3 as" })).toBeEnabled();

    fireEvent.click(bar.getByRole("button", { name: "Answer 1" }));
    const box = screen.getByLabelText("Your answer to 1 questions");
    fireEvent.change(box, { target: { value: "Weekly Notes" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(rowOf(container, "md-a1")).toBeNull();
    expect(rowOf(container, "md-c1")).not.toBeNull();
    expect(rowOf(container, "md-c2")).not.toBeNull();
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledOnce());
    expect(api.respondToTask).toHaveBeenCalledWith("md-a1", "Weekly Notes");
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("says one decision needs a choice in the singular, and offers no Answer when every question selected has choices", () => {
    const { container } = renderBoard({
      data: waiting(["md-g1", "md-c1"]), live: true,
      boards: { "meadow.example": board([
        liveTask({ id: "md-g1", title: "Approve the spend", issueType: "gate", awaitType: "human" }),
        choice("md-c1", "Pick the newsletter day"),
      ]) },
    });
    fireEvent.click(within(container).getByRole("button", { name: "Select" }));
    fireEvent.click(within(rowOf(container, "md-c1")!).getByRole("checkbox"));
    const bar = within(container.querySelector("[data-inbox-selection]") as HTMLElement);
    expect(bar.getByRole("status")).toHaveTextContent("1 selected · 1 needs a choice");
    expect(bar.queryByRole("button", { name: /^Answer/ })).toBeNull();
    expect(bar.getByRole("button", { name: "Close 1 as" })).toBeEnabled();
  });
});

describe("/tasks — Select on All tasks closes many tasks with one resolution and one note", () => {
  const backlog = (...extra: LiveTask[]) => ({ "meadow.example": board([
    liveTask({ id: "md-b1", title: "Retire the old FAQ", labels: ["seo"] }),
    liveTask({ id: "md-b2", title: "Move the sitemap", labels: ["seo"] }),
    liveTask({ id: "md-b3", title: "Rename the newsletter", labels: ["copy"] }),
    ...extra,
  ]) });
  const table = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-tasks-table]")!;
  const bar = (container: HTMLElement) => within(container.querySelector<HTMLElement>("[data-tasks-selection]")!);
  const startSelecting = (container: HTMLElement) => fireEvent.click(within(table(container)).getByRole("button", { name: "Select" }));
  const pickRows = (container: HTMLElement, ...ids: string[]) => {
    for (const id of ids) fireEvent.click(within(row(container, id)).getByRole("checkbox"));
  };
  const rowGone = (container: HTMLElement, id: string) => container.querySelector(`tr[data-task-row="${id}"]`) === null;

  it("offers Select where two or more rows can be closed, puts a box on each, and shows every row while selecting", () => {
    // A read-only board closes nothing, so it offers no Select.
    const snapshot = renderBoard();
    expect(within(table(snapshot.container)).queryByRole("button", { name: "Select" })).toBeNull();
    snapshot.unmount();

    const many = Array.from({ length: 30 }, (_, index) => liveTask({ id: `md-t${index}`, title: `Task ${index}` }));
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board(many) } });
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    expect(container.querySelector("[data-task-select]")).toBeNull();
    startSelecting(container);
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(30);
    expect(container.querySelectorAll("[data-task-select]")).toHaveLength(30);
    expect(container.querySelector("[data-tasks-more]")).toBeNull();
    // While selecting, the selection's Close as stands in for each row's own.
    expect(within(row(container, "md-t0")).queryByRole("button", { name: "Close as" })).toBeNull();
    expect(bar(container).getByRole("status")).toHaveTextContent("0 selected");
    fireEvent.click(bar(container).getByRole("button", { name: "Select all 30" }));
    expect(bar(container).getByRole("status")).toHaveTextContent("30 selected");
    expect(bar(container).getByRole("button", { name: "Close 30 as" })).toBeEnabled();
    fireEvent.click(bar(container).getByRole("button", { name: "Clear" }));
    expect(bar(container).getByRole("status")).toHaveTextContent("0 selected");
    expect(bar(container).queryByRole("button", { name: /^Close/ })).toBeNull();
    fireEvent.click(within(table(container)).getByRole("button", { name: "Done" }));
    expect(container.querySelector("[data-tasks-selection]")).toBeNull();
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    expect(within(row(container, "md-t0")).getByRole("button", { name: "Close as" })).toBeEnabled();
  });

  it("closes every selected task with one resolution and one note: one toast, one Undo, then one call at a time", async () => {
    const { container } = renderBoard({ live: true, boards: backlog(
      liveTask({ id: "md-h1", title: "Confirm the sponsor", labels: ["human"], status: "in_progress", assignee: "dana" }),
    ) });
    startSelecting(container);
    pickRows(container, "md-b1", "md-b2", "md-h1");
    expect(bar(container).getByRole("status")).toHaveTextContent("3 selected");
    fireEvent.click(bar(container).getByRole("button", { name: "Close 3 as" }));
    const menu = screen.getByRole("menu", { name: "Close 3 tasks as" });
    // Never Done: a done close carries its own evidence, task by task.
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Won't do", "Duplicate", "Can't reproduce", "Already handled"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Already handled" }));
    const form = container.querySelector<HTMLFormElement>('[data-tasks-selection] [data-task-form="close-as"]')!;
    expect(within(form).getByText("Already handled")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Note"), { target: { value: "Shipped with the spring launch" } });
    let release: () => void = () => undefined;
    api.closeTask.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
    fireEvent.click(within(form).getByRole("button", { name: "Close 3 tasks" }));

    for (const id of ["md-b1", "md-b2", "md-h1"]) expect(rowGone(container, id)).toBe(true);
    expect(rowGone(container, "md-b3")).toBe(false);
    expect(toasts.success).toHaveBeenLastCalledWith("Closed as Already handled · 3", expect.objectContaining({
      description: expect.stringMatching(/ and 2 more$/),
      action: expect.objectContaining({ label: "Undo" }),
    }));
    // The selection ends with the action; each row's own Close as is back.
    expect(container.querySelector("[data-tasks-selection]")).toBeNull();
    expect(within(row(container, "md-b3")).getByRole("button", { name: "Close as" })).toBeEnabled();
    expect(api.closeTask).not.toHaveBeenCalled();

    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    // The next call waits for the first to settle.
    expect(api.closeTask).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledOnce());
    expect(api.closeTask).toHaveBeenCalledWith("md-b1", "Shipped with the spring launch", { resolution: "already-handled" });
    expect(api.closeTask).toHaveBeenCalledWith("md-b2", "Shipped with the spring launch", { resolution: "already-handled" });
    // A task waiting on a person is declined with the resolution, as its row's Close as declines it.
    expect(api.dismissTask).toHaveBeenCalledWith("md-h1", "Shipped with the spring launch", { resolution: "already-handled" });
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("takes the whole close back with its one Undo, and the next one closes each task with the resolution and note", async () => {
    const { container } = renderBoard({ live: true, boards: backlog() });
    const closeAll = () => {
      startSelecting(container);
      fireEvent.click(bar(container).getByRole("button", { name: "Select all 3" }));
      fireEvent.click(bar(container).getByRole("button", { name: "Close 3 as" }));
      closeAsPicked(container, "Won't do", { note: "Out of scope this year" });
    };
    closeAll();
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(0);
    expect(vi.mocked(toasts.success).mock.calls.at(-1)![0]).toBe("Closed as Won't do · 3");
    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(3);
    act(() => flushAnswers());
    expect(api.closeTask).not.toHaveBeenCalled();

    closeAll();
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(3));
    for (const id of ["md-b1", "md-b2", "md-b3"]) {
      expect(api.closeTask).toHaveBeenCalledWith(id, "Out of scope this year", { resolution: "wont-do" });
    }
  });

  it("names a selected task that was closed already, and leaves it as it is", async () => {
    const { container } = renderBoard({ live: true, boards: backlog(
      liveTask({ id: "md-c1", title: "Fix the footer", status: "closed", closedAt: "2026-07-31T10:00:00.000Z" }),
    ) });
    startSelecting(container);
    fireEvent.click(bar(container).getByRole("button", { name: "Select all 4" }));
    expect(bar(container).getByRole("status")).toHaveTextContent("4 selected · 1 closed already");
    fireEvent.click(bar(container).getByRole("button", { name: "Close 3 as" }));
    closeAsPicked(container, "Can't reproduce");
    expect(toasts.success).toHaveBeenLastCalledWith("Closed as Can't reproduce · 3", expect.objectContaining({
      description: expect.stringMatching(/ and 2 more · md-c1 closed already$/),
    }));
    expect(rowGone(container, "md-c1")).toBe(false);
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(3));
    expect(api.closeTask).not.toHaveBeenCalledWith("md-c1", expect.anything(), expect.anything());
    expect(api.closeTask).toHaveBeenCalledWith("md-b1", "Can't reproduce", { resolution: "cant-reproduce" });
  });

  it("names a refused close, brings its row back and keeps the others closed", async () => {
    api.closeTask.mockImplementation(async (id: string) => {
      if (id === "md-b2") throw new Error("md-b2 is held by dana.");
      return undefined;
    });
    try {
      const { container } = renderBoard({ live: true, boards: backlog() });
      startSelecting(container);
      pickRows(container, "md-b1", "md-b2");
      fireEvent.click(bar(container).getByRole("button", { name: "Close 2 as" }));
      closeAsPicked(container, "Won't do");
      act(() => flushAnswers());
      await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Not sent: md-b2", {
        description: "md-b2 is held by dana.", action: { label: "Open", onClick: expect.any(Function) } }));
      expect(rowGone(container, "md-b2")).toBe(false);
      expect(rowGone(container, "md-b1")).toBe(true);
    } finally {
      api.closeTask.mockReset();
      api.closeTask.mockImplementation(async () => undefined);
    }
  });

  it("takes one other task for every selected duplicate, says so under the field, and never a selected task's own id", async () => {
    const { container } = renderBoard({ live: true, boards: backlog() });
    startSelecting(container);
    pickRows(container, "md-b1", "md-b2");
    fireEvent.click(bar(container).getByRole("button", { name: "Close 2 as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    const form = container.querySelector<HTMLFormElement>('[data-tasks-selection] [data-task-form="close-as"]')!;
    const other = within(form).getByLabelText("Duplicate of");
    expect(other).toHaveAccessibleDescription("All 2 become duplicates of this one task, which is rarely right.");
    const send = within(form).getByRole("button", { name: "Close 2 tasks" });
    expect(send).toBeDisabled();
    fireEvent.change(other, { target: { value: "md-b2" } });
    expect(send).toBeDisabled();
    fireEvent.change(other, { target: { value: "md-b3" } });
    expect(send).toBeEnabled();
    fireEvent.submit(form);
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(2));
    expect(api.closeTask).toHaveBeenCalledWith("md-b1", "Duplicate of md-b3", { resolution: "duplicate", duplicateOf: "md-b3" });
    expect(api.closeTask).toHaveBeenCalledWith("md-b2", "Duplicate of md-b3", { resolution: "duplicate", duplicateOf: "md-b3" });
  });

  it("keeps the filters in force while selecting: Select all picks the rows they show, and only those are closed", async () => {
    const filtered = renderBoard({ live: true, boards: backlog(), entry: "/tasks?label=seo" });
    startSelecting(filtered.container);
    expect(bar(filtered.container).getByRole("button", { name: "Select all 2" })).toBeEnabled();
    filtered.unmount();

    const { container } = renderBoard({ live: true, boards: backlog() });
    startSelecting(container);
    fireEvent.click(bar(container).getByRole("button", { name: "Select all 3" }));
    // Narrowing the board while selecting keeps the selection to what it shows.
    fireEvent.change(container.querySelector("#tasks-label")!, { target: { value: "seo" } });
    expect(screen.getByTestId("search")).toHaveTextContent("?label=seo");
    expect(bar(container).getByRole("status")).toHaveTextContent("2 selected");
    fireEvent.click(bar(container).getByRole("button", { name: "Close 2 as" }));
    closeAsPicked(container, "Already handled", { note: "Moved with the redesign" });
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledTimes(2));
    expect(api.closeTask).not.toHaveBeenCalledWith("md-b3", expect.anything(), expect.anything());
  });

  it("puts no box on a row this workspace cannot close, and offers no Select where nothing can be closed", () => {
    // Declining a task waiting on a person needs the decide permission.
    const { container, unmount } = renderBoard({ live: true, operations: ["create", "update", "comment", "close"], boards: backlog(
      liveTask({ id: "md-h1", title: "Confirm the sponsor", labels: ["human"], status: "in_progress", assignee: "dana" }),
    ) });
    startSelecting(container);
    expect(row(container, "md-b1").querySelector("[data-task-select]")).not.toBeNull();
    expect(row(container, "md-h1").querySelector("[data-task-select]")).toBeNull();
    expect(bar(container).getByRole("button", { name: "Select all 3" })).toBeEnabled();
    unmount();

    const none = renderBoard({ live: true, operations: ["create", "update", "comment"], boards: backlog() });
    expect(within(table(none.container)).queryByRole("button", { name: "Select" })).toBeNull();
  });
});

describe("/tasks — each figure's week against the week before", () => {
  const NOW = new Date("2026-08-01T12:00:00.000Z");
  const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.parse("2026-07-19T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10));
  /** Two weeks of one project at `scale`: Saturday 08-01 is the sixth day of
   * the week that began on Monday 07-27, done doubled this week, blocked
   * tripled today, the inbox emptied today, urgent level. */
  function weekly(asset: string, prefix: string, name: string, scale: number): WorkProject {
    const series = (value: (index: number) => number) => DAYS.map((t, i) => ({ t, v: value(i) }));
    const history = {
      ...emptyWorkHistory(),
      closed: series((i) => (i >= 8 ? 2 * scale : scale)),
      blocked: series((i) => (i === 13 ? 3 * scale : i >= 6 ? scale : 0)),
      urgent: series(() => 2 * scale),
      waiting: series((i) => (i === 13 ? 0 : 2 * scale)),
      inProgress: series(() => 1),
    };
    // The same closes as the snapshot carries them, each at 10:00 on its day.
    const closes = { since: "2026-07-17", items: history.closed.flatMap((day) => Array.from({ length: day.v }, () => ({ at: `${day.t}T10:00:00.000Z` }))) };
    return project({ asset, prefix, name, history, weeks: workWeeks(history, closes, NOW, "UTC") });
  }
  const data = payload({ historyDays: 14, projects: [weekly("meadow.example", "md", "Meadow Board", 1), weekly("northwind.example", "nw", "Northwind", 2)] });
  const value = (figure: HTMLElement) => figure.querySelector("dd")!.textContent;

  it("gives Urgent, Blocked and Done this week the Wall's count with its move, and the answer its own", () => {
    const { container } = renderBoard({ data });
    // The Wall's numbers: blocked from the history (3 + 6), not the snapshot's 0.
    expect(value(fig(container, "blocked"))).toBe("9");
    expect(within(fig(container, "blocked")).getByLabelText("6 more than a week ago")).toHaveAttribute("data-tone", "negative");
    expect(fig(container, "blocked")).toHaveTextContent("· 6 added");
    expect(value(fig(container, "urgent"))).toBe("6");
    expect(within(fig(container, "urgent")).getByLabelText("Level with a week ago")).toHaveAttribute("data-tone", "neutral");
    // Six days at 2 + 4 a day, against last week to this moment at 1 + 2.
    expect(value(fig(container, "closed"))).toBe("36");
    expect(fig(container, "closed").querySelector("dt")).toHaveTextContent("Done this week");
    expect(within(fig(container, "closed")).getByLabelText("18 more than last week by today")).toHaveAttribute("data-tone", "positive");
    // The inbox emptied: 0 decisions, 6 fewer than a week ago, which is better.
    expect(answerLine(container)).toBe("No decisions for you");
    const detail = container.querySelector<HTMLElement>("[data-page-answer-detail]")!;
    expect(within(detail).getByLabelText("6 fewer than a week ago")).toHaveAttribute("data-tone", "positive");
    // The rows hold seven days of closes; the figure above is the calendar week.
    expect(screen.getByRole("option", { name: /^Closed, last 7 days · / })).toBeInTheDocument();
  });

  it("draws done this week against last week under In and out, and says how they compare", () => {
    const { container } = renderBoard({ data });
    const panel = container.querySelector<HTMLElement>("[data-tasks-in-out]")!;
    expect(panel.querySelector("[data-tasks-week-line]")).toHaveTextContent("18 more done this week than last week by today");
    const week = panel.querySelector<HTMLElement>("[data-tasks-week]")!;
    expect(week).toHaveTextContent("Done this week36 · 6 days in");
    expect(week.querySelector("[data-pace-bar]")).toHaveAttribute("data-pace", "ahead");
    expect(week).toHaveTextContent("Done last week by today 18");
    expect(week).toHaveTextContent("Done last week total 21");
    // Each project's row: this week's done over last week's outline.
    expect(container.querySelector('[data-work-row="northwind.example"] [data-work-last-week]')).toHaveAttribute("data-work-last-week", "14");
  });

  it("shows the same figures from the live read as from the saved snapshot", () => {
    const { container } = renderBoard({ data, live: true, boards: {
      "meadow.example": board([liveTask({ id: "md-b", status: "blocked" })]),
      "northwind.example": { ...board([liveTask({ id: "nw-a" })], null, "northwind.example"), prefix: "nw" },
    } });
    expect([value(fig(container, "urgent")), value(fig(container, "blocked")), value(fig(container, "closed"))]).toEqual(["6", "9", "36"]);
  });

  it("gives an asset's Tasks tab its own project's week", () => {
    const { container } = renderScoped("northwind.example", { data });
    expect([value(fig(container, "urgent")), value(fig(container, "blocked")), value(fig(container, "closed"))]).toEqual(["4", "6", "24"]);
    expect(within(fig(container, "closed")).getByLabelText("12 more than last week by today")).toBeInTheDocument();
  });

  it("gives a project-filtered board its own week and history, and restores all projects when switched", () => {
    const { container } = renderBoard({ data, entry: "/tasks/all?project=northwind.example" });
    expect([value(fig(container, "urgent")), value(fig(container, "blocked")), value(fig(container, "closed"))]).toEqual(["4", "6", "24"]);
    expect(container.querySelector("[data-tasks-week-line]")).toHaveTextContent("12 more done this week");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "all" } });
    expect(value(fig(container, "closed"))).toBe("36");
    expect(container.querySelector("[data-tasks-week-line]")).toHaveTextContent("18 more done this week");
  });

  it("draws no move where the store holds no week, and no number it did not count", () => {
    const { container } = renderBoard();
    expect(container.querySelector("[data-week-move]")).toBeNull();
    expect(container.querySelector("[data-tasks-week]")).toBeNull();
    expect(value(fig(container, "closed"))).toBe("—");
  });

  it("puts no plus sign on a figure of a board every project of which was read", () => {
    const { container } = renderBoard({ data });
    const answer = container.querySelector<HTMLElement>("[data-tasks-answer]")!;
    expect(answer.textContent).not.toContain("+");
    expect(container.querySelector("[data-tasks-in-out]")!.textContent).not.toContain("+");
  });
});

describe("/tasks and the Wall: one Done this week and one Done last week", () => {
  // 05:00 on Saturday 08-01 in Los Angeles: the week began on Monday 07-27.
  const NOW = new Date("2026-08-01T12:00:00.000Z");
  const ZONE = "America/Los_Angeles";
  /** What the poller read, each close at its UTC time; the comments are Los Angeles times. */
  const meadow = { since: "2026-07-17", items: [
    { at: "2026-07-20T16:00:00.000Z" }, // Mon 09:00, last week
    { at: "2026-07-22T16:00:00.000Z" }, // Wed, last week
    { at: "2026-07-25T20:00:00.000Z" }, // Sat 13:00, later than this moment of last week
    { at: "2026-07-27T06:00:00.000Z" }, // Sun 07-26 23:00: Monday in UTC, last week here
    { at: "2026-07-28T16:00:00.000Z" },
    { at: "2026-07-29T16:00:00.000Z", resolution: "wont-do" },
    { at: "2026-07-31T16:00:00.000Z" },
  ] };
  const northwind = { since: "2026-07-17", items: [
    { at: "2026-07-21T16:00:00.000Z" },
    { at: "2026-07-30T16:00:00.000Z" }, { at: "2026-07-30T17:00:00.000Z" }, { at: "2026-07-30T18:00:00.000Z" },
    { at: "2026-08-01T08:00:00.000Z" }, // Sat 01:00
  ] };

  it("draws the same two numbers on the Work tile and the board, from one stored task snapshot", async () => {
    const store = await createTestStore();
    try {
      await addSites(store, ["meadow.example", "northwind.example"].map((id) => ({ id, displayName: id, status: "live", createdAt: "2026-07-01T00:00:00.000Z" })));
      await seedSnapshot(store, "2026-08-01T11:59:00.000Z", [
        workProject({ closes: meadow, counts: { open: 4, highPriority: 0, ready: 3, inProgress: 1, blocked: 1, closedRecent: 6, waiting: 0 }, waitingUrgent: 0 }),
        workProject({ asset: "northwind.example", prefix: "nw", closes: northwind, counts: { open: 2, highPriority: 0, ready: 2, inProgress: 0, blocked: 0, closedRecent: 4, waiting: 0 }, waitingUrgent: 0 }),
      ]);
      // Two days of history, so In and out has days to draw.
      for (const project of ["meadow.example", "northwind.example"]) {
        for (const day of ["2026-07-31", "2026-08-01"]) {
          await store.call.write((tx) => tx.execute(
            `INSERT INTO noticeos.task_daily_counts (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
             VALUES ($1::uuid, $2, $3::date, $4::timestamptz, 0, 0, 4, 1, 0, '[]'::jsonb)`,
            [tx.workspaceId, project, day, "2026-08-01T11:59:00.000Z"]));
        }
      }
      const wall = await buildWallPayload(store.call, { now: NOW, constants: { dataUsd: 25 }, integrations: { catalog: [], assets: {} },
        pullConfig: [], dashboard: {}, serpPanel: { assets: {} }, osTimeZone: ZONE });
      const work = await buildWorkPayload(store.call, { now: NOW, timeZone: ZONE });

      const tile = render(<WallWork assets={sitesInWork(wall)} operator={wall.operator} nowMs={NOW.getTime()} />);
      const tileDone = tile.container.querySelector<HTMLElement>('[data-work-figure="Done this week"]')!;
      const tileWeeks = tile.container.querySelector<HTMLElement>("[data-work-weeks]")!;
      // Three at Meadow including Won't do, and four at Northwind.
      expect(tileDone).toHaveTextContent(/^Done this week7(?!\+)/);
      expect(within(tileDone).getByLabelText("4 more than last week by today")).toBeInTheDocument();
      expect(tileWeeks).toHaveTextContent("Done last week by today 3");
      expect(tileWeeks).toHaveTextContent("Done last week total 5");
      tile.unmount();

      const { container } = renderBoard({ data: work });
      const boardDone = fig(container, "closed");
      expect(boardDone.querySelector("dt")).toHaveTextContent("Done this week");
      expect(boardDone.querySelector("dd")!.firstChild?.textContent).toBe("7");
      expect(boardDone).not.toHaveTextContent("not done");
      expect(within(boardDone).getByLabelText("4 more than last week by today")).toBeInTheDocument();
      const boardWeeks = container.querySelector<HTMLElement>("[data-tasks-week]")!;
      expect(boardWeeks).toHaveTextContent("Done this week7 · 6 days in");
      expect(boardWeeks).toHaveTextContent("Done last week by today 3");
      expect(boardWeeks).toHaveTextContent("Done last week total 5");
    } finally {
      await store.close();
    }
  });
});


describe("task word search on the board", () => {
  it("stores literal all as q, resets pagination and clears with the other filters", () => {
    const tasks = Array.from({ length: 250 }, (_, index) => liveTask({ id: `md-${index}`, title: `Install all schema ${index}` }));
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board(tasks) } });
    fireEvent.click(screen.getByRole("button", { name: /Load 25 more/ }));
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(50);
    const search = screen.getByRole("searchbox", { name: "Search task titles or ids" });
    expect(search).toHaveAccessibleDescription(/Titles\/ids only/);
    fireEvent.change(search, { target: { value: "all" } });
    expect(screen.getByTestId("search")).toHaveTextContent("?q=all");
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(25);
    fireEvent.change(search, { target: { value: "MD-249" } });
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(1);
    expect(row(container, "md-249")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
    expect(search).toHaveValue("");
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it.each([
    { live: true, errors: {}, text: "No task matches these filters." },
    { live: false, errors: {}, text: "No matches in available records. The search is limited to the tasks read." },
    { live: true, errors: { "meadow.example": "fixture unavailable" }, text: "Search is incomplete: some projects could not be read." },
  ])("distinguishes available records with live=$live, errors=$errors", ({ live, errors, text }) => {
    renderBoard({ live, errors, boards: errors["meadow.example"] ? {} : { "meadow.example": board([liveTask()]) }, entry: "/tasks/all?q=absent" });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(/snapshots: listed tasks only/)).toBeInTheDocument();
  });

  it("keeps q with the five filters on initial load and narrows selection and row actions", () => {
    const tasks = [liveTask({ id: "md-1", title: "Retry API: one", assignee: "Ada", labels: ["review"] }),
      liveTask({ id: "md-2", title: "Retry API: two", assignee: "Ada", labels: ["review"] }),
      liveTask({ id: "md-3", title: "Outside search", assignee: "Ada", labels: ["review"] })];
    const entry = "/tasks/all?q=retry+API%3A&project=meadow.example&status=open&priority=normal&label=review&assignee=Ada";
    const { container } = renderBoard({ live: true, boards: { "meadow.example": board(tasks) }, entry });
    expect(screen.getByRole("searchbox", { name: "Search task titles or ids" })).toHaveValue("retry API:");
    expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(2);
    expect(within(open(container, "md-1")).getByRole("button", { name: "Claim" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(container.querySelectorAll("[data-task-select]")).toHaveLength(2);
    expect(container.querySelector('[data-task-select="md-3"]')).toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent(entry.slice(entry.indexOf("?")));
  });
});

it("keeps an asset search pinned despite a conflicting URL project and after Clear filters", () => {
  const { container } = renderScoped("meadow.example", { entry: "/assets/meadow.example/tasks?q=recipe&project=northwind.example" });
  expect(row(container, "md-1w2")).toBeInTheDocument();
  expect(container.querySelector('[data-task-row="nw-1"]')).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search task titles or ids" }), { target: { value: "Northwind" } });
  expect(container.querySelectorAll("tr[data-task-row]")).toHaveLength(0);
  fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
  expect(row(container, "md-1w2")).toBeInTheDocument();
  expect(container.querySelector("[data-tasks-board]")).toHaveAttribute("data-tasks-board", "meadow.example");
  expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
});
