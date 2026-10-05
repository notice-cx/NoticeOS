import { fireEvent, render, screen } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { WatchWindowItem } from "@shared/asset-detail";
import { WatchesStrip } from "@/routes/asset-detail/WatchComposer";

const closed: WatchWindowItem = {
  id: "window-example",
  metricIntegration: "ga4",
  metric: "sessions",
  scope: null,
  refKind: "annotation",
  ref: "task-a1",
  registeredAt: "2026-05-01T00:00:00.000Z",
  nextCheckDate: null,
  readings: 1,
  checks: 1,
  status: "closed",
  outcome: "inconclusive",
  outcomeNote: "Change was inside normal variation.",
  closedAt: "2026-05-29T00:00:00.000Z",
  note: null,
};

function show(watch: WatchWindowItem) {
  render(
    <MemoryRouter initialEntries={["/activity"]}>
      <Routes>
        <Route path="/activity" element={
          <WatchesStrip watches={{ open: [], closed: [watch], history: [] }} beads={[]} />
        } />
        <Route path="/tasks/task-a2.1" element={<h1>Recorded readback task</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /sessions/i }));
}

describe("a closed watch's recorded readback", () => {
  it("opens the existing task without claiming a decision or successful outcome", () => {
    show({ ...closed, readbackTaskId: "task-a2.1" });
    const link = screen.getByRole("link", { name: "Readback task-a2.1" });
    expect(link).toHaveAttribute("href", "/tasks/task-a2.1");
    expect(screen.queryByText(/decision recorded|ship confirmed|resolved/i)).toBeNull();
    expect(screen.getByText("Change was inside normal variation.")).toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: "Recorded readback task" })).toBeInTheDocument();
  });

  it.each([undefined, "", "../tasks", "--help"])("does not invent a link for %s", (readbackTaskId) => {
    show({ ...closed, readbackTaskId });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Change was inside normal variation.")).toBeInTheDocument();
  });
});
