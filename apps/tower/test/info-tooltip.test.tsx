import { act, fireEvent, render, screen } from "./render";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Kpi } from "@/components/surface/KpiStrip";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const themeCss = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const brandCss = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/brand/notice.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Resolve the overlay's actual utility names through the project's theme,
 * not just their presence on an element: unknown Tailwind names generate no
 * CSS and can leave a perfectly classed popup transparent. */
function overlayColors(classes: string) {
  const utilities = classes.split(/\s+/);
  const backgrounds = utilities.filter((name) => name.startsWith("bg-"));
  const foregrounds = utilities.filter((name) => name.startsWith("text-") && !["text-xs", "text-left"].includes(name));
  if (backgrounds.length !== 1 || foregrounds.length !== 1) throw new Error("Overlay must name one background and foreground");
  const theme = themeCss.match(/@theme inline\s*\{([^}]+)\}/)?.[1] ?? "";
  return [backgrounds[0]!.slice(3), foregrounds[0]!.slice(5)].map((name) => {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Overlay colors must be unmodified opaque theme tokens");
    const variable = theme.match(new RegExp(`--color-${name}:\\s*var\\((--[a-z-]+)\\)`))?.[1];
    if (!variable) throw new Error(`Unregistered overlay color: ${name}`);
    return [":root", ".light"].map((selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = themeCss.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
      let value = block.match(new RegExp(`${variable}:\\s*([^;]+);`))?.[1]?.trim();
      const brandBlock = brandCss.match(selector === ".light"
        ? /\.light,\s*:root\[data-theme="light"\]\s*\{([^}]+)\}/
        : /:root\s*\{([^}]+)\}/)?.[1] ?? "";
      const seen = new Set<string>();
      while (value?.startsWith("var(")) {
        const reference = value.match(/^var\((--[a-z-]+)\)$/)?.[1];
        if (!reference || seen.has(reference)) throw new Error("Missing or cyclic brand color");
        seen.add(reference);
        value = brandBlock.match(new RegExp(`${reference}:\\s*([^;]+);`))?.[1]?.trim();
      }
      if (!value || !/^(?:#[\da-f]{6}|oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*(?:1|100%))?\s*\))$/i.test(value)) {
        throw new Error(`Overlay color ${variable} is not a defined opaque color in ${selector}`);
      }
      return value;
    });
  });
}

describe("InfoTooltip", () => {
  it("resolves its actual overlay utilities to opaque registered colors in both themes", () => {
    render(<InfoTooltip label="Method">Supporting explanation.</InfoTooltip>);
    fireEvent.click(screen.getByRole("button"));
    const colors = overlayColors(screen.getByRole("tooltip").className);
    expect(colors).toHaveLength(2);
    expect(colors[0]).toHaveLength(2);
    // Reproduce the original transparent-popup defect: neither missing token
    // is allowed to pass merely because its class appears in the DOM.
    expect(() => overlayColors("bg-popover text-popover-foreground text-xs text-left"))
      .toThrow("Unregistered overlay color: popover");
    expect(() => overlayColors("bg-card/50 text-card-foreground text-xs text-left"))
      .toThrow("unmodified opaque theme tokens");
  });

  it("opens by focus, exposes its explanation accessibly and dismisses with Escape", () => {
    render(<InfoTooltip label="How users are counted">A person can be counted on several days.</InfoTooltip>);
    const trigger = screen.getByRole("button", { name: "How users are counted" });
    expect(trigger).not.toHaveClass("underline");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(trigger);
    const popup = screen.getByRole("tooltip", { name: "How users are counted" });
    expect(trigger).toHaveAttribute("aria-describedby", popup.id);
    expect(trigger).toHaveAccessibleDescription("A person can be counted on several days.");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the explanation hoverable and closes after leaving both surfaces", () => {
    vi.useFakeTimers();
    render(<InfoTooltip label="Method">Only reported dates are averaged.</InfoTooltip>);
    const trigger = screen.getByRole("button");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(screen.getByRole("tooltip"));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByRole("tooltip"));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("pins on tap, stops ancestor activation, and closes on second tap or outside interaction", () => {
    const activate = vi.fn();
    render(<div onClick={activate} onKeyDown={activate}><InfoTooltip label="Method" trigger="Details">Only reported dates.</InfoTooltip></div>);
    const trigger = screen.getByRole("button", { name: "Method" });
    expect(trigger).toHaveTextContent("Details");
    expect(trigger).toHaveClass("underline", "decoration-dotted", "cursor-help");
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "touch" });
    fireEvent.click(screen.getByRole("tooltip"));
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(activate).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("clamps a portalled popup at a narrow viewport edge and permits its own scrolling", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "BUTTON"
        ? { x: 360, y: 550, top: 550, bottom: 594, left: 360, right: 384, width: 24, height: 44, toJSON: () => ({}) }
        : { x: 0, y: 0, top: 0, bottom: 200, left: 0, right: 320, width: 320, height: 200, toJSON: () => ({}) };
    });
    const { container } = render(<InfoTooltip label="Window">Long context.</InfoTooltip>);
    fireEvent.click(screen.getByRole("button"));
    const popup = screen.getByRole("tooltip");
    expect(container).not.toContainElement(popup);
    expect(popup).toHaveStyle({ left: "62px", top: "350px" });
    expect(popup).toHaveStyle({ maxWidth: "374px", maxHeight: "420px" });
    expect(popup).toHaveClass("overflow-auto");
    fireEvent.scroll(popup);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    // A page scroll moves the popup with its trigger rather than closing it
    // (ro-ujb9.14): tabbing to a trigger below the fold scrolls the page.
    fireEvent.scroll(window);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("follows its trigger when the page scrolls, and still closes on Escape", () => {
    let triggerTop = 500;
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "BUTTON"
        ? { x: 20, y: triggerTop, top: triggerTop, bottom: triggerTop + 24, left: 20, right: 44, width: 24, height: 24, toJSON: () => ({}) }
        : { x: 0, y: 0, top: 0, bottom: 100, left: 0, right: 320, width: 320, height: 100, toJSON: () => ({}) };
    });
    render(<InfoTooltip label="Why">Reason.</InfoTooltip>);
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "524px" });
    triggerTop = 200;
    fireEvent.scroll(window);
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "224px" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([375, 310])("keeps its margin inside a %ipx usable viewport with a scrollbar", (usableWidth) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(usableWidth);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(585);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = Math.min(320, Number.parseFloat(this.style.maxWidth) || 320);
      return this.tagName === "BUTTON"
        ? { x: 340, y: 380, top: 380, bottom: 424, left: 340, right: 364, width: 24, height: 44, toJSON: () => ({}) }
        : { x: 0, y: 0, top: 0, bottom: 165, left: 0, right: width, width, height: 165, toJSON: () => ({}) };
    });
    render(<InfoTooltip label="Scrollbar boundary">Supporting context.</InfoTooltip>);
    fireEvent.click(screen.getByRole("button"));
    const popup = screen.getByRole("tooltip");
    expect(popup).toHaveStyle({ left: usableWidth === 375 ? "47px" : "8px", top: "215px",
      maxWidth: `${usableWidth - 16}px`, maxHeight: "409.5px" });
    expect(Number.parseFloat(popup.style.left) + popup.getBoundingClientRect().width).toBe(usableWidth - 8);
  });

  it("keeps a selectable KPI and its explanation as separate controls", () => {
    const select = vi.fn();
    const { container } = render(<Kpi label="Users" value="100" onSelect={select}
      spark={[{ t: "2026-09-01", v: 10 }, { t: "2026-09-02", v: 20 }, { t: "2026-09-03", v: 30 }]} />);
    const info = screen.getByRole("button", { name: "About Users" });
    const selectButton = screen.getByRole("button", { name: /^Users\s*100/ });
    expect(selectButton.querySelector("button")).toBeNull();
    expect(info.parentElement).toBe(selectButton.parentElement);
    expect(container.textContent).not.toContain("Sep 1 – Sep 3");
    expect(selectButton.textContent).not.toContain("Trend:");
    fireEvent.click(info);
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sep 1 – Sep 3");
    fireEvent.click(selectButton);
    expect(select).toHaveBeenCalledOnce();
  });

  it("combines route context with the KPI's own details in one explanation", () => {
    render(<Kpi label="Open tasks" value="8" caption="Latest snapshot"
      seriesUnavailable="The task hub has no comparable history."
      explanation="Task status does not verify that each request is still needed." />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("Latest snapshot")).toBeVisible();
    expect(screen.queryByText("History unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About Open tasks" }));
    const detail = screen.getByRole("tooltip");
    expect(detail).toHaveTextContent("The task hub has no comparable history.");
    expect(detail).toHaveTextContent("Task status does not verify that each request is still needed.");
  });
});
