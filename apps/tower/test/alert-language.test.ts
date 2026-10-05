// The translation layer's contract: a stored alert (rule_id + rule_inputs + the
// rule's own message) becomes a sentence an operator can act on. Every case here
// is a real rule_inputs shape written by workers/ingest — the fixtures are
// copied from what the rules actually persist, not invented.

import { describe, expect, it } from "vitest";
import type { AnnotationItem } from "@shared/annotations";
import {
  CORRELATION_WINDOW_HOURS,
  changesLabel,
  correlateChanges,
  humanizeMetric,
  pullFailureCause,
  translateAlert,
  type AlertFacts,
} from "@shared/alert-language";

/** Everything the headline must never contain: the rule's arithmetic. */
function assertNoStatistics(text: string) {
  expect(text).not.toMatch(/avg7d|P\(<=|pLowerTail|lambda|alpha|last24h|baselinePerDay/i);
}

describe("humanizeMetric — envelope names become words", () => {
  it("splits camelCase and lowercases", () => {
    expect(humanizeMetric("plansSaved")).toBe("plans saved");
    expect(humanizeMetric("ledgerRows")).toBe("ledger rows");
    expect(humanizeMetric("receiptVisits")).toBe("receipt visits");
  });

  it("leaves a single lowercase word alone", () => {
    expect(humanizeMetric("signups")).toBe("signups");
    expect(humanizeMetric("feedback")).toBe("feedback");
  });

  it("keeps acronym runs readable and normalizes separators", () => {
    expect(humanizeMetric("gscURLClicks")).toBe("gsc url clicks");
    expect(humanizeMetric("food_log")).toBe("food log");
  });
});

describe("flow-poisson-low — the single-day drop", () => {
  const signups: AlertFacts = {
    ruleId: "flow-poisson-low",
    metric: "signups",
    message: "22 in last24h (avg7d 39.3, P(<=22)~=0.0020)",
    ruleInputs: {
      metric: "signups",
      observed: 22,
      baselinePerDay: 39.285714285714285,
      alpha: 0.01,
      minBaselinePerDay: 3,
      windowHours: 24,
      lambda: 39.285714285714285,
      pLowerTail: 0.001958382423585121,
    },
  };

  it("leads with what happened and its magnitude, rounded to what you'd say out loud", () => {
    const a = translateAlert(signups);
    expect(a.headline).toBe("Signups well below normal — 22 vs ~39/day");
    assertNoStatistics(a.headline);
  });

  it("offers no next step for a plain drop — an invented one would be noise", () => {
    expect(translateAlert(signups).hint).toBeUndefined();
  });

  it("moves the statistics into evidence, as labels and values", () => {
    const a = translateAlert(signups);
    expect(a.evidence.map((e) => e.source)).toEqual([
      "Arrived",
      "Normal · 7-day average",
      "Chance if nothing changed",
    ]);
    expect(a.evidence[0]!.detail).toBe("22 in 24h");
    expect(a.evidence[1]!.detail).toBe("39.3/day");
    expect(a.evidence[2]!.detail).toBe("0.2% · fires below 1%");
    // Label-length rows, never sentences (bead `ro-ujb9.96.6.7`).
    for (const row of a.evidence) {
      expect(`${row.source} ${row.detail}`.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(row.detail).not.toMatch(/\.$/);
    }
  });

  it("names the matching-weekday baseline when central history supplied it", () => {
    const a = translateAlert({
      ...signups,
      ruleInputs: {
        ...signups.ruleInputs,
        baselineSource: "same-weekday-4w",
        baselineComparisonDates: [
          "2026-06-28",
          "2026-06-21",
          "2026-06-14",
          "2026-06-07",
        ],
      },
    });
    expect(a.evidence[1]!.source).toBe("Normal · same weekday");
    expect(a.evidence[1]!.detail).not.toContain("7 days");
    expect(a.evidence[1]!.detail).toBe("39.3/day · 2026-06-28, 2026-06-21, 2026-06-14, 2026-06-07");
  });

  it("keeps every evidence note supporting, so the glyph never restates severity", () => {
    expect(translateAlert(signups).evidence.every((e) => e.polarity === "supporting")).toBe(true);
  });

  it("a zero on an active baseline is its own sentence, with a next step", () => {
    const a = translateAlert({
      ruleId: "flow-poisson-low",
      metric: "plansSaved",
      message: "0 in last24h (avg7d 6.5, P(<=0)~=0.0015)",
      ruleInputs: { metric: "plansSaved", observed: 0, baselinePerDay: 6.5, alpha: 0.01, pLowerTail: 0.0015034 },
    });
    expect(a.headline).toBe("Plans saved hit zero — normally ~7/day");
    expect(a.hint).toBe("flow may be broken");
  });

  it("never rounds a sub-1 baseline down to zero — that would read as 'normally nothing'", () => {
    const a = translateAlert({
      ruleId: "flow-poisson-low",
      metric: "signups",
      message: "0 in last24h",
      ruleInputs: { metric: "signups", observed: 0, baselinePerDay: 0.43 },
    });
    expect(a.headline).toBe("Signups hit zero — normally ~0.4/day");
  });

  it("falls back to the stored message when the inputs are unusable", () => {
    const a = translateAlert({
      ruleId: "flow-poisson-low",
      metric: "signups",
      message: "22 in last24h (avg7d 39.3)",
      ruleInputs: null,
    });
    expect(a.headline).toBe("Signups — 22 in last24h (avg7d 39.3)");
  });
});

describe("flow-lowvol-window — the multi-day window", () => {
  const ledgerRows: AlertFacts = {
    ruleId: "flow-lowvol-window",
    metric: "ledgerRows",
    message: "0 in last72h (baseline 7.3, P(<=0)~=0.00069)",
    ruleInputs: {
      metric: "ledgerRows",
      windowObserved: 0,
      baselinePerDay: 2.4285714285714284,
      alpha: 0.01,
      windowHours: 72,
      lambda: 7.285714285714285,
      windowDays: 3,
      pLowerTail: 0.0006852585910790803,
    },
  };

  it("names the window in days and the baseline per day", () => {
    const a = translateAlert(ledgerRows);
    expect(a.headline).toBe("Ledger rows hit zero — none in 3 days, normally ~2/day");
    assertNoStatistics(a.headline);
  });

  it("gives the bookkeeping lane its own next step, not the generic flow one", () => {
    expect(translateAlert(ledgerRows).hint).toBe("the bookkeeping import looks stalled");
  });

  it("states the pooled window's expected count — the skeptic's first question", () => {
    const a = translateAlert(ledgerRows);
    const why = a.evidence.find((e) => e.source === "Expected in 3-day window");
    expect(why?.detail).toBe("~7 · low volume, days pooled");
  });

  it("counts a non-zero window against the same per-day baseline", () => {
    const a = translateAlert({
      ...ledgerRows,
      ruleInputs: { ...ledgerRows.ruleInputs, windowObserved: 1 },
    });
    expect(a.headline).toBe("Ledger rows well below normal — 1 in 3 days, normally ~2/day");
    expect(a.hint).toBeUndefined();
  });

  it("states a window that isn't whole days in hours", () => {
    const a = translateAlert({
      ...ledgerRows,
      ruleInputs: { ...ledgerRows.ruleInputs, windowHours: 36, windowObserved: 0 },
    });
    expect(a.headline).toBe("Ledger rows hit zero — none in 36h, normally ~2/day");
  });
});

describe("flow-pct-drop — the percentage tripwire", () => {
  it("leads with the drop and the two numbers behind it", () => {
    const a = translateAlert({
      ruleId: "flow-pct-drop",
      metric: "items",
      message: "30 in last24h is 33% below avg7d 42.6",
      ruleInputs: {
        metric: "items",
        observed: 30,
        baselinePerDay: 42.6,
        minDropFraction: 0.3,
        minAbsoluteCount: 5,
        dropFraction: 0.3286,
      },
    });
    expect(a.headline).toBe("Items down 33% — 30 vs ~43/day");
    assertNoStatistics(a.headline);
    expect(a.evidence.find((e) => e.source === "Drop")?.detail).toBe("33% · fires at 30%+");
  });

  it("uses the zero sentence when the drop bottomed out", () => {
    const a = translateAlert({
      ruleId: "flow-pct-drop",
      metric: "items",
      message: "0 in last24h is 100% below avg7d 42.6",
      ruleInputs: { metric: "items", observed: 0, baselinePerDay: 42.6, dropFraction: 1 },
    });
    expect(a.headline).toBe("Items hit zero — normally ~43/day");
    expect(a.hint).toBe("flow may be broken");
  });
});

describe("ingest-freshness — the report that never arrived", () => {
  const stale: AlertFacts = {
    ruleId: "ingest-freshness",
    metric: "pulse",
    message: "no pulse in 41h (> 36h threshold)",
    ruleInputs: {
      rule: "ingest-freshness",
      lastReceivedAt: "2026-07-24T03:04:00.000Z",
      thresholdHours: 36,
      ageHours: 41,
      evaluatedAt: "2026-07-25T20:00:00.000Z",
    },
  };

  it("says it in the lexicon's words (pulse → nightly report), with a next step", () => {
    const a = translateAlert(stale);
    expect(a.headline).toBe("No nightly report in 41h");
    expect(a.headline).not.toContain("pulse");
    expect(a.hint).toBe("reporting may have stopped");
  });

  it("hangs the threshold and the last accepted report on the evidence, dated", () => {
    const a = translateAlert(stale);
    const last = a.evidence.find((e) => e.source === "Last report accepted")!;
    expect(last.at).toBe("2026-07-24T03:04:00.000Z");
    expect(a.evidence.find((e) => e.source === "Fires after")?.detail).toBe("36h without a report");
  });

  // ro-6le: a flag that fired despite dark-hour credit carries osDarkHours,
  // and the surface reads the exculpation without re-litigating the decision.
  const staleAcrossOutage: AlertFacts = {
    ruleId: "ingest-freshness",
    metric: "pulse",
    message: "no pulse in 80h (> 48h threshold) · OS offline 10h",
    ruleInputs: {
      rule: "ingest-freshness",
      lastReceivedAt: "2026-08-07T02:30:00.000Z",
      thresholdHours: 48,
      ageHours: 80,
      osDarkHours: 10,
      evaluatedAt: "2026-08-10T10:30:00.000Z",
    },
  };

  it("credits the OS's own outage against the asset, as the one row that argues back", () => {
    const a = translateAlert(staleAcrossOutage);
    expect(a.headline).toBe("No nightly report in 80h");
    const dark = a.evidence.find((e) => e.source === "OS offline, not counted")!;
    expect(dark.polarity).toBe("against");
    expect(dark.detail).toBe("10h of 80h · 70h unexplained");
    // The hint stays the next step; the mitigation is the evidence row, whose
    // "against" polarity turns the panel's glyph amber.
    expect(a.hint).toBe("reporting may have stopped");
  });

  it("carries no offline row when the store evidenced no outage", () => {
    const a = translateAlert(stale);
    expect(a.evidence.find((e) => e.source === "OS offline, not counted")).toBeUndefined();
    expect(a.evidence.every((e) => e.polarity === "supporting")).toBe(true);
    expect(a.hint).toBe("reporting may have stopped");
  });

  // docs/19 finding 5: the same rule now also fires for an asset that has
  // never reported. It has no age to state, and the fix is a different one.
  const neverReported: AlertFacts = {
    ruleId: "ingest-freshness",
    metric: "pulse",
    message: "no pulse ever received (registered 2026-07-05T00:00:00.000Z)",
    ruleInputs: {
      rule: "ingest-freshness",
      state: "never-reported",
      lastReceivedAt: null,
      registeredAt: "2026-07-05T00:00:00.000Z",
      thresholdHours: 36,
      sinceRegistrationHours: 60,
      evaluatedAt: "2026-07-07T12:00:00.000Z",
    },
  };

  it("separates 'never arrived' from 'stopped arriving' — different lane, different fix", () => {
    const a = translateAlert(neverReported);
    expect(a.headline).toBe("No nightly report has EVER arrived");
    expect(a.headline).not.toContain("pulse");
    expect(a.hint).toBe("reporting may never have been wired up");
  });

  it("dates the obligation from registration, since there is no last report to cite", () => {
    const a = translateAlert(neverReported);
    expect(a.evidence.find((e) => e.source === "Last report accepted")).toBeUndefined();
    expect(a.evidence.find((e) => e.source === "Registered, never reported")?.at).toBe(
      "2026-07-05T00:00:00.000Z",
    );
  });

  it("never degrades a never-reported alert to the raw stored message", () => {
    // The old translator keyed on `ageHours`, which this flag cannot have, so
    // the operator would have been shown the store's own terse sentence.
    expect(translateAlert(neverReported).headline).not.toContain("no pulse ever received");
  });

  // `ro-kukv.6` / decision D15: four assets that have never reported are ONE
  // fact about the portfolio, not four sentences to read.
  const members = [
    { assetDisplayName: "Fee Codes" },
    { assetDisplayName: "Pull-up Standards" },
    { assetDisplayName: "Area Lookup" },
    { assetDisplayName: "Pacer Test" },
  ];

  it("states a cross-asset group once, with the count spelled out", () => {
    const a = translateAlert({ ...neverReported, members });
    expect(a.headline).toBe("Four sites have no nightly reports");
    expect(a.hint).toBe("their nightly reporting may never have been wired up");
  });

  it("spells the count to nine and uses digits past it", () => {
    const nine = translateAlert({
      ...neverReported,
      members: Array.from({ length: 9 }, (_, i) => ({ assetDisplayName: `A${i}` })),
    });
    const ten = translateAlert({
      ...neverReported,
      members: Array.from({ length: 10 }, (_, i) => ({ assetDisplayName: `A${i}` })),
    });
    expect(nine.headline).toBe("Nine sites have no nightly reports");
    expect(ten.headline).toBe("10 sites have no nightly reports");
  });

  it("names the assets in evidence and drops the representative's registration date", () => {
    const a = translateAlert({ ...neverReported, members });
    // A registration date belongs to ONE asset; printing the representative's
    // beside a plural headline would attribute it to all four.
    expect(a.evidence.find((e) => e.source === "Registered, never reported")).toBeUndefined();
    expect(a.evidence.find((e) => e.source === "Sites with no nightly reports")?.detail).toBe(
      "Fee Codes, Pull-up Standards, Area Lookup, Pacer Test",
    );
  });

  it("keeps the singular sentence for a group of one — no plural over one asset", () => {
    const a = translateAlert({ ...neverReported, members: [{ assetDisplayName: "Fee Codes" }] });
    expect(a.headline).toBe("No nightly report has EVER arrived");
  });
});

describe("asset-pull-failed — the fetch the OS could not make", () => {
  const base = {
    ruleId: "asset-pull-failed",
    metric: null,
    message: "pull failed: 401 unauthorized — token expired",
  };

  it("counts the nights it has been failing and names the latest cause", () => {
    const a = translateAlert({
      ...base,
      ruleInputs: {
        rule: "asset-pull-failed",
        url: "https://nosh.example/api/os/report",
        status: 401,
        error: "401 unauthorized — token expired",
        providerError: "unauthorized",
        providerMessage: "token expired",
        failureCount: 5,
        lastFailedAt: "2026-07-25T02:30:00.000Z",
      },
    });
    expect(a.headline).toBe("Nightly report fetch failing 5 nights — latest: 401 unauthorized");
    expect(a.hint).toBe("the fetch credentials may have expired");
    expect(a.evidence.find((e) => e.source === "Failed fetches")?.detail).toBe("5 since the first");
    // The endpoint is the URL itself — no config-file path on a view surface.
    expect(a.evidence.find((e) => e.source === "Endpoint")?.detail).toBe("https://nosh.example/api/os/report");
  });

  it("reads as a single failure on the first night", () => {
    const a = translateAlert({
      ...base,
      message: "pull failed: non-200 response (503)",
      ruleInputs: {
        rule: "asset-pull-failed",
        url: "https://nosh.example/api/os/report",
        status: 503,
        error: "non-200 response (503)",
        failureCount: 1,
        lastFailedAt: "2026-07-25T02:30:00.000Z",
      },
    });
    expect(a.headline).toBe("Nightly report fetch failed — non-200 response (503)");
    expect(a.hint).toBe("the site's endpoint is erroring");
    // A first-night failure has no duration worth a row.
    expect(a.evidence.some((e) => e.source === "Failed fetches")).toBe(false);
  });

  it("reads a missing status as unreachable rather than inventing one", () => {
    const a = translateAlert({
      ...base,
      message: "pull failed: fetch failed",
      ruleInputs: {
        rule: "asset-pull-failed",
        url: "https://nosh.example/api/os/report",
        status: null,
        error: "fetch failed",
        failureCount: 2,
        lastFailedAt: "2026-07-25T02:30:00.000Z",
      },
    });
    expect(a.headline).toBe("Nightly report fetch failing 2 nights — latest: fetch failed");
    expect(a.hint).toBe("the endpoint may be unreachable");
  });

  // ro-ujb9.220: each failed night is a stored reading; the Evidence lists them.
  it("lists each stored night in the response's own words, newest first, instead of the latest alone", () => {
    const night = (at: string, status: number, error: string, providerError?: string) => ({
      at,
      message: `pull failed: ${error}`,
      ruleInputs: { rule: "asset-pull-failed", status, error, ...(providerError ? { providerError } : {}) },
    });
    const readings = [
      night("2026-07-25T02:30:00.000Z", 401, "401 unauthorized — token expired", "unauthorized"),
      night("2026-07-24T02:30:00.000Z", 503, "503 unconfigured — set CF_ACCOUNT_ID", "unconfigured"),
    ];
    const a = translateAlert({
      ...base,
      readings,
      ruleInputs: {
        rule: "asset-pull-failed",
        url: "https://nosh.example/api/os/report",
        status: 401,
        error: "401 unauthorized — token expired",
        providerError: "unauthorized",
        failureCount: 2,
        lastFailedAt: "2026-07-25T02:30:00.000Z",
      },
    });
    // The headline still speaks for tonight.
    expect(a.headline).toBe("Nightly report fetch failing 2 nights — latest: 401 unauthorized");
    expect(a.evidence.filter((e) => e.source === "Failed fetch")).toEqual([
      { polarity: "supporting", source: "Failed fetch", detail: "401 unauthorized — token expired", at: "2026-07-25T02:30:00.000Z" },
      { polarity: "supporting", source: "Failed fetch", detail: "503 unconfigured — set CF_ACCOUNT_ID", at: "2026-07-24T02:30:00.000Z" },
    ]);
    // The newest night IS the latest response, so it is not repeated.
    expect(a.evidence.some((e) => e.source === "Latest response")).toBe(false);
  });

  it("names a night's cause the same way on the alert and on the site's list", () => {
    expect(pullFailureCause({ status: 401, providerError: "unauthorized", error: "401 unauthorized — x" })).toBe("401 unauthorized");
    expect(pullFailureCause({ status: 502, error: "non-200 response (502): gateway" })).toBe("non-200 response (502): gateway");
    expect(pullFailureCause({ status: 504 })).toBe("HTTP 504");
    expect(pullFailureCause(null)).toBeNull();
  });
});

describe("asset-declared — the asset's own words", () => {
  it("translates Nosh's bounded poisson signature and keeps every number as evidence", () => {
    const a = translateAlert({
      ruleId: "asset-declared",
      metric: "apiRequests",
      message: "last24h 51 vs avg7d 86.4 (rule poisson-24h, P<=0.000026)",
      ruleInputs: {
        source: "envelope",
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        msg: "last24h 51 vs avg7d 86.4 (rule poisson-24h, P<=0.000026)",
      },
    });

    expect(a.headline).toBe("Api requests well below normal — 51 vs ~86/day");
    assertNoStatistics(a.headline);
    expect(a.evidence.map((row) => row.source)).toEqual([
      "Arrived",
      "Normal · site's 7-day average",
      "Site's own rule · poisson-24h",
    ]);
    expect(a.evidence[0]!.detail).toBe("51 in 24h");
    expect(a.evidence[1]!.detail).toBe("86.4/day");
    expect(a.evidence[2]!.detail).toContain("P≤0.000026");
  });

  it("keeps scientific-notation probability exact instead of rounding it to zero", () => {
    const a = translateAlert({
      ruleId: "asset-declared",
      metric: "apiRequests",
      message: "last24h 35 vs avg7d 84.0 (rule poisson-24h, P<=1.2e-9)",
      ruleInputs: {
        metric: "apiRequests",
        msg: "last24h 35 vs avg7d 84.0 (rule poisson-24h, P<=1.2e-9)",
      },
    });
    expect(a.headline).toBe("Api requests well below normal — 35 vs ~84/day");
    expect(a.evidence[2]!.detail).toContain("P≤1.2e-9");
    expect(a.evidence[2]!.detail).toContain("less than 0.01%");
  });

  it("passes the asset's sentence through untouched", () => {
    const a = translateAlert({
      ruleId: "asset-declared",
      metric: "signups",
      message: "4300 signups",
      ruleInputs: { source: "envelope", severity: "info", kind: "milestone", metric: "signups", msg: "4300 signups" },
    });
    expect(a.headline).toBe("4300 signups");
    expect(a.hint).toBeUndefined();
    expect(a.evidence[0]!.source).toBe("Raised by");
    expect(a.evidence[0]!.detail).toBe("the site's own nightly report · no statistics attached");
  });

  it("does not half-parse a malformed or different asset declaration", () => {
    const a = translateAlert({
      ruleId: "asset-declared",
      metric: "apiRequests",
      message: "last24h unclear vs avg7d 86.4 (rule poisson-24h)",
      ruleInputs: null,
    });
    expect(a.headline).toBe(
      "last24h unclear vs avg7d 86.4 (rule poisson-24h)",
    );
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0]!.source).toBe("Raised by");
  });
});

describe("hygiene failures — the check result, not its collector vocabulary", () => {
  it("turns a blocked home-page check into a short decision and keeps the URL in evidence", () => {
    const a = translateAlert({
      ruleId: "hygiene-home-unreachable",
      metric: "html-depth",
      message: "home page did not serve: https://nosh.example/ answered HTTP 403",
      ruleInputs: {
        rule: "hygiene-home-unreachable",
        check: "html-depth",
        occurrences: 2,
        lastObservedAt: "2026-08-05T04:00:00.040Z",
        url: "https://nosh.example/",
        http_status: 403,
        error: "non-200 response (403)",
      },
    });
    expect(a.headline).toBe("Home page check failed — HTTP 403");
    expect(a.hint).toBe("the site may be blocking the checker");
    expect(a.headline).not.toMatch(/html depth|https?:/i);
    expect(a.evidence.find((row) => row.source === "URL checked")?.detail).toBe(
      "https://nosh.example/",
    );
    expect(a.evidence.find((row) => row.source === "Checks in a row")?.detail).toBe("2");
  });

  it("names a missing sitemap without printing its URL in the headline", () => {
    const a = translateAlert({
      ruleId: "hygiene-sitemap",
      metric: "sitemap",
      message:
        "sitemap unreachable at https://pullups.example/sitemap.xml (non-200 response (404))",
      ruleInputs: {
        rule: "hygiene-sitemap",
        check: "sitemap",
        occurrences: 4,
        url: "https://pullups.example/sitemap.xml",
        http_status: 404,
        error: "non-200 response (404)",
      },
    });
    expect(a.headline).toBe("Sitemap check failed — HTTP 404");
    expect(a.hint).toBe("the sitemap may be missing or moved");
    expect(a.headline).not.toContain("pullups.example");
  });

  // `ro-kukv.6`, the copy defect the bead recorded: nosh.example showed "Sitemap
  // check failed — HTTP 200" after a manual hygiene run. A success status
  // quoted beside the word FAILED reads as a contradiction and says nothing
  // about what to do. The sitemap answered; it just was not a sitemap.
  it("never quotes a success status beside the word failed", () => {
    const a = translateAlert({
      ruleId: "hygiene-sitemap",
      metric: "sitemap",
      message:
        "sitemap at https://nosh.example/sitemap.xml is not parseable XML (no <urlset>/<sitemapindex> root)",
      ruleInputs: {
        rule: "hygiene-sitemap",
        check: "sitemap",
        reason: "unparseable",
        url: "https://nosh.example/sitemap.xml",
        http_status: 200,
        content_type: "text/html; charset=utf-8",
        bytes: 41_233,
      },
    });
    expect(a.headline).toBe("Sitemap returned 200 but did not parse");
    expect(a.headline).not.toContain("failed");
    expect(a.hint).toBe("the URL may be serving a page instead of XML");
  });

  it("says what a 200 sitemap actually did wrong, per stored reason", () => {
    const collapsed = translateAlert({
      ruleId: "hygiene-sitemap",
      metric: "sitemap",
      message: "sitemap URL count collapsed: 12 URLs vs 4200 on 2026-08-30",
      ruleInputs: {
        rule: "hygiene-sitemap",
        reason: "count-collapse",
        url: "https://nosh.example/sitemap.xml",
        http_status: 200,
        urls: 12,
        previous_urls: 4200,
      },
    });
    expect(collapsed.headline).toBe("Sitemap shrank to 12 URLs — was 4,200");
    expect(collapsed.hint).toBe("pages may have dropped out of the sitemap");

    const children = translateAlert({
      ruleId: "hygiene-sitemap",
      metric: "sitemap",
      message: "sitemap index points at 2 child sitemap(s) that could not be read",
      ruleInputs: {
        rule: "hygiene-sitemap",
        reason: "child-unreachable",
        url: "https://nosh.example/sitemap.xml",
        http_status: 200,
        children_failed: ["https://nosh.example/sitemap-1.xml", "https://nosh.example/sitemap-2.xml"],
      },
    });
    expect(children.headline).toBe("Sitemap index has 2 child sitemaps the OS could not read");
    expect(children.headline).not.toContain("HTTP 200");
    // The unreadable children are a value, not the stored sentence (bead
    // ro-ujb9.96.6.26).
    expect(children.evidence).toContainEqual(
      expect.objectContaining({ source: "First unreadable", detail: "https://nosh.example/sitemap-1.xml · +1 more" }),
    );
  });
});

// Each of these rules stored a sentence of 15 to 26 words that Alerts drew
// word for word. The store now keeps a short headline with its values, and the
// row draws the figures as label · value evidence (bead ro-ujb9.96.6.26).
describe("site checks and quota — a headline and its values, never the rule's sentence", () => {
  const AT = "2026-09-06T04:30:00.000Z";

  it("hygiene-html-depth: the words served against the median", () => {
    const a = translateAlert({
      ruleId: "hygiene-html-depth",
      metric: "html-depth",
      message: "home page HTML fell to 120 words (median 860)",
      ruleInputs: {
        rule: "hygiene-html-depth", check: "html-depth", lastObservedAt: AT, url: "https://example.com/",
        http_status: 200, words: 120, baseline_median: 860, baseline_readings: 14, threshold_ratio: 0.5,
      },
    });
    expect(a.headline).toBe("Home page HTML fell to 120 words — was 860");
    expect(a.evidence.map((row) => [row.source, row.detail])).toEqual([
      ["Words served", "120"],
      ["Normal · median", "860 over 14 readings"],
      ["Fires at", "50% of the median"],
      ["URL checked", "https://example.com/"],
    ]);
  });

  it("hygiene-robots-ai: a robots.txt that stopped being served, and newly blocked crawlers", () => {
    const vanished = translateAlert({
      ruleId: "hygiene-robots-ai",
      metric: "robots-ai-access",
      message: "robots.txt no longer served (HTTP 404) · allowed 5 of 7 AI crawlers",
      ruleInputs: {
        rule: "hygiene-robots-ai", lastObservedAt: AT, url: "https://example.com/robots.txt", http_status: 404,
        present: false, robots_vanished: true, lost_bots: [], previous_observed_on: "2026-09-05",
        previous_bots: { GPTBot: true, ClaudeBot: true, PerplexityBot: true, "Google-Extended": true, CCBot: true, Bytespider: false, "Applebot-Extended": false },
      },
    });
    expect(vanished.headline).toBe("robots.txt no longer served — HTTP 404");
    expect(vanished.evidence).toContainEqual(expect.objectContaining({ source: "Allowed before", detail: "5 of 7 AI crawlers" }));

    const lost = translateAlert({
      ruleId: "hygiene-robots-ai",
      metric: "robots-ai-access",
      message: "AI crawler access lost: GPTBot, ClaudeBot newly disallowed by robots.txt",
      ruleInputs: { rule: "hygiene-robots-ai", lastObservedAt: AT, http_status: 200, present: true, robots_vanished: false, lost_bots: ["GPTBot", "ClaudeBot"] },
    });
    expect(lost.headline).toBe("GPTBot and ClaudeBot newly blocked by robots.txt");
    expect(lost.evidence).toContainEqual(expect.objectContaining({ source: "Newly disallowed", detail: "GPTBot, ClaudeBot" }));
  });

  it("hygiene-page-directives and page-structure: the count, then one row per page", () => {
    const pages = [
      { url: "https://example.com/guide", read: true, blocking: ["noindex"], faults: ["title-missing"] },
      { url: "https://example.com/tools?x=1", read: false, blocking: [], faults: [] },
      { url: "https://example.com/about", read: true, blocking: [], faults: [] },
    ];
    const directives = translateAlert({
      ruleId: "hygiene-page-directives",
      metric: "robots-ai-access",
      message: "crawler directives closed 2 of 3 sampled pages",
      ruleInputs: { rule: "hygiene-page-directives", lastObservedAt: AT, pages, pages_sampled: 3, blocked_urls: ["https://example.com/guide", "https://example.com/tools?x=1"] },
    });
    expect(directives.headline).toBe("Crawler directives closed 2 of 3 sampled pages");
    expect(directives.evidence.map((row) => [row.source, row.detail])).toEqual([
      ["/guide", "noindex"],
      ["/tools?x=1", "not re-checked"],
    ]);

    const structure = translateAlert({
      ruleId: "hygiene-page-structure",
      metric: "page-structure",
      message: "page structure regressed on 1 of 3 sampled pages",
      ruleInputs: { rule: "hygiene-page-structure", lastObservedAt: AT, pages, pages_sampled: 3, faulty_urls: ["https://example.com/guide"] },
    });
    expect(structure.headline).toBe("Page structure regressed on 1 of 3 sampled pages");
    expect(structure.evidence.map((row) => [row.source, row.detail])).toEqual([["/guide", "title-missing"]]);
  });

  it("ga4-quota-pressure: the share left, with the tokens and the lane as rows", () => {
    const a = translateAlert({
      ruleId: "ga4-quota-pressure",
      metric: "ga4-quota",
      message: "GA4 daily quota at 5% for properties/123",
      ruleInputs: {
        rule: "ga4-quota-pressure", lane: "google-signals", propertyRef: "properties/123", lastObservedAt: AT,
        threshold_ratio: 0.2,
        pressured: [
          { bucket: "tokensPerDay", consumed: 190_000, remaining: 10_000, share: 0.05 },
          { bucket: "tokensPerHour", consumed: 30_000, remaining: 6_000, share: 0.167 },
        ],
      },
    });
    expect(a.headline).toBe("GA4 daily quota low — 5% left");
    expect(a.evidence.map((row) => [row.source, row.detail])).toEqual([
      ["Tokens left", "10,000 of 200,000"],
      ["Fires below", "20%"],
      ["Spent by", "Google"],
      ["GA4 property", "properties/123"],
    ]);
  });

  it("falls back to the stored headline when a row carries no inputs, never a blank", () => {
    for (const ruleId of ["hygiene-html-depth", "hygiene-robots-ai", "hygiene-page-directives", "hygiene-page-structure", "ga4-quota-pressure"]) {
      expect(translateAlert({ ruleId, metric: null, message: "stored words", ruleInputs: {} }).headline).toBe("stored words");
    }
  });
});

describe("os-egress-down — the outage that is the OS's own", () => {
  const outage: AlertFacts = {
    ruleId: "os-egress-down",
    metric: null,
    message: "OS egress down — 3 assets unmeasured",
    ruleInputs: {
      rule: "os-egress-down",
      beacons: [
        {
          url: "https://www.cloudflare.com/cdn-cgi/trace",
          error: "internal error; reference = 0d9f4a2c",
        },
        {
          url: "https://www.google.com/generate_204",
          error: "internal error; reference = 4b71e0aa",
        },
      ],
      unmeasuredAssets: ["meals.example", "nosh.example", "fees.example"],
      failureCount: 2,
      lastFailedAt: "2026-08-09T04:00:00.000Z",
      evaluatedAt: "2026-08-09T04:00:00.000Z",
    },
  };

  it("says whose fault tonight's silence is, before anything else", async () => {
    const a = translateAlert(outage);
    // The OS leads the sentence, so whose fault it is needs no clause; the
    // hint is the one move the operator has.
    expect(a.headline).toBe("OS is offline — 3 sites not checked");
    expect(a.headline).not.toMatch(/egress/i);
    expect(a.hint).toBe("check this machine's internet connection");
    assertNoStatistics(a.headline);
  });

  it("keeps the reference sites' own errors verbatim — they are the whole argument", () => {
    const a = translateAlert(outage);
    const beacons = a.evidence.find((e) => e.source === "Reference sites that did not answer")!;
    // Two unrelated operators failing the same way is what licenses suppressing
    // the asset alerts; a paraphrase would not be evidence of anything.
    expect(beacons.detail).toContain("cloudflare.com");
    expect(beacons.detail).toContain("google.com");
    expect(beacons.detail).toContain("internal error; reference = 0d9f4a2c");
    expect(beacons.at).toBe("2026-08-09T04:00:00.000Z");
  });

  it("counts the checks it has been down for and names the assets it stood in for", () => {
    const a = translateAlert(outage);
    expect(a.evidence.find((e) => e.source === "Failed connectivity checks")?.detail).toBe(
      "2 since the first",
    );
    const skipped = a.evidence.find((e) => e.source === "Not checked tonight")!;
    expect(skipped.detail).toBe("meals.example, nosh.example, fees.example");
  });

  it("drops the duration row on the first observation", () => {
    const a = translateAlert({
      ...outage,
      ruleInputs: { ...outage.ruleInputs, failureCount: 1 },
    });
    expect(a.evidence.some((e) => e.source === "Failed connectivity checks")).toBe(false);
  });

  it("falls back to the stored message when the inputs are unreadable", () => {
    const a = translateAlert({ ...outage, ruleInputs: null });
    expect(a.headline).toBe("OS egress down — 3 assets unmeasured");
    expect(a.evidence).toEqual([]);
  });

  it("says the connection is back while collectors still owe a re-check (ro-aed0.5)", () => {
    // Open only for the gaps the outage left: pointing the operator at the
    // router now would send them to fix something that is already fine.
    const a = translateAlert({
      ...outage,
      message: "OS connection back — 2 properties not yet re-checked",
      ruleInputs: {
        ...outage.ruleInputs,
        unmeasuredAssets: ["nosh.example", "fees.example"],
        connectionBackAt: "2026-08-09T12:15:00.000Z",
      },
    });
    expect(a.headline).toBe("OS connection back — 2 sites not yet re-checked");
    expect(a.hint).toBe("no action needed");
    expect(a.hint).not.toContain("connection is out");
    expect(a.evidence.find((e) => e.source === "Connection answered again")).toMatchObject({
      polarity: "against",
      at: "2026-08-09T12:15:00.000Z",
    });
    expect(a.evidence.find((e) => e.source === "Not checked tonight")!.detail).toContain(
      "nosh.example, fees.example",
    );
  });

  it("names the collectors still owed a re-run instead of explaining the wait (ro-aed0.5)", () => {
    const a = translateAlert({
      ...outage,
      message: "OS connection back — 2 properties not yet re-checked",
      ruleInputs: {
        ...outage.ruleInputs,
        unmeasuredAssets: ["nosh.example", "fees.example"],
        connectionBackAt: "2026-08-09T12:15:00.000Z",
        lanes: { "google-signals": { unmeasured: ["nosh.example"] }, dataforseo: { unmeasured: ["fees.example"] } },
      },
    });
    expect(a.evidence.find((e) => e.source === "Connection answered again")!.detail).toBe(
      "Waiting on Google, search rankings",
    );
  });
});

describe("watch-window-closed — a verdict becomes a clear next decision", () => {
  const watch = {
    ruleId: "watch-window-closed",
    metric: "clicks",
    message: "watch window kill_confirmed — gsc/clicks at +7d: 10/day → 7/day (-30%)",
    ruleInputs: {
      outcome: "kill_confirmed",
      refKind: "bead",
      ref: "mp-123",
      integration: "gsc",
      metric: "clicks",
      registeredAt: "2026-07-01T03:30:00.000Z",
      evaluatedAt: "2026-07-08T03:30:00.000Z",
      reading: { delta_pct: -30 },
    },
  } satisfies AlertFacts;

  it("states the revert decision without pretending rollback already happened", () => {
    const a = translateAlert(watch);
    expect(a.headline).toBe("Revert decision needed — Clicks down 30%");
    expect(a.headline).not.toMatch(/rollback|reverted/i);
    expect(a.hint).toContain("decide whether to revert");
    expect(a.evidence).toEqual([
      {
        polarity: "supporting",
        source: "Watched change",
        detail: "bead mp-123",
        at: "2026-07-01T03:30:00.000Z",
      },
      {
        polarity: "supporting",
        source: "Outcome signal",
        detail: "gsc · clicks · down 30%",
        at: "2026-07-08T03:30:00.000Z",
      },
    ]);
  });

  it("keeps the other registered outcomes visually distinct", () => {
    expect(
      translateAlert({ ...watch, ruleInputs: { ...watch.ruleInputs, outcome: "ship_confirmed", reading: { delta_pct: 18.5 } } }).headline,
    ).toBe("Growth threshold met — Clicks up 18.5%");
    expect(
      translateAlert({ ...watch, ruleInputs: { ...watch.ruleInputs, outcome: "inconclusive", reading: { delta_pct: 2 } } }).headline,
    ).toBe("Outcome remains inconclusive — Clicks up 2%");
    expect(
      translateAlert({ ...watch, ruleInputs: { ...watch.ruleInputs, outcome: "unmeasurable", reading: null } }).headline,
    ).toBe("Outcome could not be measured");
  });

  // `ro-kukv.3`, observed 2026-08-31 on meals.example's Current signals:
  // "Revert decision needed — Position up 10.14%", amber, beside the word
  // revert. A search position that RISES is a search position that got worse,
  // and the operator had to work that out from the metric's name.
  describe("a metric where up is bad never reads 'up'", () => {
    const position = {
      ...watch,
      metric: "position",
      ruleInputs: {
        ...watch.ruleInputs,
        metric: "position",
        reading: { delta_pct: 10.14 },
      },
    } satisfies AlertFacts;

    it("says the position WORSENED when the number rose", () => {
      const a = translateAlert(position);
      expect(a.headline).toBe("Revert decision needed — Position worsened 10.14%");
      expect(a.headline).not.toMatch(/\bup\b/i);
    });

    it("says the position IMPROVED when the number fell", () => {
      expect(
        translateAlert({
          ...position,
          ruleInputs: { ...position.ruleInputs, outcome: "ship_confirmed", reading: { delta_pct: -6 } },
        }).headline,
      ).toBe("Growth threshold met — Position improved 6%");
    });

    it("carries the same words into the outcome evidence", () => {
      const signal = translateAlert(position).evidence.find(
        (row) => row.source === "Outcome signal",
      );
      expect(signal?.detail).toBe("gsc · position · worsened 10.14%");
    });

    // The polarity table is `WATCH_SERIES`, but a rule can fire on a metric it
    // has never listed. A rank series must not be able to reach a headline
    // saying "up" just because nobody registered it yet.
    it("refuses 'up' on an unregistered rank metric too", () => {
      const headline = translateAlert({
        ...position,
        metric: "avgSerpRank",
        ruleInputs: {
          ...position.ruleInputs,
          integration: "dataforseo",
          metric: "avgSerpRank",
          reading: { delta_pct: 4 },
        },
      }).headline;
      expect(headline).toBe("Revert decision needed — Avg serp rank worsened 4%");
      expect(headline).not.toMatch(/\bup\b/i);
    });

    it("leaves higher-is-better metrics reading up and down", () => {
      expect(translateAlert(watch).headline).toBe("Revert decision needed — Clicks down 30%");
      expect(
        translateAlert({
          ...watch,
          ruleInputs: { ...watch.ruleInputs, integration: "ga4", metric: "sessions", outcome: "ship_confirmed", reading: { delta_pct: 12 } },
        }).headline,
      ).toBe("Growth threshold met — Sessions up 12%");
    });

    it("stays flat at zero on either polarity", () => {
      expect(
        translateAlert({ ...position, ruleInputs: { ...position.ruleInputs, reading: { delta_pct: 0 } } }).headline,
      ).toBe("Revert decision needed — Position flat");
      expect(
        translateAlert({ ...watch, ruleInputs: { ...watch.ruleInputs, reading: { delta_pct: 0 } } }).headline,
      ).toBe("Revert decision needed — Clicks flat");
    });
  });
});

describe("unknown rules — degrade, never blank", () => {
  it("falls back to the stored message, keeping the metric as context", () => {
    const a = translateAlert({
      ruleId: "serp-position-loss",
      metric: "avgPosition",
      message: "slipped from 4.1 to 9.7 for 12 tracked terms",
      ruleInputs: { whatever: true },
    });
    expect(a.headline).toBe("Avg position — slipped from 4.1 to 9.7 for 12 tracked terms");
    expect(a.evidence).toEqual([]);
  });

  it("still says something when even the message is missing", () => {
    const mystery = { ruleId: "mystery", ruleInputs: null };
    expect(translateAlert({ ...mystery, metric: "leads", message: null }).headline).toBe(
      "Leads alert",
    );
    expect(translateAlert({ ...mystery, metric: null, message: "  " }).headline).toBe("Alert fired");
  });
});

// --- correlated changes -----------------------------------------------------

const FIRED = "2026-07-26T02:30:00.000Z";
const hoursBefore = (h: number): string => new Date(Date.parse(FIRED) - h * 3_600_000).toISOString();

function change(id: number, at: string, kind: AnnotationItem["kind"], ref: string): AnnotationItem {
  return { id, at, kind, ref, note: null };
}

describe("correlateChanges", () => {
  it("keeps only what landed inside the window BEFORE the alert", () => {
    const changes = [
      change(1, hoursBefore(14), "deploy", "inside"),
      change(2, hoursBefore(CORRELATION_WINDOW_HOURS + 1), "deploy", "too-old"),
      change(3, hoursBefore(-2), "deploy", "after-the-alert"),
    ];
    expect(correlateChanges(changes, FIRED).map((c) => c.ref)).toEqual(["inside"]);
  });

  it("orders nearest the alert first", () => {
    const changes = [
      change(1, hoursBefore(40), "deploy", "far"),
      change(2, hoursBefore(2), "config", "near"),
    ];
    expect(correlateChanges(changes, FIRED).map((c) => c.ref)).toEqual(["near", "far"]);
  });

  it("returns nothing for an unparseable fired_at rather than guessing", () => {
    expect(correlateChanges([change(1, hoursBefore(1), "deploy", "x")], "not-a-date")).toEqual([]);
  });
});

describe("changesLabel", () => {
  it("names a single change and dates it against the alert", () => {
    expect(changesLabel([change(1, hoursBefore(14), "deploy", "a1b2c3d")], FIRED)).toBe(
      "deploy 14h before",
    );
    expect(changesLabel([change(1, hoursBefore(3), "model-change", "opus")], FIRED)).toBe(
      "model change 3h before",
    );
  });

  it("counts several of one kind", () => {
    const two = [change(1, hoursBefore(4), "deploy", "a"), change(2, hoursBefore(20), "deploy", "b")];
    expect(changesLabel(two, FIRED)).toBe("2 deploys in the 2 days before");
  });

  it("collapses mixed kinds rather than listing them", () => {
    const mixed = [change(1, hoursBefore(4), "deploy", "a"), change(2, hoursBefore(20), "config", "b")];
    expect(changesLabel(mixed, FIRED)).toBe("2 changes in the 2 days before");
  });

  it("says nothing at all when nothing correlates", () => {
    expect(changesLabel([], FIRED)).toBeNull();
  });
});
