// @vitest-environment node
// The one status model for a connection: its status says whether it works
// now. Report dates that failed during an outage and were never retried are
// counted as missing reports on their site, never as a failing connection;
// one site that fails is that site's status and a fact on the provider; a
// refused credential or most sites failing is Failing; an incomplete report
// is a data fact; and nothing is Working before a stored success.

import { describe, expect, it } from "vitest";
import type { CredentialSummary, IntegrationHealthItem, IntegrationHealthPayload } from "@noticeos/contract";
import {
  connectionFacts,
  connectionLabel,
  connectionStatus,
  currentHealth,
  laneStatus,
  needsOperator,
  reportOf,
  sourceReadings,
  sourceStatus,
} from "@shared/connection-status";
import { connectable, firstToConnect } from "@shared/connect-panel";

const NOW = Date.parse("2026-09-23T15:00:00.000Z");
const TODAY = "2026-09-23T12:15:00.000Z";

function credential(over: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    provider: "google", source: "store", fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"], assetsHeld: [], missingFields: [], auth: null,
    metadata: null, keyVersion: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: TODAY, lastOkAt: TODAY, lastError: null, ...over,
  };
}

let id = 0;
function item(over: Partial<IntegrationHealthItem>): IntegrationHealthItem {
  id += 1;
  return {
    id: `i${id}`, provider: "google", capability: "gsc-daily", label: "Search Console daily reports", asset: "meadow.example",
    detail: null, report: null, reportDate: null, state: "healthy", lastAttemptAt: TODAY, lastSuccessAt: TODAY, nextAttemptAt: null, failure: null, code: null,
    action: "Review.", coverage: "monitored", ...over,
  };
}
/** One archive report date. */
const report = (asset: string, name: string, date: string, over: Partial<IntegrationHealthItem> = {}) =>
  item({ capability: "gsc-archive", label: "Search Console report archive", asset, detail: `${name} · ${date}`, report: name, reportDate: date, ...over });
const outage = (asset: string, name: string, date: string) =>
  report(asset, name, date, { state: "failing", lastAttemptAt: `${date}T12:15:00.000Z`, lastSuccessAt: null, failure: "network", code: "network" });

/** A healthy site: its daily pull and today's archive work. */
function site(asset: string, provider = "google"): IntegrationHealthItem[] {
  return [
    item({ provider, asset }),
    report(asset, "query", "2026-09-21", { provider }),
    report(asset, "page", "2026-09-21", { provider }),
  ];
}

describe("a connection's one status", () => {
  it("shows a pending realtime retry as neutral Reconnecting without a failing count or overwriting real access trouble", () => {
    const pending = item({ capability: "ga4-realtime", state: "reconnecting", failure: "network", code: "network" });
    expect(connectionLabel("reconnecting")).toBe("Reconnecting");
    const result = connectionStatus("google", credential(), [pending]);
    expect(result).toMatchObject({ kind: "reconnecting", sitesFailing: 0 });
    expect(result.sites[0]).toMatchObject({ kind: "reconnecting" });
    expect(connectionStatus("google", credential(), [pending, item({ capability: "ga4-daily", state: "failing", failure: "access" })])).toMatchObject({ kind: "failing", sitesFailing: 1 });
    expect(connectionStatus("google", credential(), [pending, item({ capability: "ga4-daily", state: "stale" })])).toMatchObject({ kind: "overdue" });
  });
  it("is Working with a count of missing reports when the latest attempts succeed and old outage dates were never retried", () => {
    const items = [
      ...["meadow.example", "northwind.example"].flatMap((asset) => site(asset)),
      outage("meadow.example", "query", "2026-09-13"),
      outage("meadow.example", "page", "2026-09-13"),
      outage("northwind.example", "query", "2026-09-13"),
    ];
    const status = connectionStatus("google", credential(), items);
    expect(status.kind).toBe("working");
    expect(status.missing).toBe(3);
    expect(status.sitesFailing).toBe(0);
    expect(connectionFacts(status).map((fact) => fact.label)).toEqual(["3 reports missing"]);
    const meadow = status.sites.find((entry) => entry.key === "meadow.example")!;
    expect(meadow).toMatchObject({ kind: "working", missing: 2 });
    expect(needsOperator(status)).toBe(0);
  });

  // The report and its day are the item's own fields: display text reworded
  // to say the same thing on every row can neither merge two reports into one
  // nor lose a missing date.
  it("reads each report and its day from the item's fields, never its display text", () => {
    const reworded = (entry: IntegrationHealthItem): IntegrationHealthItem => ({ ...entry, detail: "Search Console report" });
    const items = [
      item({}),
      reworded(outage("meadow.example", "query", "2026-09-13")),
      reworded(report("meadow.example", "query", "2026-09-21")),
      reworded(report("meadow.example", "page", "2026-09-21")),
    ];
    const status = connectionStatus("google", credential(), items);
    const meadow = status.sites.find((entry) => entry.key === "meadow.example")!;
    expect(meadow).toMatchObject({ kind: "working", missing: 1 });
    expect(meadow.works.filter((work) => work.capability === "gsc-archive").map((work) => work.report).sort()).toEqual(["page", "query"]);
    expect(reportOf(items[1]!)).toEqual({ report: "query", date: "2026-09-13" });
    // Anything that is not one archive report has neither.
    expect(reportOf(items[0]!)).toEqual({ report: "", date: "" });
  });

  it("is Working · 1 asset failing when one asset of several is refused and the rest work", () => {
    const items = [
      ...["meadow.example", "northwind.example", "ferns.example"].flatMap((asset) => site(asset, "bing-webmaster")),
      item({ provider: "bing-webmaster", capability: "bing-daily", asset: "puffin.example", state: "failing", lastSuccessAt: null, failure: "access", code: "access" }),
    ].map((entry) => ({ ...entry, provider: "bing-webmaster" }));
    const status = connectionStatus("bing-webmaster", credential({ provider: "bing-webmaster" }), items);
    expect(status.kind).toBe("working");
    expect(status.sitesFailing).toBe(1);
    expect(status.sites[0]).toMatchObject({ key: "puffin.example", kind: "failing" });
    expect(status.sites[0]!.failure?.failure).toBe("access");
    expect(connectionFacts(status).map((fact) => fact.label)).toEqual(["1 asset failing"]);
    expect(needsOperator(status)).toBe(1);
  });

  it("is Failing when the provider refused the credential on its last use", () => {
    const refused = credential({ lastError: "The provider rejected this key.", lastOkAt: "2026-09-20T00:00:00.000Z", lastUsedAt: TODAY });
    const status = connectionStatus("google", refused, site("meadow.example"));
    expect(status.kind).toBe("failing");
    expect(needsOperator(status)).toBe(1);
  });

  it("is Failing when most assets fail now, and then does not repeat the count as a fact", () => {
    const failing = (asset: string) => item({ asset, state: "failing", lastSuccessAt: null, failure: "access", code: "access" });
    const status = connectionStatus("google", credential(), [failing("a.test"), failing("b.test"), ...site("c.test")]);
    expect(status.kind).toBe("failing");
    expect(connectionFacts(status).map((fact) => fact.label)).toEqual(["2 assets failing"]);
    const all = connectionStatus("google", credential(), [failing("a.test"), failing("b.test")]);
    expect(all.kind).toBe("failing");
    expect(connectionFacts(all)).toEqual([]);
  });

  it("fails an asset whose latest attempt of one report failed after an earlier success", () => {
    const items = [
      ...site("meadow.example"),
      report("meadow.example", "country", "2026-09-21", { state: "failing", lastSuccessAt: null, failure: "provider", code: "provider" }),
      report("meadow.example", "country", "2026-09-20", { lastAttemptAt: "2026-09-22T12:15:00.000Z", lastSuccessAt: "2026-09-22T12:15:00.000Z" }),
    ];
    const status = connectionStatus("google", credential(), items);
    expect(status.sites[0]).toMatchObject({ key: "meadow.example", kind: "failing", missing: 0 });
  });

  it("counts an incomplete report as a data fact, never a failure", () => {
    const items = [...site("meadow.example"), report("meadow.example", "query", "2026-09-22", { state: "failing", failure: "incomplete-report", code: "incomplete-report" })];
    const status = connectionStatus("google", credential(), items);
    expect(status.kind).toBe("working");
    expect(connectionFacts(status).map((fact) => fact.label)).toEqual(["1 report incomplete"]);
  });

  it("is never ahead of its proof: saved is Not checked, a passed test is Key accepted, a first run is Collecting", () => {
    expect(connectionStatus("google", null, site("meadow.example")).kind).toBe("not-connected");
    expect(connectionStatus("google", credential({ source: "none", fields: [] }), site("meadow.example")).kind).toBe("not-connected");
    expect(connectionStatus("google", credential({ lastOkAt: null, lastUsedAt: null }), []).kind).toBe("not-checked");
    expect(connectionStatus("google", credential(), []).kind).toBe("key-accepted");
    expect(connectionLabel("key-accepted", "sign-in")).toBe("Signed in");
    expect(connectionLabel("key-accepted", "url")).toBe("URL accepted");
    expect(connectionLabel("key-accepted")).toBe("Key accepted");
    const pending = item({ state: "never-run", lastAttemptAt: null, lastSuccessAt: null });
    expect(connectionStatus("google", credential(), [pending]).kind).toBe("collecting");
  });

  it("is Not using when every asset's collection is paused", () => {
    const status = connectionStatus("google", credential(), [item({ state: "paused" }), item({ asset: "northwind.example", state: "paused" })]);
    expect(status.kind).toBe("not-using");
  });

  it("keeps unknown unknown: a read that is not current cannot show retained success as Working", () => {
    const payload: IntegrationHealthPayload = { generatedAt: "2026-09-23T14:50:00.000Z", available: true, items: site("meadow.example"), events: [] };
    const stale = currentHealth(payload, false, NOW);
    expect(stale.current).toBe(false);
    expect(connectionStatus("google", credential(), stale.items).kind).toBe("unknown");
    const fresh = currentHealth({ ...payload, generatedAt: "2026-09-23T14:59:30.000Z" }, false, NOW);
    expect(connectionStatus("google", credential(), fresh.items).kind).toBe("working");
  });
});

describe("one data source on one asset", () => {
  const items = [
    item({ capability: "ga4-daily", label: "Analytics daily reports" }),
    item({ capability: "gsc-daily", state: "failing", lastSuccessAt: null, failure: "access", code: "access" }),
  ];

  it("reads only that lane's work on that asset", () => {
    expect(sourceStatus(credential(), items, "meadow.example", "ga4").kind).toBe("working");
    expect(sourceStatus(credential(), items, "meadow.example", "gsc").kind).toBe("failing");
  });

  it("is Not connected when the provider is, or when this asset has nothing scheduled", () => {
    expect(sourceStatus(null, items, "meadow.example", "ga4").kind).toBe("not-connected");
    expect(sourceStatus(credential(), items, "northwind.example", "ga4").kind).toBe("not-connected");
  });

  it("is Unknown, never Not connected, while a read is missing", () => {
    expect(sourceStatus(undefined, items, "meadow.example", "ga4").kind).toBe("unknown");
    expect(sourceStatus(credential(), null, "meadow.example", "ga4").kind).toBe("unknown");
  });

  it("is Collecting, with no asset yet, when the asset maps the source and the provider is connected", () => {
    // A site added and mapped today: no monitoring item names it yet.
    expect(sourceStatus(credential(), items, "northwind.example", "ga4", true)).toEqual({ kind: "collecting", site: null });
    expect(sourceStatus(credential(), [], "northwind.example", "ga4", true).kind).toBe("collecting");
    // A key nobody has tested yet is still a connected provider.
    expect(sourceStatus(credential({ lastOkAt: null, lastUsedAt: null }), [], "northwind.example", "ga4", true).kind).toBe("collecting");
  });

  it("keeps Not connected for a provider not connected or a source with no mapping, and Failing for a refused key", () => {
    expect(sourceStatus(null, [], "northwind.example", "ga4", true).kind).toBe("not-connected");
    expect(sourceStatus(credential({ source: "none", fields: [] }), [], "northwind.example", "ga4", true).kind).toBe("not-connected");
    expect(sourceStatus(credential(), [], "northwind.example", "ga4", false).kind).toBe("not-connected");
    expect(sourceStatus(credential(), [], "northwind.example", "ga4").kind).toBe("not-connected");
    const refused = credential({ lastError: "invalid_grant", lastOkAt: "2026-09-01T00:00:00.000Z", lastUsedAt: TODAY });
    expect(sourceStatus(refused, [], "northwind.example", "ga4", true).kind).toBe("failing");
  });

  it("lets the monitoring items speak once they name the mapped asset", () => {
    expect(sourceStatus(credential(), items, "meadow.example", "ga4", true).kind).toBe("working");
    expect(sourceStatus(credential(), items, "meadow.example", "gsc", true).kind).toBe("failing");
  });

  it("reads a mapped cell as Collecting on the Data sources row and on every card slot, with no Connect", () => {
    const credentials = new Map([["google", credential()]]);
    const cell = { assetId: "northwind.example", laneId: "ga4", effective: "needs-setup" as const, evidence: [] };
    const row = laneStatus({ laneId: "ga4", assetId: "northwind.example", cell: { ...cell, mapped: true }, credentials, items: [], nowMs: NOW });
    expect(row).toEqual({ kind: "collecting", site: null, provider: "google" });
    expect(connectable(row)).toBe(false);
    expect(laneStatus({ laneId: "ga4", assetId: "northwind.example", cell, credentials, items: [], nowMs: NOW }).kind).toBe("not-connected");

    // The header, Home, the Wall and the setup checklist read the card slot.
    const slots = sourceReadings("northwind.example", [
      { id: "ga4", label: "Google Analytics (GA4)", state: "needs-setup", detail: "No run yet", observedAt: null, mapped: true },
      { id: "gsc", label: "Google Search Console", state: "needs-setup", detail: "No run yet", observedAt: null },
    ], { credentials, items: [] }, NOW);
    expect(slots.map(({ id, kind }) => [id, kind])).toEqual([["ga4", "collecting"], ["gsc", "not-connected"]]);
    expect(firstToConnect(slots)?.id).toBe("gsc");
  });

  it("reads a demo connection as its runs say, like any connection", () => {
    // The demo workspace's connection: no field, no key, never used.
    const demo = credential({ source: "demo", fields: [], keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null });
    expect(sourceStatus(demo, items, "meadow.example", "ga4").kind).toBe("working");
    expect(sourceStatus(demo, items, "meadow.example", "gsc").kind).toBe("failing");
    expect(connectionStatus("google", demo, items).kind).toBe("failing");
    expect(connectionStatus("google", demo, site("meadow.example")).kind).toBe("working");
  });
});
