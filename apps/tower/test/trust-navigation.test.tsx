import { fireEvent, render, screen } from "./render";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NO_READS, sourceReadings, sourcesSummary } from "@shared/connection-status";
import { integrationLabel } from "@shared/integrations";
import type { CardDataSource } from "@shared/wall";
import { ListRow } from "@/components/surface/ListPanel";
import { tabPath } from "@/routes/asset-detail/AssetTabs";
import { taskReturnPath } from "@/routes/TaskRoute";

describe("truthful connection state", () => {
  const nowMs = Date.parse("2026-09-05T12:05:00.000Z");
  const observed = { id: "nightly-report", label: "Nightly report", state: "live" as const, observedAt: "2026-09-05T12:00:00.000Z", verification: { kind: "collection-success" as const, laneId: "nightly-report" } };
  const summary = (sources: CardDataSource[]) => sourcesSummary(sourceReadings("example.test", sources, NO_READS, nowMs));
  it("reports real data independently of any manual lifecycle", () => {
    expect(summary([observed]).counts.working).toBe(1);
    expect(summary([{ ...observed, state: "degraded" }])).toMatchObject({ tally: "1 overdue", attention: "warn" });
    expect(summary([{ ...observed, state: "needs-setup" }]).tally).toBe("1 not connected");
    expect(summary([{ id: "uptime", label: "Uptime", state: "skipped" }])).toMatchObject({ tally: "", attention: null });
  });
  it("keeps failures visible alongside working connections", () => {
    expect(sourcesSummary([{ kind: "working" }, { kind: "failing" }])).toMatchObject({ tally: "1 working · 1 failing", attention: "error" });
  });
  it("does not treat a configured source as proof of data collection", () => {
    for (const id of ["uptime", "clarity", "ga4"]) {
      const result = summary([{ id, label: id, state: "live", observedAt: null }]);
      expect(result.counts.working).toBe(0);
      expect(result.tally).toBe("");
    }
  });
  it("uses concise provider names without altering unknown catalog entries", () => {
    expect(integrationLabel("github-app", "Act substrate + crown-jewel credential")).toBe("GitHub");
    expect(integrationLabel("custom", "My provider")).toBe("My provider");
  });
});

describe("navigation context", () => {
  it.each([7, 90])("keeps the %i-day view across every asset tab", (days) => {
    expect(tabPath("meadow.example", "growth", `?range=${days}&status=closed&project=other`)).toBe(`/assets/meadow.example/growth?range=${days}`);
    expect(tabPath("meadow.example", "sources", `?range=${days}`)).toBe(`/assets/meadow.example/sources?range=${days}`);
    expect(tabPath("meadow.example", "overview", `?range=${days}`)).toBe(`/assets/meadow.example?range=${days}`);
  });
  it("normalizes default and invalid ranges", () => {
    expect(tabPath("meadow.example", "overview", "?range=28")).toBe("/assets/meadow.example");
    expect(tabPath("meadow.example", "overview", "?range=999")).toBe("/assets/meadow.example");
  });
  it("accepts internal return destinations and rejects external or malformed ones", () => {
    expect(taskReturnPath({ returnTo: "/assets/meadow.example?range=90" })).toBe("/assets/meadow.example?range=90");
    expect(taskReturnPath({ returnTo: "/?range=7" })).toBe("/?range=7");
    for (const returnTo of ["https://example.com", "//example.com", "javascript:alert(1)", "/unrelated", null]) {
      expect(taskReturnPath({ returnTo })).toBe("/tasks");
    }
  });
  it("opens the exact task with return context instead of expanding", () => {
    function LocationProbe() {
      const location = useLocation();
      return <output>{JSON.stringify({ path: location.pathname, state: location.state })}</output>;
    }
    render(<MemoryRouter><ul><ListRow title="Investigate traffic drop" to="/tasks/ro-123" returnTo="/assets/meadow.example?range=90" value={0}>Unused preview</ListRow></ul><LocationProbe /></MemoryRouter>);
    const link = screen.getByRole("link", { name: /Investigate traffic drop/ });
    expect(link).not.toHaveAttribute("aria-expanded");
    expect(screen.getByText("0")).toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.getByRole("status")).toHaveTextContent('"path":"/tasks/ro-123"');
    expect(screen.getByRole("status")).toHaveTextContent('"returnTo":"/assets/meadow.example?range=90"');
    expect(screen.queryByText("Unused preview")).toBeNull();
  });
});
