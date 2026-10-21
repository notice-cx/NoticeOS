import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@noticeos/contract/task-card";
import type { LiveTask, LiveTaskDetail, LiveTasksPayload } from "@shared/tasks";
import { cardDraft, cardFromDraft } from "@/routes/tasks/task-card-form";

// `/tasks/:id`'s ranking, checklist and kind: why it ranks, the card's form,
// "Done when" ticked in place, and the Kind fact. The network is mocked, not
// the hooks, as in task-route.test.tsx; Settings answers with a rate.

const api = vi.hoisted(() => ({
  fetchTasksCapabilities: vi.fn(),
  fetchTaskProjects: vi.fn(),
  fetchTask: vi.fn(),
  fetchTasks: vi.fn(),
  updateTask: vi.fn(),
  closeTask: vi.fn(),
  commentOnTask: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({ data: undefined, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: { operatorRateUsdPerMin: 2 } }),
}));
vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-09-04T12:00:00.000Z"),
}));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

import { resetAnswerQueue } from "@/lib/answer-queue";
import { TaskRoute } from "@/routes/TaskRoute";
import { resetTaskSourceMock } from "./task-source-mock";

const ID = "ro-k1nd.2";

const CARD: TaskCard = {
  valuePerMonth: 400,
  likelihood: 0.55,
  reviewMinutes: 20,
  daysToSignal: 28,
  measurability: "cohort",
  kill: { state: "Clicks still flat", date: "2026-11-11" },
  note: "A shorter title lifts clicks on the recipe pages.",
  by: "Example Operator",
  at: "2026-09-03T12:00:00.000Z",
};

function task(over: Partial<LiveTask> = {}): LiveTask {
  return {
    id: ID,
    title: "Shorten the recipe titles",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-09-04T11:00:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
    description: "The titles run long.",
    acceptance: "- [ ] Titles under 60 characters\n- [x] The template reads the new field",
    labels: [],
    ready: true,
    dependencies: [],
    comments: 0,
    metadata: null,
    createdAt: "2026-09-04T09:00:00.000Z",
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...over,
  };
}

function detail(over: Partial<LiveTask> = {}): LiveTaskDetail {
  return { project: "root-os", prefix: "ro", repo: ".", readAt: "2026-09-04T12:00:00.000Z", task: task(over), comments: [] };
}

function board(): LiveTasksPayload {
  return { project: "root-os", prefix: "ro", repo: ".", readAt: "2026-09-04T12:00:00.000Z", tasks: [task()], epics: [] };
}

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/tasks/${ID}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The element once the page has drawn it. */
function found(root: ParentNode, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const element = root.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`Nothing matches ${selector}`);
    return element;
  });
}

/** The Undo the last toast carried, pressed. */
function pressUndo() {
  const options = toasts.success.mock.calls.at(-1)?.[1] as { action?: { label: string; onClick: () => void } } | undefined;
  expect(options?.action?.label).toBe("Undo");
  options?.action?.onClick();
}

function readOnly() {
  api.fetchTasksCapabilities.mockResolvedValue({ live: true, writable: false, reason: null });
}

beforeEach(() => {
  api.fetchTasksCapabilities.mockResolvedValue({ live: true, reason: null });
  api.fetchTaskProjects.mockResolvedValue([]);
  api.fetchTask.mockResolvedValue(detail());
  api.fetchTasks.mockResolvedValue(board());
  api.updateTask.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  resetTaskSourceMock();
  resetAnswerQueue();
});

describe("why it ranks", () => {
  it("leads the work with the card's figures, who recorded them and when, and its note", async () => {
    api.fetchTask.mockResolvedValue(detail({ card: CARD }));
    const { container } = renderTask();
    const section = await found(container, '[data-task-field="Why it ranks"]');
    expect(within(section).getByText("Why it ranks")).toBeInTheDocument();
    const figures = section.querySelector("[data-why-it-ranks]") as HTMLElement;
    expect(within(figures).getByText("At stake")).toBeInTheDocument();
    expect(within(figures).getByText("55%")).toBeInTheDocument();
    expect(within(figures).getByText("Nov 11")).toBeInTheDocument();
    expect(section.querySelector("[data-card-recorded]")).toHaveTextContent("recorded by Example Operator · Sep 3");
    expect(section.querySelector("[data-card-note]")).toHaveTextContent("A shorter title lifts clicks on the recipe pages.");
    // It is the first thing the content card reads, before the description.
    const description = container.querySelector('[data-task-field="Description"]') as HTMLElement;
    expect(section.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[data-task-unranked]")).toBeNull();
  });

  it("reads a card from the task's metadata, and leaves out a caption the card does not carry", async () => {
    const { by: _by, at: _at, note: _note, ...bare } = CARD;
    api.fetchTask.mockResolvedValue(detail({ metadata: { noticeos_card: bare } }));
    const { container } = renderTask();
    const section = await found(container, '[data-task-field="Why it ranks"]');
    expect(section.querySelector("[data-why-it-ranks]")).not.toBeNull();
    expect(section.querySelector("[data-card-recorded]")).toBeNull();
    expect(section.querySelector("[data-card-note]")).toBeNull();
  });

  it("says a task without a card is not ranked, and opens the card's form from that line", async () => {
    const { container } = renderTask();
    const line = await found(container, "[data-task-unranked]");
    expect(line).toHaveTextContent("Not ranked: no card says what it is worth.");
    expect(line.closest('[data-task-field="Description"]')).not.toBeNull();
    expect(container.querySelector('[data-task-field="Why it ranks"]')).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Add why it ranks" }));
    const form = screen.getByRole("form", { name: "Why it ranks" });
    expect(within(form).getByRole("spinbutton", { name: "Predicted change a month" })).toHaveValue(null);
    expect(container.querySelector("[data-task-unranked]")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Why it ranks" })).toBeNull();
    expect(container.querySelector("[data-task-unranked]")).not.toBeNull();
  });

  it("shows nothing about ranking where the task cannot be edited", async () => {
    readOnly();
    const { container } = renderTask();
    await screen.findByText("The titles run long.");
    expect(container.querySelector("[data-task-unranked]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add why it ranks" })).toBeNull();
  });

  it("shows the rule under the field at fault, and writes the card once it holds", async () => {
    const { container } = renderTask();
    const line = await found(container, "[data-task-unranked]");
    fireEvent.click(within(line).getByRole("button", { name: "Add why it ranks" }));
    const form = screen.getByRole("form", { name: "Why it ranks" });
    const value = within(form).getByRole("spinbutton", { name: "Predicted change a month" });
    fireEvent.change(value, { target: { value: "300" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    // The first missing figure is named under its own field.
    const problem = form.querySelector('[data-card-problem="likelihood"]') as HTMLElement;
    expect(problem).toHaveTextContent("Must be a number");
    expect(within(form).getByRole("spinbutton", { name: "Likely to pay off, in percent" })).toHaveAttribute("aria-invalid", "true");
    expect(api.updateTask).not.toHaveBeenCalled();

    // Typed as a percent, the range reads in percent.
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Likely to pay off, in percent" }), { target: { value: "150" } });
    expect(form.querySelector('[data-card-problem="likelihood"]')).toHaveTextContent("Must be between 1 and 99");
    fireEvent.click(within(form).getByRole("button", { name: "75%" }));
    expect(within(form).getByRole("button", { name: "75%" })).toHaveAttribute("aria-pressed", "true");
    expect(form.querySelector('[data-card-problem="reviewMinutes"]')).toHaveTextContent("Must be a number");
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Your minutes to review" }), { target: { value: "15" } });
    fireEvent.click(within(form).getByRole("button", { name: "4 weeks" }));
    expect(within(form).getByRole("spinbutton", { name: "Signal in, in days" })).toHaveValue(28);
    fireEvent.change(within(form).getByRole("combobox", { name: "Measured as" }), { target: { value: "holdout" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Revenue family" }), { target: { value: "ads" } });
    // A kill date without its state is half a criterion.
    fireEvent.change(within(form).getByLabelText("Kill date"), { target: { value: "2026-12-01" } });
    expect(form.querySelector('[data-card-problem="killState"]')).toHaveTextContent("Required");
    fireEvent.change(within(form).getByRole("textbox", { name: "Kill if still true" }), { target: { value: "Clicks still flat" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Note" }), { target: { value: "Shorter titles lift clicks." } });
    expect(form.querySelector("[data-card-problem]")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1));
    expect(api.updateTask).toHaveBeenCalledWith(ID, {
      card: {
        valuePerMonth: 300,
        likelihood: 0.75,
        reviewMinutes: 15,
        daysToSignal: 28,
        measurability: "holdout",
        revenueFamily: "ads",
        kill: { state: "Clicks still flat", date: "2026-12-01" },
        note: "Shorter titles lift clicks.",
      },
    });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Saved — why it ranks", expect.anything()));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Why it ranks" })).toBeNull());
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { card: null }));
  });

  it("edits a recorded card in a form that opens with its figures, and Undo restores them", async () => {
    api.fetchTask.mockResolvedValue(detail({ card: CARD }));
    renderTask();
    fireEvent.click(await screen.findByRole("button", { name: "Edit why it ranks" }));
    const form = screen.getByRole("form", { name: "Why it ranks" });
    expect(within(form).getByRole("spinbutton", { name: "Predicted change a month" })).toHaveValue(400);
    expect(within(form).getByRole("button", { name: "55%" })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("button", { name: "4 weeks" })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("combobox", { name: "Measured as" })).toHaveValue("cohort");
    expect(within(form).getByRole("textbox", { name: "Kill if still true" })).toHaveValue("Clicks still flat");
    // Nothing changed is nothing to save.
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Predicted change a month" }), { target: { value: "650" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1));
    const written = (api.updateTask.mock.calls[0]?.[1] as { card: TaskCard }).card;
    expect(written.valuePerMonth).toBe(650);
    // Who recorded it and when are stamped by the writer that stores it.
    expect(written.by).toBeUndefined();
    expect(written.at).toBeUndefined();
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { card: CARD }));
  });
});

describe("the card's draft", () => {
  it("opens a new card blank and Not measurable, and round-trips a recorded one", () => {
    expect(cardDraft(null)).toMatchObject({ valuePerMonth: "", likelihood: "", measurability: "unmeasured", revenueFamily: "" });
    const draft = cardDraft({ ...CARD, buildMinutes: 90, durability: 0.8 });
    expect(draft.likelihood).toBe("55");
    const result = cardFromDraft(draft, { ...CARD, buildMinutes: 90, durability: 0.8 });
    expect(result.problem).toBeNull();
    // The figures the form does not show are carried over.
    expect(result.card).toMatchObject({ buildMinutes: 90, durability: 0.8, likelihood: 0.55, kill: CARD.kill });
  });

  it("names the field at fault in the form's own units", () => {
    const blank = cardDraft(null);
    expect(cardFromDraft(blank, null).problem).toEqual({ field: "valuePerMonth", message: "Must be a number" });
    const days = { ...blank, valuePerMonth: "10", likelihood: "50", reviewMinutes: "5", daysToSignal: "2.5" };
    expect(cardFromDraft(days, null).problem).toEqual({ field: "daysToSignal", message: "Must be a whole number" });
    const date = { ...days, daysToSignal: "14", killState: "Flat", killDate: "" };
    expect(cardFromDraft(date, null).problem).toEqual({ field: "killDate", message: "Must be a calendar date, YYYY-MM-DD" });
  });
});

describe("Done when, ticked in place", () => {
  it("counts the ticked lines beside the eyebrow and writes the one line a box flips", async () => {
    const { container } = renderTask();
    const field = await found(container, '[data-task-field="Done when"]');
    await waitFor(() => expect(within(field).getByRole("button", { name: "Titles under 60 characters" })).toBeEnabled());
    expect(field.querySelector("[data-task-field-caption]")).toHaveTextContent("1 of 2");
    const box = within(field).getByRole("button", { name: "Titles under 60 characters" });
    expect(box).toHaveAttribute("aria-pressed", "false");
    expect(within(field).getByRole("button", { name: "The template reads the new field" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(box);
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, {
      acceptance: "- [x] Titles under 60 characters\n- [x] The template reads the new field",
    }));
    // The flipped line is drawn while the write is out.
    await waitFor(() => expect(field.querySelector("[data-task-field-caption]")).toHaveTextContent("2 of 2"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Saved — the acceptance criteria", expect.anything()));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { acceptance: task().acceptance }));
  });

  it("draws the stored text again when the write is refused", async () => {
    api.updateTask.mockRejectedValueOnce(new Error("refused"));
    const { container } = renderTask();
    const field = await found(container, '[data-task-field="Done when"]');
    const box = await within(field).findByRole("button", { name: "Titles under 60 characters" });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    await waitFor(() => expect(field.querySelector("[data-task-field-caption]")).toHaveTextContent("1 of 2"));
  });

  it("is read-only where the task cannot be edited, and plain dash lines keep their boxes with no count", async () => {
    readOnly();
    api.fetchTask.mockResolvedValue(detail());
    const first = renderTask();
    const field = await found(first.container, '[data-task-field="Done when"]');
    await within(field).findByText("Titles under 60 characters");
    expect(within(field).queryByRole("button", { name: "Titles under 60 characters" })).toBeNull();
    expect(within(field).getByRole("img", { name: "Done" })).toBeInTheDocument();
    first.unmount();

    api.fetchTasksCapabilities.mockResolvedValue({ live: true, reason: null });
    api.fetchTask.mockResolvedValue(detail({ acceptance: "- Facts render\n- Undo works" }));
    const { container } = renderTask();
    const plain = await found(container, '[data-task-field="Done when"] [data-checklist]');
    expect(within(plain).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Facts render", "Undo works"]);
    expect(container.querySelector('[data-task-field="Done when"] [data-task-field-caption]')).toBeNull();
    expect(within(plain).queryByRole("button")).toBeNull();
  });
});

describe("the Kind fact", () => {
  it("sits after Priority and records one of the five kinds, Undo going back to none", async () => {
    const { container } = renderTask();
    const chip = await screen.findByRole("button", { name: "Kind: Not recorded" });
    const facts = container.querySelector("[data-task-facts]") as HTMLElement;
    const labels = [...facts.querySelectorAll("dt")].map((term) => term.textContent);
    expect(labels.indexOf("Kind")).toBe(labels.indexOf("Priority") + 1);
    fireEvent.click(chip);
    const editor = await screen.findByRole("dialog");
    expect(within(editor).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Content data", "Copy", "Template", "Feature", "Infrastructure", "Not recorded"]);
    fireEvent.click(within(editor).getByRole("option", { name: "Template" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { changeClass: "template" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Saved — the kind", expect.anything()));
    pressUndo();
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ID, { changeClass: null }));
  });

  it("reads the kind from metadata, clears it with Not recorded, and is a plain fact when read-only", async () => {
    api.fetchTask.mockResolvedValue(detail({ metadata: { noticeos_change_class: "copy" } }));
    const first = renderTask();
    fireEvent.click(await screen.findByRole("button", { name: "Kind: Copy" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("option", { name: "Not recorded" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ID, { changeClass: null }));
    first.unmount();

    readOnly();
    api.fetchTask.mockResolvedValue(detail({ changeClass: "infra" }));
    const { container } = renderTask();
    const facts = await found(container, "[data-task-facts]");
    const value = await within(facts).findByText("Infrastructure");
    expect(value.closest("[data-fact-chip]")).toHaveAttribute("data-fact-chip", "plain");
    expect(within(facts).queryByRole("button", { name: /^Kind/ })).toBeNull();
  });
});

describe("the comment box", () => {
  it("says what Markdown the comment takes", async () => {
    renderTask();
    expect(await screen.findByRole("textbox", { name: "Add a comment" })).toHaveAttribute(
      "placeholder",
      "Comment · Markdown: tables, images and checklists work; task ids and paths become links",
    );
  });
});
