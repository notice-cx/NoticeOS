// A hosted person's own view: read back the newest save for this person in
// this workspace, save one row per PUT, refuse a body that is not a view
// choice, and answer nobody but a signed-in person. Standalone and the demo
// have no person and get 404.

import { describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "@noticeos/postgres";
import {
  PERSON_VIEW_PREFERENCE_PATH,
  handleHostedPersonPreference,
  handlePersonViewPreference,
} from "../worker/person-preference-route";
import type { withWorkspaceEntry } from "../../../scripts/workspace-entry.mjs";
import type { WorkspaceContext } from "../../../scripts/workspace-admission.mjs";

const ORIGIN = "https://tower.example.com";
const WORKSPACE = "0000000a-0000-4000-8000-00000000000a";
const PERSON = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const SESSION = "00000000-0000-4000-8000-0000000000cc";

interface Row { workspace_id: string; preference_id: number; person_id: string; name: string; value: unknown }

/** The table, in memory: inserts append, the newest-per-person read sorts by id. */
function memoryStore() {
  const rows: Row[] = [];
  const tx = {
    workspaceId: WORKSPACE,
    async query(sql: string, params: readonly unknown[] = []) {
      expect(sql).toMatch(/FROM noticeos\.person_preferences/);
      return rows
        .filter((row) => row.workspace_id === params[0] && row.person_id === params[1] && row.name === "view")
        .sort((a, b) => b.preference_id - a.preference_id)
        .slice(0, 1)
        .map((row) => ({ value: row.value }));
    },
    async execute(sql: string, params: readonly unknown[] = []) {
      expect(sql).toMatch(/INSERT INTO noticeos\.person_preferences/);
      rows.push({ workspace_id: String(params[0]), preference_id: rows.length + 1, person_id: String(params[1]),
        name: "view", value: JSON.parse(String(params[2])) });
      return 1;
    },
  };
  const store = {
    read: vi.fn(async <T>(work: (t: typeof tx) => Promise<T>) => work(tx)),
    write: vi.fn(async <T>(work: (t: typeof tx) => Promise<T>) => work(tx)),
  } as unknown as Pick<WorkspaceStore, "read" | "write">;
  return { rows, store };
}

const person = { principalKind: "person", principalId: PERSON, sessionId: SESSION } as const;

function get(): Request {
  return new Request(ORIGIN + PERSON_VIEW_PREFERENCE_PATH, { headers: { "sec-fetch-site": "same-origin" } });
}
function put(body: string, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request(ORIGIN + PERSON_VIEW_PREFERENCE_PATH, { method: "PUT", headers: { origin: ORIGIN, ...headers }, body });
}
async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET and PUT /api/me/preferences/view", () => {
  it("answers no choice before the person saves one", async () => {
    const { store } = memoryStore();
    expect(await json(await handlePersonViewPreference(get(), person, store))).toEqual({ status: 200, body: { choice: null } });
  });

  it("saves one row per PUT and reads the newest back, for this person only", async () => {
    const { rows, store } = memoryStore();
    const first = await json(await handlePersonViewPreference(put('{"view":"revenue","focus":["money"]}'), person, store));
    expect(first).toEqual({ status: 200, body: { choice: { view: "revenue", focus: ["money"] } } });
    await handlePersonViewPreference(put('{"view":"growth","focus":["visitors","nonsense"]}'), person, store);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ workspace_id: WORKSPACE, person_id: PERSON, value: { view: "growth", focus: ["visitors"] } });
    expect(await json(await handlePersonViewPreference(get(), person, store)))
      .toEqual({ status: 200, body: { choice: { view: "growth", focus: ["visitors"] } } });
    const other = { ...person, principalId: OTHER };
    expect((await json(await handlePersonViewPreference(get(), other, store))).body).toEqual({ choice: null });
  });

  it.each(["overview", "growth", "revenue", "delivery", "reliability"])("saves and reads the %s purpose", async (view) => {
    const { rows, store } = memoryStore();
    const choice = { view, focus: ["money"] };
    expect((await json(await handlePersonViewPreference(put(JSON.stringify(choice)), person, store))).body).toEqual({ choice });
    expect((await json(await handlePersonViewPreference(get(), person, store))).body).toEqual({ choice });
    expect(rows[0]?.value).toEqual(choice);
  });

  it.each(["business", "product", "everything"])("reads legacy %s without changing the stored row", async (view) => {
    const { rows, store } = memoryStore();
    rows.push({ workspace_id: WORKSPACE, person_id: PERSON, preference_id: 1, name: "view", value: { view, focus: ["visitors"] } });
    const expected = { view: "overview", focus: ["visitors"], ...(view === "everything" ? {} : { needsPurposeChoice: true }) };
    expect((await json(await handlePersonViewPreference(get(), person, store))).body).toEqual({ choice: expected });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ view, focus: ["visitors"] });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a view choice with a one-line reason, and stores nothing", async () => {
    const { rows, store } = memoryStore();
    for (const body of ["not json", "[]", '{"view":"unknown"}', '{"view":"revenue","focus":"money"}',
      JSON.stringify({ view: "revenue", focus: ["x".repeat(3000)] })]) {
      const { status, body: answer } = await json(await handlePersonViewPreference(put(body), person, store));
      expect(status, body.slice(0, 40)).toBe(400);
      expect(answer.error).toBe("invalid_view_choice");
      expect(String(answer.reason)).toMatch(/^[^\n]+$/);
    }
    expect((await handlePersonViewPreference(put("{}", { "content-type": "text/plain" }), person, store)).status).toBe(415);
    expect((await handlePersonViewPreference(put('{"view":"revenue"}', { "content-type": "application/json",
      origin: "https://elsewhere.example.com" }), person, store)).status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it("answers nobody but a signed-in person", async () => {
    const { rows, store } = memoryStore();
    for (const caller of [
      { principalKind: "agent", principalId: PERSON, sessionId: undefined },
      { principalKind: "person", principalId: PERSON, sessionId: undefined },
      { principalKind: "standalone-operator", principalId: "operator", sessionId: undefined },
      { principalKind: "demo-reader", principalId: "demo-reader", sessionId: undefined },
    ] as const) {
      expect((await handlePersonViewPreference(put('{"view":"revenue"}'), caller, store)).status).toBe(403);
      expect((await handlePersonViewPreference(get(), caller, store)).status).toBe(403);
    }
    expect(rows).toHaveLength(0);
  });
});

describe("the Worker's entry for /api/me/preferences/view", () => {
  function entry(context: Partial<WorkspaceContext>, store: Pick<WorkspaceStore, "read" | "write">) {
    return vi.fn(async (_env: object, _proof: Request, work: Parameters<typeof withWorkspaceEntry>[2]) =>
      work({ context: context as WorkspaceContext,
        withStore: async (_ctx, use) => use(store as WorkspaceStore) })) as unknown as typeof withWorkspaceEntry;
  }
  const ctx = { waitUntil() {} };

  it("passes other paths by, and answers 404 where there is no person", async () => {
    const { store } = memoryStore();
    const admit = entry({ principalKind: "person", principalId: PERSON, sessionId: SESSION }, store);
    expect(await handleHostedPersonPreference(new Request(ORIGIN + "/api/wall"), {}, ctx, "hosted", admit)).toBeNull();
    for (const profile of ["standalone", "demo"] as const) {
      expect((await handleHostedPersonPreference(get(), {}, ctx, profile, admit))?.status).toBe(404);
    }
    expect((await handleHostedPersonPreference(new Request(ORIGIN + PERSON_VIEW_PREFERENCE_PATH, { method: "DELETE" }),
      {}, ctx, "hosted", admit))?.status).toBe(405);
    expect(admit).not.toHaveBeenCalled();
  });

  it("saves and reads through admission for a person, refuses an agent, and hides a refusal or a store fault", async () => {
    const { store } = memoryStore();
    const admit = entry({ principalKind: "person", principalId: PERSON, sessionId: SESSION }, store);
    expect((await handleHostedPersonPreference(put('{"view":"revenue","focus":[]}'), {}, ctx, "hosted", admit))?.status).toBe(200);
    const read = await handleHostedPersonPreference(get(), {}, ctx, "hosted", admit);
    expect(await read!.json()).toEqual({ choice: { view: "revenue", focus: [] } });

    const agent = entry({ principalKind: "agent", principalId: PERSON }, store);
    expect((await handleHostedPersonPreference(get(), {}, ctx, "hosted", agent))?.status).toBe(403);

    const refused = vi.fn(async () => { throw new Error("Workspace action is not authorized."); }) as unknown as typeof withWorkspaceEntry;
    expect(await json((await handleHostedPersonPreference(get(), {}, ctx, "hosted", refused))!))
      .toEqual({ status: 403, body: { error: "workspace_entry_unavailable" } });

    const broken = { read: async () => { throw new Error("connection to 10.0.0.1 refused"); }, write: async () => 0 } as unknown as WorkspaceStore;
    expect(await json((await handleHostedPersonPreference(get(), {}, ctx, "hosted", entry({ principalKind: "person", principalId: PERSON, sessionId: SESSION }, broken)))!))
      .toEqual({ status: 503, body: { error: "preference_unavailable" } });
  });
});
