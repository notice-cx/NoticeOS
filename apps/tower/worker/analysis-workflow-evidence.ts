import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { marketLabel } from "@noticeos/contract/dataforseo";
import { assessSerpOrganicQuality } from "../../../scripts/panel-serp-organic.mjs";
import type { AnalysisCitation, AnalysisEvidence, AnalysisTemplateId } from "../shared/analysis-runbooks";
import {
  parseProductUse, parseSearchIntelligence, parseSearchPages, parseSearchQueryProviderTrend, parseSerpPanel,
} from "./asset-detail-payload";
import { loadPortfolioBriefAcquisition } from "./portfolio-brief-acquisition";

export { analysisRunbook } from "../shared/analysis-runbooks";

type SourceRow = {
  id: string; displayName: string; snapshot: string | null; generated: string | null;
  sections: string; watches: number;
}

const METRICS: Record<string, string> = {
  clicks: "Clicks", impressions: "Impressions", sessions: "Sessions", pageViews: "Page views",
};
const PROVIDERS = { google: "Google Search Console", bing: "Bing Webmaster Tools", ga4: "Google Analytics" };
type Readings = AnalysisCitation["readings"];
function reading(label: string, value: Readings[number]["value"]) {
  return { label, value: typeof value === "string" ? value.slice(0, 400) : value };
}

export async function buildAnalysisEvidence(store: WorkspaceStore, input: {
  template: AnalysisTemplateId; assetIds: readonly string[]; asOf: string;
}): Promise<AnalysisEvidence> {
  const { asOf, assetIds, template } = input;
  const now = new Date(asOf);
  if (!Number.isFinite(now.getTime()) || !assetIds.length || assetIds.length > 8 || new Set(assetIds).size !== assetIds.length) {
    throw new Error("Invalid analysis scope.");
  }
  const seo = template === "seo-ai-visibility";
  const rows = await store.read(tx => tx.query<SourceRow>(`SELECT a.asset_id AS id, a.display_name AS "displayName",
    s.snapshot_id AS snapshot, s.generated_at AS generated, json_build_object(
      'google', s.payload#>'{searchQueries,google}', 'bing', s.payload#>'{searchQueries,bing}',
      'pages', s.payload->'searchPages', 'panel', s.payload->'serpPanel',
      'intelligence', CASE WHEN $4 THEN json_build_object('observedAt',s.payload#>'{searchIntelligence,observedAt}',
        'costUsd',s.payload#>'{searchIntelligence,costUsd}', 'rankings',s.payload#>'{searchIntelligence,rankings}',
        'ai',s.payload#>'{searchIntelligence,ai}') END,
      'use', CASE WHEN $4 THEN s.payload->'productUse' END)::text AS sections,
    (SELECT count(*)::int FROM noticeos.watch_windows w WHERE w.workspace_id=a.workspace_id AND w.asset_id=a.asset_id
      AND w.registered_at <= $3::timestamptz AND w.created_at <= $3::timestamptz
      AND (w.closed_at IS NULL OR w.closed_at > $3::timestamptz)) AS watches
    FROM noticeos.assets a LEFT JOIN LATERAL (
      SELECT snapshot_id, generated_at, payload FROM noticeos.asset_insight_snapshots s
      WHERE s.workspace_id=a.workspace_id AND s.asset_id=a.asset_id
        AND s.generated_at <= $3::timestamptz AND s.created_at <= $3::timestamptz
        AND s.payload->>'asset'=a.asset_id AND s.payload->>'schemaVersion'='1'
      ORDER BY generated_at DESC, created_at DESC, snapshot_id DESC LIMIT 1
    ) s ON true WHERE a.workspace_id=$1::uuid AND a.asset_id=ANY($2::text[]) AND a.status<>'retired' AND NOT a.is_os
    ORDER BY a.asset_id COLLATE "C"`, [tx.workspaceId, assetIds, asOf, seo]));
  if (rows.length !== assetIds.length) throw new Error("An asset is unavailable in this workspace.");
  const { facts } = await loadPortfolioBriefAcquisition(store, { assets: rows, now, collectedThrough: asOf });
  const evidence: AnalysisEvidence = { asOf, coverage: [], citations: [] };
  const cutoff = now.toISOString().slice(0, 10);
  const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= cutoff;
  for (const row of rows) {
    const data = JSON.parse(row.sections) as Record<string, unknown>;
    const date = row.generated ? javascriptInstant(row.generated) : null;
    const cover = (source: string, status: AnalysisEvidence["coverage"][number]["status"], detail: string) =>
      evidence.coverage.push({ assetId: row.id, source, status, detail });
    const cite = (key: string, source: string, label: string, observedAt: string, tab: string, readings: Readings, note: string, snapshot = true) =>
      evidence.citations.push({ id: `${encodeURIComponent(row.id)}:${key}`, assetId: row.id, source, label: label.slice(0, 240),
        observedAt, href: `/assets/${encodeURIComponent(row.id)}/${tab}`, readings, note: note.slice(0, 480),
        ...(snapshot && row.snapshot ? { snapshotId: row.snapshot } : {}) });
    for (const provider of ["google", "bing", "ga4"] as const) {
      if (!seo && provider === "ga4") continue;
      const source = PROVIDERS[provider];
      const fact = facts.find(item => item.data.asset === row.id && item.data.provider === provider);
      if (!fact) { cover(source, "unavailable", "Two complete, comparable weeks were unavailable at the time of this run."); continue; }
      const { current, previous, timeZone } = fact.comparison;
      const readings: Readings = [];
      for (const [metric, values] of Object.entries(fact.data.metrics)) {
        if (!values || !METRICS[metric]) continue;
        readings.push(reading(METRICS[metric] + " this period", values.current), reading(METRICS[metric] + " previous period", values.previous));
      }
      const note = `${previous.start}–${previous.end} and ${current.start}–${current.end} (${timeZone}). ${fact.data.caution}`;
      cite(provider, source, source + " weekly comparison", fact.observedAt, "growth", readings, note, false);
      cover(source, "available", note);
    }
    let queryCount = 0;
    for (const provider of ["google", "bing"] as const) {
      const trend = parseSearchQueryProviderTrend(data[provider], provider);
      if (!date || !trend || !validDay(trend.currentEnd) || !validDay(trend.previousEnd)) continue;
      const movers = trend.movers.slice().sort((a, b) => Math.abs(b.impressionDelta) - Math.abs(a.impressionDelta) || a.query.localeCompare(b.query));
      for (const [index, item] of movers.slice(0, 2).entries()) {
        cite(`${provider}-query-${index}`, PROVIDERS[provider], item.query, date, "search#query-visibility", [
          reading("Impressions", item.currentImpressions), reading("Previous impressions", item.previousImpressions),
          reading("Average position", item.currentPosition), reading("Previous average position", item.previousPosition),
        ], `${trend.currentStart}–${trend.currentEnd} versus ${trend.previousStart}–${trend.previousEnd}. ${trend.caveat}`);
        queryCount++;
      }
    }
    cover("Query comparisons", queryCount ? "available" : "unavailable", queryCount ? `${queryCount} retained query comparisons, up to two per engine.` : "No comparable query rows were available.");
    const pages = parseSearchPages(data.pages);
    const selected = pages && validDay(pages.currentEnd) && validDay(pages.previousEnd) ? pages.pages.slice().sort((a, b) =>
      Math.abs(b.clickDelta) - Math.abs(a.clickDelta) || a.page.localeCompare(b.page)).slice(0, 3) : [];
    for (const [index, page] of selected.entries()) {
      if (!date || !pages) continue;
      cite(`page-${index}`, "Google Search Console pages", page.path, date, "search#page-decisions", [
        reading("Clicks", page.currentClicks), reading("Previous clicks", page.previousClicks),
        reading("Impressions", page.currentImpressions), reading("Previous impressions", page.previousImpressions),
      ], `${pages.currentStart}–${pages.currentEnd} versus ${pages.previousStart}–${pages.previousEnd}. ${pages.caveat}`);
    }
    cover("Page comparisons", selected.length ? "available" : "unavailable", selected.length ? `${selected.length} of ${pages!.pages.length} reported pages, ordered by absolute change in clicks.` : "No comparable page report was available.");

    const panel = parseSerpPanel(data.panel);
    if (panel && validDay(panel.reportDate)) {
      const terms = Array.from(new Map(panel.queries.map(term => [JSON.stringify([term.query, term.device]), term])).values());
      const quality = assessSerpOrganicQuality(terms.map(term => ({ report_date: panel.reportDate, query: term.query, device: term.device,
        best_rank: term.providerStatus ? null : term.bestRank, top3_domains: term.providerStatus ? null : term.composition?.top3Domains.join("|") ?? null })));
      const readable = terms.filter(term => !term.providerStatus && (term.aioPresent !== null || term.aioCitesUs !== null || (quality?.status === "clear" && term.bestRank !== null)));
      for (const [index, term] of readable.slice(0, 6).entries()) {
        const readings = [reading("AI Overview observed", term.aioPresent), reading("Asset cited", term.aioCitesUs)];
        if (panel.market) readings.push(reading("Search market", marketLabel(panel.market)));
        if (quality?.status === "clear") readings.push(reading("Best organic rank in sample", term.bestRank));
        cite(`tracking-${index}`, "Tracked Google results", `${term.query} · ${term.device}`, panel.reportDate, "search#serp-panel", readings,
          `Observed on ${panel.reportDate}. Organic result quality: ${quality?.status ?? "unassessed"}. Tracked depth: ${panel.trackedDepth ?? "unknown"}.`);
      }
      cover("Tracked Google results", readable.length ? (quality?.status === "clear" && readable.length === terms.length ? "available" : "limited") : "unavailable",
        `${readable.length} of ${terms.length} tracked query/device pairs had usable readings on ${panel.reportDate}. Up to six are shown. Organic result quality: ${quality?.status ?? "unassessed"}.`);
    } else cover("Tracked Google results", "unavailable", "No dated search panel was available.");
    if (seo) {
      const intel = parseSearchIntelligence(data.intelligence);
      for (const [source, value] of [["Google", intel?.ai.googleMentions], ["ChatGPT", intel?.ai.chatgptMentions]] as const) {
        const label = source + " AI mentions";
        const observed = intel?.observedAt;
        if (value == null || !observed || !Number.isFinite(Date.parse(observed)) || Date.parse(observed) > now.getTime()) {
          cover(label, "unavailable", "No dated mention count was reported for this platform."); continue;
        }
        cite("mentions-" + source, label, label, observed, "search#search-context", [reading("Mentions in provider sample", value)],
          "Mentions count appearances in the provider sample. Referral traffic and conversions require separate measurements.");
        cover(label, "limited", "Sampled by the provider on " + observed.slice(0, 10) + ".");
      }
      const use = parseProductUse(data.use);
      const outcomes = use && validDay(use.windowEnd) ? [...use.build, ...use.sharing, ...use.supporting].filter(m => m.events !== null || m.users !== null).slice(0, 3) : [];
      for (const [index, metric] of outcomes.entries()) {
        if (!use || !date) continue;
        cite("event-" + index, "Product events", metric.label, date, "growth#product-use", [reading("Event", metric.eventName),
          reading("People", metric.users), reading("Events", metric.events)], `${use.windowStart}–${use.windowEnd}. The report covers all traffic sources.`);
      }
      cover("Product events", outcomes.length ? "limited" : "unavailable", outcomes.length ? "Measured across all sources. Search attribution is unavailable." : "No measured product event was available.");
    }
    cite("windows", "Measurement periods", "Open measurement periods", asOf, "activity", [reading("Open periods", row.watches)],
      "Open the asset’s activity to review the affected surfaces before proposing a change.", false);
  }
  return evidence;
}
