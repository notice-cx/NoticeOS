import { fireEvent, render, screen } from "./render";
import { describe, expect, it } from "vitest";
import { AnalysisEvidence, RecommendationFacts } from "@/components/AnalysisEvidence";
import { recommendationValidity } from "@shared/recommendation-validity";

const nowMs = Date.parse("2026-09-06T00:00:00Z");
const snapshot = { generatedAt: "2026-08-05T00:00:00Z", windowStart: "2026-07-08", windowEnd: "2026-08-04" };

describe("saved analysis evidence clock", () => {
  it("shows the analysis age and actual evidence dates without claiming live validity", () => {
    render(<AnalysisEvidence snapshot={snapshot} nowMs={nowMs} />);
    // Nothing is known against the analysis, so its line is its age alone
    // (bead ro-ujb9.135); the state is the first fact inside.
    expect(screen.getByRole("button", { name: "About this saved analysis" })).toHaveTextContent(/^Analysis 32d ago$/);
    expect(screen.queryByText(/Analysis saved Aug 5/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About this saved analysis" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Saved Aug 5, 2026");
    expect(tooltip).toHaveTextContent("Evidence Jul 8–Aug 4, 2026");
    // The state is a chip, never a disclaimer sentence (bead `ro-ujb9.96.6.8`).
    expect(tooltip).toHaveTextContent("Not rechecked");
    expect(tooltip).not.toHaveTextContent("Refreshing this page");
  });
  it("draws each source's analyzed window and latest report as a table row", () => {
    render(
      <RecommendationFacts subject="page:https://example.test/a" validity={recommendationValidity(
        { kind: "page", key: "https://example.test/a", sources: [
          { source: "gsc/page", windowStart: "2026-07-25", windowEnd: "2026-07-31" },
          { source: "dataforseo/serp-panel", windowStart: null, windowEnd: null },
        ] },
        { generatedAt: "2026-08-05T00:00:00Z", sources: { available: true, truncated: false, reports: [
          { source: "gsc/page", reportDate: "2026-09-04", collectedAt: "2026-09-05T10:00:00Z", status: "success" },
          { source: "dataforseo/serp-panel", reportDate: "2026-09-04", collectedAt: "2026-09-05T10:00:00Z", status: "error" },
        ] }, handoffs: [], taskSnapshotAt: null, decisions: [], annotations: { items: [], olderCount: 0 } },
        nowMs,
      )} />,
    );
    const rows = document.querySelectorAll<HTMLElement>("[data-fact='source']");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Search Console");
    expect(rows[0]).toHaveTextContent("Jul 25–31");
    expect(rows[0]!.querySelector("[data-latest]")).toHaveAttribute("data-latest", "newer");
    expect(rows[1]).toHaveTextContent("DataForSEO");
    expect(rows[1]).toHaveTextContent("—");
    expect(rows[1]!.querySelector("[data-latest]")).toHaveAttribute("data-latest", "failed");
    expect(screen.getByText("Newer source reports")).toBeVisible();
    expect(screen.getByText("Tasks not checked")).toBeVisible();
  });
  it("does not reset an analysis clock when the page renders again", () => {
    const view = render(<AnalysisEvidence snapshot={snapshot} nowMs={nowMs} />);
    view.rerender(<AnalysisEvidence snapshot={snapshot} nowMs={nowMs + 86_400_000} />);
    expect(screen.getByRole("button", { name: "About this saved analysis" })).toHaveTextContent("33d ago");
  });
  it("updates only when a new analysis is supplied", () => {
    const view = render(<AnalysisEvidence snapshot={snapshot} nowMs={nowMs} />);
    view.rerender(<AnalysisEvidence snapshot={{ ...snapshot, generatedAt: "2026-09-05T23:00:00Z", windowEnd: "2026-09-05" }} nowMs={nowMs} />);
    expect(screen.getByRole("button", { name: "About this saved analysis" })).toHaveTextContent("1h ago");
    fireEvent.click(screen.getByRole("button", { name: "About this saved analysis" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Saved Sep 5, 2026");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Evidence Jul 8–Sep 5, 2026");
  });
  it.each(["", "unreadable", "2027-01-01T00:00:00Z"])("treats invalid or future analysis time %s as unknown", (generatedAt) => {
    render(<AnalysisEvidence snapshot={{ ...snapshot, generatedAt }} nowMs={nowMs} />);
    expect(screen.getByText(/Analysis date unknown/)).toBeVisible();
    expect(screen.queryByText(/0s ago/)).toBeNull();
  });
});
