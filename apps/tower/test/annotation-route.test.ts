// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  AnnotationRow,
  CreateAnnotationInput,
  CreateAnnotationResult,
} from "@noticeos/contract";
import {
  handleAnnotationRequest,
  type AnnotationWriter,
} from "../worker/annotation-route";

// The Tower proxies to `createAnnotation()` on the ingest WorkerEntrypoint
// over the private INGEST Service Binding (see the header of
// worker/annotation-route.ts), so what is asserted is the boundary: what
// crosses it, and how each answer is rendered for the browser. The write
// rules themselves are asserted in workers/ingest/test/annotations.test.ts.
//
// The binding is stubbed rather than bound: this project's Vitest runs in
// node/jsdom with no workerd. The stub is typed by the shared contract.

const REQUEST_URL = new URL(
  "https://tower.local/api/assets/meals.example/annotations",
);

function row(overrides: Partial<AnnotationRow> = {}): AnnotationRow {
  return {
    id: 41,
    asset: "meals.example",
    at: "2026-07-12T18:04:00.000Z",
    kind: "deploy",
    ref: null,
    note: "July SEO batch — 240 recipe titles",
    created_at: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

/** The INGEST Service Binding, stubbed at its one RPC. `reply` is what ingest
 * answers — or throws, standing in for a store failure. */
function stubIngest(reply: CreateAnnotationResult | Error): {
  ingest: AnnotationWriter;
  calls: CreateAnnotationInput[];
} {
  const calls: CreateAnnotationInput[] = [];
  return {
    calls,
    ingest: {
      async createAnnotation(input) {
        calls.push(input);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const written: CreateAnnotationResult = {
  ok: true,
  created: true,
  annotation: row(),
};

/** A same-origin browser write, as the Tower's own fetch produces it. */
function post(body: unknown, init: RequestInit = {}): Request {
  return new Request(REQUEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function handle(
  request: Request,
  ingest: AnnotationWriter,
  asset = "meals.example",
) {
  return handleAnnotationRequest(request, REQUEST_URL, ingest, asset);
}

describe("POST /api/assets/:id/annotations", () => {
  it("hands the event to the worker that owns the table, and renders the row", async () => {
    const { ingest, calls } = stubIngest(written);
    const response = await handle(
      post({
        kind: "deploy",
        at: "2026-07-12T18:04:00.000Z",
        note: "July SEO batch — 240 recipe titles",
      }),
      ingest,
    );

    expect(calls).toEqual([
      {
        asset: "meals.example",
        kind: "deploy",
        at: "2026-07-12T18:04:00.000Z",
        ref: undefined,
        note: "July SEO batch — 240 recipe titles",
      },
    ]);
    expect(response.status).toBe(201);
    // The browser's contract is the timeline item: the store row's `asset` and
    // `created_at` do not leak into it.
    expect(await response.json()).toEqual({
      ok: true,
      asset: "meals.example",
      created: true,
      annotation: {
        id: 41,
        at: "2026-07-12T18:04:00.000Z",
        kind: "deploy",
        ref: null,
        note: "July SEO batch — 240 recipe titles",
      },
    });
  });

  it("leaves the clock to ingest when the operator does not backdate", async () => {
    const { ingest, calls } = stubIngest(written);
    await handle(post({ kind: "config", note: "raised alpha" }), ingest);
    // No Tower-side default: one writer, one clock, one backdating rule.
    expect(calls[0]?.at).toBeUndefined();
  });

  it("sends a field the operator left blank as absent, not as an empty string", async () => {
    const { ingest, calls } = stubIngest(written);
    await handle(post({ kind: "deploy", ref: "   ", note: "" }), ingest);
    expect(calls[0]).toMatchObject({ ref: null, note: null });
  });

  it("answers a re-post with the existing row and a 200", async () => {
    const { ingest } = stubIngest({
      ok: true,
      created: false,
      annotation: row({ note: "origin 502s" }),
    });
    const response = await handle(
      post({ kind: "incident", at: "2026-07-20T08:00:00.000Z", note: "x" }),
      ingest,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: false,
      annotation: { id: 41, note: "origin 502s" },
    });
  });

  it("names the field ingest rejected", async () => {
    const { ingest } = stubIngest({
      ok: false,
      error: "validation",
      issues: [
        { path: "kind", code: "invalid_value", message: "kind must be one of…" },
      ],
    });
    const response = await handle(post({ kind: "refactor" }), ingest);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_annotation",
      field: "kind",
    });
  });

  it("answers an unknown asset with 404, never a foreign-key 500", async () => {
    const { ingest } = stubIngest({
      ok: false,
      error: "unknown_asset",
      asset: "does.not.exist",
    });
    const response = await handle(
      post({ kind: "deploy" }),
      ingest,
      "does.not.exist",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "asset_not_found",
      id: "does.not.exist",
    });
  });

  it("keeps a failed write opaque instead of leaking ingest's internals", async () => {
    const { ingest } = stubIngest(new Error("D1_ERROR: no such table: annotations"));
    const response = await handle(post({ kind: "deploy" }), ingest);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "annotation_write_failed" });
  });

  it("rejects a cross-origin write and a non-JSON body without ever calling ingest", async () => {
    const { ingest, calls } = stubIngest(written);

    const foreign = new Request(REQUEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://elsewhere.example",
      },
      body: JSON.stringify({ kind: "deploy" }),
    });
    expect((await handle(foreign, ingest)).status).toBe(403);

    const notJson = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
      body: "kind=deploy",
    });
    expect((await handle(notJson, ingest)).status).toBe(415);

    const unreadable = new Request(REQUEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{",
    });
    expect((await handle(unreadable, ingest)).status).toBe(400);

    const notAnObject = await handle(post([{ kind: "deploy" }]), ingest);
    expect(notAnObject.status).toBe(422);
    expect(await notAnObject.json()).toEqual({
      error: "invalid_annotation",
      field: "body",
    });

    expect(calls).toEqual([]);
  });

  it("only writes on POST", async () => {
    const { ingest, calls } = stubIngest(written);
    const response = await handle(
      new Request(REQUEST_URL, { method: "DELETE" }),
      ingest,
    );
    expect(response.status).toBe(405);
    expect(calls).toEqual([]);
  });
});
