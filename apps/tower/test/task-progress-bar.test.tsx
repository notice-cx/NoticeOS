import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskProgressBar, taskBarLabel, type TaskBarSegment } from "@/components/viz/TaskProgressBar";

// A project's tasks as one segment each, filled from the left, with the
// counts as the bar's accessible sentence.

const states = (bar: HTMLElement) => [...bar.querySelectorAll("[data-state]")].map((node) => node.getAttribute("data-state"));
const many = (n: number, state: TaskBarSegment["state"]) => Array.from({ length: n }, () => ({ state }));

describe("TaskProgressBar", () => {
  it("says its counts as a sentence", () => {
    render(<TaskProgressBar segments={[...many(6, "done"), { state: "needs-you" }, ...many(2, "blocked")]} />);
    expect(screen.getByRole("img", { name: "9 tasks: 6 done, 1 needs you, 2 blocked" })).toBeInTheDocument();
  });

  it("speaks a plural ask and an empty bar", () => {
    expect(taskBarLabel(many(2, "needs-you"))).toBe("2 tasks: 2 need you");
    expect(taskBarLabel([])).toBe("0 tasks");
  });

  it("draws one segment per task in the order the work fills in", () => {
    render(<TaskProgressBar segments={[{ state: "parked" }, { state: "ready" }, { state: "blocked" }, { state: "done" }, { state: "unknown" }, { state: "in-progress" }, { state: "needs-you" }, { state: "waiting" }]} />);
    const bar = screen.getByRole("img");
    expect(states(bar)).toEqual(["done", "in-progress", "needs-you", "blocked", "ready", "waiting", "parked", "unknown"]);
    // Parked and unplaced work is hatched: nothing moves or was measured there.
    expect(bar.querySelector('[data-state="parked"]')).toHaveClass("viz-hatch");
    expect(bar.querySelector('[data-state="unknown"]')).toHaveClass("viz-hatch");
    // A task waiting on the operator is an outline, a blocked one a fill.
    expect(bar.querySelector('[data-state="needs-you"]')).toHaveClass("border-warn");
    expect(bar.querySelector('[data-state="blocked"]')).toHaveClass("bg-warn");
  });

  it("draws one run per state past forty tasks, each as wide as its count", () => {
    render(<TaskProgressBar segments={[...many(50, "done"), ...many(10, "ready")]} size="sm" />);
    const bar = screen.getByRole("img", { name: "60 tasks: 50 done, 10 ready" });
    expect(states(bar)).toEqual(["done", "ready"]);
    expect((bar.querySelector('[data-state="done"]') as HTMLElement).style.flexGrow).toBe("50");
    expect(bar).toHaveClass("h-1.5");
  });
});
