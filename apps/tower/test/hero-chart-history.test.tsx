import { fireEvent, render, screen, within } from "./render";
import { describe, expect, it } from "vitest";
import { HeroChart } from "@/components/surface/HeroChart";

const day = (index: number) => new Date(Date.UTC(2026, 6, index)).toISOString().slice(0, 10);

describe("HeroChart retained history coverage", () => {
  it("draws isolated reported readings without joining missing days", async () => {
    const { container } = render(<HeroChart series={[{ name: "Evidence", points: [{ t: day(1), v: 4 }, { t: day(3), v: 8 }] }]} range={3} average={false} />);
    expect(container.querySelectorAll('[data-hero-point="Evidence"]')).toHaveLength(2);
    const line = container.querySelector('[data-hero-line="Evidence"]')!.getAttribute('d');
    expect(line).not.toMatch(/[LH]/);
    fireEvent.click(screen.getByText('View data · 3 days'));
    expect(await screen.findByRole('table')).toHaveTextContent('Not reported');
  });

  it("uses hidden earlier observations for the first visible average without drawing their dates", async () => {
    const points = Array.from({ length: 35 }, (_, index) => ({ t: day(index + 1), v: index < 7 ? 10 : 80 }));
    render(<HeroChart series={[{ name: "Google", points }]} range={28} />);
    fireEvent.click(screen.getByText("View data · 28 days"));
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(29);
    expect(rows[1]!.querySelector("time")).toHaveAttribute("datetime", day(8));
    expect(rows[1]).toHaveTextContent("7-day avg: 20");
    expect(document.querySelector(`time[datetime="${day(7)}"]`)).toBeNull();
  });

  it("keeps all ninety calendar dates and reports the absent provider tail as missing", async () => {
    const points = Array.from({ length: 90 }, (_, index) => ({ t: day(index + 1), v: index + 1 }));
    render(<HeroChart series={[
      { name: "Google", points },
      { name: "Bing", points: points.slice(0, -2), tone: "bing" },
    ]} range={90} average={false} />);
    fireEvent.click(screen.getByText("View data · 90 days"));
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(91);
    expect(rows[1]!.querySelector("time")).toHaveAttribute("datetime", day(1));
    expect(rows.at(-1)!.querySelector("time")).toHaveAttribute("datetime", day(90));
    expect(within(rows.at(-1)!).getAllByRole("cell")[1]).toHaveTextContent("Not reported");
    const line = document.querySelector('[data-hero-line="Bing"]')!.getAttribute("d")!;
    const x = [...line.matchAll(/[ML]([\d.]+) /g)].map((match) => Number(match[1]));
    expect(Math.max(...x)).toBeCloseTo(1000 * 87 / 89);
  });
});
