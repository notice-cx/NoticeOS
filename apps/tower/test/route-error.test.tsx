import { act, fireEvent, render, screen, within } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A screen that throws stays inside the Tower: a desk screen's error is drawn
// in the shell, under its sidebar, and the Wall's is the TV's own frame, which
// reloads by itself less often each time. Neither is React Router's
// developer page.

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/routes/AgentsRoute", () => ({
  default: function AgentsRoute() {
    throw new Error("Cannot read properties of null (reading 'useState')");
  },
}));
vi.mock("@/routes/WallRoute", () => ({
  default: function WallRoute() {
    throw new TypeError("The Wall's layout is not an array");
  },
}));

import { routes } from "@/App";
import { RouteError, RouteErrorFrame, wallErrorReloadWait } from "@/components/RouteLoading";
import { resetTaskSourceMock } from "./task-source-mock";

const RELOADS = "noticeos:wall-error-reloads";

beforeEach(() => {
  resetTaskSourceMock();
  window.sessionStorage.clear();
  // React Router names each error it catches on the console; the frame is
  // what this file checks.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("the Tower's own routes", () => {
  it("draws a desk screen's error inside the shell, with the sidebar, its message and Reload", async () => {
    open("/agents");
    const frame = await screen.findByRole("alert");
    expect(frame).toHaveAttribute("data-route-error", "desk");
    expect(within(frame).getByRole("heading", { name: "This page ran into an error" })).toBeInTheDocument();
    expect(within(frame).getByText("Cannot read properties of null (reading 'useState')")).toBeInTheDocument();
    expect(within(frame).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
  });

  it("draws the Wall's error in the TV's frame, outside the shell, and says when it reloads", async () => {
    open("/wall");
    const frame = await screen.findByRole("alert");
    expect(frame).toHaveAttribute("data-route-error", "wall");
    expect(within(frame).getByRole("heading", { name: "The Wall ran into an error" })).toBeInTheDocument();
    expect(within(frame).getByText("The Wall's layout is not an array")).toBeInTheDocument();
    expect(within(frame).getByText("Reloads by itself in 1 min")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
  });
});

describe("the error frame", () => {
  it("reloads only when Reload is pressed on the desk", () => {
    const reload = vi.fn();
    render(<RouteErrorFrame error={new Error("boom")} reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("names an error answer by its status", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        loader: () => {
          throw new Response(null, { status: 503, statusText: "Service Unavailable" });
        },
        Component: () => null,
        errorElement: <RouteError />,
      },
    ]);
    render(<RouterProvider router={router} />);
    return expect(screen.findByText("503 Service Unavailable")).resolves.toBeInTheDocument();
  });
});

describe("the Wall reloads by itself after an error", () => {
  function throwingWall(reload: () => void) {
    function Wall(): null {
      throw new Error("boom");
    }
    const router = createMemoryRouter([{ path: "/", Component: Wall, errorElement: <RouteError surface="wall" reload={reload} /> }]);
    return render(<RouterProvider router={router} />);
  }

  it("after a minute, then two, then four, and never more than ten apart", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-16T09:00:00Z") });
    const reload = vi.fn();
    for (const minutes of [1, 2, 4, 8, 10, 10]) {
      const view = throwingWall(reload);
      expect(screen.getByText(`Reloads by itself in ${minutes} min`)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(minutes * 60_000 - 1));
      expect(reload).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(reload).toHaveBeenCalledTimes(1);
      reload.mockClear();
      view.unmount();
    }
  });

  it("starts the run over once the Wall has gone twenty minutes without an error", () => {
    const now = Date.parse("2026-10-16T09:00:00Z");
    window.sessionStorage.setItem(RELOADS, JSON.stringify({ at: now, run: 3 }));
    expect(wallErrorReloadWait(now + 19 * 60_000)).toBe(8 * 60_000);
    expect(wallErrorReloadWait(now + 20 * 60_000)).toBe(60_000);
  });

  it("waits the longest when the tab cannot store its run", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(wallErrorReloadWait()).toBe(10 * 60_000);
  });

  it("does not reload once the frame is gone", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    throwingWall(reload).unmount();
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(reload).not.toHaveBeenCalled();
  });
});
