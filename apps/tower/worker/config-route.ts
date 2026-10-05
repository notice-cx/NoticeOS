// GET/PUT /api/config — where a setting comes from, and where a Save lands.
//
// Each configuration document lives in the store (D22). A deployed Save goes
// over the private INGEST Service Binding to the Worker that owns those
// documents; the local lane applies the same guarded store write.
//
// THE CONTRACT DID NOT MOVE. `PUT /api/config` still takes `{ops, slug}` and
// still answers `{applied, archive, commit}` on success and `{error, …}` on a
// refusal, so `apps/tower/src/lib/api.ts` and `useConfigSave` are untouched.
// `archive` and `commit` are null here: a store write has no changeset file and
// makes no commit, and the client already renders a missing commit honestly.
// Local saves also return null for both; a file export is a separate result.
//
// WHAT IS STILL REFUSED, and why each one is its own sentence:
//   - the settings RPC is unavailable → editing is disabled; reads use the
//     settings compiled into the Worker until the connection returns.
//   - a stale `expect`, or a stale document version → 409 with what is actually
//     there, so the operator reloads rather than retries.
//   - a `store-asset-set` op → an asset's stage, automation mode or name is a
//     store COLUMN with its own route (asset-column-route.ts).

import type { ConfigDocumentReader, TowerConfig } from "./config-source";
import { JSON_HEADERS, jsonError } from "./http";

/** Said in one place, so the disabled field, the refusal body and the docs
 * cannot drift into three different explanations of the same fact. */
export const CONFIG_STORE_NOT_READY_REASON =
  "Settings are unavailable. Retry when the connection returns.";

/** The refusal a deployed view gives a task-project write: the projects live on
 * the machine running the local service, and are read-only everywhere else. */
export const TASK_PROJECTS_READ_ONLY = "Task projects are read-only here — edit them on the local machine.";

/** Who a Save says wrote it. The Tower is single-operator and unauthenticated on
 * the LAN (docs/10), so there is exactly one honest name for the actor — and an
 * audit row that invented a more specific one would be fiction. */
export const CONFIG_ACTOR = "operator";

/** One refusal, one status. Shared with the ingest's own door so a browser and a
 * script hear the same code for the same fact. */
export function configWriteStatus(error: string | undefined): number {
  switch (error) {
    case "store_unavailable":
    case "not_seeded":
      return 503;
    case "expect_mismatch":
    case "version_mismatch":
      return 409;
    default:
      return 422;
  }
}

export interface ConfigRouteDeps {
  ingest: ConfigDocumentReader | null | undefined;
  /** The resolver the rest of the Worker is already using this request, so the
   * GET answers the same sources the payloads were built from. */
  config: () => Promise<TowerConfig>;
}

export async function handleConfigRequest(
  request: Request,
  deps: ConfigRouteDeps,
): Promise<Response> {
  if (request.method === "GET") {
    const resolved = await deps.config();
    return Response.json(
      {
        // Only a successful settings read enables editing.
        writable: resolved.storeAvailable,
        reason: resolved.storeAvailable ? null : CONFIG_STORE_NOT_READY_REASON,
        // Per file, where the value the page is rendering came from. The
        // Settings page shows it: "which OS am I looking at" is otherwise
        // invisible until a Save behaves unexpectedly.
        sources: resolved.sources,
        versions: resolved.versions,
        store: { ready: resolved.storeAvailable, reason: resolved.storeFailure },
      },
      { headers: JSON_HEADERS },
    );
  }

  if (request.method !== "PUT") return jsonError("method_not_allowed", 405);

  if (!deps.ingest || typeof deps.ingest.applyConfigOps !== "function") {
    return jsonError("store_unavailable", 503, { detail: CONFIG_STORE_NOT_READY_REASON });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError("invalid_changeset", 422, { detail: "body must be a JSON object" });
  }
  const { ops, slug, reason, expectVersions } = parsed as {
    ops?: unknown;
    slug?: unknown;
    reason?: unknown;
    expectVersions?: unknown;
  };
  if (!Array.isArray(ops)) {
    return jsonError("invalid_changeset", 422, { detail: "ops must be an array" });
  }
  if (slug !== undefined && typeof slug !== "string") {
    return jsonError("invalid_changeset", 422, { detail: "slug must be a string" });
  }

  // Task project links belong to the local host. A deployed view exposes only
  // their logical identity, so its shortened rows cannot authorize full-row
  // delete/Undo operations or echo host metadata through conflict responses.
  //
  // The page never offers this write here — its Task projects section wears a
  // "Read-only here" chip in a deployed view — so the refusal states the same
  // fact in the same words, and no longer adds that other settings still save
  // (their Save buttons say so; bead `ro-ujb9.96.6.3`).
  if (ops.some((op: unknown) => op !== null && typeof op === "object"
    && (op as { file?: unknown }).file === "config/beads.json")) {
    return jsonError("local_task_setup_required", 422, {
      detail: TASK_PROJECTS_READ_ONLY,
    });
  }

  let result: Awaited<ReturnType<ConfigDocumentReader["applyConfigOps"]>>;
  try {
    result = await deps.ingest.applyConfigOps({
      ops,
      actor: CONFIG_ACTOR,
      ...(typeof slug === "string" ? { slug } : {}),
      reason: typeof reason === "string" ? reason : null,
      expectVersions:
        expectVersions !== null && typeof expectVersions === "object" && !Array.isArray(expectVersions)
          ? (expectVersions as Record<string, number | null>)
          : null,
    });
  } catch {
    return jsonError("store_unavailable", 503, { detail: CONFIG_STORE_NOT_READY_REASON });
  }

  if (result.ok) {
    return Response.json(
      {
        applied: result.applied ?? ops.length,
        // A store write has no archived changeset and makes no commit. Saying
        // so is the honest answer; the client already handles both being absent.
        archive: null,
        commit: null,
        documents: (result.documents ?? []).map((doc) => ({
          file: doc.file,
          version: doc.version,
        })),
      },
      { headers: JSON_HEADERS },
    );
  }

  const { ok: _ok, ...body } = result;
  return new Response(JSON.stringify(body), {
    status: configWriteStatus(result.error),
    headers: JSON_HEADERS,
  });
}
