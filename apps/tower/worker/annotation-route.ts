// POST /api/assets/:id/annotations — the operator's own timeline events.
// Ingest writes the row through `createAnnotation()` over the INGEST binding, so
// the Tower never holds the operator bearer; hosted receivers still admit the
// original request. Browser-facing only: the rules live in
// workers/ingest/src/annotations.ts.

import type {
  CreateAnnotationInput,
  CreateAnnotationResult,
} from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";
import type { AnnotationItem } from "../shared/annotations";

/** Declared here rather than imported from the binding so this file stays free
 * of Workers globals (the test project typechecks it). */
export interface AnnotationWriter {
  createAnnotation(
    input: CreateAnnotationInput,
    originalProof?: Request,
  ): Promise<CreateAnnotationResult>;
}

/**
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
