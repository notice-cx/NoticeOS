import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionExplorationPeriod, SessionExplorationSnapshot } from "@noticeos/contract/session-exploration";
import { explorationBranches, SessionExploration } from "@/components/SessionExploration";
import { SESSION_EXPLORATION_DEMO_REPORTS, SESSION_EXPLORATION_DEMO_SNAPSHOT } from "@/components/SessionExploration.fixtures";
import { readSessionExplorationReport } from "@noticeos/contract/session-exploration";

const period: SessionExplorationPeriod = {
  startDate: "2026-10-12", endDate: "2026-10-18", quality: "complete", coveredDays: 7, expectedDays: 7,
  sessions: 1000, observedSessions: 1000, definitionId: "sections-v1", timeZone: "UTC", sessionTimeoutMinutes: 30,
  surfaces: [{ id: "articles", label: "Articles" }, { id: "tools", label: "Tools" }],
  paths: [
    { surfaces: ["articles", "tools", "articles"], sessions: 300, ending: "exit" },
    { surfaces: ["articles"], sessions: 400, ending: "exit" },
    { surfaces: ["tools"], sessions: 200, ending: "exit" },
    { surfaces: ["tools", "articles", "tools"], sessions: 100, ending: "exit" },
  ],
};
const snapshot: SessionExplorationSnapshot = {
  journeyId: "exploration", generatedAt: "2026-10-19T02:00:00Z", current7: period, prior7: period,
  current28: period, prior28: period,
  weekly: [
    { ...period, startDate: "2026-10-05", endDate: "2026-10-11", paths: period.paths.map((path, index) => ({ ...path, sessions: index === 0 ? 290 : index === 1 ? 410 : path.sessions })) },
    period,
  ],
};

describe("session exploration", () => {
  it("builds eight complete varied weeks from valid synthetic daily histograms", () => {
    expect(SESSION_EXPLORATION_DEMO_REPORTS).toHaveLength(64);
    expect(SESSION_EXPLORATION_DEMO_REPORTS.every((report) => readSessionExplorationReport(report) !== null)).toBe(true);
    expect(SESSION_EXPLORATION_DEMO_SNAPSHOT.weekly).toHaveLength(8);
    expect(SESSION_EXPLORATION_DEMO_SNAPSHOT.weekly.every((week) => week.quality === "complete")).toBe(true);
    expect(new Set(SESSION_EXPLORATION_DEMO_SNAPSHOT.weekly.map((week) => week.paths.find((path) => path.surfaces.join("/") === "articles/tools")?.sessions)).size).toBeGreaterThan(3);
  });
  it("conserves branches on the all-session scale and retains returns by position", () => {
    const branches = explorationBranches(period);
    expect(branches.filter((branch) => branch.depth === 0).reduce((sum, branch) => sum + branch.count, 0)).toBe(1000);
    expect(branches.find((branch) => branch.surface === "articles" && branch.depth === 0)?.height).toBe(70);
    expect(branches.find((branch) => branch.surface === "articles" && branch.depth === 2)?.height).toBe(30);
    expect(branches.filter((branch) => branch.ending === "exit").reduce((sum, branch) => sum + branch.count, 0)).toBe(1000);
  });

  it("counts surface audiences once per session and exposes keyboard and touch inspection", () => {
    const { container } = render(<SessionExploration snapshot={snapshot} rangeDays={7}/>);
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(container.querySelector(".session-summary > div:nth-child(2)")).toHaveTextContent("40%");
    fireEvent.click(screen.getByRole("button", { name: "Articles · 80% of all sessions" }));
    expect(screen.getByText("Each session counts once here, including sessions that return to this section.")).toBeInTheDocument();
    const tools = screen.getAllByRole("button", { name: /Tools, 30% of all sessions, inspect section/ })[0]!;
    fireEvent.keyDown(tools, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Tools · 60% of all sessions" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Articles → Tools → Articles/ }));
    expect(screen.getByText("Selected path")).toBeInTheDocument();
    expect(screen.getAllByText("Exited · includes a return")).toHaveLength(2);
  });

  it("keeps selected path identity after a corrected report reorders counts", () => {
    const {container, rerender}=render(<SessionExploration snapshot={snapshot} rangeDays={7}/>);
    fireEvent.click(screen.getByRole("button", {name:/Articles → Tools → Articles/}));
    rerender(<SessionExploration snapshot={{...snapshot,generatedAt:"2026-10-19T03:00:00Z",current7:{...period,paths:[...period.paths].reverse()}}} rangeDays={7}/>);
    expect(container.querySelector(".session-inspection")).toHaveTextContent("Articles → Tools → Articles");
    expect(container.querySelector(".session-inspection")).toHaveTextContent("300 sessions");
  });

  it("keeps missing destinations distinct from exits and complete history visible", () => {
    const partial = { ...period, quality: "partial" as const, coveredDays: 5, paths: period.paths.slice(0, 3) };
    render(<SessionExploration snapshot={{ ...snapshot, current7: partial }} rangeDays={7}/>);
    expect(screen.getByText("Partial coverage")).toBeInTheDocument();
    expect(screen.getByText("10% · destinations not reported")).toBeInTheDocument();
    expect(screen.getByText(/90% have a recorded exit/)).toHaveTextContent("100 sessions have an unresolved destination or later path.");
    expect(screen.getByRole("img", { name: /weekly percentage of all sessions/ })).toBeInTheDocument();
  });

  it("shows compatible complete weeks when the current period is unavailable and retains historical gaps", () => {
    const empty = { ...period, quality: "unavailable" as const, definitionId: null, sessions: null, observedSessions: null, paths: [] };
    const gap = { ...period, quality: "partial" as const, coveredDays: 6 };
    render(<SessionExploration snapshot={{ ...snapshot, current7: empty, weekly: [snapshot.weekly[0]!, gap] }} rangeDays={7}/>);
    expect(screen.getByText("Session paths are unavailable")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /weekly percentage of all sessions/ })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("limits the diagram to eight paths while keeping the remainder inspectable and distinct from missing destinations", () => {
    const paths = Array.from({ length: 10 }, (_, index) => {
      const categories = ["articles", "tools", "search"]; let previous = 0; const surfaces = [categories[previous]!];
      for (let position = 0; position < 4; position++) { previous = (previous + 1 + ((index >> position) & 1)) % 3; surfaces.push(categories[previous]!); }
      return {surfaces, sessions: 10, ending: "exit" as const};
    });
    const many = { ...period, sessions: 125, observedSessions: 100, quality: "partial" as const, paths, surfaces: [...period.surfaces, {id:"search",label:"Search"}] };
    const { container, rerender } = render(<SessionExploration snapshot={{ ...snapshot, current7: many }} rangeDays={7}/>);
    expect(screen.getByText(/16% · Other recorded paths/)).toBeInTheDocument();
    expect(screen.getByText("20% · destinations not reported")).toBeInTheDocument();
    expect(container.querySelectorAll(".session-node[data-ending=exit]")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 paths" }));
    expect(container.querySelectorAll(".session-path-list > button[aria-pressed]")).toHaveLength(10);
    const articleTone = screen.getByRole("button", { name: /Articles · 80%/ }).getAttribute("style");
    rerender(<SessionExploration snapshot={{ ...snapshot, current7: { ...many, surfaces: [...many.surfaces].reverse() } }} rangeDays={7}/>);
    expect(screen.getByRole("button", { name: /Articles · 80%/ }).getAttribute("style")).toBe(articleTone);
  });

  it("does not turn missing counts into zero and uses a visible adaptive history axis", () => {
    const { rerender } = render(<SessionExploration snapshot={{ ...snapshot, current7: { ...period, quality: "unavailable", sessions: null, observedSessions: null, paths: [], reason: "No session source connected." } }} rangeDays={7}/>);
    expect(screen.getByText("Session paths are unavailable")).toBeInTheDocument();
    expect(screen.getByText("No session source connected.")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    rerender(<SessionExploration snapshot={snapshot} rangeDays={7}/>);
    expect(screen.getByRole("img", { name: /weekly percentage of all sessions. Y axis/ })).toHaveAttribute("aria-label", expect.stringMatching(/Y axis 38\.\d+% to 40\.\d+%/));
  });
});
