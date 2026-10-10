// @vitest-environment node
// The Worker half of the runner lane: what it does once a request is allowed,
// and that it still refuses one that is not.

import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  RUNNER_INGEST_PREFIX,
  RUNNER_SCHEDULED_PATH,
} from "../shared/runner-lane";
import { type RunnerIngest, handleRunnerRequest } from "../worker/runner-route";

function doorRequest(path: string, init: RequestInit = {}): { request: Request; url: URL } {
  const url = new URL(`http://127.0.0.1:8791${path}`);
  const headers = new Headers(init.headers);
  headers.set(RUNNER_DOOR_HEADER, RUNNER_DOOR_HEADER_VALUE);
  return { request: new Request(url, { ...init, headers }), url };
}

function stubIngest(overrides: Partial<RunnerIngest> = {}): RunnerIngest {
  return {
    runScheduled: vi.fn(async () => {}),
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    ...overrides,
  };
}

describe("the runner lane's door check", () => {
  it("refuses a request that reached the Worker without the door mark", async () => {
    const url = new URL(`http://office-mac.local:5173${RUNNER_SCHEDULED_PATH}?cron=0 * * * *`);
    const ingest = stubIngest();
    const response = await handleRunnerRequest(new Request(url), url, ingest);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "runner_lane_loopback_only" });
    expect(ingest.runScheduled).not.toHaveBeenCalled();
  });
});

describe("firing a cron", () => {
  it.each(['ran', 'skipped', 'failed'] as const)('preserves the collector outcome %s', async outcome => {
    const ingest = stubIngest({ runScheduled: async () => ({ outcome, detail: 'Stored Mediavine collection evidence.' }) });
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=10,30,50 * * * *`);
    const response = await handleRunnerRequest(request, url, ingest);
    expect(await response.json()).toMatchObject({ outcome, detail: 'Stored Mediavine collection evidence.' });
  });
  it("hands the expression to the ingest's own dispatch table", async () => {
    const ingest = stubIngest();
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("*/15 * * * *")}`);
    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, cron: "*/15 * * * *" });
    expect(ingest.runScheduled).toHaveBeenCalledWith("*/15 * * * *");
  });

  // The Tower's own steps of a tick run after the ingest's and are one run of
  // the job.
  it("runs the Tower's steps after the ingest's and records them as one run", async () => {
    const order: string[] = [];
    const ingestStep = { id: "freshness", attempt: 1, startedAt: "2026-09-12T12:00:00.000Z", state: "succeeded" as const };
    const towerStep = { id: "connection-counts", attempt: 1, startedAt: "2026-09-12T12:00:01.000Z", state: "succeeded" as const };
    const ingest = stubIngest({ runScheduled: vi.fn(async () => { order.push("ingest"); return { outcome: "ran" as const, detail: "Execution completed", steps: [ingestStep] }; }) });
    const towerCron = vi.fn(async () => { order.push("tower"); return [towerStep]; });
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("0 * * * *")}`);
    const response = await handleRunnerRequest(request, url, ingest, towerCron);
    expect(order).toEqual(["ingest", "tower"]);
    expect(towerCron).toHaveBeenCalledWith("0 * * * *");
    expect(await response.json()).toEqual({ ok: true, cron: "0 * * * *", outcome: "ran", detail: "Execution completed", steps: [ingestStep, towerStep] });
  });

  it("fails the run when a Tower step failed, in the ingest's own words", async () => {
    const failed = { id: "connection-counts", attempt: 1, startedAt: "2026-09-12T12:00:01.000Z", state: "failed" as const };
    const ingest = stubIngest({ runScheduled: async () => ({ outcome: "ran" as const, detail: "Execution completed", steps: [] }) });
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("0 * * * *")}`);
    const response = await handleRunnerRequest(request, url, ingest, async () => [failed]);
    expect(await response.json()).toMatchObject({ outcome: "failed", detail: "A workflow step failed. Check service logs for details.", steps: [failed] });
  });

  it("refuses a fire with no expression rather than running every lane", async () => {
    const ingest = stubIngest();
    const { request, url } = doorRequest(RUNNER_SCHEDULED_PATH);
    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "cron_required" });
    expect(ingest.runScheduled).not.toHaveBeenCalled();
  });

  // An expression no scheduled job runs on ran nothing, and the door turns it
  // away by name instead of answering 200.
  it("refuses an expression the dispatch refused, by its name, and runs no Tower step", async () => {
    const ingest = stubIngest({
      runScheduled: vi.fn(async () => ({
        outcome: "failed" as const, detail: 'No scheduled job runs on "7 7 7 7 7".', refused: "unknown_cron" as const, steps: [],
      })),
    });
    const towerCron = vi.fn(async () => []);
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("7 7 7 7 7")}`);
    const response = await handleRunnerRequest(request, url, ingest, towerCron);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unknown_cron", cron: "7 7 7 7 7", message: 'No scheduled job runs on "7 7 7 7 7".',
    });
    expect(towerCron).not.toHaveBeenCalled();
  });

  it("names the failing lane, because the runner logs this line verbatim", async () => {
    const ingest = stubIngest({
      runScheduled: vi.fn(async () => {
        throw new Error("D1_ERROR: no such table");
      }),
    });
    const { request, url } = doorRequest(`${RUNNER_SCHEDULED_PATH}?cron=0 4 * * *`);
    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "scheduled_failed",
      cron: "0 4 * * *",
      message: "D1_ERROR: no such table",
    });
  });
});

describe("proxying the ingest's own routes", () => {
  it("forwards method, path and body, and returns what the ingest said", async () => {
    const seen: Request[] = [];
    const ingest = stubIngest({
      fetch: vi.fn(async (request: Request) => {
        seen.push(request);
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }),
    });
    const { request, url } = doorRequest(`${RUNNER_INGEST_PREFIX}/api/beads-snapshot`, {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
      body: JSON.stringify({ projects: [] }),
    });

    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(201);

    const forwarded = seen[0]!;
    expect(new URL(forwarded.url).pathname).toBe("/api/beads-snapshot");
    expect(forwarded.method).toBe("POST");
    // The ingest's own operator check must still run — the Tower adds no
    // authority to a proxied request, it only carries it across.
    expect(forwarded.headers.get("authorization")).toBe("Bearer operator-token");
    await expect(forwarded.json()).resolves.toEqual({ projects: [] });
  });

  it("keeps the query string a read route depends on", async () => {
    const seen: Request[] = [];
    const ingest = stubIngest({
      fetch: vi.fn(async (request: Request) => {
        seen.push(request);
        return new Response("[]");
      }),
    });
    const { request, url } = doorRequest(`${RUNNER_INGEST_PREFIX}/api/serp-panel-landings?asset=northwind.example`);
    await handleRunnerRequest(request, url, ingest);
    expect(new URL(seen[0]!.url).search).toBe("?asset=northwind.example");
  });

  it("answers 404 for a runner path that names no lane", async () => {
    const ingest = stubIngest();
    const { request, url } = doorRequest("/api/runner/nonsense");
    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(404);
    expect(ingest.fetch).not.toHaveBeenCalled();
  });

  it("reports an unreachable ingest as a gateway failure, not a Tower bug", async () => {
    const ingest = stubIngest({
      fetch: vi.fn(async () => {
        throw new Error("Network connection lost.");
      }),
    });
    const { request, url } = doorRequest(`${RUNNER_INGEST_PREFIX}/healthz`);
    const response = await handleRunnerRequest(request, url, ingest);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "ingest_unreachable",
      message: "Network connection lost.",
    });
  });
});
