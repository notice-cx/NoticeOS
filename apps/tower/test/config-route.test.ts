// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_ACTOR,
  CONFIG_STORE_NOT_READY_REASON,
  handleConfigRequest,
} from "../worker/config-route";
import type {
  ConfigDocumentReader,
  ConfigOpsResult,
  TowerConfig,
} from "../worker/config-source";

// `GET/PUT /api/config`: where a setting comes from, and where a Save lands.
// The store holds a document per config file, so a Save is possible in every
// deployment. The store's own behaviour is pinned in
// workers/ingest/test/config-store.test.ts; what is asserted here is the
// route: what it sends, what statuses it maps a refusal to, and that the
// request/response contract `apps/tower/src/lib/api.ts` speaks did not move.

const URL_ = "https://tower.example/api/config";

function towerConfig(overrides: Partial<TowerConfig> = {}): TowerConfig {
  return {
    storeAvailable: true,
    storeFailure: null,
    sources: { "config/tower.json": "store", "config/constants.json": "file" },
    versions: { "config/tower.json": 3, "config/constants.json": null },
    ...overrides,
  } as TowerConfig;
}

function reader(applyConfigOps: ConfigDocumentReader["applyConfigOps"]): ConfigDocumentReader {
  return {
    getConfigDocuments: async () => [],
    applyConfigOps,
  };
}

const PUT = (body: unknown) =>
  new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const OPS = [
  {
    kind: "file-json-set",
    file: "config/tower.json",
    pointer: "/countdown/label",
    expect: "Launch",
    value: "Ship",
  },
];

describe("GET /api/config", () => {
  it("says the store can take a write, and where each value came from", async () => {
    const res = await handleConfigRequest(new Request(URL_), {
      ingest: reader(async () => ({ ok: true as const, applied: 0, documents: [] })),
      config: async () => towerConfig(),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      writable: true,
      reason: null,
      sources: { "config/tower.json": "store", "config/constants.json": "file" },
      versions: { "config/tower.json": 3 },
    });
  });

  it("disables editing while the settings connection is unavailable", async () => {
    const res = await handleConfigRequest(new Request(URL_), {
      ingest: reader(async () => ({ ok: true as const, applied: 0, documents: [] })),
      config: async () =>
        towerConfig({ storeAvailable: false, storeFailure: "connection unavailable", sources: {}, versions: {} }),
    });
    await expect(res.json()).resolves.toMatchObject({
      writable: false,
      reason: CONFIG_STORE_NOT_READY_REASON,
    });
    expect(CONFIG_STORE_NOT_READY_REASON).toContain("connection");
  });
});

describe("PUT /api/config", () => {
  it("applies through the store and answers the shape the client already speaks", async () => {
    const applyConfigOps = vi.fn(async () => ({
      ok: true as const,
      applied: 1,
      documents: [{ file: "config/tower.json", version: 4, body: {} }],
    }));
    const res = await handleConfigRequest(PUT({ ops: OPS, slug: "countdown-label" }), {
      ingest: reader(applyConfigOps),
      config: async () => towerConfig(),
    });

    expect(res.status).toBe(200);
    expect(applyConfigOps).toHaveBeenCalledWith(
      expect.objectContaining({ ops: OPS, actor: CONFIG_ACTOR, slug: "countdown-label" }),
    );
    // `archive` and `commit` are null: a store write has no changeset file and
    // makes no commit.
    await expect(res.json()).resolves.toEqual({
      applied: 1,
      archive: null,
      commit: null,
      documents: [{ file: "config/tower.json", version: 4 }],
    });
  });

  it("returns a safe unavailable response if the save connection fails", async () => {
    const applyConfigOps = vi.fn(async () => { throw new Error("private connection detail"); });
    const res = await handleConfigRequest(PUT({ ops: OPS }), {
      ingest: reader(applyConfigOps), config: async () => towerConfig(),
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "store_unavailable", detail: CONFIG_STORE_NOT_READY_REASON });
    expect(applyConfigOps).toHaveBeenCalledTimes(1);
  });

  it("maps each refusal to the status the operator's next move depends on", async () => {
    const cases: [Extract<ConfigOpsResult, { ok: false }>, number][] = [
      [{ ok: false, error: "store_unavailable", detail: "connection unavailable" }, 503],
      [{ ok: false, error: "not_seeded", detail: "nothing holds it", files: [] }, 503],
      [{ ok: false, error: "expect_mismatch", mismatches: [] }, 409],
      [{ ok: false, error: "version_mismatch", files: [] }, 409],
      [{ ok: false, error: "invalid_changeset", detail: "not a declared field" }, 422],
      [{ ok: false, error: "store_op_not_accepted", detail: "wrong door" }, 422],
    ];
    for (const [answer, status] of cases) {
      const res = await handleConfigRequest(PUT({ ops: OPS }), {
        ingest: reader(async () => answer),
        config: async () => towerConfig(),
      });
      expect(res.status).toBe(status);
      // The body is the store's own, minus `ok`.
      await expect(res.json()).resolves.toMatchObject({ error: answer.error });
    }
  });

  it("hands a /wall op to the store untouched, and passes its refusal back whole", async () => {
    // The route adds no validation of its own: the layout rule lives in
    // scripts/wall-layout.mjs, which the ingest's `applyConfigOps` runs through
    // `validateSchemaAndSafety`. The route neither rewrites the op on the way
    // in nor swallows the validator's sentence on the way out.
    const wallOp = {
      kind: "file-json-set",
      file: "config/tower.json",
      pointer: "/wall",
      expect: null,
      value: { layout: { version: 1, rows: [] }, history: [] },
    };
    let sent: unknown = null;
    const res = await handleConfigRequest(PUT({ ops: [wallOp], slug: "wall-layout" }), {
      ingest: reader(async (input) => {
        sent = input;
        return {
          ok: false,
          error: "invalid_changeset",
          detail: "op #1: config/tower.json wall.layout: A layout needs at least one row.",
        };
      }),
      config: async () => towerConfig(),
    });
    expect(sent).toMatchObject({ ops: [wallOp], slug: "wall-layout" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_changeset",
      detail: "op #1: config/tower.json wall.layout: A layout needs at least one row.",
    });
  });

  it("refuses a malformed body before anything reaches the store", async () => {
    const applyConfigOps = vi.fn(async () => ({ ok: true as const, applied: 0, documents: [] }));
    const deps = { ingest: reader(applyConfigOps), config: async () => towerConfig() };

    expect(
      (
        await handleConfigRequest(
          new Request(URL_, { method: "PUT", body: "{", headers: { "content-type": "application/json" } }),
          deps,
        )
      ).status,
    ).toBe(400);
    expect((await handleConfigRequest(PUT({ ops: "not an array" }), deps)).status).toBe(422);
    expect((await handleConfigRequest(PUT({ ops: [], slug: 7 }), deps)).status).toBe(422);
    expect(applyConfigOps).not.toHaveBeenCalled();
  });

  it("says the store is unavailable when there is no binding at all", async () => {
    const res = await handleConfigRequest(PUT({ ops: OPS }), {
      ingest: null,
      config: async () => towerConfig(),
    });
    expect(res.status).toBe(503);
  });

  it("answers nothing else", async () => {
    const res = await handleConfigRequest(new Request(URL_, { method: "DELETE" }), {
      ingest: reader(async () => ({ ok: true as const, applied: 0, documents: [] })),
      config: async () => towerConfig(),
    });
    expect(res.status).toBe(405);
  });
});


it("keeps deployed task-project writes in local setup and never asks the store to echo host metadata", async () => {
  const applyConfigOps = vi.fn(async () => ({ ok: false as const, error: "expect_mismatch" as const, mismatches: [{ expect: null, absent: false, current: { repo: "/private/checkout" } }] }));
  for (const kind of ["file-json-set", "file-json-insert", "file-json-delete"]) {
    const res = await handleConfigRequest(PUT({ ops: [...OPS, {
      kind, file: "config/beads.json", pointer: "/spokes/0", value: {}, expect: {},
    }] }), { ingest: reader(applyConfigOps), config: async () => towerConfig() });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: "local_task_setup_required" });
    expect(JSON.stringify(body)).not.toContain("/private/");
  }
  expect(applyConfigOps).not.toHaveBeenCalled();
});
