import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskHubSpoke } from "@shared/settings";
import type { NewTask } from "@/lib/api";

/**
 * The composer's newer fields: the kind of change, why the task is worth
 * doing (optional as a whole, checked by the contract when started), Done
 * when as a checklist, and the description's Markdown preview. What the lane
 * receives is read off the HTTP request, never off the form.
 */

const lane = { calls: [] as NewTask[] };
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tasks/capabilities") return Response.json({ live: true, reason: null });
    if (url === "/api/tasks" && init?.method === "POST") {
      const task = JSON.parse(String(init.body)) as NewTask;
      lane.calls.push(task);
      return Response.json({ id: "ro-9zz", project: task.project });
    }
    return Response.json({ error: "Unexpected test request" }, { status: 404 });
  }));
});

// No `/api/settings` here: the rate falls back to 2 USD a minute.
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: undefined }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

import { TaskComposer, type TaskComposerPrefill, acceptanceLines, acceptanceText } from "@/components/TaskComposer";

const SPOKES: TaskHubSpoke[] = [
  { asset: "meadow.example", prefix: "md", database: "md", repo: "../meadow.example" },
  { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
];

afterEach(() => {
  lane.calls.length = 0;
  vi.unstubAllGlobals();
});

function renderComposer(prefill: TaskComposerPrefill | null = { project: "root-os", title: "Backups keep a year" }) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TaskComposer open onClose={vi.fn()} prefill={prefill} projects={SPOKES} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded") !== "true") {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
  }
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const fileTask = () => press("File task");

/** Every figure a card needs, plus the optional ones. */
function fillWhy() {
  type("Predicted change, a month", "300");
  press("55%");
  type("Your minutes to review", "15");
  press("4 wk");
  type("Measured as", "cohort");
  type("Revenue family", "ads");
  type("Kill criterion", "Sessions still under baseline");
  type("Kill date", "2026-12-01");
  type("Note", "More clicks reach the affiliate pages");
}

describe("the composer's new fields", () => {
  it("starts with no change classification or ranking inputs selected", () => {
    renderComposer();
    const kind = screen.getByRole("group", { name: "Kind of change" });
    expect(within(kind).getByRole("button", { name: "Not recorded" })).toHaveAttribute("aria-pressed", "true");

    const why = screen.getByRole("region", { name: "Why it is worth doing" });
    for (const pill of ["30%", "55%", "75%", "90%", "2 wk", "4 wk", "8 wk"]) {
      expect(within(why).getByRole("button", { name: pill })).toHaveAttribute("aria-pressed", "false");
    }
    expect((within(why).getByLabelText("Measured as") as HTMLSelectElement).value).toBe("");

    expect(screen.getByRole("button", { name: "Write" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "false");
  });

  it("sends no card and no kind of change when neither was touched", async () => {
    renderComposer();
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).not.toHaveProperty("card");
    expect(lane.calls[0]).not.toHaveProperty("changeClass");
    expect(lane.calls[0]).not.toHaveProperty("acceptance");
  });

  it("sends the card the section describes, the likelihood as a fraction, and ranks it live", async () => {
    renderComposer();
    fillWhy();
    expect(screen.getByRole("button", { name: "55%" })).toHaveAttribute("aria-pressed", "true");
    expect(field("Likely to pay off").value).toBe("55");
    expect(screen.getByRole("button", { name: "4 wk" })).toHaveAttribute("aria-pressed", "true");
    expect(field("Signal in").value).toBe("28");
    // 0.55 × $300 over 15 minutes at $2 a minute, over four weeks.
    expect(screen.getByText("Score 1.4 · policy v1.0")).toBeInTheDocument();
    expect(document.querySelector("[data-composer-why] [data-why-it-ranks]")).not.toBeNull();

    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.card).toEqual({
      valuePerMonth: 300,
      likelihood: 0.55,
      reviewMinutes: 15,
      daysToSignal: 28,
      measurability: "cohort",
      revenueFamily: "ads",
      kill: { state: "Sessions still under baseline", date: "2026-12-01" },
      note: "More clicks reach the affiliate pages",
    });
  });

  it("takes a typed likelihood and a typed signal, and a loss avoided as a negative value", async () => {
    renderComposer();
    type("Predicted change, a month", "-120");
    type("Likely to pay off", "62");
    type("Your minutes to review", "5");
    type("Signal in", "10");
    type("Measured as", "holdout");
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.card).toEqual({ valuePerMonth: -120, likelihood: 0.62, reviewMinutes: 5, daysToSignal: 10, measurability: "holdout" });
  });

  it("shows the rule under a bad likelihood and refuses to file until it is fixed", async () => {
    renderComposer();
    fillWhy();
    type("Likely to pay off", "120");
    fileTask();
    const why = screen.getByRole("region", { name: "Why it is worth doing" });
    expect(await within(why).findByText("Must be between 1 and 99")).toBeInTheDocument();
    expect(field("Likely to pay off")).toHaveAttribute("aria-invalid", "true");
    expect(within(why).getByText("Fill the five figures to rank it.")).toBeInTheDocument();
    fileTask();
    expect(lane.calls).toHaveLength(0);

    // The rule follows the typing once File task has been pressed.
    press("75%");
    expect(within(why).queryByText("Must be between 1 and 99")).toBeNull();
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.card?.likelihood).toBe(0.75);
  });

  it("names the first missing figure of a started section, and opens More to show it", async () => {
    renderComposer();
    type("Predicted change, a month", "300");
    press("More");
    expect(screen.queryByLabelText("Likely to pay off")).toBeNull();
    fileTask();
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(field("Likely to pay off")).toHaveAttribute("aria-invalid", "true");
    expect(lane.calls).toHaveLength(0);
  });

  it("sends Done when as a checklist, one line a box, blank lines dropped", async () => {
    renderComposer();
    type("Done when", "Backups restore on a fresh machine");
    press("Another line");
    press("Another line");
    type("Done when, line 3", "A year of copies is kept");
    // Enter starts a line below and moves to it; Backspace on it takes it away again.
    fireEvent.keyDown(field("Done when, line 3"), { key: "Enter" });
    await waitFor(() => expect(field("Done when, line 4")).toHaveFocus());
    fireEvent.keyDown(field("Done when, line 4"), { key: "Backspace" });
    await waitFor(() => expect(field("Done when, line 3")).toHaveFocus());
    expect(screen.queryByLabelText("Done when, line 4")).toBeNull();
    expect(document.querySelectorAll("[data-composer-acceptance] .lucide-square")).toHaveLength(3);

    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.acceptance).toBe("- [ ] Backups restore on a fresh machine\n- [ ] A year of copies is kept");
  });

  it("splits a prefilled Done when into the editor's lines", async () => {
    renderComposer({ project: "root-os", title: "From a finding", acceptance: "The page ranks again\n\nClicks are back to the usual range" });
    expect(field("Done when").value).toBe("The page ranks again");
    expect(field("Done when, line 2").value).toBe("Clicks are back to the usual range");
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.acceptance).toBe("- [ ] The page ranks again\n- [ ] Clicks are back to the usual range");
  });

  it("reads the markers off a checklist it is handed, and writes them back once", () => {
    expect(acceptanceLines("- [ ] First\n- [x] Second\n* Third\n  ")).toEqual(["First", "Second", "Third"]);
    expect(acceptanceLines("")).toEqual([""]);
    expect(acceptanceText(["First", " ", "Second "])).toBe("- [ ] First\n- [ ] Second");
    expect(acceptanceText(["", ""])).toBe("");
  });

  it("previews the description as Markdown in the same box, and goes back to writing", () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "## Why backups matter\n\nA restore is the proof." } });
    press("Preview");
    const preview = document.querySelector("[data-composer-preview]") as HTMLElement;
    expect(within(preview).getByRole("heading", { name: "Why backups matter" })).toBeInTheDocument();
    expect(within(preview).getByText("A restore is the proof.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Description")).toBeNull();
    press("Write");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("## Why backups matter\n\nA restore is the proof.");
  });

  it("sends the kind of change once picked", async () => {
    renderComposer();
    press("Copy");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Not recorded" })).toHaveAttribute("aria-pressed", "false");
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]!.changeClass).toBe("copy");
  });

  it("sends no kind of change once it is set back to Not recorded", async () => {
    renderComposer();
    press("Infrastructure");
    press("Not recorded");
    expect(screen.getByRole("button", { name: "Not recorded" })).toHaveAttribute("aria-pressed", "true");
    fileTask();
    await waitFor(() => expect(lane.calls).toHaveLength(1));
    expect(lane.calls[0]).not.toHaveProperty("changeClass");
  });
});
