// POST /api/assets/:id/annotations — the operator's own timeline events.
//
// COLLAPSED 2026-07-31. This file used to write the row itself, through the
// Tower's own store, because the canonical writer — the ingest worker's
// `POST /api/annotations` — is behind `env.OPERATOR_TOKEN`, and the Tower is
// served unauthenticated on the trusted LAN: holding the operator bearer here
// would put every operator-authed ingest lane one LAN request away. The row is
// now written by ingest, which owns the table, through `createAnnotation()` on
// its WorkerEntrypoint — the private INGEST Service Binding, the same capability
// the GA4 realtime read crosses. Hosted receivers independently admit the
// original request; the binding alone is not customer authority.
//
// What is left here is browser-facing only: the same-origin guard, the JSON
// envelope, and the mapping from ingest's result to this route's error
// vocabulary. The kind vocabulary, backdating rule, `(asset, at, kind, ref)`
// identity and field caps live in workers/ingest/src/annotations.ts.

import type {
  CreateAnnotationInput,
  CreateAnnotationResult,
} from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";
import type { AnnotationItem } from "../shared/annotations";

/**
 * The one ingest RPC this route calls. `env.INGEST` satisfies it structurally;
 * declaring the surface here rather than importing the binding's type keeps
 * this file free of Workers globals (the test project typechecks it too) and
 * lets a test bind a double without importing Workers globals.
 */
export interface AnnotationWriter {
  createAnnotation(
    input: CreateAnnotationInput,
    originalProof?: Request,
  ): Promise<CreateAnnotationResult>;
}

/**
 * Handle one annotation write. `asset` has already been extracted from the path.
 * Error vocabulary matches the flag and decision routes:
 * 403 forbidden · 415 unsupported_media_type · 400 bad_request ·
 * 422 invalid_annotation · 404 asset_not_found · 500 annotation_write_failed.
 */
export async function handleAnnotationRequest(
  request: Request,
  url: URL,
  ingest: AnnotationWriter,
  asset: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  if (!isJsonRequest(request)) {
    return jsonError("unsupported_media_type", 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("invalid_annotation", 422, { field: "body" });
  }
  const record = body as Record<string, unknown>;

  let result: CreateAnnotationResult;
  try {
    // A claim, not a check: ingest is the validator. The only shaping done here
    // is blank-to-absent, because a form field the operator left empty means
    // "not given" to a browser and nothing at all to the store.
    result = await ingest.createAnnotation({
      asset,
      kind: record.kind,
      at: record.at,
      ref: blankToNull(record.ref),
      note: blankToNull(record.note),
    } as CreateAnnotationInput);
  } catch {
    // Keep the service boundary opaque: the browser gets a code, not ingest's
    // internals, and treats it as "the event was not recorded".
    return jsonError("annotation_write_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "unknown_asset") {
      return jsonError("asset_not_found", 404, { id: asset });
    }
    // The composer highlights one field at a time; ingest reports every bad
    // field, in the order it validates them.
    return jsonError("invalid_annotation", 422, {
      field: result.issues[0]?.path ?? "body",
    });
  }

  // The client's contract is the timeline item, not the store row: `asset` is
  // already in the envelope and `created_at` is bookkeeping.
  const annotation: AnnotationItem = {
    id: result.annotation.id,
    at: result.annotation.at,
    kind: result.annotation.kind,
    ref: result.annotation.ref,
    note: result.annotation.note,
  };
  return Response.json(
    { ok: true, asset, created: result.created, annotation },
    { status: result.created ? 201 : 200, headers: JSON_HEADERS },
  );
}

/** An empty or whitespace-only string is the operator leaving a field blank,
 * which the store holds as NULL — not a value for ingest to reject. */
function blankToNull(value: unknown): unknown {
  if (typeof value === "string" && value.trim().length === 0) return null;
  return value;
}
