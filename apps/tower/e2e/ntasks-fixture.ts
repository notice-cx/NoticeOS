import { createHash, randomBytes } from "node:crypto";
import { readTaskChoices } from "@noticeos/contract/task-choices";
import { TASK_METADATA } from "../../../packages/contract/src/task-metadata.mjs";
import { toLiveTask } from "../../../scripts/task-row.mjs";
import { TaskServiceAppRefused, type NtasksProject, type TaskService } from "../../../scripts/task-service.mjs";
import { JOURNEY_NTASKS_ORIGIN } from "./ntasks-origin.mjs";

// A fixture Ntasks for the journeys that sign a person in to it: the routes
// the Tower reaches, answered from the fixture's own task rows. The Tower's
// server reaches it with the installation's service credential (`service`);
// the browser reaches it with the person's token, through the fixture server
// (ntasks-route.mjs). It keeps the rules the Tower depends on, as Ntasks's
// docs/sign-in.md states them: only a person decides, a connected app's
// decision names its client id, and only the app's redirect origin may read
// an answer. Every value here is synthetic.

export const JOURNEY_NTASKS_CLIENT_ID = "journey-tower";
export const JOURNEY_NTASKS_APP_NAME = "Journey Tower";
export const JOURNEY_NTASKS_PERSON = "journey-owner";
const SERVICE_CREDENTIAL = "journey-service-credential";
const PROJECT_ID = "journey-ntasks-project";
const WORKSPACE_ID = "journey-workspace";
const API_VERSION = 2;
const SCOPES = ["tasks:read", "tasks:write", "tasks:decide"];
const SERVICE_REFUSAL = "Only a person signed in to Ntasks decides; a service credential never does.";

/** A task row as the harness keeps it, in `bd`'s shape. */
export interface FixtureRow {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  labels: string[];
  assignee: string | null;
  closed_at: string | null;
  close_reason: string | null;
  metadata: Record<string, unknown> | null;
  [field: string]: unknown;
}

/** One decision Ntasks took, or refused, and who sent it. */
export interface NtasksDecision {
  task: string;
  action: string;
  option: string | null;
  /** The person's name, or the service credential for a refused one. */
  by: string;
  /** The connected app's client id, for a person's decision through one. */
  app: string | null;
  recorded: boolean;
}

type Principal = { kind: "person"; name: string; app: string } | { kind: "service" };

export interface FixtureNtasks {
  handle(request: Request): Promise<Response>;
  /** What the Tower's server reaches Ntasks through. */
  service: TaskService;
  decisions(): readonly NtasksDecision[];
  /** How many times the installation registered the Tower here. */
  registrations(): number;
  /** Every token the person holds stops working, as after Revoke in Ntasks. */
  revoke(): void;
}

/** The Tower as an app of this Ntasks: registered with its client id saved,
 * not registered yet, or not registered because Ntasks refuses to. */
export type FixtureAppState = "registered" | "unregistered" | "refused";

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
const escapeHtml = (text: string) => text.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

export function createFixtureNtasks(options: {
  rows: () => FixtureRow[];
  /** After a change, so the Tower's snapshot follows (the harness's `publishTasks`). */
  changed: () => void;
  project: () => { asset: string; prefix: string };
  /** The Tower's origin: the one redirect origin of the app it is registered as. */
  towerOrigin: string;
  now: string;
  app?: FixtureAppState;
}): FixtureNtasks {
  const redirectUri = `${options.towerOrigin}/tasks/signed-in`;
  // What the installation keeps beside its connection, and what Ntasks has registered.
  let savedClientId: string | null = (options.app ?? "registered") === "registered" ? JOURNEY_NTASKS_CLIENT_ID : null;
  let registered = savedClientId !== null;
  let registrations = 0;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const access = new Map<string, Principal>();
  const refresh = new Set<string>();
  const decided: NtasksDecision[] = [];

  const project = (): NtasksProject => ({ projectId: PROJECT_ID, logicalKey: options.project().asset, displayName: "Journey Example",
    prefix: options.project().prefix });

  function answer(request: Request, body: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("x-ntasks-api-version", String(API_VERSION));
    const origin = request.headers.get("origin");
    if (origin === options.towerOrigin) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-expose-headers", "www-authenticate, retry-after, x-ntasks-api-version");
      headers.append("vary", "origin");
    }
    return body === null ? new Response(null, { ...init, headers }) : Response.json(body, { ...init, headers });
  }

  function principalOf(request: Request): Principal | null {
    const bearer = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    if (bearer === SERVICE_CREDENTIAL) return { kind: "service" };
    return bearer === undefined ? null : access.get(bearer) ?? null;
  }

  function issue(): Record<string, unknown> {
    const token = base64url(randomBytes(24)), renewal = base64url(randomBytes(24));
    access.set(token, { kind: "person", name: JOURNEY_NTASKS_PERSON, app: JOURNEY_NTASKS_CLIENT_ID });
    refresh.add(renewal);
    return { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: renewal, scope: [...SCOPES, "offline_access"].join(" ") };
  }

  function board(url: URL) {
    const statuses = (url.searchParams.get("status") ?? "open,in_progress,blocked,deferred,closed").split(",");
    const rows = options.rows();
    const ready = new Set(rows.filter((row) => row.status === "open" && row.issue_type === "task").map((row) => row.id));
    return { project: options.project().asset, prefix: options.project().prefix, repo: "", readAt: options.now, closedSince: options.now.slice(0, 10),
      tasks: rows.filter((row) => statuses.includes(row.status)).map((row) => toLiveTask(row, ready)), epics: [], actors: [] };
  }

  function decide(row: FixtureRow, action: string, body: Record<string, unknown>, person: Extract<Principal, { kind: "person" }>): void {
    const at = options.now;
    if (action === "choose") {
      const choices = readTaskChoices(row.metadata);
      const option = choices?.options.find((entry) => entry.key === body.option);
      if (!option) return;
      row.metadata = { ...(row.metadata ?? {}), [TASK_METADATA.choice.name]: { option: option.key, label: option.label, by: person.name, at,
        ...(typeof body.note === "string" && body.note.trim() !== "" ? { note: body.note } : {}) } };
    }
    if (action === "choose" || action === "respond") {
      row.labels = row.labels.filter((label) => label !== "human");
      row.assignee = null;
      row.status = "open";
    } else {
      row.status = "closed";
      row.closed_at = at;
      row.close_reason = action === "resolve" ? "Approved" : "Dismissed";
    }
    decided.push({ task: row.id, action, option: typeof body.option === "string" ? body.option : null, by: person.name, app: person.app, recorded: true });
    options.changed();
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      if (origin !== options.towerOrigin) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
      return answer(request, null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH",
        "access-control-allow-headers": "authorization, content-type, x-ntasks-workspace, idempotency-key", "access-control-max-age": "600" } });
    }
    if (origin !== null && origin !== options.towerOrigin && request.method !== "GET") return Response.json({ error: "origin_not_allowed" }, { status: 403 });

    if (path === "/api/version") return answer(request, { version: API_VERSION, oldest: 1 });
    if (path === "/api/auth/oauth2/register" && request.method === "POST") {
      // RFC 7591 with the service credential as the initial access token.
      if (principalOf(request)?.kind !== "service") return answer(request, { error: "invalid_token" }, { status: 401 });
      const metadata = await request.json().catch(() => ({})) as { client_name?: unknown; redirect_uris?: unknown };
      if (options.app === "refused") return answer(request, { error: "invalid_client_metadata", error_description: "refused by the fixture" }, { status: 400 });
      if (typeof metadata.client_name !== "string" || JSON.stringify(metadata.redirect_uris) !== JSON.stringify([redirectUri])) {
        return answer(request, { error: "invalid_redirect_uri" }, { status: 400 });
      }
      registrations += 1;
      const repeat = registered;
      registered = true;
      return answer(request, { client_id: JOURNEY_NTASKS_CLIENT_ID, client_name: metadata.client_name, redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        scope: [...SCOPES, "offline_access"].join(" ") }, { status: repeat ? 200 : 201 });
    }
    if (path === "/api/auth/oauth2/authorize" || path === "/api/auth/oauth2/allow") {
      const asked = url.searchParams;
      if (!registered || asked.get("client_id") !== JOURNEY_NTASKS_CLIENT_ID || asked.get("redirect_uri") !== redirectUri || asked.get("response_type") !== "code"
        || asked.get("code_challenge_method") !== "S256" || !asked.get("code_challenge") || asked.get("resource") !== `${JOURNEY_NTASKS_ORIGIN}/api/mcp`) {
        return new Response("This sign-in request does not match a registered app.", { status: 400 });
      }
      if (path === "/api/auth/oauth2/authorize") {
        // The approval page: the app's name and who it acts as, then Allow.
        return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ntasks</title></head><body>
          <h1>Allow ${escapeHtml(JOURNEY_NTASKS_APP_NAME)}</h1>
          <p>${escapeHtml(JOURNEY_NTASKS_APP_NAME)} acts as you, ${escapeHtml(JOURNEY_NTASKS_PERSON)}, in Journey Example: it reads and changes tasks and makes your decisions.</p>
          <a href="/api/auth/oauth2/allow?${escapeHtml(asked.toString())}">Allow</a></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const code = base64url(randomBytes(18));
      codes.set(code, { challenge: asked.get("code_challenge")!, redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", asked.get("state") ?? "");
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (path === "/api/auth/oauth2/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_id") !== JOURNEY_NTASKS_CLIENT_ID) return answer(request, { error: "invalid_client" }, { status: 401 });
      if (form.get("grant_type") === "authorization_code") {
        const kept = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = base64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest());
        if (!kept || kept.challenge !== challenge || kept.redirectUri !== form.get("redirect_uri")) return answer(request, { error: "invalid_grant" }, { status: 400 });
        return answer(request, issue());
      }
      if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token") ?? "")) return answer(request, issue());
      return answer(request, { error: "invalid_grant" }, { status: 400 });
    }

    const principal = principalOf(request);
    if (principal === null) return answer(request, { error: "invalid_token" }, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    if (path === "/api/access/me") {
      return principal.kind === "person"
        ? answer(request, { kind: "person", name: principal.name, projects: "all", deploymentAdmin: false,
          app: { clientId: principal.app, name: JOURNEY_NTASKS_APP_NAME, workspaceId: WORKSPACE_ID, scopes: SCOPES } })
        : answer(request, { kind: "service", name: "service:noticeos", projects: [PROJECT_ID] });
    }
    if (path === "/api/tasks/projects") return answer(request, { projects: [project()] });
    if (path === "/api/tasks" && request.method === "GET") {
      if (url.searchParams.get("project") !== PROJECT_ID) return answer(request, { error: "not_found" }, { status: 404 });
      return answer(request, board(url));
    }
    const gate = /^\/api\/gates\/([^/]+)\/resolve$/u.exec(path);
    const action = /^\/api\/tasks\/([^/]+)\/(choose|respond|dismiss|dispute)$/u.exec(path);
    const one = /^\/api\/tasks\/([^/]+)$/u.exec(path);
    const id = decodeURIComponent((gate ?? action ?? one)?.[1] ?? "");
    const row = options.rows().find((entry) => entry.id === id);
    if (one && request.method === "GET") {
      if (!row) return answer(request, { error: "not_found" }, { status: 404 });
      return answer(request, { project: options.project().asset, prefix: options.project().prefix, repo: "", readAt: options.now,
        task: toLiveTask(row, new Set()), comments: [], actors: [] });
    }
    if ((gate || action) && request.method === "POST") {
      const verb = gate ? "resolve" : action![2]!;
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      if (principal.kind !== "person") {
        decided.push({ task: id, action: verb, option: typeof body.option === "string" ? body.option : null, by: "service:noticeos", app: null, recorded: false });
        return answer(request, { error: "insufficient_scope", detail: SERVICE_REFUSAL }, { status: 403 });
      }
      if (body.projectId !== PROJECT_ID || !row) return answer(request, { error: "not_found" }, { status: 404 });
      decide(row, verb, body, principal);
      return answer(request, { task: toLiveTask(row, new Set()) });
    }
    return answer(request, { error: "not_found", detail: "The fixture Ntasks does not answer this route." }, { status: 404 });
  }

  const service: TaskService = {
    connected: async () => true,
    backend: async () => "ntasks",
    origin: async () => JOURNEY_NTASKS_ORIGIN,
    appClientId: async () => savedClientId,
    // The ingest's part: the saved client id, or Ntasks's answer to registering, then saved.
    async registerApp(sentRedirect) {
      if (savedClientId !== null) return savedClientId;
      const reply = await handle(new Request(`${JOURNEY_NTASKS_ORIGIN}/api/auth/oauth2/register`, { method: "POST",
        headers: { authorization: `Bearer ${SERVICE_CREDENTIAL}`, "content-type": "application/json" },
        body: JSON.stringify({ client_name: JOURNEY_NTASKS_APP_NAME, redirect_uris: [sentRedirect], token_endpoint_auth_method: "none" }) }));
      const body = await reply.json() as { client_id?: string; error?: string };
      if (!reply.ok || typeof body.client_id !== "string") throw new TaskServiceAppRefused(body.error ?? "refused", reply.status);
      savedClientId = body.client_id;
      return savedClientId;
    },
    home: async () => ({ backend: "ntasks", origin: JOURNEY_NTASKS_ORIGIN }),
    async call(call) {
      const reply = await handle(new Request(`${JOURNEY_NTASKS_ORIGIN}${call.path}`, { method: call.method,
        headers: { authorization: `Bearer ${SERVICE_CREDENTIAL}`, "content-type": "application/json" },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }) }));
      return { status: reply.status, body: reply.status === 204 ? null : await reply.json().catch(() => null) };
    },
    tool: async () => { throw new Error("The fixture Ntasks has no MCP tools."); },
    projects: async () => [project()],
    workspaceId: async () => WORKSPACE_ID,
  };

  return {
    handle,
    service,
    decisions: () => decided,
    registrations: () => registrations,
    revoke() { access.clear(); refresh.clear(); },
  };
}
