import { fireEvent, render, screen, waitFor, within } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FactChip } from "@/components/FactChip";
import { TaskTimeline, timelineOrder } from "@/components/TaskTimeline";
import { DependencyGraph } from "@/components/viz/DependencyGraph";
import { EpicSegments, epicSegments } from "@/routes/tasks/epic-tasks";
import { GuideText, TaskTextRefsProvider, guideSections } from "@/routes/tasks/task-markdown";

// The task page's drawn pieces on their own, with invented values.

function inRouter(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("FactChip", () => {
  const choices = [{ value: "open", label: "Open" }, { value: "blocked", label: "Blocked" }];

  it("is a plain fact with nothing to press when it cannot be edited", () => {
    inRouter(
      <FactChip label="Status" valueText="Open" readOnly editor={{ kind: "choice", value: "open", choices }} onSave={() => true}>
        Open
      </FactChip>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Open").closest("[data-fact-chip]")).toHaveAttribute("data-fact-chip", "plain");
  });

  it("saves a choice on press and closes, and names the press by its fact and value", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Status" valueText="Open" editor={{ kind: "choice", value: "open", choices }} onSave={onSave}>
        Open
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
    const editor = await screen.findByRole("dialog");
    expect(within(editor).getByRole("listbox", { name: "Status" })).toBeInTheDocument();
    expect(within(editor).getByRole("option", { name: "Open" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(editor).getByRole("option", { name: "Blocked" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("blocked"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves between choices with the arrow keys", async () => {
    inRouter(
      <FactChip label="Status" valueText="Open" editor={{ kind: "choice", value: "open", choices }} onSave={() => true}>
        Open
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
    const list = within(await screen.findByRole("dialog")).getByRole("listbox");
    within(list).getByRole("option", { name: "Open" }).focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(list).getByRole("option", { name: "Blocked" }));
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(within(list).getByRole("option", { name: "Open" }));
  });

  it("writes a typed value on Enter, and nothing on Escape", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Add a label" valueText="" editor={{ kind: "text", value: "", inputLabel: "New label" }} onSave={onSave}>
        Label
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    let input = within(await screen.findByRole("dialog")).getByRole("textbox", { name: "New label" });
    fireEvent.change(input, { target: { value: "ops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    input = within(await screen.findByRole("dialog")).getByRole("textbox", { name: "New label" });
    fireEvent.change(input, { target: { value: " ops " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("ops"));
  });

  it("splits into the value's link and the editor's press when it leads somewhere", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Parent epic" valueText="Ship it" to="/tasks/os-1" editor={{ kind: "choice", value: "os-1", choices: [{ value: "os-1", label: "Ship it" }, { value: "", label: "No epic" }] }} onSave={onSave}>
        Ship it
      </FactChip>,
    );
    expect(screen.getByRole("link", { name: "Ship it" })).toHaveAttribute("href", "/tasks/os-1");
    fireEvent.click(screen.getByRole("button", { name: "Change parent epic" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("option", { name: "No epic" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(""));
  });

  it("offers a date's presets and its clear, and takes a typed day on Enter", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Parked until" valueText="Oct 20" editor={{ kind: "date", value: "2026-10-20", presets: [{ label: "Tomorrow", value: "2026-10-17" }], clearLabel: "Not parked" }} onSave={onSave}>
        Oct 20
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Parked until: Oct 20" }));
    const editor = await screen.findByRole("dialog");
    expect(within(editor).getAllByRole("option").map((option) => option.textContent)).toEqual(["Tomorrow", "Not parked"]);
    const day = within(editor).getByLabelText("Date");
    fireEvent.change(day, { target: { value: "2026-11-02" } });
    fireEvent.keyDown(day, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("2026-11-02"));
  });
});

describe("epicSegments", () => {
  const row = (id: string, status: string) => ({
    id, title: id, status, priority: 2, issueType: "task", assignee: null, updatedAt: null, closedAt: null,
    parent: "os-1", deferUntil: null, project: "system", labels: [], ready: false, awaitType: null,
  });

  it("counts every task the epic holds, the ones the read leaves out included", () => {
    const segments = epicSegments({ children: [row("os-1.3", "open"), row("os-1.2", "in_progress"), row("os-1.4", "closed")], self: "os-1.2", next: "os-1.3", closed: 3, total: 6 });
    expect(segments).toHaveLength(6);
    expect(segments.map((segment) => segment.state)).toEqual(["earlier", "earlier", "done", "active", "waiting", "unknown"]);
    expect(segments.find((segment) => segment.self)?.id).toBe("os-1.2");
    expect(segments.find((segment) => segment.next)?.id).toBe("os-1.3");
  });

  it("draws a held task in the caution ink and a closed one in plain ink", () => {
    inRouter(<EpicSegments segments={epicSegments({ children: [row("os-1.1", "blocked"), row("os-1.2", "closed")], closed: 1, total: 2 })} label="1 of 2 children closed" closed={1} total={2} />);
    const bar = screen.getByRole("progressbar", { name: "1 of 2 children closed" });
    expect(bar.querySelector('[data-segment="blocked"] span')?.className).toContain("bg-warn");
    expect(bar.querySelector('[data-segment="done"] span')?.className).toContain("bg-foreground");
  });
});

describe("guideSections", () => {
  it("splits a description at the guide's labels and its steps heading", () => {
    expect(guideSections("Intro line.\n\nWHAT: a\nmore a\n\nFIX: b\n\n## Steps to Reproduce\n1. c")).toEqual([
      { label: null, body: "Intro line." },
      { label: "What", body: "a\nmore a" },
      { label: "Fix", body: "b" },
      { label: "Steps to reproduce", body: "1. c" },
    ]);
  });

  it("leaves a description without the labels alone, and ignores a label inside code", () => {
    expect(guideSections("## What\n\nJust prose.")).toBeNull();
    expect(guideSections("```\nWHAT: not a label\n```")).toBeNull();
  });

  it("draws known task ids as links and paths as chips, and leaves other words alone", () => {
    inRouter(
      <TaskTextRefsProvider value={{ prefixes: ["os"], taskHref: (id) => `/tasks/${id}`, repoUrl: "https://example.com/org/repo" }}>
        <GuideText source={"WHERE: apps/a/b.tsx:12, read-only docs/x.md and os-8f7p.2 (not xx-1234 or https://example.com/a.js)."} />
      </TaskTextRefsProvider>,
    );
    expect(screen.getByRole("link", { name: "os-8f7p.2" })).toHaveAttribute("href", "/tasks/os-8f7p.2");
    expect(screen.getByRole("link", { name: "apps/a/b.tsx:12" })).toHaveAttribute("href", "https://example.com/org/repo/blob/HEAD/apps/a/b.tsx#L12");
    // A path without a line is a chip, not a link.
    expect(screen.getByText("docs/x.md").tagName).toBe("CODE");
    expect(document.querySelectorAll("[data-path-ref]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-task-ref]")).toHaveLength(1);
  });
});

describe("DependencyGraph", () => {
  const glyph = <span>·</span>;
  it("places what the item waits on left and what waits on it right, each card opening its page", () => {
    inRouter(
      <DependencyGraph
        subject={{ id: "os-1.2", caption: "This task", mark: glyph }}
        before={[{ id: "os-1.1", title: "First", mark: glyph, href: "/tasks/os-1.1", edge: "idle", said: "Closed" }]}
        after={[{ id: "os-1.3", title: "Third", mark: glyph, href: "/tasks/os-1.3", edge: "broken" }]}
        beforeLabel="Blocked by"
        afterLabel="Blocks"
        ariaLabel="What os-1.2 waits on and what waits on it"
      />,
    );
    const graph = screen.getByRole("figure", { name: "What os-1.2 waits on and what waits on it" });
    const columns = [...graph.querySelectorAll("[data-dependency-column]")].map((column) => column.getAttribute("data-dependency-column"));
    expect(columns).toEqual(["before", "subject", "after"]);
    expect(within(graph.querySelector('[data-dependency-column="before"]') as HTMLElement).getByRole("link", { name: "os-1.1 First" })).toHaveAttribute("href", "/tasks/os-1.1");
    expect(within(graph.querySelector('[data-dependency-column="after"]') as HTMLElement).getByRole("link", { name: "os-1.3 Third" })).toBeInTheDocument();
    expect(within(graph).getByRole("link", { name: "os-1.1 First" })).toHaveAccessibleDescription("Closed");
    expect([...graph.querySelectorAll("ol li")].map((item) => item.textContent)).toEqual(["os-1.1 → os-1.2 (waiting)", "os-1.2 → os-1.3 (held)"]);
  });
});

describe("TaskTimeline", () => {
  it("lists dated moments in time order, then an undated one, with the composer last", () => {
    const nowMs = Date.parse("2026-09-04T12:00:00Z");
    inRouter(
      <TaskTimeline
        nowMs={nowMs}
        ariaLabel="What happened"
        composer={<textarea aria-label="Add a comment" />}
        entries={[
          { id: "c2", at: null, kind: "comment", label: "Comment from b", said: "Comment from b", who: { name: "b", model: null } },
          { id: "claimed", at: "2026-09-04T10:00:00Z", kind: "claimed", label: "Claimed by claude", said: "Claimed by claude", who: { name: "claude", model: "Opus 5.5" } },
          { id: "filed", at: "2026-09-04T09:00:00Z", kind: "filed", label: "Filed", said: "Filed" },
        ]}
      />,
    );
    const list = document.querySelector("[data-task-activity]") as HTMLElement;
    expect([...list.querySelectorAll("[data-entry-id]")].map((entry) => entry.getAttribute("data-entry-id"))).toEqual(["filed", "claimed", "c2"]);
    expect(list.querySelector('[data-entry-id="claimed"] [data-entry-agent]')).toHaveAttribute("data-entry-agent", "anthropic");
    expect(list.querySelector('[data-entry-id="c2"] [data-age="missing"]')).toHaveTextContent("at an unknown time");
    expect(list.lastElementChild).toHaveAttribute("data-task-timeline-composer");
    expect(timelineOrder([{ at: "2026-01-02T00:00:00Z" }, { at: null }, { at: "2026-01-01T00:00:00Z" }]).map((entry) => entry.at))
      .toEqual(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", null]);
  });
});
