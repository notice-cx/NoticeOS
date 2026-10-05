// Core hub status stays truthful, separate from optional provider connections.
import { render, screen } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { TaskSourceStatus } from "@shared/task-source";
import { TaskHubUnavailable, TaskProjectSteps, TaskSourceRows, taskProjectInitCommand } from "@/components/TaskSourceSection";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const HUB = { host: "127.0.0.1", port: 3308, user: "fixture", dataDir: ".fixture-hub" };

describe("the core task hub status", () => {
  it.each([
    [{ connected: false, projects: 0, readAt: null, failing: 0 }, "not-connected", "No projects"],
    [{ connected: false, projects: 1, readAt: null, failing: 0 }, "collecting", "Waiting for first read"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:59:30Z", failing: 0 }, "working", "Available"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:50:00Z", failing: 0 }, "overdue", "Stale"],
    [{ connected: true, projects: 1, readAt: "2026-09-12T11:59:30Z", failing: 1 }, "failing", "Unavailable"],
  ] satisfies [Omit<TaskSourceStatus, "id">, string, string][])("uses actual hub evidence: %j", (status, kind, label) => {
    render(<TaskSourceRows payload={{ connected: status.connected ? "beads" : null, sources: [{ id: "beads", ...status }] }} nowMs={NOW} />);
    expect(document.querySelector("[data-task-hub-state]")).toHaveAttribute("data-task-hub-state", kind);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(`${status.projects} ${status.projects === 1 ? "project" : "projects"}`)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(document.querySelector("[data-integration-tile]")).toBeNull();
  });

  it("exposes partial failures beside the available core hub", () => {
    render(<TaskSourceRows payload={{ connected: "beads", sources: [{ id: "beads", connected: true, projects: 2, readAt: "2026-09-12T11:59:30Z", failing: 1 }] }} nowMs={NOW} />);
    expect(screen.getByText("Available")).toBeVisible();
    expect(screen.getByText("1 unavailable")).toBeVisible();
  });

  it("leads missing core projects to their existing settings surface", () => {
    render(<MemoryRouter><TaskHubUnavailable /></MemoryRouter>);
    expect(screen.getByText("No task projects available")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage task projects →" })).toHaveAttribute("href", "/settings#task-hub");
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });
});

describe("the additional project init command", () => {
  it("names the database only when it differs from the prefix", () => {
    expect(taskProjectInitCommand({ prefix: "ex", database: "ex" }, HUB)).not.toContain("--database");
    expect(taskProjectInitCommand({ prefix: "ex", database: "ex_tasks" }, HUB)).toContain("--prefix ex --database ex_tasks");
    expect(taskProjectInitCommand({ prefix: "ex", database: "ex" }, null)).toBeNull();
  });

  it("uses the declared host helper for passworded project setup and refuses shell syntax in identifiers", () => {
    const hub = { ...HUB, initCommand: "'/fixture/node' '/fixture/scripts/dolt-project.mjs' --home '/fixture/home'" };
    expect(taskProjectInitCommand({ prefix: "ex", database: "example_tasks" }, hub))
      .toBe(`${hub.initCommand} --repo . --prefix ex --database example_tasks`);
    expect(taskProjectInitCommand({ prefix: "ex;echo", database: "example_tasks" }, hub)).toBeNull();
    expect(taskProjectInitCommand({ prefix: "ex", database: "$(echo)" }, hub)).toBeNull();
  });
});

describe("the remaining project setup steps", () => {
  const spoke = { asset: "example", prefix: "ex", database: "example_tasks", repo: "/fixture/project" };

  it("shows three steps when the host helper already standardizes the spoke config", () => {
    const hub = { ...HUB, initCommand: "'/fixture/node' '/fixture/scripts/dolt-project.mjs' --home '/fixture/home'" };
    render(<TaskProjectSteps spoke={spoke} hub={hub} />);
    expect(screen.getByText("example is mapped — three steps left")).toBeVisible();
    expect(Array.from(document.querySelectorAll("[data-checklist-step]"), node => node.getAttribute("data-checklist-step")))
      .toEqual(["1", "2", "3"]);
    expect(screen.getByText(taskProjectInitCommand(spoke, hub)!)).toBeVisible();
    expect(screen.getByText("Initialize a new task database")).toBeVisible();
    expect(screen.getByText("Review measurement windows")).toBeVisible();
    expect(screen.getByText("Link the checkout here")).toBeVisible();
    expect(screen.queryByText("Keep it on the shared database")).toBeNull();
    expect(screen.queryByText(/\.beads\/config\.yaml/)).toBeNull();
    expect(screen.queryByText(/no-git-ops: true/)).toBeNull();
  });

  it.each([HUB, null])("retains the four-step manual config path without a host helper: %j", hub => {
    render(<TaskProjectSteps spoke={spoke} hub={hub} />);
    expect(screen.getByText("example is mapped — four steps left")).toBeVisible();
    expect(Array.from(document.querySelectorAll("[data-checklist-step]"), node => node.getAttribute("data-checklist-step")))
      .toEqual(["1", "2", "3", "4"]);
    expect(screen.getByText("Keep it on the shared database")).toBeVisible();
    expect(screen.getByText("File · /fixture/project/.beads/config.yaml")).toBeVisible();
    expect(screen.getByText("sync.remote: …")).toBeVisible();
    expect(screen.getByText(/no-git-ops: true/)).toHaveTextContent("import.auto: false");
    expect(screen.getByText("Review measurement windows")).toBeVisible();
    expect(screen.getByText("Link the checkout here")).toBeVisible();
  });

  it("prepares instructions in the existing step without inventing reviewed measurement state", () => {
    const hub = { ...HUB, initCommand: "'/fixture/node' '/fixture/scripts/dolt-project.mjs' --home '/fixture/home'",
      contextCommand: "'/fixture/node' '/fixture/scripts/project-context.mjs' --repo . --write" };
    render(<TaskProjectSteps spoke={spoke} hub={hub} />);
    expect(screen.getByText("Prepare project instructions")).toBeVisible();
    expect(screen.getByText(hub.contextCommand)).toBeVisible();
    expect(document.querySelectorAll('[data-checklist-step]')).toHaveLength(3);
    expect(screen.queryByText(/none registered/i)).toBeNull();
  });
});
