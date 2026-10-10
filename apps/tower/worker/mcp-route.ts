// POST /api/mcp — the OS's read models, spoken to agents.
//
// 1. Read-only: no dispatch path from here to a write; collection (which spends
//    money) stays behind ingest's lane lock and budget gate.
// 2. Honest nulls: unknown is never flattened to false; builder output passes
//    through untidied.
// 3. One vocabulary: the decision-lane words the Tower shows the operator.
// 4. No new queries: every tool composes an existing builder.
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
import { McpToolError, serveMcp } from "../../../scripts/mcp-protocol.mjs";
import { READ_MODEL_TOOLS } from "../../../scripts/read-model-tools.mjs";

/** The transport, both MCP protocol eras, is shared with the hosted task
 * endpoint (scripts/mcp-protocol.mts). The server is the Tower, so it answers
 * with the Tower Worker's own name (`apps/tower/wrangler.jsonc`) — the
 * product's name, never an asset's id. */
const SERVER_INFO = { name: "noticeos-tower", version: "1.0.0" };
const INSTRUCTIONS =
  "Read models for the properties under management. Start with list_properties.";
/** The stored-read classifier's own bound (scripts/workspace-operations.mts). */
const BODY_BYTES = 256 * 1024;

/** Declared structurally so this file stays free of Workers globals. */
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
  /** config/signal-panels.json `assets`, verbatim. */
  signalPanels: SignalPanelsConfig;
  /** config/value-events.json and config/ga4-custom-dimensions.json `assets`,
   * verbatim, so `property_report` shows the declarations the operator sees. */
  valueEvents: ValueEventsConfig;
  ga4EventParams: Ga4EventParamsConfig;
  /** config/constants.json `os_time_zone` as saved: money days on the
   * operator's clock, as the Wall reads them. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as saved. */
  noNightlyReport?: readonly string[] | null;
  /** config/constants.json `schedules` as saved, as the runner arms them. */
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
  inputSchema: Readonly<Record<string, unknown>>;
  run(
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

const RUNS: Record<string, ToolDefinition["run"]> = {
  async list_properties(store, deps) {
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
        // Reconciled and reported stay apart, as the card shows them: their
        // sum is a number the ledger never booked.
        netPeriod: card.netPeriod,
        booked: card.booked,
        forecast: card.forecast,
      })),
      attention: wall.attention,
    };
  },
  async property_report(store, deps, args) {
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
  async research_lookup(_store, deps, args) {
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
      // Explicit rather than implied by `found`: the agent states its choice.
      guidance:
        prior === null
          ? "Not bought recently. Buy it, then record the purchase via POST /api/research-log on the ingest worker."
          : `Bought ${prior.ageDays} day(s) ago by ${prior.actor} for $${prior.costUsd}. Read the archived answer at ${prior.objectKey ?? "(not archived)"} and say you are reusing it.`,
    };
  },
};
const TOOLS: ToolDefinition[] = READ_MODEL_TOOLS.map((tool) => ({ ...tool, run: RUNS[tool.name]! }));

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

export async function handleMcpRequest(
  request: Request,
  store: WorkspaceStore,
  deps: McpDeps,
  viewer: DemoViewerDescriptor | null = null,
): Promise<Response> {
  return serveMcp(request, {
    info: SERVER_INFO,
    instructions: INSTRUCTIONS,
    // Only tools. Declaring resources or prompts we do not serve would make a
    // client probe for capabilities that answer nothing.
    tools: TOOLS,
    // A failure the caller can act on is an McpToolError, returned as a
    // result with `isError` so a model can read it and correct itself; any
    // other fault is logged by name and never echoed, because its message can
    // carry SQL and binding internals that a model would repeat.
    call: (name, args) => TOOLS.find((tool) => tool.name === name)!.run(store, deps, args),
  }, {
    maxBytes: BODY_BYTES,
    screen: (body) => demoMcpRequestAllowed(viewer, body) ? null
      : Response.json({ error: 'demo_read_only', detail: DEMO_READ_ONLY }, { status: 403, headers: JSON_HEADERS }),
  });
}

/** Exported for the suite: the tool surface, so a test can assert it is whole. */
export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);
