// POST/DELETE /api/assets/:id/decisions — the operator's own judgement on an
// item. DELETE restores rather than a `restore` pseudo-status, so `status`
// maps 1:1 onto the column's CHECK.

import {
  DECISION_KEY_MAX,
  DECISION_NOTE_MAX,
  clearDecision,
  isDecisionKind,
  isDecisionStatus,
  recordDecision,
} from "./decision-actions";
import type { MutationActor } from "@noticeos/postgres/mutation-audit";
import type { WorkspaceStore } from "@noticeos/postgres";
import { readSite } from "./asset-registry";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";
import type { DecisionKind, DecisionStatus } from "../shared/asset-detail";

interface ValidBody {
  kind: DecisionKind;
  key: string;
  status: DecisionStatus | null;
  note: string | null;
}

/**
 * 403 forbidden · 415 unsupported_media_type · 400 bad_request ·
 * 422 invalid_decision · 404 asset_not_found · 500 decision_write_failed.
 */
export async function handleDecisionsRequest(
  request: Request,
  url: URL,
  store: WorkspaceStore,
  asset: string,
  nowIso: string,
  actor: MutationActor | null = null,
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
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

  const parsed = parseBody(body, request.method === "POST");
  if (typeof parsed === "string") {
    return jsonError("invalid_decision", 422, { field: parsed });
  }

  // An unknown asset is a 404 rather than a foreign-key 500: the operator
  // asked about something that does not exist, which is not a server fault.
  if ((await readSite(store, asset)) === null) {
    return jsonError("asset_not_found", 404, { id: asset });
  }

  try {
    if (request.method === "DELETE") {
      const { removed } = await clearDecision(store, asset, parsed.kind, parsed.key, actor);
      return Response.json(
        { ok: true, asset, kind: parsed.kind, key: parsed.key, removed },
        { headers: JSON_HEADERS },
      );
    }
    const decision = await recordDecision(
      store,
      asset,
      { kind: parsed.kind, key: parsed.key, status: parsed.status as DecisionStatus, note: parsed.note },
      nowIso,
      actor,
    );
    if (!decision) {
      return jsonError("decision_write_failed", 500);
    }
    return Response.json({ ok: true, asset, ...decision }, { headers: JSON_HEADERS });
  } catch {
    return jsonError("decision_write_failed", 500);
  }
}

/** Returns the validated body, or the name of the field that failed. */
function parseBody(body: unknown, statusRequired: boolean): ValidBody | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  const record = body as Record<string, unknown>;

  if (!isDecisionKind(record.kind)) return "kind";

  const key = typeof record.key === "string" ? record.key.trim() : "";
  if (key.length === 0 || key.length > DECISION_KEY_MAX) return "key";

  if (statusRequired && !isDecisionStatus(record.status)) return "status";

  const note =
    record.note === undefined || record.note === null
      ? null
      : typeof record.note === "string"
        ? record.note
        : undefined;
  if (note === undefined || (note !== null && note.length > DECISION_NOTE_MAX)) {
    return "note";
  }

  return {
    kind: record.kind,
    key,
    status: statusRequired ? (record.status as DecisionStatus) : null,
    note,
  };
}
