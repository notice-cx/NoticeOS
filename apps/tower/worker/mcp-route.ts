// POST /api/mcp — the OS's read models, spoken to agents (bead ro-cda6.4).
//
// WHY THIS EXISTS. The OS holds richer evidence about these properties than any
// SEO tool the portfolio could buy — the ledger, pre-registered watch windows,
// measurability tiers, the four decision lanes — and none of it was reachable by
// an agent without a person pasting it. Every session that reasoned about a
// property began by re-deriving state the OS already knew, which costs tokens
// and, worse, works from a stale paste rather than from the read model.
//
// FOUR CONSTRAINTS, all load-bearing.
//
// 1. READ-ONLY, and enforced rather than intended. Every tool below is a pure
//    read; there is no dispatch path from here to a write. Collection stays
//    behind `POST /api/signal-collect` on ingest, where the lane lock and the
//    budget gate live — a tool that could spend provider money is a different
//    surface with a different risk profile, and it is not this one.
//
// 2. HONEST NULLS. The tri-state discipline (`aio_present` unknown vs false,
//    "not inside the tracked depth" vs "not ranking") has to survive
//    serialization. A tool that flattened unknown to false would launder
//    exactly the dishonesty the collector was built to prevent, and it would do
//    it at the moment an agent acts on it. The payload builders already carry
//    nulls correctly, so the rule here is simply: pass their output through, do
//    not "tidy" it.
//
// 3. ONE VOCABULARY. Tool output uses the decision-lane words the Tower already
//    shows the operator — act / investigate / protect / wait — because the
//    alternative is an operator and an agent describing one portfolio in two
//    languages.
//
// 4. NO NEW QUERIES. Every tool composes an EXISTING builder. A second query
//    that answered "what did this property earn" slightly differently would be
//    a second truth, and the two would diverge silently.
//
// Hosted requests use fresh evidence.read admission for the selected workspace
// on Tower and every ingest receiver. The fixed demo exposes stored tools only.
// The explicit standalone adapter retains its existing local read surface; a
// private Service Binding is transport, never hosted authority.

import type { TowerConfig } from "./config-source";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import type {
  Ga4EventParamsConfig,
  PullConfigEntry,
  SerpPanelConfig,
  SignalPanelsConfig,
  ValueEventsConfig,
} from "./asset-config";
import { buildAssetDetailPayload } from "./asset-detail-payload";
import type { WorkspaceStore } from "@noticeos/postgres";
import { JSON_HEADERS } from "./http";
import { buildWallPayload } from "./wall-payload";
import type { CountersConfig } from "./counters";
import type { DashboardConfig } from "../shared/dashboard";
import type { IntegrationsConfig } from "../shared/integrations";
import { DEMO_READ_ONLY, demoMcpRequestAllowed, type DemoViewerDescriptor } from '../shared/demo-viewer';

/** JSON-RPC 2.0, the subset MCP's streamable-HTTP transport actually needs. */
const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2025-06-18";
/** The server is the Tower, so it answers with the Tower Worker's own name
 * (`apps/tower/wrangler.jsonc`) — the product's name, never an asset's id. */
const SERVER_INFO = { name: "noticeos-tower", version: "1.0.0" };

/** Standard JSON-RPC error codes, plus MCP's use of -32602 for a bad tool arg. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * The ingest RPC this surface borrows, declared structurally rather than by
 * importing the binding's type, as the annotation route does, so this file
 * stays free of Workers globals and a test can bind a
 * double.
 */
export interface McpIngest {
  researchLookup(query: {
    provider: "dataforseo";
    endpoint: string;
    params: unknown;
    windowDays?: number;
  }, originalProof?: Request): Promise<{
    asset: string | null;
    endpoint: string;
    question: string;
    costUsd: number;
    objectKey: string | null;
    actor: string;
    boughtAt: string;
    ageDays: number;
  } | null>;
}

export interface McpDeps {
  now: Date;
  /** config/constants.json `monthly_caps`, the shape both builders take. */
  monthlyCaps: { dataUsd: number };
  /** config/constants.json `flag_defaults`, verbatim (snake_case keys). */
  flagDefaults: Record<string, number | string>;
  operatorRateUsdPerMin: number;
  counters: CountersConfig;
  integrations: IntegrationsConfig;
  pullConfig: PullConfigEntry[];
  dashboard: DashboardConfig;
  serpPanel: SerpPanelConfig;
  /** config/signal-panels.json `assets`, verbatim — carried for the same reason
   * as `counters`: the asset payload names every config entry that would have to
   * go with the asset (bead `ro-sk7q`). */
  signalPanels: SignalPanelsConfig;
  /** config/value-events.json and config/ga4-custom-dimensions.json `assets`,
   * verbatim — the GA4 declarations the asset payload carries so its Sources
   * tab can edit them (bead `ro-x5gu.3`). An agent reading `property_report`
   * sees the same declarations the operator does. */
  valueEvents: ValueEventsConfig;
  ga4EventParams: Ga4EventParamsConfig;
  /** config/constants.json `os_time_zone` as SAVED, store first (bead
   * `ro-ujb9.88`): an agent reading a property's money days reads them on the
   * operator's clock, exactly as the Wall and the asset page do. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as SAVED (bead `ro-ujb9.96.8`):
   * an agent is told the same assets owe no report as the Wall is. */
  noNightlyReport?: readonly string[] | null;
  /** config/constants.json `schedules` as SAVED (bead `ro-ujb9.96.7.12`): an
   * agent reads a report's schedule as the runner arms it. */
  schedules?: ScheduleOverrides | null;
  /** The private INGEST Service Binding, or null where it is not bound. */
  ingest: McpIngest | null;
}

/** Both entry profiles use the same released read-model configuration. */
export function mcpDependencies(cfg: TowerConfig, ingest: McpIngest | null, now = new Date()): McpDeps {
  return { now, monthlyCaps: cfg.monthlyCaps, flagDefaults: cfg.flagDefaults,
    operatorRateUsdPerMin: cfg.operatorRateUsdPerMin, counters: cfg.counters,
    integrations: cfg.integrations, pullConfig: cfg.pullConfig, dashboard: cfg.dashboard,
    serpPanel: cfg.serpPanel, signalPanels: cfg.signalPanels, valueEvents: cfg.valueEvents,
    ga4EventParams: cfg.ga4EventParams, osTimeZone: cfg.osTimeZone,
    noNightlyReport: cfg.noNightlyReport, schedules: cfg.schedules, ingest };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(
    /** The call's store: the site list is read on Postgres (bead ro-ujb9.76.4.2). */
    store: WorkspaceStore,
    deps: McpDeps,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

function requireAsset(args: Record<string, unknown>): string {
  const asset = args.asset;
  if (typeof asset !== "string" || asset.length === 0) {
    throw new McpToolError("`asset` is required and must be a property id");
  }
  return asset;
}

/** A tool-level failure the caller can act on, as opposed to a server fault. */
class McpToolError extends Error {}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_properties",
    description:
      "Every property under management with its lifecycle status, open-flag severity, and the period's revenue, cost and margin. Start here when you do not know a property's id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(store, deps) {
      const wall = await buildWallPayload(store, wallOptions(deps));
      return {
        generatedAt: wall.generatedAt,
        portfolio: wall.portfolio,
        ledgerRecordedAt: wall.ledgerRecordedAt,
        properties: wall.assets.map((card) => ({
          asset: card.id,
          displayName: card.displayName,
          status: card.status,
          senseOnly: card.senseOnly,
          worstSeverity: card.worstSeverity,
          openError: card.openError,
          openWarn: card.openWarn,
          // Reconciled and reported are kept APART, exactly as the card shows
          // them. Summing them here would hand an agent one number the ledger
          // never booked — the whole point of the split (ro-uwo.2).
          netPeriod: card.netPeriod,
          booked: card.booked,
          forecast: card.forecast,
        })),
        attention: wall.attention,
      };
    },
  },
  {
    name: "property_report",
    description:
      "The full read model behind one property's Tower page: P&L for the period, open flags, signal freshness, the tracked SERP panel with its AI-Overview readings, and the query and page decision lanes (act / investigate / protect / wait). This is the single richest call — prefer it over several narrow ones.",
    inputSchema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Property id, e.g. example.com" },
      },
      required: ["asset"],
      additionalProperties: false,
    },
    async run(store, deps, args) {
      const asset = requireAsset(args);
      const payload = await buildAssetDetailPayload(store, asset, {
        now: deps.now,
        flagDefaults: deps.flagDefaults,
        pullConfig: deps.pullConfig,
        monthlyCaps: deps.monthlyCaps,
        operatorRateUsdPerMin: deps.operatorRateUsdPerMin,
        integrations: deps.integrations,
        counters: deps.counters,
        serpPanel: deps.serpPanel,
        signalPanels: deps.signalPanels,
        valueEvents: deps.valueEvents,
        ga4EventParams: deps.ga4EventParams,
        osTimeZone: deps.osTimeZone,
        noNightlyReport: deps.noNightlyReport,
        schedules: deps.schedules,
      });
      if (payload === null) {
        throw new McpToolError(
          `no property with id ${asset} — call list_properties for the ids in use`,
        );
      }
      return payload;
    },
  },
  {
    name: "research_lookup",
    description:
      "Has this exact provider question already been paid for, and where is the archived answer? Ask BEFORE buying search data. A hit returns the R2 object key and how many days ago it was bought; reuse it and say so rather than re-buying.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description:
            "Provider path without the API base, e.g. dataforseo_labs/google/keyword_overview/live",
        },
        params: {
          type: "object",
          description:
            "The request body exactly as it would be sent. Hashed to identify the question; key order does not matter, array order does.",
        },
        windowDays: {
          type: "number",
          description: "Reuse window; defaults to 30. Use less for volatile reads like a live SERP.",
        },
      },
      required: ["endpoint", "params"],
      additionalProperties: false,
    },
    async run(_store, deps, args) {
      if (deps.ingest === null) {
        throw new McpToolError(
          "the research log is not reachable from this deployment",
        );
      }
      if (typeof args.endpoint !== "string" || args.endpoint.length === 0) {
        throw new McpToolError("`endpoint` is required");
      }
      if (args.params === undefined) {
        // Never defaulted to {}: every caller who omitted it would collide on
        // one hash, and the second would "reuse" an answer to a question it
        // never asked.
        throw new McpToolError(
          "`params` is required — it is what makes this question distinct",
        );
      }
      const prior = await deps.ingest.researchLookup({
        provider: "dataforseo",
        endpoint: args.endpoint,
        params: args.params,
        windowDays:
          typeof args.windowDays === "number" && args.windowDays > 0
            ? args.windowDays
            : undefined,
      });
      return {
        found: prior !== null,
        prior,
        // Said explicitly rather than implied by `found`, because the whole
        // point is that the agent states its choice out loud.
        guidance:
          prior === null
            ? "Not bought recently. Buy it, then record the purchase via POST /api/research-log on the ingest worker."
            : `Bought ${prior.ageDays} day(s) ago by ${prior.actor} for $${prior.costUsd}. Read the archived answer at ${prior.objectKey ?? "(not archived)"} and say you are reusing it.`,
      };
    },
  },
];

function wallOptions(deps: McpDeps) {
  return {
    now: deps.now,
    constants: deps.monthlyCaps,
    integrations: deps.integrations,
    pullConfig: deps.pullConfig,
    dashboard: deps.dashboard,
    serpPanel: deps.serpPanel,
    osTimeZone: deps.osTimeZone,
    noNightlyReport: deps.noNightlyReport,
    counters: deps.counters,
    schedules: deps.schedules,
  };
}

function rpcResult(id: unknown, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result }),
    { headers: JSON_HEADERS },
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } }),
    { headers: JSON_HEADERS },
  );
}

/**
 * A tool failure is a RESULT with `isError`, not a JSON-RPC error — MCP draws
 * that line so a model can read the failure and correct itself, where a
 * transport error would just abort the call.
 */
function toolFailure(id: unknown, message: string): Response {
  return rpcResult(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

export async function handleMcpRequest(
  request: Request,
  store: WorkspaceStore,
  deps: McpDeps,
  viewer: DemoViewerDescriptor | null = null,
): Promise<Response> {
  if (request.method !== "POST") {
    return rpcError(null, INVALID_REQUEST, "MCP requests must be POST");
  }
  let body: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return rpcError(null, PARSE_ERROR, "request body was not valid JSON");
  }
  if (!demoMcpRequestAllowed(viewer, body)) {
    return Response.json({ error: 'demo_read_only', detail: DEMO_READ_ONLY }, { status: 403, headers: JSON_HEADERS });
  }
  const id = body.id ?? null;
  if (body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== "string") {
    return rpcError(id, INVALID_REQUEST, "expected a JSON-RPC 2.0 request");
  }

  switch (body.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        // Only `tools`. Declaring resources or prompts we do not serve would
        // make a client probe for capabilities that answer nothing.
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    // Notifications carry no id and expect no response body; `initialized` is
    // the one every client sends after a successful handshake.
    case "notifications/initialized":
      return new Response(null, { status: 202 });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const params = (body.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof params.name !== "string") {
        return rpcError(id, INVALID_PARAMS, "tools/call needs a tool name");
      }
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) {
        return rpcError(id, METHOD_NOT_FOUND, `no tool named ${params.name}`);
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await tool.run(store, deps, args);
        return rpcResult(id, {
          // `structuredContent` is what a model should read; the text block is
          // the same JSON, because clients that predate structured output would
          // otherwise see an empty result rather than a degraded one.
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (error) {
        if (error instanceof McpToolError) {
          return toolFailure(id, error.message);
        }
        // A genuine fault. The message is not echoed: it can carry SQL and
        // binding internals, and this surface is read by a model that would
        // repeat them.
        console.error("mcp tool failed", params.name);
        return rpcError(
          id,
          INTERNAL_ERROR,
          `tool ${params.name} failed — see the Tower worker log`,
        );
      }
    }

    default:
      return rpcError(id, METHOD_NOT_FOUND, `unsupported method ${body.method}`);
  }
}

/** Exported for the suite: the tool surface, so a test can assert it is whole. */
export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);
