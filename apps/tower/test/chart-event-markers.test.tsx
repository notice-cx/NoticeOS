import { fireEvent, render, screen, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import { ChartEventMarkers, groupChartEvents } from "@/components/ChartEventMarkers";
import { HeroChart } from "@/components/surface/HeroChart";

const data = [
  { t: "2026-09-01", v: 10 },
  { t: "2026-09-02", v: 20 },
  { t: "2026-09-03", v: 15 },
];

describe("chart event inspection", () => {
  it("shows only the selected event, not surrounding paragraphs or a competing data tooltip", () => {
    const { container } = render(<HeroChart series={[{ name: "Users", points: data }]} range={3}
      annotations={[{ date: "2026-09-01", label: "Deployed recipe search", detail: "Version abc123 changed recipe search." },
        { date: "2026-09-03", label: "Updated pricing" }]} />);
    const plot = screen.getByRole("group", { name: "Explore Users values" });
    fireEvent.focus(plot);
    expect(screen.getByRole("status")).toHaveTextContent("15");
    expect(container.textContent).not.toContain("Deployed recipe search");

    const deploy = screen.getByRole("button", { name: "Event on Sep 1, 2026: Deployed recipe search" });
    fireEvent.focus(deploy);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Version abc123 changed recipe search.");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Updated pricing");
    expect(deploy).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    fireEvent.keyDown(deploy, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(deploy).toHaveAttribute("aria-expanded", "false");

    fireEvent.pointerEnter(deploy, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerMove(plot, { clientX: 10 });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("10");
  });

  it("opens a dashed line's own event and keeps touch inspection open until dismissal", () => {
    const { container } = render(<HeroChart series={[{ name: "Users", points: data }]} range={3}
      annotations={[{ date: "2026-09-02", label: "Timezone moved" }]} />);
    fireEvent.pointerEnter(container.querySelector("[data-chart-event-line]")!, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Timezone moved");
    const marker = screen.getByRole("button", { name: "Event on Sep 2, 2026: Timezone moved" });
    fireEvent.pointerDown(marker, { pointerType: "touch" });
    fireEvent.focus(marker);
    fireEvent.click(marker);
    fireEvent.pointerLeave(marker, { pointerType: "touch" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("groups same-date events and retains actual dates inside a monthly chart", () => {
    render(<HeroChart series={[{ name: "Net", points: [{ t: "2026-09", v: 100 }] }]} range={1}
      annotations={[{ date: "2026-09-02", label: "New pricing" }, { date: "2026-09-20", label: "Hosting renewal" }]} />);
    const marker = screen.getByRole("button", { name: "2 events from Sep 2, 2026 to Sep 20, 2026" });
    fireEvent.click(marker);
    const detail = screen.getByRole("tooltip");
    expect(within(detail).getAllByRole("listitem")).toHaveLength(2);
    expect(detail).toHaveTextContent("Sep 2, 2026");
    expect(detail).toHaveTextContent("Sep 20, 2026");
    expect(detail).toHaveTextContent("New pricing");
    expect(detail).toHaveTextContent("Hosting renewal");
  });

  it("shows the original note once when the marker label is its shortened opening", () => {
    render(<ChartEventMarkers events={[
      { date: "2026-09-02", position: 50, label: "Wrote off two site-wide average-position bets a…", detail: "Wrote off two site-wide average-position bets after reviewing their evidence. No measured improvement was claimed." },
      { date: "2026-09-02", position: 50, label: "Release published", detail: "Version abc123 added search navigation." },
      { date: "2026-09-02", position: 50, label: "Enabled search", detail: "Enabled search. The underlying counts remain unchanged." },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "3 events on Sep 2, 2026" }));
    const detail = screen.getByRole("tooltip");
    expect(within(detail).queryByText("Wrote off two site-wide average-position bets a…")).toBeNull();
    expect(within(detail).queryByText("Enabled search", { exact: true })).toBeNull();
    expect(detail).toHaveTextContent("No measured improvement was claimed.");
    expect(detail).toHaveTextContent("Enabled search. The underlying counts remain unchanged.");
    expect(within(detail).getByText("Release published")).toBeInTheDocument();
    expect(detail).toHaveTextContent("Version abc123 added search navigation.");
  });

  it("groups overlapping touch targets without changing the underlying dates", () => {
    const events = [
      { date: "2026-09-01", label: "One", position: 10 },
      { date: "2026-09-02", label: "Two", position: 12 },
      { date: "2026-09-03", label: "Three", position: 80 },
    ];
    const groups = groupChartEvents(events, 320);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.events.map((event) => event.date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(groups[0]!.position).toBe(11);
    const { container } = render(<ChartEventMarkers events={[events[0]!]} />);
    expect(container.querySelector("button")).toHaveClass("size-11");
  });

  it("keeps edge hit targets inside the plot without moving visible event glyphs", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 320, height: 100, left: 0, right: 320, top: 0, bottom: 100, x: 0, y: 0, toJSON() {} });
    const { container } = render(<ChartEventMarkers lineTargets events={[
      { date: "2026-09-01", label: "Start", position: 0 },
      { date: "2026-09-03", label: "End", position: 100 },
    ]} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]!.style.left).toBe("22px");
    expect(buttons[1]!.style.left).toBe("298px");
    const glyphs = container.querySelectorAll('span[aria-hidden="true"]:not([data-chart-event-line])');
    expect(glyphs[0]).toHaveStyle({ left: "0%" });
    expect(glyphs[1]).toHaveStyle({ left: "100%" });
    expect(groupChartEvents([
      { date: "2026-09-01", label: "Start", position: 0 },
      { date: "2026-09-02", label: "Nearby", position: 20 },
    ], 320)).toHaveLength(1);
    rect.mockRestore();
  });
});
