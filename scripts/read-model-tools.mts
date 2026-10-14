/** The read-model MCP tools: what they are called, what
 * they answer and the arguments they take. The Tower Worker runs them
 * (apps/tower/worker/mcp-route.ts); the hosted MCP endpoint lists them with
 * the task tools (scripts/hosted-mcp.mts). One derivation for both. */
export interface ReadModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export const READ_MODEL_TOOLS: readonly ReadModelTool[] = Object.freeze([
  {
    name: "list_properties",
    description:
      "Every property under management with its lifecycle status, open-flag severity, the period's booked and forecast revenue, cost and margin, and its last 28 days in totals: daily revenue by source (each named, with its provider and family) and traffic by provider and metric. Start here when you do not know a property's id; call property_history for the days behind the totals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "property_history",
    description:
      "Revenue and traffic day by day for one property, or for every property when asset is omitted. Revenue: each day's figures per source from the revenue ledger (the source's name, provider, family, currency, first and last reported day, and the clock its days are counted on), their daily sum, the days a source missed, and accounting months by source and booking state (estimated or reconciled). Traffic: each provider's daily series (GA4 sessions, users, page views and events; Search Console and Bing clicks and impressions; Search Console CTR and position) with its unit, whether days add up, when it was collected and the first provisional day. A missing day is unknown, never zero.",
    inputSchema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Property id, e.g. example.com. Omit for every property." },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description: "Days of daily revenue and traffic, ending yesterday on each source's clock; default 28.",
        },
        months: {
          type: "integer",
          minimum: 0,
          maximum: 120,
          description: "Accounting months of revenue by source, the current one included; default 12, 0 for none.",
        },
      },
      additionalProperties: false,
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
  },
]);
export const READ_MODEL_TOOL_NAMES: readonly string[] = Object.freeze(READ_MODEL_TOOLS.map(tool => tool.name));
