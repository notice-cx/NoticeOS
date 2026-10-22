import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTask, LiveTaskDetail, LiveTasksPayload } from "@shared/tasks";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "@shared/tasks";
import type { WallPayload } from "@shared/wall";
import { emptyWorkHistory, type WorkEpic, type WorkItem, type WorkPayload } from "@shared/work";
import { DEMO_READ_ONLY, validateDemoViewer } from '@shared/demo-viewer';
import type { TaskChoices } from "@noticeos/contract/task-choices";

// `/tasks/:id`, one task whole. The network is mocked, not the hooks: the real
// `useTask` / `useUpdateTask` / `useCloseTask` run against fake `@/lib/api`
// functions. Sonner is mocked because the toast is not the subject, except for
// its Undo.

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
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
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
      reindex_asset: "meadow.example",
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

/** The project's board, where the two facts a single task's own read cannot
 * carry come from: what it blocks, and the epic's all-time child progress. */
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
        name: "System",
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

/** `client` is the desk's query cache, for a case about what it already holds. */
function renderTask(id = ID, query = '', state?: { returnTo: string }, client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
})) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: `/tasks/${id}`, search: query, state }]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Opens a fact's editor by the chip's name ("Status: In progress"). */
async function openFact(name: string | RegExp): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
}

/** The page's header band, where a close's summary and the actions sit. */
function headerBand(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-page-header]")!;
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
    const editor = await openFact('Assignee: Current operator');
    expect(within(editor).getByRole('option', { name: 'Current operator' })).toHaveAttribute('data-value', principal);
    expect(within(editor).getByRole('option', { name: 'Current operator' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-entry="comment"] [data-entry-label]')).toHaveTextContent('Comment from Current operator');
    expect(screen.queryByText(principal)).not.toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('option', { name: 'Another member' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: other }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { assignee: principal }));
  });
  it('saves a claimed-task handoff without offering an unauthorized Undo', async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'in_progress', assignee: principal }),
      actors: [{ principalId: principal, displayName: 'Current operator' }, { principalId: other, displayName: 'Another member' }] }));
    renderTask();
    const editor = await openFact('Assignee: Current operator');
    fireEvent.click(within(editor).getByRole('option', { name: 'Another member' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved — assignee'));
    expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: other });
    expect(toasts.success.mock.calls.at(-1)?.[1]).toBeUndefined();
  });
  it('uses neutral unavailable labels without disclosing a foreign person or replacing agent names', async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ assignee: principal }), actors: [],
      comments: [{ id: 'c1', author: principal, text: 'Historical work', createdAt: null },
        { id: 'c2', author: 'agent/reviewer', text: 'Checked work', createdAt: null }] }));
    renderTask();
    const editor = await openFact('Assignee: Unknown actor');
    expect(within(editor).getByRole('option', { name: 'Unknown actor' })).toHaveAttribute('data-value', principal);
    expect(screen.getByText('agent/reviewer')).toBeInTheDocument();
    expect(screen.queryByText(principal)).not.toBeInTheDocument();
    // A hosted workspace's members are the whole list: no typed name.
    expect(within(editor).queryByRole('textbox')).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Status: Open' })).toBeEnabled();
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
    await waitFor(() => expect(view.container.querySelector('[data-task-activity]')).not.toBeNull());
    expect(within(view.container.querySelector('[data-task-activity]') as HTMLElement).getByText('Ship the facts panel first.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit description' })).toBeDisabled());
    for (const name of ['Claim', 'Close', 'Comment']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('textbox', { name: 'Add a comment' })).toBeDisabled();
    // Without write permission each fact is its plain chip: nothing to press.
    const facts = view.container.querySelector('[data-task-facts]') as HTMLElement;
    expect(within(facts).queryByRole('button', { name: /^(Status|Priority|Assignee|Parked until|Add a label|Change parent epic)/ })).toBeNull();
    expect(within(facts).queryByRole('button', { name: /^Remove label/ })).toBeNull();
    expect(within(facts).getByText('Open').closest('[data-fact-chip]')).toHaveAttribute('data-fact-chip', 'plain');
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(api.fetchTask).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    expect(api.updateTask).not.toHaveBeenCalled(); expect(api.closeTask).not.toHaveBeenCalled();
    expect(api.commentOnTask).not.toHaveBeenCalled(); expect(api.resolveGate).not.toHaveBeenCalled();
    expect(api.respondToTask).not.toHaveBeenCalled(); expect(api.dismissTask).not.toHaveBeenCalled();
  });
});

// A hint over Claim or Close hides the page's one job. The header carries no
// hover title at all, and a disabled action says why in text beside it.
describe("no hint covers the header's actions", () => {
  const header = () => document.querySelector<HTMLElement>("[data-page-header]")!;
  const actions = () => header().querySelector<HTMLElement>("[data-task-actions]")!;

  it("opens no hint over Claim or Close, and the header holds no hover title", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, startedAt: null }) }));
    renderTask();
    const claim = await screen.findByRole("button", { name: "Claim" });
    const close = screen.getByRole("button", { name: "Close" });
    for (const node of [claim, close, ...header().querySelectorAll("[data-status-for]")]) {
      fireEvent.pointerEnter(node);
      fireEvent.mouseOver(node);
      fireEvent.focus(node);
    }
    expect(document.querySelector("[role=tooltip]")).toBeNull();
    expect([...header().querySelectorAll("[title]")].map((node) => node.getAttribute("title"))).toEqual([]);
    expect(actions()).toContainElement(claim);
    expect(actions()).toContainElement(close);
    expect(actions().querySelector("[data-action-reason]")).toBeNull();
  });

  it("writes a disabled Claim's reason as visible text beside it in a read-only demo", async () => {
    vi.stubGlobal('__DEMO_VIEWER__', validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40),
      scenarioHash: '2'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111',
      cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null }));
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, startedAt: null }) }));
    renderTask();
    await screen.findByText("A task has a page");
    const claim = await within(header()).findByRole("button", { name: "Claim" });
    await waitFor(() => expect(claim).toBeDisabled());
    const reason = actions().querySelector("[data-action-reason]") as HTMLElement;
    expect(reason).toHaveTextContent(DEMO_READ_ONLY);
    expect(reason).toBeVisible();
    expect(reason.className).not.toContain("sr-only");
    expect(claim).not.toHaveAttribute("title");
    expect(claim).toHaveAccessibleDescription(DEMO_READ_ONLY);
    expect(screen.getByRole("button", { name: "Close" })).toHaveAccessibleDescription(DEMO_READ_ONLY);
  });

  it("names a workspace that cannot claim as the reason, in text", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null,
      operations: ["update", "comment", "close"], editableFields: ["status", "priority"] });
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, startedAt: null }) }));
    renderTask();
    const claim = await within(header()).findByRole("button", { name: "Claim" });
    await waitFor(() => expect(claim).toBeDisabled());
    expect(actions().querySelector("[data-action-reason]")).toHaveTextContent("Unavailable in this workspace.");
    expect(claim).toHaveAccessibleDescription("Unavailable in this workspace.");
    // Close can still run, so it names no reason.
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveAccessibleDescription();
  });
});

// The description reads as the task guide's labelled sections, its paths and
// task ids as chips; Done when reads as a checklist; activity is in time order.
describe("the work reads as labelled sections, and what happened as a timeline", () => {
  const guide = [
    "WHAT: The page draws the facts.",
    "",
    "WHY: Read dozens of times a day.",
    "",
    "WHERE: apps/tower/src/routes/TaskRoute.tsx:191 and docs/tower/tasks.md; after ro-l1ed.4 lands.",
    "",
    "## Steps to Reproduce",
    "1. Open a task",
    "2. Look at the facts",
  ].join("\n");

  it("draws each label as its section's eyebrow, paths as chips and a task id as a link", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ description: guide, acceptance: "- Facts render\n- Undo works" }) }));
    const { container } = renderTask();
    await screen.findByText("The page draws the facts.");
    const sections = [...container.querySelectorAll("[data-guide-section]")].map((section) => section.getAttribute("data-guide-section"));
    expect(sections).toEqual(["What", "Why", "Where", "Steps to reproduce"]);
    const where = container.querySelector('[data-guide-section="Where"]') as HTMLElement;
    expect(within(where).getByRole("heading", { level: 3, name: "Where" })).toBeInTheDocument();
    expect([...where.querySelectorAll("[data-path-ref]")].map((chip) => chip.textContent))
      .toEqual(["apps/tower/src/routes/TaskRoute.tsx:191", "docs/tower/tasks.md"]);
    // The project has no web address for its repository, so a path is a chip, not a link.
    expect(where.querySelector("a[data-path-ref]")).toBeNull();
    expect(within(where).getByRole("link", { name: "ro-l1ed.4" })).toHaveAttribute("href", "/tasks/ro-l1ed.4");
    const steps = container.querySelector('[data-guide-section="Steps to reproduce"]') as HTMLElement;
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Open a task", "Look at the facts"]);
    const done = container.querySelector('[data-task-field="Done when"] [data-checklist]') as HTMLElement;
    expect(within(done).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Facts render", "Undo works"]);
  });

  it("reads a description without the guide's labels as it was written", async () => {
    const { container } = renderTask();
    await screen.findByText("the fields");
    expect(container.querySelector("[data-guide-sections]")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "What" })).toBeInTheDocument();
  });

  it("orders filing, the claim, comments and the close by time, comments inline", async () => {
    api.fetchTask.mockResolvedValue(detail({
      task: task({ status: "closed", closedAt: "2026-09-04T11:30:00Z", closeReason: "Done · abc1234",
        metadata: { noticeos_closed_by: "claude", noticeos_closed_at: "2026-09-04T11:30:00Z" } }),
      comments: [
        { id: "late", author: "Example Operator", text: "After the claim.", createdAt: "2026-09-04T10:45:00.000Z" },
        { id: "early", author: "Example Operator", text: "Before the claim.", createdAt: "2026-09-04T09:30:00.000Z" },
      ],
    }));
    const { container } = renderTask();
    await waitFor(() => expect(container.querySelector('[data-entry="closed"]')).not.toBeNull());
    const activity = container.querySelector("[data-task-activity]") as HTMLElement;
    expect([...activity.querySelectorAll("[data-entry-id]")].map((entry) => entry.getAttribute("data-entry-id")))
      .toEqual(["filed", "comment-early", "claimed", "comment-late", "closed"]);
    // The strip above draws the same moments on a time axis that ends at now.
    const strip = container.querySelector("[data-task-timeline] [data-event-timeline]") as HTMLElement;
    expect(strip).toHaveAttribute("data-compact", "true");
    expect(strip.querySelectorAll("[data-event], [data-event-cluster]").length).toBeGreaterThan(0);
    // The comment box is the timeline's last item.
    const last = activity.lastElementChild as HTMLElement;
    expect(last).toHaveAttribute("data-task-timeline-composer");
    expect(within(last).getByRole("textbox", { name: "Add a comment" })).toBeInTheDocument();
  });
});

// Each type has its own mark and header band; every control answers a hover,
// a press and focus; the page's motion is the Wall's, and stops under reduced
// motion.
describe("the page carries its type's identity and the Wall's states", () => {
  const header = () => document.querySelector<HTMLElement>("[data-page-header]")!;
  const band = () => document.querySelector<HTMLElement>("[data-task-band]")!;

  it.each([
    ["epic", null, "Epic"],
    ["task", null, "Task"],
    ["bug", null, "Bug"],
    ["feature", null, "Feature"],
    ["chore", null, "Chore"],
    ["decision", null, "Decision"],
    ["gate", "human", "Approval"],
  ])("draws a %s's word and mark in its header", async (issueType, awaitType, word) => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ issueType, awaitType, status: "open", assignee: null, startedAt: null, labels: issueType === "gate" ? ["human"] : [] }) }));
    renderTask();
    await screen.findByText("A task has a page");
    expect(within(header()).getByText(word)).toHaveAttribute("data-task-type", issueType);
    const mark = header().querySelector(`[data-task-type-mark="${issueType}"]`) as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.querySelector("svg")).not.toBeNull();
    // A type is not a state: only an open bug wears the alert surface.
    expect(band()).toHaveAttribute("data-surface-kind", issueType === "bug" ? "alert" : "neutral");
    expect(mark.className).toMatch(issueType === "bug" ? /\btext-error\b/ : /\btext-foreground\b/);
  });

  it("draws a closed bug's band and mark in plain ink, never green", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ issueType: "bug", status: "closed", closedAt: "2026-09-04T11:30:00Z" }) }));
    renderTask();
    await screen.findByText("A task has a page");
    expect(band()).toHaveAttribute("data-surface-kind", "neutral");
    const mark = header().querySelector('[data-task-type-mark="bug"]') as HTMLElement;
    expect(mark.className).not.toMatch(/error|healthy|milestone|success/);
  });

  it("gives every link and button on the page a hover and a focus state, and every button a press", async () => {
    const { container } = renderTask();
    await waitFor(() => expect(container.querySelector("[data-dependency-graph]")).not.toBeNull());
    const page = container.querySelector("[data-task-page]") as HTMLElement;
    expect(page.className).toContain("motion-safe:[&_button:not(:disabled):active]:translate-y-px");
    const controls = [...page.querySelectorAll<HTMLElement>("a, button")].filter((node) => !node.closest("[data-event-timeline]"));
    expect(controls.length).toBeGreaterThan(10);
    for (const node of controls) {
      const name = `${node.tagName} ${node.textContent?.trim() || node.getAttribute("aria-label")}`;
      expect(node.className, name).toMatch(/hover:/);
      // Focus is either drawn as a ring or left to the browser's own outline.
      expect(/focus-visible:/.test(node.className) || !/outline-none/.test(node.className), name).toBe(true);
    }
  });

  it("moves only with the Wall's motion, all of which stops under reduced motion", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const stilled = reduced.slice(0, reduced.indexOf("}", reduced.indexOf(".viz-draw,")));
    const { container } = renderTask();
    await waitFor(() => expect(container.querySelector("[data-epic-segments]")).not.toBeNull());
    const classes = new Set([...container.querySelectorAll<HTMLElement | SVGElement>("*")]
      .flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/)));
    const motion = [...classes].filter((name) => /^viz-(arrive|breathe|grow-x|grow-y|draw|flow)$/.test(name));
    // The page's entrance, the bar growing, a live edge's flow and the
    // holder's slow ring for work still under way.
    expect(motion).toEqual(expect.arrayContaining(["viz-arrive", "viz-grow-y", "viz-breathe"]));
    for (const name of motion) expect(stilled, name).toContain(`.${name}`);
    // Any other animation runs only where motion is allowed.
    for (const name of classes) if (/animate-/.test(name)) expect(name, name).toMatch(/^motion-safe:/);
  });
});

// A row is one target: the whole row is the link, named by its id and title.
// Blocked by and Blocks are the dependency graph's cards, one target each.
describe("every task row opens its task from anywhere on the row", () => {
  it("opens a dependency from a press anywhere on its card, and names the card by its id and title", async () => {
    renderTask();
    const card = await screen.findByRole("link", { name: "ro-l1ed.4 The composer replaces the copied bd create" });
    expect(card).toHaveAttribute("href", "/tasks/ro-l1ed.4");
    expect(card).toHaveAttribute("data-dependency", "ro-l1ed.4");
    // The card's whole content sits inside the one link: the glyph, the id and
    // the title, with no second link inside it.
    expect(card.querySelectorAll("a")).toHaveLength(0);
    expect(card).toContainElement(card.querySelector("[data-task-status-glyph]") as HTMLElement);
    expect(card).toHaveAccessibleDescription("Open, high priority");
    fireEvent.click(within(card).getByText("The composer replaces the copied bd create"));
    await waitFor(() => expect(api.fetchTask).toHaveBeenLastCalledWith("ro-l1ed.4", expect.any(AbortSignal)));
  });

  it("opens a row with Enter once it has focus, the way a link activates", async () => {
    renderTask();
    const row = await screen.findByRole("link", { name: "ro-l1ed.1 A local task lane" });
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(row.tagName).toBe("A");
    expect(row).not.toHaveAttribute("tabindex");
    // A browser turns Enter on a focused link into its click.
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.click(row);
    await waitFor(() => expect(api.fetchTask).toHaveBeenLastCalledWith("ro-l1ed.1", expect.any(AbortSignal)));
  });

  it("opens an epic's task from a press on its holder", async () => {
    const EPIC = "ro-l1ed";
    api.fetchTask.mockResolvedValue(detail({ task: task({ id: EPIC, title: "Tasks are managed in the Tower", issueType: "epic", parent: null,
      status: "open", assignee: null, startedAt: null, dependencies: [], metadata: null }), comments: [] }));
    const { container } = renderTask(EPIC);
    await waitFor(() => expect(container.querySelector(`[data-epic-task="${ID}"]`)).not.toBeNull());
    const item = container.querySelector(`[data-epic-task="${ID}"]`) as HTMLElement;
    const row = within(item).getByRole("link", { name: `${ID} A task has a page` });
    const holder = within(row).getByText("claude/task-page-agent");
    fireEvent.click(holder);
    await waitFor(() => expect(api.fetchTask).toHaveBeenLastCalledWith(ID, expect.any(AbortSignal)));
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

describe("a task's status looks the same here as on the board", () => {
  it.each([["closed"], ["in_progress"], ["marinating"]])("draws %s from the board's own status face", async (stored) => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: stored }) }));
    const { container } = renderTask();
    const face = statusFace(stored);
    await screen.findByText("A task has a page");
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    const word = within(header).getByText(face.label);
    expect(word).toHaveAttribute("data-task-status", face.key);
    const chip = word.closest("[data-status-for]") as HTMLElement;
    expect(chip.className).toContain(STATE_TONE[face.tone].chip.split(" ").at(-1)!);
    expect(chip.querySelector(`[data-task-status-glyph="${face.key}"]`)).not.toBeNull();
    expect(chip.className).not.toContain("healthy");
  });
});

describe("the task page", () => {
  it("draws the project's asset icon for the theme, from the card in the Wall read the desk holds", async () => {
    const light = "https://www.example.com/brand/icon-32.png";
    const dark = "https://www.example.com/brand/icon-32-dark.png";
    const desk = () => {
      // The shell's own observer keeps the read; here nothing does, so it is
      // kept by the default collection time rather than this file's zero.
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const card = { id: "root-os", displayName: "System", icons: { light, dark, readAt: null, outcome: null } };
      client.setQueryData(["wall"], { assets: [card] } as unknown as WallPayload);
      return client;
    };
    const requests = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", requests);
    const chip = async () => {
      const facts = (await screen.findByText("Came from")).closest("[data-task-facts]") as HTMLElement;
      return within(facts).getByRole("link", { name: /System/ }).querySelector("[data-property-favicon] img");
    };
    try {
      const onDark = renderTask(ID, "", undefined, desk());
      expect(await chip()).toHaveAttribute("src", dark);
      onDark.unmount();
      document.documentElement.classList.add("light");
      renderTask(ID, "", undefined, desk());
      expect(await chip()).toHaveAttribute("src", light);
      expect(requests.mock.calls.filter(([input]) => String(input).startsWith("/api/wall"))).toEqual([]);
    } finally {
      document.documentElement.classList.remove("light");
      vi.unstubAllGlobals();
    }
  });

  it("renders the task, its dependencies, its epic and its conversation", async () => {
    const { container } = renderTask();

    expect(await screen.findByText("A task has a page")).toBeInTheDocument();
    expect(screen.getAllByText(ID).length).toBeGreaterThan(0);

    // The state chip in the header is the page's one display of the fact, so
    // the facts panel below carries the control and no second chip.
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByText("In progress")).toBeInTheDocument();
    expect(within(header).getByText("high priority")).toBeInTheDocument();
    // Priority is a rank, not a severity: the chip wears no attention hue.
    const priorityChip = within(header).getByText("high priority").closest("[data-status-for]")!;
    expect(priorityChip.querySelector("[data-priority-mark]")).toHaveAttribute("data-priority-mark", "high");
    expect(priorityChip.className).not.toMatch(/\b(text|bg|border)-(error|warn|info)\b/);

    expect(screen.getByRole("heading", { level: 3, name: "What" })).toBeInTheDocument();
    expect(screen.getByText("the fields")).toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toBe("bd show");

    expect(
      screen.getByText("Renders the fields, the comments and where it came from."),
    ).toBeInTheDocument();

    await screen.findByText("Blocks");
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    expect(within(facts).getByRole("link", { name: /System/ })).toHaveAttribute(
      "href",
      "/assets/root-os",
    );
    // The type is a word in the header, beside the id.
    expect(within(header).getByText("Task")).toHaveAttribute("data-task-type", "task");
    expect(within(facts).getByText("tower")).toBeInTheDocument();

    // Who blocks whom is one graph: blockers left, what this blocks right.
    const graph = container.querySelector("[data-dependency-graph]") as HTMLElement;
    expect(within(graph).getByRole("link", { name: /ro-l1ed\.1/ })).toHaveAttribute(
      "href",
      "/tasks/ro-l1ed.1",
    );
    expect(within(graph).getByRole("link", { name: /ro-l1ed\.4/ })).toHaveAttribute(
      "href",
      "/tasks/ro-l1ed.4",
    );
    expect(graph.querySelector('[data-dependency-column="before"] [data-dependency="ro-l1ed.1"]')).not.toBeNull();
    expect(graph.querySelector('[data-dependency-column="after"] [data-dependency="ro-l1ed.4"]')).not.toBeNull();
    const closedBlocker = within(graph).getByLabelText("State — Closed");
    expect(closedBlocker.getAttribute("class")).toContain("text-muted-foreground");

    expect(
      within(facts).getByRole("link", { name: "Tasks are managed in the Tower" }),
    ).toHaveAttribute("href", "/tasks/ro-l1ed");
    expect(within(facts).getByRole("progressbar")).toHaveAttribute(
      "aria-label",
      "2 of 5 children closed",
    );
    expect(within(facts).getByText("2 of 5 closed")).toBeInTheDocument();

    // Comments sit in the activity timeline at their time, after the claim.
    const activity = container.querySelector("[data-task-activity]") as HTMLElement;
    const entries = [...activity.querySelectorAll("[data-entry]")].map((entry) => entry.getAttribute("data-entry"));
    expect(entries).toEqual(["filed", "claimed", "comment"]);
    const comment = activity.querySelector('[data-entry="comment"]') as HTMLElement;
    expect(within(comment).getByText("Example Operator")).toBeInTheDocument();
    expect(within(comment).getByText("Ship the facts panel first.")).toBeInTheDocument();
    expect(comment.querySelector("[data-entry-label]")).toHaveTextContent("Comment from Example Operator");
    expect(within(activity).getByText("Filed")).toBeInTheDocument();
    expect(activity.querySelector('[data-entry="claimed"] [data-entry-label]')).toHaveTextContent("Claimed by claude/task-page-agent");
  });

  it("names who claimed and who closed it, with the models they named", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({
      status: "closed", assignee: "claude", closedAt: "2026-09-04T11:30:00Z", closeReason: "Facts render · abc1234",
      metadata: { noticeos_claimed_model: "Opus 5.5", noticeos_closed_by: "claude", noticeos_closed_model: "Opus 5.5",
        noticeos_closed_at: "2026-09-04T11:30:00Z" },
    }) }));
    const { container } = renderTask();
    await waitFor(() => expect(container.querySelector('[data-entry="closed"]')).not.toBeNull());
    const activity = container.querySelector("[data-task-activity]") as HTMLElement;
    const closed = activity.querySelector('[data-entry="closed"]') as HTMLElement;
    expect(closed.querySelector("[data-entry-label]")).toHaveTextContent("Closed by claude · Opus 5.5");
    expect(activity.querySelector('[data-entry="claimed"] [data-entry-label]')).toHaveTextContent("Claimed by claude · Opus 5.5");
    // The agent's own mark, as the Wall's feed draws it.
    expect(closed.querySelector("[data-entry-agent]")).toHaveAttribute("data-entry-agent", "anthropic");
    // The reason's sentence, and its commit as a chip.
    expect(within(closed).getByText("Facts render")).toBeInTheDocument();
    expect(within(closed.querySelector("[data-entry-evidence]") as HTMLElement).getByText("abc1234")).toHaveClass("font-mono");
  });

  // Every place `Age` renders pairs it with a word that needs it, so a bare
  // em-dash after "created" reads as a rendering failure. `formatAge` keeps
  // its own dash.
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

    // The title says which absence it is: the task was created and the
    // comment was written; the hub simply recorded no time.
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

    const back = within(facts).getByRole("link", { name: "the findings on meadow.example" });
    expect(back).toHaveAttribute("href", "/assets/meadow.example#insights");
    expect(within(facts).getByText(/organic-clicks-fell/)).toBeInTheDocument();
    expect(container.textContent).toContain("traffic-warning");
  });

  // The fixture above is a task filed under the legacy handoff grammar
  // (reindex_* metadata, the reindex-handoff label); this one uses the current
  // names. Both link back the same way.
  it("links a handoff filed under the NoticeOS names back the same way", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({
      labels: ["noticeos-handoff"],
      metadata: {
        noticeos_source: "noticeos-handoff",
        noticeos_asset: "meadow.example",
        noticeos_kind: "query",
        noticeos_rule: "recover",
        noticeos_key: "meal plan, weekly",
      },
    }) }));
    const { container } = renderTask();
    const facts = (await screen.findByText("Came from")).closest("[data-task-facts]") as HTMLElement;
    const back = within(facts).getByRole("link", { name: "the query decisions on meadow.example" });
    expect(back).toHaveAttribute("href", "/assets/meadow.example#query-visibility");
    expect(within(facts).getByText(/meal plan, weekly/)).toBeInTheDocument();
    expect(container.textContent).toContain("recover");
  });

  it("says nothing about an origin when the task carries no handoff metadata", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ metadata: null }) }));
    renderTask();
    await screen.findByText("A task has a page");
    expect(screen.queryByText("Came from")).toBeNull();
  });

  it("saves an edit through updateTask, and the toast's Undo writes the previous value back", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: 'open' }) }));
    renderTask();

    // A local read carries no member list, so a typed name is offered too.
    const editor = await openFact("Assignee: claude/task-page-agent");
    expect(within(editor).getByRole("option", { name: "claude/task-page-agent" })).toHaveAttribute("aria-selected", "true");
    const other = within(editor).getByRole("textbox", { name: "Someone else" });
    fireEvent.change(other, { target: { value: "operator" } });
    fireEvent.keyDown(other, { key: "Enter" });

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { assignee: "operator" }),
    );
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    // Saved on Enter: the editor closed and there is no Save anywhere.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();

    pressUndo();
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenLastCalledWith(ID, {
        assignee: "claude/task-page-agent",
      }),
    );
  });

  it("saves the priority as a number on choose and undoes it to the band it came from", async () => {
    renderTask();

    const editor = await openFact("Priority: high");
    expect(within(editor).getAllByRole("option").map((option) => option.getAttribute("data-value"))).toEqual(["0", "1", "2", "3", "4"]);
    for (const band of ["top", "high", "normal", "low", "lowest"]) {
      expect(within(editor).getByRole("option", { name: band }).querySelector("[data-priority-mark]")).toHaveAttribute("data-priority-mark", band);
    }
    fireEvent.click(within(editor).getByRole("option", { name: "top" }));

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { priority: 0 }));
    expect(toasts.success).toHaveBeenLastCalledWith("Saved — priority", expect.objectContaining({ action: expect.anything() }));
    pressUndo();
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenLastCalledWith(ID, { priority: 1 }),
    );
  });

  it("saves the status on choose with the board's words, and undoes it", async () => {
    renderTask();
    const editor = await openFact("Status: In progress");
    expect(within(editor).getAllByRole("option").map((option) => option.textContent)).toEqual(["Open", "In progress", "Blocked", "Parked", "Closed"]);
    fireEvent.click(within(editor).getByRole("option", { name: "Blocked" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { status: "blocked" }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { status: "in_progress" }));
  });

  it("parks a task until a picked day, and clears it, each with an Undo", async () => {
    const { unmount } = renderTask();
    let editor = await openFact("Parked until: Not parked");
    const day = within(editor).getByLabelText("Date") as HTMLInputElement;
    fireEvent.change(day, { target: { value: "2026-09-20" } });
    fireEvent.keyDown(day, { key: "Enter" });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { defer: "2026-09-20" }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { defer: "" }));
    unmount();

    api.updateTask.mockClear();
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "deferred", deferUntil: "2026-09-20T00:00:00Z" }) }));
    renderTask();
    editor = await openFact("Parked until: Sep 20");
    fireEvent.click(within(editor).getByRole("option", { name: "Not parked" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { defer: "" }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { defer: "2026-09-20" }));
  });

  it("closes a fact's editor on Escape without a write", async () => {
    renderTask();
    for (const name of ["Status: In progress", "Priority: high", "Assignee: claude/task-page-agent", "Parked until: Not parked", "Add a label"]) {
      const editor = await openFact(name);
      fireEvent.keyDown(editor, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    // Choosing the value it already has is not an edit either.
    fireEvent.click(within(await openFact("Status: In progress")).getByRole("option", { name: "In progress" }));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("adds and removes a label, each undone by its opposite", async () => {
    renderTask();

    const editor = await openFact("Add a label");
    const input = within(editor).getByRole("textbox", { name: "New label" });
    fireEvent.change(input, { target: { value: "saas" } });
    fireEvent.keyDown(input, { key: "Enter" });
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
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { addLabels: ["tower"] }));
  });

  it("moves a task to another epic from the parent's chip, and keeps the epic's link", async () => {
    renderTask();
    const facts = (await screen.findByText("Parent epic")).closest("[data-task-facts]") as HTMLElement;
    await waitFor(() => expect(within(facts).getByRole("link", { name: "Tasks are managed in the Tower" })).toHaveAttribute("href", "/tasks/ro-l1ed"));
    const editor = await openFact("Change parent epic");
    expect(within(editor).getByRole("option", { name: "Tasks are managed in the Tower" })).toHaveAttribute("aria-selected", "true");
    const other = within(editor).getByRole("textbox", { name: "Another task id" });
    fireEvent.change(other, { target: { value: "ro-abc" } });
    fireEvent.keyDown(other, { key: "Enter" });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { parent: "ro-abc" }));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { parent: "ro-l1ed" }));
  });

  it("draws every fact as a chip sized to its content, with no Save and no select", async () => {
    const { container } = renderTask();
    await screen.findByText("A task has a page");
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    await waitFor(() => expect(within(facts).getByText("2 of 5 closed")).toBeInTheDocument());
    expect(facts.querySelectorAll("select, input, textarea")).toHaveLength(0);
    expect(within(facts).queryByRole("button", { name: /^Save/ })).toBeNull();
    for (const name of ["Status: In progress", "Priority: high", "Assignee: claude/task-page-agent", "Parked until: Not parked", "Add a label", "Change parent epic"]) {
      expect(within(facts).getByRole("button", { name })).toHaveAttribute("aria-haspopup", "dialog");
    }
  });
  it("offers an empty description as a field to fill, not a command to run", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ description: "", acceptance: "" }) }));
    renderTask();
    await screen.findByText("A task has a page");

    expect(document.body.textContent).not.toContain("--description");
    fireEvent.click(screen.getByRole("button", { name: /Add a description/ }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "What, why, where." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(ID, { description: "What, why, where." }),
    );
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
    // actions are the refused ones, so wait for the live task.
    await screen.findByText("A task has a page");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const confirm = screen.getByRole("button", { name: "Close task" });
    expect(screen.getByText("What shipped, and the commit")).toBeInTheDocument();
    expect(screen.queryByText(/Closing records a decision/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Closed means shipped/)).not.toBeInTheDocument();
    // The button that writes stays disabled until there is something to write.
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

  it("opens Close on five resolution chips, Done first and picked, with the shipped line under Done", async () => {
    renderTask();
    await screen.findByText("A task has a page");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const chips = screen.getByRole("radiogroup", { name: "How it ended" });
    expect(within(chips).getAllByRole("radio").map((chip) => [chip.textContent, chip.getAttribute("aria-checked")])).toEqual([
      ["Done", "true"], ["Won't do", "false"], ["Duplicate", "false"], ["Can't reproduce", "false"], ["Already handled", "false"],
    ]);
    expect(screen.getByText("What shipped, and the commit")).toBeInTheDocument();
    // The arrow keys move the pick, as a radio group's do.
    fireEvent.keyDown(within(chips).getByRole("radio", { name: "Done" }), { key: "ArrowRight" });
    expect(within(chips).getByRole("radio", { name: "Won't do" })).toHaveAttribute("aria-checked", "true");
    expect(within(chips).getByRole("radio", { name: "Won't do" })).toHaveFocus();
    expect(screen.queryByText("What shipped, and the commit")).toBeNull();
    expect(screen.getByLabelText("Note")).toBeInTheDocument();
  });

  it("closes a bug nobody holds as Can't reproduce from its page: one line, through the Undo window", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ issueType: "bug", status: "open", assignee: null, startedAt: null }) }));
    renderTask();
    await screen.findByRole("button", { name: "Claim" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("radio", { name: "Can't reproduce" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Ran the import three times; no error." } });
    fireEvent.submit(document.querySelector<HTMLFormElement>('[data-task-form="close-as"]')!);
    expect(toasts.success).toHaveBeenLastCalledWith("Closed as Can't reproduce", expect.objectContaining({
      description: "A task has a page", action: expect.objectContaining({ label: "Undo" }) }));
    // While the window runs the header offers nothing, and nothing has been sent.
    expect(within(headerBand()).queryByRole("button", { name: "Claim" })).toBeNull();
    expect(within(headerBand()).queryByRole("button", { name: "Close" })).toBeNull();
    expect(api.closeTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.closeTask).toHaveBeenCalledWith(ID, "Ran the import three times; no error.", { resolution: "cant-reproduce" }));
  });

  it("takes a close where nothing shipped back with Undo, and the actions return", async () => {
    renderTask();
    await screen.findByText("A task has a page");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("radio", { name: "Duplicate" }));
    const form = document.querySelector<HTMLFormElement>('[data-task-form="close-as"]')!;
    fireEvent.change(within(form).getByLabelText("Duplicate of"), { target: { value: "ro-l1ed.4" } });
    fireEvent.submit(form);
    const undo = vi.mocked(toasts.success).mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    expect(vi.mocked(toasts.success).mock.calls.at(-1)![0]).toBe("Closed as Duplicate");
    act(() => undo.action.onClick());
    act(() => flushAnswers());
    expect(api.closeTask).not.toHaveBeenCalled();
    expect(await within(headerBand()).findByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("reads a close where nothing shipped as Closed as its resolution, with who, when and the note; a duplicate links the other task", async () => {
    const closer = { noticeos_closed_by: "Dana", noticeos_closed_at: "2026-09-04T11:30:00Z" };
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "closed", closedAt: "2026-09-04T11:30:00Z", closeReason: "Nobody asked for it",
      resolution: "wont-do", metadata: { ...closer, noticeos_resolution: "wont-do" } }) }));
    const { unmount } = renderTask();
    const fact = await screen.findByText("Closed as Won't do");
    const summary = headerBand().querySelector("[data-task-closed]") as HTMLElement;
    expect(summary).toHaveAttribute("data-task-resolution", "wont-do");
    expect(summary).toContainElement(fact);
    expect(within(summary).getByText("Dana")).toBeInTheDocument();
    expect(within(summary).getByText("30m ago")).toBeInTheDocument();
    expect(within(summary).getByText("Nobody asked for it")).toBeInTheDocument();
    const activity = document.querySelector("[data-task-activity]") as HTMLElement;
    expect(activity.querySelector('[data-entry="closed"] [data-entry-label]')).toHaveTextContent("Closed as Won't do by Dana");
    // The resolution's glyph, not the done close's tick.
    expect(activity.querySelector('[data-entry="closed"] svg.lucide-circle-slash')).not.toBeNull();
    expect(activity.querySelector('[data-entry="closed"] svg.lucide-check')).toBeNull();
    unmount();

    // A duplicate closed with no note: its words are the reason, which the summary does not repeat.
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "closed", closedAt: "2026-09-04T11:30:00Z", closeReason: "Duplicate of ro-l1ed.4",
      resolution: "duplicate", duplicateOf: "ro-l1ed.4", metadata: { ...closer, noticeos_resolution: "duplicate", noticeos_duplicate_of: "ro-l1ed.4" } }) }));
    renderTask();
    const heading = await screen.findByText((_, node) => node?.getAttribute("data-task-resolution-fact") === "" && node.textContent === "Closed as Duplicate of ro-l1ed.4");
    expect(within(heading).getByRole("link", { name: "ro-l1ed.4" })).toHaveAttribute("href", "/tasks/ro-l1ed.4");
    expect(within(headerBand().querySelector("[data-task-closed]") as HTMLElement).queryByText("Duplicate of ro-l1ed.4")).toBeNull();
  });

  it("reads the saved snapshot's resolution where there is no live read", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    const snapshot = work([]);
    snapshot.projects[0]!.recentlyClosed = [snapshotItem({ status: "closed", closedAt: "2026-09-04T11:00:00.000Z", resolution: "already-handled" })];
    snapshot.projects[0]!.recentWork = [{ kind: "closed", taskId: ID, title: "A task has a page", by: "Dana", model: null,
      at: "2026-09-04T11:00:00.000Z", evidence: "ro-l1ed.4 covered it", resolution: "already-handled" }];
    state.work = snapshot;
    renderTask();
    const fact = await screen.findByText("Closed as Already handled");
    const summary = fact.closest("[data-task-closed]") as HTMLElement;
    expect(within(summary).getByText("ro-l1ed.4 covered it")).toBeInTheDocument();
    expect(within(summary).getByText("Dana")).toBeInTheDocument();
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

  it("offers Claim on an open, unclaimed task", async () => {
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
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Tasks" })).toHaveAttribute(
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

    expect(await screen.findByText("A task has a page")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Read-only snapshot")).toBeInTheDocument();
    expect(document.querySelector("[data-task-readonly] [role=status]")).toHaveTextContent(READ_ONLY_TASKS_HINT);
    expect(document.querySelector("[data-owner-chip]")).toBeNull();

    // The reason is the banner under the header, which the button names; no
    // hover title repeats it over the next button.
    const claim = screen.getByRole("button", { name: "Claim" });
    expect(claim).toBeDisabled();
    expect(claim).not.toHaveAttribute("title");
    expect(claim).toHaveAccessibleDescription(expect.stringContaining(READ_ONLY_TASKS_HINT));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

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
// the same definition (routes/tasks/ask-actions).
describe("a waiting task's page offers what its inbox row offers", () => {
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

  it("gives an ask Answer and Close as, and the answer box sends through the inbox's call", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: ask() }));
    renderTask();

    fireEvent.click(await header().findByRole("button", { name: "Answer" }));
    expect(headerButtons().slice(0, 2)).toEqual(["Answer", "Close as"]);
    expect(header().queryByRole("button", { name: "Claim" })).toBeNull();
    expect(header().queryByRole("button", { name: "Close" })).toBeNull();
    const box = header().getByLabelText(`Your answer to ${ID}`);
    fireEvent.change(box, { target: { value: "Ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toasts.success).toHaveBeenCalledWith("Answered", expect.anything());
    act(() => flushAnswers());
    await waitFor(() => expect(api.respondToTask).toHaveBeenCalledWith(ID, "Ship it"));
  });

  it("dismisses an ask as the Close as menu's Won't do, through the inbox's call", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: ask() }));
    renderTask();

    fireEvent.click(await header().findByRole("button", { name: "Close as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Won't do" }));
    fireEvent.submit(document.querySelector<HTMLFormElement>('[data-task-form="close-as"]')!);
    expect(toasts.success).toHaveBeenCalledWith("Closed as Won't do", expect.anything());
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
    expect(approve).not.toHaveAttribute("title");
    expect(approve).toHaveAccessibleDescription(expect.stringContaining(READ_ONLY_TASKS_HINT));
    expect(headerButtons()).toEqual(["Approve"]);
  });
});

// A task that carries choices: the question and one button per option under
// the header, one press to pick through the inbox's call, and the pick drawn
// as a fact once the task is read back.
describe("a task with choices is answered with one press", () => {
  const CHOICES: TaskChoices = {
    question: "What happens to the retired recipe page?",
    options: [
      { key: "a", label: "Keep the old page", detail: "It stays reachable at its address." },
      { key: "b", label: "Redirect to the new page", detail: "A permanent redirect keeps its search traffic.", recommended: true },
      { key: "c", label: "Remove it", detail: "Visitors get a not-found page." },
    ],
  };
  const PICK = { option: "b", label: "Redirect to the new page", by: "Dana", at: "2026-09-04T11:00:00.000Z" } as const;
  const choosing = (over: Partial<LiveTask> = {}) =>
    task({ status: "open", assignee: null, labels: ["human"], ready: true, startedAt: null, choices: CHOICES, choice: null, ...over });
  const headerNode = () => document.querySelector<HTMLElement>("[data-page-header]")!;
  const header = () => within(headerNode());
  const optionKeys = () => [...headerNode().querySelectorAll<HTMLElement>("[data-choice-option]")].map((node) => node.dataset.choiceOption);

  it("reads Needs your choice, and draws the question and one button per option, the recommended first, Answer and Close as under them", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: choosing() }));
    const { container } = renderTask();
    const group = await header().findByRole("group", { name: CHOICES.question });
    expect(header().getByText("Needs your choice")).toHaveAttribute("data-task-ask", "choose");
    expect(optionKeys()).toEqual(["b", "a", "c"]);
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim())).toEqual([
      "(b) Redirect to the new page", "(a) Keep the old page", "(c) Remove it", "Answer", "Close as",
    ]);
    expect(within(buttons[0]!).getByText("Recommended")).toBeInTheDocument();
    expect(within(buttons[1]!).getByText("It stays reachable at its address.")).toBeInTheDocument();
    expect(header().queryByRole("button", { name: "Claim" })).toBeNull();
    expect(header().queryByRole("button", { name: "Close" })).toBeNull();
    // The options keep the page's hover, focus and press rules.
    const page = container.querySelector("[data-task-page]") as HTMLElement;
    expect(page.className).toContain("motion-safe:[&_button:not(:disabled):active]:translate-y-px");
    for (const node of within(group).getAllByRole("button")) {
      expect(node.className, node.textContent ?? "").toMatch(/hover:/);
      expect(node.className, node.textContent ?? "").toMatch(/focus-visible:/);
    }
    expect(headerNode().querySelectorAll("[title]")).toHaveLength(0);
  });

  it("sends the pressed option and the note through the inbox's call after the Undo window, and draws the pick meanwhile", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: choosing() }));
    renderTask();
    await header().findByRole("group", { name: CHOICES.question });
    fireEvent.change(header().getByLabelText("Note"), { target: { value: "Keep the redirect for a year." } });
    fireEvent.click(header().getByRole("button", { name: "(b) Redirect to the new page" }));
    expect(toasts.success).toHaveBeenCalledWith("Chose (b) Redirect to the new page", expect.objectContaining({
      description: "A task has a page",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    // While the window runs the options are the pick: nothing to press, (b) filled.
    expect(header().queryByRole("button", { name: /^\([abc]\)/ })).toBeNull();
    expect(headerNode().querySelector('[data-choice-option="b"]')).toHaveAttribute("data-choice-chosen");
    expect(api.chooseOnTask).not.toHaveBeenCalled();
    act(() => flushAnswers());
    await waitFor(() => expect(api.chooseOnTask).toHaveBeenCalledWith(ID, "b", "Keep the redirect for a year."));
    expect(api.respondToTask).not.toHaveBeenCalled();
    expect(api.closeTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("takes the pick back with the toast's Undo, and offers the options again", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: choosing() }));
    renderTask();
    fireEvent.click(await header().findByRole("button", { name: "(a) Keep the old page" }));
    act(() => pressUndo());
    expect(await header().findByRole("button", { name: "(a) Keep the old page" })).toBeEnabled();
    expect(headerNode().querySelector("[data-choice-chosen]")).toBeNull();
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("shows a refused pick in the lane's own words, and brings the options back", async () => {
    api.chooseOnTask.mockRejectedValueOnce(new Error(`${ID} already has a choice: (b) Redirect to the new page.`));
    api.fetchTask.mockResolvedValue(detail({ task: choosing() }));
    renderTask();
    fireEvent.click(await header().findByRole("button", { name: "(c) Remove it" }));
    act(() => flushAnswers());
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(`${ID} already has a choice: (b) Redirect to the new page.`));
    expect(await header().findByRole("button", { name: "(c) Remove it" })).toBeEnabled();
  });

  it("states a recorded pick under the header, who chose and how long ago, with the options inert and the chosen one filled", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: choosing({ labels: [], choice: { ...PICK, note: "Keep the redirect for a year." } }) }));
    renderTask();
    const fact = await header().findByRole("heading", { name: "Chose (b) Redirect to the new page" });
    const record = fact.closest("section") as HTMLElement;
    expect(record).toHaveTextContent(/^Chose \(b\) Redirect to the new pageDana1h ago/);
    expect(within(record).getByText("Keep the redirect for a year.")).toBeInTheDocument();
    expect(within(record).queryAllByRole("button")).toHaveLength(0);
    expect(record.querySelector('[data-choice-option="b"]')).toHaveAttribute("data-choice-chosen");
    expect(record.querySelector('[data-choice-option="a"]')).not.toHaveAttribute("data-choice-chosen");
    expect(header().queryByText("Needs your choice")).toBeNull();
    // Handed back to ready work, the task offers Claim again.
    expect(header().getByRole("button", { name: "Claim" })).toBeInTheDocument();
  });

  it("draws a decision a pick closed with the pick alone, not the same words again as its close reason", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: choosing({ issueType: "decision", status: "closed", labels: ["human"],
      closedAt: "2026-09-04T11:00:00Z", closeReason: "Chose (b) Redirect to the new page", choice: PICK }) }));
    renderTask();
    await header().findByRole("heading", { name: "Chose (b) Redirect to the new page" });
    expect(document.querySelector("[data-task-closed]")).toBeNull();
    expect(header().queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a read-only snapshot's question and options as buttons that cannot be pressed, naming why", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    const snapshot = work();
    snapshot.projects[0]!.waiting = [snapshotItem({ choices: CHOICES, choice: null })];
    state.work = snapshot;
    renderTask();
    const group = await header().findByRole("group", { name: CHOICES.question });
    expect(header().getByText("Needs your choice")).toBeInTheDocument();
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(expect.stringContaining(READ_ONLY_TASKS_HINT));
    }
    expect(within(group).queryByLabelText("Note")).toBeNull();
  });

  it("names a workspace that may answer but not pick as the reason, and keeps the options inert", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: true, reason: null,
      operations: ["create", "update", "comment", "close", "respond", "dismiss"] });
    api.fetchTask.mockResolvedValue(detail({ task: choosing() }));
    renderTask();
    const option = await header().findByRole("button", { name: "(b) Redirect to the new page" });
    await waitFor(() => expect(option).toBeDisabled());
    expect(option).toHaveAccessibleDescription(expect.stringContaining("Unavailable in this workspace."));
    expect(headerNode().querySelector("[data-action-reason]")).toHaveTextContent("Unavailable in this workspace.");
    expect(header().getByRole("button", { name: "Answer" })).toBeEnabled();
  });
});

// The header states what the item is, where it sits, where it stands and the
// one thing to do next, before any prose.
describe("the header reads in one look", () => {
  const header = () => document.querySelector<HTMLElement>("[data-page-header]")!;
  const crumbs = () => within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  const firstAction = () => within(header()).getAllByRole("button")[0]!;

  it("states a task's type, id, state, priority, holder and model with the claim's age, and leads with Close", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ metadata: { noticeos_claimed_model: "Opus 5.5" } }) }));
    renderTask();
    await screen.findByText("A task has a page");
    await waitFor(() => expect(crumbs().getByRole("link", { name: "Tasks are managed in the Tower" })).toHaveAttribute("href", "/tasks/ro-l1ed"));
    expect(crumbs().getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    expect(crumbs().getByRole("link", { name: /System/ })).toHaveAttribute("href", "/tasks?project=root-os");

    const head = within(header());
    expect(head.getByRole("heading", { level: 1 })).toHaveTextContent("A task has a page");
    expect(head.getByText("Task")).toHaveAttribute("data-task-type", "task");
    expect(head.getByText(ID)).toBeInTheDocument();
    expect(head.getByText("In progress")).toBeInTheDocument();
    expect(head.getByText("high priority")).toBeInTheDocument();
    const holder = header().querySelector("[data-task-holder]") as HTMLElement;
    expect(holder).toHaveTextContent("claude/task-page-agent· Opus 5.5· claimed 2h ago");
    // Somebody holds it, so closing it with its evidence is what comes next.
    expect(firstAction()).toHaveTextContent("Close");
    expect(firstAction()).toHaveAttribute("data-primary-action");
  });

  it("states an epic's type and its closed of total, and leads with Claim while nobody holds it", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ id: "ro-l1ed", title: "Tasks are managed in the Tower", issueType: "epic",
      parent: null, status: "open", assignee: null, startedAt: null, dependencies: [] }), comments: [] }));
    renderTask("ro-l1ed");
    await waitFor(() => expect(within(header()).queryByRole("progressbar")).not.toBeNull());
    const head = within(header());
    expect(head.getByText("Epic")).toHaveAttribute("data-task-type", "epic");
    expect(head.getByText("Open")).toBeInTheDocument();
    expect(head.getByText("2 of 5 closed")).toBeInTheDocument();
    expect(header().querySelector("[data-task-holder]")).toBeNull();
    expect(within(header()).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Claim", "Close"]);
    expect(firstAction()).toHaveAttribute("data-primary-action");
  });

  it("states what a decision asks of the operator, and leads with that answer", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ issueType: "gate", awaitType: "human", status: "open", assignee: null, labels: ["human"], startedAt: null }) }));
    const { unmount } = renderTask();
    await within(header()).findByRole("button", { name: "Approve" });
    expect(within(header()).getByText("Approval")).toHaveAttribute("data-task-type", "gate");
    expect(within(header()).getByText("Needs your approval")).toHaveAttribute("data-task-ask", "approve");
    expect(firstAction()).toHaveTextContent("Approve");
    unmount();

    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, labels: ["human"], ready: true, startedAt: null }) }));
    renderTask();
    await within(header()).findByRole("button", { name: "Answer" });
    expect(within(header()).getByText("Needs your answer")).toHaveAttribute("data-task-ask", "answer");
    expect(firstAction()).toHaveTextContent("Answer");
  });

  it("puts a closed task's reason and closer directly under the header, offers no action, and wears no green", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({
      status: "closed", closedAt: "2026-09-04T11:30:00Z", closeReason: "Facts render · abc1234",
      metadata: { noticeos_closed_by: "claude", noticeos_closed_model: "Opus 5.5", noticeos_closed_at: "2026-09-04T11:30:00Z" },
    }) }));
    renderTask();
    await screen.findByText("A task has a page");
    const closed = header().querySelector("[data-task-closed]") as HTMLElement;
    expect(closed).not.toBeNull();
    expect(within(closed).getByText("Facts render · abc1234")).toBeInTheDocument();
    expect(within(closed).getByText("claude · Opus 5.5")).toBeInTheDocument();
    expect(within(closed).getByText("30m ago")).toBeInTheDocument();
    expect(within(header()).getByText("Closed")).toHaveAttribute("data-task-status", "closed");
    expect(within(header()).queryAllByRole("button")).toHaveLength(0);
    // A holder is for open work; who closed it is the reason's line.
    expect(header().querySelector("[data-task-holder]")).toBeNull();
    for (const node of [closed, ...header().querySelectorAll("[data-status-for]")]) {
      expect(node.className).not.toMatch(/healthy|milestone|success/);
    }
  });

  it("keeps the board's filters on the Tasks crumb, and keeps one way back to Home or an asset", async () => {
    const { unmount } = renderTask(ID, "", { returnTo: "/tasks?status=open" });
    await screen.findByText("A task has a page");
    expect(crumbs().getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks?status=open");
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
    unmount();

    renderTask(ID, "", { returnTo: "/?range=7" });
    await screen.findByText("A task has a page");
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/?range=7");
    expect(crumbs().getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
  });

  it("reaches the primary action, then the facts, then the comment box, in that order", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: task({ status: "open", assignee: null, startedAt: null }) }));
    const { container } = renderTask();
    const claim = await screen.findByRole("button", { name: "Claim" });
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    const description = container.querySelector('[data-task-field="Description"]') as HTMLElement;
    const comment = screen.getByRole("textbox", { name: "Add a comment" });
    const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // Facts come first after the header, which is the order a phone stacks.
    expect(follows(claim, facts)).toBe(true);
    expect(follows(facts, description)).toBe(true);
    expect(follows(description, comment)).toBe(true);
    for (const node of [claim, comment]) expect(node).not.toHaveAttribute("tabindex", "-1");
  });

  it("states a deployed task's type and holder from the snapshot", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    state.work = work([snapshotItem({ status: "in_progress", assignee: "claude" })]);
    renderTask();
    await screen.findByText("A task has a page");
    expect(within(header()).getByText("Task")).toHaveAttribute("data-task-type", "task");
    expect(header().querySelector("[data-task-holder]")).toHaveTextContent("claude");
    expect(firstAction()).toHaveTextContent("Close");
    expect(firstAction()).toBeDisabled();
  });
});

// An epic's page lists what it holds, from the project's live read; a task's
// page shows where it stands among its siblings.
describe("an epic's page and its tasks", () => {
  const EPIC = "ro-l1ed";
  const epicTask = () => task({ id: EPIC, title: "Tasks are managed in the Tower", issueType: "epic", parent: null, status: "open",
    assignee: null, startedAt: null, dependencies: [], metadata: null });
  const child = (over: Partial<LiveTask>) => task({ status: "open", assignee: null, startedAt: null, parent: EPIC, dependencies: [], metadata: null, ...over });
  function epicBoard(): LiveTasksPayload {
    const base = board();
    return {
      ...base,
      tasks: [
        epicTask(),
        ...base.tasks,
        child({ id: "ro-l1ed.5", title: "Fields are edited where they are read", ready: true, priority: 2 }),
        child({ id: "ro-l1ed.6", title: "Approve the close form wording", ready: true, labels: ["human"] }),
        child({ id: "ro-l1ed.1", title: "A local task lane", status: "closed", closedAt: "2026-09-03T10:00:00.000Z" }),
      ],
      epics: [{ ...base.epics![0]!, total: 6, closed: 2 }],
    };
  }
  const rollup = (over: Partial<WorkEpic> = {}): WorkEpic => ({ id: EPIC, title: "Tasks are managed in the Tower", status: "open", priority: 1,
    total: 4, closed: 1, counts: { open: 2, inProgress: 1, blocked: 0, deferred: 0 }, priorities: [0, 1, 2, 0, 0], ...over });

  it("lists its tasks under the board's state words, each opening its page, with closed of total in the header", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: epicTask(), comments: [] }));
    api.fetchTasks.mockResolvedValue(epicBoard());
    const { container } = renderTask(EPIC);

    await waitFor(() => expect(container.querySelector("[data-epic-tasks]")).not.toBeNull());
    const list = container.querySelector("[data-epic-tasks]") as HTMLElement;
    const groups = [...list.querySelectorAll("[data-epic-group]")].map((group) => [
      group.getAttribute("data-epic-group"),
      [...group.querySelectorAll("[data-epic-task]")].map((row) => row.getAttribute("data-epic-task")),
    ]);
    expect(groups).toEqual([
      ["Needs attention", ["ro-l1ed.6"]],
      ["In progress", [ID]],
      ["Ready", ["ro-l1ed.5"]],
      ["Waiting", ["ro-l1ed.4"]],
      ["Done", ["ro-l1ed.1"]],
    ]);
    const ready = within(list.querySelector('[data-epic-group="Ready"]') as HTMLElement);
    expect(ready.getByRole("link", { name: /ro-l1ed\.5/ })).toHaveAttribute("href", "/tasks/ro-l1ed.5");
    // Who holds a task in progress is on its row.
    expect(within(list.querySelector(`[data-epic-task="${ID}"]`) as HTMLElement).getByText("claude/task-page-agent")).toBeInTheDocument();
    // The read holds a week of closes; the epic's all-time count names the rest.
    expect(within(list).getByText("1 more, closed over 7 days ago")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "Epic graph →" })).toHaveAttribute("href", `/tasks?epic=${EPIC}`);

    const header = container.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByRole("progressbar")).toHaveAttribute("aria-label", "2 of 6 children closed");
    expect(within(header).getByText("2 of 6 closed")).toBeInTheDocument();
  });

  it("offers no Epic graph link where the board draws no graph for the epic", async () => {
    const flat = epicBoard();
    flat.tasks = flat.tasks.map((row) => ({ ...row, dependencies: [] }));
    api.fetchTask.mockResolvedValue(detail({ task: epicTask(), comments: [] }));
    api.fetchTasks.mockResolvedValue(flat);
    const { container } = renderTask(EPIC);
    await waitFor(() => expect(container.querySelector("[data-epic-tasks]")).not.toBeNull());
    expect(screen.queryByRole("link", { name: "Epic graph →" })).toBeNull();
  });

  it("shows a child's epic as closed of total and names the next sibling ready to claim", async () => {
    api.fetchTasks.mockResolvedValue(epicBoard());
    const { container } = renderTask();
    await waitFor(() => expect(container.querySelector("[data-next-ready]")).not.toBeNull());
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    expect(within(facts).getByText("2 of 6 closed")).toBeInTheDocument();
    const next = facts.querySelector("[data-next-ready]") as HTMLElement;
    expect(next).toHaveAttribute("data-next-ready", "ro-l1ed.5");
    expect(within(next).getByRole("link", { name: /Fields are edited where they are read/ })).toHaveAttribute("href", "/tasks/ro-l1ed.5");
    // The bar is the epic's tasks, one segment each: the one closed before the
    // read's window, the closed sibling, this task ringed, then what waits,
    // the next ready one marked.
    const bar = within(facts).getByRole("progressbar");
    expect(bar).toHaveAttribute("data-epic-segments", "6");
    expect([...bar.querySelectorAll("[data-segment]")].map((segment) => segment.getAttribute("data-segment")))
      .toEqual(["earlier", "done", "active", "waiting", "waiting", "waiting"]);
    expect(bar.querySelectorAll("[data-segment-self]")).toHaveLength(1);
    expect(bar.querySelector("[data-segment-self]")).toHaveAttribute("data-segment", "active");
    expect(bar.querySelectorAll("[data-segment-next]")).toHaveLength(1);
    // A closed task is ink, never green.
    expect(bar.innerHTML).not.toMatch(/healthy|milestone|success/);
  });

  it("draws an epic's header bar as its tasks, one segment each", async () => {
    api.fetchTask.mockResolvedValue(detail({ task: epicTask(), comments: [] }));
    api.fetchTasks.mockResolvedValue(epicBoard());
    const { container } = renderTask(EPIC);
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    await waitFor(() => expect(within(header).getByRole("progressbar")).toHaveAttribute("data-epic-segments", "6"));
    expect(header.querySelector("[data-segment-self]")).toBeNull();
  });

  it("draws a deployed epic from the snapshot's rollup and counts the tasks the snapshot does not hold", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    const snapshot = work();
    snapshot.projects[0]!.epics = [rollup()];
    state.work = snapshot;
    const { container } = renderTask(EPIC);

    expect(await screen.findByText("Tasks are managed in the Tower")).toBeInTheDocument();
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByText("1 of 4 closed")).toBeInTheDocument();
    const list = container.querySelector("[data-epic-tasks]") as HTMLElement;
    expect(list.querySelectorAll("[data-epic-task]")).toHaveLength(0);
    expect(within(list).getByText("4 tasks not in the saved snapshot")).toBeInTheDocument();
    expect(api.fetchTask).not.toHaveBeenCalled();
  });

  it("lists the epic's tasks the deployed snapshot does hold, and counts the rest", async () => {
    api.fetchTasksCapabilities.mockResolvedValue({ live: false, reason: READ_ONLY_DEPLOYMENT });
    const snapshot = work([snapshotItem({ id: "ro-l1ed.5", title: "Fields are edited where they are read", parent: EPIC })]);
    snapshot.projects[0]!.epics = [rollup()];
    state.work = snapshot;
    const { container } = renderTask(EPIC);

    await screen.findByText("Tasks are managed in the Tower");
    const list = container.querySelector("[data-epic-tasks]") as HTMLElement;
    expect(within(list.querySelector('[data-epic-group="Ready"]') as HTMLElement).getByRole("link", { name: /ro-l1ed\.5/ }))
      .toHaveAttribute("href", "/tasks/ro-l1ed.5");
    expect(within(list).getByText("3 more not in the saved snapshot")).toBeInTheDocument();
  });
});
