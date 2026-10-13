import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WallAgents } from "@/components/wall/WallAgents";
import { wallAgentsOf } from "../worker/wall-payload";
import type { BeadsSnapshot, SnapshotProject } from "../worker/beads-snapshot";

const project = (over: Partial<SnapshotProject>): SnapshotProject => ({
  asset: "example.com", prefix: "ex", ok: true, error: null,
  counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
  priorities: null, epics: null, ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [], waitingUrgent: null,
  panelReview: undefined, handoffs: undefined, ...over,
});

// The TV's Agents widget reads the snapshot alone: each agent and model's
// closes summed across projects, the leader first.
describe("wallAgentsOf", () => {
  it("sums agents across projects and leaves people out", () => {
    const snapshot: BeadsSnapshot = { capturedAt: "2026-10-16T12:00:00.000Z", projects: [
      project({ workers: [{ id: "claude", model: "Opus 5.5", closedRecent: 6, inProgress: 1 }, { id: "Mara", model: null, closedRecent: 5, inProgress: 2 }] }),
      project({ asset: "b.example.com", workers: [{ id: "claude", model: "Opus 5.5", closedRecent: 4, inProgress: 0 }, { id: "codex", model: "GPT-5-Codex", closedRecent: 3, inProgress: 1 }] }),
      project({ asset: "c.example.com", ok: false, workers: [{ id: "claude", model: "Opus 5.5", closedRecent: 99, inProgress: 0 }] }),
    ] };
    expect(wallAgentsOf(snapshot)).toEqual({ closed: 13, inProgress: 2, capturedAt: "2026-10-16T12:00:00.000Z", standings: [
      { id: "claude", model: "Opus 5.5", closed: 10, inProgress: 1 }, { id: "codex", model: "GPT-5-Codex", closed: 3, inProgress: 1 },
    ] });
  });

  it("is null without a snapshot or an agent", () => {
    expect(wallAgentsOf(null)).toBeNull();
    expect(wallAgentsOf({ capturedAt: "2026-10-16T12:00:00.000Z", projects: [project({ workers: [{ id: "Mara", model: null, closedRecent: 1, inProgress: 0 }] })] })).toBeNull();
  });
});

describe("WallAgents", () => {
  it("ranks each agent and model with its place and count", () => {
    render(<WallAgents agents={{ closed: 13, inProgress: 2, capturedAt: null, standings: [
      { id: "claude", model: "Opus 5.5", closed: 10, inProgress: 1 }, { id: "codex", model: "GPT-5-Codex", closed: 3, inProgress: 1 }] }} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("1")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("claude · Opus 5.5");
    expect(rows[1]).toHaveTextContent("codex · GPT-5-Codex3");
    expect(screen.getByText("13 closed · 2 in progress")).toBeInTheDocument();
  });

  it("says so when no agent has named a model", () => {
    render(<WallAgents agents={null} />);
    expect(screen.getByText("No agent has named its model yet")).toBeInTheDocument();
  });
});
