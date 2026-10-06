// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_TOOL_NAMES,
  handleMcpRequest,
  type McpDeps,
  type McpIngest,
} from "../worker/mcp-route";
import { createTestStore, type TestStore } from "./postgres-store";
import { seedAssets } from "./invented-sites";
import type { IntegrationsConfig } from "../shared/integrations";
import type { DashboardConfig } from "../shared/dashboard";
import { buildAssetDetailPayload } from "../worker/asset-detail-payload";

const NOW = new Date("2026-09-15T12:00:00.000Z");

// Synthetic documents in the shapes the config files carry, never the
// checkout's own config/ (bead ro-ujb9.92): what this suite proves about the
// MCP surface must not move when an operator saves a setting. One seeded asset
// declares something in every document, so `property_report` reads each.
const INTEGRATIONS: IntegrationsConfig = {
  catalog: [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" },
    { id: "ad-network", label: "Ad network reporting", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" },
  ],
  assets: {
    "meals.example": {
      gsc: { status: "live", note: "synthetic", since: "2026-09-01" },
      "ad-network": { status: "needs-setup", note: "synthetic", since: "2026-09-01" },
    },
  },
};

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    now: NOW,
    monthlyCaps: { dataUsd: 25 },
    flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
    operatorRateUsdPerMin: 2,
    counters: { assets: { "meals.example": { cards: [{ metric: "signups", counter: "profiles", label: "Accounts" }] } } },
    integrations: INTEGRATIONS,
    pullConfig: [{ asset: "meals.example", url: "https://meals.example/api/internal/metrics", enabled: true, format: "prometheus", metrics: { signups: { counter: "profiles" } } }],
    dashboard: { widgets: [] } as unknown as DashboardConfig,
    serpPanel: { assets: { "meals.example": { queries: ["meals"] } } },
    signalPanels: { assets: { "meals.example": { enabled: true, reason: "live-lanes", note: "Synthetic.", since: "2026-09-01" } } },
    valueEvents: { assets: { "meals.example": { valueEvents: ["sign_up"] } } },
    ga4EventParams: { assets: { "meals.example": { eventParams: ["source"] } } },
    osTimeZone: "America/Los_Angeles",
    ingest,
    ...overrides,
  };
}

let ctx: TestStore;
let ingest: McpIngest & { researchLookup: ReturnType<typeof vi.fn> };

function rpc(method: string, params?: unknown, id: unknown = 1): Request {
  return new Request("https://tower.local/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function call(
  method: string,
  params?: unknown,
  overrides?: Partial<McpDeps>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleMcpRequest(rpc(method, params), ctx.call, deps(overrides));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  ctx = await createTestStore();
  await seedAssets(ctx);
  ingest = { researchLookup: vi.fn().mockResolvedValue(null) };
});

describe("the MCP surface — handshake", () => {
  it("declares only the capability it serves", async () => {
    const { body } = await call("initialize");
    expect(body.result).toMatchObject({
      protocolVersion: expect.any(String),
      serverInfo: { name: "noticeos-tower" },
    });
    // Advertising resources or prompts we do not serve would make a client
    // probe for capabilities that answer nothing.
    expect(Object.keys((body.result as { capabilities: object }).capabilities)).toEqual([
      "tools",
    ]);
  });

  it("acknowledges the initialized notification without a body", async () => {
    const res = await handleMcpRequest(
      rpc("notifications/initialized", undefined, undefined),

      ctx.call,
      deps(),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("refuses anything that is not JSON-RPC 2.0", async () => {
    const res = await handleMcpRequest(
      new Request("https://tower.local/api/mcp", {
        method: "POST",
        body: JSON.stringify({ method: "tools/list" }) }),

      ctx.call,
      deps(),
    );
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
      -32600,
    );
  });

  it("refuses a GET — this transport is POST-only", async () => {
    const res = await handleMcpRequest(
      new Request("https://tower.local/api/mcp"),

      ctx.call,
      deps(),
    );
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
      -32600,
    );
  });

  it("names an unknown method rather than failing silently", async () => {
    const { body } = await call("resources/list");
    expect(body.error).toMatchObject({ code: -32601 });
  });
});

describe("the MCP surface — tools", () => {
  it("lists every tool with a schema a model can fill in", async () => {
    const { body } = await call("tools/list");
    const tools = (body.result as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("answers what the portfolio holds and what it earned", async () => {
    const { body } = await call("tools/call", { name: "list_properties" });
    const result = (body.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(Array.isArray(result.properties)).toBe(true);
    expect((result.properties as { asset: string }[]).length).toBeGreaterThan(0);
    expect(result).toHaveProperty("portfolio");
  });

  /**
   * The split docs/00 turns on: reconciled and reported are different claims,
   * and an agent handed one summed number would be quoting money the ledger
   * never booked.
   */
  it("keeps booked and forecast apart, never summed", async () => {
    const { body } = await call("tools/call", { name: "list_properties" });
    const properties = (
      (body.result as { structuredContent: { properties: Record<string, unknown>[] } })
        .structuredContent
    ).properties;
    for (const property of properties) {
      expect(property).toHaveProperty("booked");
      expect(property).toHaveProperty("forecast");
      expect(property).not.toHaveProperty("net");
      expect(property).not.toHaveProperty("total");
    }
  });

  it("returns a property's whole read model, decision lanes included", async () => {
    const expected = await buildAssetDetailPayload(ctx.call, "meals.example", deps());
    const { body } = await call("tools/call", {
      name: "property_report",
      arguments: { asset: "meals.example" },
    });
    const result = (body.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect((result.asset as { id: string }).id).toBe("meals.example");
    // The evidence an agent came for: money, flags, and the decision lanes.
    expect(result).toHaveProperty("ledger");
    expect(result).toHaveProperty("flags");
    expect(result).toHaveProperty("performance");
    expect(result).not.toHaveProperty("laterPhase");
    expect(result).toEqual(JSON.parse(JSON.stringify(expected)));
    const content = (body.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual(result);
  });

  /**
   * A tool failure is a RESULT with `isError`, not a JSON-RPC error. MCP draws
   * that line so a model can read the failure and correct itself, where a
   * transport error would just abort the call — and "you used the wrong
   * property id" is exactly the kind of thing a model should be able to fix.
   */
  it("reports an unknown property as a correctable tool error", async () => {
    const { body } = await call("tools/call", {
      name: "property_report",
      arguments: { asset: "does.not.exist" },
    });
    expect(body.error).toBeUndefined();
    const result = body.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("list_properties");
  });

  it("reports a missing required argument the same way", async () => {
    const { body } = await call("tools/call", { name: "property_report" });
    expect((body.result as { isError: boolean }).isError).toBe(true);
  });

  it("rejects a call to a tool that does not exist", async () => {
    const { body } = await call("tools/call", { name: "delete_everything" });
    expect(body.error).toMatchObject({ code: -32601 });
  });
});

describe("the MCP surface — the research log", () => {
  it("tells an agent to buy when nothing was bought", async () => {
    const { body } = await call("tools/call", {
      name: "research_lookup",
      arguments: {
        endpoint: "dataforseo_labs/google/keyword_overview/live",
        params: { keywords: ["dri calculator"] } } });
    const result = (
      body.result as { structuredContent: { found: boolean; guidance: string } }
    ).structuredContent;
    expect(result.found).toBe(false);
    expect(result.guidance).toContain("record the purchase");
  });

  it("names the age, the spender and the archive key on a hit", async () => {
    ingest.researchLookup.mockResolvedValue({
      asset: "meals.example",
      endpoint: "dataforseo_labs/google/keyword_overview/live",
      question: "keyword overview, 1 term",
      costUsd: 0.02,
      objectKey: "raw/dataforseo/meals.example/2026-09-06/x.json.gz",
      actor: "claude-opus-5",
      boughtAt: "2026-09-06T10:00:00.000Z",
      ageDays: 9,
    });
    const { body } = await call("tools/call", {
      name: "research_lookup",
      arguments: {
        endpoint: "dataforseo_labs/google/keyword_overview/live",
        params: { keywords: ["dri calculator"] } } });
    const result = (
      body.result as { structuredContent: { found: boolean; guidance: string } }
    ).structuredContent;
    expect(result.found).toBe(true);
    // The reuse has to be sayable out loud — a silent skip is
    // indistinguishable from forgetting to make the call.
    expect(result.guidance).toContain("9 day(s) ago");
    expect(result.guidance).toContain("claude-opus-5");
    expect(result.guidance).toContain("reusing");
  });

  /**
   * Defaulting `params` to `{}` would make every caller who omitted it collide
   * on one hash, and the second would "reuse" an answer to a question it never
   * asked.
   */
  it("refuses a lookup with no params rather than guessing the question", async () => {
    const { body } = await call("tools/call", {
      name: "research_lookup",
      arguments: { endpoint: "dataforseo_labs/google/keyword_overview/live" },
    });
    expect((body.result as { isError: boolean }).isError).toBe(true);
    expect(ingest.researchLookup).not.toHaveBeenCalled();
  });

  it("says so plainly when the log is not reachable", async () => {
    const { body } = await call(
      "tools/call",
      {
        name: "research_lookup",
        arguments: { endpoint: "x/live", params: {} },
      },
      { ingest: null },
    );
    expect((body.result as { isError: boolean }).isError).toBe(true);
  });
});

/**
 * The constraint that makes this surface safe to point an agent at. Collection
 * spends real money behind a lane lock and a budget gate; nothing here may
 * reach it.
 */
describe("the MCP surface is read-only", () => {
  it("offers no tool that writes, spends, or collects", async () => {
    const { body } = await call("tools/list");
    const tools = (body.result as { tools: { name: string; description: string }[] }).tools;
    const forbidden =
      /\b(create|update|delete|write|insert|collect|run|spend|buy|purchase|resolve|close)\b/i;
    for (const tool of tools) {
      expect(tool.name).not.toMatch(forbidden);
    }
  });

  it("leaves the store untouched after every tool runs", async () => {
    // D1's tables, and the money ledger, Mediavine's revenue, the item
    // dispositions, the alerts and the changes on Postgres (beads
    // ro-ujb9.76.6.1, ro-ujb9.76.5.5, ro-ujb9.76.5.8, ro-ujb9.76.5.2,
    // ro-ujb9.76.5.7).
    const countRows = async () =>
      ((await (ctx.call).read((tx) =>
        tx.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM noticeos.assets) + (SELECT count(*) FROM noticeos.ledger_entries) + (SELECT count(*) FROM noticeos.mediavine_daily)
                  + (SELECT count(*) FROM noticeos.mediavine_runs)
                  + (SELECT count(*) FROM noticeos.item_dispositions) + (SELECT count(*) FROM noticeos.flags)
                  + (SELECT count(*) FROM noticeos.annotations))::int AS n`,
        ),
      ))[0]?.n ?? 0);

    const before = await countRows();
    for (const name of MCP_TOOL_NAMES) {
      await call("tools/call", {
        name,
        arguments:
          name === "research_lookup"
            ? { endpoint: "x/live", params: {} }
            : { asset: "meals.example" },
      });
    }
    expect(await countRows()).toBe(before);
  });
});
