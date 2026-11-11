// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { handleTasksRequest, readSpokes, taskLane } from "../vite/task-lane";

// The Tower's task routes on a Tower served from this machine with no task
// service connected, as the synthetic viewer always is. task-service-lane.test.ts
// covers the routes while a task service is connected.

const SAME_ORIGIN = {
  host: "office-mac.local:5173",
  origin: "http://office-mac.local:5173",
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};
const SPOKES = [{ asset: "example.com", prefix: "ex", database: "ex" }];

/** The lane with no task service, counting every read of the saved projects. */
function lane() {
  let reads = 0;
  const readProjects = async () => { reads += 1; return SPOKES.map(spoke => ({ ...spoke, repo: "" })); };
  const ask = (method: string, url: string, body?: unknown, headers: Record<string, string> = SAME_ORIGIN) =>
    handleTasksRequest({ method, url, headers, body: body === undefined ? "" : JSON.stringify(body) }, { readProjects });
  return { ask, reads: () => reads };
}

describe("without a task service", () => {
  it("answers the capabilities without reading a project", async () => {
    const { ask, reads } = lane();
    expect(await ask("GET", "/api/tasks/capabilities")).toEqual({ status: 200, body: { live: true, reason: null } });
    expect(reads()).toBe(0);
  });

  it("reports that its tasks live only in a task service, which is not connected", async () => {
    const { ask, reads } = lane();
    expect(await ask("GET", "/api/tasks/service")).toEqual({ status: 200, body: { connected: false, origin: null, projects: null, required: true } });
    expect(reads()).toBe(0);
  });

  it.each([
    ["GET", "/api/tasks?project=example.com", undefined],
    ["GET", "/api/tasks/ex-1", undefined],
    ["GET", "/api/tasks/agent-stats", undefined],
    ["POST", "/api/tasks", { project: "example.com", title: "Filed" }],
    ["PATCH", "/api/tasks/ex-1", { claim: true }],
    ["POST", "/api/tasks/ex-1/close", { reason: "Done" }],
    ["POST", "/api/gates/ex-g1/resolve", { reason: "Approved" }],
  ])("answers %s %s as not connected, reading no project", async (method, url, body) => {
    const { ask, reads } = lane();
    expect(await ask(method, url, body)).toMatchObject({ status: 409, body: { error: "task_service_not_connected" } });
    expect(reads()).toBe(0);
  });

  it("refuses a request from another origin before any read", async () => {
    const { ask, reads } = lane();
    const reply = await ask("GET", "/api/tasks?project=example.com", undefined, { ...SAME_ORIGIN, origin: "https://elsewhere.example" });
    expect(reply).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(reads()).toBe(0);
  });

  it("answers through the dev server's plugin as not connected", async () => {
    const own = await fs.mkdtemp(path.join(os.tmpdir(), "noticeos-task-lane-"));
    const server = await createTestViteServer(createServer, { configFile: false, root: own, logLevel: "silent",
      plugins: [taskLane({ readProjects: async () => [] })], server: { host: "127.0.0.1", port: 0, strictPort: true } }, { pages: false });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Missing owned test listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks?project=example.com`, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "task_service_not_connected" });
    } finally {
      await server.close();
      await fs.rm(own, { recursive: true, force: true });
    }
  });
});

it("reads the stored project map joined to this host's repository links", async () => {
  const projects = await readSpokes(await fs.realpath(os.tmpdir()), {
    token: "op",
    fetchImpl: async () => Response.json({ ready: true, documents: [{ file: "config/beads.json", version: 3, body: { spokes: SPOKES } }] }),
    readHost: async () => JSON.stringify({ repositories: SPOKES }),
  });
  expect(projects.map(({ asset, prefix, database, unavailableReason }) => ({ asset, prefix, database, unavailableReason })))
    .toEqual([{ asset: "example.com", prefix: "ex", database: "ex", unavailableReason: undefined }]);
});
