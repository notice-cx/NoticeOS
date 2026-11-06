// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleTasksRequest } from "../vite/task-lane";
import { TaskServiceUnavailable, type TaskService, type TaskServiceCall } from "../../../scripts/task-service.mjs";

// The Tower's task routes while tasks live in Ntasks (vite/task-service-lane.ts).
// Ntasks is a scripted TaskService here; `bd` must never run.

const PROJECT = { projectId: "8b3adafa-0d35-8bd9-b981-7a238b7cf410", logicalKey: "example.com", displayName: "Example", prefix: "ex" };
const BOARD = { project: "example.com", prefix: "ex", repo: "", readAt: "2026-11-06T10:00:00.000Z", closedSince: "2026-10-30",
  tasks: [{ id: "ex-1", title: "From Ntasks", status: "open" }], epics: [], actors: [] };
const DETAIL = { project: "example.com", prefix: "ex", repo: "", readAt: "2026-11-06T10:00:00.000Z", task: { id: "ex-1" }, comments: [], actors: [], proposal: "[]" };

let cacheDir: string;
beforeEach(async () => { cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-service-lane-")); });
afterEach(async () => { await fs.rm(cacheDir, { recursive: true, force: true }); });

/** A task service that answers `answer(call)`; `down` makes every call unanswered. */
function ntasks(answer: (call: TaskServiceCall) => { status: number; body: unknown }, state = { down: false, connected: true }) {
  const calls: TaskServiceCall[] = [];
  const service: TaskService = {
    connected: async () => state.connected,
    origin: async () => "https://ntasks.example.com",
    async call(call) {
      calls.push(call);
      if (state.down) throw new TaskServiceUnavailable("network");
      return answer(call);
    },
    async projects() {
      if (state.down) throw new TaskServiceUnavailable("network");
      return [PROJECT];
    },
    tool: async () => { throw new Error("no tools here"); },
  };
  return { service, calls, state };
}

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return { method, url, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? "" : JSON.stringify(body) };
}
function lane(service: TaskService, ran: string[][] = []) {
  return (req: ReturnType<typeof request>) => handleTasksRequest(req, {
    taskService: service, taskCacheDir: cacheDir,
    readProjects: async () => [{ asset: "example.com", prefix: "ex", repo: "", database: "ex", cwd: cacheDir }],
    run: argv => { ran.push(argv); return { code: 0, stdout: "[]", stderr: "" }; },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
}

it("reads a site's board from its Ntasks project and keeps the copy", async () => {
  const ran: string[][] = [];
  const { service, calls } = ntasks(() => ({ status: 200, body: { ...BOARD, project: "example.com-in-ntasks" } }));
  const reply = await lane(service, ran)(request("GET", "/api/tasks?project=example.com"));
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({ project: "example.com", readAt: BOARD.readAt, tasks: BOARD.tasks });
  expect(reply.body.cached).toBeUndefined();
  expect(calls).toEqual([{ method: "GET", path: `/api/tasks?project=${PROJECT.projectId}` }]);
  const narrowed = await lane(service)(request("GET", "/api/tasks?project=example.com&status=closed&closedDays=15"));
  expect(narrowed.status).toBe(200);
  expect(calls[1]).toEqual({ method: "GET", path: `/api/tasks?project=${PROJECT.projectId}&status=closed&closedDays=15` });
  expect(ran).toEqual([]);
});

it("shows the kept copy, with the time Ntasks read it, while Ntasks cannot be reached", async () => {
  const { service, state } = ntasks(call => ({ status: 200, body: call.path.startsWith("/api/tasks/") ? DETAIL : BOARD }));
  const read = lane(service);
  await read(request("GET", "/api/tasks?project=example.com"));
  await read(request("GET", "/api/tasks/ex-1"));
  state.down = true;
  const board = await read(request("GET", "/api/tasks?project=example.com"));
  expect(board.status).toBe(200);
  expect(board.body).toMatchObject({ readAt: BOARD.readAt, tasks: BOARD.tasks, cached: { reason: "https://ntasks.example.com did not answer (network)." } });
  const detail = await read(request("GET", "/api/tasks/ex-1"));
  expect(detail.body).toMatchObject({ readAt: DETAIL.readAt, task: { id: "ex-1" }, cached: { reason: expect.any(String) } });
  const never = await read(request("GET", "/api/tasks?project=example.com&status=open"));
  expect(never).toMatchObject({ status: 503, body: { error: "task_service_unreachable" } });
});

it("sends a change to Ntasks with the project's id and answers only what Ntasks answered", async () => {
  const { service, calls, state } = ntasks(call => call.method === "POST" && call.path === "/api/tasks"
    ? { status: 201, body: { id: "ex-2" } } : { status: 404, body: { error: "not_found" } });
  const send = lane(service);
  const created = await send(request("POST", "/api/tasks", { project: "example.com", title: "New", labels: [] }, { "idempotency-key": "create-12345678" }));
  expect(created).toEqual({ status: 201, body: { id: "ex-2" } });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/tasks", body: { title: "New", projectId: PROJECT.projectId }, idempotencyKey: "create-12345678", onBehalfOf: "tower" });

  const claim = await send(request("PATCH", "/api/tasks/ex-1", { claim: true }));
  expect(claim).toMatchObject({ status: 501, body: { error: "task_service_unsupported" } });
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/tasks/ex-1", body: { claim: true, projectId: PROJECT.projectId } });

  state.down = true;
  for (const [method, url, body] of [["POST", "/api/tasks/ex-1/comments", { text: "Note" }], ["POST", "/api/tasks/ex-1/close", { reason: "Done" }],
    ["PATCH", "/api/tasks/ex-1", { claim: true }], ["POST", "/api/gates/ex-1/resolve", {}]] as const) {
    const reply = await send(request(method, url, body));
    expect(reply.status, url).toBe(503);
    expect(reply.body.detail, url).toMatch(/Nothing was saved\.$/u);
  }
});

it("names a site with no Ntasks project instead of reading another", async () => {
  const { service } = ntasks(() => ({ status: 200, body: BOARD }));
  const reply = await handleTasksRequest(request("GET", "/api/tasks?project=shop.example"), { taskService: service, taskCacheDir: cacheDir,
    readProjects: async () => [{ asset: "shop.example", prefix: "shop", repo: "" }] });
  expect(reply).toMatchObject({ status: 404, body: { error: "unmapped_project", detail: "No Ntasks project has the prefix shop" } });
});

it("keeps the task routes on bd while no task service is connected", async () => {
  const ran: string[][] = [];
  const { service, calls } = ntasks(() => ({ status: 200, body: BOARD }), { down: false, connected: false });
  await lane(service, ran)(request("GET", "/api/tasks?project=example.com"));
  expect(calls).toEqual([]);
  expect(ran.length).toBeGreaterThan(0);
});
