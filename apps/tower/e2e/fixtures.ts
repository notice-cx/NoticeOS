// Synthetic, public test data. Never import the owner's config into this harness.
export const JOURNEY_NOW = "2026-09-06T12:00:00.000Z";
export const JOURNEY_ASSET = "journey.example";
export const JOURNEY_KEY = "journey-only-not-a-real-key";
export const JOURNEY_SITE = "https://journey.example/";
/** The fixture's OWN operator clock (bead `ro-ujb9.89`): the saved
 * `os_time_zone` its config store holds and the compiled fallback its Worker
 * is given. Never the checkout's `config/constants.json`, which is whatever
 * the operator of the machine running the suite happens to use. */
export const JOURNEY_TIME_ZONE = "UTC";
/** The store key the fixture's ingest seals its synthetic connections under:
 * 32 public bytes, sealing only the synthetic values above. */
export const JOURNEY_CREDENTIALS_KEY = btoa("journey-only-synthetic-store-key");

export const INITIAL_DOCUMENTS: Record<string, unknown> = {
  "config/constants.json": { os_time_zone: JOURNEY_TIME_ZONE, monthly_caps: { data_usd: 25 }, operator_rate_usd_per_min: 1, flag_defaults: {} },
  "config/integrations.json": { catalog: [
    { id: "bing-webmaster", label: "Bing Webmaster Tools", scope: "property", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md" },
    { id: "ad-network", label: "Ad revenue", scope: "property", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md#mediavine-revenue" },
  ], assets: {} },
  "config/counters.json": { assets: {} },
  "config/pull.json": [],
  "config/tower.json": {},
  "config/serp-panel.json": { assets: {} },
  "config/signal-panels.json": { assets: {} },
  "config/value-events.json": { assets: {} },
  "config/ga4-custom-dimensions.json": { assets: {} },
  "config/domain-costs.json": { orders: [] },
  "config/recurring-costs.json": { costs: [] },
  "config/entities.json": { entities: [] },
  // The bare harness can model unread setup; /__journey/core-tasks models the
  // provisioned core project, without adding any managed user sites.
  "config/beads.json": { hub: null, spokes: [] },
};

/** The fixture's task project: what connecting the task source saves.
 * The harness's fixed host inventory independently matches this descriptor. */
export const JOURNEY_TASK_PROJECT = { asset: JOURNEY_ASSET, prefix: "jt", database: "journey_fixture", repo: "." };
export const JOURNEY_CORE_PROJECT = { asset: "os-journey-core", prefix: "no", database: "noticeos_tasks", repo: "." };

/** Where the fixture's `bd` commands say the task server is: a synthetic
 * loopback address nothing listens on and nothing here connects to. It is the
 * compiled hub connection a local Tower carries (`__BEADS__.hub`), which is
 * what lets the connect panel save a task project (bead ro-ujb9.152); the
 * saved document keeps `hub: null`, as every stored one does. */
export const JOURNEY_TASK_HUB = { host: "127.0.0.1", port: 3399, user: "journey", dataDir: ".journey-task-hub" };

/** An archived site whose id is not its domain, as an imported site's can be
 * (bead ro-ujb9.76.4.6): `/__journey/archived-site` stores it, so adding its
 * domain again meets the store's one-site-per-domain refusal. */
export const JOURNEY_ARCHIVED_SITE = { id: "archived-site", domain: "archived.example", displayName: "Archived Example" };

/** The fixture site's all-time totals in config/counters.json's own shape
 * (bead ro-trai.21): `/__journey/counters` stores a reading for the first two;
 * the third has none, so the Overview leaves it out. */
export const JOURNEY_COUNTER_CARDS = [
  { metric: "accounts", label: "Accounts" },
  { metric: "leads", label: "Leads" },
  { metric: "plans", label: "Plans saved" },
];

/** The remaining property data sources, for journeys that open every Sources
 * row. Synthetic rows in the catalog's own shape, NOT copied from the owner's
 * file. The one long `docRef` is deliberate: it is the longest string an
 * expanded row draws, and a phone must wrap it. */
export const EVERY_SOURCE_CATALOG = [
  { id: "gsc", label: "Google Search Console (GSC API)", scope: "property", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md#the-catalog" },
  { id: "ga4", label: "Google Analytics 4 (GA4 Data API)", scope: "property", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md#the-catalog" },
  { id: "clarity", label: "Microsoft Clarity (data-export API)", scope: "property", layer: "provider", credential: "per-property", docRef: "docs/11-integrations.md#microsoft-clarity-per-project-export-token-and-daily-quota" },
  { id: "posthog", label: "PostHog (product analytics)", scope: "property", layer: "provider", credential: "per-property", docRef: "docs/11-integrations.md#posthog" },
  { id: "dataforseo", label: "DataForSEO search intelligence", scope: "property", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md#the-catalog" },
  { id: "uptime", label: "Uptime monitoring", scope: "both", layer: "provider", credential: "shared", docRef: "docs/11-integrations.md#the-catalog" },
];

export const INJECTED: Record<string, unknown> = {
  __MONTHLY_CAPS__: { dataUsd: 25 }, __FLAG_DEFAULTS__: {}, __PULL_CONFIG__: [],
  __OPERATOR_RATE__: 1, __INTEGRATIONS__: INITIAL_DOCUMENTS["config/integrations.json"],
  __COUNTERS__: INITIAL_DOCUMENTS["config/counters.json"], __DASHBOARD__: {},
  __OS_TIME_ZONE__: JOURNEY_TIME_ZONE, __NO_NIGHTLY_REPORT__: null, __SCHEDULES__: null, __SERP_PANEL__: { assets: {} }, __SIGNAL_PANELS__: { assets: {} },
  __VALUE_EVENTS__: { assets: {} }, __GA4_EVENT_PARAMS__: { assets: {} },
  __DOMAIN_COSTS__: [], __RECURRING_COSTS__: [], __ENTITIES__: [],
  __BEADS__: { hub: JOURNEY_TASK_HUB, spokes: [] }, __RUNNER_LANE__: false,
};

/** One saved finding for the fixture asset (bead ro-ujb9.96.7.11): the
 * analysis snapshot the asset Overview's What matters reads, so a journey can
 * file a task from a finding. Synthetic numbers; no real site. */
export const JOURNEY_FINDING_KEY = "journey-sitemap-drop";
export function journeyFindingSnapshot() {
  return {
    schemaVersion: 1, asset: JOURNEY_ASSET, generatedAt: JOURNEY_NOW, windowStart: "2026-08-30", windowEnd: "2026-09-05",
    sourceArchiveCount: 1, methodology: [], suppressedItems: [],
    items: [{
      key: JOURNEY_FINDING_KEY, kind: "warning", title: "Sitemap URLs fell from 120 to 80",
      summary: "Synthetic fixture finding.", whyItMatters: "Synthetic fixture finding.",
      primary: { value: "-40", label: "Sitemap URLs" }, confidence: "high",
      windowStart: "2026-08-30", windowEnd: "2026-09-05",
      evidence: [{ label: "Before", value: "120" }, { label: "After", value: "80" }],
      sources: ["bing-webmaster/sitemaps"], caveat: "Synthetic fixture: no real site.",
    }],
  };
}

/** A saved analysis whose only collected source is PostHog (bead
 * ro-ujb9.146): 35 days of site use ending the day before the fixture's clock,
 * and no finding. Synthetic numbers; no real site. */
export function journeyPosthogSnapshot() {
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(Date.parse(JOURNEY_NOW) - (35 - index) * 86_400_000).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    const people = (weekend ? 180 : 240) + index * 4;
    return { date, people, pageviews: people * 5, sessions: Math.round(people * 1.4) };
  });
  const windowStart = days[0]!.date;
  const windowEnd = days.at(-1)!.date;
  return {
    schemaVersion: 1, asset: JOURNEY_ASSET, generatedAt: JOURNEY_NOW, windowStart, windowEnd,
    sourceArchiveCount: 1, methodology: [], suppressedItems: [], items: [],
    product: {
      source: "posthog", observedAt: windowEnd, collectedAt: JOURNEY_NOW,
      families: [{ family: "web-daily", reportDate: windowEnd, windowStart, windowEnd, rows: days.length, truncated: false }],
      webDaily: { windowStart, windowEnd, reportDate: windowEnd, days },
      funnels: [], vitals: null, exceptions: null, rageClicks: null, onceEvents: [], checks: [], caveat: "",
    },
  };
}

/** A saved analysis carrying one tracked search panel (bead ro-ujb9.230), in
 * the market the site saved or none: `market` is the analyzer's
 * `{ locationCode, languageCode }`, or null. Synthetic terms; no real site. */
export function journeySerpPanelSnapshot(market: { locationCode: number; languageCode: string } | null) {
  const reportDate = new Date(Date.parse(JOURNEY_NOW) - 2 * 86_400_000).toISOString().slice(0, 10);
  const row = (query: string, device: string, bestRank: number | null, aioPresent: boolean | null, aioCitesUs: boolean | null) => ({
    query, device, label: null, bestRank, bestUrl: bestRank === null ? null : `${JOURNEY_SITE}${query.replaceAll(" ", "-")}`,
    aioPresent, aioCitesUs, composition: null,
  });
  return {
    schemaVersion: 1, asset: JOURNEY_ASSET, generatedAt: JOURNEY_NOW, windowStart: "2026-08-30", windowEnd: reportDate,
    sourceArchiveCount: 1, methodology: [], suppressedItems: [], items: [],
    serpPanel: {
      reportDate, trackedDepth: 20, market,
      queries: [
        row("meal planner", "mobile", 3, true, false), row("meal planner", "desktop", 2, false, false),
        row("weekly menu", "mobile", 8, null, null), row("weekly menu", "desktop", 7, true, true),
        row("grocery list maker", "mobile", null, true, false), row("grocery list maker", "desktop", null, false, false),
      ],
    },
  };
}

/** The operator's two asks: a top-priority one, so every journey walks the
 * inbox's warn register at the band that used to turn it red (bead
 * ro-ujb9.200), and a human gate in `bd`'s own shape — titled "Gate: human",
 * with the ask under `Reason:` in its description — so every journey reads the
 * gate's ask the way the live board and the snapshot both title it (bead
 * ro-ujb9.201). */
export function initialTasks() {
  const shared = { status: "open", priority: 1, assignee: null, created_at: JOURNEY_NOW,
    updated_at: JOURNEY_NOW, closed_at: null as string | null, close_reason: null as string | null, labels: ["human"], dependencies: [], comment_count: 0 };
  return [
    { ...shared, priority: 0, id: "jt-review", title: "Review the synthetic launch copy", issue_type: "task", await_type: null,
      description: "Confirm the example headline uses the approved wording.", acceptance_criteria: "The reviewed wording is recorded." },
    { ...shared, id: "jt-approve", title: "Gate: human", issue_type: "gate", await_type: "human",
      description: "Ad-hoc gate blocking jt-review. This fixture gate authorizes no real action.\n\nReason: Approve the synthetic launch",
      acceptance_criteria: "A fixture-only approval is recorded." },
  ];
}
