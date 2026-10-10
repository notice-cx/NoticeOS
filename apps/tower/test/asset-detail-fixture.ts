import type { AssetDetailPayload, ProductUseSnapshot } from "@shared/asset-detail";
import {
  ALL_ASSET_DETAIL_SECTIONS,
  ASSET_SECTION_FIELDS,
  ASSET_VIEW_SECTIONS,
  type AssetDetailResponse,
  type AssetDetailView,
} from "@shared/asset-detail-views";

/**
 * One asset report with something on every tab, shared by the suites that
 * draw the whole asset page from it: `asset-detail-tabs.test.tsx`, which
 * records each tab's DOM, and `lazy-parts.test.tsx`, which opens the tabs one
 * at a time. Dates are fixed and assume the suites pin `Date.now()` to
 * 2026-07-05T14:00:00Z and the zone to UTC.
 */

const emptyTrend = () => ({
  series: [],
  provisionalFrom: null,
  collectedAt: null,
  timeZoneChanges: [],
});

const noSecondarySeries = () => ({
  sessions: emptyTrend(),
  pageViews: emptyTrend(),
  events: emptyTrend(),
  searchCtr: emptyTrend(),
  searchPosition: emptyTrend(),
});

const productUseSnapshot: ProductUseSnapshot = {
  windowStart: "2026-07-02",
  windowEnd: "2026-07-29",
  days: 28,
  build: [
    {
      key: "item-openers",
      eventName: "builder_item_open",
      label: "Opened an item",
      users: 233,
      events: 649,
    },
    {
      key: "builder-users",
      eventName: "builder_add_to_order",
      label: "Added to an order",
      users: 85,
      events: 179,
    },
  ],
  sharing: [
    {
      key: "share-openers",
      eventName: "order_share_open",
      label: "Opened sharing",
      users: 1,
      events: 1,
    },
  ],
  supporting: [
    {
      key: "guide-follow-through",
      eventName: "guide_next_click",
      label: "Followed a guide",
      users: 365,
      events: 498,
    },
  ],
  source: "ga4/events-28d",
  caveat: "Users are unique within each event.",
};

const gscLane = {
  catalog: {
    id: "gsc",
    label: "Google Search Console",
    docRef: "docs/11-integrations.md#the-catalog",
    scope: "property" as const,
    layer: "provider" as const,
    usage: { cost: "free" as const },
    onFailure: "keeps-last-data" as const,
    credential: "shared" as const,
    derived: false,
  },
  cell: {
    assetId: "meals.example",
    laneId: "gsc",
    declared: "needs-setup" as const,
    effective: "needs-setup" as const,
    evidence: [],
    note: "No successful collector run yet.",
    ref: null,
    since: "2026-07-06",
  },
  mapping: [],
  mappingSource: "fallback" as const,
};

/** One payload with something to say on every tab: an open alert, a recorded
 * change, a mixed accounting month, a product-use window, a source that is
 * not set up, a tracked panel, a page-decision window and a search-context
 * snapshot. A tab that rendered its empty state would pin nothing. */
export function everyTabPayload(): AssetDetailPayload {
  return {
    generatedAt: "2026-07-05T12:00:00.000Z",
    osTimeZone: "America/Los_Angeles",
    asset: {
      id: "meals.example",
      displayName: "Meal Planner",
      domain: "meals.example",
      status: "live",
      senseOnly: false,
      isOs: false,
      firstReportAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      worstOpenSeverity: "error",
      openError: 1,
      openWarn: 0,
    },
    scheduledLanes: null,
    countersConfig: null,
    panelConfig: {
      trackedQueries: null,
      roster: {
        enabled: true,
        reason: "live-lanes",
        note: "GSC + GA4 live.",
        since: "2026-08-03",
      },
    },
    wiring: {
      mode: "push",
      modeOwner: "config/pull.json",
      cadence: "nightly",
      schedule: null,
      cadenceOwner: "workers/ingest",
      pull: null,
      push: {
        endpoint: "POST /api/pulse",
        endpointOwner: "workers/ingest",
        auth: "Site token",
        authOwner: "workers/ingest/.dev.vars",
      },
      lastPulseReceivedAt: "2026-07-05T02:00:00.000Z",
      lastPulseDate: "2026-07-05",
      pullFailure: null,
      ingestFreshness: null,
    },
    rules: {
      scope: "portfolio-default",
      hasOverride: false,
      knobs: [],
    },
    portfolio: { owner: "config/constants.json", note: "portfolio-wide", knobs: [] },
    performance: {
      ...noSecondarySeries(),
      activeUsers: {
        series: [
          { t: "2026-06-28", v: 90 },
          { t: "2026-06-29", v: 100 },
          { t: "2026-06-30", v: 104 },
          { t: "2026-07-01", v: 110 },
          { t: "2026-07-02", v: 106 },
          { t: "2026-07-03", v: 94 },
          { t: "2026-07-04", v: 70 },
          { t: "2026-07-05", v: 99 },
        ],
        provisionalFrom: "2026-07-05",
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
      webSearchClicks: {
        google: {
          series: [
            { t: "2026-06-28", v: 45 },
            { t: "2026-06-29", v: 52 },
            { t: "2026-06-30", v: 55 },
            { t: "2026-07-01", v: 57 },
            { t: "2026-07-02", v: 50 },
            { t: "2026-07-03", v: 43 },
            { t: "2026-07-04", v: 31 },
            { t: "2026-07-05", v: 60 },
          ],
          provisionalFrom: "2026-07-05",
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
        bing: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      },
      webSearchImpressions: {
        google: {
          series: [
            { t: "2026-06-28", v: 900 },
            { t: "2026-06-29", v: 1000 },
            { t: "2026-06-30", v: 1040 },
            { t: "2026-07-01", v: 1100 },
            { t: "2026-07-02", v: 1060 },
            { t: "2026-07-03", v: 940 },
            { t: "2026-07-04", v: 700 },
            { t: "2026-07-05", v: 990 },
          ],
          provisionalFrom: "2026-07-05",
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
        bing: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      },
    },
    executive: {
      schemaVersion: 1,
      asset: "meals.example",
      generatedAt: "2026-07-05T11:30:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-04",
      sourceArchiveCount: 12,
      items: [
        {
          key: "search-striking-distance",
          kind: "recommendation",
          title: "Move “weekly meal plan” into the top results",
          summary: "/meal-plan is visible at position 6.1 with existing demand.",
          whyItMatters: "The page already earns impressions below the highest-click positions.",
          primary: { value: "1,003", label: "captured impressions" },
          confidence: "high",
          windowStart: "2026-07-01",
          windowEnd: "2026-07-04",
          evidence: [{ label: "Average position", value: "6.1" }],
          sources: ["gsc/page-query", "bing-webmaster/queries"],
          caveat: "GSC returns top rows.",
        },
      ],
      suppressedItems: [],
      searchQueries: {
        google: {
          provider: "google",
          currentStart: "2026-07-03",
          currentEnd: "2026-07-04",
          previousStart: "2026-07-01",
          previousEnd: "2026-07-02",
          daysPerWindow: 2,
          movers: [
            {
              query: "weekly meal plan",
              currentImpressions: 140,
              previousImpressions: 100,
              impressionDelta: 40,
              impressionDeltaPercent: 40,
              currentPosition: 6.1,
              previousPosition: 7.4,
              positionImprovement: 1.3,
            },
          ],
          evidence: [
            {
              label: "Grounding queries excluded",
              value: "0",
              detail: "No quoted-literal queries in this window",
            },
          ],
          source: "gsc/query",
          caveat: "Only queries present in both top-row windows are ranked.",
        },
        bing: null,
        dataforseo: {
          observedAt: "2026-07-04",
          queries: [
            {
              query: "weekly meal plan",
              monthlySearches: 1900,
              organicPosition: 7,
              previousOrganicPosition: null,
              positionImprovement: null,
              keywordDifficulty: 24,
              estimatedVisits: 31,
              page: "/meal-plan",
              intent: "informational",
              aiOverview: "cited",
              aiCitationPosition: 2,
              aioDevices: [],
            },
          ],
          source: "dataforseo/ranked-keywords",
          caveat: "Search volume is estimated demand, not impressions.",
        },
      },
      searchPages: {
        provider: "google",
        currentStart: "2026-07-03",
        currentEnd: "2026-07-04",
        previousStart: "2026-07-01",
        previousEnd: "2026-07-02",
        daysPerWindow: 2,
        pages: [
          {
            page: "https://meals.example/meal-plan",
            path: "/meal-plan",
            currentClicks: 61,
            previousClicks: 40,
            clickDelta: 21,
            clickDeltaPercent: 52.5,
            currentImpressions: 1400,
            previousImpressions: 1000,
            impressionDelta: 400,
            impressionDeltaPercent: 40,
            currentPosition: 6.1,
            previousPosition: 7.4,
            positionImprovement: 1.3,
            currentCtr: 0.0436,
            previousCtr: 0.04,
            leadingQuery: {
              query: "weekly meal plan",
              clicks: 44,
              impressions: 900,
              position: 6.1,
              aioDevices: [],
            },
          },
        ],
        evidence: [
          {
            label: "Pages compared",
            value: "1",
            detail: "Present in both windows",
          },
        ],
        source: "gsc/page",
        caveat: "Only pages present in both windows are compared.",
      },
      productUse: productUseSnapshot,
      searchIntelligence: {
        observedAt: "2026-07-04",
        costUsd: 0.42,
        rankings: {
          keywords: 184,
          top3: 6,
          top10: 21,
          top20: 44,
          estimatedVisits: 1320,
          estimatedPaidTrafficCost: 2410,
          aiOverviewReferences: 9,
        },
        backlinks: {
          rank: 212,
          backlinks: 8100,
          referringDomains: 154,
          newReferringDomains: 12,
          lostReferringDomains: 5,
        },
        ai: {
          googleMentions: 4,
          googleSearchVolume: 5400,
          chatgptMentions: 2,
          chatgptSearchVolume: 1300,
        },
        referringDomains: [
          {
            domain: "healthline.com",
            rank: 640,
            backlinks: 12,
            spamScore: 3,
            firstSeen: "2026-02-11T00:00:00.000Z",
          },
        ],
        anchors: {
          sampled: 90,
          spammy: 6,
          spammyDomains: 2,
          top: [
            { anchor: "meal plan", referringDomains: 21, backlinks: 44, spamScore: 4 },
          ],
        },
        keywordIdeas: [
          {
            keyword: "high protein lunch",
            searchVolume: 4400,
            difficulty: 21,
            cpc: 0.62,
            intent: "informational",
          },
        ],
        competitors: [
          {
            domain: "myfooddata.com",
            intersections: 658,
            competitorKeywords: 296392,
            overlapShare: 0.0022,
            avgPosition: 18.4,
          },
        ],
      },
      serpPanel: {
        reportDate: "2026-07-01",
        trackedDepth: 20,
        market: null,
        queries: [
          {
            query: "weekly meal plan",
            device: "desktop",
            label: null,
            bestRank: 12,
            bestUrl: "https://meals.example/meal-plan",
            aioPresent: true,
            aioCitesUs: false,
            composition: null,
          },
          {
            query: "weekly meal plan",
            device: "mobile",
            label: null,
            bestRank: 14,
            bestUrl: "https://meals.example/meal-plan",
            aioPresent: true,
            aioCitesUs: false,
            composition: null,
          },
          {
            query: "high fiber cereals",
            device: "desktop",
            label: null,
            bestRank: null,
            bestUrl: null,
            aioPresent: null,
            aioCitesUs: null,
            composition: null,
          },
        ],
      },
      methodology: ["Missing rows remain unknown."],
    },
    counters: null,
    metrics: [
      {
        name: "signups",
        last24h: 10,
        avg7d: 9.4,
        total: 4233,
        series: [{ t: "2026-07-05", v: 10 }],
      },
    ],
    flags: {
      open: [
        {
          id: 91,
          firedAt: "2026-07-05T02:30:00.000Z",
          severity: "error",
          kind: "anomaly",
          metric: "signups",
          message: "22 in last24h (avg7d 39.3)",
          ruleId: "poisson-low",
          ruleInputs: null,
          correlatedChanges: [],
          disposition: null,
          dispositionAt: null,
          dispositionNote: null,
          snoozeUntil: null,
          ackExpiry: null,
          resolvedAt: null,
          liveness: { state: "live" },
          occurrences: 1,
          firstFiredAt: "2026-07-05T02:30:00.000Z",
        },
      ],
      notCurrent: [],
      snoozed: [],
      history: [
        {
          id: 84,
          firedAt: "2026-07-02T02:30:00.000Z",
          severity: "warn",
          kind: "anomaly",
          metric: "signups",
          message: "31 in last24h (avg7d 39.3)",
          ruleId: "poisson-low",
          ruleInputs: null,
          correlatedChanges: [],
          disposition: "ack",
          dispositionAt: "2026-07-03T09:00:00.000Z",
          dispositionNote: null,
          snoozeUntil: null,
          ackExpiry: null,
          resolvedAt: "2026-07-03T09:00:00.000Z",
          liveness: { state: "historical" },
          occurrences: 1,
          firstFiredAt: "2026-07-02T02:30:00.000Z",
        },
      ],
      openError: 1,
      openWarn: 0,
    },
    ledger: {
      periods: [
        {
          period: "2026-06",
          booked: {
            figure: { currency: 'USD', revenue: 498.1, cost: 0, net: 498.1 },
            revenueByFamily: [{ currency: 'USD', family: "ads", amount: 498.1 }],
            costByFamily: [],
          },
          forecast: {
            figure: { currency: 'USD', revenue: 168.2, cost: 22.1, net: 146.1 },
            revenueByFamily: [{ currency: 'USD', family: "affiliate", amount: 168.2 }],
            costByFamily: [{ currency: 'USD', family: "inference", amount: 22.1 }],
          },
        },
      ],
      recentRows: [
        { currency: 'USD',
          id: 2,
          kind: "revenue",
          period: "2026-06",
          family: "ads",
          amount: 498.1,
          bookingState: "reconciled",
          source: "raptive-report",
          ref: null,
          note: null,
          recordedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
      empty: false,
      currency: "USD",
    },
    decisions: [],
    handoffBeads: [],
    operator: {
      capturedAt: "2026-07-05T11:59:00.000Z",
      waiting: 0,
      urgent: 0,
      items: [],
    },
    annotations: {
      items: [
        {
          id: 41,
          at: "2026-07-04T09:00:00.000Z",
          kind: "deploy",
          ref: null,
          note: "July title batch",
        },
      ],
      olderCount: 0,
    },
    watches: { open: [], closed: [], history: [] },
    reclamation: null,
    hygiene: null,
    fetchFailures: [],
    integrations: {
      sources: [],
      lanes: [gscLane],
      summary: {
        counts: { live: 5, degraded: 1, "needs-setup": 2, skipped: 0, "not-applicable": 1 },
        total: 8,
        needsAttention: 3,
      },
    },
    ga4Config: { valueEvents: null, eventParams: null },
    freshness: {
      pulseReceivedAt: "2026-07-05T02:00:00.000Z",
      ledgerRecordedAt: "2026-07-03T00:00:00.000Z",
      flagFiredAt: "2026-07-05T02:30:00.000Z",
      annotationAt: "2026-07-04T09:00:00.000Z",
    },
    panelReview: null,
    latestPanelDate: null,
  };
}

/**
 * What `GET /api/assets/:id?view=<tab>` answers for this payload's asset: the
 * core and that tab's own sections, every other section absent.
 * `test/asset-detail-payload.test.ts` holds the Worker's output to this shape.
 */
export function viewOf(payload: AssetDetailPayload, view: AssetDetailView): AssetDetailResponse {
  const sectionFields = new Set<string>(ALL_ASSET_DETAIL_SECTIONS.flatMap((section) => ASSET_SECTION_FIELDS[section]));
  const own = new Set<string>(ASSET_VIEW_SECTIONS[view].flatMap((section) => ASSET_SECTION_FIELDS[section]));
  const out: Record<string, unknown> = { view };
  for (const [key, value] of Object.entries(payload)) {
    if (!sectionFields.has(key) || own.has(key)) out[key] = value;
  }
  out.watches = (ASSET_VIEW_SECTIONS[view] as readonly string[]).includes("watchHistory")
    ? payload.watches
    : { open: payload.watches.open, closed: payload.watches.closed };
  return out as unknown as AssetDetailResponse;
}
