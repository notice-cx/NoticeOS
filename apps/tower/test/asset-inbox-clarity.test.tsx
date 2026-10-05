import { fireEvent, render, screen } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AssetOperatorPosture } from "@shared/asset-detail";
import { NeedsYou } from "@/routes/asset-detail/OverviewTab";

const nowMs = Date.parse("2026-09-06T00:00:00Z");
const base: AssetOperatorPosture = {
  capturedAt: "2026-09-05T23:59:30Z", waiting: 0, urgent: 0, items: [],
};
function view(over: Partial<AssetOperatorPosture> = {}) {
  return render(<MemoryRouter><NeedsYou assetId="meals.example" operator={{ ...base, ...over }} nowMs={nowMs} /></MemoryRouter>);
}
describe("asset operator inbox evidence", () => {
  it("states the scope of a fresh empty inbox", () => {
    view();
    expect(screen.getByText("Nothing waiting")).toBeVisible();
    expect(screen.getByRole("button", { name: "About this task preview" })).toHaveTextContent("Read 30s ago");
    expect(screen.queryByText("Task status does not verify that each request is still needed.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About this task preview" }));
    expect(screen.getByText("Task status read 30s ago")).toBeVisible();
    expect(screen.getByText("Task status does not verify that each request is still needed.")).toBeVisible();
  });
  it("never presents an unknown inbox as nothing needing the operator", () => {
    view({ waiting: null, urgent: null });
    expect(screen.getByText("Count unavailable")).toBeVisible();
    expect(screen.getByText(/Tasks not read yet/)).toBeVisible();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });
  it("withdraws an empty verdict when the snapshot is outdated", () => {
    view({ capturedAt: "2026-09-05T23:00:00Z" });
    expect(screen.getByText("Task status outdated")).toBeVisible();
    expect(screen.getByText(/Last known: 0 urgent/)).toBeVisible();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });
  it("does not convert a missing capture time into a fresh zero", () => {
    view({ capturedAt: null });
    expect(screen.getByText(/Tasks not read yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "About this task preview" })).toHaveTextContent("Time unknown");
  });
  it("discloses missing preview rows and links to complete task details", () => {
    view({ waiting: 20, urgent: 2, items: [{
      id: "mp-example", title: "Confirm the current release", priority: 1, status: "open",
      issueType: "task", assignee: null, updatedAt: "2026-08-06T00:00:00Z",
      closedAt: null, parent: null, deferUntil: null,
    }] });
    expect(screen.getByText(/2 urgent · 20 waiting · 1 captured in preview/)).toBeVisible();
    expect(screen.getByText("updated")).toBeVisible();
    expect(screen.getByRole("link", { name: /Confirm the current release/ })).toHaveAttribute("href", "/tasks/mp-example");
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/assets/meals.example/tasks");
  });
  it("does not call a nonempty count clear when row details are missing", () => {
    view({ waiting: 4, urgent: 1 });
    expect(screen.getByText("Task details not captured")).toBeVisible();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });
  it("keeps known requests visible when one inbox source fails", () => {
    view({ waiting: null, urgent: null, items: [{
      id: "mp-known", title: "Approve the proposed change", priority: 1, status: "open",
      issueType: "task", assignee: null, updatedAt: "2026-08-06T00:00:00Z",
      closedAt: null, parent: null, deferUntil: null,
    }] });
    expect(screen.getByText("At least 1 waiting · total unavailable")).toBeVisible();
    expect(screen.getByRole("link", { name: /Approve the proposed change/ })).toBeVisible();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });
  it("marks retained partial requests as last known when outdated", () => {
    view({ waiting: null, urgent: null, capturedAt: "2026-09-05T23:00:00Z", items: [{
      id: "mp-known", title: "Approve the proposed change", priority: 1, status: "open",
      issueType: "task", assignee: null, updatedAt: "2026-08-06T00:00:00Z",
      closedAt: null, parent: null, deferUntil: null,
    }] });
    expect(screen.getByText("Last known: at least 1 waiting · total unavailable")).toBeVisible();
    expect(screen.getByText("Outdated snapshot")).toBeVisible();
  });
});
