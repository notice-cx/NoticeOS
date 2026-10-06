// @vitest-environment node
import { describe, expect, it } from "vitest";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "../shared/tasks";
import {
  READ_ONLY_TASKS_REFUSAL,
  handleTasksRequest,
  isTasksPath,
} from "../worker/tasks-route";

// What a DEPLOYED Tower says when asked to read or write the task hub. Locally
// these paths never reach the Worker — the task lane answers them first, in the
// process that can run `bd` (D19, bead `ro-l1ed.1`) — so these cases pin the
// other deployment, the one that has neither `bd` nor a route to a Dolt server
// on the operator's Mac.
//
// The point is not the status code. It is that the board DEGRADES rather than
// breaks: `live: false` reaches the browser before any action is offered, the
// snapshot at `/api/work` still renders, and a request that slipped through
// anyway gets a short refusal back rather than a blank failure. The
// capability answer is a STATE CODE, never a paragraph (bead
// `ro-ujb9.96.6.11`): the Tower draws it as a Read-only chip.

function ask(pathname: string): Response {
  return handleTasksRequest(new URL(`https://tower.example${pathname}`));
}

describe("/api/tasks/* on a build that cannot reach the hub", () => {
  it("reports that the lane is not live here, and why, as a code", async () => {
    const res = ask("/api/tasks/capabilities");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      live: false,
      reason: READ_ONLY_DEPLOYMENT,
    });
  });

  it("refuses every other task path as not-implemented-here", async () => {
    for (const pathname of [
      "/api/tasks",
      "/api/tasks?project=root-os",
      "/api/tasks/ro-aaa",
      "/api/tasks/ro-aaa/close",
      "/api/tasks/ro-aaa/comments",
      "/api/gates/ro-5n5/resolve",
    ]) {
      const res = ask(pathname);
      expect(res.status, pathname).toBe(501);
      await expect(res.json()).resolves.toEqual({
        error: "read_only_deployment",
        detail: READ_ONLY_TASKS_REFUSAL,
      });
    }
  });

  it("says what happened and what to do, in one short line — not a paragraph", () => {
    expect(READ_ONLY_TASKS_REFUSAL).toContain("Read-only");
    expect(READ_ONLY_TASKS_REFUSAL).toContain(READ_ONLY_TASKS_HINT);
    expect(READ_ONLY_TASKS_REFUSAL.split(/\s+/).length).toBeLessThanOrEqual(18);
  });

  it("claims exactly the paths the local lane owns, and nothing next to them", () => {
    for (const pathname of [
      "/api/tasks",
      "/api/tasks/capabilities",
      "/api/tasks/ro-aaa",
      "/api/gates/ro-5n5/resolve",
    ]) {
      expect(isTasksPath(pathname), pathname).toBe(true);
    }
    for (const pathname of ["/api/work", "/api/tasksomething", "/api/gates", "/api/config"]) {
      expect(isTasksPath(pathname), pathname).toBe(false);
    }
  });
});
