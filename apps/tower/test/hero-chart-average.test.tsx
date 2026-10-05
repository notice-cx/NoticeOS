import { fireEvent, render, screen, within } from "./render";
import { describe, expect, it } from "vitest";
import { HeroChart } from "@/components/surface/HeroChart";

const date = (day: number) => new Date(Date.UTC(2026, 8, day)).toISOString().slice(0, 10);
const reports = (count: number) => Array.from({ length: count }, (_, index) => ({ t: date(index + 1), v: index + 1 }));
const coordinates = (path: Element) => [...path.getAttribute("d")!.matchAll(/[ML]([\d.]+) /g)].map((match) => Number(match[1]));
const line = (name: string, kind = "line") => document.querySelector(`[data-hero-${kind}="${name}"]`)!;

async function openData(range: number) {
  fireEvent.click(screen.getByText(`View data · ${range} days`));
  return within(await screen.findByRole("table")).getAllByRole("row").slice(1);
}

describe("HeroChart completed-report averages", () => {
  it("stops raw and average lines at each provider's actual last report on the shared range", async () => {
    render(<HeroChart range={10} series={[
      { name: "Google", points: reports(10) },
      { name: "Bing", points: reports(8), tone: "bing" },
    ]} />);
    for (const kind of ["line", "raw"]) {
      expect(Math.max(...coordinates(line("Google", kind)))).toBe(1000);
      expect(Math.max(...coordinates(line("Bing", kind)))).toBeCloseTo(1000 * 7 / 9);
    }
    const rows = await openData(10);
    expect(rows).toHaveLength(10);
    expect(rows[0]!.querySelector("time")).toHaveAttribute("datetime", date(1));
    expect(rows.at(-1)!.querySelector("time")).toHaveAttribute("datetime", date(10));
    for (const row of rows.slice(-2)) {
      const cells = within(row).getAllByRole("cell");
      expect(cells[1]).toHaveTextContent(/^Not reported$/);
      expect(cells[0]).toHaveTextContent("7-day avg:");
    }
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google and Bing values" }));
    expect(screen.getByRole("status")).toHaveTextContent("Bing7-day avg: Not availableReported: Not reported");
  });

  it("breaks both paths over missing middle days without treating them as zeroes", async () => {
    render(<HeroChart range={10} series={[{ name: "Google", points: reports(10).filter((point) => point.t !== date(5)) }]} formatValue={String} />);
    for (const kind of ["line", "raw"]) {
      expect(line("Google", kind).getAttribute("d")!.match(/M/g)).toHaveLength(2);
      expect(coordinates(line("Google", kind))).not.toContain(1000 * 4 / 9);
    }
    const rows = await openData(10);
    expect(within(rows[4]!).getAllByRole("cell")[0]).toHaveTextContent(/^Not reported$/);
    // Days 1,2,3,4,6 average to 3.2, not 16/7 or a fabricated day-five point.
    expect(within(rows[5]!).getAllByRole("cell")[0]).toHaveTextContent("7-day avg: 3.2 · 5/7 reported days");
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google values" }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Explore Google values" }), { key: "Home" });
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(screen.getByRole("group", { name: "Explore Google values" }), { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("7-day avg: Not availableReported: Not reported");
  });

  it("keeps provisional raw values and range but excludes the entire unfinished tail from the average", async () => {
    render(<HeroChart range={10} series={[{ name: "Google", points: reports(10) }]} provisionalFrom={date(9)} />);
    expect(Math.max(...coordinates(line("Google")))).toBeCloseTo(1000 * 7 / 9);
    expect(Math.max(...coordinates(line("Google", "raw")))).toBe(1000);
    const rows = await openData(10);
    expect(within(rows[7]!).getAllByRole("cell")[0]).toHaveTextContent("7-day avg: 5");
    for (const [index, row] of rows.slice(-2).entries()) {
      expect(within(row).getAllByRole("cell")[0]).toHaveTextContent(new RegExp(`^${index + 9} · Provisional$`));
    }
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google values" }));
    expect(screen.getByRole("status")).toHaveTextContent("7-day avg: Not availableReported: 10 · Provisional");
    // The readout above already shows the provisional day kept out of the
    // average; the tooltip says only what the marks mean.
    fireEvent.focus(screen.getByRole("button", { name: "About this chart" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Marked periods are provisional");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Bold line");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("The last period");
  });

  it("does not apply one provider's unfinished tail to a provider with final reports", async () => {
    render(<HeroChart range={10} provisionalFrom={date(9)} series={[
      { name: "Google", points: reports(10), provisionalFrom: date(8) },
      { name: "Bing", points: reports(10), provisionalFrom: null, tone: "bing" },
    ]} />);
    expect(Math.max(...coordinates(line("Google")))).toBeCloseTo(1000 * 6 / 9);
    expect(Math.max(...coordinates(line("Bing")))).toBe(1000);
    const rows = await openData(10);
    const last = within(rows.at(-1)!).getAllByRole("cell");
    expect(last[0]).toHaveTextContent(/^10 · Provisional$/);
    expect(last[1]).toHaveTextContent("107-day avg: 7");
    expect(last[1]).not.toHaveTextContent("Provisional");
    expect(last[2]).not.toHaveTextContent("Provisional");
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google and Bing values" }));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Google7-day avg: Not availableReported: 10 · Provisional");
    expect(status).toHaveTextContent("Bing7-day avg: 7Reported: 10");
    expect(status.textContent!.match(/Provisional/g)).toHaveLength(1);
  });

  it("recalculates an inherited boundary without changing any reports", () => {
    const series = [{ name: "Google", points: reports(10) }];
    const { rerender } = render(<HeroChart range={10} series={series} provisionalFrom={date(9)} />);
    expect(Math.max(...coordinates(line("Google")))).toBeCloseTo(1000 * 7 / 9);
    rerender(<HeroChart range={10} series={series} provisionalFrom={date(10)} />);
    expect(Math.max(...coordinates(line("Google")))).toBeCloseTo(1000 * 8 / 9);
    expect(Math.max(...coordinates(line("Google", "raw")))).toBe(1000);
  });

  it("uses hidden completed reports before the selected range and distinguishes plotted average from raw value", async () => {
    render(<HeroChart range={3} series={[{ name: "Google", points: reports(10) }]} />);
    const rows = await openData(3);
    expect(rows[0]!.querySelector("time")).toHaveAttribute("datetime", date(8));
    expect(within(rows[0]!).getAllByRole("cell")[0]).toHaveTextContent("87-day avg: 5");
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google values" }));
    expect(screen.getByRole("status")).toHaveTextContent("7-day avg: 7Reported: 10");
    expect(screen.getByRole("status")).not.toHaveTextContent("reported days");
  });

  it("retains and clearly counts the desk's documented partial-calendar-window average", () => {
    render(<HeroChart range={7} series={[{ name: "Google", points: reports(2) }]} formatValue={(value) => value.toFixed(1)} />);
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google values" }));
    expect(screen.getByRole("status")).toHaveTextContent("7-day avg: 1.5 · 2/7 reported daysReported: 2.0");
    // The chart keys itself (bead ro-ujb9.96.6.12): the legend names the bold
    // line, the readout above counts the reports each average used, and no
    // methodology paragraph sits behind an info icon.
    expect(screen.getByRole("list")).toHaveTextContent("7-day average");
    expect(screen.queryByRole("button", { name: "About this chart" })).toBeNull();
  });

  it("leaves raw-only charts unsmoothed and labels provisional state only on observed provider values", async () => {
    render(<HeroChart range={10} average={false} provisionalFrom={date(9)} series={[
      { name: "Google", points: reports(10) },
      { name: "Bing", points: reports(8), provisionalFrom: null },
    ]} />);
    expect(Math.max(...coordinates(line("Google")))).toBe(1000);
    expect(document.querySelector("[data-hero-raw]")).toBeNull();
    const rows = await openData(10);
    expect(rows.at(-1)).not.toHaveTextContent("avg");
    fireEvent.focus(screen.getByRole("group", { name: "Explore Google and Bing values" }));
    expect(screen.getByRole("status")).toHaveTextContent("Google10 · ProvisionalBingNot reported");
    expect(screen.getByRole("status")).not.toHaveTextContent("avg");
  });
});
