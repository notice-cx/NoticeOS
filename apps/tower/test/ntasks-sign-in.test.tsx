import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonSession, finishSignIn, NtasksSignedOut, personDecisions, startSignIn, type TokenStorage } from "@/lib/ntasks-sign-in";

// A person's sign-in to Ntasks from the Tower: the PKCE start and finish, and
// the tokens this browser keeps and refreshes for them.

const ORIGIN = "https://ntasks.example.com";
const APP = { origin: ORIGIN, clientId: "tower-client" };

function memoryStorage(seed: Record<string, string> = {}): TokenStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return { values, read: (name) => values.get(name) ?? null, write: (name, value) => { values.set(name, value); }, forget: (name) => { values.delete(name); } };
}
const tokens = (expiresAt: number, access = "access-1", refresh: string | null = "refresh-1") =>
  JSON.stringify({ access, refresh, expiresAt, name: "Pat Example" });
const NAME = `ntasks-person:${ORIGIN}:${APP.clientId}`;

afterEach(() => {
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
