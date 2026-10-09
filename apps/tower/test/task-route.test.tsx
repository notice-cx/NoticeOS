import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTask, LiveTaskDetail, LiveTasksPayload } from "@shared/tasks";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "@shared/tasks";
import { emptyWorkHistory, type WorkItem, type WorkPayload } from "@shared/work";
import { validateDemoViewer } from '@shared/demo-viewer';

// `/tasks/:id` — one bead, whole (D19, bead `ro-l1ed.3`).
//
// What is asserted here is the page's promise: it renders what the hub holds,
// an edit WRITES and the toast's Undo writes the previous value back, a close
// carries its evidence, and the two states that are not a task — an id the hub
// has never heard of, and a deployment with no lane — say so rather than
// spinning or erroring.
//
// The NETWORK is mocked, not the hooks: the real `useTask` / `useUpdateTask` /
// `useCloseTask` run against fake `@/lib/api` functions, so what the test proves
// is the request the page actually makes. Sonner is mocked because the toast is
// not the subject — except for its Undo, which is the subject twice over.

const api = vi.hoisted(() => ({
  fetchTasksCapabilities: vi.fn(),
  fetchTaskProjects: vi.fn(),
  fetchTask: vi.fn(),
  fetchTasks: vi.fn(),
  updateTask: vi.fn(),
  closeTask: vi.fn(),
  commentOnTask: vi.fn(),
  resolveGate: vi.fn(async () => undefined),
  respondToTask: vi.fn(async () => undefined),
  dismissTask: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({ work: null as WorkPayload | null }));
vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({ data: state.work ?? undefined, isPending: false, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-09-04T12:00:00.000Z"),
}));

import { ApiError } from "@/lib/api";
import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { STATE_TONE } from "@/components/StateChip";
import { TaskRoute } from "@/routes/TaskRoute";
import { statusFace } from "@/routes/tasks/task-face";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

const ID = "ro-l1ed.3";

function task(over: Partial<LiveTask> = {}): LiveTask {
  return {
    id: ID,
    title: "A task has a page",
    status: "in_progress",
    priority: 1,
    issueType: "task",
    assignee: "claude/task-page-agent",
    updatedAt: "2026-09-04T11:00:00.000Z",
    closedAt: null,
    parent: "ro-l1ed",
    deferUntil: null,
    description:
      "## What\n\nThe detail page a task index links to.\n\n- the fields\n- the comments\n\nRun `bd show` no more.",
    acceptance: "Renders the fields, the comments and where it came from.",
    labels: ["tower", "tasks"],
    ready: true,
    dependencies: [
      { id: "ro-l1ed", type: "parent-child", title: "The epic", status: "open" },
      { id: "ro-l1ed.1", type: "blocks", title: "A local task lane", status: "closed" },
    ],
    comments: 1,
    metadata: {
      reindex_source: "reindex-handoff",
      reindex_asset: "meals.example",
      reindex_kind: "finding",
      reindex_rule: "traffic-warning",
      reindex_key: "organic-clicks-fell",
    },
    createdAt: "2026-09-04T09:00:00.000Z",
    startedAt: "2026-09-04T10:00:00.000Z",
    closeReason: null,
    awaitType: null,
    ...over,
  };
}

function detail(over: Partial<LiveTaskDetail> = {}): LiveTaskDetail {
  return {
    project: "root-os",
    prefix: "ro",
    repo: ".",
    readAt: "2026-09-04T12:00:00.000Z",
    task: task(),
    comments: [
      {
        id: "c1",
        author: "Example Operator",
        text: "Ship the facts panel first.",
        createdAt: "2026-09-04T10:30:00.000Z",
      },
    ],
    ...over,
  };
}

/** The project's board — where the two facts a single bead's own read cannot
 * carry come from: what it BLOCKS, and the epic's all-time child progress. */
function board(): LiveTasksPayload {
  return {
    project: "root-os",
    prefix: "ro",
    repo: ".",
    readAt: "2026-09-04T12:00:00.000Z",
    tasks: [
      task(),
      task({
        id: "ro-l1ed.4",
        title: "The composer replaces the copied bd create",
        status: "open",
        assignee: null,
        parent: "ro-l1ed",
        metadata: null,
        dependencies: [{ id: ID, type: "blocks", title: null, status: null }],
      }),
    ],
    epics: [
      {
        id: "ro-l1ed",
        title: "Tasks are managed in the Tower",
        status: "open",
        priority: 1,
        total: 5,
        closed: 2,
        eligibleForClose: false,
      },
    ],
  };
}

function snapshotItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: ID,
    title: "A task has a page",
    status: "open",
    priority: 1,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-09-04T11:00:00.000Z",
    closedAt: null,
    parent: "ro-l1ed",
    deferUntil: null,
    ...over,
  };
}

function work(items: WorkItem[] = []): WorkPayload {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    capturedAt: "2026-09-04T11:59:00.000Z",
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects: [
      {
        asset: "root-os",
        prefix: "ro",
        name: "NoticeOS",
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
        history: emptyWorkHistory(),
        priorities: null,
        epics: null,
        ready: items,
        inProgress: [],
        recentlyClosed: [],
        deferred: [],
        waiting: [],
      },
    ],
    historyDays: 0,
  };
}

function renderTask(id = ID, query = '') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${id}${query}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The Undo the toast carried, invoked the way the operator would. */
function pressUndo() {
  const call = toasts.success.mock.calls.at(-1);
  const options = call?.[1] as { action?: { label: string; onClick: () => void } } | undefined;
  expect(options?.action?.label).toBe("Undo");
  options?.action?.onClick();
}

beforeEach(() => {
  state.work = work();
  api.fetchTasksCapabilities.mockResolvedValue({ live: true, reason: null });
  api.fetchTaskProjects.mockResolvedValue([]);
  api.fetchTask.mockResolvedValue(detail());
  api.fetchTasks.mockResolvedValue(board());
  api.updateTask.mockResolvedValue(undefined);
  api.closeTask.mockResolvedValue(undefined);
  api.commentOnTask.mockResolvedValue(undefined);
});

describe('hosted actor labels', () => {
  const principal = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  it('shows current names for immutable assignee/comment IDs and saves the selected ID', async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open', assignee: principal }),
      actors: [{ principalId: principal, displayName: 'Current operator' }, { principalId: other, displayName: 'Another member' }],
      comments: [{ id: 'c1', author: principal, text: 'Observed work', createdAt: '2026-09-04T10:30:00.000Z' }] }));
    renderTask();
    const chooser = await screen.findByRole('combobox', { name: 'Assignee' });
    expect(chooser).toHaveValue(principal);
    expect(screen.getByRole('option', { name: 'Current operator' })).toHaveValue(principal);
    expect(screen.getByText('Comment from Current operator')).toBeInTheDocument();
    expect(screen.queryByText(principal)).not.toBeInTheDocument();
    fireEvent.change(chooser, { target: { value: other } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Assignee' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: other }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { assignee: principal }));
  });
  it('saves a claimed-task handoff without offering an unauthorized Undo', async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'in_progress', assignee: principal }),
      actors: [{ principalId: principal, displayName: 'Current operator' }, { principalId: other, displayName: 'Another member' }] }));
    renderTask();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Assignee' }), { target: { value: other } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Assignee' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved — assignee'));
    expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: other });
    expect(toasts.success.mock.calls.at(-1)?.[1]).toBeUndefined();
  });
  it('uses neutral unavailable labels without disclosing a foreign person or replacing agent names', async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ assignee: principal }), actors: [],
      comments: [{ id: 'c1', author: principal, text: 'Historical work', createdAt: null },
        { id: 'c2', author: 'agent/reviewer', text: 'Checked work', createdAt: null }] }));
    renderTask();
    expect(await screen.findByRole('option', { name: 'Unknown actor' })).toHaveValue(principal);
    expect(screen.getByText('agent/reviewer')).toBeInTheDocument();
    expect(screen.queryByText(principal)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Assignee' })).not.toBeInTheDocument();
  });
});

describe('hosted explicit project selection', () => {
  const project = { projectId: '33333333-3333-4333-8333-333333333333', logicalKey: 'root-os', displayName: 'Root project', prefix: 'ro' };
  function hosted() {
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null, projectSelection: true,
      operations: ['create', 'update', 'comment', 'close'], editableFields: ['title', 'description', 'status', 'priority'] });
    api.fetchTaskProjects.mockResolvedValue([project]);
  }
  it('requires an explicit project instead of guessing ownership from the task prefix', async () => {
    hosted(); renderTask();
    const chooser = await screen.findByRole('combobox', { name: 'Task project' });
    expect(api.fetchTask).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: 'Root project' });
    fireEvent.change(chooser, { target: { value: 'root-os' } });
    expect(await screen.findByText('A task has a page')).toBeInTheDocument();
    expect(api.fetchTask).toHaveBeenCalledWith(ID, expect.any(AbortSignal), 'root-os');
  });
  it('keeps supported edits writable and refuses unsupported controls in the selected project', async () => {
    hosted(); api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open', assignee: null }) }));
    renderTask(ID, '?project=root-os');
    expect(await screen.findByText('A task has a page')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit description' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Claim' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Add a comment' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), { target: { value: 'Observed outcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(api.commentOnTask).toHaveBeenCalledWith(ID, 'Observed outcome', 'root-os'));
  });
  it('binds Claim and advanced field Undo to the explicitly selected project', async () => {
    hosted();
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null, projectSelection: true,
      operations: ['create', 'update', 'comment', 'close'],
      editableFields: ['title', 'description', 'status', 'priority', 'claim', 'assignee', 'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels'] });
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open', assignee: null }) }));
    renderTask(ID, '?project=root-os');
    expect(await screen.findByText('A task has a page')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Claim' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { claim: true }, 'root-os'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit done when' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Done when' }), { target: { value: 'Observed acceptance' } });
    const field = document.querySelector('[data-task-field="Done when"]') as HTMLElement;
    fireEvent.click(within(field).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { acceptance: 'Observed acceptance' }, 'root-os'));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { acceptance: task().acceptance }, 'root-os'));
  });
  it('keeps a gate approval on its captured project through Undo and later selector navigation', async () => {
    hosted();
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null, projectSelection: true,
      operations: ['resolve', 'respond', 'dismiss'] });
    api.fetchTaskProjects.mockResolvedValue([project, { ...project, projectId: '66666666-6666-4666-8666-666666666666', logicalKey: 'other-project', prefix: 'tt', displayName: 'Other project' }]);
    api.fetchTask.mockResolvedValue(detail({ task: task({ issueType: 'gate', awaitType: 'human', labels: ['human'], status: 'open' }) }));
    renderTask(ID, '?project=root-os');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    act(() => pressUndo());act(() => flushAnswers());
    expect(api.resolveGate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Task project' }), { target: { value: 'other-project' } });
    act(() => flushAnswers(true));
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledWith(ID, undefined, { project: 'root-os', keepalive: true }));
    expect(api.closeTask).not.toHaveBeenCalled();expect(api.updateTask).not.toHaveBeenCalled();
  });
  it('sends a hosted human answer with the captured project rather than substituting ordinary closure', async () => {
    hosted();
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null, projectSelection: true,
      operations: ['respond', 'dismiss'] });
    api.fetchTask.mockResolvedValue(detail({ task: task({ labels: ['human'], status: 'open' }) }));
    renderTask(ID, '?project=root-os');
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    const box=screen.getByLabelText(`Your answer to ${ID}`);
    fireEvent.change(box, { target: { value: '--file=literal answer' } });fireEvent.keyDown(box, { key: 'Enter' });
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledWith(ID, '--file=literal answer', { project: 'root-os' }));
    expect(api.closeTask).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetTaskSourceMock();
  resetAnswerQueue();
});

describe('live task details in a read-only demo', () => {
  it('keeps real details and dependency navigation while disabling every task edit', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40),
      scenarioHash: '2'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111',
      cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null }));
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open', assignee: null }) }));
    const view = renderTask();
    expect(await screen.findByText('A task has a page')).toBeInTheDocument();
    await waitFor(() => expect(view.container.querySelector('[data-task-comments]')).not.toBeNull());
    expect(within(view.container.querySelector('[data-task-comments]') as HTMLElement).getByText('Ship the facts panel first.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit description' })).toBeDisabled());
    for (const name of ['Claim', 'Close', 'Comment', 'Save Status', 'Save Priority']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('textbox', { name: 'Add a comment' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Back to tasks' })).toHaveAttribute('href', '/tasks');
    expect(api.fetchTask).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    expect(api.updateTask).not.toHaveBeenCalled(); expect(api.closeTask).not.toHaveBeenCalled();
    expect(api.commentOnTask).not.toHaveBeenCalled(); expect(api.resolveGate).not.toHaveBeenCalled();
    expect(api.respondToTask).not.toHaveBeenCalled(); expect(api.dismissTask).not.toHaveBeenCalled();
  });
});

describe("the core task page before the snapshot hub status answers", () => {
  it("reads the linked task through the live lane without an optional connection", async () => {
    taskSourceMock.connected = null;
    renderTask();
    expect(await screen.findByText("A task has a page")).toBeInTheDocument();
    expect(screen.queryByText("No task source connected")).toBeNull();
  });
});

describe("a task's status looks the same here as on the board (bead ro-ujb9.202)", () => {
  it.each([["closed"], ["in_progress"], ["marinating"]])("draws %s from the board's own status face", async (stored) => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: stored }) }));
    const { container } = renderTask();
    const face = statusFace(stored);
    await screen.findByText("A task has a page");
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    const word = within(header).getByText(face.label);
    expect(word).toHaveAttribute("data-task-status", face.key);
    const chip = word.closest("[data-status-for]") as HTMLElement;
    // The chip's tone is the one the board's State cell inks its word with.
    expect(chip.className).toContain(STATE_TONE[face.tone].chip.split(" ").at(-1)!);
    expect(chip.querySelector(`[data-task-status-glyph="${face.key}"]`)).not.toBeNull();
    // A closed task wears no green on its page either.
    expect(chip.className).not.toContain("healthy");
  });
});

describe("the task page", () => {
  it("renders the bead, its dependencies, its epic and its conversation", async () => {
    const { container } = renderTask();

    expect(await screen.findByText("A task has a page")).toBeInTheDocument();
    // The id is beside the title, not instead of it: it is what a commit quotes.
    expect(screen.getAllByText(ID).length).toBeGreaterThan(0);

    // State is a glyph-led chip in the header, and that chip is the page's ONE
    // display of the fact — which is why the facts panel below carries the
    // control and no second chip beside it (doc 14).
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByText("In progress")).toBeInTheDocument();
    expect(within(header).getByText("high priority")).toBeInTheDocument();
    // Priority is a rank, not a severity (doc 14, bead ro-ujb9.200): the chip
    // leads with the board row's own mark and wears no attention hue.
    const priorityChip = within(header).getByText("high priority").closest("[data-status-for]")!;
    expect(priorityChip.querySelector("[data-priority-mark]")).toHaveAttribute("data-priority-mark", "high");
    expect(priorityChip.className).not.toMatch(/\b(text|bg|border)-(error|warn|info)\b/);

    // Markdown, rendered as structure rather than a wall of asterisks.
    expect(screen.getByRole("heading", { level: 3, name: "What" })).toBeInTheDocument();
    expect(screen.getByText("the fields")).toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toBe("bd show");

    expect(
      screen.getByText("Renders the fields, the comments and where it came from."),
    ).toBeInTheDocument();

    // The project's board is a second read, and the two facts a single bead
    // cannot carry — what it BLOCKS, and the epic's progress — arrive with it.
    await screen.findByText("Blocks");
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    // The project links to its asset page; the type is a plain fact.
    expect(within(facts).getByRole("link", { name: /NoticeOS/ })).toHaveAttribute(
      "href",
      "/assets/root-os",
    );
    expect(within(facts).getByText("task")).toBeInTheDocument();
    expect(within(facts).getByText("tower")).toBeInTheDocument();

    // The blocker it depends on, and the bead it blocks — opposite directions,
    // both linking to their own page.
    expect(within(facts).getByRole("link", { name: /ro-l1ed\.1/ })).toHaveAttribute(
      "href",
      "/tasks/ro-l1ed.1",
    );
    expect(within(facts).getByRole("link", { name: /ro-l1ed\.4/ })).toHaveAttribute(
      "href",
      "/tasks/ro-l1ed.4",
    );
    // A closed blocker is out of the way, and the glyph says so — the board's
    // own status glyph, in its quiet ink (bead ro-ujb9.202).
    const closedBlocker = within(facts).getByLabelText("State — Closed");
    expect(closedBlocker.getAttribute("class")).toContain("text-muted-foreground");

    // The parent epic with its all-time child progress.
    expect(
      within(facts).getByRole("link", { name: "Tasks are managed in the Tower" }),
    ).toHaveAttribute("href", "/tasks/ro-l1ed");
    expect(within(facts).getByRole("progressbar")).toHaveAttribute(
      "aria-label",
      "2 of 5 children closed",
    );
    expect(within(facts).getByText("2 of 5 closed")).toBeInTheDocument();

    // The conversation, and the activity timeline under it.
    const comments = container.querySelector("[data-task-comments]") as HTMLElement;
    expect(within(comments).getByText("Example Operator")).toBeInTheDocument();
    expect(within(comments).getByText("Ship the facts panel first.")).toBeInTheDocument();

    const activity = container.querySelector("[data-task-activity]") as HTMLElement;
    expect(within(activity).getByText("Filed")).toBeInTheDocument();
    expect(
      within(activity).getByText("Claimed by claude/task-page-agent"),
    ).toBeInTheDocument();
    expect(within(activity).getByText("Comment from Example Operator")).toBeInTheDocument();
  });

  // `ro-kukv.12`, doc 17 rule 6. Every place `Age` renders pairs it with a word
  // that needs it — created, updated, an author, an event label — so all four
  // are labelled value slots rather than the dense table cells rule 6 exempts.
  // A bare em-dash after "created" reads as a rendering failure; the phrase
  // reads as the fact. `formatAge` keeps its own dash, untouched.
  it("names an absent age in words rather than drawing a dash", async () => {
    api.fetchTask.mockResolvedValue(
      detail({
        task: task({ createdAt: null, updatedAt: null }),
        comments: [{ id: "c1", author: "Example Operator", text: "No time on this.", createdAt: null }],
      }),
    );
    const { container } = renderTask();
    await screen.findByText("A task has a page");

    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    expect(within(facts).getByText(/^created/)).toHaveTextContent(
      "created at an unknown time",
    );
    expect(within(facts).getByText(/^updated/)).toHaveTextContent(
      "updated at an unknown time",
    );
    expect(facts.textContent).not.toContain("—");

    // One phrase, and the TITLE says which absence it is: neither of these is
    // "never" — the task was created and the comment was written; the hub
    // simply recorded no time.
    for (const slot of container.querySelectorAll('[data-age="missing"]')) {
      expect(slot.getAttribute("title")).toBe("No time is recorded for this");
    }
    expect(container.querySelectorAll('[data-age="missing"]').length).toBeGreaterThanOrEqual(3);
  });

  it("tells an unreadable timestamp apart from one that was never recorded", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ createdAt: "not-a-date" }) }));
    const { container } = renderTask();
    await screen.findByText("A task has a page");

    const unreadable = container.querySelector('[data-age="unreadable"]');
    expect(unreadable?.textContent).toBe("at an unknown time");
    expect(unreadable?.getAttribute("title")).toBe(
      "The stored timestamp could not be read",
    );
  });

  it("links a handoff task back to the section of the asset page that raised it", async () => {
    const { container } = renderTask();
    const facts = (await screen.findByText("Came from")).closest(
      "[data-task-facts]",
    ) as HTMLElement;
    expect(facts).not.toBeNull();

    const back = within(facts).getByRole("link", { name: "the findings on meals.example" });
    expect(back).toHaveAttribute("href", "/assets/meals.example#insights");
    // The join key travels byte-exact, which is the whole point of the grammar.
    expect(within(facts).getByText(/organic-clicks-fell/)).toBeInTheDocument();
    expect(container.textContent).toContain("traffic-warning");
  });

  // The fixture above is a bead filed BEFORE the NoticeOS rename (reindex_*
  // metadata, the reindex-handoff label); this is one filed after it. Both link
  // back the same way (bead ro-ujb9.77.4).
  it("links a handoff filed under the NoticeOS names back the same way", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({
      labels: ["noticeos-handoff"],
      metadata: {
        noticeos_source: "noticeos-handoff",
        noticeos_asset: "meals.example",
        noticeos_kind: "query",
        noticeos_rule: "recover",
        noticeos_key: "meal plan, weekly",
      },
    }) }));
    const { container } = renderTask();
    const facts = (await screen.findByText("Came from")).closest("[data-task-facts]") as HTMLElement;
    const back = within(facts).getByRole("link", { name: "the query decisions on meals.example" });
    expect(back).toHaveAttribute("href", "/assets/meals.example#query-visibility");
    expect(within(facts).getByText(/meal plan, weekly/)).toBeInTheDocument();
    expect(container.textContent).toContain("recover");
  });

  it("says nothing about an origin when the bead carries no handoff metadata", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ metadata: null }) }));
    renderTask();
    await screen.findByText("A task has a page");
    expect(screen.queryByText("Came from")).toBeNull();
  });

  it("saves an edit through updateTask, and the toast's Undo writes the previous value back", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open' }) }));
    renderTask();

    const assignee = (await screen.findByLabelText("Assignee")) as HTMLInputElement;
    expect(assignee.value).toBe("claude/task-page-agent");
    fireEvent.change(assignee, { target: { value: "operator" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Assignee" }));

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: "operator" }),
    );
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());

    pressUndo();
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenLastCalledWith(ID, {
        assignee: "claude/task-page-agent",
      }),
    );
  });

  it("saves the priority as a number and undoes it to the band it came from", async () => {
    renderTask();

    const priority = (await screen.findByLabelText("Priority")) as HTMLSelectElement;
    fireEvent.change(priority, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Priority" }));

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { priority: 0 }));
    pressUndo();
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenLastCalledWith(ID, { priority: 1 }),
    );
  });

  it("adds and removes a label, each undone by its opposite", async () => {
    renderTask();

    fireEvent.change(await screen.findByLabelText("Add a label"), {
      target: { value: "saas" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { addLabels: ["saas"] }),
    );
    pressUndo();
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenLastCalledWith(ID, { removeLabels: ["saas"] }),
    );

    api.updateTask.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Remove label tower" }));
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { removeLabels: ["tower"] }),
    );
  });

  it("offers an empty description as a field to fill, not a command to run", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ description: "", acceptance: "" }) }));
    renderTask();
    await screen.findByText("A task has a page");

    // Bead ro-ujb9.96.6.11: no sentence quoting `bd update --description`.
    expect(document.body.textContent).not.toContain("--description");
    fireEvent.click(screen.getByRole("button", { name: /Add a description/ }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "What, why, where." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { description: "What, why, where." }),
    );
    // The same way back every field has.
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { description: "" }));
    expect(screen.getByRole("button", { name: /Add when it is done/ })).toBeInTheDocument();
  });

  it("edits a written description in place and can cancel without a write", async () => {
    renderTask();
    await screen.findByText("A task has a page");
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const box = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(box.value).toContain("What");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("will not close without a reason, and closes with one", async () => {
    renderTask();
    // The header renders before the lane has answered, and until it does the
    // actions are the refused ones — so wait for the live bead rather than
    // clicking a Close that is still disabled.
    await screen.findByText("A task has a page");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const confirm = screen.getByRole("button", { name: "Close task" });
    // The field's label asks for what closes it; no footnote under the buttons.
    expect(screen.getByText("What shipped, and the commit")).toBeInTheDocument();
    expect(screen.queryByText(/Closing records a decision/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Closed means shipped/)).not.toBeInTheDocument();
    // Completion is evidence: the button that writes stays disabled until there
    // is something to write.
    expect(confirm).toBeDisabled();
    expect(api.closeTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Close reason"), {
      target: { value: "Landed in 1a2b3c4 — the page renders the fields." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    await waitFor(() =>
      expect(api.closeTask).toHaveBeenCalledWith(
        ID,
        "Landed in 1a2b3c4 — the page renders the fields.",
      ),
    );
  });

  it("sends a comment through commentOnTask", async () => {
    renderTask();

    fireEvent.change(await screen.findByLabelText("Add a comment"), {
      target: { value: "Blocked on the lane landing first." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(api.commentOnTask).toHaveBeenCalledWith(
        ID,
        "Blocked on the lane landing first.",
      ),
    );
  });

  it("offers Claim on an open, unclaimed bead", async () => {
    api.fetchTask.mockResolvedValue(
      detail({ task: task({ status: "open", assignee: null, startedAt: null }) }),
    );
    renderTask();
    expect(await screen.findByRole("button", { name: "Claim" })).toBeEnabled();
  });

  it("does not offer Claim on work somebody already has", async () => {
    renderTask();
    await screen.findByText("A task has a page");
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
  });

  it("says so, and links back, when the hub has never heard of the id", async () => {
    api.fetchTask.mockRejectedValue(new ApiError("root-os has no bead ro-nope", 404, "unknown_task"));
    renderTask("ro-nope");

    expect(await screen.findByText("No task with this id")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to tasks" })).toHaveAttribute(
      "href",
      "/tasks",
    );
  });

  it("shows what the local read said when it refuses for any other reason", async () => {
    api.fetchTask.mockRejectedValue(
      new ApiError("bd: show is unhappy about something", 502, "bd_failed"),
    );
    renderTask();

    expect(await screen.findByText("The task database could not answer")).toBeInTheDocument();
    expect(screen.getByText("bd: show is unhappy about something")).toBeInTheDocument();
  });

  it("falls back to the snapshot's row where there is no lane, under one Read-only banner", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({
      live: false,
      reason: READ_ONLY_DEPLOYMENT,
    });
    state.work = work([snapshotItem()]);
    renderTask();

    // The header still identifies the task from the photograph.
    expect(await screen.findByText("A task has a page")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    // What happened, then what to do — one banner, not two paragraphs.
    expect(screen.getByText("Read-only snapshot")).toBeInTheDocument();
    expect(document.querySelector("[data-task-readonly] [role=status]")).toHaveTextContent(READ_ONLY_TASKS_HINT);
    expect(document.querySelector("[data-owner-chip]")).toBeNull();

    // The two primary actions are present and refused, with what to do on them.
    const claim = screen.getByRole("button", { name: "Claim" });
    expect(claim).toBeDisabled();
    expect(claim).toHaveAttribute("title", READ_ONLY_TASKS_HINT);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    // And nothing pretends the live read happened.
    expect(api.fetchTask).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Add a comment")).toBeNull();
  });

  it("says the snapshot does not carry the id, and opens the board that could", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({
      live: false,
      reason: READ_ONLY_DEPLOYMENT,
    });
    state.work = work();
    renderTask();

    expect(await screen.findByText("Not in the saved snapshot")).toBeInTheDocument();
    const door = screen.getByRole("link", { name: /tasks →$/ });
    expect(door.getAttribute("href")).toMatch(/^\/tasks\?project=/);
  });
});

// A task waiting on the operator offers the verbs its inbox row offers, from
// the same definition (routes/tasks/ask-actions, bead ro-ujb9.243): Claim and
// Close were the wrong commands for a gate or an ask.
describe("a waiting task's page offers what its inbox row offers (bead ro-ujb9.243)", () => {
  const gate = () => task({ issueType: "gate", awaitType: "human", status: "open", assignee: null, labels: ["human"], startedAt: null });
  const ask = () => task({ status: "open", assignee: null, labels: ["human"], ready: true, startedAt: null });
  const header = () => within(document.querySelector<HTMLElement>("[data-page-header]")!);
  const headerButtons = () => header().getAllByRole("button").map((button) => button.textContent?.trim());

  it("gives a human gate one action, Approve, which resolves the gate after the Undo window", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: gate() }));
    renderTask();

    const approve = await header().findByRole("button", { name: "Approve" });
    expect(headerButtons()).toEqual(["Approve"]);
    fireEvent.click(approve);
    // The inbox's own path: the toast names it with Undo, and the verb leaves.
    expect(toasts.success).toHaveBeenCalledWith("Approved", expect.objectContaining({ description: "A task has a page" }));
    expect(header().queryByRole("button", { name: "Approve" })).toBeNull();
    expect(api.resolveGate).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.resolveGate).toHaveBeenCalledWith(ID));
    expect(api.closeTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("takes an approval back with the toast's Undo, and offers Approve again", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: gate() }));
    renderTask();

    fireEvent.click(await header().findByRole("button", { name: "Approve" }));
    act(() => pressUndo());
    expect(await header().findByRole("button", { name: "Approve" })).toBeEnabled();
    act(() => flushAnswers());
    expect(api.resolveGate).not.toHaveBeenCalled();
  });

  it("gives an ask Answer and Dismiss, and the answer box sends through the inbox's call", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: ask() }));
    renderTask();

    fireEvent.click(await header().findByRole("button", { name: "Answer" }));
    expect(headerButtons().slice(0, 2)).toEqual(["Answer", "Dismiss"]);
    expect(header().queryByRole("button", { name: "Claim" })).toBeNull();
    expect(header().queryByRole("button", { name: "Close" })).toBeNull();
    const box = header().getByLabelText(`Your answer to ${ID}`);
    fireEvent.change(box, { target: { value: "Ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toasts.success).toHaveBeenCalledWith("Answered", expect.anything());
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledWith(ID, "Ship it"));
  });

  it("dismisses an ask through the inbox's call", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: ask() }));
    renderTask();

    fireEvent.click(await header().findByRole("button", { name: "Dismiss" }));
    act(() => flushAnswers());
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledWith(ID));
  });

  it("keeps Claim and Close for an ordinary task", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, startedAt: null }) }));
    renderTask();

    await header().findByRole("button", { name: "Claim" });
    expect(headerButtons()).toEqual(["Claim", "Close"]);
  });

  it("reads a gate from the snapshot's waiting list where there is no lane, and refuses Approve with what to do", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    const snapshot = work();
    snapshot.projects[0]!.waiting = [snapshotItem({ issueType: "gate" })];
    state.work = snapshot;
    renderTask();

    const approve = await header().findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("title", READ_ONLY_TASKS_HINT);
    expect(headerButtons()).toEqual(["Approve"]);
  });
});
