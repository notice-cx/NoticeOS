import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { PulseMetric } from "@shared/asset-detail";
import { ProductUse } from "@/routes/asset-detail/OverviewTab";
import { productReportSummary } from "@shared/product-reports";

const observed = [53, 43, 67, 145, 126, 275, 144, 59];
const dates = ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
const metric: PulseMetric = {
  name: "signups", last24h: 59, avg7d: 121.85714285714286, total: 4338,
  series: observed.map((v, index) => ({ t: dates[index]!, v })),
};
const props = {
  assetId: "meadow.example", metrics: [metric], reportDate: "2026-09-05",
  receivedAt: "2026-09-05T02:30:03.980Z", nowMs: Date.parse("2026-09-06T00:18:58Z"),
};
function renderProduct(over: Partial<typeof props> = {}, range = 28) {
  return render(<MemoryRouter initialEntries={[`/assets/meadow.example?range=${range}`]}><ProductUse {...props} {...over} /></MemoryRouter>);
}

describe("product report clarity", () => {
  it("separates the latest 24-hour count, previous reports and raw history", () => {
    renderProduct();
    const section = screen.getByRole("region", { name: "Product use" });
    expect(section).toHaveTextContent("Latest reported 24 hours");
    expect(section).toHaveTextContent("Report 21h ago");
    expect(section).toHaveTextContent("21h ago");
    expect(section).toHaveTextContent("59in 24h");
    expect(section).toHaveTextContent("Prior 7 reports: 122 / day");
    expect(section).toHaveTextContent("Daily counts");
    expect(screen.queryByText(/comparison: 7 reports/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About product reports" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("comparison: 7 reports · Aug 29–Sep 4, 2026");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Report received");
    fireEvent.keyDown(window, { key: "Escape" });
    const chart = within(section).getByRole("img", { name: /Signups trend/ });
    fireEvent.focus(chart);
    expect(within(section).getByRole("status")).toHaveTextContent("59");
    expect(within(section).getByRole("status")).not.toHaveTextContent("122");
  });

  it("uses observed preceding reports, never the producer's fallback average", () => {
    const first = { ...metric, avg7d: 59, series: [{ t: "2026-09-05", v: 59 }] };
    renderProduct({ metrics: [first] });
    expect(screen.getByText("No earlier reports to compare")).toBeVisible();
    expect(screen.queryByText(/59 \/ day/)).toBeNull();
  });

  it("preserves gaps and calls sparse history reports rather than seven days", () => {
    const sparse = { ...metric, series: [metric.series[0]!, metric.series[2]!, metric.series[7]!] };
    const summary = productReportSummary(sparse, props.reportDate);
    expect(summary.previousCount).toBe(2);
    expect(summary.previousMean).toBe(60);
    expect(summary.missingDays).toBe(5);
    expect(summary.series.find((point) => point.t === "2026-09-01")?.v).toBeNull();
    renderProduct({ metrics: [sparse] });
    expect(screen.getByText(/Prior 2 reports:/)).toBeVisible();
    expect(screen.getByText("5 missing days")).toBeVisible();
    expect(screen.queryByText(/7.day/)).toBeNull();
  });

  it("makes old report age visible rather than implying a current 24-hour window", () => {
    renderProduct({ nowMs: Date.parse("2026-09-10T12:00:00Z") });
    expect(screen.getByRole("button", { name: "About product reports" })).toHaveTextContent("Report 5d ago · Outdated");
    expect(screen.queryByText("Last 24 hours")).toBeNull();
  });

  it("does not invent report age or comparison dates when timestamps are missing", () => {
    render(<MemoryRouter><ProductUse {...props} receivedAt={null} reportDate={null} /></MemoryRouter>);
    expect(screen.getByText("Report time unknown")).toBeVisible();
    expect(screen.getByText("No earlier reports to compare")).toBeVisible();
  });

  it("keeps report scope independent of traffic range and preserves the navigation range", () => {
    renderProduct({}, 7);
    expect(screen.getByText(/Prior 7 reports:/)).toHaveTextContent("122 / day");
    expect(screen.getByRole("link", { name: "Growth →" })).toHaveAttribute("href", "/assets/meadow.example/growth?range=7");
  });

  it("never treats missing metrics as zeros", () => {
    render(<MemoryRouter><ProductUse {...props} metrics={[{ ...metric, last24h: null, series: [] }]} /></MemoryRouter>);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.getByText("No report history")).toBeVisible();
  });
});
