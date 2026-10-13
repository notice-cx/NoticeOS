import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
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

// Home's work section names what the agents did, in one line, from the
// snapshot alone.
describe("AgentsLine", () => {
  it("sums each agent's closes across projects and links to the Agents page", () => {
    render(<MemoryRouter><AgentsLine work={work([
      { workers: [{ id: "claude", model: "Opus 5.5", closedRecent: 9, inProgress: 2 }, { id: "Mara", model: null, closedRecent: 4, inProgress: 0 }] },
      { workers: [{ id: "claude", model: "Sonnet 5.5", closedRecent: 3, inProgress: 0 }, { id: "codex", model: "GPT-5-Codex", closedRecent: 2, inProgress: 1 }] },
    ])} /></MemoryRouter>);
    expect(screen.getByText("Agents closed 14 tasks in 7 days")).toBeInTheDocument();
    expect(screen.getByText(/claude/u).textContent).toContain("12");
    expect(screen.queryByText(/Mara/u)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents →" })).toHaveAttribute("href", "/agents");
  });

  it("draws nothing until some worker has named a model", () => {
    const { container } = render(<MemoryRouter><AgentsLine work={work([{ workers: [{ id: "Mara", model: null, closedRecent: 4, inProgress: 0 }] }])} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
