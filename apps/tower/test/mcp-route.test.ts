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
import { writeRevenue } from "./money";
import { writeSignalRun } from "./collected-metrics";

const NOW = new Date("2026-09-15T12:00:00.000Z");

// Synthetic documents in the shapes the config files carry, never the
// checkout's own config/. One seeded asset declares something in every
// document, so `property_report` reads each.
const INTEGRATIONS: IntegrationsConfig = {
  catalog: [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" },
    { id: "ad-network", label: "Ad network reporting", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" },
  ],
  assets: {
    "meadow.example": {
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
    counters: { assets: { "meadow.example": { cards: [{ metric: "signups", counter: "profiles", label: "Accounts" }] } } },
    integrations: INTEGRATIONS,
    pullConfig: [{ asset: "meadow.example", url: "https://meadow.example/api/internal/metrics", enabled: true, format: "prometheus", metrics: { signups: { counter: "profiles" } } }],
    dashboard: { widgets: [] } as unknown as DashboardConfig,
    serpPanel: { assets: { "meadow.example": { queries: ["meadow"] } } },
    signalPanels: { assets: { "meadow.example": { enabled: true, reason: "live-lanes", note: "Synthetic.", since: "2026-09-01" } } },
    valueEvents: { assets: { "meadow.example": { valueEvents: ["sign_up"] } } },
    ga4EventParams: { assets: { "meadow.example": { eventParams: ["source"] } } },
    osTimeZone: "America/Los_Angeles",
    ingest,
    ...overrides,
  };
}

let ctx: TestStore;
let ingest: McpIngest & { researchLookup: ReturnType<typeof vi.fn> };

/** `id: null` sends a notification, which carries no id at all. */
function rpc(method: string, params?: unknown, id: unknown = 1): Request {
  return new Request("https://tower.local/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
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
    const { body } = await call("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(body.result).toMatchObject({
      protocolVersion: "2025-06-18",
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
      rpc("notifications/initialized", undefined, null),

      ctx.call,
      deps(),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("refuses anything that is not JSON-RPC 2.0", async () => {
    for (const contentType of ["application/json", "text/plain"]) {
      const res = await handleMcpRequest(
        new Request("https://tower.local/api/mcp", {
          method: "POST",
          headers: { "content-type": contentType },
          body: JSON.stringify(contentType === "text/plain"
            ? { jsonrpc: "2.0", id: 1, method: "tools/list" } : { method: "tools/list" }) }),

        ctx.call,
        deps(),
      );
      // A text/plain POST is the one a page elsewhere can send without asking.
      expect(res.status).toBe(contentType === "text/plain" ? 415 : 400);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
        -32600,
      );
    }
  });

  it("answers an older client with no handshake", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = (method: string, params: Record<string, unknown> = {}) =>
      handleMcpRequest(new Request("https://tower.local/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28",
          "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }), ctx.call, deps());
    const discovered = (await (await modern("server/discover")).json()) as { result: Record<string, unknown> };
    expect(discovered.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "noticeos-tower" } } });
    const listed = (await (await modern("tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    const called = (await (await modern("tools/call", { name: "list_properties", arguments: {} })).json()) as {
      result: { resultType: string; structuredContent: { properties: unknown[] } } };
    expect(called.result.resultType).toBe("complete");
    expect(called.result.structuredContent.properties.length).toBeGreaterThan(0);
  });

  it("refuses a GET — this transport is POST-only", async () => {
    const res = await handleMcpRequest(
      new Request("https://tower.local/api/mcp"),

      ctx.call,
      deps(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
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

  /** Reconciled and reported are different claims; an agent handed one
   * summed number would be quoting money the ledger never booked. */
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
    const expected = await buildAssetDetailPayload(ctx.call, "meadow.example", deps());
    const { body } = await call("tools/call", {
      name: "property_report",
      arguments: { asset: "meadow.example" },
    });
    const result = (body.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect((result.asset as { id: string }).id).toBe("meadow.example");
    expect(result).toHaveProperty("ledger");
    expect(result).toHaveProperty("flags");
    expect(result).toHaveProperty("performance");
    expect(result).not.toHaveProperty("laterPhase");
    expect(result).toEqual(JSON.parse(JSON.stringify(expected)));
    const content = (body.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual(result);
  });

  /** A tool failure is a result with `isError`, not a JSON-RPC error, so a
   * model can read the failure and correct itself. */
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
    expect(body.error).toMatchObject({ code: -32602 });
  });
});

describe("the MCP surface — revenue by source and traffic by provider", () => {
  /** Synthetic days, `first`..`last`, one a day. */
  function days(first: string, last: string): string[] {
    const out: string[] = [];
    for (let date = first; date <= last; date = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(date);
    return out;
  }

  /** Mediavine Journey from Aug 20 and a second Mediavine account from Sep 10,
   * both through yesterday (Sep 14 on Mediavine's clock), and a GA4 and a
   * Search Console run whose newest day is still provisional. */
  async function seedMeadow(): Promise<void> {
    await writeRevenue(ctx.call, [
      ...days("2026-08-20", "2026-09-14").map((date) => ({ asset: "meadow.example", account: "mv-meadow", date, amountMinor: 100, run: "mv-run" })),
      ...days("2026-09-10", "2026-09-14").map((date) => ({ asset: "meadow.example", source: "mediavine", account: "mv-second", date, amountMinor: 50, run: "mv-run-2" })),
    ]);
    const traffic = days("2026-08-18", "2026-09-14");
    await writeSignalRun(ctx.call, { id: "ga4-run", asset: "meadow.example", integration: "ga4", finishedAt: "2026-09-15T06:00:00Z",
      windowStart: traffic[0], windowEnd: "2026-09-14", provisionalFrom: "2026-09-14" },
    traffic.flatMap((date) => [{ date, metric: "sessions", value: 10 }, { date, metric: "active_users", value: 8 }]));
    await writeSignalRun(ctx.call, { id: "gsc-run", asset: "meadow.example", integration: "gsc", finishedAt: "2026-09-15T06:00:00Z",
      windowStart: traffic[0], windowEnd: "2026-09-14" }, traffic.map((date) => ({ date, metric: "clicks", value: 3 })));
  }

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const { body } = await call("tools/call", { name, arguments: args });
    return body.result as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
  }

  it("lists each property's last 28 days: revenue per named source and traffic per named provider", async () => {
    await seedMeadow();
    const result = await tool("list_properties");
    const meadow = (result.structuredContent.properties as Record<string, unknown>[]).find((property) => property.asset === "meadow.example")!;
    expect(meadow.yesterdayRevenue).toEqual({ date: "2026-09-14", amountMinor: 150, reportedThrough: "2026-09-14",
      timeZone: "America/Los_Angeles", timeZoneLabel: "Pacific" });
    const { revenue, traffic } = meadow.last28Days as {
      revenue: Record<string, unknown> & { bySource: Record<string, unknown>[] };
      traffic: Record<string, unknown>[];
    };
    expect(revenue).toMatchObject({ from: "2026-08-18", to: "2026-09-14", clock: { timeZone: "America/Los_Angeles", label: "Pacific" },
      currency: "USD", totalMinor: 2850, daysReported: 26, partialDays: 0 });
    expect(revenue.bySource.map(({ source, displayName, provider, family, totalMinor, daysReported }) =>
      ({ source, displayName, provider, family, totalMinor, daysReported }))).toEqual([
      { source: "mediavine", displayName: "Mediavine ad revenue", provider: "mediavine", family: "ads", totalMinor: 250, daysReported: 5 },
      { source: "mediavine-journey", displayName: "Mediavine Journey ad revenue", provider: "mediavine", family: "ads", totalMinor: 2600, daysReported: 26 },
    ]);
    const series = (integration: string, metric: string) => traffic.find((item) => item.integration === integration && item.metric === metric);
    // Sessions add; the provisional newest day is counted apart.
    expect(series("ga4", "sessions")).toMatchObject({ source: "Google Analytics 4", unit: "count", additive: true,
      from: "2026-08-18", to: "2026-09-14", settledDays: 27, provisionalDays: 1, total: 270, provisionalFrom: "2026-09-14" });
    // People never add across days; their daily average stands in.
    expect(series("ga4", "active_users")).toMatchObject({ additive: false, total: null, dailyAverage: 8 });
    expect(series("gsc", "clicks")).toMatchObject({ source: "Google Search Console", additive: true, total: 84, provisionalDays: 0 });
    // A property with no source and no collection lists nothing, never zeros.
    const quiet = (result.structuredContent.properties as Record<string, unknown>[]).find((property) => property.asset !== "meadow.example")!;
    const quietDays = quiet.last28Days as { revenue: { bySource: unknown[]; totalMinor: unknown }; traffic: unknown[] };
    expect([quietDays.revenue.bySource, quietDays.revenue.totalMinor, quietDays.traffic]).toEqual([[], null, []]);
  });

  it("returns a property's days by source, its accounting months by source and booking state, and each traffic series", async () => {
    await seedMeadow();
    const result = await tool("property_history", { asset: "meadow.example", days: 7, months: 2 });
    expect(result.isError).toBeUndefined();
    const [meadow] = result.structuredContent.properties as {
      asset: string;
      revenue: { from: string; to: string; days: unknown[]; partialDates: string[]; months: Record<string, unknown>[];
        bySource: { source: string; since: string; reportedThrough: string; days: unknown[]; clock: Record<string, unknown> }[] };
      traffic: { days: number; series: { integration: string; metric: string; days: { date: string; value: number }[] }[] };
    }[];
    expect(meadow!.asset).toBe("meadow.example");
    expect([meadow!.revenue.from, meadow!.revenue.to, meadow!.revenue.days.length, meadow!.revenue.partialDates])
      .toEqual(["2026-09-08", "2026-09-14", 7, []]);
    expect(meadow!.revenue.bySource.map((source) => [source.source, source.since, source.reportedThrough, source.days.length, source.clock.label]))
      .toEqual([["mediavine", "2026-09-10", "2026-09-14", 5, "Pacific"], ["mediavine-journey", "2026-08-20", "2026-09-14", 7, "Pacific"]]);
    expect(meadow!.revenue.months).toEqual([
      { period: "2026-08", source: "mediavine-journey", sourceName: "Mediavine Journey ad revenue", family: "ads", currency: "USD",
        bookingState: "estimated", amountMinor: 1200, entries: 1 },
      { period: "2026-09", source: "mediavine", sourceName: "Mediavine ad revenue", family: "ads", currency: "USD",
        bookingState: "estimated", amountMinor: 250, entries: 1 },
      { period: "2026-09", source: "mediavine-journey", sourceName: "Mediavine Journey ad revenue", family: "ads", currency: "USD",
        bookingState: "estimated", amountMinor: 1400, entries: 1 },
    ]);
    const sessions = meadow!.traffic.series.find((item) => item.integration === "ga4" && item.metric === "sessions")!;
    expect(sessions.days.map((day) => day.date)).toEqual(days("2026-09-08", "2026-09-14"));
    expect(meadow!.traffic.days).toBe(7);
  });

  it("returns every property when no asset is named", async () => {
    await seedMeadow();
    const listed = (await tool("list_properties")).structuredContent.properties as unknown[];
    const result = await tool("property_history", { months: 0 });
    const properties = result.structuredContent.properties as { asset: string; revenue: Record<string, unknown> }[];
    expect(properties.length).toBeGreaterThanOrEqual(listed.length);
    expect(properties.every((property) => !("months" in property.revenue))).toBe(true);
  });

  it("refuses days, months or a property out of range as a correctable error", async () => {
    for (const args of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { months: -1 }, { months: 121 }, { asset: "does.not.exist" }]) {
      const result = await tool("property_history", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
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
      asset: "meadow.example",
      endpoint: "dataforseo_labs/google/keyword_overview/live",
      question: "keyword overview, 1 term",
      costUsd: 0.02,
      objectKey: "raw/dataforseo/meadow.example/2026-09-06/x.json.gz",
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
    // The reuse has to be sayable out loud: a silent skip is
    // indistinguishable from forgetting to make the call.
    expect(result.guidance).toContain("9 day(s) ago");
    expect(result.guidance).toContain("claude-opus-5");
    expect(result.guidance).toContain("reusing");
  });

  /** Defaulting `params` to `{}` would make every caller who omitted it
   * collide on one hash. */
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

/** Collection spends real money behind a lane lock and a budget gate;
 * nothing here may reach it. */
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
    // Every table a tool could have written to.
    const countRows = async () =>
      ((await (ctx.call).read((tx) =>
        tx.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM noticeos.assets) + (SELECT count(*) FROM noticeos.ledger_entries) + (SELECT count(*) FROM noticeos.revenue_observations)
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
            : { asset: "meadow.example" },
      });
    }
    expect(await countRows()).toBe(before);
  });
});
