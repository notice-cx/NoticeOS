import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageSkeleton, Skeleton } from "@/components/Skeleton";

/** The classes that carry a state, the list `route-split.test.tsx` keeps. */
const STATE_CLASS =
  /(?:^|[\s:-])(?:text|bg|border|fill|stroke|ring)-(?:error|warn|urgent|info|healthy|connected|milestone|trend-positive|trend-negative|live-up|live-down|search-bing|financial-revenue|financial-cost|chart-[a-z-]+|primary)\b/;

describe("Skeleton", () => {
  it("is a block hidden from screen readers, with nothing in it", () => {
    const { container } = render(<Skeleton className="h-10 w-64" />);
    const block = container.firstElementChild!;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block).toHaveClass("skeleton", "h-10", "w-64");
    expect(block.childNodes).toHaveLength(0);
  });
});

describe("PageSkeleton", () => {
  it.each(["board", "list", "form"] as const)("%s: one status naming its read, words for screen readers, blocks that cannot pass for data", (shape) => {
    const { container } = render(<PageSkeleton subject="read:example" shape={shape} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-status-for", "read:example");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Loading…")).toHaveClass("sr-only");
    const group = status.querySelector("[data-skeleton]")!;
    expect(group).toHaveAttribute("aria-hidden", "true");
    expect(group).toHaveClass("skeleton-group");
    expect(group.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    expect(group.textContent).toBe("");
    expect(container.textContent ?? "").not.toMatch(/\d/);
    expect(container.querySelectorAll("svg, canvas, img, table, progress, meter")).toHaveLength(0);
    for (const element of container.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(STATE_CLASS);
    }
  });

  it("takes the page's own words and size", () => {
    render(<PageSkeleton subject="read:example" label="Loading alerts…" className="min-h-[30vh]" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading alerts…");
    expect(status).toHaveClass("min-h-[30vh]");
    expect(status).not.toHaveClass("min-h-[40vh]");
  });
});

describe("the skeleton's motion", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  it("waits 180 ms before the blocks show, shimmers in the furniture tokens, and holds still under reduced motion", () => {
    expect(css).toMatch(/\.skeleton-group\s*\{\s*animation: skeleton-reveal 200ms ease-out 180ms both;/);
    expect(css).toMatch(/\.skeleton\s*\{[^}]*background-color: var\(--viz-track\);[^}]*var\(--skeleton-shine\)/);
    expect(reduced).toMatch(/\.skeleton-group\s*\{\s*animation-duration: 1ms;/);
    expect(reduced).toMatch(/\.skeleton\s*\{\s*animation: none;/);
  });
});
