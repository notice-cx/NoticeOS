import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskHubSpoke } from "@shared/settings";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT, type TasksCapabilities } from "@shared/tasks";
import type { NewTask } from "@/lib/api";

/**
 * The composer files exactly the task the copied `bd create` describes. Both
 * are rendered from one function, and the parity case parses the emitted shell
 * command back apart and compares what a shell would hand `bd` against the
 * object the composer sends to the lane.
 */

const lane = vi.hoisted(() => ({
  calls: [] as NewTask[],
  fail: null as string | null,
  capability: { live: true, reason: null } as TasksCapabilities,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTasksCapabilities: async () => lane.capability,
    fetchTaskProjects: async () => [],
    createTask: async (input: NewTask) => {
      lane.calls.push(input);
      if (lane.fail) throw new Error(lane.fail);
      return { id: "mp-9zz", project: input.project };
    },
  };
});

// The composer reads the spoke map from `/api/settings`; nothing serves it
// here and every case passes `projects` explicitly, so the hook answers with
// nothing rather than opening a fetch jsdom cannot complete.
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: undefined }),
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

import {
  FileTaskButton,
  TaskComposer,
  type TaskComposerPrefill,
} from "@/components/TaskComposer";
import { taskHandoffPrefill, taskHandoffSection } from "@/lib/task-handoff";
import { alertTaskHandoff } from "@/lib/attention";
import { queryTaskHandoff } from "@/lib/query-decision-markdown";
import { RECOMMENDATION_RECHECK } from "@shared/recommendation-validity";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

const SPOKES: TaskHubSpoke[] = [
  { asset: "meals.example", prefix: "mp", database: "mp", repo: "../meals.example" },
  { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
];

afterEach(() => {
  resetTaskSourceMock();
  lane.calls.length = 0;
  lane.fail = null;
  lane.capability = { live: true, reason: null };
  toasts.success.mockClear();
  toasts.error.mockClear();
});

/** Where the router actually is, so the toast's Open link is asserted by its
 * effect rather than by reading the handler back. */
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderComposer(prefill: TaskComposerPrefill | null = null) {
  const onClose = vi.fn();
  const onFiled = vi.fn();
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/assets/meals.example"]}>
        <Where />
        <TaskComposer
          open
          onClose={onClose}
          prefill={prefill}
          onFiled={onFiled}
          projects={SPOKES}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onClose, onFiled };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const fileTask = () => screen.getByRole("button", { name: "File task" });

describe('hosted composer fields', () => {
  it('retains linked labels/metadata and ordinary fields in a selected hosted project', async () => {
    lane.capability = { live: true, writable: true, reason: null, projectSelection: true, operations: ['create', 'update', 'comment', 'close'] };
    const metadata = { noticeos_source: 'noticeos-handoff', noticeos_kind: 'finding', noticeos_asset: 'meals.example', noticeos_key: 'observed' };
    renderComposer({ project: 'meals.example', title: 'Linked finding', labels: ['noticeos'], acceptance: 'Observed result', metadata });
    await waitFor(() => expect(fileTask()).toBeEnabled());
    expect(screen.queryByText('Unavailable in this workspace.')).toBeNull();
    fireEvent.change(field('Parent epic'), { target: { value: 'mp-parent' } });
    fireEvent.click(fileTask());
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).toMatchObject({ project: 'meals.example', title: 'Linked finding', parent: 'mp-parent',
      labels: ['noticeos'], acceptance: 'Observed result', metadata });
  });
  it('does not dispatch linked content through read-only hosted permission', async () => {
    lane.capability = { live: true, writable: false, reason: null, projectSelection: true, operations: ['create'] };
    renderComposer({ project: 'meals.example', title: 'Linked finding', labels: ['noticeos'], metadata: { noticeos_kind: 'finding' } });
    await screen.findByText('Tasks are read-only in this workspace.');
    expect(fileTask()).toBeDisabled(); expect(lane.calls).toEqual([]);
  });
});

/** Reverse of the emitter's POSIX single-quoting, so a test reads back what
 * the shell would actually hand `bd`. */
function unquote(token: string): string {
  return token.slice(1, -1).replaceAll("'\\''", "'");
}

/** The `bd create` the copied handoff carries, parsed into the task it makes. */
function parseCommand(markdown: string) {
  const title = /^bd create (.+) \\$/m.exec(markdown)?.[1] ?? "";
  const labels = [...markdown.matchAll(/^ {2}-l (.+) \\$/gm)].map((match) =>
    unquote(match[1]!),
  );
  const metadata = /^ {2}--metadata (.+) \\$/m.exec(markdown)?.[1] ?? "";
  const description = /^ {2}-d (.+)$/m.exec(markdown)?.[1] ?? "";
  return {
    title: unquote(title),
    type: /^ {2}-t (\w+) \\$/m.exec(markdown)?.[1] ?? "",
    priority: Number(/^ {2}-p (\d) \\$/m.exec(markdown)?.[1]),
    labels,
    metadata: JSON.parse(unquote(metadata)) as Record<string, unknown>,
    description: unquote(description),
  };
}

describe("the composer's prefill IS the copied bd create", () => {
  const asset = { id: "meals.example", displayName: "Meal Planner", domain: "meals.example" };

  const cases = [
    {
      name: "a query decision",
      handoff: queryTaskHandoff({
        row: {
          query: "jarra del buen beber",
          key: "jarra del buen beber",
          google: null,
          bing: null,
          dataforseo: null,
        },
        assessment: {
          lane: "act",
          kind: "recover",
          label: "Recover visibility",
          action: "Confirm the page still exists and is indexed.",
        },
        asset,
      })!,
    },
    {
      name: "an alert row",
      handoff: alertTaskHandoff({
        id: 412,
        asset: "meals.example",
        assetDisplayName: "Meal Planner",
        severity: "warn",
        kind: "anomaly",
        message: "22 in last24h (avg7d 39.3, P(<=22)~=0.0020)",
        firedAt: "2026-09-01T09:00:00.000Z",
        metric: "signups",
        ruleId: "metric-drop",
        ruleInputs: null,
        correlatedChanges: [],
        occurrences: 1,
        firstFiredAt: "2026-09-01T09:00:00.000Z",
      }),
    },
    {
      name: "a query whose text would be a shell injection if it were not quoted",
      handoff: {
        asset: "meals.example",
        kind: "query" as const,
        key: "it's `rm -rf /` $(whoami)",
        rule: "recover",
        title: "Act on “it's `rm -rf /` $(whoami)”",
        summary: "A query nobody should ever have typed.",
        priority: 1,
      },
    },
  ];

  for (const { name, handoff } of cases) {
    it(`agrees with the command for ${name}`, () => {
      const command = taskHandoffSection(handoff).join("\n");
      const parsed = parseCommand(command);
      const prefill = taskHandoffPrefill(handoff)!;

      expect(prefill.title).toBe(parsed.title);
      expect(prefill.labels).toEqual(parsed.labels);
      expect(prefill.metadata).toEqual(parsed.metadata);
      expect(prefill.type).toBe(parsed.type);
      expect(prefill.priority).toBe(parsed.priority);
      expect(prefill.description).toBe(parsed.description);
      expect(command).toContain(`Run it in the \`${prefill.project}\` asset repo`);
      // The section leads with the button rather than teaching the command.
      expect(command).toContain("**File task** button");
      expect(command.indexOf("**File task** button")).toBeLessThan(
        command.indexOf("bd create"),
      );
      // No tutorial, and none of the internal vocabulary.
      for (const gone of ["bd config list", "issue_prefix", "task hub", "bead id"]) {
        expect(command).not.toContain(gone);
      }
    });
  }

  it("preserves the complete review context in the copied command and submitted draft after shortening the summary", async () => {
    const applicabilityReview = `${RECOMMENDATION_RECHECK} Analysis saved 2026-08-05T12:00:00.000Z. ${"This source's collection is not proof that the advice is current. ".repeat(8)}Exact linked task mp-review was recorded closed, not shipped or resolved.`;
    const handoff = { ...cases[0]!.handoff, title: "Review saved advice ".repeat(20), summary: "Long saved summary. ".repeat(50), applicabilityReview };
    const copied = parseCommand(taskHandoffSection(handoff).join("\n"));
    const prefill = taskHandoffPrefill(handoff)!;
    expect(prefill.title.length).toBeLessThanOrEqual(110);
    expect(prefill.description.indexOf(applicabilityReview)).toBeGreaterThan(0);
    expect(prefill.description.indexOf(applicabilityReview)).toBeLessThanOrEqual(301);
    expect(prefill.description).toContain(applicabilityReview);
    expect(copied.description).toBe(prefill.description);
    renderComposer(prefill);
    expect(field("Description").value).toBe(copied.description);
    fireEvent.click(fileTask());
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.description).toBe(copied.description);
    expect(JSON.parse(JSON.stringify(lane.calls[0])).description).toContain(applicabilityReview);
  });

  it("names the alert kind and keys on the firing", () => {
    const prefill = taskHandoffPrefill(cases[1]!.handoff)!;
    expect(prefill.metadata.noticeos_kind).toBe("alert");
    expect(prefill.metadata.noticeos_key).toBe("412");
    expect(prefill.metadata.noticeos_rule).toBe("metric-drop");
    expect(prefill.labels).toEqual([
      "noticeos-handoff",
      "asset:meals.example",
      "rule:metric-drop",
      "key:412",
    ]);
  });

  it("drops both the command and the prefill where it cannot name a repo", () => {
    const unnamed = { ...cases[0]!.handoff, asset: "" };
    expect(taskHandoffSection(unnamed)).toEqual([]);
    expect(taskHandoffPrefill(unnamed)).toBeNull();
  });
});

describe("TaskComposer", () => {
  const prefill = taskHandoffPrefill({
    asset: "meals.example",
    kind: "finding",
    key: "search-opportunity",
    rule: "search-opportunity",
    title: "Expand pages already earning search demand",
    summary: "From the NoticeOS finding for meals.example (Recommendation): expand them.",
    priority: 2,
  })!;

  it("opens on the prefill: title, project, priority, locked labels, and what it links to", () => {
    renderComposer(prefill);

    expect(field("Title").value).toBe("Expand pages already earning search demand");
    expect(field("Project").value).toBe("meals.example");
    // The board's own words, never a P-number.
    expect(field("Priority").value).toBe("2");
    expect(screen.getByRole("option", { name: "normal" })).toBeInTheDocument();
    expect(screen.queryByText("P2")).toBeNull();

    for (const label of prefill.labels) {
      const chip = document.querySelector(`[data-composer-locked-label="${label}"]`);
      expect(chip).not.toBeNull();
      // Locked: no remove control on a handoff label, because the join it carries
      // is what puts the filed task back on the row that raised it.
      expect(chip!.querySelector("button")).toBeNull();
    }

    expect(document.querySelector('[data-composer-linked="finding"]')).not.toBeNull();
    expect(screen.getByText(/Linked to a finding/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("noticeos_source");
  });

  // A prefill carrying the legacy handoff grammar (reindex_*) still says what it
  // links to.
  it("reads the kind of a handoff written under the old grammar", () => {
    renderComposer({ project: "meals.example", title: "Old handoff", metadata: { reindex_kind: "query", reindex_key: "meal plan" } });
    expect(document.querySelector('[data-composer-linked="query"]')).not.toBeNull();
    expect(screen.getByText(/Linked to a query decision/)).toBeInTheDocument();
  });

  it("files exactly what the prefill describes, metadata included", async () => {
    const { onClose, onFiled } = renderComposer(prefill);
    fireEvent.click(fileTask());

    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).toEqual({
      project: "meals.example",
      title: "Expand pages already earning search demand",
      type: "task",
      priority: 2,
      labels: prefill.labels,
      description: prefill.description,
      metadata: prefill.metadata,
    });

    expect(toasts.success).toHaveBeenCalledWith("Filed mp-9zz", expect.anything());
    expect(onFiled).toHaveBeenCalledWith({ id: "mp-9zz", project: "meals.example" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("opens the task's own page from the toast", async () => {
    renderComposer(prefill);
    expect(screen.getByTestId("where").textContent).toBe("/assets/meals.example");
    fireEvent.click(fileTask());
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());

    // `/tasks/:id` is where every other task id in the Tower leads.
    const options = toasts.success.mock.calls[0]?.[1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Open");
    options.action.onClick();
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/tasks/mp-9zz"),
    );
  });

  it("carries the operator's own edits and their extra labels", async () => {
    renderComposer(prefill);

    fireEvent.change(field("Title"), { target: { value: "Rewrite the recipes hub" } });
    fireEvent.change(field("Type"), { target: { value: "chore" } });
    fireEvent.change(field("Priority"), { target: { value: "0" } });
    fireEvent.change(field("Parent epic"), { target: { value: "mp-1w2" } });
    fireEvent.change(screen.getByLabelText("Done when"), {
      target: { value: "The hub ranks for its own name." },
    });
    fireEvent.change(field("Labels"), { target: { value: "content" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(fileTask());

    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).toMatchObject({
      title: "Rewrite the recipes hub",
      type: "chore",
      priority: 0,
      parent: "mp-1w2",
      acceptance: "The hub ranks for its own name.",
      labels: [...prefill.labels, "content"],
    });
  });

  it("keeps what the operator typed when the row behind it re-renders", () => {
    // A row builds its prefill fresh on every render, so an effect keyed on
    // the prefill object would reset the form whenever anything above it
    // re-rendered and throw the operator's typing away mid-sentence.
    const client = new QueryClient();
    const compose = (p: TaskComposerPrefill) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TaskComposer open onClose={vi.fn()} prefill={p} projects={SPOKES} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(compose({ ...prefill }));

    fireEvent.change(field("Title"), { target: { value: "My own words" } });
    rerender(compose({ ...prefill }));

    expect(field("Title").value).toBe("My own words");
  });

  it("opens a new task on title, project and priority, with the rest under More", () => {
    renderComposer({ project: "root-os" });
    expect(field("Title")).toHaveFocus();
    expect(field("Project").value).toBe("root-os");
    expect(screen.queryByLabelText("Type")).toBeNull();
    expect(screen.queryByLabelText("Description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(field("Type").value).toBe("task");
    expect(screen.getByLabelText("Done when")).toBeInTheDocument();
  });

  it("files with Enter from the title", async () => {
    renderComposer({ project: "root-os" });
    fireEvent.change(field("Title"), { target: { value: "Backups keep a year" } });
    fireEvent.keyDown(field("Title"), { key: "Enter" });
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).toMatchObject({ project: "root-os", title: "Backups keep a year", priority: 2 });
  });

  it("opens More by itself when a handoff filled what lives there", () => {
    renderComposer(prefill);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "true");
    expect(field("Type")).toBeInTheDocument();
    const chip = document.querySelector(`[data-composer-locked-label="${prefill.labels[0]}"]`)!;
    expect(chip.textContent).toContain("Locked label");
    expect(document.body.textContent).not.toContain("cannot be edited");
  });

  it("refuses to file without a project, and says so on the field", async () => {
    renderComposer(null);
    fireEvent.change(field("Title"), { target: { value: "Something worth doing" } });
    fireEvent.click(fileTask());

    expect(
      await screen.findByText("Choose the site whose repo this task belongs to."),
    ).toBeInTheDocument();
    expect(lane.calls).toHaveLength(0);
  });

  it("refuses to file without a title", async () => {
    renderComposer(null);
    fireEvent.change(field("Project"), { target: { value: "root-os" } });
    fireEvent.click(fileTask());

    expect(
      await screen.findByText("A task needs a title somebody could read cold."),
    ).toBeInTheDocument();
    expect(lane.calls).toHaveLength(0);
  });

  it("refuses an epic that belongs to another spoke", async () => {
    renderComposer(prefill);
    fireEvent.change(field("Parent epic"), { target: { value: "ro-l1ed" } });
    fireEvent.click(fileTask());

    expect(
      await screen.findByText("An epic in meals.example starts with `mp-`."),
    ).toBeInTheDocument();
    expect(lane.calls).toHaveLength(0);
  });

  it("shows bd's own refusal rather than a wording invented here", async () => {
    lane.fail = "bd: unknown parent mp-nope";
    const { onClose } = renderComposer(prefill);
    fireEvent.click(fileTask());

    expect(await screen.findByText("bd: unknown parent mp-nope")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("FileTaskButton", () => {
  const render1 = (props: Parameters<typeof FileTaskButton>[0]) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <FileTaskButton {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it("opens the composer, and mounts no form until it does", () => {
    render1({ prefill: null, onFile: async () => ({ id: "ro-1", project: "root-os" }), projects: SPOKES });

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File task" }));
    expect(screen.getByRole("dialog", { name: "File a task" })).toBeInTheDocument();
  });

  it("is disabled with what to do where nothing can write", () => {
    render1({
      prefill: null,
      capabilities: { live: false, reason: READ_ONLY_DEPLOYMENT },
      projects: SPOKES,
    });

    const button = screen.getByRole("button", { name: "File task" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", READ_ONLY_TASKS_HINT);
    // Visible, not hidden: an operator who cannot find the button learns nothing.
    expect(button).toBeInTheDocument();
  });

  // Snapshot health never hides filing; the actual task lane governs writes.
  it("keeps filing available through the live lane before the snapshot connection answers", () => {
    taskSourceMock.connected = null;
    const { container } = render1({ prefill: null, projects: SPOKES });
    expect(container.querySelector("[data-file-task]")).not.toBeNull();
    resetTaskSourceMock();
    const again = render1({ prefill: null, projects: SPOKES });
    expect(again.container.querySelector("[data-file-task]")).not.toBeNull();
  });

  it("names what it is filing, so a table of them does not read as one button", () => {
    render1({ prefill: null, subject: "/recipes", onFile: async () => ({ id: "mp-1", project: "meals.example" }) });
    expect(
      screen.getByRole("button", { name: "File task for /recipes" }),
    ).toBeInTheDocument();
  });
});
