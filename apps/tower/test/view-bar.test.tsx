import { fireEvent, render, screen, waitFor, within } from "./render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewBar } from "@/components/ViewBar";
import { storageKey } from "@/lib/browser-storage";

vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { dashboard: {} } }) }));
beforeEach(() => window.localStorage.clear());

describe("the shared purpose view bar", () => {
  it("shows five short choices and preserves focus preferences", () => {
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view: "overview", focus: ["visitors", "costs"] }));
    render(<ViewBar />);
    const group = screen.getByRole("group", { name: "View" });
    expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual(["Overview", "Growth", "Revenue", "Delivery", "Reliability"]);
    expect(within(group).getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Growth" }));
    expect(JSON.parse(window.localStorage.getItem(storageKey("view")) ?? "null")).toEqual({ view: "growth", focus: ["visitors", "costs"] });
    expect(within(group).getByRole("button", { name: "Growth" })).toHaveAttribute("aria-pressed", "true");
  });

  it("returns focus to the compact trigger after Escape and selection", async () => {
    render(<ViewBar />);
    const trigger = screen.getByRole("button", { name: "View: Overview" });
    trigger.focus();
    fireEvent.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Choose a view" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Choose a view" });
    const revenue = within(dialog).getByRole("button", { name: /Revenue/ });
    revenue.focus();
    fireEvent.click(revenue, { detail: 0 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "View: Revenue" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "View: Revenue" }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: /Revenue/ })).toHaveAttribute("aria-pressed", "true");
  });
});
