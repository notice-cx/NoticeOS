// POST /api/assets/:id/watch-windows — open a pre-registered outcome check
// from the asset page (bead `ro-71r`).
//
// Same shape as annotation-route.ts, and for the same reason: the ingest Worker
// owns `watch_windows` and the operator bearer guarding its HTTP lane, and the
// Tower is served unauthenticated on the trusted LAN — so the row is written by
// ingest through `createWatchWindow()` on its WorkerEntrypoint, over the private
// INGEST Service Binding. The binding IS the authorization; no credential
// crosses the boundary, and there is one writer.
//
// What is left here is browser-facing only: the same-origin guard, the JSON
// envelope, and the mapping from ingest's result to this route's error
// vocabulary. Every pre-registration rule — the metric vocabulary, a baseline
// that must end before the change, a final check no shorter than the baseline —
// lives in workers/ingest/src/routes/watch-windows.ts and is unchanged by there
// being a UI in front of it. The composer prefills; it does not relax.

import type {
  CreateWatchWindowInput,
  CreateWatchWindowResult,
} from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/**
 * The one ingest RPC this route calls. `env.INGEST` satisfies it structurally;
 * declaring the surface here rather than importing the binding's type keeps this
 * file free of Workers globals and lets a test bind a double. Same trick as
 * `AnnotationWriter`.
 */
export interface WatchWindowWriter {
  createWatchWindow(
    input: CreateWatchWindowInput,
  ): Promise<CreateWatchWindowResult>;
}

/**
 * Handle one registration. `asset` has already been extracted from the path and
 * is the only field this route supplies itself — a page can register a watch on
 * the asset it is showing and on nothing else.
 *
 * Error vocabulary matches the flag, decision and annotation routes:
 * 403 forbidden · 415 unsupported_media_type · 400 bad_request ·
 * 422 invalid_watch_window · 404 asset_not_found · 500 watch_window_write_failed.
 */
export async function handleWatchWindowRequest(
  request: Request,
  url: URL,
  ingest: WatchWindowWriter,
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
    return jsonError("invalid_watch_window", 422, { field: "body" });
  }
  const record = body as Record<string, unknown>;

  let result: CreateWatchWindowResult;
  try {
    // A claim, not a check: ingest is the validator. Nothing is defaulted here
    // either — a composer that quietly filled in a baseline the operator never
    // saw would be pre-registering on their behalf.
    result = await ingest.createWatchWindow({
      asset,
      ref_kind: record.ref_kind,
      ref: record.ref,
      metric_integration: record.metric_integration,
      metric: record.metric,
      baseline_start: record.baseline_start,
      baseline_end: record.baseline_end,
      check_offsets: record.check_offsets,
      thresholds: record.thresholds,
      // The query or page a check opened from a Search row is watched inside
      // (`watchDraftBody`). Dropping it would register the check site-wide —
      // a different comparison than the one the composer drew — and refuse
      // every average outright (bead `ro-ujb9.96.6.28`).
      ...(record.scope !== undefined ? { scope: record.scope } : {}),
      note: blankToNull(record.note),
    } as CreateWatchWindowInput);
  } catch {
    // Keep the service boundary opaque: the browser gets a code, not ingest's
    // internals, and treats it as "the check was not registered".
    return jsonError("watch_window_write_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "unknown_asset") {
      return jsonError("asset_not_found", 404, { id: asset });
    }
    // The composer highlights one rule at a time, and carries ingest's own
    // sentence: a refusal the operator cannot read is a refusal they will
    // retry identically.
    return jsonError("invalid_watch_window", 422, {
      field: result.issues[0]?.path ?? "body",
      detail: result.issues[0]?.message ?? null,
    });
  }

  // The client's contract is "it is registered", not the store row: the page
  // refetches and renders the window from the same payload slice the strip
  // already reads, so there is one shape of a watch on the client.
  return Response.json(
    { ok: true, asset, id: result.watchWindow.id },
    { status: 201, headers: JSON_HEADERS },
  );
}

/** An empty or whitespace-only string is the operator leaving a field blank,
 * which the store holds as NULL — not a value for ingest to reject. */
function blankToNull(value: unknown): unknown {
  if (typeof value === "string" && value.trim().length === 0) return null;
  return value;
}
