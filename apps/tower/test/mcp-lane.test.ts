import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMcpMiddleware, mcpLane } from "../vite/mcp-lane";

// vite/mcp-lane.ts: /api/mcp with every tool on a standalone Tower, reaching
// whoever reaches the Tower. The tools themselves are proved in
// scripts/standalone-tasks.test.mjs.

function request(url: string, { method = "POST", headers = {}, body = "" }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { url, method, headers });
}
function response() {
  const sent = { status: 0, headers: {} as Record<string, string>, body: "", headersSent: false };
  const res = {
    get statusCode() { return sent.status; }, set statusCode(value: number) { sent.status = value; },
    get headersSent() { return sent.headersSent; },
    setHeader(name: string, value: string) { sent.headers[name] = value; },
    end(chunk?: Buffer | string) { sent.body = chunk ? chunk.toString() : ""; sent.headersSent = true; done(); },
  };
  let done = () => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  return { res, sent, finished };
}
type Middleware = ReturnType<typeof createMcpMiddleware>;
async function serve(middleware: Middleware, req: ReturnType<typeof request>) {
  const { res, sent, finished } = response();
  let passed = false;
  middleware(req as never, res as never, () => { passed = true; });
  if (!passed) await finished;
  return { passed, sent };
}

describe("/api/mcp for an agent on this machine", () => {
  it("is served wherever the Tower is published, as its own pages are, and opens nothing until called", () => {
    const used: unknown[] = [];
    let opened = 0;
    const server = { middlewares: { use: (handler: unknown) => used.push(handler) }, httpServer: null };
    for (const address of ["127.0.0.1", "0.0.0.0", "192.168.1.20"]) {
      (mcpLane({ env: { NOTICEOS_HOST_TOWER_ADDRESS: address }, open: async () => { opened += 1; throw new Error("not opened here"); } })
        .configureServer as (s: unknown) => void)(server);
    }
    expect([used.length, opened]).toEqual([3, 0]);
  });

  it("hands each message to the endpoint as the agent sent it, and passes other paths and its own read-model calls on", async () => {
    const seen: Request[] = [];
    let opens = 0;
    const middleware = createMcpMiddleware(async () => {
      opens += 1;
      return { close: async () => {}, handle: async (req: Request) => { seen.push(req); return Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "cache-control": "no-store" } }); } };
    });
    expect((await serve(middleware, request("/api/tasks"))).passed).toBe(true);
    expect((await serve(middleware, request("/api/mcp", { headers: { "x-noticeos-mcp-part": "read-models" } }))).passed).toBe(true);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const { sent } = await serve(middleware, request("/api/mcp", { body,
      headers: { host: "localhost:5180", "content-type": "application/json", "x-noticeos-actor": "claude", "content-length": String(body.length) } }));
    expect([sent.status, sent.body, sent.headers["cache-control"]]).toEqual([200, '{"jsonrpc":"2.0","id":1,"result":{}}', "no-store"]);
    expect(seen[0]!.url).toBe("http://localhost/api/mcp");
    expect([seen[0]!.headers.get("x-noticeos-actor"), seen[0]!.headers.get("host"), await seen[0]!.text()]).toEqual(["claude", null, body]);
    await serve(middleware, request("/api/mcp", { body }));
    expect(opens).toBe(1);
  });

  it("says the database is unavailable when the endpoint cannot open, and opens again on the next call", async () => {
    let attempts = 0;
    const middleware = createMcpMiddleware(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("PRIVATE-SENTINEL");
      return { close: async () => {}, handle: async () => Response.json({ ok: true }) };
    });
    const first = await serve(middleware, request("/api/mcp", { body: "{}" }));
    expect(first.sent.status).toBe(503);
    expect(first.sent.body).toMatch(/database is unavailable; pnpm os:status shows why/u);
    expect(first.sent.body).not.toMatch(/PRIVATE-SENTINEL/u);
    expect((await serve(middleware, request("/api/mcp", { body: "{}" }))).sent.status).toBe(200);
    expect((await serve(middleware, request("/api/mcp", { body: "x".repeat(300 * 1024) }))).sent.status).toBe(413);
  });
});
