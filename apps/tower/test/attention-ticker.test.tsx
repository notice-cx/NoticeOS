import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "./render";
import { AttentionTicker } from "@/components/wall/AttentionTicker";
import type { AttentionTickerItem } from "@/lib/attention-ticker";

const items: AttentionTickerItem[] = Array.from({ length: 6 }, (_, index) => ({ id: `item-${index}`, severity: index ? "warn" : "error", assetName: `Example ${index}`, title: `Review decision ${index}`, href: `/tasks?id=${index}`, conditions: ["human-gates"], since: null, kind: "task" }));

describe("AttentionTicker", () => {
  it("renders every message and preserves links and severity shapes", () => {
    const view = render(<AttentionTicker items={items} />);
    expect(view.getAllByRole("link")).toHaveLength(6);
    expect(view.getByRole("link", { name: "Example 5: Review decision 5" }).getAttribute("href")).toBe("/tasks?id=5");
    expect(view.getAllByRole("img", { name: "Warning" })).toHaveLength(5);
    expect(view.getByRole("img", { name: "Error" })).not.toBeNull();
    expect(view.getByRole("region").getAttribute("data-material-condition")).toBe("human-gates");
  });

  it("supports an explicit keyboard-operable pause and resume", () => {
    const view = render(<AttentionTicker items={items} />);
    fireEvent.click(view.getByRole("button", { name: "Pause attention ticker" }));
    expect(view.getByRole("button", { name: "Resume attention ticker" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(view.getByRole("group"), { key: " " });
    expect(view.getByRole("button", { name: "Pause attention ticker" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps user pause active after hover or focus leaves and ignores Space from message links", () => {
    const view = render(<AttentionTicker items={items} />);
    const region = view.getByRole("region");
    expect(region.classList.contains("text-wall-body")).toBe(true);
    fireEvent.keyDown(view.getAllByRole("link")[0]!, { key: " " });
    expect(region.getAttribute("data-attention-paused")).toBe("false");
    fireEvent.click(view.getByRole("button", { name: "Pause attention ticker" }));
    fireEvent.mouseLeave(region);
    fireEvent.blur(view.getByRole("group"), { relatedTarget: null });
    expect(region.getAttribute("data-attention-paused")).toBe("true");
    expect(view.getByRole("button", { name: "Resume attention ticker" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("resets the keyboard scroll offset before the visual loop resumes", () => {
    const view = render(<AttentionTicker items={items} />);
    const viewport = view.getByRole("group");
    viewport.scrollLeft = 200;
    fireEvent.blur(viewport, { relatedTarget: view.getByRole("button") });
    expect(viewport.scrollLeft).toBe(0);
  });

  it.each([["ready", "Nothing needs attention"], ["loading", "Checking task status…"], ["stale", "Task status stale"], ["partial", "Task status incomplete"], ["unavailable", "Task status unavailable"]] as const)("keeps an empty %s state honest", (status, text) => {
    const view = render(<AttentionTicker items={[]} status={status} />);
    expect(view.getByText(text)).not.toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });

  it("measures the full sequence for a stable speed and excludes its visual duplicate from accessibility", () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(720);
    const viewport = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    try {
      const view = render(<AttentionTicker items={items} status="stale" />);
      const track = view.container.querySelector(".attention-ticker-track") as HTMLElement;
      expect(track.style.getPropertyValue("--attention-distance")).toBe("720px");
      expect(track.style.getPropertyValue("--attention-duration")).toBe("20s");
      const duplicate = view.container.querySelector('[data-attention-copy="duplicate"]')!;
      expect(duplicate.getAttribute("aria-hidden")).toBe("true");
      expect(duplicate.hasAttribute("inert")).toBe(false);
      expect([...duplicate.querySelectorAll("a")].every(link => link.tabIndex === -1)).toBe(true);
      expect(view.getAllByRole("link")).toHaveLength(6);
      expect(view.getByText("Task status stale")).not.toBeNull();
    } finally { width.mockRestore(); viewport.mockRestore(); }
  });
});
