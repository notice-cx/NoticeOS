import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "./render";
import type { DashboardConfig } from "@shared/dashboard";
import { storageKey } from "@/lib/browser-storage";
import { ViewPanel } from "@/routes/settings/ViewPanel";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

/** The writability answer and the config writes, recorded; every other read
 * fails, so the Wall read has no workspace default to offer. */
function stubFetch(writable: boolean) {
  const writes: { ops: unknown[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ applied: 1, archive: null, commit: null });
    }
    if (url.includes("/api/config")) {
      return Response.json(writable
        ? { writable: true, reason: null, sources: {} }
        : { writable: false, reason: "Saves are paused", sources: {} });
    }
    return new Response("not here", { status: 404 });
  }));
  return writes;
}

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>,
  );
}

const NOTHING_SAVED: DashboardConfig = { wall: null } as unknown as DashboardConfig;

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe("Settings → General → Your view", () => {
  it("offers the three views as radios, Everything chosen before anyone answers", () => {
    stubFetch(true);
    const { container } = wrap(<ViewPanel dashboard={NOTHING_SAVED} />);
    const panel = within(container.querySelector("[data-settings-view]") as HTMLElement);
    const radios = panel.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(panel.getByRole("radio", { name: /I run the business/ })).not.toBeChecked();
    expect(panel.getByRole("radio", { name: /I build the product/ })).not.toBeChecked();
    expect(panel.getByRole("radio", { name: /Everything/ })).toBeChecked();
    expect(container.querySelectorAll("[data-view-option]")).toHaveLength(3);
  });

  it("stores the choice in this browser on change, and Undo forgets it", () => {
    stubFetch(true);
    const { container } = wrap(<ViewPanel dashboard={NOTHING_SAVED} />);
    fireEvent.click(screen.getByRole("radio", { name: /I run the business/ }));

    expect(window.localStorage.getItem(storageKey("view"))).toBe(JSON.stringify({ view: "business", focus: [] }));
    expect(screen.getByRole("radio", { name: /I run the business/ })).toBeChecked();
    const saved = container.querySelector('[data-status-for="field:Your view"][data-save-state="saved"]') as HTMLElement;
    expect(saved).not.toBeNull();

    fireEvent.click(within(saved).getByRole("button", { name: "Undo" }));
    expect(window.localStorage.getItem(storageKey("view"))).toBeNull();
    expect(screen.getByRole("radio", { name: /Everything/ })).toBeChecked();
  });

  it("keeps the picks when the view changes, and saves each pick on its own", () => {
    stubFetch(true);
    const { container } = wrap(<ViewPanel dashboard={NOTHING_SAVED} />);
    const focus = within(container.querySelector("[data-settings-focus]") as HTMLElement);
    expect(focus.getByText("Nothing picked")).toBeInTheDocument();
    fireEvent.click(focus.getByRole("button", { name: "Change" }));
    fireEvent.click(container.querySelector('[data-focus-option="money"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-focus-option="agents"]') as HTMLElement);
    expect(container.querySelector("[data-focus-value]")).toHaveTextContent("Money · The agents' work");

    fireEvent.click(screen.getByRole("radio", { name: /I build the product/ }));
    expect(JSON.parse(window.localStorage.getItem(storageKey("view")) ?? "null")).toEqual({
      view: "product",
      focus: ["money", "agents"],
    });
  });

  it("writes the workspace default as one document at /view, with Undo beside it", async () => {
    const writes = stubFetch(true);
    const { container } = wrap(<ViewPanel dashboard={NOTHING_SAVED} />);
    expect(container.querySelector("[data-workspace-view-value]")).toHaveTextContent("Everything");
    fireEvent.click(container.querySelector("[data-workspace-view-change]") as HTMLElement);
    fireEvent.click(container.querySelector('[data-workspace-view-option="business"]') as HTMLElement);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.ops).toEqual([
      { kind: "file-json-set", file: "config/tower.json", pointer: "/view", expect: null, value: { default: "business" } },
    ]);
    const saved = await waitFor(() => {
      const found = container.querySelector('[data-status-for="field:Workspace default"][data-save-state="saved"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(saved).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.ops).toEqual([
      { kind: "file-json-set", file: "config/tower.json", pointer: "/view", expect: { default: "business" }, value: null },
    ]);
  });

  it("guards the write with the saved default", async () => {
    const writes = stubFetch(true);
    const dashboard = { ...NOTHING_SAVED, view: { default: "product" } } as DashboardConfig;
    const { container } = wrap(<ViewPanel dashboard={dashboard} />);
    expect(container.querySelector("[data-workspace-view-value]")).toHaveTextContent("I build the product");
    fireEvent.click(container.querySelector("[data-workspace-view-change]") as HTMLElement);
    expect(container.querySelector('[data-workspace-view-option="product"]')).toBeDisabled();
    fireEvent.click(container.querySelector('[data-workspace-view-option="everything"]') as HTMLElement);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.ops).toEqual([
      { kind: "file-json-set", file: "config/tower.json", pointer: "/view", expect: { default: "product" }, value: { default: "everything" } },
    ]);
  });

  it("shows the workspace default read-only, with a lock, while saves are paused", async () => {
    stubFetch(false);
    const { container } = wrap(<ViewPanel dashboard={NOTHING_SAVED} />);
    await waitFor(() => expect(container.querySelector("[data-workspace-view-locked]")).not.toBeNull());
    expect(container.querySelector("[data-workspace-view-change]")).toBeNull();
    expect(container.querySelector("[data-workspace-view-value]")).toHaveTextContent("Everything");
    // The person's own view is kept in this browser, so it still saves.
    fireEvent.click(screen.getByRole("radio", { name: /I run the business/ }));
    expect(window.localStorage.getItem(storageKey("view"))).toBe(JSON.stringify({ view: "business", focus: [] }));
  });
});
