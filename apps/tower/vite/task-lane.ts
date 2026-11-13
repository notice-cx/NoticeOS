// The task lane: dev-server middleware for the Tower's task routes. An
// installation's routes are answered from its task service
// (task-service-lane.ts); without one, as in the synthetic viewer, every task
// route but the capabilities and the service status answers that no task
// service is connected. A Worker can spawn no process, so a built Tower
// answers these paths read-only from worker/tasks-route.ts.

import type { Plugin, ViteDevServer } from "vite";
import { readTaskProjects, type TaskProjectReadOptions } from "../../../scripts/task-project-config.mjs";
import { TASK_SERVICE_APP_PATH, TASK_SERVICE_NOT_CONNECTED, TASK_SERVICE_STATUS_PATH } from "../shared/tasks";
import type { TaskService } from "../../../scripts/task-service.mjs";
import { taskCacheDir } from "../../../scripts/task-service-cache.mjs";
import { handleTaskServiceRequest, registerTowerApp, taskServiceStatus } from "./task-service-lane";
import { DEFAULT_REPO_ROOT, crossOrigin, laneMiddleware, type LaneReply, type LaneRequest } from "./lane";

/** Gates live beside tasks because a gate has its own id space and verb. */
export const TASKS_PATH = "/api/tasks";
export const GATES_PATH = "/api/gates";

/** Asked first by the browser; never depends on a project or on the task service. */
export const CAPABILITIES_PATH = `${TASKS_PATH}/capabilities`;

export function ownsPath(pathname: string): boolean {
  return (
    pathname === TASKS_PATH ||
    pathname.startsWith(`${TASKS_PATH}/`) ||
    pathname.startsWith(`${GATES_PATH}/`)
  );
}

export interface TaskLaneOptions {
  /** The checkout a task project saved with the repository `.` resolves against. */
  repoRoot?: string;
  /** Stored project reader; tests can supply a disposable configuration door. */
  readProjects?: () => Promise<Spoke[]>;
  now?: () => Date;
  /** This installation's task service: every task route is answered from it.
   * Only the Tower's own config passes one, so no test reaches a real ingest. */
  taskService?: TaskService | null;
  /** Where the task service's answers are kept; defaults to the home checkout's `.local/task-cache`. */
  taskCacheDir?: string;
}

/** A saved task project, as the task service lane maps it to an Ntasks project. */
export interface Spoke {
  asset: string;
  prefix: string;
  /** As configured, relative to the repo root. */
  repo: string;
  database?: string | null;
  unavailableReason?: string;
  cwd?: string;
}

/** Saved membership, mapped to Ntasks by prefix per request. */
export async function readSpokes(repoRoot: string, options: TaskProjectReadOptions = {}): Promise<Spoke[]> {
  return readTaskProjects({ ...options, repoRoot });
}

export async function handleTasksRequest(
  request: LaneRequest,
  options: TaskLaneOptions = {},
): Promise<LaneReply> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const service = options.taskService ?? null;
  const readProjects = options.readProjects ?? (() => readSpokes(repoRoot));
  const url = new URL(request.url ?? TASKS_PATH, "http://lane.local");
  const pathname = url.pathname;

  // Answered before anything else: no project and no task service.
  if (pathname === CAPABILITIES_PATH) {
    if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    return { status: 200, body: { live: true, reason: null } };
  }

  // Same origin for reads too: every other path reads the saved projects or the task service.
  if (crossOrigin(request.headers)) {
    return { status: 403, body: { error: "forbidden" } };
  }

  if (pathname === TASK_SERVICE_STATUS_PATH) {
    if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    return { status: 200, body: { ...await taskServiceStatus(service, readProjects) } };
  }
  if (pathname === TASK_SERVICE_APP_PATH) return await registerTowerApp(service, request);

  const backend = service ? await service.backend() : "none";
  if (backend === "none") {
    return { status: 409, body: { error: TASK_SERVICE_NOT_CONNECTED,
      detail: "No task service is connected; connect Ntasks in Settings → Task projects." } };
  }
  if (backend === "unknown") {
    return { status: 503, body: { error: "task_service_unknown",
      detail: "The installation's ingest did not answer, so it is unknown where its tasks live. Nothing was read or saved." } };
  }
  try {
    return await handleTaskServiceRequest(pathname, url, request, { service: service!, readProjects,
      cacheDir: options.taskCacheDir ?? taskCacheDir(repoRoot), now: options.now ?? (() => new Date()) });
  } catch (err) {
    return { status: 500, body: { error: "task_lane_failed", detail: err instanceof Error ? err.message : String(err) } };
  }
}

export function taskLaneMiddleware(options: TaskLaneOptions = {}) {
  return laneMiddleware({
    matches: ownsPath,
    handle: (request) => handleTasksRequest(request, options),
    failure: "task_lane_failed",
  });
}

/** `enforce: "pre"`: it must answer before the Cloudflare plugin dispatches
 * these paths into the Worker. */
export function taskLane(options: TaskLaneOptions = {}): Plugin {
  return {
    name: "noticeos:task-lane",
    enforce: "pre",
    apply: "serve",
    configureServer(viteDevServer: ViteDevServer) {
      viteDevServer.middlewares.use(taskLaneMiddleware(options));
    },
  };
}
