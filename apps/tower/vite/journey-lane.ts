import type { Connect, Plugin } from "vite";
import { createJourneyManagement, type JourneyManagementSource } from "../../../scripts/journey-management.mjs";
import { configStoreRequest, readConfigSnapshot } from "../../../scripts/config-store-client.mjs";
import { doorConfigStore, handleConfigRequest, type ConfigWriteLaneOptions } from "./config-write-lane";
import { crossOrigin, isJson, laneMiddleware, type LaneRequest, type LaneReply } from "./lane";

const ROUTE = /^\/api\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,252})\/journeys(?:\/([A-Za-z][A-Za-z0-9_-]{0,59}))?$/u;

export function journeyRoute(target: string): { asset: string; journeyId: string | null } | null {
  const match = ROUTE.exec(target);
  return match ? { asset: match[1]!, journeyId: match[2] ?? null } : null;
}

/** The local operator's existing config writer retains validation, history and export. */
export function localJourneySource(config: ConfigWriteLaneOptions = {}): JourneyManagementSource {
  return {
    async read(asset) {
      const [documents, response] = await Promise.all([
        readConfigSnapshot(),
        configStoreRequest("api/asset-state", { params: { asset } }),
      ]);
      if (response.status !== 200) throw new Error("Asset settings are unavailable.");
      const state = response.body;
      if (state === null || typeof state !== "object" || typeof (state as { known?: unknown }).known !== "boolean") {
        throw new Error("Asset settings are unavailable.");
      }
      const document = documents.get("config/value-events.json");
      return { known: (state as { known: boolean }).known, document: document ? { version: document.version, body: document.body } : null };
    },
    async apply(input) {
      return handleConfigRequest({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, {
        ...config, store: config.store ?? doorConfigStore(),
      });
    },
  };
}

export interface JourneyLaneOptions {
  source: JourneyManagementSource;
}

export function journeyRequestHandler({ source }: JourneyLaneOptions): (request: LaneRequest) => Promise<LaneReply> {
  const management = createJourneyManagement(source);
  return async (request) => {
    const route = journeyRoute(request.url ?? "");
    if (!route) return { status: 404, body: { error: "not_found" } };
    if (crossOrigin(request.headers)) return { status: 403, body: { error: "forbidden" } };
    if (request.method === "GET" && route.journeyId === null) return management.get(route.asset);
    if (request.method !== "PUT" || route.journeyId === null) return { status: 405, body: { error: "method_not_allowed" } };
    if (!isJson(request.headers)) return { status: 415, body: { error: "unsupported_media_type" } };
    let parsed: unknown;
    try { parsed = JSON.parse(request.body); }
    catch { return { status: 400, body: { error: "bad_request" } }; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as { journey?: { id?: unknown } }).journey?.id !== route.journeyId) {
      return { status: 422, body: { error: "invalid_journey", detail: "The journey id must match its URL." } };
    }
    return management.save(route.asset, parsed);
  };
}

export function journeyMiddleware(options: JourneyLaneOptions): Connect.NextHandleFunction {
  return laneMiddleware({
    matches: (pathname) => /^\/api\/assets\/[^/]+\/journeys(?:\/[^/]+)?$/u.test(pathname),
    handle: journeyRequestHandler(options),
    failure: "journey_settings_unavailable",
  });
}

/** Mounted only by the standalone operator's server, beside its config writer. */
export function journeyLane(): Plugin {
  return {
    name: "noticeos:journey-management", enforce: "pre", apply: "serve",
    configureServer(server) {
      server.middlewares.use(journeyMiddleware({ source: localJourneySource({ log: (line) => server.config.logger.info(`  [journeys] ${line}`) }) }));
    },
  };
}
