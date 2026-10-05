// `/api/tasks/*` and `/api/gates/*` — what a DEPLOYED Tower says about the task
// hub.
//
// In the local `os:up` dev server these paths never reach the Worker: the task
// lane answers them first, in the Node process that can run `bd` against the
// hub (apps/tower/vite/task-lane.ts, `enforce: "pre"`), and a claim, close,
// comment or answer lands for real (D19, bead `ro-l1ed.1`).
//
// What is left here is the honest answer everywhere else. The hub is a Dolt
// server on 127.0.0.1:3308 on the operator's Mac and `bd` is the only client
// that speaks to it — this runtime has neither a route to that host nor a
// process to spawn. So a deployed build keeps the board it has always had: the
// once-a-minute snapshot at `/api/work`, read-only, with a state code saying
// why the actions are absent rather than broken. The code, not a sentence
// (bead `ro-ujb9.96.6.11`): the Tower draws it as a Read-only chip.

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
  // The one question a deployed build can answer: no. Asked once per session
  // before anything else, so the board knows to render the snapshot without
  // actions instead of offering a claim that cannot land.
  if (url.pathname === "/api/tasks/capabilities") {
    return Response.json(
      { live: false, reason: READ_ONLY_DEPLOYMENT },
      { headers: JSON_HEADERS },
    );
  }
  // Everything else — reads included. A live read is as impossible here as a
  // write: there is no `bd`. `501` rather than `403` or `404` because the path
  // is real and the refusal is about this deployment, not about the request.
  return jsonError(READ_ONLY_DEPLOYMENT, 501, { detail: READ_ONLY_TASKS_REFUSAL });
}
