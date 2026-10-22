import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BlockerImpact } from "@/routes/tasks/projects/BlockerImpact";
import { blockerProject as project, blockerTask as task } from "./blocker-impact-fixture";

describe("blocker impact section", () => {
  it("shows separate counts, project, state, holder and an explicit project link, with more rows disclosed", () => {
    const tasks = Array.from({ length: 4 }, (_, index) => [task(`ex-${index}`, [], {
      title: `Blocker ${index}`, status: "in_progress", assignee: "actor", actors: [{ principalId: "actor", displayName: "Builder" }],
    }), task(`ex-child${index}`, [`ex-${index}`])]).flat();
    render(<MemoryRouter><BlockerImpact projects={[project(tasks)]} /></MemoryRouter>);
    const section = screen.getByRole("region", { name: "Holding up work" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    const link = within(section).getByRole("link", { name: /Blocker 0/ });
    expect(link).toHaveAttribute("href", "/tasks/ex-0?project=example.com");
    expect(link).toHaveTextContent("Example project · In progress · Builder");
    expect(link).toHaveTextContent("1 downstream");
    expect(link).toHaveTextContent("1 could become ready");
    fireEvent.click(within(section).getByRole("button", { name: "Show 1 more" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
    expect(within(section).getAllByRole("button")).toHaveLength(1);
  });

  it("labels lower bounds and unknown readiness on saved samples", () => {
    render(<MemoryRouter><BlockerImpact projects={[project([task("ex-a"), task("ex-b", ["ex-a"])], { source: "snapshot" })]} /></MemoryRouter>);
    expect(screen.getByText("Known work · lower bounds")).toBeVisible();
    expect(screen.getByRole("link")).toHaveTextContent("≥1 downstream");
    expect(screen.getByRole("link")).toHaveTextContent("— could become ready");
    expect(screen.getByText(/A dash means readiness is unknown/)).toBeVisible();
  });

  it("distinguishes a complete empty graph from an unmeasured one", () => {
    const { rerender } = render(<MemoryRouter><BlockerImpact projects={[project([])]} /></MemoryRouter>);
    expect(screen.getByText("No unfinished tasks hold up other work.")).toBeVisible();
    rerender(<MemoryRouter><BlockerImpact projects={[project([], { source: "unavailable" })]} /></MemoryRouter>);
    expect(screen.getByText("No blockers found in the available dependencies.")).toBeVisible();
  });
});
