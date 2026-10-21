import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkPayload, WorkProject } from "@shared/work";
import { AgentsLine } from "@/routes/HomeRoute";

function work(projects: Partial<WorkProject>[]): WorkPayload {
  return {
    generatedAt: "2026-10-16T12:00:00.000Z", capturedAt: "2026-10-16T12:00:00.000Z", pollCadenceHours: 1 / 60, owner: "config/beads.json",
    historyDays: 0, projects: projects.map((over, index) => ({ asset: `site-${index}.example.com`, prefix: "ex", name: `Site ${index}`, ok: true, error: null,
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
      history: { days: [], open: [], inProgress: [], blocked: [], closed: [] }, priorities: null, epics: null,
      ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [], ...over })) as WorkProject[],
  } as WorkPayload;
}

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
afterEach(cleanup);
const agent = (id: string, closedRecent: number, inProgress = 0) => ({ id, model: "example-model", closedRecent, inProgress });

// The Home summary shows known work separately from an unread snapshot.
describe("AgentsLine", () => {
  it("sums each agent's completed and active tasks across projects and excludes human work", () => {
    const { container } = render(<MemoryRouter><AgentsLine nowMs={NOW} work={work([
      { workers: [agent("agent-a", 9, 2), { id: "Mara", model: null, closedRecent: 40, inProgress: 10 }] },
      { workers: [agent("agent-a", 3), agent("agent-b", 2, 1)] },
    ])} /></MemoryRouter>);
    expect(container.querySelector("[data-agents-closed]")).toHaveTextContent(/^14$/);
    expect(container.querySelector("[data-agents-active]")).toHaveTextContent(/^3$/);
    expect(screen.getByText("Closed in 7 days")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "agent-a: 12 closed, 2 in progress" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "agent-b: 2 closed, 1 in progress" })).toBeInTheDocument();
    expect(screen.queryByText("Mara")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents →" })).toHaveAttribute("href", "/agents");
    expect(screen.queryByText("partial read")).not.toBeInTheDocument();
  });

  it("shows maker icons by worker name and all of a generic worker's reported models", () => {
    render(<MemoryRouter><AgentsLine nowMs={NOW} work={work([
      { workers: [agent("claude-reviewer", 4), { ...agent("worker-1", 3), model: "unrecognized-model" }, { ...agent("worker-2", 2), model: "GPT-5-Codex" }] },
      { workers: [{ ...agent("worker-1", 1), model: "Opus 5.5" }] },
    ])} /></MemoryRouter>);
    const named = screen.getByRole("listitem", { name: "claude-reviewer: 4 closed, 0 in progress" });
    const inferred = screen.getByRole("listitem", { name: "worker-1: 4 closed, 0 in progress" });
    for (const row of [named, inferred]) {
      expect(row.querySelector('[data-agent-maker="anthropic"]')).toHaveAttribute("aria-hidden", "true");
      expect(row.querySelector("img")).toHaveAttribute("src", "/agents/claude.svg");
      expect(row.querySelector("img")).toHaveAttribute("alt", "");
    }
    expect(within(named).getByText("claude-reviewer")).toBeVisible();
    expect(within(inferred).getByText("worker-1")).toBeVisible();
    expect(screen.getByRole("listitem", { name: "worker-2: 2 closed, 0 in progress" }).querySelector("img")).toHaveAttribute("src", "/agents/openai.png");
  });

  it("uses the original orange Claude tile with a light glyph alongside visible text", () => {
    const svg = readFileSync(path.resolve(import.meta.dirname, "../public/agents/claude.svg"), "utf8");
    const sources = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../public/agents/sources.json"), "utf8")) as Record<string, { sha256: string }>;
    expect(svg).toMatch(/<rect[^>]+fill="#D97757"/);
    expect(svg).toMatch(/<path[^>]+fill="#FAF9F5"/);
    expect(createHash("sha256").update(svg).digest("hex")).toBe(sources["claude.svg"]!.sha256);
  });

  it("bounds the worker preview to three rows while keeping totals for all agents", () => {
    const { container } = render(<MemoryRouter><AgentsLine nowMs={NOW} work={work([
      { workers: [agent("fourth", 1), agent("first", 4), agent("third", 2), agent("second", 3)] },
    ])} /></MemoryRouter>);
    expect(container.querySelector("[data-agents-closed]")).toHaveTextContent(/^10$/);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByRole("listitem").map((row) => row.getAttribute("aria-label"))).toEqual([
      "first: 4 closed, 0 in progress", "second: 3 closed, 0 in progress", "third: 2 closed, 0 in progress",
    ]);
    expect(screen.getByText("1 more agent")).toBeInTheDocument();
  });

  it("shows a measured zero for a known idle agent", () => {
    const { container } = render(<MemoryRouter><AgentsLine nowMs={NOW} work={work([{ workers: [agent("agent-a", 0)] }])} /></MemoryRouter>);
    expect(container.querySelector("[data-agents-closed]")).toHaveTextContent(/^0$/);
    expect(container.querySelector("[data-agents-active]")).toHaveTextContent(/^0$/);
  });

  it.each([
    [undefined, false, "Reading agent activity…"],
    [undefined, true, "Could not read agent activity."],
    [{ ...work([{ workers: [] }]), capturedAt: null }, false, "No agent activity read yet."],
    [work([{ workers: [] }]), false, "No agent activity reported."],
    [work([{}]), false, "Agent activity not fully read."],
  ] as const)("keeps unknown, failed and measured-empty states distinct", (payload, failed, message) => {
    const { container } = render(<MemoryRouter><AgentsLine nowMs={NOW} work={payload} failed={failed} /></MemoryRouter>);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(container.querySelector("[data-agents-closed]")).toBeNull();
    expect(screen.getByRole("link", { name: "Agents →" })).toHaveAttribute("href", "/agents");
  });

  it("qualifies a partial total and excludes workers from a failed project", () => {
    const { container } = render(<MemoryRouter><AgentsLine nowMs={NOW} work={work([
      { workers: [agent("agent-a", 3, 2)] },
      { ok: false, workers: [agent("agent-b", 900, 800)] },
    ])} /></MemoryRouter>);
    expect(container.querySelector("[data-agents-closed]")).toHaveTextContent(/^3$/);
    expect(container.querySelector("[data-agents-active]")).toHaveTextContent(/^2$/);
    expect(screen.getByText("partial read")).toBeInTheDocument();
    expect(screen.queryByText("agent-b")).not.toBeInTheDocument();
  });

  it("keeps a stale reading visible and names its age qualification", () => {
    render(<MemoryRouter><AgentsLine nowMs={NOW + 3_600_000} work={work([{ workers: [agent("agent-a", 3)] }])} /></MemoryRouter>);
    const card = screen.getByRole("region", { name: "Agents" });
    expect(within(card).getByText("outdated")).toBeInTheDocument();
    expect(card.querySelector("[data-agents-closed]")).toHaveTextContent(/^3$/);
  });
});
