// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_STATUSES,
  clearDecision,
  isDecisionStatus,
  loadDecisions,
  recordDecision,
} from "../worker/decision-actions";
import { handleDecisionsRequest } from "../worker/decision-route";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

const T1 = "2026-07-30T09:00:00.000Z";
const T2 = "2026-07-30T11:30:00.000Z";
const URL_ORIGIN = new URL("https://tower.local/api/assets/meals.example/decisions");

let testDb: TestStore;

beforeEach(async () => {
  testDb = await createTestStore();
  // A test that writes a disposition has a copy of its own (test/sites.ts).
  await addSites(testDb, [{ id: "meals.example", domain: null, displayName: "Meal Planner", status: "live", senseOnly: 0, createdAt: T1 }]);
});

/** This test's store, as a Worker call gets one. */
const store = () => testDb.call;

/** How many dispositions the store holds. */
async function stored(): Promise<number> {
  const [row] = await (await store()).read((tx) =>
    tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM noticeos.item_dispositions`),
  );
  return row?.n ?? 0;
}

/** A same-origin browser write, as the Tower's own fetch produces it. */
function post(body: unknown, init: RequestInit = {}): Request {
  return new Request(URL_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
    ...init,
  });
}

async function handle(request: Request, asset = "meals.example", now = T1) {
  return handleDecisionsRequest(request, URL_ORIGIN, await store(), asset, now);
}

describe("decision records", () => {
  it("records one decision and repeats it idempotently", async () => {
    const first = await recordDecision(
      await store(),
      "meals.example",
      { kind: "finding", key: "gsc-decline-1", status: "marked" },
      T1,
    );
    expect(first).toEqual({
      kind: "finding",
      key: "gsc-decline-1",
      status: "marked",
      decidedAt: T1,
      updatedAt: T1,
    });

    // The same decision at a later clock is not a new event.
    expect(
      await recordDecision(
        await store(),
        "meals.example",
        { kind: "finding", key: "gsc-decline-1", status: "marked" },
        T2,
      ),
    ).toMatchObject({ decidedAt: T1, updatedAt: T1 });

    expect(await stored()).toBe(1);
  });

  it("keeps the first decision time when the status changes", async () => {
    await recordDecision(
      await store(),
      "meals.example",
      { kind: "finding", key: "gsc-decline-1", status: "marked" },
      T1,
    );
    expect(
      await recordDecision(
        await store(),
        "meals.example",
        { kind: "finding", key: "gsc-decline-1", status: "dismissed" },
        T2,
      ),
    ).toEqual({
      kind: "finding",
      key: "gsc-decline-1",
      status: "dismissed",
      decidedAt: T1,
      updatedAt: T2,
    });
  });

  it("moves the change time when only the note changes, and not when a note repeats", async () => {
    await recordDecision(await store(), "meals.example", { kind: "query", key: "q", status: "marked", note: "later" }, T1);
    expect(
      await recordDecision(await store(), "meals.example", { kind: "query", key: "q", status: "marked", note: "later" }, T2),
    ).toMatchObject({ updatedAt: T1 });
    expect(
      await recordDecision(await store(), "meals.example", { kind: "query", key: "q", status: "marked", note: null }, T2),
    ).toMatchObject({ decidedAt: T1, updatedAt: T2,
    });
  });

  it("separates the two kinds under one key", async () => {
    await recordDecision(
      await store(),
      "meals.example",
      { kind: "query", key: "shared", status: "marked" },
      T1,
    );
    await recordDecision(
      await store(),
      "meals.example",
      { kind: "finding", key: "shared", status: "marked" },
      T1,
    );
    expect(await loadDecisions(await store(), "meals.example")).toHaveLength(2);
  });

  it("clears a decision, and clearing an untouched item is not an error", async () => {
    await recordDecision(
      await store(),
      "meals.example",
      { kind: "finding", key: "gsc-decline-1", status: "dismissed" },
      T1,
    );
    expect(
      await clearDecision(await store(), "meals.example", "finding", "gsc-decline-1"),
    ).toEqual({ removed: true });
    expect(
      await clearDecision(await store(), "meals.example", "finding", "gsc-decline-1"),
    ).toEqual({ removed: false });
    expect(await loadDecisions(await store(), "meals.example")).toEqual([]);
  });

  // Whether a row was handed off is answered by the task somebody filed, never
  // by the operator's self-report.
  describe("the handed_off self-report", () => {
    it("is not a status the store will accept from the Tower", () => {
      // The route's own validator, which turns this into a 422 rather than a
      // 500 from the store's CHECK.
      expect(isDecisionStatus("handed_off")).toBe(false);
      expect(DECISION_STATUSES).toEqual(["marked", "dismissed"]);
    });

    it("is not a value the table will hold at all", async () => {
      // The CHECK closes the door, so even a hand-written INSERT cannot recreate one.
      await expect(
        (await store()).write((tx) =>
          tx.execute(
            `INSERT INTO noticeos.item_dispositions (workspace_id, asset_id, kind, item_key, status, decided_at, updated_at)
             VALUES ($1, 'meals.example', 'query', 'weekly meal plan', 'handed_off', $2::timestamptz, $2::timestamptz)`,
            [tx.workspaceId, T1],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
      expect(await stored()).toBe(0);
    });

    it("still cannot reach the display even if a row somehow carried it", async () => {
      // The read filter stays: it binds DECISION_STATUSES, so the payload's
      // vocabulary is the module's and not whatever the column holds.
      await recordDecision(
        await store(),
        "meals.example",
        { kind: "finding", key: "gsc-decline-1", status: "dismissed" },
        T1,
      );
      expect(await loadDecisions(await store(), "meals.example")).toEqual([
        {
          kind: "finding",
          key: "gsc-decline-1",
          status: "dismissed",
          decidedAt: T1,
          updatedAt: T1,
        },
      ]);
    });
  });
});

describe("POST/DELETE /api/assets/:id/decisions", () => {
  it("refuses to write the retired handed_off self-report", async () => {
    const res = await handle(
      post({ kind: "query", key: "weekly meal plan", status: "handed_off" }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid_decision",
      field: "status",
    });
    expect(await stored()).toBe(0);
  });

  it("records a decision and returns the stored row", async () => {
    const res = await handle(
      post({ kind: "finding", key: "gsc-decline-1", status: "marked" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      asset: "meals.example",
      kind: "finding",
      key: "gsc-decline-1",
      status: "marked",
      decidedAt: T1,
      updatedAt: T1,
    });
  });

  it("restores a finding through DELETE", async () => {
    await handle(post({ kind: "finding", key: "gsc-decline-1", status: "dismissed" }));
    const res = await handle(
      post({ kind: "finding", key: "gsc-decline-1" }, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: true });
    expect(await loadDecisions(await store(), "meals.example")).toEqual([]);
  });

  it("refuses a cross-origin write", async () => {
    const res = await handle(
      new Request(URL_ORIGIN, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://elsewhere.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ kind: "finding", key: "q", status: "marked" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("refuses a body that is not declared JSON", async () => {
    const res = await handle(
      new Request(URL_ORIGIN, { method: "POST", body: "kind=query" }),
    );
    expect(res.status).toBe(415);
  });

  it("refuses a malformed body", async () => {
    const res = await handle(
      new Request(URL_ORIGIN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("names the field that failed validation", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "note", key: "q", status: "marked" }, "kind"],
      [{ kind: "finding", key: "   ", status: "marked" }, "key"],
      [{ kind: "finding", key: "x".repeat(513), status: "marked" }, "key"],
      [{ kind: "finding", key: "q", status: "open" }, "status"],
      [{ kind: "finding", key: "q", status: "marked", note: 7 }, "note"],
    ];
    for (const [body, field] of cases) {
      const res = await handle(post(body));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid_decision", field });
    }
    expect(await loadDecisions(await store(), "meals.example")).toEqual([]);
  });

  it("rejects an unknown asset instead of failing the foreign key", async () => {
    const res = await handle(
      post({ kind: "finding", key: "q", status: "marked" }),
      "not-a-property",
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "asset_not_found",
      id: "not-a-property",
    });
  });

  it("refuses a method that is neither POST nor DELETE", async () => {
    const res = await handle(new Request(URL_ORIGIN, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
