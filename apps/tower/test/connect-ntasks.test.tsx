import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { API_VERSION } from "@notice-cx/ntasks-ui";
import { cleanup, fireEvent, render, screen } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TaskServiceStatus } from "@shared/tasks";

// The Tower's /tasks is the Ntasks UI, reading and writing as the person
// signed in to Ntasks in this browser. While no task service is connected it
// leads to Settings → Task projects instead.

const ORIGIN = "https://ntasks.example.com";
const CLIENT_ID = "tower-client";
const TOKENS_KEY = `noticeos:ntasks-person:${ORIGIN}:${CLIENT_ID}`;
const NOT_CONNECTED: TaskServiceStatus = { connected: false, origin: null, projects: null, required: true };
const CONNECTED: TaskServiceStatus = { connected: true, origin: ORIGIN, required: true, app: { clientId: CLIENT_ID, workspaceId: "w-1" },
  projects: [{ asset: "example.com", prefix: "md", project: { displayName: "Example", logicalKey: "example.com", projectId: "p-md" } }] };

const UNREGISTERED: TaskServiceStatus = { ...CONNECTED, app: null };

const state = vi.hoisted(() => ({ service: undefined as TaskServiceStatus | undefined }));
// Ntasks answers the app it has for this Tower address, the saved one unless a test says otherwise.
const api = vi.hoisted(() => ({ registerNtasksApp: vi.fn(async (): Promise<{ clientId: string; held: boolean }> => ({ clientId: "tower-client", held: false })) }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), message: vi.fn() }), Toaster: () => null }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), ...api }));
vi.mock("@/hooks/useTaskService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTaskService")>();
  return { ...actual, useTaskService: () => ({ data: state.service, isPending: state.service === undefined }) };
});

import { toast } from "sonner";
import { deskRoutes } from "@/App";
import { ApiError } from "@/lib/api";
import { resetPersonSessions } from "@/hooks/useNtasksSignIn";
import { heldSentence } from "@/lib/ntasks-sign-in";
import { NEWER_NTASKS, OLDER_NTASKS, versionProblem } from "@/routes/TasksRoute";

/** An Ntasks at ORIGIN of the given API version, where nobody is signed in unless a request carries `person-token`. */
function ntasks(version = API_VERSION) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/version") return Response.json({ version, oldest: 1 });
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== "Bearer person-token") return Response.json({ error: "invalid_token" }, { status: 401 });
    if (url.pathname === "/api/workspaces") return Response.json({ workspaces: [] });
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(entry: string) {
  const table = [
    ...deskRoutes.filter((route) => route.path?.startsWith("/tasks")),
    { path: "/settings/task-projects", element: <output data-testid="task-projects" /> },
  ];
  const router = createMemoryRouter(table, { initialEntries: [entry] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeAll(async () => {
  // The Ntasks UI's toaster asks for the system's theme.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {},
    removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  await import("@/routes/TasksRoute");
}, 60_000);

afterEach(() => {
  state.service = undefined;
  resetPersonSessions();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Tasks pages of an installation with no task service connected", () => {
  it.each(["/tasks", "/tasks/focus", "/tasks/md-c1"])("lead from %s to Settings → Task projects", async (entry) => {
    state.service = NOT_CONNECTED;
    const router = renderAt(entry);
    const step = await screen.findByRole("link", { name: /Task projects/u });
    expect(document.querySelector("[data-ntasks]")).toBeNull();
    fireEvent.click(step);
    expect(await screen.findByTestId("task-projects")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/task-projects");
  });
});

describe("the Ntasks version", () => {
  it("is a problem only when the Ntasks is older than the pages, or no longer answers their version", () => {
    expect(versionProblem({ version: 1, oldest: 1 }, 2)).toBe(OLDER_NTASKS);
    expect(versionProblem({ version: 4, oldest: 3 }, 2)).toBe(NEWER_NTASKS);
    expect(versionProblem({ version: 2, oldest: 1 }, 2)).toBeNull();
    expect(versionProblem(null, 2)).toBeNull();
  });

  it("shows the sentence in place of the pages when the connected Ntasks is older", async () => {
    state.service = CONNECTED;
    ntasks(API_VERSION - 1);
    renderAt("/tasks");
    expect(await screen.findByRole("alert")).toHaveTextContent(OLDER_NTASKS);
    expect(document.querySelector("[data-ntasks]")).toBeNull();
  });
});

describe("the Ntasks UI inside the Tower", () => {
  it("asks a signed-out person to sign in before any task request, and starts the Tower's sign-in to that Ntasks", async () => {
    state.service = CONNECTED;
    const fetch = ntasks();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
    renderAt("/tasks");
    const signIn = await screen.findByRole("button", { name: "Sign in to Ntasks" });
    // The Ntasks UI is not mounted, so nothing but the public version read reaches Ntasks.
    expect(document.querySelector("[data-ntasks]")).toBeNull();
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/api/version"]);
    fireEvent.click(signIn);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    const authorize = new URL(String(assign.mock.calls[0]![0]));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ORIGIN}/api/auth/oauth2/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(fetch.mock.calls.every(([input]) => String(input).startsWith(ORIGIN))).toBe(true);
  });

  it("sends every request to the connected Ntasks with the signed-in person's own token", async () => {
    state.service = CONNECTED;
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify({ access: "person-token", refresh: null, expiresAt: Number.MAX_SAFE_INTEGER, name: "Pat Example" }));
    const fetch = ntasks();
    renderAt("/tasks");
    await vi.waitFor(() => expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain("/api/workspaces"));
    const reads = fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname !== "/api/version");
    expect(reads.every(([input]) => String(input).startsWith(ORIGIN))).toBe(true);
    expect(reads.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer person-token")).toBe(true);
  });

  it("with no Tower client ID saved, registers the Tower in Ntasks on the press, then signs in with the new one", async () => {
    state.service = UNREGISTERED;
    api.registerNtasksApp.mockResolvedValueOnce({ clientId: "tower-registered", held: false });
    const fetch = ntasks();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
    renderAt("/tasks");
    const signIn = await screen.findByRole("button", { name: "Sign in to Ntasks" });
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/api/version"]);
    fireEvent.click(signIn);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(api.registerNtasksApp).toHaveBeenCalledOnce();
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get("client_id")).toBe("tower-registered");
  });

  it("signs in at another address with the app Ntasks answers for it, and says where an owner allows an address Ntasks holds", async () => {
    state.service = CONNECTED;
    ntasks();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
    api.registerNtasksApp.mockResolvedValueOnce({ clientId: "tower-at-home", held: true });
    renderAt("/tasks");
    expect(document.querySelector("[data-ntasks-address-held]")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Ntasks" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get("client_id")).toBe("tower-at-home");

    // Back on the page, as after an owner has not allowed the address yet.
    cleanup();
    renderAt("/tasks");
    expect(await screen.findByText(heldSentence(window.location.origin))).toBeInTheDocument();
  });

  it("says why when the Tower could not be registered, and starts no sign-in", async () => {
    state.service = UNREGISTERED;
    ntasks();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
    const detail = "Ntasks refused to register the Tower (invalid_client_metadata). Nothing was saved.";
    api.registerNtasksApp.mockRejectedValueOnce(new ApiError(detail, 502, "ntasks_registration_refused"));
    renderAt("/tasks");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Ntasks" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not signed in to Ntasks", expect.objectContaining({ description: detail })));
    expect(assign).not.toHaveBeenCalled();
  });

  it("signs in again when Ntasks refuses the token this browser still holds", async () => {
    state.service = CONNECTED;
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify({ access: "revoked-token", refresh: null, expiresAt: Number.MAX_SAFE_INTEGER, name: "Pat Example" }));
    ntasks();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
    renderAt("/tasks");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
