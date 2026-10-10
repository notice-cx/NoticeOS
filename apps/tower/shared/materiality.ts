// The Tower presentation contract: data crossing the API is not proof that an
// operator can see it. This registry names the material CONDITIONS, while the
// two payload inventories below force every top-level concern to declare
// whether it is current state, evidence, configuration, or history.

import type { AssetDetailPayload } from "./asset-detail";
import type { WallPayload } from "./wall";

export const MATERIAL_CONDITIONS = [
  "open-flags",
  "signal-freshness",
  "os-runner-health",
  "scheduled-lane-health",
  "budget-guardrail",
  "human-gates",
  "active-changes",
  "outcome-watches",
  "rollback-failure",
] as const;

export type MaterialCondition = (typeof MATERIAL_CONDITIONS)[number];
export type VisualPriority = "critical" | "high" | "context";

export type MaterialDestination =
  | {
      placement: "fixed-horizon" | "first-viewport" | "primary-content" | "property-card";
      component: string;
      /** Selector exercised against the rendered destination, including real asset routes. */
      selector: string;
    }
  | { placement: "not-applicable"; reason: string };

export interface MaterialConditionContract {
  source: string;
  derivation: string;
  priority: VisualPriority;
  wall: MaterialDestination;
  asset: MaterialDestination;
  behavior: {
    empty: string;
    unknown: string;
    stale: string;
  };
}

/**
 * Exhaustive by construction: adding a MaterialCondition without a complete
 * destination and absence contract fails typecheck here.
 */
export const MATERIALITY = {
  "open-flags": {
    source: "WallPayload.attention / AssetDetailPayload.flags.open",
    derivation: "Open rows retain severity and kind as independent visual channels.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="open-flags"]' },
    asset: { placement: "primary-content", component: "AlertsTab", selector: 'section[aria-label="Open"]' },
    behavior: {
      empty: "The open queue names its empty state; it does not certify source health.",
      unknown: "Missing source data stays unknown in the header and Sources; an empty alert queue only means no recorded open alerts.",
      stale: "The held/stale report posture sits beside the signal list.",
    },
  },
  "signal-freshness": {
    source: "WallPayload.system.ingest + assets[].pulseReceivedAt / AssetDetailPayload.freshness",
    derivation: "Age is evaluated against the effective cadence, never inferred from row presence.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="signal-freshness"]' },
    asset: { placement: "first-viewport", component: "AssetHeader", selector: 'header [data-nightly-report-age], header [data-nightly-report="none"]' },
    behavior: {
      empty: "No expected reporters is named as an empty denominator.",
      unknown: "Report absence is named without claiming healthy; each connected source retains its own evidence.",
      stale: "Stale is amber and named before supporting evidence.",
    },
  },
  "os-runner-health": {
    source: "WallPayload.system.assetId + hasPulse (osReportMissing), its age in system.ingest / asset #0 freshness",
    derivation: "The OS earns healthy only from a current self-report.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="os-runner-health"]' },
    asset: { placement: "first-viewport", component: "AssetHeader", selector: 'header [data-nightly-report-age], header [data-nightly-report="none"]' },
    behavior: {
      empty: "The Wall names a missing OS report; its asset header names report absence without claiming healthy.",
      unknown: "A failed live read is held and labelled unknown.",
      stale: "An aged OS report loses healthy posture.",
    },
  },
  "scheduled-lane-health": {
    source: "WallPayload.system.scheduledLanes / AssetDetailPayload.scheduledLanes",
    derivation: "The latest store-backed outcome and age determine scheduler posture.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="scheduled-lane-health"]' },
    asset: { placement: "primary-content", component: "SourcesTab / ScheduledLanesPanel", selector: 'section[aria-label="Scheduled automation"]' },
    behavior: {
      empty: "No recorded lane is Unknown, never all-clear.",
      unknown: "A non-OS asset marks this system-only state not applicable.",
      stale: "Global silence or an old latest firing escalates visually.",
    },
  },
  "budget-guardrail": {
    source: "WallPayload.system.spendTodayUsd + dailyCapUsd",
    derivation:
      "The day's metered DATA spend, summed over the OS's own record of the calls it made, is compared with the day's share of the data cap — the portfolio's only cap.",
    priority: "high",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="budget-guardrail"]' },
    asset: { placement: "not-applicable", reason: "Portfolio spend is OS state, not an asset fact." },
    behavior: {
      empty: "A day with no metered call is a measured $0.00, not an absent row.",
      unknown: "There is no unknown state: the store answers whether or not the OS reported.",
      stale: "The containing OS posture carries report age.",
    },
  },
  "human-gates": {
    source: "WallPayload.operator / AssetDetailPayload.operator",
    derivation:
      "Urgent includes open human gates and blocker-aware P0/P1 human work. Missing task readings remain unknown in the asset preview.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="human-gates"]' },
    asset: { placement: "primary-content", component: "OverviewTab / NeedsYou", selector: 'section[aria-label="Needs you"]' },
    behavior: {
      empty: "Complete measured zero renders calm.",
      unknown: "Partial or stale hub coverage cannot render zero.",
      stale: "The hub photograph age remains attached to the posture.",
    },
  },
  "active-changes": {
    source: "AssetDetailPayload.annotations.items[0]",
    derivation: "The Activity timeline keeps recorded changes in date order, with each change carrying its own date.",
    priority: "high",
    wall: {
      placement: "not-applicable",
      reason: "A change is one asset's state; the Wall's live feed says when something shipped, and the asset page owns the change.",
    },
    asset: { placement: "primary-content", component: "ActivityTab / Timeline", selector: '#timeline' },
    behavior: {
      empty: "No recorded change is stated without manufacturing one.",
      unknown: "An unread timeline leaves the latest change unknown at the payload boundary.",
      stale: "The change carries its own age; old history does not masquerade as active.",
    },
  },
  "outcome-watches": {
    source: "WallPayload.assets[].activeWatch / AssetDetailPayload.watches.open",
    derivation: "Only pre-registered open comparisons count as active bets.",
    priority: "high",
    wall: {
      placement: "not-applicable",
      reason: "An open watch is true but does not move; the asset page owns it, and a watch that closes badly reaches Needs you as rollback-failure.",
    },
    asset: { placement: "primary-content", component: "ActivityTab / WatchesStrip", selector: 'section[aria-label="Bets"]' },
    behavior: {
      empty: "An empty watch list draws no panel; Activity retains the action to register a comparison.",
      unknown: "Unmeasured series stays unmeasurable; it is never converted to a zero outcome.",
      stale: "Next-check date and readings show a watch that stopped advancing.",
    },
  },
  "rollback-failure": {
    source: "watch-window-closed open flag with ruleInputs.outcome = kill_confirmed",
    derivation: "A measured decline asks for a revert decision; it never claims rollback already happened.",
    priority: "critical",
    wall: { placement: "fixed-horizon", component: "NeedsYou", selector: '[data-material-condition~="rollback-failure"]' },
    asset: { placement: "primary-content", component: "AlertsTab / AlertRow", selector: '[data-material-condition~="rollback-failure"]' },
    behavior: {
      empty: "No failed outcome adds no rollback state.",
      unknown: "An unreadable outcome falls back to the stored alert without inventing a verdict.",
      stale: "The open flag remains material until disposition or resolution.",
    },
  },
} satisfies Record<MaterialCondition, MaterialConditionContract>;

type CurrentConcern = {
  class: "material-current";
  placement: "fixed-horizon" | "first-viewport" | "primary-content";
  destination: string;
};

type SupportingConcern = {
  class: "supporting-evidence" | "configuration" | "history";
  placement: "fixed-horizon" | "first-viewport" | "primary-content" | "progressive-disclosure" | "derived-only";
  destination: string;
};

export type PayloadConcern = CurrentConcern | SupportingConcern;

/** New WallPayload top-level keys fail typecheck until their visual role is named.
 * A key no screen draws is removed with the read behind it, not kept here under
 * a screen that does not read it. */
export const WALL_PAYLOAD_INVENTORY = {
  generatedAt: { class: "supporting-evidence", placement: "fixed-horizon", destination: "WallStrip held-since age" },
  // The MCP `list_properties` tool hands the WHOLE band to agents, so the band
  // keeps fields no screen draws: `bookedDelta` (the last two closed months),
  // `residue`, `daysIn` and `trendGranularity` reach agents only.
  portfolio: { class: "material-current", placement: "primary-content", destination: "RevenueHero + Home and Sites net; MCP list_properties returns the whole band" },
  system: { class: "material-current", placement: "fixed-horizon", destination: "NeedsYou system problems + Home System tile" },
  dashboard: { class: "configuration", placement: "primary-content", destination: "WallStrip countdown + the saved Wall layout" },
  assets: { class: "material-current", placement: "primary-content", destination: "SiteRows" },
  attention: { class: "material-current", placement: "fixed-horizon", destination: "NeedsYou" },
  // History: a snoozed condition is a decision already made, so it belongs on
  // `/alerts`, never on the Wall.
  snoozed: { class: "history", placement: "primary-content", destination: "AlertsRoute Snoozed list" },
  operator: { class: "material-current", placement: "fixed-horizon", destination: "NeedsYou urgent tasks" },
  ledgerRecordedAt: { class: "supporting-evidence", placement: "derived-only", destination: "MCP list_properties (no screen)" },
} satisfies Record<keyof WallPayload, PayloadConcern>;

/** New AssetDetailPayload top-level keys fail until classified. A material-current
 * concern cannot select progressive-disclosure because that placement is not in
 * CurrentConcern's type. */
export const ASSET_PAYLOAD_INVENTORY = {
  generatedAt: { class: "supporting-evidence", placement: "first-viewport", destination: "held-read posture" },
  asset: { class: "material-current", placement: "first-viewport", destination: "AssetHeader identity and source status" },
  scheduledLanes: { class: "material-current", placement: "primary-content", destination: "SourcesTab / ScheduledLanesPanel" },
  wiring: { class: "supporting-evidence", placement: "primary-content", destination: "SettingsTab / DataCollectionCard and SourcesTab report details" },
  countersConfig: { class: "configuration", placement: "primary-content", destination: "Settings tab CardTotalsCard" },
  panelConfig: { class: "configuration", placement: "primary-content", destination: "Growth tab TrackedPanelSection" },
  rules: { class: "configuration", placement: "primary-content", destination: "SettingsTab / AlertRulesCard" },
  portfolio: { class: "configuration", placement: "primary-content", destination: "SettingsTab / PanelSettings" },
  performance: { class: "supporting-evidence", placement: "primary-content", destination: "OverviewTab / SiteLead and GrowthTab charts" },
  executive: { class: "material-current", placement: "primary-content", destination: "OverviewTab / WhatMatters and GrowthTab / SearchTab evidence" },
  recommendationEvidence: { class: "supporting-evidence", placement: "primary-content", destination: "Recommendation applicability review on findings, queries and pages" },
  metrics: { class: "supporting-evidence", placement: "primary-content", destination: "OverviewTab / ProductUse and SourcesTab / PulseMetricsSection" },
  counters: { class: "supporting-evidence", placement: "primary-content", destination: "Overview tab SiteTotals" },
  flags: { class: "material-current", placement: "primary-content", destination: "Overview open-alert count and AlertsTab queues" },
  dailyRevenue: { class: "material-current", placement: "first-viewport", destination: "FinancialsTab → DailyRevenuePanel" },
  ledger: { class: "supporting-evidence", placement: "progressive-disclosure", destination: "FinancialsTab → AssetLedger" },
  osTimeZone: { class: "configuration", placement: "derived-only", destination: "FinancialsTab daily revenue window end" },
  decisions: { class: "supporting-evidence", placement: "primary-content", destination: "Executive decisions" },
  handoffBeads: { class: "supporting-evidence", placement: "primary-content", destination: "Handoff badges" },
  operator: { class: "material-current", placement: "primary-content", destination: "OverviewTab / NeedsYou preview linking to task details and Tasks" },
  annotations: { class: "history", placement: "primary-content", destination: "ActivityTab / Timeline" },
  watches: { class: "material-current", placement: "primary-content", destination: "ActivityTab / WatchesStrip" },
  reclamation: { class: "supporting-evidence", placement: "progressive-disclosure", destination: "ReclamationSection" },
  hygiene: { class: "supporting-evidence", placement: "progressive-disclosure", destination: "SiteHealthSection" },
  fetchFailures: { class: "supporting-evidence", placement: "progressive-disclosure", destination: "FetchFailuresPanel" },
  integrations: { class: "material-current", placement: "first-viewport", destination: "AssetHeader / DataSourceIcons; SourcesTab source rows" },
  ga4Config: { class: "configuration", placement: "progressive-disclosure", destination: "Sources tab GA4 lane card" },
  panelReview: { class: "material-current", placement: "primary-content", destination: "ActivityTab / PanelReviewLine" },
  latestPanelDate: { class: "supporting-evidence", placement: "primary-content", destination: "ActivityTab / PanelReviewLine age" },
  freshness: { class: "material-current", placement: "first-viewport", destination: "AssetHeader report age and held-read state; tab evidence ages" },
} satisfies Record<keyof AssetDetailPayload, PayloadConcern>;
