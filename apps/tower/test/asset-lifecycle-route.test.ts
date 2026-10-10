// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CreateAssetInput, CreateAssetResult } from "@noticeos/contract";
import { handleCreateAssetRequest, type AssetLifecycleWriter } from "../worker/asset-lifecycle-route";

// POST /api/assets: an asset row is born. Nothing removes one: a site is
// archived, never deleted. The Tower proxies to `createAsset()` on the ingest
// WorkerEntrypoint over the private INGEST Service Binding, so what is
// asserted is the boundary: what crosses it, and how each answer is rendered
// for the browser. The id shape and the lifecycle enum are asserted in
// workers/ingest/test/asset-lifecycle.test.ts.
//
// The binding is stubbed rather than bound: this project's Vitest runs in
// node/jsdom with no workerd. The stub is typed by the shared contract.

const COLLECTION_URL = new URL("https://tower.local/api/assets");

const CREATED = {
  id: "brandnew.test",
  domain: "brandnew.test",
  displayName: "Brand New",
  status: "onboarding",
  senseOnly: 1,
  isOs: 0,
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
} as const;

interface Stub {
  ingest: AssetLifecycleWriter;
  created: CreateAssetInput[];
}

/** The binding, stubbed at its RPC. The reply may be an Error, standing in
 * for a store failure behind the boundary. */
function stubIngest(create: CreateAssetResult | Error = { ok: true, asset: { ...CREATED } }): Stub {
  const created: CreateAssetInput[] = [];
  return {
    created,
    ingest: {
      async createAsset(input) {
        created.push(input);
        if (create instanceof Error) throw create;
        return create;
      },
    },
  };
}

const SAME_ORIGIN = {
  origin: COLLECTION_URL.origin,
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

function post(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(COLLECTION_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/assets — an asset is created", () => {
  it("passes the body through as a claim and answers 201 with the row the store wrote", async () => {
    const { ingest, created } = stubIngest();
    const res = await handleCreateAssetRequest(
      post({ id: "brandnew.test", displayName: "Brand New", domain: "brandnew.test" }),
      COLLECTION_URL,
      ingest,
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/api/assets/brandnew.test");
    await expect(res.json()).resolves.toEqual({ ok: true, asset: CREATED });
    // A claim, not a check: ingest is the validator, and nothing here narrowed
    // the body before handing it over.
    expect(created).toEqual([
      { id: "brandnew.test", displayName: "Brand New", domain: "brandnew.test" },
    ]);
  });

  // There is no authentication on the LAN Tower, so the boundary is the same
  // one every write route uses.
  it("refuses a cross-origin create without asking the store", async () => {
    const { ingest, created } = stubIngest();
    const res = await handleCreateAssetRequest(
      post({ id: "x.test", displayName: "X" }, { ...SAME_ORIGIN, origin: "https://evil.example" }),
      COLLECTION_URL,
      ingest,
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect(created).toEqual([]);
  });

  it("refuses a non-JSON content type (415) and an unparseable body (400)", async () => {
    const { ingest, created } = stubIngest();
    const noType = await handleCreateAssetRequest(
      post({ id: "x.test" }, { "sec-fetch-site": "same-origin" }),
      COLLECTION_URL,
      ingest,
    );
    expect(noType.status).toBe(415);

    const garbage = await handleCreateAssetRequest(post("not json"), COLLECTION_URL, ingest);
    expect(garbage.status).toBe(400);
    expect(created).toEqual([]);
  });

  it("refuses a body that is not a JSON object (422)", async () => {
    const { ingest, created } = stubIngest();
    const res = await handleCreateAssetRequest(post([1, 2, 3]), COLLECTION_URL, ingest);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: "invalid_asset", field: "body" });
    expect(created).toEqual([]);
  });

  // A taken id is an ordinary answer a wizard renders beside the id field:
  // a 409 with the id in it, never a 500.
  it("renders a duplicate id as 409 asset_exists", async () => {
    const { ingest } = stubIngest({ ok: false, error: "asset_exists", asset: "meadow.example", existingStatus: "retired" });
    const res = await handleCreateAssetRequest(
      post({ id: "meadow.example", displayName: "Again" }),
      COLLECTION_URL,
      ingest,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "asset_exists", id: "meadow.example", existingStatus: "retired" });
  });

  it("carries the store's own sentence about the field it refused (422)", async () => {
    const { ingest } = stubIngest({
      ok: false,
      error: "validation",
      issues: [{ path: "id", code: "invalid_value", message: "Site must be a site id" }],
    });
    const res = await handleCreateAssetRequest(
      post({ id: "NOT VALID", displayName: "Bad" }),
      COLLECTION_URL,
      ingest,
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: "invalid_asset",
      field: "id",
      detail: "Site must be a site id",
    });
  });

  // The browser gets a code it can act on, never ingest's internals.
  it("turns a binding failure into an opaque 500", async () => {
    const { ingest } = stubIngest(new Error("D1_ERROR: disk is on fire"));
    const res = await handleCreateAssetRequest(
      post({ id: "x.test", displayName: "X" }),
      COLLECTION_URL,
      ingest,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "asset_create_failed" });
  });
});
