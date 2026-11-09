import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTasksPayload, TaskServiceStatus, TasksCapabilities } from "@shared/tasks";
import type { WorkPayload } from "@shared/work";

// While this installation's tasks live in Ntasks, a decision, an approval or a
// dispute is taken only from a person signed in to Ntasks. A browser signed in
// to it sends them there as the person; one that is not shows Sign in to Ntasks.

const ORIGIN = "https://ntasks.example.com";
const APP = { origin: ORIGIN, clientId: "tower-client" };
const NTASKS: TaskServiceStatus = { connected: true, origin: ORIGIN, app: { clientId: APP.clientId, workspaceId: "w-1" },
  projects: [{ asset: "example.com", prefix: "md", project: { displayName: "Example", logicalKey: "example.com", projectId: "p-md" } }] };
const UNCONFIGURED: TaskServiceStatus = { connected: true, origin: ORIGIN, projects: null, app: null };
const LOCAL_HUB: TaskServiceStatus = { connected: false, origin: null, projects: null };
const TOKENS_KEY = `noticeos:ntasks-person:${ORIGIN}:${APP.clientId}`;

const state = vi.hoisted(() => ({
  work: null as WorkPayload | null,
  capabilities: { live: true, reason: null } as TasksCapabilities,
  boards: {} as Record<string, LiveTasksPayload>,
  service: undefined as TaskServiceStatus | undefined,
}));
const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async (..._args: unknown[]) => undefined),
  chooseOnTask: vi.fn(async (..._args: unknown[]) => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), ...api }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [] } }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isPending: false, isError: false }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useTaskService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTaskService")>();
  return { ...actual, useTaskService: () => ({ data: state.service }), useNeedsNtasks: () => actual.needsNtasks(state.service) };
});
vi.mock("@/hooks/useTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTasks")>()),
  useTasksLive: () => state.capabilities,
  useTasksLiveRead: () => ({ data: state.capabilities, isPending: false, fetchStatus: "idle" }),
  useTasksAcross: (projects: string[]) => projects.map((asset) => ({ data: state.boards[asset], isError: false, error: null })),
}));

import { resetPersonSessions } from "@/hooks/useNtasksSignIn";
import { flushAnswers, resetAnswerQueue } from "@/lib/answer-queue";
import { createPersonSession, finishSignIn, NtasksSignedOut, personDecisions, startSignIn, type TokenStorage } from "@/lib/ntasks-sign-in";
import { closableHere } from "@/routes/tasks/close-actions";
import { FocusRoute } from "@/routes/tasks/FocusRoute";
import { NextTab } from "@/routes/tasks/next/NextTab";
import { scenarioBoards, scenarioPayload } from "./tasks-next-fixtures";

function renderAt(element: ReactNode, entry: string) {
  state.work = scenarioPayload();
  state.boards = scenarioBoards();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function memoryStorage(seed: Record<string, string> = {}): TokenStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return { values, read: (name) => values.get(name) ?? null, write: (name, value) => { values.set(name, value); }, forget: (name) => { values.delete(name); } };
}
const tokens = (expiresAt: number, access = "access-1", refresh: string | null = "refresh-1") =>
  JSON.stringify({ access, refresh, expiresAt, name: "Pat Example" });
const NAME = `ntasks-person:${ORIGIN}:${APP.clientId}`;

afterEach(() => {
  state.service = undefined;
  resetAnswerQueue();
  resetPersonSessions();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the person's tokens", () => {
  it("refreshes an expired token once for every call waiting on it, and keeps the new one", async () => {
    const storage = memoryStorage({ [NAME]: tokens(1_000) });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ access_token: "access-2", expires_in: 3600, refresh_token: "refresh-2" }));
    const session = createPersonSession(APP, { storage, fetch, now: () => 10_000 });
    expect(await Promise.all([session.token(), session.token()])).toEqual(["access-2", "access-2"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/auth/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1",
      client_id: APP.clientId, resource: `${ORIGIN}/api/mcp` });
    expect(JSON.parse(storage.values.get(NAME)!)).toMatchObject({ access: "access-2", refresh: "refresh-2", expiresAt: 10_000 + 3_600_000, name: "Pat Example" });
    expect(session.snapshot()).toEqual({ signedIn: true, name: "Pat Example" });
  });

  it("signs out when Ntasks answers a call with 401, or refuses the refresh", async () => {
    const storage = memoryStorage({ [NAME]: tokens(Number.MAX_SAFE_INTEGER) });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }));
    const session = createPersonSession(APP, { storage, fetch, now: () => 0 });
    const listener = vi.fn();
    session.subscribe(listener);
    await expect(session.request("/api/tasks/projects")).rejects.toBeInstanceOf(NtasksSignedOut);
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer access-1" });
    expect(session.snapshot()).toEqual({ signedIn: false, name: null });
    expect(storage.values.has(NAME)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    const expired = memoryStorage({ [NAME]: tokens(1_000) });
    const refused = createPersonSession(APP, { storage: expired, fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }), now: () => 10_000 });
    expect(await refused.token()).toBeNull();
    expect(refused.snapshot().signedIn).toBe(false);
    expect(expired.values.has(NAME)).toBe(false);
  });

  it("keeps the sign-in when Ntasks does not answer a refresh, so the call can be sent again", async () => {
    const storage = memoryStorage({ [NAME]: tokens(1_000) });
    const answers = [new Response(null, { status: 503 }), Response.json({ access_token: "access-2", expires_in: 3600 })];
    const session = createPersonSession(APP, { storage, fetch: async () => answers.shift()!, now: () => 10_000 });
    await expect(session.token()).rejects.toMatchObject({ code: "task_service_unreachable" });
    expect(session.snapshot().signedIn).toBe(true);
    expect(JSON.parse(storage.values.get(NAME)!)).toMatchObject({ access: "access-1", refresh: "refresh-1" });
    expect(await session.token()).toBe("access-2");
  });

  it("does not sign in again when another tab signed out while a refresh was on its way", async () => {
    const storage = memoryStorage({ [NAME]: tokens(1_000) });
    let signOutElsewhere = () => {};
    const session = createPersonSession(APP, { storage, now: () => 10_000, fetch: async () => {
      signOutElsewhere();
      return Response.json({ access_token: "access-2", expires_in: 3600, refresh_token: "refresh-2" });
    } });
    signOutElsewhere = () => { storage.values.delete(NAME); };
    expect(await session.token()).toBeNull();
    expect(session.snapshot().signedIn).toBe(false);
    expect(storage.values.has(NAME)).toBe(false);
  });

  it.each([
    ["another project with the same prefix", "p-other", "w-1"],
    ["the same project ids in another workspace, as after a backup was loaded there", "p-md", "w-2"],
  ])("sends no decision when the sign-in reaches %s", async (_case, projectId, workspaceId) => {
    const storage = memoryStorage({ [NAME]: tokens(Number.MAX_SAFE_INTEGER) });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/api/access/me")
      ? Response.json({ kind: "person", name: "Pat Example", app: { workspaceId } })
      : Response.json({ projects: [{ projectId, prefix: "md", logicalKey: "example.com", displayName: "Example" }] }));
    const decisions = personDecisions(createPersonSession(APP, { storage, fetch, now: () => 0 }), () => ({ projectId: "p-md", workspaceId: "w-1" }));
    await expect(decisions.chooseOnTask("md-c1", "b")).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(fetch.mock.calls.map(([input]) => String(input)).filter((url) => url.endsWith("/choose"))).toEqual([]);
  });

  it("sends no decision, and blames no sign-in, while the Tower cannot say where the task is held", async () => {
    const storage = memoryStorage({ [NAME]: tokens(Number.MAX_SAFE_INTEGER) });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/api/access/me")
      ? Response.json({ kind: "person", name: "Pat Example", app: { workspaceId: "w-1" } })
      : Response.json({ projects: [{ projectId: "p-md", prefix: "md", logicalKey: "example.com", displayName: "Example" }] }));
    const decisions = personDecisions(createPersonSession(APP, { storage, fetch, now: () => 0 }), () => null);
    await expect(decisions.chooseOnTask("md-c1", "b")).rejects.toMatchObject({ code: "task_source_unknown" });
    expect(fetch.mock.calls.map(([input]) => String(input)).filter((url) => url.endsWith("/choose"))).toEqual([]);
  });

  it("starts a sign-in only with an Ntasks new enough for connected apps, with an S256 challenge of the verifier it keeps", async () => {
    const session = window.sessionStorage;
    const older = vi.fn<typeof globalThis.fetch>(async () => Response.json({ version: 1, oldest: 1 }));
    await expect(startSignIn(APP, { towerOrigin: "http://localhost:4173", returnTo: "/tasks", fetch: older, session })).rejects.toThrow(/API version 2/u);
    expect(session.length).toBe(0);

    const current = vi.fn<typeof globalThis.fetch>(async () => Response.json({ version: 2, oldest: 1 }));
    const address = new URL(await startSignIn(APP, { towerOrigin: "http://localhost:4173", returnTo: "/tasks?project=x", fetch: current, session }));
    expect(`${address.origin}${address.pathname}`).toBe(`${ORIGIN}/api/auth/oauth2/authorize`);
    const asked = Object.fromEntries(address.searchParams);
    expect(asked).toMatchObject({ response_type: "code", client_id: APP.clientId, redirect_uri: "http://localhost:4173/tasks/signed-in",
      code_challenge_method: "S256", resource: `${ORIGIN}/api/mcp`, scope: "tasks:read tasks:write tasks:decide offline_access" });
    const pending = JSON.parse(session.getItem("noticeos:ntasks-sign-in")!) as { verifier: string; state: string };
    expect(pending.state).toBe(asked.state);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)));
    expect(asked.code_challenge).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""));
  });

  it("finishes only the sign-in this tab started, and keeps the person's tokens and name", async () => {
    const session = window.sessionStorage;
    await startSignIn(APP, { towerOrigin: "http://localhost:4173", returnTo: "/tasks?project=x", session,
      fetch: async () => Response.json({ version: 2, oldest: 1 }) });
    const { state: sent, verifier } = JSON.parse(session.getItem("noticeos:ntasks-sign-in")!) as { state: string; verifier: string };
    const storage = memoryStorage();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/api/access/me")
      ? Response.json({ kind: "person", name: "Pat Example" })
      : Response.json({ access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1" }));
    const holder = createPersonSession(APP, { storage, fetch, now: () => 0 });
    await expect(finishSignIn(`?code=c1&state=other`, { session, sessionFor: () => holder })).rejects.toThrow(/not started from this tab/u);
    expect(fetch).not.toHaveBeenCalled();

    session.setItem("noticeos:ntasks-sign-in", JSON.stringify({ origin: ORIGIN, clientId: APP.clientId, redirectUri: "http://localhost:4173/tasks/signed-in",
      verifier, state: sent, returnTo: "/tasks?project=x" }));
    expect(await finishSignIn(`?code=c1&state=${sent}`, { session, sessionFor: () => holder })).toEqual({ returnTo: "/tasks?project=x" });
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]![1]?.body)))).toMatchObject({ grant_type: "authorization_code", code: "c1",
      code_verifier: verifier, redirect_uri: "http://localhost:4173/tasks/signed-in", client_id: APP.clientId });
    expect(holder.snapshot()).toEqual({ signedIn: true, name: "Pat Example" });
    expect(session.getItem("noticeos:ntasks-sign-in")).toBeNull();
  });
});

describe("closing a task from its row", () => {
  it("declines a task waiting on a person here unless the browser must sign in to Ntasks first", () => {
    const capabilities: TasksCapabilities = { live: true, reason: null };
    const waiting = { labels: ["human"] };
    const plain = { labels: [] };
    expect(closableHere(waiting, capabilities, false)).toBe(true);
    expect(closableHere(waiting, capabilities, true)).toBe(false);
    expect(closableHere(plain, capabilities, true)).toBe(true);
  });
});

/** Approve, Answer, and the options of the scenario's choice. */
const DECIDING = [/^Approve/u, /^Answer/u, /Monday|Tuesday|Friday/u];

describe("deciding while tasks live in Ntasks", () => {
  it("shows Sign in to Ntasks for every decision on the Next tab, and its brief, while this browser is signed out", () => {
    state.service = NTASKS;
    renderAt(<NextTab scope={null} />, "/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Read it as a brief" }));
    expect(screen.getAllByRole("button", { name: "Sign in to Ntasks" }).length).toBeGreaterThanOrEqual(3);
    for (const name of DECIDING) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
  });

  it("leads to Settings → Task projects while no Tower client ID is saved", () => {
    state.service = UNCONFIGURED;
    renderAt(<NextTab scope={null} />, "/tasks");
    for (const link of screen.getAllByRole("link", { name: "Set up Ntasks sign-in" })) expect(link).toHaveAttribute("href", "/settings/task-projects#ntasks");
    expect(screen.queryByRole("button", { name: /Tuesday/u })).toBeNull();
  });

  it("sends a signed-in person's pick to Ntasks with their own token, never through the Tower's route", async () => {
    state.service = NTASKS;
    window.localStorage.setItem(TOKENS_KEY, tokens(Number.MAX_SAFE_INTEGER, "person-token"));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/api/tasks/projects")
      ? Response.json({ projects: [{ projectId: "p-md", prefix: "md", logicalKey: "example.com", displayName: "Example" }] })
      : String(input).endsWith("/api/access/me") ? Response.json({ kind: "person", name: "Pat Example", app: { workspaceId: "w-1" } })
        : Response.json({ task: { id: "md-c1" } }));
    vi.stubGlobal("fetch", fetch);
    renderAt(<NextTab scope={null} />, "/tasks");
    expect(screen.queryByRole("button", { name: "Sign in to Ntasks" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Tuesday/u })[0]!);
    act(() => flushAnswers());
    const toNtasks = () => fetch.mock.calls.filter(([input]) => String(input).startsWith(ORIGIN));
    await vi.waitFor(() => expect(toNtasks().map(([input]) => String(input))).toContain(`${ORIGIN}/api/tasks/md-c1/choose`));
    const [, init] = toNtasks().find(([input]) => String(input).endsWith("/choose"))!;
    expect(init?.headers).toMatchObject({ authorization: "Bearer person-token", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ projectId: "p-md", option: "b" });
    expect(api.chooseOnTask).not.toHaveBeenCalled();
  });

  it("keeps every button on the Next tab, on the Tower's own routes, while tasks live in the local hub", () => {
    state.service = LOCAL_HUB;
    renderAt(<NextTab scope={null} />, "/tasks");
    expect(screen.queryByRole("button", { name: "Sign in to Ntasks" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Approve/u }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /Tuesday/u })[0]!);
    act(() => flushAnswers());
    expect(api.chooseOnTask).toHaveBeenCalledWith("md-c1", "b", undefined);
  });

  it("in Focus, offers sign-in and leaves the option keys unbound while signed out, so a key press sends nothing", () => {
    state.service = NTASKS;
    const { container } = renderAt(<FocusRoute />, "/tasks/focus?task=md-c1");
    const decision = container.querySelector<HTMLElement>("[data-focus-decision]")!;
    expect(decision).toHaveAttribute("data-focus-decision", "md-c1");
    expect(within(decision).getByRole("button", { name: "Sign in to Ntasks" })).toBeVisible();
    expect(within(decision).queryByRole("button", { name: /Tuesday/u })).toBeNull();
    fireEvent.keyDown(window, { key: "b" });
    act(() => flushAnswers());
    expect(api.chooseOnTask).not.toHaveBeenCalled();
    expect(container.querySelector("[data-focus-decision]")).toHaveAttribute("data-focus-decision", "md-c1");
  });
});
