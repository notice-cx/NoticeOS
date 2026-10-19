// A signed-in person's own view of the Tower, kept per person in a hosted
// workspace so it follows them to every sign-in and device:
//
//   GET /api/me/preferences/view  → { choice: ViewChoice | null }, the newest
//                                   saved choice of this person in this workspace
//   PUT /api/me/preferences/view  ← a ViewChoice ({ view, focus }); saves one row
//                                   and answers { choice } as stored
//
// The person is the admitted session's (`preferences.self`), never a path
// segment or body field. Rows in noticeos.person_preferences are append-only
// and the newest wins, so there is no DELETE: a reset is a PUT of the default
// choice, `{ "view": "everything", "focus": [] }` or the workspace's default.
// The CHECKs on `name` and on the value's object shape and size are the whole
// storage contract; `parseViewChoice` is the whole body contract.
//
// Standalone has no person and keeps the choice in the browser: this path is
// not routed there (404), and the demo answers 404 too.

import type { CallContext, WorkspaceStore } from "@noticeos/postgres";
import { parseViewChoice, serializeViewChoice, type ViewChoice } from "@noticeos/contract/views";
import { PERSON_VIEW_PREFERENCE_PATH, personPreferenceRequest } from "../../../scripts/workspace-operations.mjs";
import { withWorkspaceEntry, type WorkspaceProfile } from "../../../scripts/workspace-entry.mjs";
import type { WorkspaceContext } from "../../../scripts/workspace-admission.mjs";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

export { PERSON_VIEW_PREFERENCE_PATH };

/** Matches the column's CHECK: a stored value is at most 2 KiB. */
const MAX_BODY_BYTES = 2048;

type PreferenceStore = Pick<WorkspaceStore, "read" | "write">;
type Person = Pick<WorkspaceContext, "principalKind" | "principalId" | "sessionId">;

/** A stored value read back: jsonb arrives parsed, or as text from a driver that does not parse it. */
function storedChoice(value: unknown): ViewChoice | null {
  if (typeof value === "string") {
    try { return parseViewChoice(JSON.parse(value)); } catch { return null; }
  }
  return parseViewChoice(value);
}

async function readBody(request: Request): Promise<{ choice: ViewChoice } | { reason: string }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return { reason: "The choice is longer than 2 KiB." };
  let text: string;
  try { text = await request.text(); } catch { return { reason: "The body could not be read." }; }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { reason: "The choice is longer than 2 KiB." };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { reason: "The body is not JSON." }; }
  const choice = parseViewChoice(body);
  return choice ? { choice } : { reason: "The body is not a view choice: { view, focus }." };
}

/** The route itself, after admission: `person` is the admitted context and
 * `store` the workspace's store opened for this same call. */
export async function handlePersonViewPreference(request: Request, person: Person,
  store: PreferenceStore): Promise<Response> {
  if (person.principalKind !== "person" || !person.sessionId) return jsonError("person_required", 403);
  if (request.method === "GET") {
    const rows = await store.read((tx) => tx.query<{ value: unknown }>(
      `SELECT value FROM noticeos.person_preferences
        WHERE workspace_id = $1 AND person_id = $2 AND name = 'view'
        ORDER BY preference_id DESC LIMIT 1`,
      [tx.workspaceId, person.principalId],
    ));
    return Response.json({ choice: rows[0] ? storedChoice(rows[0].value) : null }, { headers: JSON_HEADERS });
  }
  if (request.method !== "PUT") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, new URL(request.url))) return jsonError("forbidden", 403);
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);
  const body = await readBody(request);
  if ("reason" in body) return jsonError("invalid_view_choice", 400, { reason: body.reason });
  await store.write((tx) => tx.execute(
    `INSERT INTO noticeos.person_preferences (workspace_id, person_id, name, value)
     VALUES ($1, $2, 'view', $3::jsonb)`,
    [tx.workspaceId, person.principalId, serializeViewChoice(body.choice)],
  ));
  return Response.json({ choice: body.choice }, { headers: JSON_HEADERS });
}

/** The Worker's entry for the path: null for any other path. Hosted only;
 * every call is admitted afresh as `preferences.self`. */
export async function handleHostedPersonPreference(request: Request, env: object, ctx: CallContext,
  profile: WorkspaceProfile, entry: typeof withWorkspaceEntry = withWorkspaceEntry): Promise<Response | null> {
  if (new URL(request.url).pathname !== PERSON_VIEW_PREFERENCE_PATH) return null;
  if (profile !== "hosted") return jsonError("not_found", 404);
  if (!personPreferenceRequest(request)) {
    return ["GET", "PUT"].includes(request.method) ? jsonError("not_found", 404) : jsonError("method_not_allowed", 405);
  }
  try {
    const proof = request.clone(), message = proof.clone();
    return await entry(env, proof, async (call) => {
      if (call.context.principalKind !== "person" || !call.context.sessionId) return jsonError("person_required", 403);
      try { return await call.withStore(ctx, (store) => handlePersonViewPreference(message, call.context, store)); }
      // A failed hosted read or write exposes no query or connection detail.
      catch { return jsonError("preference_unavailable", 503); }
    });
  } catch {
    return jsonError("workspace_entry_unavailable", 403);
  }
}
