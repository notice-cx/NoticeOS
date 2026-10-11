// /api/mcp with every tool, for an agent on this machine: the standalone
// endpoint (scripts/standalone-mcp.mts), answered here while the stack
// publishes the Tower on this machine's loopback only. A Tower on the network
// keeps the Worker's read-model /api/mcp, and `pnpm os:mcp` serves the rest
// over stdio there. Its own forwarded read-model calls pass through.

import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Connect, Plugin } from "vite";
import { LOCAL_CONNECTION_VARIABLE } from "../../../scripts/database-address.mjs";
import { MCP_PATH, READ_MODELS_HEADER } from "../../../scripts/hosted-mcp.mjs";
import { openStandaloneMcp, STANDALONE_MCP_ORIGIN, type StandaloneMcp } from "../../../scripts/standalone-mcp.mjs";
import { readBody } from "./lane";

/** Whether the stack publishes the Tower on this machine's loopback only (deploy/compose/compose.yaml). */
export function towerOnThisMachineOnly(env: NodeJS.ProcessEnv): boolean {
  return /^127\./u.test(env.NOTICEOS_HOST_TOWER_ADDRESS ?? "");
}

/** Request headers a handler reads; the hop's own framing stays with the hop. */
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

function rpcError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } }));
}

/** The middleware, opening the endpoint on its first call and again after a failed open. */
export function createMcpMiddleware(open: () => Promise<StandaloneMcp>):
  Connect.NextHandleFunction & { close(): Promise<void> } {
  let opened: Promise<StandaloneMcp> | null = null;
  const middleware = (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "";
    if (url.split("?")[0] !== MCP_PATH || req.headers[READ_MODELS_HEADER] !== undefined) {
      next();
      return;
    }
    void (async () => {
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : "";
      if (body === null) { rpcError(res, 413, "the message is too large"); return; }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      let mcp: StandaloneMcp;
      try {
        mcp = await (opened ??= open().catch((error: unknown) => { opened = null; throw error; }));
      } catch {
        rpcError(res, 503, "the installation's database is unavailable; pnpm os:status shows why");
        return;
      }
      const response = await mcp.handle(new Request(STANDALONE_MCP_ORIGIN + url,
        { method, headers, ...(method === "POST" ? { body } : {}) }));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => { if (!res.headersSent) rpcError(res, 500, "the MCP endpoint failed; see the Tower's log"); });
  };
  return Object.assign(middleware, { close: async () => { if (opened) await (await opened.catch(() => null))?.close(); } });
}

export interface McpLaneOptions {
  env?: NodeJS.ProcessEnv;
  /** Opens the endpoint with the Tower's own address for its read models. */
  open?: (tower: string) => Promise<StandaloneMcp>;
}

export function mcpLane({ env = process.env, open }: McpLaneOptions = {}): Plugin {
  return {
    name: "mcp", apply: "serve", enforce: "pre",
    configureServer(server) {
      if (!towerOnThisMachineOnly(env)) return;
      const tower = () => `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo | null)?.port ?? 5173}`;
      const middleware = createMcpMiddleware(() => (open ?? ((address: string) =>
        openStandaloneMcp({ databaseUrl: env[LOCAL_CONNECTION_VARIABLE], tower: address })))(tower()));
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => { void middleware.close(); });
    },
  };
}
