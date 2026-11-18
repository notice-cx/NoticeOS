import type { CallContext, WorkspaceStore } from "@noticeos/postgres";
import { readAnalysisAssignment } from "@noticeos/postgres/analysis-assignment";
import { ASSET_ID_MAX, CONFIG_ASSET_KEY_RE } from "../../../packages/contract/src/configuration.mjs";
import { ANALYSIS_WORKFLOWS_PATH, analysisId, analysisWorkflowRequest } from "../../../scripts/analysis-workflow-request.mjs";
import { readBoundedJsonText } from "../../../scripts/bounded-json-body.mjs";
import { withWorkspaceEntry, type WorkspaceProfile } from "../../../scripts/workspace-entry.mjs";
import type { WorkspaceContext } from "../../../scripts/workspace-admission.mjs";
import { ANALYSIS_RUNBOOKS } from "../shared/analysis-runbooks";
import type { AnalysisTrigger, CreateAnalysisWorkflow } from "../shared/analysis-workflows";
import { AnalysisWorkflowRefused, completeAnalysisWorkflowRun, createAnalysisWorkflow, listAnalysisWorkflows,
  readAnalysisWorkflow, readAnalysisWorkflowRun, setAnalysisWorkflowEnabled, startAnalysisWorkflowRun } from "./analysis-workflow-store";
import { JSON_HEADERS, isJsonRequest, jsonError } from "./http";

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { ...JSON_HEADERS, "cache-control": "no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });
type Route = NonNullable<ReturnType<typeof analysisWorkflowRequest>>;

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function data(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function triggerOf(input: unknown): AnalysisTrigger | null {
  const value = data(input);
  if (!value) return null;
  if (value.kind === "manual" && Object.keys(value).length === 1) return { kind: "manual" };
  if (value.kind !== "weekly" || Object.keys(value).length !== 5 || !whole(value.weekday, 0, 6)
    || !whole(value.hour, 0, 23) || !whole(value.minute, 0, 59) || typeof value.timeZone !== "string"
    || value.timeZone.length > 80 || !/^[A-Za-z][A-Za-z0-9/_+-]*$/u.test(value.timeZone)) return null;
  let timeZone: string;
  try { timeZone = new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).resolvedOptions().timeZone; }
  catch { return null; }
  return { kind: "weekly", weekday: value.weekday, hour: value.hour, minute: value.minute, timeZone };
}

function definitionOf(body: Record<string, unknown>): CreateAnalysisWorkflow | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (Object.keys(body).length !== 4 || !name || name.length > 120 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(name)
    || (body.template !== "weekly-search-review" && body.template !== "seo-ai-visibility")) return null;
  const assets = body.assetIds;
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 8 || new Set(assets).size !== assets.length
    || !assets.every(asset => typeof asset === "string" && asset.length <= ASSET_ID_MAX && CONFIG_ASSET_KEY_RE.test(asset))) return null;
  const trigger = triggerOf(body.trigger);
  return trigger && { name, template: body.template, assetIds: assets, trigger };
}

async function operation(request: Request, route: Route, context: WorkspaceContext, store: WorkspaceStore): Promise<Response> {
  if (context.principalKind !== "person" || !context.sessionId) return jsonError("person_required", 403);
  if (route.kind === "list") return json({ workflows: await listAnalysisWorkflows(store), runbooks: ANALYSIS_RUNBOOKS });
  if (route.kind === "workflow") return json(await readAnalysisWorkflow(store, route.workflowId));
  if (route.kind === "run") {
    const run = await readAnalysisWorkflowRun(store, route.workflowId, route.runId);
    const assignment = await readAnalysisAssignment(store, route.workflowId, route.runId);
    return json({ run: { ...run, assignment } });
  }

  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);
  let body: Record<string, unknown> | null;
  try { body = data(JSON.parse(await readBoundedJsonText(request, MAX_BODY_BYTES)) as unknown); }
  catch { return jsonError("invalid_analysis_request", 400); }
  if (!body) return jsonError("invalid_analysis_request", 400);
  const actor = { principalId: context.principalId };
  if (route.kind === "create" || route.kind === "start") {
    const key = request.headers.get("Idempotency-Key");
    if (!key || !/^[A-Za-z0-9._-]{8,128}$/u.test(key)) return jsonError("idempotency_key_required", 400);
    if (route.kind === "create") {
      const definition = definitionOf(body);
      if (!definition) return jsonError("invalid_analysis_workflow", 400);
      return json({ workflow: await createAnalysisWorkflow(store, definition, key, actor) }, 201);
    }
    const retryOf = body.retryOf;
    if (Object.keys(body).some(field => field !== "retryOf") || (retryOf !== undefined && !analysisId(retryOf)))
      return jsonError("invalid_analysis_run", 400);
    const run = await startAnalysisWorkflowRun(store, route.workflowId, { source: "manual", key, retryOf }, actor);
    return json({ run }, 201);
  }
  if (route.kind === "pause") {
    if (Object.keys(body).length !== 2 || typeof body.enabled !== "boolean" || !whole(body.expectedVersion, 1, 2_147_483_646))
      return jsonError("invalid_analysis_pause", 400);
    return json({ workflow: await setAnalysisWorkflowEnabled(store, route.workflowId, body.enabled, body.expectedVersion) });
  }
  if (route.kind === "complete")
    return json({ run: await completeAnalysisWorkflowRun(store, route.workflowId, route.runId, body, actor) });
  return jsonError("not_found", 404);
}

export async function handleHostedAnalysisWorkflow(request: Request, env: { NOTICEOS_CUSTOMER_SHADOW?: boolean }, ctx: CallContext,
  profile: WorkspaceProfile): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== ANALYSIS_WORKFLOWS_PATH && !path.startsWith(ANALYSIS_WORKFLOWS_PATH + "/")) return null;
  const route = analysisWorkflowRequest(request);
  // The assignment API has its separately scoped receiver.
  if (!route && /\/assignments?(?:\/|$)/u.test(path)) return null;
  if (profile !== "hosted" || env.NOTICEOS_CUSTOMER_SHADOW === true || !route) return jsonError("not_found", 404);
  try {
    return await withWorkspaceEntry(env, request, call => call.withStore(ctx, async store => {
      try { return await operation(request, route, call.context, store); }
      catch (error) {
        if (error instanceof AnalysisWorkflowRefused) return jsonError(error.code, error.status);
        return jsonError("analysis_workflow_unavailable", 503);
      }
    }));
  } catch { return jsonError("workspace_entry_unavailable", 403); }
}
