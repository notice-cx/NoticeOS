// A page whose first read fails says so (bead ro-ujb9.218; docs/19 finding 15).
//
// Home, Sites, Alerts, the Wall and Tasks used to print "Waiting for the
// store…" once their read (/api/wall; /api/work for Tasks) had failed: TanStack
// holds no data and nothing is
// pending, which is the error state and nothing else. Each route here is
// rendered with its REAL read over a fetch that answers 503, and must draw the
// shared failure — the error dot, what could not be loaded, the status, Try
// again — never the patient wait. Integrations handled its failure already, in
// a sentence of its own; it draws the same state now. So do Settings, the TV
// layout editor and Workflows (bead ro-ujb9.242), which each said it in a
// sentence — Workflows in the read's own error message.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactElement } from "react";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadFailed, readFailureReason } from "@/components/ReadFailed";
import { ApiError } from "@/lib/api";
import { AlertsRoute } from "@/routes/AlertsRoute";
import { AssetsRoute } from "@/routes/AssetsRoute";
import { HomeRoute } from "@/routes/HomeRoute";
import { IntegrationsRoute } from "@/routes/IntegrationsRoute";
import { SettingsRoute } from "@/routes/SettingsRoute";
import { TasksRoute } from "@/routes/TasksRoute";
import { WallEditRoute } from "@/routes/WallEditRoute";
import { WallRoute } from "@/routes/WallRoute";
import WorkflowsRoute from "@/routes/WorkflowsRoute";
import { WORKFLOW_DEFINITIONS } from "@shared/workflows";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** Every read this page makes fails the way a store that does not answer
 * fails: the Worker's 503. */
function storeDown() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ error: "store_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string, element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A DATA router: the TV layout editor's unsaved-changes guard is react-router's
 * own blocker, which only exists on one; `path` is the route's pattern. */
function renderRouted(at: string, pattern: string, element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const router = createMemoryRouter([{ path: pattern, element }], { initialEntries: [at] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const readsOf = (fetchMock: ReturnType<typeof storeDown>, path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input).split("?")[0]!.endsWith(path)).length;

describe("a page whose first read failed draws the shared failure", () => {
  it.each([
    ["Home", "/", <HomeRoute />, "Couldn't load Home", "/api/wall"],
    ["Sites", "/assets", <AssetsRoute />, "Couldn't load your sites", "/api/wall"],
    ["Alerts", "/alerts", <AlertsRoute />, "Couldn't load alerts", "/api/wall"],
    ["the Wall", "/wall", <WallRoute />, "Couldn't load the Wall", "/api/wall"],
    ["Integrations", "/integrations", <IntegrationsRoute />, "Couldn't load integrations", "/api/integrations/providers"],
    ["Tasks", "/tasks", <TasksRoute />, "Couldn't load tasks", "/api/work"],
  ])("%s", async (_page, path, element, title, read) => {
    const fetchMock = storeDown();
    const { container } = renderAt(path, element);

    const retry = await screen.findByRole("button", { name: /try again/i }, { timeout: 5_000 });
    const failed = container.querySelector("[data-read-failed]");
    expect(failed).not.toBeNull();
    expect(failed).toHaveTextContent(title);
    expect(failed).toHaveTextContent("HTTP 503");
    expect(container.textContent).not.toContain("Waiting for the store");

    const before = readsOf(fetchMock, read);
    expect(before).toBeGreaterThan(0);
    fireEvent.click(retry);
    await waitFor(() => expect(readsOf(fetchMock, read)).toBeGreaterThan(before));
  });
});

const workflow = WORKFLOW_DEFINITIONS.find((definition) => definition.surface === "workflow")!;

describe("Settings, the TV layout editor and Workflows draw it too, never a sentence of their own", () => {
  it.each([
    ["Settings", "/settings", "/settings", <SettingsRoute />, "Couldn't load settings", "read:settings", "/api/settings"],
    ["the TV layout editor", "/wall/edit", "/wall/edit", <WallEditRoute />, "Couldn't load the TV layout", "read:tv-layout", "/api/wall"],
    ["Workflows", "/workflows", "/workflows/:id?", <WorkflowsRoute />, "Couldn't load workflows", "read:workflows", "/api/workflows"],
    ["System health's operations", "/health/operations", "/health/operations/:id?", <WorkflowsRoute surface="system" />, "Couldn't load operations", "read:operations", "/api/workflows"],
    ["one workflow's page", `/workflows/${workflow.id}`, "/workflows/:id?", <WorkflowsRoute />, "Couldn't load this workflow", "read:workflow", "/api/workflows"],
  ])("%s", async (_page, at, pattern, element, title, subject, read) => {
    const fetchMock = storeDown();
    const { container } = renderRouted(at, pattern, element);

    const retry = await screen.findByRole("button", { name: /try again/i }, { timeout: 5_000 });
    const failed = container.querySelector("[data-read-failed]");
    expect(failed).not.toBeNull();
    expect(failed).toHaveAttribute("data-status-for", subject);
    expect(failed).toHaveTextContent(title);
    expect(failed).toHaveTextContent("HTTP 503");
    // The sentences it replaced, and the read's own error message.
    expect(container.textContent).not.toMatch(/could not be read|next poll retries|GET \/api/);

    const before = readsOf(fetchMock, read);
    expect(before).toBeGreaterThan(0);
    fireEvent.click(retry);
    await waitFor(() => expect(readsOf(fetchMock, read)).toBeGreaterThan(before));
  });
});

describe("ReadFailed", () => {
  it("says why as a fact: the status the Tower answered, or no answer at all", () => {
    expect(readFailureReason(new ApiError("GET /api/wall failed", 500))).toBe("HTTP 500");
    expect(readFailureReason(new TypeError("Failed to fetch"))).toBe("No answer");
  });

  it("puts a detail ahead of the reason and holds Try again while the retry is out", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ReadFailed title="Couldn't load this site" subject="read:site" detail="example.com" error={new TypeError("x")} retrying={false} onRetry={onRetry} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("example.com · No answer");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ReadFailed title="Couldn't load this site" subject="read:site" detail="example.com" error={new TypeError("x")} retrying onRetry={onRetry} />,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });

  it("draws the Wall's in the TV's own frame", () => {
    const { container } = render(
      <ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={new ApiError("x", 503)} retrying={false} onRetry={() => {}} />,
    );
    expect(container.querySelector(".wall-root [data-read-failed='wall']")).not.toBeNull();
  });
});
