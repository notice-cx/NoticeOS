// PATCH /api/flags/:id — the alert-lifecycle lane. A store write, not a config
// write, so a deployed Worker serves it without the read-only gate.

import { checkSnoozeUntil } from "../shared/snooze";
import { checkTunedSetting, type TunedSetting } from "../shared/tune";
import type { MutationActor } from "@noticeos/postgres/mutation-audit";
import type { WorkspaceStore } from "@noticeos/postgres";
import { applyFlagAction, type FlagAction } from "./flag-actions";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

const ACTIONS: ReadonlySet<string> = new Set<FlagAction>([
  "acknowledge",
  "resolve",
  "snooze",
  "unsnooze",
  "tune",
]);

export async function handleFlagRequest(
  request: Request,
  url: URL,
  store: WorkspaceStore,
  /** The alert's workspace number. */
  id: number,
  nowIso: string,
  actor: MutationActor | null = null,
): Promise<Response> {
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown;
    until?: unknown;
    tuned?: unknown;
  };
  if (typeof fields.action !== "string" || !ACTIONS.has(fields.action)) {
    return jsonError("invalid_flag_action", 422);
  }
  const action = fields.action as FlagAction;

  // The horizon is refused HERE and not by a CHECK constraint: the column takes
  // any instant, and a store that accepts a date in 2199 has no way to tell
  // later whether the operator meant it.
  let until: string | null = null;
  if (action === "snooze") {
    const checked = checkSnoozeUntil(fields.until, nowIso);
    if (!checked.ok) return jsonError(checked.reason, 422);
    until = checked.until;
  }

  // A tune arrives as which setting moved and its two values, never as a note:
  // `disposition_note` is the store's own sentence about an operator decision,
  // and a free-text field on this lane would let a caller write anything into
  // the record the false-positive rate is later read from (`shared/tune`).
  let tuned: TunedSetting | null = null;
  if (action === "tune") {
    const checked = checkTunedSetting(fields.tuned);
    if (!checked.ok) return jsonError(checked.reason, 422);
    tuned = checked.tuned;
  }

  try {
    const changed = await applyFlagAction(store, id, action, nowIso, until, tuned, actor);
    // 409, never 404: the row usually exists and is simply no longer in the
    // state this action moves out of — someone acted on it in another tab, or
    // the snooze the operator is ending already ran out on its own.
    if (!changed) return jsonError("flag_not_open", 409);
    return Response.json({ ok: true, ...changed }, { headers: JSON_HEADERS });
  } catch {
    return jsonError("flag_action_failed", 500);
  }
}
