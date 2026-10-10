import { buildAssetDetailPayload, buildAssetDetailView } from "./asset-detail-payload";
import { isAssetDetailView } from "../shared/asset-detail-views";
/** One payload dispatcher for stored reads in standalone and hosted profiles.
 * Its dependencies cannot call providers, mutate configuration or run tasks. */
import type { WorkspaceStore } from '@noticeos/postgres';
import { timeZoneEverSaved, type TowerConfig } from './config-source';
import { JSON_HEADERS, jsonError } from './http';
import { handleAlertHistoryRequest } from "./alert-history";
import { handleAlertRuleStatsRequest } from "./alert-rules";
import { timeZoneChosen } from "@noticeos/contract/time-zone-setting";
import { PeriodNotFound, buildFinancialsPayload } from "./financials-payload";
import { buildIntegrationsMatrix, integrationsDeps } from "./integrations-payload";
import { buildSettingsPayload } from "./settings-payload";
import { buildWallPayload } from "./wall-payload";
import { handleWallFeedRequest } from "./wall-feed";
import { buildTaskBoard, buildTaskSourcePayload } from "./task-source";
import { PERIOD_PATTERN } from "../shared/financials";

export async function handleStoredRead(request: Request, {
  store, config, compiledTimeZone,
}: { store: WorkspaceStore; config: () => Promise<TowerConfig>; compiledTimeZone: string }): Promise<Response | null> {
  const url = new URL(request.url);
  // What already closed, across the portfolio: a paged archive, kept out of
  // the Wall's 60-second poll.
  if (url.pathname === "/api/alerts/history") {
    return handleAlertHistoryRequest(request, url, store, { now: new Date() });
  }

  // What each rule has cost over the last quarter (alert-rules.ts).
  if (url.pathname === "/api/alerts/rules") {
    return handleAlertRuleStatsRequest(request, store, { now: new Date() });
  }

  // The portfolio's accounting, in full; the Wall's ROI card links here.
  if (url.pathname === "/api/financials") {
    // `?period=YYYY-MM` makes a month a link. Absent, the payload picks the
    // latest month with rows.
    const requestedPeriod = url.searchParams.get("period");
    // Both refusals carry the months that exist, so a dead bookmark lands on
    // a list of live months; a mistyped month and a missing one are one case.
    const malformed =
      requestedPeriod !== null && !PERIOD_PATTERN.test(requestedPeriod);
    const cfg = await config();
    try {
      const payload = await buildFinancialsPayload(store, {
        now: new Date(),
        domainOrders: cfg.domainOrders,
        recurringCosts: cfg.recurringCosts,
        period: malformed ? null : requestedPeriod,
        osTimeZone: cfg.osTimeZone,
      });
      if (malformed) {
        return jsonError("period_malformed", 400, { periods: payload.periods });
      }
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      // A well-formed month the ledger has nothing for is a miss, not a failure.
      if (err instanceof PeriodNotFound) {
        return jsonError("period_not_found", 404, { periods: err.periods });
      }
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: "financials_assembly_failed", message }),
        { status: 500, headers: JSON_HEADERS },
      );
    }
  }

  // Every portfolio-wide knob on one page. The pure builder
  // receives resolved store-first configuration, with compiled fallbacks, and
  // the bounded clock-selection read below. Missing evidence keeps the clock
  // chosen instead of inventing a proposal.
  if (url.pathname === "/api/settings") {
    const cfg = await config();
    // The one store read here, and a total one: an unanswered read leaves the
    // clock "chosen", so nothing is proposed.
    const everSaved = await timeZoneEverSaved(store);
    const payload = buildSettingsPayload({
      now: new Date(),
      osTimeZone: cfg.osTimeZone,
      timeZoneChosen: everSaved === null ? true : timeZoneChosen(cfg.osTimeZone, compiledTimeZone, everSaved),
      monthlyCaps: cfg.monthlyCaps,
      operatorRateUsdPerMin: cfg.operatorRateUsdPerMin,
      flagDefaults: cfg.flagDefaults,
      signalPanels: cfg.signalPanels,
      pullConfig: cfg.pullConfig,
      integrations: cfg.integrations,
      dashboard: cfg.dashboard,
      entities: cfg.entities,
      beads: cfg.beads,
      schedules: cfg.schedules,
    });
    return Response.json(payload, { headers: JSON_HEADERS });
  }

  // The Wall's live feed: its own 30-second poll, apart
  // from `/api/wall`, so a slow union never delays the rest of the TV.
  if (url.pathname === "/api/wall/feed") {
    const cfg = await config();
    return handleWallFeedRequest(request, url, store, { now: new Date(), osTimeZone: cfg.osTimeZone });
  }

  if (url.pathname === "/api/wall") {
    const cfg = await config();
    try {
      const payload = await buildWallPayload(store, {
        now: new Date(),
        constants: cfg.monthlyCaps,
        integrations: cfg.integrations,
        pullConfig: cfg.pullConfig,
        dashboard: cfg.dashboard,
        serpPanel: cfg.serpPanel,
        osTimeZone: cfg.osTimeZone,
        noNightlyReport: cfg.noNightlyReport,
        counters: cfg.counters,
        schedules: cfg.schedules,
      });
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      // Surface a clean error; the client keeps its last-good payload and
      // ages the badges rather than blanking.
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: "wall_assembly_failed", message }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }

  if (url.pathname === "/api/integrations") {
    const cfg = await config();
    try {
      // Reads only: the hourly tick records each source's day (tower-cron.ts).
      const payload = await buildIntegrationsMatrix(store, integrationsDeps(cfg, new Date()));
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: "integrations_assembly_failed", message }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }

  // Which task source every task screen shows, and each source's row on
  // Integrations. Connected is derived from the
  // source's own reading (`./task-source`); the saved projects only tell a
  // row that is being set up from one nobody has started.
  if (url.pathname === "/api/task-source") {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const cfg = await config();
    try {
      const payload = await buildTaskSourcePayload({ store, savedProjects: { beads: cfg.beads.spokes.length } });
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: "task_source_failed", message }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }

  // The task board (desk-only), through the connected task source: for the
  // beads hub, the newest snapshot the local runner filed. An installation
  // with no task source connected gets an empty board.
  if (url.pathname === "/api/work") {
    try {
      const payload = await buildTaskBoard({ store }, new Date());
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: "work_assembly_failed", message }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }
  // Desk-only asset drill-down. IDs contain dots (example.com) and are the
  // assets PK, so the whole remainder of the path is the id.
  if (request.method === "GET" && /^\/api\/assets\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice("/api/assets/".length));
    if (!id || id.includes("/")) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    // `?view=<tab>` is one tab's read (shared/asset-detail-views); no view is
    // the whole page.
    const view = url.searchParams.get("view");
    if (view !== null && !isAssetDetailView(view)) {
      return new Response(JSON.stringify({ error: "unknown_view", view }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const cfg = await config();
    try {
      const deps = {
        now: new Date(),
        flagDefaults: cfg.flagDefaults,
        pullConfig: cfg.pullConfig,
        monthlyCaps: cfg.monthlyCaps,
        operatorRateUsdPerMin: cfg.operatorRateUsdPerMin,
        integrations: cfg.integrations,
        counters: cfg.counters,
        serpPanel: cfg.serpPanel,
        signalPanels: cfg.signalPanels,
        valueEvents: cfg.valueEvents,
        ga4EventParams: cfg.ga4EventParams,
        osTimeZone: cfg.osTimeZone,
        noNightlyReport: cfg.noNightlyReport,
        schedules: cfg.schedules,
      };
      const payload = view === null
        ? await buildAssetDetailPayload(store, id, deps)
        : await buildAssetDetailView(store, id, deps, view);
      if (!payload) {
        return new Response(JSON.stringify({ error: "asset_not_found", id }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      }
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: "asset_detail_failed", message }),
        { status: 500, headers: JSON_HEADERS },
      );
    }
  }

  return null;
}
