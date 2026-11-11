// Core hub status stays truthful, separate from optional provider connections.
import { render, screen } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { TaskSourceStatus } from "@shared/task-source";
import { TaskHubUnavailable, TaskSourceRows } from "@/components/TaskSourceSection";

const NOW = Date.parse("2026-09-12T12:00:00Z");

describe("the core task hub status", () => {
  it.each([
    [{ connected: false, projects: 0, readAt: null, failing: 0 }, "not-connected", "No projects"],
    [{ connected: false, projects: 1, readAt: null, failing: 0 }, "collecting", "Waiting for first read"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:59:30Z", failing: 0 }, "working", "Available"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:50:00Z", failing: 0 }, "overdue", "Stale"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:59:30Z", failing: 1 }, "failing", "Unavailable"],
  ] satisfies [Omit<TaskSourceStatus, "id">, string, string][])("uses actual hub evidence: %j", (status, kind, label) => {
    render(<TaskSourceRows payload={{ connected: status.connected ? "snapshots" : null, sources: [{ id: "snapshots", ...status }] }} nowMs={NOW} />);
    expect(document.querySelector("[data-task-hub-state]")).toHaveAttribute("data-task-hub-state", kind);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(`${status.projects} ${status.projects === 1 ? "project" : "projects"}`)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(document.querySelector("[data-integration-tile]")).toBeNull();
  });

  it("exposes partial failures beside the available core hub", () => {
    render(<TaskSourceRows payload={{ connected: "snapshots", sources: [{ id: "snapshots", connected: true, projects: 2, readAt: "2026-09-12T11:59:30Z", failing: 1 }] }} nowMs={NOW} />);
    expect(screen.getByText("Available")).toBeVisible();
    expect(screen.getByText("1 unavailable")).toBeVisible();
  });

  it("leads missing core projects to their existing settings surface", () => {
    render(<MemoryRouter><TaskHubUnavailable /></MemoryRouter>);
    expect(screen.getByText("No task projects available")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage task projects →" })).toHaveAttribute("href", "/settings/task-projects");
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });
});
