// `/api/tasks/*` and `/api/gates/*` in a deployed Tower. Locally the Node task
// lane (apps/tower/vite/task-lane.ts, `enforce: "pre"`) answers these first
// because it can run `bd`; this runtime cannot, so it serves the read-only
// `/api/work` snapshot and a state code the Tower draws as a Read-only chip.

import { JSON_HEADERS, jsonError } from "./http";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "../shared/tasks";

/** A write that slipped through anyway: what happened, then what to do. */
export const READ_ONLY_TASKS_REFUSAL = `Read-only deployment. ${READ_ONLY_TASKS_HINT}`;

/** True for every path the local lane owns — the set this route must answer for
 * in a build, so a deployed Tower never dispatches one of them somewhere else. */
export function isTasksPath(pathname: string): boolean {
  return (
    pathname === "/api/tasks" ||
    pathname.startsWith("/api/tasks/") ||
    pathname.startsWith("/api/gates/")
  );
}

export function handleTasksRequest(url: URL): Response {
  if (url.pathname === "/api/tasks/capabilities") {
    return Response.json(
      { live: false, reason: READ_ONLY_DEPLOYMENT },
      { headers: JSON_HEADERS },
    );
  }
  // 501, not 403 or 404: the path is real; the refusal is about this deployment.
  return jsonError(READ_ONLY_DEPLOYMENT, 501, { detail: READ_ONLY_TASKS_REFUSAL });
}
