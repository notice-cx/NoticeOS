import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProgress, RouterNavigationProgress } from "@/components/NavigationProgress";
import { INDICATOR_TIMING, createLoadingIndicator, type IndicatorPhase } from "@/lib/loading-indicator";

const { delay, minVisible, finish } = INDICATOR_TIMING;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function indicator() {
  const phases: IndicatorPhase[] = [];
  const owned = createLoadingIndicator((phase) => phases.push(phase));
  return { owned, phases };
}

describe("createLoadingIndicator", () => {
  it("draws nothing for a wait shorter than the delay", () => {
    const { owned, phases } = indicator();
    owned.set(true);
    vi.advanceTimersByTime(delay - 1);
    owned.set(false);
    vi.advanceTimersByTime(10_000);
    expect(phases).toEqual([]);
    expect(owned.phase).toBe("hidden");
  });

  it("once drawn, stays the minimum however soon the wait ends, then finishes and goes", () => {
    const { owned, phases } = indicator();
    owned.set(true);
    vi.advanceTimersByTime(delay);
    expect(owned.phase).toBe("shown");
    vi.advanceTimersByTime(50);
    owned.set(false);
    vi.advanceTimersByTime(minVisible - 50 - 1);
    expect(owned.phase).toBe("shown");
    vi.advanceTimersByTime(1);
    expect(owned.phase).toBe("finishing");
    vi.advanceTimersByTime(finish);
    expect(phases).toEqual(["shown", "finishing", "hidden"]);
  });

  it("finishes at once when the wait outlasted the minimum", () => {
    const { owned, phases } = indicator();
    owned.set(true);
    vi.advanceTimersByTime(delay + minVisible + 500);
    owned.set(false);
    vi.advanceTimersByTime(0);
    expect(owned.phase).toBe("finishing");
    vi.advanceTimersByTime(finish);
    expect(phases).toEqual(["shown", "finishing", "hidden"]);
  });

  it("stays drawn when a new wait starts before it has finished", () => {
    const { owned, phases } = indicator();
    owned.set(true);
    vi.advanceTimersByTime(delay);
    owned.set(false);
    vi.advanceTimersByTime(minVisible / 2);
    owned.set(true);
    vi.advanceTimersByTime(minVisible * 4);
    expect(phases).toEqual(["shown"]);
    owned.set(false);
    vi.advanceTimersByTime(0);
    expect(owned.phase).toBe("finishing");
    owned.set(true);
    expect(owned.phase).toBe("shown");
    expect(phases).toEqual(["shown", "finishing", "shown"]);
  });

  it("starts over from hidden when disposed", () => {
    const { owned } = indicator();
    owned.set(true);
    vi.advanceTimersByTime(delay);
    owned.dispose();
    expect(owned.phase).toBe("hidden");
    expect(vi.getTimerCount()).toBe(0);
    owned.set(true);
    vi.advanceTimersByTime(delay);
    expect(owned.phase).toBe("shown");
  });
});

describe("NavigationProgress", () => {
  const line = () => document.querySelector<HTMLElement>("[data-navigation-progress]");

  it("draws a decorative line that never takes a click, only after the delay", () => {
    const view = render(<NavigationProgress busy />);
    expect(line()).toBeNull();
    act(() => vi.advanceTimersByTime(delay));
    expect(line()).toHaveAttribute("data-navigation-progress", "shown");
    expect(line()).toHaveAttribute("aria-hidden", "true");
    expect(line()).toHaveClass("pointer-events-none", "fixed");
    expect(line()!.textContent).toBe("");
    view.rerender(<NavigationProgress busy={false} />);
    act(() => vi.advanceTimersByTime(minVisible));
    expect(line()).toHaveAttribute("data-navigation-progress", "finishing");
    act(() => vi.advanceTimersByTime(finish));
    expect(line()).toBeNull();
  });

  it("follows the router's navigation state", () => {
    const listeners = new Set<() => void>();
    const router = {
      state: { navigation: { state: "idle" } },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const navigate = (state: string) =>
      act(() => {
        router.state = { navigation: { state } };
        for (const listener of listeners) listener();
      });
    const view = render(<RouterNavigationProgress router={router} />);
    navigate("loading");
    act(() => vi.advanceTimersByTime(delay));
    expect(line()).toHaveAttribute("data-navigation-progress", "shown");
    navigate("idle");
    act(() => vi.advanceTimersByTime(minVisible + finish));
    expect(line()).toBeNull();
    view.unmount();
    expect(listeners.size).toBe(0);
  });
});

describe("the motion behind the line and a page's arrival", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  it("stops under reduced motion", () => {
    expect(reduced).toMatch(/\.page-arrive > \*\s*\{\s*animation: none;/);
    expect(reduced).toMatch(/\.nav-progress-bar,[^{]*\.nav-progress\[data-navigation-progress="finishing"\] \.nav-progress-bar\s*\{\s*transform: none;\s*transition: none;/);
  });

  it("finishes in the time the indicator gives it", () => {
    const fill = Number(css.match(/transition: transform (\d+)ms ease-out;/)?.[1]);
    const fade = css.match(/transition: opacity (\d+)ms ease-out (\d+)ms;/);
    expect(fill + Number(fade?.[1])).toBe(finish);
    expect(Number(fade?.[2])).toBe(fill);
  });
});
