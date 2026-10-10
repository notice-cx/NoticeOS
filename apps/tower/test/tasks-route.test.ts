// @vitest-environment node
import { describe, expect, it } from "vitest";
import { READ_ONLY_DEPLOYMENT, READ_ONLY_TASKS_HINT } from "../shared/tasks";
import {
  READ_ONLY_TASKS_REFUSAL,
  handleTasksRequest,
  isTasksPath,
} from "../worker/tasks-route";

// What a deployed Tower says when asked to read or write the task hub. Locally
// the task lane answers these paths first, so these cases pin a deployment with
// neither `bd` nor a Dolt server: the board degrades rather than breaks, and the
// capability answer is a state code, never a paragraph.

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
