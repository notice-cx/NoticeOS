// @vitest-environment node
import { expect, it } from "vitest";
import { buildAnalysisEvidence } from "../worker/analysis-workflow-evidence";
import { createTestStore } from "./postgres-store";
import { writeInsightSnapshots } from "./provider-reports";
import { addSites } from "./sites";

it("freezes only evidence available on the review date and preserves observed absence", async () => {
  const { call } = await withAsset();
  const asset = "example.com";
  const day = "2026-11-04";
  const asOf = day + "T23:00:00Z";
  const nextDay = "2026-11-05T01:00:00Z";
  const panel = {
    reportDate: day, trackedDepth: 20, market: { locationCode: 2124, languageCode: "fr" },
    queries: [
      { query: "example query", device: "mobile", bestRank: 5, aioPresent: true, aioCitesUs: false },
      { query: "unread pair", device: "desktop", providerStatus: "unavailable", bestRank: 1, aioPresent: false, aioCitesUs: false },
    ],
  };
  const payload = {
    schemaVersion: 1, asset, serpPanel: panel,
    searchIntelligence: { observedAt: day, costUsd: 0,
      rankings: { keywords: 0, top3: 0, top10: 0, top20: 0, estimatedVisits: 0, estimatedPaidTrafficCost: 0, aiOverviewReferences: 0 },
      ai: { googleMentions: null, googleSearchVolume: null, chatgptMentions: 0, chatgptSearchVolume: null } },
  };
  await writeInsightSnapshots(call, [
    { id: "original", asset, generated_at: asOf, created_at: asOf, payload: JSON.stringify(payload) },
    { id: "late", asset, generated_at: asOf, created_at: nextDay, payload: JSON.stringify({ ...payload, serpPanel: null }) },
  ]);
  const seo = await buildAnalysisEvidence(call, { template: "seo-ai-visibility", assetIds: [asset], asOf });
  expect(seo.citations.filter(c => c.source === "Tracked Google results")).toMatchObject([{
    snapshotId: "original", observedAt: day, readings: [{ value: true }, { value: false }, { value: "Canada · French" }],
  }]);
  expect(seo.coverage).toContainEqual(expect.objectContaining({ source: "Google AI mentions", status: "unavailable" }));
  expect(seo.citations.find(c => c.source === "ChatGPT AI mentions")?.readings[0]?.value).toBe(0);
  const weekly = await buildAnalysisEvidence(call, { template: "weekly-search-review", assetIds: [asset], asOf: nextDay });
  expect(weekly.citations.some(c => c.source === "Tracked Google results" || c.source.includes("AI mentions"))).toBe(false);
  await expect(buildAnalysisEvidence(call, { template: "weekly-search-review", assetIds: [asset, "unregistered.example"], asOf })).rejects.toThrow();
});

async function withAsset() {
  const ctx = await createTestStore();
  await addSites(ctx, [{ id: "example.com", displayName: "Example", domain: null, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00Z" }]);
  return ctx;
}
