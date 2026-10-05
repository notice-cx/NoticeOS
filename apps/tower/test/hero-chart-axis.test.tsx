import { act, fireEvent, render, screen, within } from "./render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeroChart } from "@/components/surface/HeroChart";

const date = (offset: number) => new Date(Date.UTC(2026, 8, 5 + offset)).toISOString().slice(0, 10);
const reports = (count: number) => Array.from({ length: count }, (_, index) => ({
  t: date(index - count + 1), v: index + 1,
}));

describe("HeroChart responsive date-axis spacing", () => {
  let plotWidth: number;
  let labelWidth: number;
  const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];

  beforeEach(() => {
    plotWidth = 290; // The plot inside a 390px phone, after card/y-axis gutters.
    labelWidth = 42;
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      readonly disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ notify: () => callback([], this), disconnect: this.disconnect });
      }
      observe() {}
      unobserve() {}
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-hero-x-axis")) return new DOMRect(50, 200, plotWidth, 16);
      if (this.hasAttribute("data-hero-x-candidate")) {
        const left = this.classList.contains("end-0") ? plotWidth - labelWidth
          : plotWidth * Number.parseFloat(this.style.left) / 100
            - (this.classList.contains("-translate-x-1/2") ? labelWidth / 2 : 0);
        return new DOMRect(50 + left, 200, labelWidth, 16);
      }
      return original.call(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function axisLabels(container: HTMLElement) {
    return [...container.querySelectorAll<HTMLElement>("[data-hero-x-label]")];
  }

  function expectReadable(container: HTMLElement, count: number) {
    const labels = axisLabels(container);
    const bounds = labels.map((label) => label.getBoundingClientRect());
    expect(labels[0]).toHaveAttribute("data-hero-x-label", date(-(count - 1)));
    expect(labels.at(-1)).toHaveAttribute("data-hero-x-label", date(0));
    const axis = container.querySelector("[data-hero-x-axis]")!.getBoundingClientRect();
    for (const [index, box] of bounds.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(axis.left);
      expect(box.right).toBeLessThanOrEqual(axis.right);
      if (index > 0) expect(box.left - bounds[index - 1]!.right).toBeGreaterThanOrEqual(8);
    }
  }

  it.each([7, 28, 90])("keeps both endpoints and collision-free ticks for a %i-day mobile and desktop plot", (count) => {
    const { container } = render(<HeroChart range={count} series={[{ name: "Users", points: reports(count) }]} />);
    expectReadable(container, count);
    const phoneLabels = axisLabels(container).length;
    plotWidth = 900;
    act(() => observers.forEach((observer) => observer.notify()));
    expectReadable(container, count);
    expect(axisLabels(container).length).toBeGreaterThan(phoneLabels);
  });

  it("removes the colliding Aug 31 and Sep 4 ticks without removing their data or keyboard access", async () => {
    const { container } = render(<HeroChart range={7} series={[{ name: "Users", points: reports(7) }]} />);
    const shown = axisLabels(container).map((label) => label.dataset.heroXLabel);
    expect(shown).not.toContain("2026-08-31");
    expect(shown).not.toContain("2026-09-04");
    expectReadable(container, 7);
    const pathBefore = container.querySelector("[data-hero-line]")!.getAttribute("d");

    const chart = screen.getByRole("group", { name: "Explore Users values" });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Home" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Aug 31");
    expect(screen.getByRole("status")).toHaveTextContent("Reported: 2");
    fireEvent.keyDown(chart, { key: "End" });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 4");
    expect(screen.getByRole("status")).toHaveTextContent("Reported: 6");

    fireEvent.click(screen.getByText("View data · 7 days"));
    const rows = within(await screen.findByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("time")?.dateTime)).toEqual(reports(7).map((point) => point.t));
    plotWidth = 900;
    act(() => observers.forEach((observer) => observer.notify()));
    expect(axisLabels(container)).toHaveLength(7);
    expect(container.querySelector("[data-hero-line]")).toHaveAttribute("d", pathBefore);
  });

  it("remeasures occupied text widths, and disconnects observation on unmount", () => {
    plotWidth = 450;
    const { container, unmount } = render(<HeroChart range={7} series={[{ name: "Users", points: reports(7) }]} />);
    const originalCount = axisLabels(container).length;
    labelWidth = 65;
    act(() => observers.forEach((observer) => observer.notify()));
    expectReadable(container, 7);
    expect(axisLabels(container).length).toBeLessThan(originalCount);
    unmount();
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("rebuilds the endpoint labels when the selected period changes", () => {
    const series = [{ name: "Users", points: reports(90) }];
    const { container, rerender } = render(<HeroChart range={7} series={series} />);
    expectReadable(container, 7);
    rerender(<HeroChart range={90} series={series} />);
    expectReadable(container, 90);
    expect(axisLabels(container).some((label) => label.dataset.heroXLabel === date(-89))).toBe(true);
  });

  it("preserves monthly endpoints and centers a single date over its only point", () => {
    const series = [{ name: "Net", points: [{ t: "2026-07", v: 1 }, { t: "2026-08", v: 2 }, { t: "2026-09", v: 3 }] }];
    const { container, rerender } = render(<HeroChart range={3} series={series} variant="monthly" />);
    expect(axisLabels(container).map((label) => label.dataset.heroXLabel)).toEqual(["2026-07", "2026-08", "2026-09"]);
    rerender(<HeroChart range={1} series={series} variant="monthly" />);
    const labels = axisLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveAttribute("data-hero-x-label", "2026-09");
    expect(labels[0]!.style.left).toBe("50%");
    expect(labels[0]).toHaveClass("-translate-x-1/2");
  });
});
