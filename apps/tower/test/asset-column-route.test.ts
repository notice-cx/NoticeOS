// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  AssetStateRead,
  AssetStateWriteResult,
  WriteAssetColumnInput,
} from "@noticeos/contract";
import {
  handleAssetColumnRequest,
  type AssetColumnWriter,
} from "../worker/asset-column-route";

// PATCH /api/assets/:id — the two settings that live in the STORE rather
// than in a file: an asset's lifecycle stage and its automation mode. They save
// in every deployment, which is the whole reason they do not go through the
// local config write lane (D18, bead ro-pbzu.5).
//
// The Tower does not write the row: it proxies to `writeAssetColumn()` on the
// ingest WorkerEntrypoint over the private INGEST Service Binding. So what is
// asserted here is the boundary — what crosses it, the expect guard, and how
// each answer ingest can give is rendered for the browser. The column
// allowlist, the lifecycle enum and the 0/1 rule are asserted against real D1 in
// workers/ingest/test/asset-state.test.ts, which is their only home.
//
// The binding is stubbed rather than bound: this project's Vitest runs in
// node/jsdom with no workerd (vitest.config.ts). The stub is typed by the shared
// contract, so a change to either RPC's shape breaks these tests at compile time.

const REQUEST_URL = new URL("https://tower.local/api/assets/meals.example");

function state(overrides: Partial<AssetStateRead> = {}): AssetStateRead {
  return {
    asset: "meals.example",
    known: true,
    columns: { status: "onboarding", sense_only: 1, display_name: "Meal Planner" },
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

interface Stub {
  ingest: AssetColumnWriter;
  writes: WriteAssetColumnInput[];
}

/** The INGEST Service Binding, stubbed at its two RPCs. Either `reply` may be an
 * Error, standing in for a store failure. */
function stubIngest(
  read: AssetStateRead | Error,
  write: AssetStateWriteResult | Error = {
    ok: true,
    asset: "meals.example",
    column: "status",
    value: "live",
    updatedAt: "2026-09-04T12:00:00.000Z",
  },
): Stub {
  const writes: WriteAssetColumnInput[] = [];
  return {
    writes,
    ingest: {
      async readAssetState() {
        if (read instanceof Error) throw read;
        return read;
      },
      async writeAssetColumn(input) {
        writes.push(input);
        if (write instanceof Error) throw write;
        return write;
      },
    },
  };
}

/** A same-origin browser write, as the Tower's own fetch produces it. */
function patch(body: unknown, init: RequestInit = {}): Request {
  return new Request(REQUEST_URL, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function handle(request: Request, ingest: AssetColumnWriter, asset = "meals.example") {
  return handleAssetColumnRequest(request, REQUEST_URL, ingest, asset);
}

describe("PATCH /api/assets/:id", () => {
  it("hands the column to the worker that owns the row, and reports what it now holds", async () => {
    const { ingest, writes } = stubIngest(state());
    const res = await handle(
      patch({ column: "status", value: "live", expect: "onboarding" }),
      ingest,
    );

    expect(res.status).toBe(200);
    expect(writes).toEqual([{ asset: "meals.example", column: "status", value: "live", expect: "onboarding" }]);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      asset: "meals.example",
      column: "status",
      value: "live",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
  });

  it("writes the automation mode as the 0/1 the row holds", async () => {
    const { ingest, writes } = stubIngest(state(), {
      ok: true,
      asset: "meals.example",
      column: "sense_only",
      value: 0,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const res = await handle(patch({ column: "sense_only", value: 0, expect: 1 }), ingest);

    expect(res.status).toBe(200);
    expect(writes).toEqual([{ asset: "meals.example", column: "sense_only", value: 0, expect: 1 }]);
  });

  // The guard is what makes a Save safe to press on a page that has been open a
  // while: two browsers, or a `config:apply` in a terminal, and the second save
  // hears what is actually there instead of silently winning.
  it("refuses a save whose expect no longer matches the row, and names what is there", async () => {
    const { ingest, writes } = stubIngest(state({ columns: { status: "live", sense_only: 1, display_name: "Meal Planner" } }));
    const res = await handle(
      patch({ column: "status", value: "retired", expect: "onboarding" }),
      ingest,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "expect_mismatch",
      column: "status",
      current: "live",
    });
    expect(writes).toEqual([]);
  });

  it("reports a competing save detected by the writer after the early read", async () => {
    const { ingest, writes } = stubIngest(state(), {
      ok: false, error: "expect_mismatch", column: "status", current: "retired",
    });
    const res = await handle(patch({ column: "status", value: "live", expect: "onboarding" }), ingest);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "expect_mismatch", column: "status", current: "retired" });
    expect(writes).toEqual([{ asset: "meals.example", column: "status", value: "live", expect: "onboarding" }]);
  });

  it("treats an asset the store does not have as a 404, before writing anything", async () => {
    const { ingest, writes } = stubIngest(state({ known: false, columns: null }));
    const res = await handle(
      patch({ column: "status", value: "live", expect: "onboarding" }),
      ingest,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "asset_not_found", id: "meals.example" });
    expect(writes).toEqual([]);
  });

  it("refuses a column the store does not sanction, without asking ingest", async () => {
    const { ingest, writes } = stubIngest(state());
    for (const column of ["domain", "is_os", "id", "created_at", "updated_at"]) {
      const res = await handle(patch({ column, value: "x", expect: "y" }), ingest);
      expect(res.status, column).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: "invalid_asset_column",
        field: "column",
      });
    }
    expect(writes).toEqual([]);
  });

  // The third sanctioned column, joined 2026-09-04 (bead ro-z349.1) so an asset
  // created from the wizard can be renamed once the typo is spotted. The guard
  // is the same: the name the page rendered has to still be the name in the row.
  it("renames an asset through the same guarded lane", async () => {
    const { ingest, writes } = stubIngest(state(), {
      ok: true,
      asset: "meals.example",
      column: "display_name",
      value: "My Plate",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    const res = await handle(
      patch({ column: "display_name", value: "My Plate", expect: "Meal Planner" }),
      ingest,
    );

    expect(res.status).toBe(200);
    expect(writes).toEqual([
      { asset: "meals.example", column: "display_name", value: "My Plate", expect: "Meal Planner" },
    ]);
  });

  it("refuses a rename whose expect no longer matches the row", async () => {
    const { ingest, writes } = stubIngest(
      state({ columns: { status: "onboarding", sense_only: 1, display_name: "Renamed" } }),
    );
    const res = await handle(
      patch({ column: "display_name", value: "My Plate", expect: "Meal Planner" }),
      ingest,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "expect_mismatch",
      column: "display_name",
      current: "Renamed",
    });
    expect(writes).toEqual([]);
  });

  it("requires the expect guard to be present at all", async () => {
    const { ingest, writes } = stubIngest(state());
    const res = await handle(patch({ column: "status", value: "live" }), ingest);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ field: "expect" });
    expect(writes).toEqual([]);
  });

  it("still renders ingest's own refusal when the value is one this route let through", async () => {
    const { ingest } = stubIngest(state(), {
      ok: false,
      error: "validation",
      issues: [{ path: "value", code: "invalid_value", message: "Automation must be at most 1" }],
    });
    const res = await handle(patch({ column: "sense_only", value: 2, expect: 1 }), ingest);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_asset_column",
      field: "value",
      detail: "Automation must be at most 1",
    });
  });

  it("refuses a write that did not come from this origin", async () => {
    const { ingest, writes } = stubIngest(state());
    const res = await handle(
      new Request(REQUEST_URL, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "https://evil.test" },
        body: JSON.stringify({ column: "status", value: "live", expect: "onboarding" }),
      }),
      ingest,
    );

    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("takes PATCH and JSON, and nothing else", async () => {
    const { ingest } = stubIngest(state());
    const wrongMethod = await handle(
      new Request(REQUEST_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      ingest,
    );
    expect(wrongMethod.status).toBe(405);

    const wrongType = await handle(
      new Request(REQUEST_URL, {
        method: "PATCH",
        headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
        body: "column=status",
      }),
      ingest,
    );
    expect(wrongType.status).toBe(415);
  });

  it("keeps the service boundary opaque when the store itself fails", async () => {
    const { ingest } = stubIngest(state(), new Error("D1_ERROR: disk I/O"));
    const res = await handle(
      patch({ column: "status", value: "live", expect: "onboarding" }),
      ingest,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "asset_column_write_failed" });
  });
});
