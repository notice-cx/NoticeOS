// The connect panel's second screen: the account's sites, and Start collecting.
//
//   GET  /api/integrations/:provider/sites   — what the connected account lists,
//                                              beside the portfolio's assets and
//                                              their saved mapping (+ the spend
//                                              preview for a metered provider)
//   POST /api/integrations/:provider/collect — run the provider's collect-now
//                                              job step for the confirmed assets
//
// Neither writes a mapping: the panel saves it through `PUT /api/config` before
// asking for the collection, so the run reads the stored mapping like any
// scheduled run. Nothing here holds a secret; ingest alone opens the credential.

import type {
  CollectNowInput,
  CollectNowResult,
  SiteDiscovery,
  SiteSpendPreview,
} from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract";
import type { JsonValue } from "../shared/changeset";
import type { SitesAsset, SitesPayload } from "../shared/site-discovery";
import { LANE_MAPPING } from "../shared/config-registers";
import type { IntegrationsConfig } from "../shared/integrations";
import type { WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/** The two ingest RPCs these routes call (structural, as next door). */
export interface SiteDiscoveryIngest {
  discoverSites(provider: string, originalProof?: Request): Promise<SiteDiscovery>;
  collectNow(input: CollectNowInput, originalProof?: Request): Promise<CollectNowResult>;
}

/** `/api/integrations/:provider/sites` and `…/collect`. */
export const SITES_PATH = /^\/api\/integrations\/([^/]+)\/(sites|collect)$/;

/** At most this many assets in one press: the whole portfolio, with room. */
const COLLECT_MAX_ASSETS = 100;

/**
 * The portfolio's assets as the panel matches them: every non-OS asset that is
 * not retired, with its saved cell for each of the provider's lanes. A missing
 * cell is `null` — the register has no entry, so there is nothing the Data
 * sources tab could write there either. In site-list order.
 *
 * `fieldsOf` names the mapping fields read from each cell: the lane's
 * `LANE_MAPPING` fields, plus whatever the account's sites write there — so a
 * lane whose Data sources row has its own editor (Mediavine's site id) is still
 * read as mapped.
 */
export async function loadSitesAssets(
  store: WorkspaceStore,
  config: IntegrationsConfig,
  lanes: readonly string[],
  fieldsOf: (lane: string) => readonly string[] = (lane) => LANE_MAPPING[lane]?.fields ?? [],
): Promise<SitesAsset[]> {
  const rows = (await readSites(store))
    .filter((site) => site.isOs === 0 && site.status !== "retired")
    .map((site) => ({ id: site.id, label: site.displayName, domain: site.domain, status: site.status }));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    domain: row.domain,
    status: row.status,
    cells: Object.fromEntries(lanes.map((lane) => {
      const cell = config.assets?.[row.id]?.[lane];
      if (!cell) return [lane, null];
      const fields = fieldsOf(lane);
      const mapping: Record<string, string | number> = {};
      for (const field of fields) {
        const value = (cell as unknown as Record<string, unknown>)[field];
        if (typeof value === "string" || typeof value === "number") mapping[field] = value;
      }
      // The note rides along as the guard a Not using from the panel writes
      // against; null when the key is absent.
      const note = (cell as unknown as Record<string, unknown>).note;
      // A saved funnel list (PostHog), as held: the guard picked-up funnels
      // are written against, and never over.
      const funnels = (cell as unknown as Record<string, unknown>).funnels;
      return [lane, {
        status: cell.status,
        note: typeof note === "string" ? note : null,
        mapping,
        ...(LANE_MAPPING[lane]?.lists?.includes("funnels") && Array.isArray(funnels) ? { funnels: funnels as JsonValue } : {}),
      }];
    })),
  }));
}

export async function handleSitesRequest(
  request: Request,
  url: URL,
  deps: {
    ingest: SiteDiscoveryIngest;
    /** The call's store: the site list is read on Postgres. */
    store: WorkspaceStore;
    config: () => Promise<{ integrations: IntegrationsConfig; capUsd: number }>;
    spend: (now: Date, capUsd: number) => Promise<SiteSpendPreview>;
    now?: Date;
  },
  provider: string,
  action: "sites" | "collect",
): Promise<Response> {
  const declared = integrationProvider(provider);
  if (declared === null) return jsonError("provider_not_found", 404, { provider });

  if (action === "sites") {
    if (request.method !== "GET") return jsonError("method_not_allowed", 405);
    let discovery: SiteDiscovery;
    try {
      discovery = await deps.ingest.discoverSites(provider);
    } catch {
      return jsonError("sites_unavailable", 503);
    }
    const { integrations, capUsd } = await deps.config();
    const listed = discovery.ok ? discovery.sites : [];
    const fieldsOf = (lane: string) => [...new Set([
      ...(LANE_MAPPING[lane]?.fields ?? []),
      ...listed.filter((site) => site.lane === lane).flatMap((site) => Object.keys(site.mapping)),
    ])];
    const payload: SitesPayload = {
      discovery,
      assets: await loadSitesAssets(deps.store, integrations, declared.lanes, fieldsOf),
      domainMatch: declared.lanes.filter((lane) => LANE_MAPPING[lane]?.fallback === "domain-match"),
      // Shown before the first paid collection, never after the fact.
      spend: declared.meter?.window === "portfolio-month"
        ? await deps.spend(deps.now ?? new Date(), capUsd).catch(() => null)
        : null,
    };
    return Response.json(payload, { headers: JSON_HEADERS });
  }

  return handleCollectRequest(request, url, deps.ingest, provider);
}

/** Collection has no site-list/config/meter read capability. */
export async function handleCollectRequest(request: Request, url: URL,
  ingest: Pick<SiteDiscoveryIngest, "collectNow">, provider: string): Promise<Response> {
  if (integrationProvider(provider) === null) return jsonError("provider_not_found", 404, { provider });
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  const assets = body && typeof body === "object" && !Array.isArray(body) ? (body as { assets?: unknown }).assets : undefined;
  if (!Array.isArray(assets) || assets.length > COLLECT_MAX_ASSETS || !assets.every((asset) => typeof asset === "string" && asset.length <= 253)) {
    return jsonError("invalid_collect", 422, { field: "assets" });
  }
  let result: CollectNowResult;
  try {
    result = await ingest.collectNow({ provider, assets: assets as string[] });
  } catch {
    return jsonError("collect_failed", 500);
  }
  // A refusal is an answer the panel draws (paused, in flight…), not a fault.
  return Response.json(result, { headers: JSON_HEADERS });
}
