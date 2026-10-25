// @vitest-environment node
import { describe, expect, it } from "vitest";
import { journeyRequestHandler, journeyRoute } from "../vite/journey-lane";
import { handleConfigRequest } from "../vite/config-write-lane";
import type { JourneyManagementSource } from "../../../scripts/journey-management.mjs";

const asset = "example.com";
const definition = {
  id: "calculator", label: "Complete a calculation", goal: "Calculator use", kind: "funnel", status: "active",
  steps: [
    { id: "start", label: "Start", alternatives: [{ eventName: "calculator_start" }] },
    { id: "complete", label: "Result shown", alternatives: [{ eventName: "calculator_complete" }] },
  ],
};
const headers = { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" };
const target = `/api/assets/${asset}/journeys`;
function fixture() {
  let reads = 0;
  const writes: unknown[] = [];
  const source: JourneyManagementSource = {
    async read(id) {
      reads++;
      return { known: id === asset, document: { version: 7, body: { assets: { [asset]: { valueEvents: ["calculator_complete"] } } } } };
    },
    async apply(input) { writes.push(input); return { status: 200, body: { applied: 1, exported: true } }; },
  };
  return { handle: journeyRequestHandler({ source }), writes, reads: () => reads };
}

describe("the standalone Journey HTTP resource", () => {
  it("reads saved settings and previews or saves through the same guarded operation", async () => {
    const f = fixture();
    expect(await f.handle({ method: "GET", headers, body: "", url: target })).toMatchObject({
      status: 200, body: { asset, documentVersion: 7, journeys: [], eventNames: ["calculator_complete"] },
    });
    const input = { journey: definition, edit_token: null, dry_run: true };
    expect(await f.handle({ method: "PUT", headers, body: JSON.stringify(input), url: `${target}/calculator` })).toMatchObject({
      status: 200, body: { dry_run: true, definition: { version: 1 }, collection: { immediateFetch: false } },
    });
    expect(f.writes).toEqual([]);
    expect(await f.handle({ method: "PUT", headers, body: JSON.stringify({ ...input, dry_run: false }), url: `${target}/calculator` })).toMatchObject({
      status: 200, body: { exported: true, definition: { id: "calculator", version: 1 } },
    });
    expect(f.writes).toMatchObject([{ expectVersions: { "config/value-events.json": 7 } }]);
  });

  it("rejects another origin and malformed requests before reading or writing settings", async () => {
    const f = fixture();
    const request = { method: "PUT", headers, body: JSON.stringify({ journey: definition, edit_token: null }), url: `${target}/calculator` };
    expect((await f.handle({ ...request, headers: { ...headers, origin: "https://other.example" } })).status).toBe(403);
    expect((await f.handle({ ...request, headers: { ...headers, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await f.handle({ ...request, body: "{" })).status).toBe(400);
    expect((await f.handle({ ...request, headers: { host: "localhost:5173" } })).status).toBe(415);
    expect((await f.handle({ ...request, url: `${target}/different-id` })).status).toBe(422);
    expect((await f.handle({ ...request, body: JSON.stringify({ journey: definition, edit_token: null, actor: "owner" }) })).status).toBe(422);
    expect(f.reads()).toBe(0);
    expect(f.writes).toEqual([]);
  });

  it("keeps the resource path exact and reports missing assets", async () => {
    expect(journeyRoute(`${target}?workspace=other`)).toBeNull();
    expect(journeyRoute(`${target}/calculator/extra`)).toBeNull();
    expect(journeyRoute("/api/assets/example%2fcom/journeys")).toBeNull();
    const f = fixture();
    expect((await f.handle({ method: "POST", headers, body: "{}", url: target })).status).toBe(405);
    expect((await f.handle({ method: "GET", headers, body: "", url: "/api/assets/missing.example/journeys" })).status).toBe(404);
    expect(f.writes).toEqual([]);
  });
});

describe("Journey document version guards in the existing local config writer", () => {
  it("passes the observed version to the store and preserves a stale-version refusal", async () => {
    const writes: unknown[] = [];
    const input = {
      ops: [{ kind: "file-json-insert", file: "config/value-events.json", pointer: `/assets/${asset}/journeys`, value: [{ ...definition, version: 1 }] }],
      slug: "journey-calculator", expectVersions: { "config/value-events.json": 7 },
    };
    const reply = await handleConfigRequest({ method: "PUT", headers, body: JSON.stringify(input) }, { store: {
      state: async () => ({ ready: true, reason: null, unseeded: [] }),
      apply: async (value) => { writes.push(value); return { status: 409, body: { ok: false, error: "version_mismatch" } }; },
    } });
    expect(writes).toEqual([{ ...input, actor: "operator" }]);
    expect(reply).toEqual({ status: 409, body: { error: "version_mismatch" } });
  });
});
