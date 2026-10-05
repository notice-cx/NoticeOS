import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";

const state = vi.hoisted(() => ({ assets: [] as AssetCard[] }));

// Tasks, and a typed task id, are offered once a task source is connected
// (D32, bead ro-ujb9.143): connected here, as this installation's is.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: { assets: state.assets } as unknown as WallPayload,
    isPending: false,
    isError: false,
  }),
}));

// The Integrations entry wears a dot when a credential is about to expire (bead
// `ro-vu8d.8`), which means the sidebar now reads the provider payload too.
// Mocked for the same reason `useWall` is: nothing here is about the fetch.
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));

import { AppShell } from "@/components/AppShell";
import { PALETTE_RECENT_KEY } from "@/components/CommandPalette";
import { loadCommandPalette } from "./lazy-code";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

// The palette's code arrives on first open (bead `ro-ujb9.84`). These cases are
// about the palette once it is here; the first press before that is
// `lazy-parts.test.tsx`'s.
beforeAll(loadCommandPalette);

// The command palette (bead `ro-d298`). doc 10 principle 4 has named ⌘K since
// the Tower was a sketch; this is the navigation half of it. What these
// assertions are really protecting: the shortcut reaches the operator wherever
// they are on the desk, the two things they jump to (a page, an asset) are both
// listed, Enter actually MOVES the router, and the palette exists nowhere near
// `/wall` — the television renders outside the shell and stays read-only.

function asset(id: string, displayName: string, worstSeverity: AssetCard["worstSeverity"] = null) {
  // `status` is here because the SIDEBAR now lists these same assets (bead
  // `ro-pbzu.9`) and reads the lifecycle stage off every row. The store's column
  // is NOT NULL, so a fixture without it was describing a payload that cannot
  // exist.
  // The reported-once fields decide where a site opens (`sitePath`, bead
  // `ro-ujb9.96.7.4`): these have reported, so they open on their Overview.
  return {
    id, displayName, worstSeverity, status: "live",
    activeUsers: { series: [{ t: "2026-09-01", v: 12 }], provisionalFrom: null, collectedAt: null },
  } as AssetCard;
}

const ASSETS = [
  asset("meals.example", "Meal Planner", "warn"),
  asset("fees.example", "Fee Codes"),
  asset("areas.example", "Area Lookup"),
];

/** The one path in the app that answers by moving. */
function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

/**
 * The desk shell over a page that prints where it is. `/wall` sits OUTSIDE the
 * layout route here exactly as it does in `App.tsx`, which is the whole point
 * of the last test in this file.
 */
function renderShell(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<CurrentPath />} />
        </Route>
        <Route path="/wall" element={<p>the television</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function openWithShortcut() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.getByRole("dialog", { name: "Search pages and sites" });
}

function paletteInput() {
  return screen.getByPlaceholderText("Search pages and sites…");
}

/** The rows cmdk is currently rendering, in DOM order. */
function rows(): string[] {
  return [...document.querySelectorAll("[cmdk-item]")].map((el) => el.textContent ?? "");
}

beforeEach(() => {
  state.assets = ASSETS;
  resetTaskSourceMock();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("opening and closing", () => {
  it("opens on ⌘K and on Ctrl+K, from anywhere in the shell", () => {
    renderShell("/financials");

    expect(screen.queryByRole("dialog")).toBeNull();
    openWithShortcut();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Ctrl is the same shortcut, for the operator who is not on the Mac.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search pages and sites" })).toBeInTheDocument();
  });

  it("ignores a bare k, so it cannot eat what the operator is typing", () => {
    renderShell();

    fireEvent.keyDown(window, { key: "k" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the sidebar button, so a touch operator can reach it too", () => {
    renderShell();

    // Two sidebars are in the DOM by design (the desktop column and the
    // small-screen drawer's source); either button is the same palette.
    fireEvent.click(screen.getAllByRole("button", { name: /Search/ })[0]!);
    expect(screen.getByRole("dialog", { name: "Search pages and sites" })).toBeInTheDocument();
  });

  it("closes on Escape and on the backdrop", () => {
    renderShell();

    openWithShortcut();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    openWithShortcut();
    fireEvent.click(screen.getByRole("button", { name: "Close search pages and sites" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts focus back where it came from", () => {
    renderShell();

    const trigger = screen.getAllByRole("button", { name: /Search/ })[0]!;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    // The palette takes focus for its own field — that is the point of a
    // shortcut — and gives it back rather than dropping it on <body>, which
    // would make the operator's next Tab restart at the top of the page.
    expect(document.activeElement).toBe(paletteInput());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("what it lists", () => {
  it("offers every page and every asset", () => {
    renderShell();
    openWithShortcut();

    const shown = rows();
    for (const page of [
      "Home",
      "Sites",
      "Alerts",
      "Tasks",
      "Financials",
      "System health",
      "Settings",
      "TV dashboard",
    ]) {
      expect(shown.some((row) => row.includes(page))).toBe(true);
    }
    for (const { displayName, id } of ASSETS) {
      // Name AND domain, because the operator knows a site by either.
      expect(shown.some((row) => row.includes(displayName) && row.includes(id))).toBe(true);
    }
  });

  it("marks an asset that has an open warning, and only that one", () => {
    renderShell();
    const dialog = openWithShortcut();

    // Identity is the favicon; the dot is attention, exactly as on the cards.
    expect(within(dialog).getAllByRole("img", { name: /Warn|Error/ })).toHaveLength(1);
  });

  // `ro-hou2`: the favicon is decoration beside a name that is always there,
  // so it contributes nothing to the row's accessible name. Before the fix this
  // row announced as "Meal Planner favicon Meal Planner meals.example".
  it("names an asset row by the asset, not by its favicon", () => {
    renderShell();
    const dialog = openWithShortcut();

    // The accessible name is the row's own text — the display name and the
    // domain, which is what the operator searched by. (jsdom concatenates the
    // text nodes with no separator, so the assertion reads run together.)
    expect(
      within(dialog).getByRole("option", { name: "Fee Codesfees.example" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryAllByRole("option", { name: /favicon/i })).toHaveLength(0);
    expect(within(dialog).queryByTitle(/favicon/i)).toBeNull();
  });

  it("says asset, never the older noun (D20)", () => {
    renderShell();
    const dialog = openWithShortcut();

    // Once as the group heading, once as the page row.
    expect(within(dialog).getAllByText("Sites")).toHaveLength(2);
    expect(paletteInput()).toHaveAttribute("placeholder", "Search pages and sites…");
  });

  it("filters as the operator types", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "fee" } });

    const shown = rows();
    expect(shown.some((row) => row.includes("Fee Codes"))).toBe(true);
    expect(shown.some((row) => row.includes("Meal Planner"))).toBe(false);
    expect(shown.some((row) => row.includes("TV dashboard"))).toBe(false);
  });

  it("finds a page by a word that is not its label", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "revenue" } });

    expect(rows().some((row) => row.includes("Financials"))).toBe(true);
  });

  it("says so when nothing matches", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "zzzzzzzz" } });

    expect(screen.getByText("No page or site matches.")).toBeInTheDocument();
  });
});

describe("navigating", () => {
  it("moves the router on Enter and closes behind itself", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "meal planner" } });
    fireEvent.keyDown(paletteInput(), { key: "Enter" });

    expect(screen.getByTestId("path")).toHaveTextContent("/assets/meals.example");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the router on a click", () => {
    renderShell();
    const dialog = openWithShortcut();

    fireEvent.click(within(dialog).getByText("Financials"));

    expect(screen.getByTestId("path")).toHaveTextContent("/financials");
  });

  it("offers a bead id as a task, and lands it on the task's page", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "ro-d298" } });

    // A task has a page (`/tasks/:id`, D19); the row goes straight there.
    expect(rows()).toEqual(["Open task ro-d298Enter"]);
    // A force-mounted row is the only thing left on screen, so the empty state
    // would be a lie — it must not be here.
    expect(screen.queryByText("No page or site matches.")).toBeNull();

    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    expect(screen.getByTestId("path")).toHaveTextContent("/tasks/ro-d298");
  });

  it("offers Tasks and task IDs even before the core hub has been read", () => {
    taskSourceMock.connected = null;
    renderShell();
    openWithShortcut();
    expect(rows()).toContain("Tasks");
    fireEvent.change(paletteInput(), { target: { value: "ro-d298" } });
    expect(rows()).toEqual(["Open task ro-d298Enter"]);
  });

  it("does not mistake an ordinary word for a bead id", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "financials" } });
    expect(screen.queryByText(/on the work board/)).toBeNull();
  });
});

describe("recents", () => {
  it("remembers what was chosen and offers it first next time", () => {
    const view = renderShell();
    const dialog = openWithShortcut();
    fireEvent.click(within(dialog).getByText("System health"));

    expect(JSON.parse(window.localStorage.getItem(PALETTE_RECENT_KEY) ?? "[]")).toEqual([
      "page:System health",
    ]);

    // Reopen: the remembered page leads, and is NOT drawn twice.
    openWithShortcut();
    const first = rows()[0] ?? "";
    expect(first).toContain("System health");
    expect(rows().filter((row) => row.includes("System health"))).toHaveLength(1);

    view.unmount();
  });

  it("survives a store that refuses to answer", () => {
    window.localStorage.setItem(PALETTE_RECENT_KEY, "{not json");
    renderShell();

    // No throw, no empty palette: a broken convenience is not an outage.
    const dialog = openWithShortcut();
    expect(within(dialog).getByText("Home")).toBeInTheDocument();
  });

  it("does not remember a task lookup, which is not a place", () => {
    renderShell();
    openWithShortcut();

    fireEvent.change(paletteInput(), { target: { value: "ro-d298" } });
    fireEvent.keyDown(paletteInput(), { key: "Enter" });

    expect(window.localStorage.getItem(PALETTE_RECENT_KEY)).toBeNull();
  });
});

describe("the television has no palette", () => {
  it("does not mount on /wall, which renders outside the shell", () => {
    renderShell("/wall");

    expect(screen.getByText("the television")).toBeInTheDocument();
    // No sidebar, therefore no search button…
    expect(screen.queryByRole("button", { name: /Search/ })).toBeNull();
    // …and no shortcut, because the handler is mounted by the shell.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
