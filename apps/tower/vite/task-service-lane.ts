// The task routes while this installation's tasks live in Ntasks
// (docs/11-integrations.md#ntasks): task-lane.ts hands every /api/tasks and
// /api/gates request here once a task service is connected. Each read is
// Ntasks's answer, addressed by site as the standalone pages address it, and
// is kept (scripts/task-service-cache.mts); when Ntasks cannot be reached a
// read answers the kept copy, marked `cached`, with the time Ntasks read it.
// A write answers only what Ntasks answered: nothing is saved here. These
// calls carry the installation's service credential, which Ntasks never lets
// decide; a person's decisions go from their browser to Ntasks with their own
// sign-in (src/lib/ntasks-sign-in.ts).

import { randomUUID } from "node:crypto";
import type { LaneReply, LaneRequest } from "./lane";
import { isTaskId, TASKS_CLOSED_HISTORY_DAYS, type TaskServiceStatus } from "../shared/tasks";
import { AGENT_HISTORY_DAYS, readAgentStats, type AgentStatsProject } from "../../../packages/contract/src/agent-stats.mjs";
import { mapTaskProjects, TaskServiceUnavailable, unavailableSentence, withNoticeosRecords, type MappedTaskProject, type NtasksProject,
  type TaskService } from "../../../scripts/task-service.mjs";
import { ALL_STATUSES, boardKey, readCached, taskKey, writeCached } from "../../../scripts/task-service-cache.mjs";

export interface TaskServiceLaneOptions {
  service: TaskService;
  /** The saved task projects (config/beads.json `spokes`): each site and its task prefix. */
  readProjects: () => Promise<readonly { asset: string; prefix: string }[]>;
  cacheDir: string;
  now: () => Date;
}

const STATUS_PATTERN = /^[a-z_]+(,[a-z_]+)*$/u;
const ACTIONS = new Set(["close", "comments", "respond", "choose", "dismiss", "dispute"]);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
/** Who Ntasks records for a change made on the Tower's pages: `service:<credential>/tower`. */
export const TOWER_ACTOR = "tower";

class Refused extends Error {
  constructor(readonly reply: LaneReply) { super(String(reply.body.error)); }
}
const refuse = (status: number, error: string, detail?: string) =>
  new Refused({ status, body: detail === undefined ? { error } : { error, detail } });

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const CREDENTIAL_REFUSED = "Ntasks refused this installation's service credential; replace it in Settings → Task projects.";
/** The routes only a person signed in to Ntasks may use; the installation's credential is refused them by design. */
const PERSON_ACTIONS = new Set(["respond", "choose", "dismiss", "dispute"]);

/** Ntasks's refusal, in the `{ error, detail }` shape the pages read. On a
 * route only a person may use, Ntasks's own sentence says where to decide;
 * there the credential is not at fault. */
function relayed(status: number, body: unknown, personOnly = false): LaneReply {
  const answer = record(body) ?? {};
  if (personOnly && status === 403 && answer.error === "insufficient_scope" && typeof answer.detail === "string") {
    return { status: 403, body: { error: "insufficient_scope", detail: answer.detail } };
  }
  if (status === 401 || status === 403) return { status: 502, body: { error: "task_service_refused", detail: CREDENTIAL_REFUSED } };
  return { status, body: { error: typeof answer.error === "string" ? answer.error : "task_service_refused",
    ...(typeof answer.detail === "string" ? { detail: answer.detail } : {}) } };
}

const PROJECTS_KEY = "projects";
/** The last project list kept, so an unchanged list is not written again. */
let keptProjects: readonly NtasksProject[] | null = null;

/** Ntasks's projects, or the list it last gave when it cannot be reached:
 * an offline read still has to know which project a site's tasks are in. */
async function ntasksProjects(opts: TaskServiceLaneOptions): Promise<readonly NtasksProject[]> {
  try {
    const projects = await opts.service.projects();
    if (projects !== keptProjects) { await writeCached(opts.cacheDir, PROJECTS_KEY, projects, () => opts.now().getTime()); keptProjects = projects; }
    return projects;
  } catch (error) {
    if (!(error instanceof TaskServiceUnavailable)) throw error;
    const kept = await readCached(opts.cacheDir, PROJECTS_KEY);
    if (kept && Array.isArray(kept.body)) return kept.body as NtasksProject[];
    throw error;
  }
}

async function mapped(opts: TaskServiceLaneOptions): Promise<MappedTaskProject[]> {
  return mapTaskProjects(await opts.readProjects(), await ntasksProjects(opts));
}
function projectFor(projects: readonly MappedTaskProject[], match: (project: MappedTaskProject) => boolean, named: string) {
  const found = projects.find(match);
  if (!found) throw refuse(404, "unknown_project", `${named} is not a saved task project; Settings → Task projects lists them`);
  if (!found.project) throw refuse(404, "unmapped_project", `No Ntasks project has the prefix ${found.prefix}`);
  return { asset: found.asset, projectId: found.project.projectId };
}
const prefixOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("-"))).toLowerCase();

/** A board or a task read with each task's close and claim under the keys the pages read. */
function withRecords(body: Record<string, unknown>): Record<string, unknown> {
  const tasks = Array.isArray(body.tasks) ? body.tasks.map(task => record(task) ? withNoticeosRecords(record(task)!) : task) : body.tasks;
  const task = record(body.task) ? withNoticeosRecords(record(body.task)!) : body.task;
  return { ...body, ...(tasks === undefined ? {} : { tasks }), ...(task === undefined ? {} : { task }) };
}

/** A read: Ntasks's answer, kept; or, when Ntasks gave none, the kept copy. */
async function read(opts: TaskServiceLaneOptions, key: string, path: string, asset: string): Promise<LaneReply> {
  let reason: string;
  try {
    const { status, body } = await opts.service.call({ method: "GET", path });
    if (status === 200 && record(body)) {
      const answer = { ...withRecords(record(body)!), project: asset };
      await writeCached(opts.cacheDir, key, answer, () => opts.now().getTime());
      return { status: 200, body: answer };
    }
    if (status === 200) return { status: 502, body: { error: "task_service_invalid", detail: "Ntasks answered this read with something other than a task read." } };
    if (status !== 502 && status !== 503 && status !== 504) {
      return relayed(status === 400 ? 422 : status, body);
    }
    reason = `Ntasks answered HTTP ${status}`;
  } catch (error) {
    if (!(error instanceof TaskServiceUnavailable)) throw error;
    reason = unavailableSentence(error, await opts.service.origin().catch(() => null));
  }
  const kept = await readCached(opts.cacheDir, key);
  if (kept && record(kept.body)) return { status: 200, body: { ...record(kept.body)!, cached: { reason } } };
  return { status: 503, body: { error: "task_service_unreachable", detail: `${reason} No copy of this read is kept on this machine.` } };
}

/** A write: Ntasks's own answer, or a refusal that says nothing was saved. */
async function write(opts: TaskServiceLaneOptions, method: "POST" | "PATCH", path: string, body: Record<string, unknown>,
  idempotencyKey: string, personOnly = false): Promise<LaneReply> {
  try {
    // The Tower's own changes are the operator's, under the installation's credential.
    const { status, body: answer } = await opts.service.call({ method, path, body, idempotencyKey, onBehalfOf: TOWER_ACTOR });
    if (status >= 200 && status < 300) return { status, body: record(answer) ?? {} };
    if (status === 404 && record(answer)?.error === "not_found" && typeof record(answer)?.detail !== "string" || status === 405) {
      return { status: 501, body: { error: "task_service_unsupported", detail: "Ntasks does not accept this change yet, so nothing was saved." } };
    }
    return relayed(status === 400 ? 422 : status, answer, personOnly);
  } catch (error) {
    if (!(error instanceof TaskServiceUnavailable)) throw error;
    const sentence = unavailableSentence(error, await opts.service.origin().catch(() => null));
    return { status: 503, body: { error: "task_service_unreachable",
      detail: error.reason === "timeout" ? `${sentence} The change may have landed; reload before sending it again.` : `${sentence} Nothing was saved.` } };
  }
}

function parseBody(request: LaneRequest): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(request.body === "" ? "{}" : request.body); } catch { throw refuse(400, "invalid_json"); }
  const body = record(parsed);
  if (!body) throw refuse(400, "invalid_json");
  return body;
}

/** One project's agent work, read from its boards. */
async function agentStats(opts: TaskServiceLaneOptions, url: URL): Promise<LaneReply> {
  if ([...url.searchParams.keys()].some(key => key !== "project") || url.searchParams.getAll("project").length > 1) {
    throw refuse(422, "invalid_query", "Only one project may be selected");
  }
  const selected = url.searchParams.get("project");
  const all = await mapped(opts);
  const projects = selected === null ? all : all.filter(project => project.asset === selected);
  if (selected !== null && projects.length === 0) throw refuse(404, "unknown_project");
  const readAt = opts.now().toISOString();
  const read: AgentStatsProject[] = [], broken: string[] = [];
  for (const project of projects) {
    try {
      if (!project.project) throw new Error("unmapped");
      const id = encodeURIComponent(project.project.projectId);
      const boards = await Promise.all([`status=in_progress,blocked`, `status=closed&closedDays=${AGENT_HISTORY_DAYS}`]
        .map(query => opts.service.call({ method: "GET", path: `/api/tasks?project=${id}&${query}` })));
      const tasks = boards.flatMap(board => {
        const rows = record(board.body)?.tasks;
        if (board.status !== 200 || !Array.isArray(rows)) throw new Error("unreadable");
        return rows.map(task => record(task) ? withNoticeosRecords(record(task)!) : task) as AgentStatsProject["tasks"];
      });
      read.push({ project: project.asset, tasks });
    } catch { broken.push(project.asset); }
  }
  return { status: 200, body: { readAt, projects: projects.length, broken, stats: readAgentStats(read, Date.parse(readAt)) } };
}

/** GET /api/tasks/service for Settings → Task projects. */
export async function taskServiceStatus(service: TaskService | null,
  readProjects: TaskServiceLaneOptions["readProjects"]): Promise<TaskServiceStatus> {
  if (!service) return { connected: false, origin: null, projects: null };
  const connected = await service.connected().catch(() => null);
  if (connected !== true) return { connected, origin: null, projects: null, required: true };
  const origin = await service.origin().catch(() => null);
  const clientId = await service.appClientId().catch(() => null);
  // The workspace the Tower reads, which a person's sign-in must reach before
  // their decision is sent (src/lib/ntasks-sign-in.ts personDecisions).
  const app = clientId === null ? null : { clientId, workspaceId: await service.workspaceId().catch(() => null) };
  try {
    const projects = mapTaskProjects(await readProjects(), await service.projects()).map(entry => ({ asset: entry.asset, prefix: entry.prefix,
      project: entry.project && { displayName: entry.project.displayName, logicalKey: entry.project.logicalKey, projectId: entry.project.projectId } }));
    return { connected, origin, projects, required: true, app };
  } catch (error) {
    return { connected, origin, projects: null, required: true, app, reason: error instanceof TaskServiceUnavailable ? unavailableSentence(error, origin)
      : "The saved task projects could not be read." };
  }
}

export async function handleTaskServiceRequest(pathname: string, url: URL, request: LaneRequest,
  opts: TaskServiceLaneOptions): Promise<LaneReply> {
  try {
    const method = request.method;
    if (pathname === "/api/tasks/agent-stats") {
      if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
      return await agentStats(opts, url);
    }
    const sent = request.headers["idempotency-key"];
    const idempotencyKey = sent !== undefined && KEY.test(sent) ? sent : randomUUID();
    if (pathname === "/api/tasks") {
      if (method === "GET") {
        const statuses = url.searchParams.get("status") ?? ALL_STATUSES;
        if (!STATUS_PATTERN.test(statuses)) throw refuse(422, "invalid_status", `"${statuses}" is not a comma-separated status list`);
        const days = url.searchParams.get("closedDays");
        if (days !== null && (!/^[1-9]\d?$/u.test(days) || Number(days) > TASKS_CLOSED_HISTORY_DAYS || statuses !== "closed")) {
          throw refuse(422, "invalid_window", `closedDays is 1 to ${TASKS_CLOSED_HISTORY_DAYS}, with status=closed`);
        }
        const asset = url.searchParams.get("project") ?? "";
        const { projectId } = projectFor(await mapped(opts), project => project.asset === asset, asset || "No project");
        const query = new URLSearchParams({ project: projectId });
        if (statuses !== ALL_STATUSES) query.set("status", statuses);
        if (days !== null) query.set("closedDays", days);
        return await read(opts, boardKey(asset, statuses, days === null ? undefined : Number(days)), `/api/tasks?${query}`, asset);
      }
      if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
      const body = parseBody(request);
      const asset = typeof body.project === "string" ? body.project : "";
      const { projectId } = projectFor(await mapped(opts), project => project.asset === asset, asset || "No project");
      const { project: _project, ...fields } = body;
      if (Array.isArray(fields.labels) && fields.labels.length === 0) delete fields.labels;
      return await write(opts, "POST", "/api/tasks", { ...fields, projectId }, idempotencyKey);
    }
    const gate = /^\/api\/gates\/([^/]+)\/resolve$/u.exec(pathname);
    const action = /^\/api\/tasks\/([^/]+)\/([^/]+)$/u.exec(pathname);
    const one = /^\/api\/tasks\/([^/]+)$/u.exec(pathname);
    const id = decodeURIComponent((gate ?? action ?? one)?.[1] ?? "");
    if (!(gate || action || one) || !isTaskId(id) || (action && !ACTIONS.has(action[2]!))) return { status: 404, body: { error: "not_found" } };
    const { asset, projectId } = projectFor(await mapped(opts), project => project.prefix.toLowerCase() === prefixOf(id), id);
    if (one && method === "GET") return await read(opts, taskKey(id), `/api/tasks/${encodeURIComponent(id)}?project=${encodeURIComponent(projectId)}`, asset);
    if (one ? method !== "PATCH" : method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    const { project: _project, ...fields } = parseBody(request);
    const personOnly = gate !== null || (action !== null && PERSON_ACTIONS.has(action[2]!));
    return await write(opts, one ? "PATCH" : "POST", pathname, { ...fields, projectId }, idempotencyKey, personOnly);
  } catch (error) {
    if (error instanceof Refused) return error.reply;
    if (error instanceof TaskServiceUnavailable) {
      return { status: 503, body: { error: "task_service_unreachable", detail: unavailableSentence(error, await opts.service.origin().catch(() => null)) } };
    }
    throw error;
  }
}
