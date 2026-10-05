import { toast } from 'sonner';
import { useOwnerToast } from '@/lib/browser-context';
import { DailyRevenuePanel } from "@/components/DailyRevenuePanel";
import { BrandLockup } from "@/components/BrandLockup";
import { IntegrationLogo } from "@/components/IntegrationLogo";
import { IntegrationHealthPanel } from "@/components/IntegrationHealthPanel";
import { TaskHubUnavailable, TaskProjectSteps, TaskSourceRows } from "@/components/TaskSourceSection";

/** The gallery's task server: a documentation address, never a real one. */
const KITCHEN_TASK_HUB = { host: "127.0.0.1", port: 3399, user: "root", dataDir: ".beads-hub" };
import { ConnectPanel } from "@/components/ConnectPanel";
import { WhatLands } from "@/components/WhatLands";
import { ConnectionActions } from "@/components/ConnectionActions";
import { SiteTokens } from "@/components/SiteTokens";
import { SitePicker } from "@/components/SitePicker";
import { ScheduleRows } from "@/routes/workflows/ScheduleEditor";
import { connectionCollections } from "@shared/scheduled-jobs";
import { DeclineReasons } from "@/components/DeclineReasons";
import type { SitesPayload } from "@shared/site-discovery";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useReducer, useState } from "react";

import { GOOGLE_TESTING_GRANT_DAYS } from "@noticeos/contract/integrations";
import { REPORT_MAX_AGE_HOURS } from "@noticeos/contract/reporting";
import type { CalendarFeed, CalendarUpcoming, UpcomingMeeting } from "@noticeos/contract/calendar-upcoming";
import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract/ga4-realtime";
import type {
  AssetCard as AssetData,
  AttentionItem,
  PortfolioBand as PortfolioData,
  ScheduledLane,
  SeriesPoint,
  SystemBand as SystemData,
  WallPayload,
} from "@shared/wall";
import { CADENCE_HOURS } from "@shared/wall";
import {
  DEFAULT_WALL_LAYOUT,
  WALL_LAYOUT_VERSION,
  type WallLayout,
  type WallLayoutVersion,
} from "@shared/wall-layout";
import type { AlertRuleStat, AlertRuleStatsPayload } from "@shared/alert-rules";
import type { AnnotationItem } from "@shared/annotations";
import { assetSetupChecklist } from "@shared/asset-setup";
import type { SourceReading } from "@shared/connection-status";
import { demoConnections, demoCountsHistory } from "@/routes/kitchen-sink/demo-connections";
import type { ConnectVerdict, RuleBacktest, RuleBacktestDay } from "@noticeos/contract";
import type {
  AssetStatus,
  ExecutiveInsight,
  ExecutiveSnapshot,
  FlagRecord,
  HandoffBead,
  KnobFact,
  SerpPanelQuery,
  SearchPageTrends,
  SearchQueryTrends,
  SerpPanelSnapshot,
} from "@shared/asset-detail";
import type {
  DerivedLaneRow,
  IntegrationCell,
  IntegrationEvidence,
  IntegrationsMatrix,
} from "@shared/integrations";
import {
  EGRESS_LANE_ID,
  NIGHTLY_REPORT_LANE_ID,
  emptyIntegrationsHistory,
  sharedCredentialInsight,
  summarize,
} from "@shared/integrations";
import type {
  CredentialProbe,
  ProbeResult,
  CredentialSummary,
  GooglePropertyDiscovery,
  IntegrationCredentialsPayload,
  IntegrationProvider,
  IntegrationProviderId,
  IntegrationProviderStatus,
} from "@shared/integrations-page";
import { connectBlockers, googleOAuthCardState } from "@shared/integrations-page";
import { integrationProvider, probeLine } from "@noticeos/contract/integrations";
import { posthogFunnelsRefusal, type PosthogFunnel } from "@noticeos/contract/configuration";
import { ASSET_STATUS, type FileOp, type JsonValue, type SettingOp } from "@shared/changeset";
import { entityLabel, entityMoveOps, type EntityRow } from "@shared/entities";
import type { TaskHubSpoke } from "@shared/settings";
import type { TaskCreated } from "@shared/tasks";
import { AgeBadge, NoNightlyReport } from "@/components/AgeBadge";
import { Sidebar } from "@/components/AppShell";
import { CommandPalette } from "@/components/CommandPalette";
import { AiOverviewGlyphs } from "@/components/AiOverviewGlyphs";
import { BookingChip, bookingChipState } from "@/components/BookingChip";
import { DeltaChip, paceTone } from "@/components/DeltaChip";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { CountdownWidget } from "@/components/DashboardWidgets";
import { CountdownFace } from "@/components/TimeFaces";
import { Drill } from "@/components/Drill";
import { EmptyState } from "@/components/EmptyState";
import { ChangeChip } from "@/components/ChangeChip";
import { EvidencePopover } from "@/components/EvidencePopover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pillClass, pillControlClass } from "@/components/ui/pill";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ExecutiveFindingsList } from "@/components/ExecutiveFindingsList";
import { AnalysisEvidence } from "@/components/AnalysisEvidence";
import { AlertVerification } from "@/components/AlertVerification";
import { ExecutiveInsightRow } from "@/components/ExecutiveInsightRow";
import { BacktestStrip } from "@/components/BacktestStrip";
import { FlagActions } from "@/components/FlagActions";
import { RuleTunePanel, type RuleTunePreview } from "@/components/RuleTune";
import { IntegrationMatrix } from "@/components/IntegrationMatrix";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { IntegrationSummaryStrip } from "@/components/IntegrationSummaryStrip";
import { CollectionEditor } from "@/components/CollectionEditor";
import { KnobEditor } from "@/components/KnobEditor";
import { InlineSaveState } from "@/components/InlineSaveState";
import { SavesPaused } from "@/components/SavesPaused";
import { FunnelListEditor } from "@/components/FunnelListEditor";
import { ConnectBlockers } from "@/components/ConnectBlockers";
import { GoogleSignInSetup } from "@/components/GoogleSignInSetup";
import {
  ProviderCard,
  type ProviderCardAsset,
  type ProviderOAuthPanel,
} from "@/components/ProviderCard";
import { GoogleStartPress } from "@/components/provider-card/GoogleStartPress";
import { KnobRow } from "@/components/KnobRow";
import { FileTaskButton } from "@/components/TaskComposer";
import { Meter } from "@/components/Meter";
import { OwnerChip } from "@/components/OwnerChip";
import { PageHeader } from "@/components/PageHeader";
import { PageDecisions } from "@/components/PageDecisions";
import { ProgressRing } from "@/components/ProgressRing";
import { PriorityBar } from "@/components/PriorityBar";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { DemoViewerStatus } from "@/components/DemoViewerStatus";
import { validateDemoViewer } from "@shared/demo-viewer";
import { ReportFreshness } from "@/components/ReportFreshness";
import { QueryVisibilityRankings } from "@/components/QueryVisibilityRankings";
import { ReadFailed } from "@/components/ReadFailed";
import { RouteLoadFailure, RouteLoading } from "@/components/RouteLoading";
import { SeverityDot } from "@/components/SeverityDot";
import { SnoozeUntil } from "@/components/SnoozeUntil";
import { SegmentBar } from "@/components/SegmentBar";
import { TuneRate } from "@/components/TuneRate";
import { StateChip } from "@/components/StateChip";
import { UnknownPriceCount } from "@/components/UnknownPriceCount";
import { TaskStatusChip } from "@/routes/tasks/task-face";
import { Stepper, lifecycleStepper } from "@/components/Stepper";
import { AddSiteButton, AddSitePanel, NoSitesYet, type AddSitePanelProps } from "@/components/AddSite";
import { Tabs } from "@/components/Tabs";
import { Timeline } from "@/components/Timeline";
import { WallLibraryPanel } from "@/components/wall/WallLibraryPanel";
import { WallPreview } from "@/components/wall/WallPreview";
import { WallRowsPanel } from "@/components/wall/WallRowsPanel";
import { WallStrip } from "@/components/wall/WallStrip";
import { WallVersions } from "@/components/wall/WallVersions";
import { WallWidgetPanel } from "@/components/wall/WallWidgetPanel";
import { wallEditorReducer, wallEditorState } from "@/lib/wall-editor";
import {
  validateFutureDateTime,
  validateProbability,
  validateUrl,
  validateUsd,
} from "@/lib/knob-validators";
import { toLocalDateTimeInput } from "@/lib/countdown";
import { ApiError, type NewTask } from "@/lib/api";
import { taskHandoffPrefill } from "@/lib/task-handoff";
import { TimeZoneCaveat } from "@/components/TimeZoneCaveat";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { PanelReviewBadge } from "@/components/PanelReviewBadge";
import { PanelReviewLine } from "@/components/PanelReviewLine";
import { SerpPanelBoard } from "@/components/SerpPanelBoard";
import { AlertList, AlertRow, AttentionAllClear } from "@/components/AlertRow";
import { WallCanvas } from "@/components/WallCanvas";
import { NeedsYou } from "@/components/wall/NeedsYou";
import { RevenueHero } from "@/components/wall/RevenueHero";
import { SiteRows } from "@/components/wall/SiteRows";
import { wallIssues } from "@/lib/wall-issues";
import type { RevenueProjection } from "@shared/revenue-projection";
import { yesterdayRevenue, type DailyRevenueSummary } from "@shared/daily-revenue";
import { WallFeed } from "@/components/wall/WallFeed";
import type { WallFeedItem, WallFeedPayload } from "@shared/wall-feed";
// Imported rather than re-typed: the first-run copy is the one thing on this
// page a reviewer is checking, and a second copy of it would drift (bead
// `ro-vtf7`).
import { FirstRun } from "@/routes/HomeRoute";
// Same reason: the setup panel is route layout on the asset page, and a second
// copy of its rows here would drift from the one the operator actually sees.
import { SetupChecklistPanel } from "@/routes/asset-detail/SetupChecklist";
import {
  ScheduledLanesPanel,
  ScheduledLanesSummary,
} from "@/components/ScheduledLanes";
import { WorkflowStateLabel, WorkflowActivity, WorkflowStages, WorkflowScheduleTimeline, WorkflowStepOutputView } from '@/components/WorkflowVisuals';
import { WORKFLOW_DEFINITIONS, type WorkflowState } from '@shared/workflows';
// The registry is LAW (doc 14), and a law nothing reads is a suggestion. This
// page is its one importer: the contents below are the registry's own
// inventory, so an entry added there appears here without anybody editing this
// file, and `scripts/component-registry.test.mjs` fails the build when a
// component, an entry, a REGISTRY.md row or a demo on this page goes missing.
import { COMPONENT_REGISTRY } from "@/components/registry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DEFAULT_RANGE_DAYS,
  averageSeries,
  periodDelta,
  windowSeries,
  type SurfaceAnnotation,
} from "@shared/surface";
import { About } from "@/components/surface/About";
import { HeroChart, type HeroSeries } from "@/components/surface/HeroChart";
import { ChartEventMarkers } from "@/components/ChartEventMarkers";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { FilterBar, FilterControls, FilterFold, FilterToggle } from "@/components/surface/FilterBar";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { SmallMultiple, SmallMultipleStrip } from "@/components/surface/SmallMultiple";
import { ChartArea, ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { MinutePulse } from "@/components/surface/MinutePulse";
import { LiveUsers } from "@/components/wall/LiveUsers";
import { Sparkline } from "@/components/surface/Sparkline";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { ProductJourney } from "@/components/ProductJourney";
import type { ProductFunnel, ProductSnapshot } from "@shared/asset-detail";
import { parseProductSnapshot } from "@shared/product-snapshot";
import posthogProductJson from "@/routes/kitchen-sink/posthog-product.json";
import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui/field";
import { formatCompact, formatInt, formatSignedUsd, formatUsd } from "@/lib/format";

const NOW = Date.now();

/** The live feed's demo rows: one of each tone, newest first, the last one
 * older than twelve hours so it shows muted. Synthetic sites. */
const FEED_DEMO_ITEMS: WallFeedItem[] = (
  [
    [6, "task-done", "Task done", "Recipes", "Recipe cards load faster", "healthy"],
    [19, "task-filed", "New task", "Menus", "Menu import skips closed restaurants", "neutral"],
    [31, "collected", "Collected", null, "Google · 5 sites, none failed", "neutral"],
    [52, "source-failed", "Source failed", "Codes", "Analytics daily reports: access denied", "error"],
    [120, "alert", "Alert", "Recipes", "Plans saved well below normal", "warn"],
    [195, "revenue", "Revenue", null, "2 sites reported $55.25 for Sep 21", "revenue"],
    [268, "cost", "Cost", null, "DataForSEO · $0.41 for 12 reports", "cost"],
    [780, "deployed", "Deployed", "NoticeOS", "The OS moved to a newer version", "neutral"],
  ] as const
).map(([minutes, kind, label, site, text, tone]) => ({
  id: `demo-${kind}`,
  at: new Date(NOW - minutes * 60_000).toISOString(),
  kind,
  label,
  asset: site ? `${site.toLowerCase()}.example.com` : null,
  site,
  text,
  count: 1,
  tone,
}));

function feedDemo(items: WallFeedItem[]): WallFeedPayload {
  return { generatedAt: new Date(NOW).toISOString(), since: new Date(NOW - 18 * 3_600_000).toISOString(), items, limit: 50 };
}
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** A deadline that has not arrived yet — the only fixtures here that look
 * forward rather than back are the review due dates. */
const isoAhead = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The eight-slot source inventory (doc 14) at its full width, one slot per
 * distinct look — so the Wall row is as wide as the widest one an asset card
 * ever draws, and every status can be told from every other without reading a
 * hover. Not checked wears Unknown's "?" and Key accepted Working's check. */
const DATA_SOURCE_STATES: SourceReading[] = ([
  ["nightly-report", "Nightly report", "working"],
  ["gsc", "Google Search Console", "failing"],
  ["bing-webmaster", "Bing Webmaster Tools", "overdue"],
  ["ga4", "Google Analytics 4", "collecting"],
  ["posthog", "PostHog", "unknown"],
  ["clarity", "Microsoft Clarity", "not-using"],
  ["dataforseo", "DataForSEO", "not-applicable"],
  ["uptime", "Uptime", "not-connected"],
] as const).map(([id, label, kind]) => ({ id, label, kind, site: null, provider: null, detail: null, observedAt: null }));

function series(values: number[], prefix = "2026-"): SeriesPoint[] {
  return values.map((v, i) => ({ t: `${prefix}${String(i + 1).padStart(2, "0")}`, v }));
}

/** Real consecutive calendar dates. The daily charts derive Sunday–Saturday
 * week bands and rolling averages from the dates themselves, so their demos
 * cannot use `series`' synthetic labels. */
function dailySeries(values: number[], startDate: string): SeriesPoint[] {
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  return values.map((v, i) => ({
    t: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
    v,
  }));
}

// Demo op factories for the KnobEditor showcase (target a fictional demo asset).
// The gallery is a real page in the real app, so a KnobEditor left on its default
// writer would apply a config change and commit it the moment somebody clicked
// Save while browsing components. Every demo below is handed this instead: the
// controls, the validation, the pending state and the toast are the shipped ones;
// only the write is a promise that resolves.
const DEMO_FUNNELS: PosthogFunnel[] = [
  {
    id: "calculator",
    name: "Calculator",
    steps: [{ event: "$pageview", path: "/calculator" }, { event: "form_start" }, { event: "calculation_complete" }],
  },
];
const demoSave = async (op: SettingOp): Promise<void> => {
  toast.success(`Demo only — nothing written (${op.kind})`);
};
const fileDemo =
  (
    file: "config/constants.json" | "config/pull.json" | "config/tower.json",
    pointer: string,
    expect: JsonValue,
  ) =>
  (value: JsonValue): SettingOp => ({ kind: "file-json-set", file, pointer, expect, value });
const storeDemo =
  (column: "status" | "sense_only", expect: JsonValue) =>
  (value: JsonValue): SettingOp => ({ kind: "store-asset-set", asset: "demo.example", column, expect, value });

// The same escape hatch, for the collection editor (bead `ro-x5gu.1`). A table
// left on its default writer would add, edit and REMOVE rows of the operator's
// real config — and commit each one — the moment somebody browsed components.
const demoCollectionSave = async (ops: FileOp[]): Promise<void> => {
  toast.success(`Demo only — nothing written (${ops.map((op) => op.kind).join(", ")})`);
};
const DEMO_DOMAIN_COSTS = [
  {
    domain: "demo.example",
    asset: "demo.example",
    kind: "registration",
    paidUsd: 5.66,
    paidOn: "2026-06-19",
  },
  {
    domain: "demo-two.example",
    asset: "demo.example",
    kind: "renewal",
    paidUsd: 36.32,
    paidOn: "2026-07-04",
  },
];

/** Past `NARROWS_FROM` rows, so the filter box and the sortable headers appear
 * (bead `ro-x5gu.11`). Two assets, so narrowing to one is the thing the demo is
 * for; the prices differ so a sort is visible. */
/** Two legal entities (bead `ro-aodz`): one that owns an asset, and one that
 * owns nothing — which is the row with no `assets` key at all, and therefore the
 * one whose first asset is a FIRST write rather than an ordinary set. */
const DEMO_ENTITIES: EntityRow[] = [
  {
    slug: "demo-ventures",
    name: "Demo Ventures LLC",
    form: "LLC",
    jurisdiction: "US-DE",
    assets: ["demo.example"],
  },
  { slug: "second-demo-co", name: "Second Demo Co" },
];

const DEMO_LONG_DOMAIN_COSTS = Array.from({ length: 10 }, (_, n) => ({
  domain: `demo-${n + 1}.example`,
  asset: n % 3 === 0 ? "menu.example.org" : "demo.example",
  kind: n % 2 === 0 ? "registration" : "renewal",
  paidUsd: Number((6.5 + n * 3.17).toFixed(2)),
  paidOn: `2026-0${(n % 9) + 1}-14`,
}));

// The same escape hatch, for the task composer (bead `ro-l1ed.4`). The gallery
// runs inside `os:up`, which HAS the task lane, so a File task left on its
// default writer would file a real bead on the portfolio hub the moment somebody
// pressed it while browsing components. This is the shipped form, the shipped
// validation and the shipped toast; only `bd create` is a promise that resolves.
const demoFileTask = async (input: NewTask): Promise<TaskCreated> => ({
  id: `${input.project === "plate.example.com" ? "mp" : "ro"}-demo`,
  project: input.project,
});

// The same escape hatch again, for `ProviderCard` (bead `ro-vu8d.2`). The
// gallery is the real app, and these three handlers are the ONLY reason a
// Connect / Test / Disconnect demo can be a live control rather than a
// screenshot: the form, the validation, the spinner, the one confirmation and the
// probe rendering are all shipped code; only the network call is a promise.
const demoConnect = async (fields: Record<string, string>): Promise<void> => {
  toast.success(`Demo only — nothing stored (${Object.keys(fields).join(", ")})`);
};
const demoDisconnect = async (): Promise<void> => {
  toast.success("Demo only — nothing removed");
};
/** The same escape hatch for the legacy credential's Import (bead `ro-vu8d.7`).
 * The button, its spinner and its refusal are shipped code; only the crossing
 * from the environment file to the store is a promise, because a press while
 * browsing components must not move the operator's real secrets. */
const demoImportEnv = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  toast.success("Demo only — nothing imported");
};
const demoSetExpiry = async (expiresAt: string | null): Promise<void> => {
  toast.success(
    expiresAt === null ? "Demo only — recorded as never expiring" : `Demo only — ${expiresAt}`,
  );
};
/**
 * The connect panel's demos (bead `ro-ujb9.96.7.1`): one per answer a provider
 * can give, each after a beat so Checking is a state a reviewer sees. The
 * panel, its fields, its states and its refusals are the shipped code; only
 * the provider's answer is a promise.
 */
const connectAnswer = (verdict: ConnectVerdict) => async (): Promise<ConnectVerdict> => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return verdict;
};
const CONNECT_DEMO_AT = "2026-09-22T12:00:00.000Z";
const CONNECT_PANEL_DEMOS: {
  key: string;
  provider: IntegrationProviderId;
  canConnect?: boolean;
  answer: (fields: Record<string, string>) => Promise<ConnectVerdict>;
}[] = [
  { key: "bing-accepts", provider: "bing-webmaster", answer: connectAnswer({ verdict: "accepted", checkedAt: CONNECT_DEMO_AT, facts: { sites: 2 } }) },
  { key: "bing-refuses", provider: "bing-webmaster", answer: connectAnswer({ verdict: "refused", checkedAt: CONNECT_DEMO_AT }) },
  { key: "dataforseo-accepts", provider: "dataforseo", answer: connectAnswer({ verdict: "accepted", checkedAt: CONNECT_DEMO_AT, facts: { creditUsd: "18.72" } }) },
  { key: "dataforseo-silent", provider: "dataforseo", answer: connectAnswer({ verdict: "unreachable", checkedAt: CONNECT_DEMO_AT }) },
  { key: "bing-blocked", provider: "bing-webmaster", canConnect: false, answer: connectAnswer({ verdict: "accepted", checkedAt: CONNECT_DEMO_AT, facts: { sites: 2 } }) },
  // PostHog (bead ro-ujb9.96.7.8): one account key, its region found.
  { key: "posthog-accepts", provider: "posthog", answer: connectAnswer({ verdict: "accepted", checkedAt: CONNECT_DEMO_AT, facts: { projects: 2, region: "eu" } }) },
];

/** The site list's demos (bead ro-ujb9.96.7.2): an account whose sites match
 * two assets, lack one, and hold two nothing claims; and a portfolio provider
 * with its markets and spend. Start answers after a beat; nothing is sent. */
const SITE_DEMO_ASSETS: SitesPayload["assets"] = [
  { id: "journey.example", label: "Journey Example", domain: "journey.example", status: "live", cells: { "bing-webmaster": { status: "needs-setup", mapping: {} }, dataforseo: { status: "needs-setup", mapping: {} } } },
  { id: "second.example", label: "Second Example", domain: "second.example", status: "live", cells: { "bing-webmaster": { status: "needs-setup", mapping: {} }, dataforseo: { status: "needs-setup", mapping: { locationCode: 2826 } } } },
  { id: "third.example", label: "Third Example", domain: "third.example", status: "pre-launch", cells: { "bing-webmaster": { status: "skipped", mapping: {} }, dataforseo: { status: "needs-setup", mapping: {} } } },
];
const siteDemo = (url: string, ready = true) => ({ lane: "bing-webmaster", ref: url, label: url, host: new URL(url).hostname, mapping: { siteUrl: url }, ready });
const SITE_PICKER_DEMOS: { key: string; provider: IntegrationProviderId; payload: SitesPayload }[] = [
  { key: "bing", provider: "bing-webmaster", payload: { spend: null, assets: SITE_DEMO_ASSETS,
    discovery: { ok: true, provider: "bing-webmaster", kind: "account", checkedAt: CONNECT_DEMO_AT,
      sites: [siteDemo("https://journey.example/"), siteDemo("https://shop.example/"), siteDemo("https://blog.journey.example/", false)] } } },
  { key: "dataforseo", provider: "dataforseo", payload: { assets: SITE_DEMO_ASSETS,
    spend: { period: "2026-09", spentUsd: 3.1, unknownPrices: 0, capUsd: 25, perSiteWeekUsd: 0.45, perSiteCeilingUsd: 2.5 },
    discovery: { ok: true, provider: "dataforseo", kind: "portfolio", checkedAt: CONNECT_DEMO_AT,
      sites: ["journey.example", "second.example"].map((id) => ({ lane: "dataforseo", ref: id, label: id, host: id, mapping: {}, asset: id, ready: true })) } } },
  { key: "bing-no-answer", provider: "bing-webmaster", payload: { spend: null, assets: SITE_DEMO_ASSETS,
    discovery: { ok: false, provider: "bing-webmaster", checkedAt: CONNECT_DEMO_AT, reason: "unreachable" } } },
  // PostHog (bead ro-ujb9.96.7.8): projects matched by the domain each
  // records, with the saved funnels one brings; a staging project unclaimed.
  { key: "posthog", provider: "posthog", payload: { spend: null,
    assets: SITE_DEMO_ASSETS.map((asset) => ({ ...asset, cells: { posthog: { status: "needs-setup", mapping: {} } } })),
    discovery: { ok: true, provider: "posthog", kind: "account", checkedAt: CONNECT_DEMO_AT, sites: [
      { lane: "posthog", ref: "eu:596607", label: "Journey Example", host: "journey.example", mapping: { host: "eu", projectId: "596607" }, ready: true,
        funnels: [{ id: "signup", name: "Signup", steps: [{ event: "$pageview" }, { event: "signed_up" }] }, { id: "checkout", name: "Checkout", steps: [{ event: "checkout_started" }, { event: "purchase" }] }] },
      { lane: "posthog", ref: "eu:12", label: "Staging", host: null, mapping: { host: "eu", projectId: "12" }, ready: true },
    ] } } },
];
const demoCollect = (provider: string, paused = false) => (plan: { assets: string[] }) =>
  new Promise<import("@noticeos/contract").CollectNowResult>((resolve) => setTimeout(() => resolve(paused
    ? { ok: false, provider, error: "paused", job: "pull" }
    : { ok: true, provider, job: "pull", startedAt: CONNECT_DEMO_AT, finishedAt: CONNECT_DEMO_AT,
      sites: plan.assets.map((asset) => ({ asset, outcome: "collected" as const, code: null, ...(provider === "dataforseo" ? { reports: 8, costUsd: 0.09 } : {}) })) }), 800));

/** A connected provider in the panel (bead ro-ujb9.96.7.10): working, then
 * failing, with the sites a Disconnect would stop. */
const CONNECTION_DEMO_SITES = [
  { id: "journey.example", label: "Journey Example", domain: "journey.example" },
  { id: "second.example", label: "Second Example", domain: "second.example" },
];
const CONNECTION_DEMOS: { key: string; provider: IntegrationProviderId; failing: boolean }[] = [
  { key: "bing-working", provider: "bing-webmaster", failing: false },
  { key: "bing-failing", provider: "bing-webmaster", failing: true },
];

/** The same panel in its real `Sheet`, over the gallery, on a press. */
function ConnectSheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        Open in its Sheet
      </Button>
      {open ? (
        <ConnectPanel
          provider={realProvider("bing-webmaster")}
          onConnect={CONNECT_PANEL_DEMOS[0]!.answer}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** A probe that takes a beat, so the spinner is a state somebody can actually
 * see rather than one frame between two renders. */
const demoProbe =
  ({ ok, result }: { ok: boolean; result: ProbeResult }) => (): Promise<CredentialProbe> =>
    new Promise((resolve) => setTimeout(() => resolve({ ok, result, message: probeLine(result), checkedAt: new Date(NOW).toISOString() }), 600));

/**
 * The provider as the product actually ships it, from `packages/contract`.
 *
 * Deliberately NOT a hand-written fixture. This gallery is the review surface
 * for the component, and the thing most worth reviewing on a credential form is
 * the `help` sentence under each input — the one the operator reads while
 * hunting for an API key in somebody's console. An invented one here would
 * review a sentence nobody ships, which is the exact drift the registry rule
 * exists to prevent (bead `ro-vu8d.6`).
 */
function realProvider(id: IntegrationProviderId): IntegrationProvider {
  const found = integrationProvider(id);
  if (!found) {
    throw new Error(`the contract declares no provider "${id}" — the gallery is stale`);
  }
  return found;
}

function demoCredential(
  provider: IntegrationProviderId,
  over: Partial<CredentialSummary>,
): CredentialSummary {
  return {
    provider,
    source: "none",
    fields: [],
    // Only a per-asset provider has one (bead `ro-vu8d.9`); every demo below
    // that needs one states it.
    assetsHeld: [],
    missingFields: [],
    auth: null,
    metadata: null,
    keyVersion: null,
    createdAt: null,
    updatedAt: null,
    lastUsedAt: null,
    lastOkAt: null,
    lastError: null,
    ...over,
  };
}

/**
 * Credential and evidence cases use each provider's shipped field schema:
 * DataForSEO's two-field form, Google service-account JSON (paste or upload),
 * the calendar url-list without a credential, and Bing's failing key. Between them every field
 * kind in the schema is drawn at least once.
 */
interface ProviderCardDemo {
  status: IntegrationProviderStatus;
  assets: ProviderCardAsset[];
  probe: () => Promise<CredentialProbe>;
}

/** Named, because the no-encryption-key demo below reuses this exact card and
 * an index into the array would be a silent dependency on its order. */
const PROVIDER_CARD_CONNECTED: ProviderCardDemo = {
  status: {
    provider: realProvider("dataforseo"),
    credential: demoCredential("dataforseo", {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      updatedAt: iso(3 * DAY),
      lastUsedAt: iso(4 * HOUR),
      lastOkAt: iso(4 * HOUR),
      // THE OTHER NUMBER ON THIS CARD (bead `ro-qpas`): the prepaid credit
      // DataForSEO last reported, with the instant it said so. What a reviewer
      // judges here is whether the amount and its age read as ONE fact — a
      // figure whose age is easy to miss is a figure somebody will take for
      // today's.
      metadata: {
        account: null,
        scopes: [],
        connectedAt: iso(60 * DAY),
        expiresAt: null,
        expirySource: null,
        balance: { usd: "18.72", seenAt: iso(4 * HOUR) },
      },
    }),
    assets: [
      { id: "plate.example.com", lanes: ["dataforseo"] },
      { id: "menu.example.org", lanes: ["dataforseo"] },
    ],
    // WHAT IS LEFT OF THE MONTH (bead `ro-qpas`) — the second window the same
    // budget line draws, beside Clarity's per-asset day below. A reviewer is
    // judging whether one line about dollars and a list of lines about calls
    // read as the same component, and whether the note under it is legible as
    // "this is the cap, NOT the credit on the account".
    meter: {
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: 4.487_088, unknownPrices: 2,
      capUsd: 25,
    },
  },
  assets: [
    { id: "plate.example.com", displayName: "plate.example.com", domain: "plate.example.com" },
    { id: "menu.example.org", displayName: "menu.example.org", domain: "menu.example.org" },
  ],
  probe: demoProbe({ ok: true, result: { outcome: "answered", facts: { creditUsd: "18.72" } } }),
};

/** The same card with the month spent out — the state that decides whether next
 * Monday's sweep runs at all, and the one a bar has to make legible at a
 * glance. It is a separate demo rather than a knob because the two ends of a
 * meter only get compared when they are on the screen together. */
const PROVIDER_CARD_CAP_REACHED: ProviderCardDemo = {
  ...PROVIDER_CARD_CONNECTED,
  status: {
    ...PROVIDER_CARD_CONNECTED.status,
    // The other end of the credit line too (bead `ro-qpas`): an account nobody
    // has read yet, which is what every card looks like until the first answer
    // carries a figure. It is a SENTENCE rather than a blank, because a missing
    // row reads as an account with no credit on it — and it belongs beside a
    // spent-out cap, since that is the pair an operator meets when they are
    // deciding whether Monday's sweep can run at all.
    credential: demoCredential("dataforseo", {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      updatedAt: iso(3 * DAY),
      lastUsedAt: iso(4 * HOUR),
      lastOkAt: iso(4 * HOUR),
    }),
    meter: {
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: 25, unknownPrices: 0,
      capUsd: 25,
    },
  },
};

/** The same card with a credit sighting TOO OLD TO ACT ON (bead `ro-vu8d.27`):
 * the weekly refresh is silent when refused, so a figure that quietly ages is
 * the failure mode, and past two missed weeks the age is said in warn ink
 * rather than left as a muted timestamp. What a reviewer judges here is that
 * the amount is still legible (hiding it would invent "no credit") while the
 * sentence, not the number, is what the eye lands on. */
const PROVIDER_CARD_CREDIT_STALE: ProviderCardDemo = {
  ...PROVIDER_CARD_CONNECTED,
  status: {
    ...PROVIDER_CARD_CONNECTED.status,
    credential: demoCredential("dataforseo", {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      updatedAt: iso(40 * DAY),
      lastUsedAt: iso(4 * HOUR),
      lastOkAt: iso(4 * HOUR),
      metadata: {
        account: null,
        scopes: [],
        connectedAt: iso(60 * DAY),
        expiresAt: null,
        expirySource: null,
        balance: { usd: "18.72", seenAt: iso(16 * DAY) },
      },
    }),
  },
};

/**
 * What the sidebar's Integrations entry reads its expiry dot from (bead
 * `ro-vu8d.8`).
 *
 * `ro-vu8d.19` decided on 2026-09-05 that this dot, plus the provider card
 * behind it, is the WHOLE ceiling for an expiring portfolio-shared credential —
 * the Wall carries nothing and Home's Alerts list carries nothing — so this is
 * the one place the state is reviewable, and it had none. Passing the payload
 * also keeps the gallery off the live credential read, exactly as `assets`
 * keeps it off the wall.
 */
const SIDEBAR_CREDENTIALS: IntegrationCredentialsPayload = {
  generatedAt: new Date(NOW).toISOString(),
  keyPresent: true,
  blockers: [],
  keyReason: null,
  providers: [
    {
      provider: realProvider("dataforseo"),
      credential: demoCredential("dataforseo", {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
        metadata: {
          account: null,
          scopes: [],
          connectedAt: iso(60 * DAY),
          expiresAt: new Date(NOW + 9 * DAY).toISOString(),
          expirySource: "operator",
        },
      }),
      assets: [{ id: "plate.example.com", lanes: ["dataforseo"] }],
    },
  ],
};

/** The same provider one second after Save: stored, and with every outcome
 * column reset, because a PUT throws away what the previous key proved. */
const PROVIDER_CARD_JUST_SAVED: IntegrationProviderStatus = {
  ...PROVIDER_CARD_CONNECTED.status,
  credential: demoCredential("dataforseo", {
    source: "store",
    fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    updatedAt: iso(4_000),
  }),
};

/** Named, because the two import shapes below render this exact card twice and
 * an index into the array would be a silent dependency on its order. */
const PROVIDER_CARD_LEGACY_ENV: ProviderCardDemo = {
  status: {
    provider: realProvider("google"),
    credential: demoCredential("google", {
      source: "env",
      fields: [],
      lastUsedAt: iso(35 * 60_000),
      lastOkAt: iso(35 * 60_000),
    }),
    assets: [
      { id: "plate.example.com", lanes: ["ga4", "gsc"] },
      { id: "menu.example.org", lanes: ["ga4", "gsc"] },
      { id: "finance.example.org", lanes: ["gsc"] },
    ],
  },
  assets: [
    { id: "plate.example.com", displayName: "plate.example.com", domain: "plate.example.com" },
    { id: "menu.example.org", displayName: "menu.example.org", domain: "menu.example.org" },
    { id: "finance.example.org", displayName: "finance.example.org", domain: "finance.example.org" },
  ],
  probe: demoProbe({ ok: true, result: { outcome: "answered", facts: { sites: 3, account: "robot@demo-project.iam.gserviceaccount.com" } } }),
};

/**
 * The countdown's whole ramp on one screen (bead `ro-vu8d.8`).
 *
 * Real providers again, because which sentence a card can honestly print is a
 * per-provider FACT: DataForSEO offers the operator a date field, Bing the
 * same, and the calendar feed states no lifetime at all — so the last card here
 * is the one that proves the design refuses to invent one.
 */
const PROVIDER_CARD_EXPIRY_DEMOS: IntegrationProviderStatus[] = [
  {
    provider: realProvider("dataforseo"),
    credential: demoCredential("dataforseo", {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      updatedAt: iso(30 * DAY),
      lastOkAt: iso(2 * HOUR),
      lastUsedAt: iso(2 * HOUR),
      metadata: {
        account: null,
        scopes: [],
        connectedAt: null,
        expiresAt: isoAhead(60 * DAY),
        expirySource: "operator",
      },
    }),
    assets: [],
  },
  {
    provider: realProvider("bing-webmaster"),
    credential: demoCredential("bing-webmaster", {
      source: "store",
      fields: ["BING_WEBMASTER_API_KEY"],
      updatedAt: iso(80 * DAY),
      lastOkAt: iso(9 * HOUR),
      lastUsedAt: iso(9 * HOUR),
      metadata: {
        account: null,
        scopes: [],
        connectedAt: null,
        expiresAt: isoAhead(6 * DAY),
        expirySource: "operator",
      },
    }),
    assets: [],
  },
  {
    provider: realProvider("bing-webmaster"),
    credential: demoCredential("bing-webmaster", {
      source: "store",
      fields: ["BING_WEBMASTER_API_KEY"],
      updatedAt: iso(400 * DAY),
      lastOkAt: iso(9 * HOUR),
      lastUsedAt: iso(9 * HOUR),
      metadata: {
        account: null,
        scopes: [],
        connectedAt: null,
        expiresAt: isoAhead(-3 * DAY),
        expirySource: "operator",
      },
    }),
    assets: [],
  },
  {
    provider: realProvider("calendar"),
    credential: demoCredential("calendar", {
      source: "store",
      fields: ["CALENDAR_FEEDS"],
      updatedAt: iso(12 * DAY),
      lastOkAt: iso(HOUR),
      lastUsedAt: iso(HOUR),
    }),
    assets: [],
  },
];

/**
 * THE PROPERTY MAP RETIRING ITSELF (bead `ro-90mr`) — the same Google card in
 * both of its sentences.
 *
 * Worth two cards rather than one: what a reviewer is judging is whether the
 * unfinished one is ACTIONABLE (does it name which asset and which data source,
 * and does each link somewhere) and whether the finished one is precise enough
 * to act on, since what it licenses is deleting ids out of a stored secret.
 */
const PROVIDER_CARD_PROPERTY_MAP_DEMOS: IntegrationProviderStatus[] = [
  {
    ...PROVIDER_CARD_LEGACY_ENV.status,
    credential: {
      ...PROVIDER_CARD_LEGACY_ENV.status.credential,
      propertyMap: {
        needed: true,
        answersFor: [
          { asset: "menu.example.org", id: "ga4", label: "GA4 Data API" },
          // An ORPHAN (bead `ro-vu8d.22`): an asset the credential's own account
          // map names that `config/integrations.json` has no entry for at all.
          // It is the case the Tower's old derivation could not see, and the one
          // where getting the sentence wrong tells the operator to delete an id
          // a run is still reading.
          { asset: "codes.example.com", id: "gsc", label: "Google Search Console (GSC API)" },
        ],
      },
    },
  },
  {
    ...PROVIDER_CARD_LEGACY_ENV.status,
    credential: {
      ...PROVIDER_CARD_LEGACY_ENV.status.credential,
      propertyMap: { needed: false, answersFor: [] },
    },
  },
];

const PROVIDER_CARD_DEMOS: ProviderCardDemo[] = [
  PROVIDER_CARD_CONNECTED,
  PROVIDER_CARD_CAP_REACHED,
  PROVIDER_CARD_CREDIT_STALE,
  PROVIDER_CARD_LEGACY_ENV,
  {
    status: {
      provider: realProvider("calendar"),
      credential: demoCredential("calendar", {}),
      assets: [],
    },
    assets: [],
    probe: demoProbe({ ok: false, result: { outcome: "refused", facts: { feeds: 1, feedsTotal: 2 }, failing: ["Team calendar"], fix: { kind: "replace" } } }),
  },
  {
    status: {
      provider: realProvider("bing-webmaster"),
      credential: demoCredential("bing-webmaster", {
        source: "store",
        fields: ["BING_WEBMASTER_API_KEY"],
        updatedAt: iso(60 * DAY),
        lastUsedAt: iso(9 * HOUR),
        lastOkAt: iso(31 * DAY),
        lastError: "The API key was rejected — it may have been rotated in the Bing console.",
      }),
      assets: [{ id: "plate.example.com", lanes: ["bing-webmaster"] }],
    },
    assets: [{ id: "plate.example.com", displayName: "plate.example.com", domain: "plate.example.com" }],
    probe: demoProbe({ ok: false, result: { outcome: "refused", status: 401, fix: { kind: "replace" } } }),
  },
  // Discord, which is the ONLY card whose Test button reaches the operator's own
  // channel (bead `ro-vu8d.18`). It is here so the sentence that warns about
  // that gets reviewed beside the button it belongs to — and so the `url` field
  // kind, the one address that is itself a credential, is drawn somewhere.
  {
    status: {
      provider: realProvider("discord"),
      credential: demoCredential("discord", {
        source: "store",
        fields: ["DISCORD_WEBHOOK_URL"],
        updatedAt: iso(9 * DAY),
        lastUsedAt: iso(2 * DAY),
        lastOkAt: iso(2 * DAY),
      }),
      assets: [{ id: "home-os", lanes: ["discord-webhooks"] }],
    },
    assets: [{ id: "home-os", displayName: "home-os", domain: null }],
    probe: demoProbe({ ok: true, result: { outcome: "answered" } }),
  },
  // Clarity, the only PER-ASSET credential (bead `ro-vu8d.9`), shown in the
  // state that is normal for one: partly covered. Two facts are only visible
  // here — the served-assets list becomes a checklist, and the Test button
  // carries the sentence saying it will not call Clarity at all.
  {
    status: {
      provider: realProvider("clarity"),
      credential: demoCredential("clarity", {
        source: "store",
        fields: ["CLARITY_TOKENS"],
        assetsHeld: ["plate.example.com"],
        updatedAt: iso(21 * DAY),
        lastUsedAt: iso(11 * HOUR),
        lastOkAt: iso(11 * HOUR),
      }),
      assets: [
        { id: "plate.example.com", lanes: ["clarity"] },
        { id: "menu.example.org", lanes: ["clarity"] },
        { id: "finance.example.org", lanes: ["clarity"] },
      ],
      // WHAT IS LEFT OF TODAY (bead `ro-vu8d.25`), on the one provider that
      // declares a meter. It is here because doc 15 flow C step 3 asked for this
      // number in prose for months, and what a reviewer is judging is whether a
      // partly-spent day and an untouched one read differently at a glance.
      meter: {
        window: "asset-day",
        day: "2026-09-05",
        assets: [{ asset: "plate.example.com", spent: 3 }],
      },
    },
    assets: [
      { id: "plate.example.com", displayName: "plate.example.com", domain: "plate.example.com" },
      { id: "menu.example.org", displayName: "menu.example.org", domain: "menu.example.org" },
      { id: "finance.example.org", displayName: "finance.example.org", domain: "finance.example.org" },
    ],
    probe: demoProbe({ ok: true, result: { outcome: "not-checked", facts: { tokens: 1 }, fix: { kind: "run-now" } } }),
  },
  // The same per-asset credential still on the OLDER single-asset binding (bead
  // `ro-vu8d.24`) — an environment credential with one asset covered, and the only card that
  // names a binding the form has no input for. It is here because the sentence
  // is what stops a self-hoster deleting a value that is doing work, and because
  // this is the state that used to render Not connected over a data source that
  // was collecting every night.
  {
    status: {
      provider: realProvider("clarity"),
      credential: demoCredential("clarity", {
        source: "env",
        fields: [],
        assetsHeld: ["plate.example.com"],
        lastUsedAt: iso(11 * HOUR),
        lastOkAt: iso(11 * HOUR),
      }),
      assets: [
        { id: "plate.example.com", lanes: ["clarity"] },
        { id: "menu.example.org", lanes: ["clarity"] },
      ],
      // A day nothing has spent yet, beside the partly-spent one above — the
      // two ends of the same meter.
      meter: { window: "asset-day", day: "2026-09-05", assets: [] },
    },
    assets: [
      { id: "plate.example.com", displayName: "plate.example.com", domain: "plate.example.com" },
      { id: "menu.example.org", displayName: "menu.example.org", domain: "menu.example.org" },
    ],
    probe: demoProbe({ ok: true, result: { outcome: "not-checked", facts: { tokens: 1 }, fix: { kind: "run-now" } } }),
  },
];

// --- ProviderCard, the Google sign-in half (bead ro-vu8d.3) ----------------

/** The `google-oauth-app` companion, in the two states that matter: entered, or
 * not. It never gets a card of its own — `/integrations` filters it out on
 * `companionOf` — so the gallery is where its form is actually reviewable. */
function demoOAuthApp(entered: boolean): IntegrationProviderStatus {
  return {
    provider: realProvider("google-oauth-app"),
    credential: demoCredential(
      "google-oauth-app",
      entered
        ? {
            source: "store",
            fields: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
            updatedAt: iso(2 * DAY),
          }
        : { missingFields: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] },
    ),
    assets: [],
  };
}

/** Google, connected by SIGNING IN: the account, the scopes, the property list. */
const GOOGLE_SIGNED_IN: IntegrationProviderStatus = {
  provider: realProvider("google"),
  credential: demoCredential("google", {
    source: "store",
    fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
    auth: "oauth",
    metadata: {
      account: "ops@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/analytics.readonly",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ],
      connectedAt: iso(6 * HOUR),
      // The Testing-mode countdown the OAuth exchange records (bead
      // `ro-vu8d.8`): six hours in, so the chip is inside the T-14d window and
      // the gallery shows the warn-toned state rather than the quiet one.
      expiresAt: isoAhead(GOOGLE_TESTING_GRANT_DAYS * DAY - 6 * HOUR),
      expirySource: "flow",
    },
    updatedAt: iso(6 * HOUR),
    lastUsedAt: iso(20 * 60_000),
    lastOkAt: iso(20 * 60_000),
  }),
  assets: [
    { id: "plate.example.com", lanes: ["ga4", "gsc"] },
    { id: "menu.example.org", lanes: ["ga4", "gsc"] },
  ],
};

/**
 * The same grant after Google stopped accepting it (bead `ro-vu8d.14`).
 *
 * The state this card used to be UNABLE to show: a tick and "Signed in as
 * ops@example.com" while the nightly pull failed underneath. `lastError` is the
 * exact constant the ingest raises, so what is reviewed here is the sentence an
 * operator actually meets.
 */
const GOOGLE_GRANT_REVOKED: IntegrationProviderStatus = {
  ...GOOGLE_SIGNED_IN,
  credential: {
    ...GOOGLE_SIGNED_IN.credential,
    lastUsedAt: iso(7 * HOUR),
    lastOkAt: iso(31 * HOUR),
    lastError: "Google revoked this sign-in: Testing-mode grants last 7 days.",
  },
};

/** Google with nothing stored — the first-run card. */
const GOOGLE_NOT_CONNECTED: IntegrationProviderStatus = {
  provider: realProvider("google"),
  credential: demoCredential("google", {
    missingFields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
  }),
  assets: [{ id: "plate.example.com", lanes: ["ga4", "gsc"] }],
};

/** What the account can see. Takes a beat, so the spinner is a state somebody
 * can watch rather than one frame between two renders. */
const demoDiscovery = (): Promise<GooglePropertyDiscovery> =>
  new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: true,
          message: "2 GA4 properties and 3 Search Console sites.",
          checkedAt: new Date(NOW).toISOString(),
          account: "ops@example.com",
          auth: "oauth",
          properties: [
            { lane: "ga4", ref: "412330001", label: "Plate", detail: "Example Ventures" },
            { lane: "ga4", ref: "412330002", label: "Menu", detail: "Example Ventures" },
            { lane: "gsc", ref: "sc-domain:plate.example.com", label: "sc-domain:plate.example.com", detail: "siteOwner" },
            { lane: "gsc", ref: "sc-domain:menu.example.org", label: "sc-domain:menu.example.org", detail: "siteOwner" },
            { lane: "gsc", ref: "https://finance.example.org/", label: "https://finance.example.org/", detail: "siteFullUser" },
          ],
        }),
      600,
    ),
  );

function demoPanel(
  google: IntegrationProviderStatus,
  app: IntegrationProviderStatus,
  origin: string,
): ProviderOAuthPanel {
  return {
    card: googleOAuthCardState(google, app, origin),
    app,
    // The gallery must never actually leave for Google, so the link goes
    // nowhere — everything else on the panel is the shipped component.
    startHref: "#demo-sign-in",
    onSaveApp: demoConnect,
    onDiscover: demoDiscovery,
  };
}

const GOOGLE_OAUTH_DEMOS: {
  key: string;
  note: string;
  status: IntegrationProviderStatus;
  panel: ProviderOAuthPanel;
}[] = [
  {
    key: "app-missing",
    note:
      "First run: Google has never heard of this OS, so the card asks for the console setup and nothing else. The redirect address is shown inside the step that needs it — a value pasted into the wrong box is the failure this section exists to prevent.",
    status: GOOGLE_NOT_CONNECTED,
    panel: demoPanel(GOOGLE_NOT_CONNECTED, demoOAuthApp(false), "http://127.0.0.1:5173"),
  },
  {
    key: "ready",
    note:
      "The OAuth client is stored and the address is one Google will return to, so there is a button — beside the service-account paste, which still works and is not being taken away.",
    status: GOOGLE_NOT_CONNECTED,
    panel: demoPanel(GOOGLE_NOT_CONNECTED, demoOAuthApp(true), "http://127.0.0.1:5173"),
  },
  {
    key: "redirect-unusable",
    note:
      "The same install, opened over the LAN. Google refuses every plain-http address that is not loopback, and `os:up` binds the LAN by default — so this is the normal way to meet this wall, and the card answers with the address to use instead rather than letting the operator find out from Google.",
    status: GOOGLE_NOT_CONNECTED,
    panel: demoPanel(GOOGLE_NOT_CONNECTED, demoOAuthApp(true), "http://192.168.1.20:5173"),
  },
  {
    key: "connected",
    note:
      "Signed in: whose account, what the grant covers in words rather than scope URLs, and — on demand — what that account can actually see. The list is read-only; which asset each GA4 property or Search Console site belongs to is the operator's answer and gets its own surface (ro-vu8d.4).",
    status: GOOGLE_SIGNED_IN,
    panel: demoPanel(GOOGLE_SIGNED_IN, demoOAuthApp(true), "http://127.0.0.1:5173"),
  },
  {
    key: "revoked",
    note:
      "And the state this card could not show until ro-vu8d.14: Google has stopped accepting the sign-in — a Testing-mode consent screen expires every grant after seven days. The identity is still printed, because it is what says WHICH account to sign back in as, but the tick is gone, the scopes go neutral (they describe access that no longer exists), and Sign in again is the loudest control on the card instead of a muted link. The verdict slot carries the constant the ingest stamps; both ways out are presses: Sign in again, or Publish app on the expiry line so it stops recurring.",
    status: GOOGLE_GRANT_REVOKED,
    panel: demoPanel(GOOGLE_GRANT_REVOKED, demoOAuthApp(true), "http://127.0.0.1:5173"),
  },
];

/** The spokes the demo composer offers, so the gallery does not depend on
 * `/api/settings` answering. Two is enough to show the select doing its job. */
const DEMO_SPOKES: TaskHubSpoke[] = [
  { asset: "plate.example.com", prefix: "mp", database: "mp", repo: "../plate.example.com" },
  { asset: "home-os", prefix: "ro", database: "ro", repo: "." },
];

/** A finding's handoff, as data — the very object `ExecutiveInsightRow` hands
 * its own File task button, so the gallery shows the real locked labels and the
 * real `noticeos_*` metadata rather than a plausible-looking imitation. */
const DEMO_HANDOFF_PREFILL = taskHandoffPrefill({
  asset: "plate.example.com",
  kind: "finding",
  key: "query-cannibalization",
  rule: "query-cannibalization",
  title: "Two pages compete for “high protein breakfast”",
  summary:
    "From the NoticeOS finding for plate.example.com (Warning sign): two pages split the impressions for one query.",
  priority: 1,
});

const activitySeries = series([12, 14, 9, 16, 21, 18, 24], "d");
const netTrend = series([-40, 20, 55, 90, 140, 190]);

const insightDemo: ExecutiveInsight = {
  key: "demo-search-opportunity",
  kind: "recommendation",
  title: "Move “weekly meal plan” into the top results",
  summary:
    "/meal-plan is already visible at average position 6.1 with 1,003 captured impressions.",
  whyItMatters:
    "This is observed demand below the highest-click positions, not a speculative keyword.",
  primary: { value: "1,003", label: "captured impressions" },
  confidence: "high",
  windowStart: "2026-07-25",
  windowEnd: "2026-07-28",
  evidence: [
    { label: "Average position", value: "6.1" },
    { label: "CTR", value: "3.8%" },
    { label: "Clicks", value: "38" },
    { label: "Page", value: "/meal-plan" },
  ],
  sources: ["gsc/page-query", "bing-webmaster/queries"],
  caveat: "GSC page/query exports contain top rows and can omit low-volume demand.",
};

// --- asset-detail chart + decision demos -----------------------------------
// 28 visible days from Thursday 2026-07-02, preceded by seven calculation-only
// dates so the first visible day still has a prior-week reference.
const DAU_CONTEXT = dailySeries([61, 58, 66, 72, 69, 74, 70], "2026-06-25");
const DAU_VISIBLE = dailySeries(
  [
    75, 81, 78, 84, 90, 71, 68, 88, 94, 91, 97, 102, 79, 74, 99, 108, 104,
    111, 118, 86, 81, 115, 121, 117, 124, 130, 95, 62,
  ],
  "2026-07-02",
);
const DAU_PROVISIONAL_FROM = DAU_VISIBLE.at(-1)!.t;

// A reporting-timezone change inside the visible window (`ro-kukv.8`). The
// marked days are DERIVED from it — the change day and the one before it — so
// this fixture names an event, never a pair of dates.
/**
 * The zones the gallery demonstrates a move between, read from the runtime's
 * own tz database rather than written into the product (bead `ro-ujb9.118`).
 * UTC stands in where the runtime lists none.
 */
const [DEMO_ZONE_WEST, DEMO_ZONE_EAST] = demoZones();
function demoZones(): [string, string] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const pick = (area: string) => zones.find((zone) => zone.startsWith(`${area}/`)) ?? "UTC";
  return [pick("America"), pick("Europe")];
}

const DAU_TIME_ZONE_CHANGE = [
  {
    effectiveOn: "2026-07-22",
    from: DEMO_ZONE_WEST,
    to: DEMO_ZONE_EAST,
  },
];

// The fourteen days a 7-vs-7 chip over the visible window really compares — the
// latest complete day back thirteen. The change above sits inside it, which is
// what withdraws the tile's color verdict (`ro-kukv.13`).
const DISTORTED_WEEKLY_WINDOW = { start: "2026-07-15", end: "2026-07-28" };

const demoProperty = {
  id: "plate.example.com",
  displayName: "Plate",
  domain: "plate.example.com",
};

/** One fixture per PAGE decision lane (bead `ro-427`): a page that lost clicks,
 * one shown far more than it is taken, one walled by an overview on its largest
 * query, one that overview cites, one gaining, and one genuinely flat — which
 * stays in the table, because flat is a finding and a missing row is not. */
const pageTrendsDemo: SearchPageTrends = {
  provider: "google",
  currentStart: "2026-07-23",
  currentEnd: "2026-07-29",
  previousStart: "2026-07-16",
  previousEnd: "2026-07-22",
  daysPerWindow: 7,
  pages: [
    {
      page: "https://plate.example.com/dri-calculator",
      path: "/dri-calculator",
      currentClicks: 21,
      previousClicks: 84,
      clickDelta: -63,
      clickDeltaPercent: -75,
      currentImpressions: 2800,
      previousImpressions: 2760,
      impressionDelta: 40,
      impressionDeltaPercent: 1.4,
      currentPosition: 5.2,
      previousPosition: 5.1,
      positionImprovement: -0.1,
      currentCtr: 0.0075,
      previousCtr: 0.03,
      leadingQuery: {
        query: "dri calculator",
        impressions: 1900,
        clicks: 14,
        position: 5.4,
        aioDevices: [],
      },
    },
    {
      page: "https://plate.example.com/worksheets",
      path: "/worksheets",
      currentClicks: 6,
      previousClicks: 6,
      clickDelta: 0,
      clickDeltaPercent: 0,
      currentImpressions: 2400,
      previousImpressions: 900,
      impressionDelta: 1500,
      impressionDeltaPercent: 166.7,
      currentPosition: 14.2,
      previousPosition: 11.8,
      positionImprovement: -2.4,
      currentCtr: 0.0025,
      previousCtr: 0.0067,
      leadingQuery: {
        query: "plate worksheets",
        impressions: 1200,
        clicks: 4,
        position: 12.9,
        aioDevices: [],
      },
    },
    {
      page: "https://plate.example.com/calculator",
      path: "/calculator",
      currentClicks: 34,
      previousClicks: 37,
      clickDelta: -3,
      clickDeltaPercent: -8.1,
      currentImpressions: 4200,
      previousImpressions: 4100,
      impressionDelta: 100,
      impressionDeltaPercent: 2.4,
      currentPosition: 6.8,
      previousPosition: 6.9,
      positionImprovement: 0.1,
      currentCtr: 0.0081,
      previousCtr: 0.009,
      leadingQuery: {
        query: "plate calculator",
        impressions: 3100,
        clicks: 28,
        position: 6.2,
        aioDevices: [],
      },
    },
    {
      page: "https://plate.example.com/recipes",
      path: "/recipes",
      currentClicks: 8,
      previousClicks: 9,
      clickDelta: -1,
      clickDeltaPercent: -11.1,
      currentImpressions: 3100,
      previousImpressions: 3050,
      impressionDelta: 50,
      impressionDeltaPercent: 1.6,
      currentPosition: 6.4,
      previousPosition: 6.5,
      positionImprovement: 0.1,
      currentCtr: 0.0026,
      previousCtr: 0.003,
      leadingQuery: {
        query: "where to find free meal plans",
        impressions: 2400,
        clicks: 2,
        position: 5.9,
        aioDevices: [
          { device: "mobile", aioPresent: true, aioCitesUs: false },
          { device: "desktop", aioPresent: true, aioCitesUs: false },
        ],
      },
    },
    {
      page: "https://plate.example.com/food-groups",
      path: "/food-groups",
      currentClicks: 44,
      previousClicks: 121,
      clickDelta: -77,
      clickDeltaPercent: -63.6,
      currentImpressions: 1800,
      previousImpressions: 2600,
      impressionDelta: -800,
      impressionDeltaPercent: -30.8,
      currentPosition: 4.8,
      previousPosition: 3.4,
      positionImprovement: -1.4,
      currentCtr: 0.024,
      previousCtr: 0.047,
      leadingQuery: {
        query: "5 food groups",
        impressions: 1400,
        clicks: 33,
        position: 4.1,
        aioDevices: [
          { device: "mobile", aioPresent: true, aioCitesUs: true },
          { device: "desktop", aioPresent: true, aioCitesUs: true },
        ],
      },
    },
    {
      page: "https://plate.example.com/meal-plans",
      path: "/meal-plans",
      currentClicks: 96,
      previousClicks: 61,
      clickDelta: 35,
      clickDeltaPercent: 57.4,
      currentImpressions: 2200,
      previousImpressions: 1900,
      impressionDelta: 300,
      impressionDeltaPercent: 15.8,
      currentPosition: 4.1,
      previousPosition: 5.6,
      positionImprovement: 1.5,
      currentCtr: 0.0436,
      previousCtr: 0.0321,
      leadingQuery: {
        query: "free meal plans",
        impressions: 1500,
        clicks: 70,
        position: 3.8,
        aioDevices: [
          { device: "mobile", aioPresent: false, aioCitesUs: false },
          { device: "desktop", aioPresent: false, aioCitesUs: false },
        ],
      },
    },
    {
      page: "https://plate.example.com/food-groups/vegetables",
      path: "/food-groups/vegetables",
      currentClicks: 41,
      previousClicks: 45,
      clickDelta: -4,
      clickDeltaPercent: -8.9,
      currentImpressions: 1400,
      previousImpressions: 1360,
      impressionDelta: 40,
      impressionDeltaPercent: 2.9,
      currentPosition: 9.4,
      previousPosition: 7.9,
      positionImprovement: -1.5,
      currentCtr: 0.0293,
      previousCtr: 0.0331,
      leadingQuery: {
        query: "vegetable group",
        impressions: 800,
        clicks: 26,
        position: 8.8,
        aioDevices: [],
      },
    },
    {
      page: "https://plate.example.com/about",
      path: "/about",
      currentClicks: 12,
      previousClicks: 14,
      clickDelta: -2,
      clickDeltaPercent: -14.3,
      currentImpressions: 310,
      previousImpressions: 300,
      impressionDelta: 10,
      impressionDeltaPercent: 3.3,
      currentPosition: 8.9,
      previousPosition: 8.8,
      positionImprovement: -0.1,
      currentCtr: 0.0387,
      previousCtr: 0.0467,
      leadingQuery: null,
    },
  ],
  evidence: [
    {
      label: "Grounding queries excluded from the leading-query join",
      value: "4,216",
      detail:
        "9.0% of captured page/query impressions · 101 quoted-literal queries · 0 clicks. The click and impression totals on each row are the page family’s own and are NOT decontaminated: a page row carries no query to classify.",
    },
  ],
  source: "gsc/page",
  caveat:
    "Search Console page exports are top rows: a page reported in only one of the two weeks is unknown rather than zero and is left out.",
};

/** The page rows' real task-register states (bead `ro-e46.4`). The absolute URL
 * is the join key; the shorter path is presentation only. */
const pageHandoffBeadsDemo: HandoffBead[] = [
  {
    kind: "page",
    key: "https://plate.example.com/dri-calculator",
    beadId: "mp-7aa",
    status: "open",
    closedAt: null,
  },
  {
    kind: "page",
    key: "https://plate.example.com/food-groups",
    beadId: "mp-3fd",
    status: "closed",
    closedAt: iso(28 * HOUR),
  },
];

/** One fixture per decision lane: a loss to recover, a page-one near win, a
 * page-two opportunity, an AI-Overview organic gap, a protected top-3 result,
 * and a query with no usable evidence yet. */
const queryTrendsDemo: SearchQueryTrends = {
  google: {
    provider: "google",
    currentStart: "2026-07-23",
    currentEnd: "2026-07-29",
    previousStart: "2026-07-16",
    previousEnd: "2026-07-22",
    daysPerWindow: 7,
    movers: [
      {
        query: "weekly meal plan",
        currentImpressions: 1403,
        previousImpressions: 1002,
        impressionDelta: 401,
        impressionDeltaPercent: 40,
        currentPosition: 6.1,
        previousPosition: 7.4,
        positionImprovement: 1.3,
      },
      {
        query: "macro calculator",
        currentImpressions: 164,
        previousImpressions: 1640,
        impressionDelta: -1476,
        impressionDeltaPercent: -90,
        currentPosition: 18.2,
        previousPosition: 9.4,
        positionImprovement: -8.8,
      },
      {
        query: "portion size guide",
        currentImpressions: 220,
        previousImpressions: 210,
        impressionDelta: 10,
        impressionDeltaPercent: 4.8,
        currentPosition: 2.4,
        previousPosition: 2.6,
        positionImprovement: 0.2,
      },
      {
        query: "meal prep containers",
        currentImpressions: 31,
        previousImpressions: 30,
        impressionDelta: 1,
        impressionDeltaPercent: 3.3,
        currentPosition: 41.2,
        previousPosition: 41.8,
        positionImprovement: 0.6,
      },
      {
        query: "grocery list template",
        currentImpressions: 302,
        previousImpressions: 288,
        impressionDelta: 14,
        impressionDeltaPercent: 4.9,
        currentPosition: 4.2,
        previousPosition: 4.5,
        positionImprovement: 0.3,
      },
      {
        query: "healthy dinner ideas",
        currentImpressions: 480,
        previousImpressions: 300,
        impressionDelta: 180,
        impressionDeltaPercent: 60,
        currentPosition: 12.4,
        previousPosition: 14,
        positionImprovement: 1.6,
      },
    ],
    // Both states of the proof row on one page: Google excluded something, Bing
    // excluded nothing and says so. The zero row is the one worth looking at —
    // it is what "the check ran and came back clean" has to look like, and it
    // must never be mistaken for a lane that was never checked (which renders
    // no row at all).
    evidence: [
      {
        label: "Grounding queries excluded",
        value: "4,217",
        detail: "9.0% of captured impressions · 102 quoted-literal queries · 0 clicks",
      },
    ],
    source: "gsc/query",
    caveat: "Only queries present in both top-row windows are ranked.",
  },
  bing: {
    provider: "bing",
    currentStart: "2026-07-23",
    currentEnd: "2026-07-29",
    previousStart: "2026-07-16",
    previousEnd: "2026-07-22",
    daysPerWindow: 7,
    movers: [
      {
        query: "Weekly Meal Plan",
        currentImpressions: 96,
        previousImpressions: 88,
        impressionDelta: 8,
        impressionDeltaPercent: 9.1,
        currentPosition: 8.8,
        previousPosition: 9.1,
        positionImprovement: 0.3,
      },
    ],
    evidence: [
      {
        label: "Grounding queries excluded",
        value: "0",
        detail: "No quoted-literal queries in this window",
      },
    ],
    source: "bing-webmaster/queries",
    caveat: "Bing reports a smaller top-row set than Search Console.",
  },
  dataforseo: {
    observedAt: "2026-07-28",
    queries: [
      {
        query: "weekly meal plan",
        monthlySearches: 1900,
        organicPosition: 7,
        previousOrganicPosition: 9,
        positionImprovement: 2,
        keywordDifficulty: 24,
        estimatedVisits: 31,
        page: "/meal-plan",
        intent: "informational",
        aiOverview: "cited",
        aiCitationPosition: 2,
        // Not on the tracked panel: the two panel rules must leave this row
        // exactly as it was before the panel existed.
        aioDevices: [],
      },
      {
        // Tracked and clear: the panel read the result page and found no
        // overview, so this stays an act-lane ranking opportunity.
        query: "high protein lunch ideas",
        monthlySearches: 4400,
        organicPosition: 14,
        previousOrganicPosition: null,
        positionImprovement: null,
        keywordDifficulty: 38,
        estimatedVisits: 12,
        page: "/lunch",
        intent: "informational",
        aiOverview: "present",
        aiCitationPosition: null,
        aioDevices: [
          { device: "mobile", aioPresent: false, aioCitesUs: false },
          { device: "desktop", aioPresent: false, aioCitesUs: false },
        ],
      },
      {
        // Tracked and walled ON THE PHONE ONLY — the split ro-o1n bought the
        // second device for. The demotion still fires: an overview that
        // consumes the click on the phone is not undone by a clear desktop.
        query: "how many calories should i eat",
        monthlySearches: 74000,
        organicPosition: 6,
        previousOrganicPosition: 6,
        positionImprovement: 0,
        keywordDifficulty: 44,
        estimatedVisits: 210,
        page: "/calculator",
        intent: "informational",
        aiOverview: "present",
        aiCitationPosition: null,
        aioDevices: [
          { device: "mobile", aioPresent: true, aioCitesUs: false },
          { device: "desktop", aioPresent: false, aioCitesUs: false },
        ],
      },
      {
        // Tracked and cited: protected regardless of where the rank is going.
        query: "what is plate",
        monthlySearches: 9900,
        organicPosition: 12,
        previousOrganicPosition: 9,
        positionImprovement: -3,
        keywordDifficulty: 19,
        estimatedVisits: 46,
        page: "/what-is-plate",
        intent: "informational",
        aiOverview: "cited",
        aiCitationPosition: 1,
        aioDevices: [
          { device: "mobile", aioPresent: true, aioCitesUs: true },
          { device: "desktop", aioPresent: true, aioCitesUs: true },
        ],
      },
      {
        query: "portion size guide",
        monthlySearches: 720,
        organicPosition: 2,
        previousOrganicPosition: 2,
        positionImprovement: 0,
        keywordDifficulty: 11,
        estimatedVisits: 88,
        page: "/portions",
        intent: "informational",
        aiOverview: "none",
        aiCitationPosition: null,
        aioDevices: [],
      },
      {
        query: "calorie deficit meals",
        monthlySearches: 2900,
        organicPosition: 34,
        previousOrganicPosition: null,
        positionImprovement: null,
        keywordDifficulty: 46,
        estimatedVisits: null,
        page: "(not set)",
        intent: "commercial",
        aiOverview: "cited",
        aiCitationPosition: 4,
        aioDevices: [],
      },
      {
        query: "grocery list template",
        monthlySearches: 5400,
        organicPosition: 25,
        previousOrganicPosition: 23,
        positionImprovement: -2,
        keywordDifficulty: 52,
        estimatedVisits: 4,
        page: "/lists",
        intent: "informational",
        aiOverview: "present",
        aiCitationPosition: null,
        aioDevices: [],
      },
      {
        query: "meal planning app",
        monthlySearches: 8100,
        organicPosition: 27,
        previousOrganicPosition: null,
        positionImprovement: null,
        keywordDifficulty: 61,
        estimatedVisits: null,
        page: "/",
        intent: "commercial",
        aiOverview: "none",
        aiCitationPosition: null,
        aioDevices: [],
      },
    ],
    source: "dataforseo/ranked-keywords",
    caveat: "Search volume is estimated market demand, not asset impressions.",
  },
};

/** What the register holds for those queries (bead `ro-5e8.3`). Keys are the
 * normalized query — lowercased and trimmed — because that is the `noticeos_key`
 * the copied `bd create` carries and the poller reads back off the bead. */
const queryHandoffBeadsDemo: HandoffBead[] = [
  { kind: "query", key: "macro calculator", beadId: "mp-1w2", status: "open", closedAt: null },
  {
    kind: "query",
    key: "what is plate",
    beadId: "mp-4qd",
    status: "closed",
    closedAt: iso(30 * HOUR),
  },
  // A finding's bead under a key that reads like a query: filtered out, never
  // borrowed by the row that happens to share the string.
  { kind: "finding", key: "portion size guide", beadId: "mp-9zz", status: "open", closedAt: null },
];

/** One weekly tracked panel, shaped like menu.example.org's real 2026-08-03 collection:
 * a couple of top-3 terms, a mid-page cluster, several with no result inside the
 * pull's depth at all, and every AI-Overview state including unknown. Small
 * enough to read on one screen, wide enough that all four rank tiers and both
 * AI denominators are non-trivial.
 *
 * ONE ROW PER (TERM, DEVICE) since `ro-14d.1`. Nine terms, and `macro
 * calculator` is deliberately the disagreeing pair — walled on the phone, clear
 * on the desktop — so the registry's rendered reference contains the case the
 * second device was bought to find. Ten rows, nine tracked: the scoreboard
 * counts terms, and a demo that let a split double a denominator would be the
 * bug rendered as documentation.
 *
 * CLUSTER-LABELLED since `ro-282.5`, and deliberately MIXED: two named bets
 * plus two terms from a pre-label collection. A demo where everything carries a
 * label would never show the trailing ungrouped run, which is the case both
 * plate.example.com and the other site's own history depend on. */
const panelComposition = (
  top3Domains: string[],
  overrides: Partial<NonNullable<SerpPanelQuery["composition"]>> = {},
): NonNullable<SerpPanelQuery["composition"]> => ({
  top3Domains,
  organicResults: 20,
  secondRank: null,
  secondUrl: null,
  serpFeatures: ["people_also_ask", "related_searches"],
  ...overrides,
});

const panelDemo: SerpPanelSnapshot = {
  reportDate: "2026-08-03",
  trackedDepth: 20,
  market: null,
  queries: [
    { query: "calorie calculator", device: "desktop", label: "Calculator seam", bestRank: 2, bestUrl: "https://menu.example.org/calories", aioPresent: true, aioCitesUs: true, composition: panelComposition(["calculator.net", "menu.example.org", "omnicalculator.com"], { secondRank: 8, secondUrl: "https://menu.example.org/tdee" }) },
    { query: "macro calculator", device: "mobile", label: "Calculator seam", bestRank: 3, bestUrl: "https://menu.example.org/macros", aioPresent: true, aioCitesUs: false, composition: panelComposition(["calculator.net", "omnicalculator.com", "menu.example.org"], { serpFeatures: ["ai_overview", "people_also_ask", "related_searches"] }) },
    { query: "macro calculator", device: "desktop", label: "Calculator seam", bestRank: 3, bestUrl: "https://menu.example.org/macros", aioPresent: false, aioCitesUs: false, composition: panelComposition(["omnicalculator.com", "calculator.net", "menu.example.org"]) },
    { query: "tdee calculator", device: "desktop", label: "Calculator seam", bestRank: 7, bestUrl: "https://menu.example.org/tdee", aioPresent: false, aioCitesUs: false, composition: panelComposition(["tdeecalculator.net", "calculator.net", "forbes.com"], { organicResults: 18 }) },
    { query: "protein calculator", device: "desktop", label: "Calculator seam", bestRank: 9, bestUrl: "https://menu.example.org/protein", aioPresent: true, aioCitesUs: false, composition: panelComposition(["calculator.net", "promixnutrition.com", "healthline.com"], { serpFeatures: ["ai_overview", "images", "people_also_ask"] }) },
    { query: "bmr calculator", device: "desktop", label: "Calculator seam", bestRank: 14, bestUrl: "https://menu.example.org/bmr", aioPresent: false, aioCitesUs: false, composition: panelComposition(["calculator.net", "omnicalculator.com", "verywellfit.com"]) },
    // Checked, and the overview did not load — unknown, which draws no glyph
    // rather than the ghosted "checked and clear" one. Also unlabelled: a
    // collection older than ro-282.2, which is normal input and stays in the
    // trailing ungrouped run rather than becoming a seventh bet.
    { query: "meal calorie counter", device: "desktop", label: null, bestRank: 18, bestUrl: "https://menu.example.org/counter", aioPresent: null, aioCitesUs: null, composition: panelComposition(["myfitnesspal.com", "calorieking.com", "fatsecret.com"]) },
    { query: "chipotle calorie calculator", device: "desktop", label: "Item head", bestRank: null, bestUrl: null, aioPresent: false, aioCitesUs: false, composition: panelComposition(["chipotle.com", "chipotlenutrition.org", "womeninbalance.org"], { organicResults: 19, serpFeatures: ["related_searches"] }) },
    { query: "starbucks calorie calculator", device: "desktop", label: "Item head", bestRank: null, bestUrl: null, aioPresent: true, aioCitesUs: false, composition: panelComposition(["cheatdaydesign.com", "starbucks.com", "calculator.net"], { serpFeatures: ["ai_overview", "related_searches"] }) },
    // Provider-unread: the whole neighborhood is absent, never a confident
    // empty top three or a claim that the page had zero organic results.
    { query: "restaurant nutrition lookup", device: "desktop", label: null, bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null, composition: null },
  ],
};

const findingsSnapshotDemo: ExecutiveSnapshot = {
  schemaVersion: 1,
  asset: "kitchen-sink.demo",
  generatedAt: iso(3 * HOUR),
  windowStart: "2026-07-25",
  windowEnd: "2026-07-28",
  sourceArchiveCount: 12,
  items: [
    {
      ...insightDemo,
      key: "demo-findings-warning",
      kind: "warning",
      title: "JavaScript errors concentrate on /calculator",
      primary: { value: "570", label: "JavaScript errors" },
    },
    insightDemo,
    {
      ...insightDemo,
      key: "demo-findings-discovery",
      kind: "discovery",
      title: "AI assistants are already sending identifiable visits",
      primary: { value: "40", label: "AI-referred sessions" },
    },
    {
      ...insightDemo,
      key: "demo-findings-insight",
      kind: "insight",
      title: "The calculator is completing meaningful user jobs",
      primary: { value: "1,162", label: "Calculation Complete" },
    },
  ],
  // What the eight-card cut dropped: named here, reachable in the list's quiet
  // reveal, and carrying identity only — a suppressed card is a mention, not a
  // finding the operator can act on from the page.
  suppressedItems: [
    {
      key: "demo-findings-suppressed-cluster",
      kind: "discovery",
      title: "56,500 monthly searches sit past the near-win band on /water-intake-calculator",
    },
    {
      key: "demo-findings-suppressed-appearance",
      kind: "discovery",
      title: "Recipe results are the leading search treatment",
    },
  ],
  searchQueries: null,
  searchPages: null,
  productUse: null,
  searchIntelligence: null,
  serpPanel: null,
  methodology: [
    "Findings are deterministic rules over the archived provider reports.",
    "A provider row that is missing stays unknown; it never becomes a zero.",
  ],
};

/** What the register holds for the demo findings above. The warning was filed
 * and is still open; the discovery was filed and has since shipped — shipped,
 * NOT proven. The other two were never filed, and the `query` row is here to
 * prove the list ignores kinds that are not its own even when a key matches. */
const findingsHandoffBeadsDemo: HandoffBead[] = [
  {
    kind: "finding",
    key: "demo-findings-warning",
    beadId: "mp-1w2",
    status: "open",
    closedAt: null,
  },
  {
    kind: "finding",
    key: "demo-findings-discovery",
    beadId: "mp-4kq",
    status: "closed",
    closedAt: iso(48 * HOUR),
  },
  {
    kind: "query",
    key: "demo-findings-insight",
    beadId: "mp-9zz",
    status: "open",
    closedAt: null,
  },
];

const emptyFindingsSnapshotDemo: ExecutiveSnapshot = {
  ...findingsSnapshotDemo,
  asset: "kitchen-sink.demo-empty",
  items: [],
  // A snapshot with nothing to show has nothing the cut could have dropped, so
  // the reveal is absent rather than an affordance opening onto nothing.
  suppressedItems: [],
};

/**
 * The strip's meetings run off a fixed 9:05 AM anchor instead of the live
 * clock, so "in 10m" is still "in 10m" at 11pm. `WallStrip` is pure over
 * `nowMs`, which is exactly what that prop is for.
 */
const MEETINGS_NOW = (() => {
  const anchor = new Date(NOW);
  anchor.setHours(9, 5, 0, 0);
  return anchor.getTime();
})();

/** A local wall-clock time on the anchor day (or `days` after it). */
function meetingAt(days: number, hour: number, minute: number): string {
  const at = new Date(MEETINGS_NOW);
  at.setDate(at.getDate() + days);
  at.setHours(hour, minute, 0, 0);
  return at.toISOString();
}

function meeting(
  calendar: string,
  title: string,
  start: [days: number, hour: number, minute: number],
  minutes: number,
  location: string | null = null,
): UpcomingMeeting {
  const startsAt = meetingAt(...start);
  return {
    calendar,
    title,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    allDay: false,
    location,
  };
}

/** A meeting placed against the LIVE clock, for the full-row demo — that row
 * runs `DashboardWidgets`' own one-second tick rather than the fixed anchor. */
function liveMeeting(
  calendar: string,
  title: string,
  startsInMs: number,
  minutes: number,
  location: string | null = null,
): UpcomingMeeting {
  return {
    calendar,
    title,
    startsAt: new Date(NOW + startsInMs).toISOString(),
    endsAt: new Date(NOW + startsInMs + minutes * 60_000).toISOString(),
    allDay: false,
    location,
  };
}

/** Two feeds with no pinned color, so the gallery's default is the fallback hue
 * taken from config order. `PINNED_FEEDS` below is the other half of that pair. */
const GALLERY_FEEDS: CalendarFeed[] = [
  { id: "work", color: null, status: "ok" },
  { id: "personal", color: null, status: "ok" },
];

/** The same two feeds with colors the operator pinned in their calendar app. */
const PINNED_FEEDS: CalendarFeed[] = [
  { id: "work", color: "#0b8043", status: "ok" },
  { id: "personal", color: "#8e24aa", status: "ok" },
];

function upcoming(
  meetings: UpcomingMeeting[],
  feedsConfigured = 2,
  feedsOk = feedsConfigured,
  calendars = GALLERY_FEEDS,
): CalendarUpcoming {
  return {
    fetchedAt: new Date(MEETINGS_NOW).toISOString(),
    feedsConfigured,
    feedsOk,
    calendars,
    meetings,
  };
}

/** The rest of today after the hero — the same three rows in several fixtures,
 * so a state differs from its neighbour only in the thing it is demonstrating. */
const REST_OF_DAY: UpcomingMeeting[] = [
  meeting("work", "Design review", [0, 11, 0], 50),
  meeting("personal", "Dentist", [0, 13, 30], 45),
  meeting("work", "Vendor call — renewal terms", [0, 15, 0], 30),
];

/** Which heading a registry entry's folder falls under. The registry's own
 * order decides the order these appear in — this map only names them. */
const REGISTRY_GROUPS: Record<string, string> = {
  "components/": "Composite",
  "components/ui/": "Primitives (vendored)",
  "components/surface/": "Surface (doc 21)",
  "components/bands/": "Bands",
  "components/wall/": "Wall",
};

/**
 * The registry's inventory, read straight out of `components/registry.ts` —
 * this page is that file's one importer (doc 14, bead `ro-6bhm`). Nothing below
 * is typed by hand: a component that enters the registry appears here, and
 * `scripts/component-registry.test.mjs` fails the build for a component that
 * never entered it, an entry naming a file that is gone, an entry with no row
 * in REGISTRY.md, or an entry with no demo further down this page.
 */
function RegistryContents() {
  const groups = new Map<string, string[]>();
  for (const entry of COMPONENT_REGISTRY) {
    const folder = entry.file.slice(0, entry.file.lastIndexOf("/") + 1);
    const label = REGISTRY_GROUPS[folder] ?? "Composite";
    groups.set(label, [...(groups.get(label) ?? []), entry.name]);
  }
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        What the catalog holds —{" "}
        <span className="tabular-nums">{COMPONENT_REGISTRY.length}</span> entries
      </summary>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[...groups].map(([label, names]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
              {label} <span className="tabular-nums">({names.length})</span>
            </h3>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {names.map((name) => (
                <li key={name} className="truncate" title={name}>
                  {name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        Check this before building anything — a near-duplicate is a rejected
        completion, not a style note. Every entry renders somewhere below except
        the few whose exception{" "}
        <code className="font-mono">REGISTRY.md</code> records, and the same list
        is what <code className="font-mono">pnpm test:scripts</code> holds the
        catalog, its written mirror and this page to.
      </p>
    </details>
  );
}

// Gallery controls never open another app tab.
const GALLERY_NO_OPEN = () => {};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-4 rounded-lg border border-border p-4">
        {children}
      </div>
    </section>
  );
}

const NO_RESIDUE = {
  booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
};

const portfolioNormal: PortfolioData = { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
  period: "2026-06",
  periodIsCurrent: true,
  booked: { currency: 'USD', revenue: 210, cost: 20, net: 190 },
  forecast: { currency: 'USD', revenue: 560, cost: 78.9, net: 481.1 },
  netTrend,
  netTrendAll: netTrend,
  trendGranularity: "monthly",
  // The last two CLOSED months — never the open one the headline states.
  bookedDelta: { currency: 'USD', value: 50, percent: 55.6, period: "2026-05", priorPeriod: "2026-04" },
  residue: NO_RESIDUE,
  firstRun: false,
  daysIn: 42,
};

/**
 * The scheduled-run records behind the System band's summary line, as their own
 * fixtures so every posture is visible rather than only the healthy one the
 * System card happens to carry. `silent` is decided by age alone — nothing has
 * started for longer than the contract's silence window — so it needs no failed
 * or skipped record to reach it.
 */
const SCHEDULED_HEALTHY: ScheduledLane[] = [
  { job: "cron 30 2 * * *", outcome: "ran", startedAt: iso(5 * HOUR) },
  { job: "backup", outcome: "ran", startedAt: iso(3 * HOUR) },
  { job: "beads-snapshot", outcome: "ran", startedAt: iso(HOUR) },
];

const SCHEDULED_SKIPPED: ScheduledLane[] = [
  ...SCHEDULED_HEALTHY.slice(1),
  { job: "cron 45 12 * * 1", outcome: "skipped", startedAt: iso(4 * HOUR) },
];

const SCHEDULED_FAILED: ScheduledLane[] = [
  ...SCHEDULED_HEALTHY.slice(1),
  { job: "cron 0 4 * * *", outcome: "failed", startedAt: iso(6 * HOUR) },
];

const SCHEDULED_SILENT: ScheduledLane[] = SCHEDULED_HEALTHY.map((lane) => ({
  ...lane,
  startedAt: iso(3 * DAY),
}));

/** The full matrix asset #0's page draws: a failed job, a skipped one, and the
 * rest of the runner's inventory sorted behind them. */
const SCHEDULED_MATRIX: ScheduledLane[] = [
  { job: "cron 0 4 * * *", outcome: "failed", startedAt: iso(6 * HOUR) },
  { job: "cron 45 12 * * 1", outcome: "skipped", startedAt: iso(4 * HOUR) },
  { job: "cron 0 * * * *", outcome: "ran", startedAt: iso(40 * 60_000) },
  { job: "cron 30 2 * * *", outcome: "ran", startedAt: iso(5 * HOUR) },
  { job: "cron 0 3 * * *", outcome: "ran", startedAt: iso(4.5 * HOUR) },
  { job: "cron 30 3 * * *", outcome: "ran", startedAt: iso(4 * HOUR) },
  { job: "cron */15 * * * *", outcome: "ran", startedAt: iso(9 * 60_000) },
  { job: "panel-refresh", outcome: "ran", startedAt: iso(7 * HOUR) },
  { job: "beads-hub", outcome: "ran", startedAt: iso(2 * HOUR) },
  { job: "beads-snapshot", outcome: "ran", startedAt: iso(HOUR) },
  { job: "backup", outcome: "ran", startedAt: iso(3 * HOUR) },
];

const systemNormal: SystemData = {
  assetId: "home-os",
  hasPulse: true,
  // The data cap alone, which is the portfolio's only cap since the inference
  // ceiling was withdrawn (beads `ro-uj7x`, `ro-rggc`): $25/mo over a 31-day
  // month is 81 cents a day.
  spendTodayUsd: 0.48,
  dailyCapUsd: 0.81,
  ingest: { fresh: 3, stale: 0, notExpected: 1, expected: 3 },
  scheduledLanes: [
    { job: "backup", outcome: "ran", startedAt: iso(3 * HOUR) },
    { job: "beads-snapshot", outcome: "ran", startedAt: iso(HOUR) },
  ],
};

// The missing OS report remains explicit; coverage and spend come from the store.
const systemNoPulse: SystemData = {
  ...systemNormal,
  hasPulse: false,
  ingest: { fresh: 2, stale: 0, notExpected: 2, expected: 2 },
};

const cardLive: AssetData = { netByMonthCurrency: 'USD',
  id: "plate.example.com",
  displayName: "Plate",
  status: "onboarding",
  senseOnly: false,
  worstSeverity: null,
  openError: 0,
  openWarn: 0,
  // Both sides of the split on one card: $210 reconciled, $48 still only
  // reported. The card states the first and labels the second — never $258.
  booked: { currency: 'USD', revenue: 260, cost: 50, net: 210 },
  forecast: { currency: 'USD', revenue: 48, cost: 0, net: 48 },
  netPeriod: "2026-06",
  pulseReceivedAt: iso(4 * HOUR),
  // Nine days of nightly reports — an onboarding card whose setup ring reads
  // 2 of 4 with nineteen baseline days left (bead `ro-28ma`).
  firstReportAt: iso(9 * DAY),
  reportDays: 9,
  dataSources: [
    { id: "nightly-report", label: "Nightly report", state: "live" },
    { id: "ga4", label: "Google Analytics 4 (GA4 Data API)", state: "live" },
    { id: "gsc", label: "Google Search Console", state: "needs-setup" },
    { id: "bing-webmaster", label: "Bing Webmaster Tools", state: "live" },
  ],
  activeUsers: {
    series: activitySeries,
    provisionalFrom: activitySeries.at(-2)?.t ?? null,
    timeZoneChanges: [],
    collectedAt: iso(5 * 60_000),
  },
  // /assets' comparison columns (bead `ro-78qo.35`). The CARD draws neither —
  // it charts active users and nothing else — so they are the designed-empty
  // shape here until that table is built.
  searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  netByMonth: [],
  netByMonthProvisionalFrom: null,
  work: {
    open: 12,
    highPriority: 3,
    inProgress: 2,
    blocked: 1,
    closedRecent: 4,
    priorities: [1, 2, 8, 3, 1],
    capturedAt: iso(20_000),
  },
  // REVIEWED: the review is about the SAME panel day the archive holds as this
  // asset's newest, so it still covers it. Quiet clipboard glyph, muted
  // tone, the age of the review.
  panelReview: {
    beadId: "mp-4a2",
    panelDate: "2026-06-26",
    dueAt: iso(2 * DAY),
    status: "closed",
    closedAt: iso(7 * DAY),
    panel: true,
  },
  latestPanelDate: "2026-06-26",
};

const cardWarn: AssetData = {
  ...cardLive,
  id: "menu.example.org",
  displayName: "Menu",
  worstSeverity: "warn",
  openWarn: 1,
  // Nothing reconciled yet: the booked line holds an em dash so the only number
  // on show cannot be read as booked money.
  booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  forecast: { currency: 'USD', revenue: 62, cost: 0, net: 62 },
  pulseReceivedAt: iso(3 * DAY),
  dataSources: [
    { id: "nightly-report", label: "Nightly report", state: "degraded" },
    { id: "ga4", label: "Google Analytics 4 (GA4 Data API)", state: "needs-setup" },
  ],
  activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  // A calm queue: every count is zero, so the widget says so in one line
  // instead of rendering five noughts.
  work: {
    open: 0,
    highPriority: 0,
    inProgress: 0,
    blocked: 0,
    closedRecent: 0,
    priorities: [0, 0, 0, 0, 0],
    capturedAt: iso(20_000),
  },
  // OVERDUE: a real failure — a panel collected and left unread.
  // The bead is open and three days past its deadline, so the badge takes the
  // error tone and the warning glyph: the one panel state that has to read as a
  // problem from across the room.
  panelReview: {
    beadId: "menu-f1c",
    panelDate: "2026-06-25",
    dueAt: iso(3 * DAY),
    status: "open",
    closedAt: null,
    panel: true,
  },
  latestPanelDate: "2026-06-25",
};

const cardSetup: AssetData = {
  ...cardLive,
  id: "fitness.example.net",
  displayName: "Fitness",
  senseOnly: true,
  // No ledger row of either kind — the accounting block is absent entirely.
  booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  pulseReceivedAt: null,
  firstReportAt: null,
  dataSources: [
    { id: "nightly-report", label: "Nightly report", state: "needs-setup" },
    { id: "gsc", label: "Google Search Console", state: "needs-setup" },
  ],
  activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  // No snapshot covers this asset — the card says that rather than claiming
  // an empty queue. This is also the card that has no nightly report yet, which
  // is exactly why the work widget still renders here.
  work: null,
  // PENDING, and in the OTHER noun: fitness.example.net buys no tracked
  // panel (no config/serp-panel.json entry) yet collects five report families
  // every Monday, so it owes the same weekly read and its marker says signal
  // collection — the word its own bead title carries (bead `ro-z0g`). Quiet
  // hourglass, muted tone, the time still left.
  panelReview: {
    beadId: "fit-90c",
    panelDate: "2026-07-02",
    dueAt: isoAhead(4 * DAY),
    status: "open",
    closedAt: null,
    panel: false,
  },
  latestPanelDate: "2026-07-02",
};

// --- setup checklist (bead `ro-28ma`) --------------------------------------
// Built through the real derivation rather than hand-written, so the panel
// below demonstrates the FUNCTION as well as the rendering: change a rule in
// `shared/asset-setup` and this page moves with it.
const SETUP_PART_DONE = assetSetupChecklist({
  id: "fitness.example.net",
  displayName: "Fitness",
  status: "baselining",
  sources: [
    { id: "nightly-report", kind: "working" },
    { id: "gsc", kind: "working" },
    { id: "ga4", kind: "not-connected" },
    { id: "bing-webmaster", kind: "not-using" },
    { id: "clarity", kind: "not-applicable" },
  ],
  firstReportAt: iso(9 * DAY),
  latestReportAt: iso(5 * HOUR),
  reportDays: 9,
  nowMs: Date.now(),
})!;

const SETUP_READY = assetSetupChecklist({
  id: "plate.example.com",
  displayName: "Plate",
  status: "baselining",
  sources: [
    { id: "nightly-report", kind: "working" },
    { id: "gsc", kind: "working" },
    { id: "ga4", kind: "failing" },
  ],
  firstReportAt: iso(40 * DAY),
  reportDays: 28,
  latestReportAt: iso(4 * HOUR),
  nowMs: Date.now(),
})!;

// An asset with only one daily report: the value is useful, the line is not.
const cardThin: AssetData = {
  ...cardLive,
  id: "area.codes",
  displayName: "Codes",
  // Everything reconciled: no forecast line at all, not a $0 one.
  booked: { currency: 'USD', revenue: 43, cost: 0, net: 43 },
  forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
  netPeriod: "2026-01",
  // NO PANEL: this asset buys no tracked SERP panel, so it owes no review
  // and its header carries no marker at all — the absence is the state, and it
  // is what nearly every card in the portfolio looks like.
  panelReview: null,
  latestPanelDate: null,
};

/**
 * The Wall card whose 7-vs-7 comparison straddles a reporting-timezone change
 * (bead `ro-jkp2`). Twenty-eight visible days with the change on Jul 22 and a
 * provisional Jul 29: the comparison runs Jul 15–28, so the change is inside it
 * and the verdict is withdrawn — while the card's own headline still reads
 * today so far.
 */
const cardDistortedWindow: AssetData = {
  ...cardLive,
  id: "plate.example.com",
  displayName: "Plate",
  activeUsers: {
    series: DAU_VISIBLE,
    contextSeries: DAU_CONTEXT,
    provisionalFrom: DAU_PROVISIONAL_FROM,
    timeZoneChanges: DAU_TIME_ZONE_CHANGE,
    collectedAt: iso(5 * 60_000),
  },
};

/** The same card with no change on file: the identical figure, still coloured. */
const cardCleanWindow: AssetData = {
  ...cardDistortedWindow,
  activeUsers: { ...cardDistortedWindow.activeUsers, timeZoneChanges: [] },
};

/**
 * The sidebar's asset list (bead `ro-pbzu.9`), one card per state it can draw:
 * live and quiet (no glyph at all), an open warning, mid-lifecycle, and retired
 * — which the nav sinks to the foot whatever order it arrives in, so the fixture
 * deliberately hands it in second place.
 */
const sidebarAssets: AssetData[] = [
  { ...cardLive, status: "live" },
  { ...cardThin, status: "retired" },
  cardWarn,
  cardSetup,
];

const realtimeLive: Ga4RealtimeAsset = {
  asset: "plate.example.com",
  status: "success",
  activeUsers5m: 7,
  activeUsers30m: 26,
  hourlyActiveUsers: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    today:
      hour < 12
        ? [2, 1, 1, 2, 3, 5, 8, 10, 9, 12, 15, 14][hour]!
        : null,
    sameDayLastWeek:
      [
        1, 1, 2, 2, 2, 4, 6, 7, 8, 9, 11, 10, 9, 8, 7, 10, 12, 14, 11,
        9, 7, 5, 4, 2,
      ][hour]!,
  })),
  // The minute pulse (bead ro-trai.27): a quiet half hour picking up.
  activeUsersByMinute: [1, 0, 2, 1, 1, 0, 3, 2, 1, 2, 0, 1, 2, 3, 2, 1, 2, 4, 3, 2, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6],
  observedAt: iso(12_000),
  timeZone: DEMO_ZONE_WEST,
  errorCode: null,
};

const realtimeError: Ga4RealtimeAsset = {
  asset: "area.codes",
  status: "error",
  activeUsers5m: null,
  activeUsers30m: null,
  hourlyActiveUsers: null,
  observedAt: iso(12_000),
  errorCode: "ga4_realtime_http_503",
};

const realtimeDemo: Ga4RealtimePayload = {
  generatedAt: iso(12_000),
  assets: [realtimeLive, realtimeError],
};

const deployAnnotation: AnnotationItem = {
  id: 1,
  at: iso(16 * HOUR),
  kind: "deploy",
  ref: "a1b2c3d",
  note: "ship CJ Magnifique product cards",
};

// One per translated shape: a pre-registered kill threshold, a plain drop, a
// zero (rule-specific next step), and a wiring failure — each with the
// rule_inputs its rule really writes.
/** One alert row per state `AlertRow` can be in (bead `ro-ju7f`). Built off one
 * base so the only thing that differs between them is the state being shown. */
const alertRowFlag = (overrides: Partial<FlagRecord> = {}): FlagRecord => ({
  id: 8100,
  firedAt: iso(3 * DAY),
  firstFiredAt: iso(3 * DAY),
  occurrences: 1,
  severity: "warn",
  kind: "anomaly",
  metric: "signups",
  message: "0 signups in last24h (avg7d 6.2)",
  ruleId: "volume-anomaly",
  ruleInputs: { observed: 0, baseline: 6.2, alpha: 0.01 },
  correlatedChanges: [],
  disposition: null,
  dispositionAt: null,
  dispositionNote: null,
  snoozeUntil: null,
  ackExpiry: null,
  resolvedAt: null,
  liveness: { state: "live" },
  ...overrides,
});

const alertRowFlags = {
  open: alertRowFlag({ id: 8100, occurrences: 4, firstFiredAt: iso(9 * DAY) }),
  resolvedFast: alertRowFlag({
    id: 8101,
    message: "Search clicks fell 41% against the same weekday",
    firedAt: iso(2 * DAY),
    firstFiredAt: iso(2 * DAY),
    resolvedAt: iso(2 * DAY - 4 * HOUR),
    liveness: { state: "historical" },
  }),
  resolvedSlow: alertRowFlag({
    id: 8102,
    severity: "error",
    message: "No asset report received",
    ruleId: "ingest-freshness",
    ruleInputs: { rule: "ingest-freshness", state: "stale" },
    firedAt: iso(40 * DAY),
    firstFiredAt: iso(40 * DAY),
    resolvedAt: iso(9 * DAY),
    liveness: { state: "historical" },
  }),
  acknowledged: alertRowFlag({
    id: 8103,
    message: "Ad revenue reported 62% below the 7-day average",
    firedAt: iso(6 * DAY),
    firstFiredAt: iso(6 * DAY),
    disposition: "ack",
    dispositionAt: iso(5 * DAY),
    dispositionNote: "Network holiday reporting lag; re-check Monday.",
    ackExpiry: isoAhead(2 * DAY),
    liveness: { state: "historical" },
  }),
  milestone: alertRowFlag({
    id: 8104,
    severity: "info",
    kind: "milestone",
    metric: null,
    message: "First 1,000 daily visitors",
    ruleId: "milestone-visitors",
    ruleInputs: null,
    firedAt: iso(21 * DAY),
    firstFiredAt: iso(21 * DAY),
    resolvedAt: iso(20 * DAY),
    liveness: { state: "historical" },
  }),
  // AN ERROR THE OS ALREADY SENT (bead `ro-vu8d.23`). Only an error qualifies,
  // so this is the one demo where the notified mark can appear at all — and it
  // is drawn beside the age, in the same muted ink, because being notified is
  // one more dated fact about the row rather than a severity or a decision.
  notified: alertRowFlag({
    id: 8107,
    severity: "error",
    message: "No asset report received",
    ruleId: "ingest-freshness",
    ruleInputs: { rule: "ingest-freshness", state: "stale" },
    firedAt: iso(5 * HOUR),
    firstFiredAt: iso(5 * HOUR),
    notifiedAt: iso(5 * HOUR - 12 * 60_000),
  }),
  // The row that used to lose its tune (bead `ro-bkcl`): tuned, then marked
  // read. `disposition` says `ack` and the note carries the setting that moved
  // behind `shared/tune.ts`'s mark, so the footer says both — the badge for
  // what the operator did with the firing, the chip for what they did to the
  // rule — and the quoted reason is the ack's half alone.
  tunedThenRead: alertRowFlag({
    id: 8106,
    message: "0 signups in last24h (avg7d 6.2)",
    firedAt: iso(8 * DAY),
    firstFiredAt: iso(8 * DAY),
    ruleId: "flow-poisson-low",
    disposition: "ack",
    dispositionAt: iso(6 * DAY),
    dispositionNote:
      "Marked read by operator · rule tuned: Anomaly sensitivity (alpha) 0.01 → 0.05",
    liveness: { state: "historical" },
  }),
  undatedDisposition: alertRowFlag({
    id: 8105,
    message: "Pull endpoint returned 502",
    ruleId: "asset-pull-failed",
    ruleInputs: null,
    firedAt: iso(12 * DAY),
    firstFiredAt: iso(12 * DAY),
    disposition: "tune",
    dispositionAt: null,
    dispositionNote: "Row predates disposition_at.",
    liveness: { state: "historical" },
  }),
} satisfies Record<string, FlagRecord>;

const attentionItems: AttentionItem[] = [
  {
    id: 9000,
    asset: "plate.example.com",
    assetDisplayName: "Plate",
    severity: "warn",
    kind: "anomaly",
    message: "watch window kill_confirmed — gsc/clicks at +7d: 10/day → 7/day (-30%)",
    firedAt: iso(1 * HOUR),
    metric: "clicks",
    ruleId: "watch-window-closed",
    ruleInputs: {
      outcome: "kill_confirmed",
      refKind: "bead",
      ref: "mp-123",
      integration: "gsc",
      metric: "clicks",
      registeredAt: iso(8 * DAY),
      evaluatedAt: iso(1 * HOUR),
      reading: { delta_pct: -30 },
    },
    correlatedChanges: [deployAnnotation],
    occurrences: 1,
    firstFiredAt: iso(1 * HOUR),
  },
  {
    id: 9001,
    asset: "menu.example.org",
    assetDisplayName: "Menu",
    severity: "warn",
    kind: "anomaly",
    message: "19 in last24h (avg7d 58.2, P(<=19)~=0.0000)",
    firedAt: iso(2 * HOUR),
    metric: "receiptVisits",
    ruleId: "flow-poisson-low",
    ruleInputs: {
      metric: "receiptVisits",
      observed: 19,
      baselinePerDay: 58.2,
      alpha: 0.01,
      pLowerTail: 0.0000041,
    },
    correlatedChanges: [],
    // The recurring-condition state (bead ro-kukv.1): one row standing for a
    // month of nightly re-readings of ONE standing condition, carrying the
    // `Recurrence` chip the asset page's Current signals renders too. Every
    // other row here is a single firing and shows no chip at all.
    occurrences: 16,
    firstFiredAt: iso(26 * DAY),
  },
  {
    id: 9002,
    asset: "plate.example.com",
    assetDisplayName: "Plate",
    severity: "warn",
    kind: "opportunity",
    message: "0 in last24h (avg7d 6.5, P(<=0)~=0.0015)",
    firedAt: iso(9 * HOUR),
    metric: "plansSaved",
    ruleId: "flow-poisson-low",
    ruleInputs: {
      metric: "plansSaved",
      observed: 0,
      baselinePerDay: 6.5,
      alpha: 0.01,
      pLowerTail: 0.0015,
    },
    correlatedChanges: [deployAnnotation],
    occurrences: 1,
    firstFiredAt: iso(9 * HOUR),
  },
  {
    id: 9003,
    asset: "plate.example.com",
    assetDisplayName: "Plate",
    severity: "error",
    kind: "anomaly",
    message: "no pulse in 53h (> 48h threshold)",
    firedAt: iso(5 * HOUR),
    metric: "pulse",
    ruleId: "ingest-freshness",
    ruleInputs: {
      rule: "ingest-freshness",
      lastReceivedAt: iso(53 * HOUR),
      thresholdHours: REPORT_MAX_AGE_HOURS,
      ageHours: 53,
    },
    correlatedChanges: [],
    occurrences: 1,
    firstFiredAt: iso(5 * HOUR),
  },
];

/** The chip's three shapes: one named change, several of a kind, nothing. */
const mixedChanges: AnnotationItem[] = [
  deployAnnotation,
  { id: 2, at: iso(30 * HOUR), kind: "config", ref: "config@9f2c", note: "anomaly threshold tuned" },
];
const twoDeploys: AnnotationItem[] = [
  deployAnnotation,
  { id: 3, at: iso(28 * HOUR), kind: "deploy", ref: "e4f5a6b", note: "analytics endpoint" },
];

// --- integrations demo data ------------------------------------------------
const evAgainst: IntegrationEvidence[] = [
  {
    polarity: "against",
    source: "Nightly report overdue",
    detail: "Alert open",
    at: iso(2 * DAY),
  },
];
const evReported: IntegrationEvidence[] = [
  {
    polarity: "supporting",
    source: "Last nightly report accepted",
    detail: "",
    at: iso(4 * HOUR),
  },
];
const evSupporting: IntegrationEvidence[] = [
  {
    polarity: "supporting",
    source: "Affiliate revenue added by hand",
    detail: "$168.20 · latest 2026-06",
    at: null,
  },
];

function icell(
  assetId: string,
  laneId: string,
  declared: IntegrationCell["declared"],
  effective: IntegrationCell["effective"] = declared,
  evidence: IntegrationEvidence[] = [],
): IntegrationCell {
  return { assetId, laneId, declared, effective, evidence, note: `${laneId} honesty note`, ref: null, since: "2026-07-06" };
}

const demoCatalog = [
  { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md#the-catalog", derived: false, scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const, limit: "1,200 queries/min" }, onFailure: "keeps-last-data" as const, credential: "shared" as const },
  { id: "uptime", label: "Uptime / monitoring", docRef: "docs/11-integrations.md#the-catalog", derived: false, scope: "both" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "raises-alert" as const, credential: "shared" as const },
  { id: "clarity", label: "Microsoft Clarity", docRef: "docs/11-integrations.md#the-catalog", derived: false, scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const, limit: "10 calls/day" }, onFailure: "keeps-last-data" as const, credential: "per-property" as const },
  { id: "affiliate-cj", label: "Affiliate — CJ", docRef: "docs/11-integrations.md#the-catalog", derived: false, scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "books-on-payment" as const, credential: "shared" as const },
];

const demoCells: Record<string, IntegrationCell[]> = {
  "home-os": [icell("home-os", "gsc", "not-applicable"), icell("home-os", "uptime", "needs-setup"), icell("home-os", "clarity", "not-applicable"), icell("home-os", "affiliate-cj", "not-applicable")],
  "plate.example.com": [icell("plate.example.com", "gsc", "needs-setup"), icell("plate.example.com", "uptime", "needs-setup"), icell("plate.example.com", "clarity", "needs-setup"), icell("plate.example.com", "affiliate-cj", "needs-setup", "needs-setup", evSupporting)],
  "menu.example.org": [icell("menu.example.org", "gsc", "needs-setup"), icell("menu.example.org", "uptime", "live", "degraded", evAgainst), icell("menu.example.org", "clarity", "needs-setup"), icell("menu.example.org", "affiliate-cj", "not-applicable")],
};

// The derived row: no declared value anywhere, state read from the store.
const demoDerivedLane: DerivedLaneRow = {
  catalog: {
    id: NIGHTLY_REPORT_LANE_ID,
    label: "Nightly report",
    docRef: "docs/02-signal-contract.md",
    scope: "both",
    layer: "property",
    usage: { cost: "free" as const },
    onFailure: "raises-alert" as const,
    credential: "per-property",
    derived: true,
  },
  cells: {
    "home-os": { assetId: "home-os", laneId: NIGHTLY_REPORT_LANE_ID, effective: "live", evidence: evReported },
    "plate.example.com": { assetId: "plate.example.com", laneId: NIGHTLY_REPORT_LANE_ID, effective: "live", evidence: evReported },
    "menu.example.org": { assetId: "menu.example.org", laneId: NIGHTLY_REPORT_LANE_ID, effective: "degraded", evidence: evAgainst },
  },
};

// The L0 row, in the state worth previewing: an outage the OS has attributed to
// its own uplink (bead `ro-034`). One real cell, on asset #0's column — a
// asset's own host is not this machine, so the scope rule blanks the rest.
const demoEgressLane: DerivedLaneRow = {
  catalog: {
    id: EGRESS_LANE_ID,
    label: "The OS's own internet connection",
    docRef: "workers/ingest/src/egress.ts · db/postgres/migrations/0001_baseline.sql",
    scope: "portfolio",
    layer: "os",
    usage: { cost: "free" as const, trigger: "failed-fetch" as const, limit: "1 check per 5 min" },
    onFailure: "pauses-asset-checks" as const,
    credential: "shared",
    derived: true,
  },
  cells: {
    "home-os": {
      assetId: "home-os",
      laneId: EGRESS_LANE_ID,
      effective: "degraded",
      evidence: [
        {
          polarity: "against",
          source: "Reference sites that did not answer",
          detail:
            "https://www.cloudflare.com/cdn-cgi/trace: internal error; reference = 9f2a; https://www.google.com/generate_204: internal error; reference = 3b71",
          at: iso(6 * HOUR),
        },
        {
          polarity: "against",
          source: "Assets left unmeasured",
          detail:
            "plate.example.com, menu.example.org — the lanes checked nothing there, so nothing about them was concluded either way.",
          at: iso(6 * HOUR),
        },
      ],
    },
    "plate.example.com": {
      assetId: "plate.example.com",
      laneId: EGRESS_LANE_ID,
      effective: "not-applicable",
      evidence: [],
    },
    "menu.example.org": {
      assetId: "menu.example.org",
      laneId: EGRESS_LANE_ID,
      effective: "not-applicable",
      evidence: [],
    },
  },
};

const demoMatrix: IntegrationsMatrix = {
  generatedAt: iso(0),
  owner: "config/integrations.json",
  history: emptyIntegrationsHistory(),
  catalog: demoCatalog,
  // Every demo asset declares every demo source, which is the healthy state.
  undeclared: [],
  derivedLanes: [demoEgressLane, demoDerivedLane],
  assets: [
    { id: "home-os", displayName: "NoticeOS", isOs: true },
    { id: "plate.example.com", displayName: "Plate", isOs: false },
    { id: "menu.example.org", displayName: "Menu", isOs: false },
  ],
  cells: demoCells,
  summary: summarize([
    ...Object.values(demoCells).flat(),
    ...Object.values(demoDerivedLane.cells),
    ...Object.values(demoEgressLane.cells),
  ]),
  sharedCredential: sharedCredentialInsight(demoCatalog, demoCells),
  dataSpend: {
    period: "2026-07",
    spentUsd: 8.4, unknownPrices: 0,
    capUsd: 25,
    unattributedUsd: 0, unattributedUnknownPrices: 0,
    // The split the cap above cannot supply (bead ro-4cm): the total is the sum
    // of these, biggest spender first.
    byAsset: [
      { asset: "plate.example.com", spentUsd: 6.2, unknownPrices: 0 },
      { asset: "menu.example.org", spentUsd: 2.2, unknownPrices: 0 },
    ],
  },
};

/**
 * ONE WALL PAYLOAD, assembled from the fixtures above — the same portfolio,
 * system, alert and asset-card data every other section on this page renders.
 * `WallCanvas` takes the payload whole and each widget takes its own slice, so
 * a canvas demo built from anything else would be a second set of facts about
 * the same portfolio.
 */
const wallFixture: WallPayload = {
  generatedAt: new Date(NOW).toISOString(),
  portfolio: portfolioNormal,
  system: systemNormal,
  dashboard: {
    countdown: {
      emoji: "🌁",
      label: "SF Trip",
      targetAt: new Date(NOW + 12 * DAY).toISOString(),
    },
  },
  assets: [cardLive, cardWarn, cardSetup, cardThin],
  attention: attentionItems,
  snoozed: [],
  operator: {
    waiting: 7,
    urgent: 3,
    measuredProjects: 6,
    urgentMeasuredProjects: 6,
    projectCount: 6,
    capturedAt: iso(0),
  },
  ledgerRecordedAt: iso(2 * DAY),
};

/**
 * A ready month projection for the revenue widget's demos (bead `ro-trai.4`):
 * evenly earned through `reportedDay`, the rest of June at the same pace.
 * Invented figures on `portfolioNormal`'s month.
 */
function demoMonthProjection(projectedMinor: number, earnedMinor: number, previousMonthMinor: number | null, reportedDay = 20): RevenueProjection {
  const days = 30;
  const perDay = earnedMinor / reportedDay;
  const ahead = (projectedMinor - earnedMinor) / (days - reportedDay);
  return {
    period: "2026-06", status: "ready", reason: null, reportedThrough: `2026-06-${reportedDay}`,
    earnedMinor, projectedMinor, dailyPaceMinor: Math.round(ahead), previousPeriod: "2026-05", previousMonthMinor,
    changePercent: null, historyDays: 56, holidayHistoryDays: 0,
    points: Array.from({ length: days }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      cumulativeMinor: Math.round(index < reportedDay ? perDay * (index + 1) : earnedMinor + ahead * (index + 1 - reportedDay)),
      projected: index >= reportedDay,
    })),
  };
}

/** A site's saved estimate for yesterday on the gallery's clock (bead
 * `ro-trai.32`); `null` is a report not in yet. */
const demoYesterday = (amountMinor: number | null): DailyRevenueSummary => ({
  ...yesterdayRevenue(new Date(NOW), "UTC", []),
  amountMinor,
});
/** June so far: $560 of the ledger's forecast, two sites paced to $850, both
 * sites' reports for yesterday in. */
const revenueOnPace = [
  { revenueProjection: demoMonthProjection(60_000, 40_000, 50_000), dailyRevenue: demoYesterday(2_118) },
  { revenueProjection: demoMonthProjection(25_000, 16_000, 18_000), dailyRevenue: demoYesterday(804) },
];
/** The same month against a smaller May: passed on a reported day; one of the
 * two sites' reports for yesterday is not in yet. */
const revenuePassed = [
  { revenueProjection: demoMonthProjection(60_000, 40_000, 30_000), dailyRevenue: demoYesterday(2_118) },
  { revenueProjection: demoMonthProjection(25_000, 16_000, 10_000), dailyRevenue: demoYesterday(null) },
];
const revenueLearning: { revenueProjection: RevenueProjection; dailyRevenue: DailyRevenueSummary }[] = [
  {
    revenueProjection: {
      ...demoMonthProjection(0, 0, null), status: "insufficient-history", reason: "Learning from traffic and revenue · 12/21 days.",
      earnedMinor: null, projectedMinor: null, dailyPaceMinor: null, points: [],
    },
    dailyRevenue: demoYesterday(1_530),
  },
];

/** The reads the demo cards' source marks come from, as the TV would see
 * them for these assets (bead `ro-ujb9.96.7.16`). */
const DEMO_CONNECTIONS = demoConnections(
  [cardLive, cardWarn, cardSetup, cardThin, cardDistortedWindow, cardCleanWindow],
  NOW,
);

/** The layout a Wall nobody has rearranged draws — D28 (docs/25-the-wall.md):
 * the strip, revenue beside Needs you over the site rows, the feed beside. */
const wallDefaultLayout = DEFAULT_WALL_LAYOUT;

/** And one the operator arranged: the site rows first and taller beside the
 * feed, money under them, no strip, and both per-site widgets narrowed to two
 * sites. */
const wallArrangedLayout: WallLayout = {
  version: WALL_LAYOUT_VERSION,
  rows: [
    {
      id: "body",
      height: "fill",
      widgets: [
        {
          id: "sites",
          type: "sites",
          width: 2,
          settings: { assets: ["menu.example.org", "plate.example.com"] },
        },
        { id: "feed", type: "feed", width: 1 },
      ],
    },
    {
      id: "money",
      height: "auto",
      widgets: [
        { id: "revenue", type: "revenue", width: 1.55 },
        {
          id: "needs",
          type: "needs",
          width: 1,
          settings: { assets: ["menu.example.org", "plate.example.com"] },
        },
      ],
    },
  ],
};

export function KitchenSinkRoute() {
  const toast = useOwnerToast();
  const [light, setLight] = useState(false);

  return (
    <div className={cn(light && "light")}>
      <div className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8">
          <header className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Kitchen sink</h1>
              <p className="text-sm text-muted-foreground">
                Every component in every state — the visual reference and review
                surface (doc 14). Dev-only route.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setLight((v) => !v)}>
              {light ? "Dark" : "Light"} preview
            </Button>
          </header>

          <Section title="BrandLockup">
            <div className="flex flex-wrap items-center gap-8">
              <BrandLockup />
              <BrandLockup size="compact" />
              <span className="text-2xl">
                <BrandLockup size="text" />
              </span>
              <a href="/design-system.html" className="text-sm text-primary underline underline-offset-4">NoticeOS design system and assets</a>
            </div>
          </Section>

          <Section title="IntegrationHealthPanel">
            <IntegrationHealthPanel nowMs={Date.parse('2026-09-12T12:00:00Z')} data={{ generatedAt: '2026-09-12T12:00:00Z', available: true, events: [], items: (['failing', 'healthy', 'stale', 'unknown', 'never-run', 'unmonitored', 'idle', 'paused', 'disconnected'] as const).map((state, index) => ({ id: state, provider: 'google', capability: 'ga4-daily', label: ['Live active users', 'Daily traffic', 'Search report', 'Hourly traffic', 'New asset', 'Coverage gap', 'Connection test', 'Paused export', 'Disconnected tool'][index]!, state, asset: `${state}.example`, detail: null, report: null, reportDate: null, lastAttemptAt: state === 'never-run' ? null : '2026-09-12T11:59:00Z', lastSuccessAt: state === 'healthy' ? '2026-09-12T11:59:00Z' : null, nextAttemptAt: null, failure: state === 'failing' ? 'rate-limit' : null, code: state === 'failing' ? 'rate-limit-daily' : null, action: 'Review the connection in Integrations.', coverage: 'monitored' })) }} />
            <IntegrationHealthPanel nowMs={Date.parse('2026-09-12T12:00:00Z')} isError provider="google" data={{ generatedAt: '2026-09-12T11:00:00Z', available: true, events: [], items: [{ id: 'kept', provider: 'google', capability: 'ga4-daily', label: 'Analytics daily reports', state: 'healthy', asset: 'example.test', detail: null, report: null, reportDate: null, lastAttemptAt: '2026-09-12T10:59:00Z', lastSuccessAt: '2026-09-12T10:59:00Z', nextAttemptAt: null, failure: null, code: null, action: 'Review the Analytics connection.', coverage: 'monitored' }] }} />
            {/* The strip with a week of its daily record (bead ro-ujb9.96.7.26). */}
            <IntegrationHealthPanel nowMs={Date.parse('2026-09-12T12:00:00Z')} providers={[{ provider: integrationProvider('google')!, assets: [], meter: null, credential: { provider: 'google', source: 'store', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'], assetsHeld: [], missingFields: [], auth: null, metadata: null, keyVersion: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastUsedAt: '2026-09-12T11:59:00Z', lastOkAt: '2026-09-12T11:59:00Z', lastError: null } as CredentialSummary }]} data={{ generatedAt: '2026-09-12T12:00:00Z', available: true, events: [], countsHistory: demoCountsHistory(Date.parse('2026-09-12T12:00:00Z')), items: (['healthy', 'healthy', 'failing'] as const).map((state, index) => ({ id: `history-${index}`, provider: 'google', capability: 'ga4-daily', label: 'Daily traffic', state, asset: `site-${index + 1}.example`, detail: null, report: null, reportDate: null, lastAttemptAt: '2026-09-12T11:59:00Z', lastSuccessAt: state === 'healthy' ? '2026-09-12T11:59:00Z' : null, nextAttemptAt: null, failure: state === 'failing' ? 'access' : null, code: state === 'failing' ? 'access' : null, action: 'Review the connection in Integrations.', coverage: 'monitored' })) }} />
          </Section>
          <Section title="IntegrationLogo">
            <div className="flex flex-wrap items-start gap-6">
              {([
                ["google", "Google"],
                ["bing-webmaster", "Bing Webmaster Tools"],
                ["dataforseo", "DataForSEO"],
                ["clarity", "Microsoft Clarity"],
                ["mediavine", "Mediavine"],
                ["discord", "Discord"],
                ["calendar", "Calendar feeds"],
                ["beads", "Beads"],
                ["unknown", "Other integration"],
              ] as const).map(([provider, label]) => (
                <div key={provider} className="flex flex-col items-center gap-2">
                  <IntegrationLogo provider={provider} />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-4" aria-label="Google logo sizes">
              <IntegrationLogo provider="google" size="small" />
              <IntegrationLogo provider="google" />
              <IntegrationLogo provider="google" size="large" />
            </div>
          </Section>
          <Section title="WhatLands (notification channel)">
            {/* What Discord's channel carries: before it is connected, once it
                is, and connected while the OS is sending nothing (bead
                ro-ujb9.96.7.14 draws it in the connect panel too). */}
            <div className="grid gap-4 md:grid-cols-3">
              <WhatLands connected={false} />
              <WhatLands connected />
            </div>
          </Section>
          <Section title="TaskSourceRows / TaskHubUnavailable (D32)">
            {/* Core hub readings and the unavailable-project state. */}
            <div className="flex flex-col gap-4">
              {([
                { connected: false, projects: 0, readAt: null, failing: 0 },
                { connected: false, projects: 1, readAt: null, failing: 0 },
                { connected: true, projects: 2, readAt: "2026-09-12T11:59:30Z", failing: 0 },
                { connected: true, projects: 2, readAt: "2026-09-12T11:50:00Z", failing: 0 },
                { connected: true, projects: 1, readAt: "2026-09-12T11:59:30Z", failing: 1 },
              ] as const).map((row, index) => (
                <TaskSourceRows
                  key={index}
                  anchor={`task-sources-demo-${index}`}
                  nowMs={Date.parse("2026-09-12T12:00:00Z")}
                  payload={{ connected: row.connected ? "beads" : null, sources: [{ id: "beads", ...row }] }}
                />
              ))}
              <TaskHubUnavailable />
              <TaskProjectSteps spoke={{ asset: "example.com", prefix: "ex", database: "ex" }} hub={KITCHEN_TASK_HUB} />
            </div>
          </Section>

          <RegistryContents />

          <SurfaceSections />

          {/* The shell and the page header frame every desk route, so they come
              first here too. The full AppShell is a LAYOUT ROUTE — it owns the
              Outlet and the theme class on <html> — so what is demonstrated is
              its visible half, the Sidebar, at its real width. */}
          <Section title="PageHeader (plain / breadcrumb + actions + meta / rich title)">
            <div className="flex w-full flex-col gap-6">
              <PageHeader title="Home" description="Portfolio overview" />
              <div className="border-t border-border pt-4">
                <PageHeader
                  title="Tasks"
                  description="What every repo has queued and in flight, read from the task hub."
                  breadcrumb={[{ label: "Home", to: "/" }]}
                  meta={
                    <AgeBadge
                      iso={new Date(Date.now() - 9 * 60_000).toISOString()}
                      cadenceHours={1}
                      nowMs={Date.now()}
                    />
                  }
                  actions={
                    <Button variant="outline" size="sm">
                      Export
                    </Button>
                  }
                />
              </div>
              <div className="border-t border-border pt-4">
                {/* The asset page's identity row IS its heading: one
                    representation per fact, so the name is not repeated above a
                    separate strip. */}
                <PageHeader
                  breadcrumb={[{ label: "Assets", to: "/assets" }]}
                  title={
                    <>
                      <PropertyFavicon
                        domain="plate.example.com"
                        displayName="Plate"
                        className="size-7"
                      />
                      Plate
                      <SeverityDot severity="warn" />
                      <span className="font-mono text-sm font-normal text-muted-foreground">
                        plate.example.com
                      </span>
                      <Badge variant="outline">Live</Badge>
                      <Badge variant="secondary">Monitor only</Badge>
                    </>
                  }
                  actions={
                    <AgeBadge
                      iso={new Date(Date.now() - 3 * 3_600_000).toISOString()}
                      cadenceHours={CADENCE_HOURS.pulse}
                      nowMs={Date.now()}
                    />
                  }
                />
              </div>
            </div>
          </Section>

          <Section title="Sidebar (the desk shell's navigation, at its real width)">
            <div className="flex h-[32rem] overflow-hidden rounded-lg border border-border">
              <Sidebar
                theme={light ? "light" : "dark"}
                onToggleTheme={() => setLight((v) => !v)}
                assets={sidebarAssets}
                credentials={SIDEBAR_CREDENTIALS}
                className="h-full"
              />
            </div>
            <p className="max-w-sm text-xs text-muted-foreground">
              The active item carries <code className="font-mono">aria-current</code>
              , so on this route nothing is lit — this page is reached by URL and
              is deliberately not in the nav. The theme button here drives this
              page's own light preview; in the app it flips{" "}
              <code className="font-mono">.light</code> on the document and
              persists the choice. Below <code className="font-mono">md</code> the
              same content is a drawer behind a menu button — and that bar wears
              the Integrations dot too (bead{" "}
              <code className="font-mono">ro-vu8d.19</code>), because a ceiling
              the operator cannot see on their phone is not a ceiling.
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Integrations carries a warn dot: this fixture's DataForSEO password
              is nine days from expiry. That dot and the provider card behind it
              are the WHOLE ceiling for an expiring portfolio-shared credential —
              the Wall and Home&rsquo;s Alerts list deliberately carry nothing,
              because the action list owns the fact (D15) and nobody can reconnect
              from a television. It turns <code className="font-mono">error</code>
              {" "}once a date has actually passed; no fourth severity.
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Under Assets, the portfolio: a live asset carries nothing but its
              favicon and name, one has an open warning, one is mid-lifecycle
              (four muted segments filled to its stage), and the retired one has
              sunk to the foot behind the switched-off slash. New asset closes
              the list. Passing <code className="font-mono">assets</code> is
              gallery-only — it keeps this page off the store and off the
              remembered collapse state, so the demo always shows the list open.
            </p>
          </Section>

          <Section title="CommandPalette (⌘K, rendered in place)">
            <div className="flex w-full flex-wrap items-start gap-4">
              <div className="w-full max-w-sm">
                <p className="pb-2 text-xs text-muted-foreground">
                  Empty query: every page, then every asset.
                </p>
                <CommandPalette
                  inline
                  open
                  onOpenChange={() => {}}
                  assets={[cardLive, cardWarn, cardSetup]}
                />
              </div>
              <div className="w-full max-w-sm">
                <p className="pb-2 text-xs text-muted-foreground">
                  A bead id: the one row that is not a place.
                </p>
                <CommandPalette
                  inline
                  open
                  onOpenChange={() => {}}
                  assets={[cardLive, cardWarn, cardSetup]}
                  defaultQuery="ro-d298"
                />
              </div>
            </div>
            <p className="max-w-sm text-xs text-muted-foreground">
              <code className="font-mono">inline</code> is a gallery-only prop:
              no portal, no backdrop, and no ⌘K binding, so this page does not
              fight the shell&rsquo;s own palette for the shortcut. Selecting a
              row here really navigates — it is the live component, and the
              gallery has no fake router to send it to.
            </p>
          </Section>

          <Section title="SeverityDot">
            <Labeled name="error"><SeverityDot severity="error" /></Labeled>
            <Labeled name="warn"><SeverityDot severity="warn" /></Labeled>
            <Labeled name="info"><SeverityDot severity="info" /></Labeled>
            <Labeled name="none"><SeverityDot severity={null} /></Labeled>
            <Labeled name="milestone"><SeverityDot severity="info" milestone /></Labeled>
            <Labeled name="lg"><SeverityDot severity="error" size="lg" /></Labeled>
          </Section>

          <Section title="PropertyFavicon">
            <Labeled name="ico">
              <PropertyFavicon domain="plate.example.com" displayName="Plate" />
            </Labeled>
            <Labeled name="svg + detail size">
              <PropertyFavicon
                domain="finance.example.org"
                displayName="Finance"
                className="size-7"
              />
            </Labeled>
            <Labeled name="fallback">
              <PropertyFavicon
                domain="missing.invalid"
                displayName="Missing"
              />
            </Labeled>
          </Section>

          <Section title="DemoViewerStatus">
            <Labeled name="ordinary installation (hidden)"><DemoViewerStatus viewer={null} /></Labeled>
            <Labeled name="unknown generation time">
              <DemoViewerStatus viewer={validateDemoViewer({ version: 1, synthetic: true, release: "1".repeat(40), scenarioHash: "2".repeat(64), workspaceId: "11111111-1111-4111-8111-111111111111", cutoff: "2026-09-15T12:00:00.000Z", generatedAt: null })} />
            </Labeled>
            <Labeled name="completed generation aging">
              <DemoViewerStatus nowMs={Date.parse("2026-09-16T12:00:00.000Z")} viewer={validateDemoViewer({ version: 1, synthetic: true, release: "1".repeat(40), scenarioHash: "2".repeat(64), workspaceId: "11111111-1111-4111-8111-111111111111", cutoff: "2026-09-15T12:00:00.000Z", generatedAt: "2026-09-16T11:55:00.000Z" })} />
            </Labeled>
          </Section>

          <Section title="AgeBadge (amber past 2× cadence; absence says which absence)">
            <Labeled name="fresh">
              <AgeBadge iso={iso(3 * HOUR)} cadenceHours={CADENCE_HOURS.pulse} nowMs={NOW} />
            </Labeled>
            <Labeled name="amber (stale)">
              <AgeBadge iso={iso(3 * DAY)} cadenceHours={CADENCE_HOURS.pulse} nowMs={NOW} />
            </Labeled>
            <Labeled name="last-good">
              <AgeBadge
                iso={iso(90 * 60_000)}
                cadenceHours={CADENCE_HOURS.pulse}
                nowMs={NOW}
                lastGood
              />
            </Labeled>
            {/* The two absent cases are DIFFERENT facts and read differently
                (bead `ro-kukv.10`): nothing ever arrived on this lane, versus a
                timestamp we were handed and cannot parse. Neither is a dash. */}
            <Labeled name="never reported">
              <AgeBadge iso={null} cadenceHours={CADENCE_HOURS.pulse} nowMs={NOW} />
            </Labeled>
            <Labeled name="unreadable timestamp">
              <AgeBadge
                iso="not-a-timestamp"
                cadenceHours={CADENCE_HOURS.pulse}
                nowMs={NOW}
              />
            </Labeled>
            <Labeled name="P&L fresh">
              <AgeBadge iso={iso(2 * DAY)} cadenceHours={CADENCE_HOURS.ledger} nowMs={NOW} />
            </Labeled>
            {/* The third absence (bead `ro-ujb9.96.8`): none is owed. */}
            <Labeled name="no report owed (NoNightlyReport)">
              <NoNightlyReport />
            </Labeled>
          </Section>

          <Section title="ReportFreshness (fresh · stale · no report owed · declared none · in a Reported column)">
            <Labeled name="fresh">
              <ReportFreshness iso={iso(5 * HOUR)} nowMs={NOW} />
            </Labeled>
            <Labeled name="stale (amber)">
              <ReportFreshness iso={iso(3 * DAY)} nowMs={NOW} />
            </Labeled>
            <Labeled name="no report owed">
              <ReportFreshness iso={null} nowMs={NOW} />
            </Labeled>
            <Labeled name="declared none">
              <ReportFreshness iso={iso(9 * DAY)} nowMs={NOW} declared />
            </Labeled>
            <Labeled name="in a Reported column">
              <ReportFreshness iso={iso(5 * HOUR)} nowMs={NOW} label={false} />
            </Labeled>
          </Section>

          <Section title="DeltaChip (neutral by default; positive is opt-in)">
            <DeltaChip value={30} tone="positive-strong" />
            <DeltaChip value={12} tone="positive" />
            <DeltaChip value={5} tone="positive-subtle" />
            <DeltaChip value={-30} tone="negative-strong" />
            <DeltaChip value={-12} tone="negative" />
            <DeltaChip value={-5} tone="negative-subtle" />
            <DeltaChip value={0} />
          </Section>

          <Section title="DeltaChip — today's pace (paceTone: on pace · a little behind · far behind)">
            {[6.9, -25, -58].map((percent) => (
              <DeltaChip key={percent} value={percent} tone={paceTone(percent)} render={(value) => `${value}%`} />
            ))}
          </Section>

          <Section title="Meter (amber over cap)">
            <div className="w-48"><Meter value={2.4} max={4.03} /></div>
            <div className="w-48"><Meter value={3.9} max={4.03} /></div>
            <div className="w-48"><Meter value={5.2} max={4.03} /></div>
          </Section>

          <Section title="ProgressRing (n of m discrete steps — the setup ring)">
            <ProgressRing done={0} total={4} title="Setup 0 of 4 — still to do: Identity, Data sources, First nightly report, Baseline · 28 days" />
            <ProgressRing done={2} total={4} title="Setup 2 of 4 — still to do: Data sources, Baseline · 28 days" />
            <ProgressRing done={4} total={4} title="Setup 4 of 4 — ready to go live" />
            <ProgressRing done={2} total={4} title="Setup 2 of 4 — still to do: Data sources, Baseline · 28 days" size="md" />
            <ProgressRing done={5} total={9} title="5 of 9 done" size="md" />
            <ProgressRing done={1} total={1} title="1 of 1 done" size="md" />
          </Section>

          <Section title="Setup checklist panel (the asset page's Overview, bead ro-28ma)">
            <div className="w-full max-w-2xl">
              <SetupChecklistPanel setup={SETUP_PART_DONE} open />
            </div>
            <div className="w-full max-w-2xl">
              <SetupChecklistPanel setup={SETUP_READY} open />
            </div>
          </Section>

          <Section title="SegmentBar (how a total divides — the shape behind two counts)">
            <div className="w-full max-w-xs">
              <span className="mb-2 block text-xs text-muted-foreground">
                urgent inside the operator inbox (warn + the muted rest)
              </span>
              <SegmentBar
                ariaLabel="3 of 12 waiting on you are urgent"
                segments={[
                  { name: "urgent", value: 3, fill: "bg-warn" },
                  { name: "rest", value: 9, fill: "bg-muted-foreground/30" },
                ]}
              />
            </div>
            <div className="w-full max-w-xs">
              <span className="mb-2 block text-xs text-muted-foreground">
                red inside the open-alert count (error + warn)
              </span>
              <SegmentBar
                ariaLabel="4 of 7 open alerts are errors, 3 are warnings"
                segments={[
                  { name: "error", value: 4, fill: "bg-error" },
                  { name: "warn", value: 3, fill: "bg-warn" },
                ]}
              />
            </div>
            <div className="w-full max-w-xs">
              <span className="mb-2 block text-xs text-muted-foreground">
                one band in 121 — never below its minimum painted width, so a
                lone P0 cannot vanish into a rounding error
              </span>
              <SegmentBar
                ariaLabel="1 of 121 is top priority"
                segments={[
                  { name: "top", value: 1, fill: "bg-error" },
                  { name: "rest", value: 120, fill: "bg-muted-foreground/30" },
                ]}
              />
            </div>
            <div className="w-full max-w-xs">
              <span className="mb-2 block text-xs text-muted-foreground">
                nothing to divide — an empty track, never an invented split
              </span>
              <SegmentBar
                ariaLabel="Nothing open"
                segments={[
                  { name: "error", value: 0, fill: "bg-error" },
                  { name: "warn", value: 0, fill: "bg-warn" },
                ]}
              />
            </div>
          </Section>

          <Section title="TimeZoneCaveat (a comparison whose window straddles a reporting-timezone change)">
            <span className="inline-flex items-center gap-1">
              <DeltaChip value={12.4} render={(value) => `${value.toFixed(1)}%`} className="text-xs" />
              <TimeZoneCaveat trend={{ timeZoneChanges: DAU_TIME_ZONE_CHANGE }} window={DISTORTED_WEEKLY_WINDOW} />
            </span>
          </Section>

          <Section title="PriorityBar (mixed priorities · one hot band in many · all default priority)">
            <div className="flex w-full max-w-md flex-col gap-3">
              <PriorityBar bands={[3, 11, 98, 47, 17]} total={176} />
              <PriorityBar bands={[1, 0, 90, 20, 10]} total={121} />
              <PriorityBar bands={[0, 0, 12, 0, 0]} total={12} />
            </div>
          </Section>

          <Section title="EmptyState · NoSitesYet (an empty site list's door, bead ro-ujb9.96.6.18)">
            <EmptyState
              title="P&L starts with the first reconciled month — 6 days in."
              hint="Revenue and cost book on reconciliation; estimates don't count yet."
            />
            <EmptyState size="sm" title="None yet" hint="Conversion counts unchecked" />
            <div className="w-full max-w-xl rounded-[10px] border border-border bg-card px-4 py-3">
              <NoSitesYet />
            </div>
          </Section>

          <Section title="ReadFailed (a page's first read failed)">
            <div className="grid w-full gap-4 md:grid-cols-2">
              <div className="overflow-hidden rounded-md border border-border">
                <ReadFailed title="Couldn't load alerts" subject="read:alerts" error={new ApiError("GET /api/wall failed", 503)} retrying={false} onRetry={() => {}} />
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                <ReadFailed title="Couldn't load this site" subject="read:site" detail={<span className="font-mono">example.com</span>} error={new TypeError("Failed to fetch")} retrying={false} onRetry={() => {}} />
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                <ReadFailed title="Couldn't load Home" subject="read:home" error={new ApiError("GET /api/wall failed", 500)} retrying onRetry={() => {}} />
              </div>
              <div className="h-48 overflow-hidden rounded-md border border-border">
                <ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={new ApiError("GET /api/wall failed", 503)} retrying={false} onRetry={() => {}} />
              </div>
            </div>
          </Section>

          <Section title="RouteLoading / RouteLoadFailure (a screen's or a tab's code arriving, and gone after a rebuild)">
            {/* Clip the four frames for comparison; the gallery's action
                stays inert instead of opening another browser tab. */}
            <div className="grid w-full gap-4 md:grid-cols-2">
              <div className="h-48 overflow-hidden rounded-md border border-border">
                <RouteLoading />
              </div>
              <div className="h-48 overflow-hidden rounded-md border border-border">
                <RouteLoading surface="wall" />
              </div>
              <div className="h-48 overflow-hidden rounded-md border border-border">
                <RouteLoadFailure openUpdated={GALLERY_NO_OPEN} />
              </div>
              <div className="h-48 overflow-hidden rounded-md border border-border">
                <RouteLoadFailure
                  surface="wall"
                  openUpdated={GALLERY_NO_OPEN}
                />
              </div>
              {/* An asset TAB's code (bead `ro-ujb9.84`): the same two frames
                  in the tab panel, under a header and tab bar that did load.
                  The palette's frames are not drawn here: its loading frame is
                  nothing at all, and its failure is a box over the whole page,
                  which on this page would cover the gallery. */}
              <div className="h-48 overflow-hidden rounded-md border border-border p-4">
                <RouteLoading surface="panel" />
              </div>
              <div className="h-48 overflow-hidden rounded-md border border-border p-4">
                <RouteLoadFailure
                  surface="panel"
                  openUpdated={GALLERY_NO_OPEN}
                />
              </div>
            </div>
          </Section>

          <Section title="Home · first run (an empty store: no tiles, no table)">
            {/* The whole page, not a fragment of it: what is being reviewed here
                is that a fresh install says what to connect first instead of
                showing four zeros (bead `ro-vtf7`). */}
            <div className="w-full">
              <FirstRun />
            </div>
          </Section>

          <Section title="DataSourceIcons (recorded states plus unverified)">
            <DataSourceIcons sources={DATA_SOURCE_STATES} />
          </Section>

          <Section title="ExecutiveInsightRow (one focused decision / compact queue faces)">
            <div className="w-full max-w-2xl">
              <ExecutiveInsightRow
                insight={insightDemo}
                rank={1}
                marked
                initiallyExpanded
                disclosureGroup="gallery-finding-queue"
              />
            </div>
            <div className="w-full max-w-2xl">
              <ExecutiveInsightRow
                rank={2}
                disclosureGroup="gallery-finding-queue"
                insight={{
                  ...insightDemo,
                  key: "demo-warning",
                  kind: "warning",
                  title: "JavaScript errors concentrate on /calculator",
                  primary: { value: "570", label: "JavaScript errors" },
                }}
              />
            </div>
            <div className="w-full max-w-2xl">
              <ExecutiveInsightRow
                rank={3}
                disclosureGroup="gallery-finding-queue"
                insight={{
                  ...insightDemo,
                  key: "demo-discovery",
                  kind: "discovery",
                  title: "AI assistants are already sending identifiable visits",
                  primary: { value: "40", label: "AI-referred sessions" },
                }}
              />
            </div>
            <div className="w-full max-w-2xl">
              <ExecutiveInsightRow
                rank={4}
                disclosureGroup="gallery-finding-queue"
                insight={{
                  ...insightDemo,
                  key: "demo-insight",
                  kind: "insight",
                  title: "The calculator is completing meaningful user jobs",
                  primary: { value: "1,162", label: "Calculation Complete" },
                }}
              />
            </div>
          </Section>

          <Section title="AlertVerification — source confirmation is not first detection">
            <div className="flex flex-wrap items-center gap-4">
              {(["confirmed", "unverified", "source-ended", "recorded-closed", "not-applicable"] as const).map((state) =>
                <AlertVerification key={state} firstDetectedAt="2026-07-01T04:00:00.000Z" nowMs={NOW}
                  verification={{ state, lastConfirmedAt: new Date(NOW - 21 * 3_600_000).toISOString(),
                    lastEvaluatedAt: new Date(NOW - 21 * 3_600_000).toISOString(), source: "Site checks",
                    reason: state === "confirmed" ? "source-confirms" : "confirmation-stale" }} />)}
              <AlertVerification firstDetectedAt="2026-07-01T04:00:00.000Z" nowMs={NOW} />
              <span className="text-base"><AlertVerification firstDetectedAt="2026-07-01T04:00:00.000Z" nowMs={NOW} interactive={false} /></span>
            </div>
          </Section>

          <Section title="AnalysisEvidence (saved analysis / unknown date)">
            <div className="w-full">
              <AnalysisEvidence snapshot={findingsSnapshotDemo} />
            </div>
            <div className="w-full">
              <AnalysisEvidence snapshot={{ ...findingsSnapshotDemo, generatedAt: "" }} />
            </div>
          </Section>

          <Section title="ExecutiveFindingsList (populated / empty snapshot)">
            <p className="w-full text-xs text-muted-foreground">
              Demo-only controls update this mounted gallery state. A real
              asset writes the same reversible decisions to the OS.
            </p>
            {/* Two of the four findings carry a bead and two do not, which is
                the state to look at: the marker has to be findable on the rows
                that have one and completely absent on the rows that do not. */}
            <div className="w-full">
              <ExecutiveFindingsList
                snapshot={findingsSnapshotDemo}
                handoffBeads={findingsHandoffBeadsDemo}
              />
            </div>
            <div className="w-full border-t border-border pt-3">
              <span className="mb-2 block text-xs text-muted-foreground">
                empty snapshot
              </span>
              <ExecutiveFindingsList snapshot={emptyFindingsSnapshotDemo} />
            </div>
          </Section>

          <Section title="QueryVisibilityRankings (every decision lane / filed and unfiled / no comparable windows)">
            <div className="w-full">
              <span className="mb-2 block text-xs text-muted-foreground">
                the register was asked: one query filed and open, one filed and
                shipped, the rest picked up by nobody
              </span>
              <QueryVisibilityRankings
                trends={queryTrendsDemo}
                asset={demoProperty}
                handoffBeads={queryHandoffBeadsDemo}
              />
            </div>
            <div className="w-full border-t border-border pt-3">
              <span className="mb-2 block text-xs text-muted-foreground">
                the register could not be asked (no snapshot / not a spoke /
                poller one generation behind) — identical to nothing filed
              </span>
              <QueryVisibilityRankings
                trends={queryTrendsDemo}
                asset={demoProperty}
                handoffBeads={null}
              />
            </div>
            <div className="w-full border-t border-border pt-3">
              <span className="mb-2 block text-xs text-muted-foreground">
                no provider windows and no DataForSEO snapshot yet
              </span>
              <QueryVisibilityRankings trends={null} asset={demoProperty} />
            </div>
          </Section>

          <Section title="PageDecisions (every page lane / filed and unfiled / AI Overview gate / no two complete weeks)">
            <div className="w-full">
              <span className="mb-2 block text-xs text-muted-foreground">
                the same four lanes as the query table, on the grain an operator
                edits — one task open, one shipped, and the rest picked up by
                nobody
              </span>
              <PageDecisions
                pages={pageTrendsDemo}
                asset={demoProperty}
                handoffBeads={pageHandoffBeadsDemo}
                annotations={{
                  items: [{ id: 1, at: "2026-07-26T17:00:00.000Z", kind: "deploy", ref: null, note: "Recipe template refresh" }],
                  olderCount: 0,
                }}
              />
            </div>
            <div className="w-full border-t border-border pt-3">
              <span className="mb-2 block text-xs text-muted-foreground">
                fewer than two complete Search Console weeks stored
              </span>
              <PageDecisions pages={null} asset={demoProperty} />
            </div>
          </Section>

          <Section title="Drill (real route / static)">
            <Labeled name="interactive + route">
              <Drill interactive to="/assets/plate.example.com">
                <span className="tabular-nums">3 open alerts</span>
              </Drill>
            </Labeled>
            <Labeled name="static (the Wall)">
              <Drill interactive={false} to="/tasks">
                <span className="tabular-nums">14 queued</span>
              </Drill>
            </Labeled>
          </Section>

          <Section title="FlagActions (the sanctioned alert-lifecycle actions)">
            <p className="w-full text-xs text-muted-foreground">
              Live: every button PATCHes the alert and disables while in flight.
              The demo ids do not exist, so the failure toast is the expected
              result here. Snooze opens the horizons in place — three presets
              and a date — and Escape closes them again.
            </p>
            <Labeled name="open alert">
              <FlagActions flagId={9001} assetId="menu.example.org" />
            </Labeled>
            <Labeled name="rule-driven open alert (Tune too)">
              <FlagActions
                flagId={9003}
                assetId="menu.example.org"
                ruleId="flow-poisson-low"
                metric="signups"
              />
            </Labeled>
            <Labeled name="already snoozed (Unsnooze alone)">
              <FlagActions flagId={9002} assetId="menu.example.org" snoozed />
            </Labeled>
          </Section>

          <Section title="SnoozeUntil (when a parked alert comes back)">
            <p className="w-full text-xs text-muted-foreground">
              A state carries its own visual: the date and the time left, not
              the word &ldquo;snoozed&rdquo;. An expired snooze is an OPEN alert
              whose row still records that it was quiet — the glyph and the
              wording flip so the row explains its own reappearance.
            </p>
            <Labeled name="active (counting down)">
              <SnoozeUntil until={new Date(NOW + 3 * 86_400_000).toISOString()} nowMs={NOW} />
            </Labeled>
            <Labeled name="expired (back on the list)">
              <SnoozeUntil until={new Date(NOW - 2 * 86_400_000).toISOString()} nowMs={NOW} />
            </Labeled>
          </Section>

          <Section title="BacktestStrip (what a rule setting would have done)">
            <p className="w-full text-xs text-muted-foreground">
              Two tracks over the same thirty days: above the line what these
              settings WOULD do, below it the days the rule really fired. The
              count says how many, the strip says where — three firings in one
              week and three spread across the month are the same number and
              opposite decisions.
            </p>
            <div className="flex w-full flex-col gap-6">
              <Labeled name="judged (fired, quiet, unjudged, no report)">
                <div className="w-[360px]">
                  <BacktestStrip backtest={BACKTEST_MIXED} />
                </div>
              </Labeled>
              <Labeled name="quieter than reality (0 would fire, 4 really did)">
                <div className="w-[360px]">
                  <BacktestStrip backtest={BACKTEST_SILENT} />
                </div>
              </Labeled>
              <Labeled name="too little history (nothing could be judged)">
                <div className="w-[360px]">
                  <BacktestStrip backtest={BACKTEST_UNJUDGED} />
                </div>
              </Labeled>
              <Labeled name="no reports at all">
                <div className="w-[360px]">
                  <BacktestStrip backtest={BACKTEST_EMPTY} />
                </div>
              </Labeled>
            </div>
          </Section>

          <Section title="TuneRate (how often the operator answered a rule by tuning it)">
            <p className="w-full text-xs text-muted-foreground">
              docs/15 flow E's false-positive rate, per rule: the amber share is
              the settled alerts the operator answered by making the rule
              quieter, the rest is every other way they finished with one. The
              bar is the shape and the figures live beside it; a rule with
              nothing settled says so rather than drawing a measured zero. The
              first card also carries the PROPOSAL (bead{" "}
              <code className="font-mono">ro-bgny</code>): 4 of 9 settled is over
              the 40% line on more than the 5 settled alerts the OS waits for, so
              it says so and offers two answers. Live form, fake writer — File
              task is given an <code className="font-mono">onFile</code> that
              fabricates an id, and the decline here is deliberately NOT
              remembered, because these are real rule ids and a reviewer&rsquo;s
              click would otherwise silence the operator&rsquo;s own proposal.
            </p>
            <div className="flex w-full flex-wrap items-start gap-6">
              {TUNE_RATES.map(([name, stat]) => (
                <Labeled key={name} name={name}>
                  <div className="w-[220px]">
                    <TuneRate
                      stat={stat}
                      windowDays={90}
                      onFileTask={demoFileTask}
                      rememberDecline={false}
                    />
                  </div>
                </Labeled>
              ))}
            </div>
          </Section>

          <Section title="RuleTunePanel (tune a rule after seeing what it would do)">
            <p className="w-full text-xs text-muted-foreground">
              The panel behind Tune rule on an alert row. Every field is the
              shipped KnobEditor and each Save here is handed a fake writer, so
              the controls, the refusals and the toast are the real ones and only
              the commit is a promise — the same escape hatch KnobEditor's own
              demos take. The trigger and its portal are exercised in
              test/rule-tune.test.tsx.
            </p>
            <div className="flex w-full flex-wrap items-start gap-6">
              {TUNE_PREVIEWS.map(([name, preview]) => (
                <Labeled key={name} name={name}>
                  <div className="w-[360px] rounded-lg border border-border p-3">
                    <RuleTunePanel
                      asset="menu.example.org"
                      ruleId="flow-poisson-low"
                      metric="signups"
                      knobs={TUNE_KNOBS}
                      preview={preview}
                      stats={TUNE_RATE_PAYLOAD}
                      onDraftChange={() => {}}
                      onSave={async () => {}}
                    />
                  </div>
                </Labeled>
              ))}
            </div>
          </Section>

          <Section title="Table (shadcn primitives)">
            <div className="w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">Last 24h</TableHead>
                    <TableHead className="text-right">Avg / day (7d)</TableHead>
                    <TableHead className="w-28">30-day trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">signups</TableCell>
                    <TableCell className="text-right tabular-nums">24</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      15.7
                    </TableCell>
                    <TableCell>
                      <div className="w-24">
                        <Sparkline data={dailySeries([12, 14, 9, 16, 21, 18, 24], "2026-07-20")} size="cell" average={false} ariaLabel="signups trend" />
                      </div>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">leads</TableCell>
                    <TableCell className="text-right tabular-nums">—</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      —
                    </TableCell>
                    <TableCell>
                      <div className="w-24">
                        <Sparkline data={[]} size="cell" ariaLabel="leads trend" />
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            {/* The stacked variant (bead `ro-md80`). Its whole behaviour is a
                breakpoint, so at gallery width this renders as the table above
                — which is the point: `stacked` costs the desk nothing. Narrow
                the window past 640px to see the rows become labelled cards,
                the header go, and the chrome-only cell drop — and each row
                that `opens` draw its › on the card instead (bead ro-ujb9.13). */}
            <div className="w-full">
              <Table stacked>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="w-6" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow opens>
                    <TableCell className="font-medium">Plate</TableCell>
                    <TableCell label="Status" className="text-xs text-muted-foreground">
                      Onboarding · Automation on
                    </TableCell>
                    <TableCell label="Net" className="text-right tabular-nums">
                      +$436
                    </TableCell>
                    <TableCell dropWhenStacked className="text-right">
                      <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />
                    </TableCell>
                  </TableRow>
                  <TableRow opens>
                    <TableCell className="font-medium">Finance</TableCell>
                    <TableCell label="Status" className="text-xs text-muted-foreground">
                      Live · Observe only
                    </TableCell>
                    <TableCell label="Net" className="text-right tabular-nums">
                      −$6
                    </TableCell>
                    <TableCell dropWhenStacked className="text-right">
                      <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </Section>

          <Section title="Badge / Button">
            <Badge>default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
            <Button>Default</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button size="sm">Small</Button>
          </Section>

          {/* The panel container every card-shaped surface on the desk is built
              out of. It had no demo here for a year because it is always seen
              THROUGH something else — but the parts are a registry entry, and an
              entry nobody can look at is a description rather than a reference.
              The footer is the part with the fewest callers, so it is drawn once
              here rather than hunted for. */}
          <Section title="Card (+ Header / Title / Content / Footer)">
            <Card className="w-72">
              <CardHeader>
                <CardTitle>Card</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Header, title and content — the shape almost every panel on the
                  desk starts from.
                </p>
              </CardContent>
            </Card>
            <Card className="w-72">
              <CardHeader>
                <CardTitle>With a footer</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold tabular-nums">1,284</span>
              </CardContent>
              <CardFooter>
                <span className="text-xs text-muted-foreground">
                  Footers carry the quiet line under a figure.
                </span>
              </CardFooter>
            </Card>
            <Card className="w-72">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">
                  Content alone — no header, no border inside. A card with one
                  thing to say does not grow a title bar to say it.
                </p>
              </CardContent>
            </Card>
          </Section>

          {/* Every panel-review state side by side, which is the only way to
              check the thing that matters: that the three are told apart by
              glyph and tone alone, with no status word anywhere, and that the
              fourth renders literally nothing. The pending one is also the
              second NOUN — fitness.example.net buys no panel, so its hover
              says signal collection (bead ro-z0g). */}
          <Section title="PanelReviewBadge (reviewed / pending, no panel / overdue / nothing to review)">
            <PanelReviewBadge
              review={cardLive.panelReview}
              latestPanelDate={cardLive.latestPanelDate}
              nowMs={NOW}
            />
            <PanelReviewBadge
              review={cardSetup.panelReview}
              latestPanelDate={cardSetup.latestPanelDate}
              nowMs={NOW}
            />
            <PanelReviewBadge
              review={cardWarn.panelReview}
              latestPanelDate={cardWarn.latestPanelDate}
              nowMs={NOW}
            />
            {/* A NEWER panel day than the one the finished review was about:
                the obligation is outstanding again even though no bead has been
                filed for it yet, so it falls back to pending rather than
                claiming the newest panel was read. */}
            <PanelReviewBadge
              review={cardLive.panelReview}
              latestPanelDate="2026-07-03"
              nowMs={NOW}
            />
            <PanelReviewBadge review={null} latestPanelDate={null} nowMs={NOW} />
          </Section>

          {/* The same four states one surface down, where the page has room the
              card does not: which panel day is owed, the deadline while it is
              still the operator's, and the bead to close. Only the overdue row
              leaves the quiet surface, and the absent one is still literally
              nothing (bead ro-elf). */}
          <Section title="PanelReviewLine (the page's statement: reviewed / pending, no panel / overdue / nothing to review)">
            <div className="w-[28rem]">
              <PanelReviewLine
                review={cardLive.panelReview}
                latestPanelDate={cardLive.latestPanelDate}
                nowMs={NOW}
              />
            </div>
            <div className="w-[28rem]">
              <PanelReviewLine
                review={cardSetup.panelReview}
                latestPanelDate={cardSetup.latestPanelDate}
                nowMs={NOW}
              />
            </div>
            <div className="w-[28rem]">
              <PanelReviewLine
                review={cardWarn.panelReview}
                latestPanelDate={cardWarn.latestPanelDate}
                nowMs={NOW}
              />
            </div>
            <div className="w-[28rem]">
              <PanelReviewLine
                review={cardLive.panelReview}
                latestPanelDate="2026-07-03"
                nowMs={NOW}
              />
            </div>
            <div className="flex w-[28rem] flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                Nothing to review — no collection landed inside the window, so
                the page says nothing at all and the slot below is empty by
                design.
              </span>
              <PanelReviewLine review={null} latestPanelDate={null} nowMs={NOW} />
            </div>
          </Section>

          {/* The three things worth looking at here are the three lies the
              obvious rendering would tell: an unranked term reads `>20` rather
              than as a blank, the AI tiles quote the CHECKED count rather than
              the tracked one, and the unstated-depth variant names no depth at
              all. The fourth panel is an asset that buys none. */}
          <Section title="SerpPanelBoard (scoreboard first / unstated depth / never checked / no panel)">
            <div className="w-[46rem] max-w-full">
              <SerpPanelBoard panel={panelDemo} />
            </div>
            <div className="w-[46rem] max-w-full">
              <SerpPanelBoard
                panel={{ ...panelDemo, trackedDepth: null }}
              />
            </div>
            <div className="w-[46rem] max-w-full">
              <SerpPanelBoard
                panel={{
                  ...panelDemo,
                  queries: panelDemo.queries.map((q) => ({
                    ...q,
                    aioDevices: [],
                  })),
                }}
              />
            </div>
            <div className="flex w-[46rem] max-w-full flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                No panel in config/serp-panel.json — nothing at all, never six
                zeroes.
              </span>
              <SerpPanelBoard panel={null} />
            </div>
          </Section>

          {/* The glyph both surfaces above draw, on its own, because the whole
              point of extracting it (bead `ro-glf`) is that a token change or a
              fourth state has ONE place to land. The row that matters is the
              last pair: the same unknown reading, held as a blank slot for a
              caller with a column to align to and drawn as nothing at all for a
              caller without one. */}
          <Section title="AiOverviewGlyphs (three weights / pair / unknown blank vs omitted)">
            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
              <GlyphRow label="Cites us — solid">
                <AiOverviewGlyphs
                  readings={[
                    { device: "desktop", aioPresent: true, aioCitesUs: true },
                  ]}
                  unknownSurface="blank"
                />
              </GlyphRow>
              <GlyphRow label="Shown, not cited — outline">
                <AiOverviewGlyphs
                  readings={[
                    { device: "desktop", aioPresent: true, aioCitesUs: false },
                  ]}
                  unknownSurface="blank"
                />
              </GlyphRow>
              <GlyphRow label="Read and clear — ghosted">
                <AiOverviewGlyphs
                  readings={[
                    { device: "desktop", aioPresent: false, aioCitesUs: false },
                  ]}
                  unknownSurface="blank"
                />
              </GlyphRow>
              <GlyphRow label="Walled on the phone, clear on the desktop">
                <AiOverviewGlyphs
                  readings={[
                    { device: "mobile", aioPresent: true, aioCitesUs: false },
                    { device: "desktop", aioPresent: false, aioCitesUs: false },
                  ]}
                  unknownSurface="blank"
                />
              </GlyphRow>
              <GlyphRow label="Phone never answered · blank slot (panel board)">
                <AiOverviewGlyphs
                  readings={[
                    { device: "mobile", aioPresent: null, aioCitesUs: null },
                    { device: "desktop", aioPresent: true, aioCitesUs: true },
                  ]}
                  unknownSurface="blank"
                />
              </GlyphRow>
              <GlyphRow label="Phone never answered · omitted (query table)">
                <AiOverviewGlyphs
                  readings={[
                    { device: "mobile", aioPresent: null, aioCitesUs: null },
                    { device: "desktop", aioPresent: true, aioCitesUs: true },
                  ]}
                  unknownSurface="omit"
                />
              </GlyphRow>
              <GlyphRow label="Panel does not cover the query — nothing at all">
                <AiOverviewGlyphs readings={[]} unknownSurface="omit" />
              </GlyphRow>
            </div>
          </Section>

          {/* Side by side is the only way to check what matters here: that the
              two filed states are told apart by glyph and weight alone, that
              neither shouts loudly enough to rival a finding's severity, that
              the closed one reads as shipped rather than as resolved, and that
              the unfiled case renders literally nothing. */}
          <Section title="HandoffBeadBadge (open / closed / closed undated / not filed)">
            <HandoffBeadBadge
              bead={{
                kind: "finding",
                key: "item-openers",
                beadId: "mp-1w2",
                status: "open",
                closedAt: null,
              }}
            />
            <HandoffBeadBadge
              bead={{
                kind: "finding",
                key: "gsc-decline-1",
                beadId: "mp-4kq",
                status: "closed",
                closedAt: "2026-08-01T09:30:00.000Z",
              }}
            />
            {/* A closed bead whose close time did not survive the poller: the
                marker keeps the state it can prove and drops only the date. */}
            <HandoffBeadBadge
              bead={{
                kind: "finding",
                key: "brand-drift",
                beadId: "menu-7bd",
                status: "closed",
                closedAt: null,
              }}
            />
            <HandoffBeadBadge bead={null} />
          </Section>

          {/* D28's one top line (bead ro-trai.3): the same OS report in four
              states, the meeting and countdown from the gallery's own fixed
              clock. */}
          <Section title="WallStrip (healthy / a source failing / OS report missing / clear day, no countdown)">
            <div className="wall-root flex w-full flex-col gap-2 bg-background p-2">
              <WallStrip
                system={systemNormal}
                assets={[cardLive, cardWarn]}
                countdown={{ emoji: "🌁", label: "SF Trip", targetAt: new Date(MEETINGS_NOW + 12 * DAY).toISOString() }}
                meetings={upcoming([meeting("work", "Partner sync", [0, 15, 0], 30)])}
                nowMs={MEETINGS_NOW}
              />
              <WallStrip
                system={systemNormal}
                assets={[{ ...cardLive, dataSources: [{ id: "uptime", label: "Uptime", state: "degraded", observedAt: iso(HOUR), detail: "Home page down" }] }, cardWarn]}
                countdown={{ emoji: "🌁", label: "SF Trip", targetAt: new Date(MEETINGS_NOW + 12 * DAY).toISOString() }}
                meetings={upcoming([meeting("work", "Partner sync", [0, 15, 0], 30)])}
                nowMs={MEETINGS_NOW}
              />
              <WallStrip
                system={systemNoPulse}
                assets={[cardLive, cardWarn]}
                countdown={{ emoji: "🌁", label: "SF Trip", targetAt: new Date(MEETINGS_NOW + 12 * DAY).toISOString() }}
                meetings={upcoming([meeting("work", "Partner sync", [0, 9, 0], 30)])}
                nowMs={MEETINGS_NOW}
              />
              <WallStrip
                system={systemNormal}
                assets={[cardLive, cardWarn]}
                meetings={upcoming([meeting("work", "Partner sync", [2, 10, 0], 30)])}
                nowMs={MEETINGS_NOW}
              />
            </div>
          </Section>

          {/* The System band above renders the summary, so its healthy face was
              visible here — the four postures that are NOT healthy were not, and
              the full matrix had no demo at all. Both are drawn straight from
              the same records the System card reads, because the summary is a
              roll-up of exactly this list and two fixtures would let them
              disagree. */}
          <Section title="ScheduledLanesSummary / ScheduledLanesPanel (healthy / skipped / failed / silent / not yet recorded)">
            <div className="flex w-full flex-col gap-2">
              <ScheduledLanesSummary lanes={SCHEDULED_HEALTHY} nowMs={NOW} />
              <ScheduledLanesSummary lanes={SCHEDULED_SKIPPED} nowMs={NOW} />
              <ScheduledLanesSummary lanes={SCHEDULED_FAILED} nowMs={NOW} />
              <ScheduledLanesSummary lanes={SCHEDULED_SILENT} nowMs={NOW} />
              <ScheduledLanesSummary lanes={[]} nowMs={NOW} />
            </div>
            <div className="w-full">
              <ScheduledLanesPanel lanes={SCHEDULED_MATRIX} nowMs={NOW} />
            </div>
            <div className="w-full">
              <ScheduledLanesPanel lanes={[]} nowMs={NOW} />
            </div>
            <p className="max-w-prose text-xs text-muted-foreground">
              Nothing recorded is <em>unknown</em> and never <em>healthy</em>:
              the empty summary and the empty panel both say so in words rather
              than showing a clear tick over a record no job has written yet.
            </p>
          </Section>

          <Section title="WorkflowStateLabel / WorkflowActivity / WorkflowStages / WorkflowScheduleTimeline / WorkflowStepOutputView">
            <div className="flex w-full flex-wrap gap-4">{(['succeeded', 'failed', 'running', 'skipped', 'paused', 'never', 'unknown', 'waiting'] satisfies WorkflowState[]).map((state) => <WorkflowStateLabel key={state} state={state} />)}</div>
            <div className="w-80"><WorkflowActivity name="Example workflow" history={Array.from({ length: 24 }, (_, i) => ({ at: new Date(NOW - (23 - i) * 3_600_000).toISOString(), succeeded: i % 3 ? 2 : 0, failed: i === 15 ? 1 : 0, skipped: i === 5 ? 1 : 0, runId: null }))} /></div>
            <div className="w-full"><WorkflowStages definition={WORKFLOW_DEFINITIONS.find((w) => w.id === 'pull')!} run={{ id: 'example', workflowId: 'pull', definitionVersion: 1, startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 3000).toISOString(), state: 'failed', steps: [
              { id: 'config', attempt: 1, startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 10).toISOString(), state: 'succeeded', summary: 'Collection settings loaded.' },
              { id: 'pull', attempt: 1, startedAt: new Date(NOW + 10).toISOString(), finishedAt: new Date(NOW + 2900).toISOString(), state: 'failed', summary: 'One asset could not be collected.' },
              { id: 'bing', attempt: 1, startedAt: new Date(NOW + 10).toISOString(), finishedAt: new Date(NOW + 2500).toISOString(), state: 'succeeded', summary: 'Search signals collected.' },
              { id: 'record', attempt: 1, startedAt: new Date(NOW + 2900).toISOString(), finishedAt: new Date(NOW + 3000).toISOString(), state: 'succeeded', summary: 'Execution recorded.' },
            ] }} /></div>
            <div className="w-full"><WorkflowStages definition={WORKFLOW_DEFINITIONS.find((w) => w.id === 'backup')!} run={null} /></div>
            <div className="w-full"><WorkflowStepOutputView output={{ version: 1, metrics: [{ key: 'attempted', label: 'Attempted', value: 2 }, { key: 'succeeded', label: 'Succeeded', value: 1 }, { key: 'failed', label: 'Failed', value: 1 }], fields: [], totalItems: 2, truncated: false, items: [{ label: 'plate.example.com', state: 'succeeded', fields: [{ key: 'written', label: 'Rows written', value: 12 }] }, { label: 'menu.example.org', state: 'failed', fields: [{ key: 'status', label: 'HTTP status', value: 503 }] }] }} /></div>
            <WorkflowStepOutputView /><WorkflowStepOutputView pending />
            <div className="w-full"><WorkflowScheduleTimeline cron="*/15 * * * *" now={NOW} enabled name="Example schedule" /></div>
          </Section>

          <Section title="Stepper (lifecycle — every assets.status stage)">
            {(["pre-launch", "onboarding", "baselining", "live", "retired"] as AssetStatus[]).map(
              (status) => {
                const spec = lifecycleStepper(status);
                return (
                  <div key={status} className="flex w-full flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{status}</span>
                    <Stepper steps={spec.steps} activeIndex={spec.activeIndex} terminal={spec.terminal} />
                  </div>
                );
              },
            )}
          </Section>

          {/* Add a site (bead ro-ujb9.96.7.5), which retired the five-step
              Wizard layout: the one screen in each of its states, drawn in
              place, plus the button that opens the real sheet. */}
          <Section title="AddSitePanel / AddSiteButton — add a site in one screen (bead ro-ujb9.96.7.5)">
            <div className="flex w-full flex-wrap items-start gap-4">
              <AddSiteButton />
              {ADD_SITE_DEMOS.map((demo) => (
                <AddSitePanel
                  key={demo.key}
                  presentation="inline"
                  domain={demo.domain}
                  onDomainChange={() => {}}
                  preview={demo.preview ?? null}
                  prelaunch={demo.prelaunch ?? false}
                  onPrelaunchChange={() => {}}
                  issue={demo.issue ?? null}
                  blocked={demo.blocked ?? null}
                  adding={demo.adding ?? false}
                  failed={null}
                  onSubmit={() => toast.success("Demo only — Add would write the asset")}
                  onClose={() => {}}
                  incomplete={demo.incomplete ?? null}
                />
              ))}
            </div>
          </Section>

          {/* The tab bar the asset page is built on. The tabs are links, so the
              demo needs a router — the gallery already runs inside one — and the
              "active" tab here is whichever `to` matches the gallery's own URL.
              What is worth reviewing is the STATE slots: a count, a count with a
              severity dot, and the segmented working/degraded/not-set-up ratio,
              beside plain tabs that carry nothing.

              The last bar is the query-carrying variant (bead `ro-clz8`): every
              `to` here hands a filter across the switch, and Overview still
              lights, because selection is decided by the PATH. */}
          <Section title="Tabs (plain · count · glyph + count · segmented ratio · link with a query)">
            <div className="flex w-full flex-col gap-6">
              <Tabs
                label="Kitchen-sink tabs (plain)"
                idBase="ks-plain-tab"
                panelId="ks-plain-panel"
                tabs={[
                  { key: "overview", to: "/dev/kitchen-sink", label: "Overview", end: true },
                  { key: "growth", to: "/dev/kitchen-sink/growth", label: "Growth" },
                  { key: "sources", to: "/dev/kitchen-sink/sources", label: "Sources" },
                ]}
              />
              <Tabs
                label="Kitchen-sink tabs (state)"
                idBase="ks-state-tab"
                panelId="ks-state-panel"
                tabs={[
                  { key: "overview", to: "/dev/kitchen-sink", label: "Overview", end: true },
                  {
                    key: "alerts",
                    to: "/dev/kitchen-sink/alerts",
                    label: "Alerts",
                    count: 3,
                    glyph: <SeverityDot severity="error" size="sm" />,
                    title: "3 open alerts, worst is critical",
                  },
                  {
                    key: "activity",
                    to: "/dev/kitchen-sink/activity",
                    label: "Activity",
                    count: 2,
                    title: "2 outcome checks still running",
                  },
                  {
                    key: "sources",
                    to: "/dev/kitchen-sink/sources",
                    label: "Sources",
                    glyph: (
                      <span
                        role="img"
                        aria-label="5 working · 1 degraded · 2 not set up"
                        className="inline-flex h-1.5 w-9 overflow-hidden rounded-full bg-muted"
                      >
                        <span className="w-[62%] bg-connected" />
                        <span className="w-[13%] bg-warn" />
                        <span className="w-[25%] bg-info" />
                      </span>
                    ),
                    title: "5 working · 1 degraded · 2 not set up",
                  },
                  {
                    key: "thin",
                    to: "/dev/kitchen-sink/thin",
                    label: "Sources (bar too thin)",
                    glyph: (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        19 of 20 live
                      </span>
                    ),
                    title: "A segment under 3px says nothing — the count takes over",
                  },
                ]}
              />
              <Tabs
                label="Kitchen-sink tabs (link with a query)"
                idBase="ks-query-tab"
                panelId="ks-query-panel"
                tabs={[
                  {
                    key: "overview",
                    to: "/dev/kitchen-sink?asset=menu.example.org",
                    label: "Overview",
                    end: true,
                    title: "Keeps the asset filter on the way across",
                  },
                  {
                    key: "growth",
                    to: "/dev/kitchen-sink/growth?asset=menu.example.org",
                    label: "Growth",
                    title: "Keeps the asset filter on the way across",
                  },
                ]}
              />
            </div>
          </Section>

          <Section title="OwnerChip (copyable path → owning file/table)">
            <OwnerChip path="config/pull.json" />
            <OwnerChip path="config/constants.json" />
            <OwnerChip path="workers/ingest/.dev.vars" />
            <OwnerChip path="db · assets row" />
            <OwnerChip
              path="docs/11-integrations.md#the-catalog"
              hint="Google Search Console setup is written up at docs/11-integrations.md#the-catalog — click to copy the reference."
            />
          </Section>

          <Section title="KnobRow (value-only / explain / owner / scope)">
            <div className="w-full">
              <KnobRow label="Data collection" value="The asset sends it" />
              <KnobRow
                label="Anomaly sensitivity"
                value="0.01"
                explain="How unlikely a drop must be before an alert fires. Lower = fewer, more certain alerts."
                scope="portfolio default"
              />
              <KnobRow label="Auth source" value="Site token" />
            </div>
          </Section>

          <Section title="StateChip (boolean/enum state — glyph + color by meaning)">
            <StateChip subject="demo:enabled" tone="affirmative" label="Enabled" />
            <StateChip subject="demo:automation-enabled" tone="affirmative" label="Automation enabled" />
            <StateChip subject="demo:paused" tone="declined" label="Paused" />
            <StateChip subject="demo:monitor-only" tone="declined" label="Monitor only" />
            <StateChip subject="demo:degraded" tone="caution" label="Degraded" />
            <StateChip subject="demo:failed" tone="critical" label="Failed" />
            <StateChip subject="demo:retired" tone="na" label="Retired" />
            <StateChip subject="demo:we-fetch-it" tone="neutral" label="We fetch it" />
          </Section>

          <Section title="UnknownPriceCount">
            <span className="tabular-nums">$4.49<UnknownPriceCount count={2} subject="spend:demo-unknown" /></span>
            <span className="tabular-nums">$4.49<UnknownPriceCount count={0} subject="spend:demo-priced" /></span>
          </Section>

          {/* The `glyph` face (bead ro-l1ed.3): the task lifecycle already owns
              five shapes on the cards, the Wall and the board, so on a chip it
              keeps them. An anonymous dot here would have said the tone twice
              and the state not at all. */}
          <Section title="StateChip glyph face (the task lifecycle, on /tasks/:id and the board)">
            <TaskStatusChip subject="demo:task-open" status="open" />
            <TaskStatusChip subject="demo:task-in-progress" status="in_progress" />
            <TaskStatusChip subject="demo:task-blocked" status="blocked" />
            <TaskStatusChip subject="demo:task-deferred" status="deferred" />
            <TaskStatusChip subject="demo:task-closed" status="closed" />
            <TaskStatusChip subject="demo:task-marinating" status="marinating" />
          </Section>

          {/* The pair, side by side, which is the only way to check what it is
              for: booked and forecast money are told apart by FILL and TONE, so
              the split survives a glance across a room and a grayscale screen.
              Three surfaces wear it — the portfolio headline, every asset
              card, and the asset page's P&L and recent-entries table — and
              the last of those reached it by having its own lowercase-word
              badge deleted (bead ro-jk7). */}
          <Section title="BookingChip (reconciled / forecast — the ledger's honesty split)">
            <BookingChip subject="demo:booking-booked" state="booked" />
            <BookingChip subject="demo:booking-forecast" state="forecast" />
            {/* A raw ledger row states the store's own vocabulary; one mapper
                turns it into the chip's, so a table of rows and a rollup over
                those same rows can never disagree on how they look. */}
            <BookingChip subject="demo:booking-reconciled" state={bookingChipState("reconciled")} />
            <BookingChip subject="demo:booking-estimated" state={bookingChipState("estimated")} />
          </Section>

          <Section title="IntegrationStateChip (one connection status, never ahead of its proof)">
            <IntegrationStateChip subject="demo:connection-not-connected" state="not-connected" />
            <IntegrationStateChip subject="demo:connection-not-checked" state="not-checked" />
            <IntegrationStateChip subject="demo:connection-key-accepted" state="key-accepted" />
            <IntegrationStateChip subject="demo:connection-key-accepted-sign-in" state="key-accepted" accepted="sign-in" />
            <IntegrationStateChip subject="demo:connection-key-accepted-url" state="key-accepted" accepted="url" />
            <IntegrationStateChip subject="demo:connection-collecting" state="collecting" />
            <IntegrationStateChip subject="demo:connection-working" state="working" />
            <IntegrationStateChip subject="demo:connection-overdue" state="overdue" />
            <IntegrationStateChip subject="demo:connection-failing" state="failing" />
            <IntegrationStateChip subject="demo:connection-not-using" state="not-using" />
            <IntegrationStateChip subject="demo:connection-unknown" state="unknown" />
            <IntegrationStateChip subject="demo:connection-not-applicable" state="not-applicable" />
            <IntegrationStateChip subject="demo:connection-working-count" state="working" count={4} />
          </Section>

          <Section title="IntegrationSummaryStrip (the register's totals, in the connection vocabulary)">
            <div className="w-full">
              <IntegrationSummaryStrip counts={{ failing: 1, working: 12, "not-checked": 3, "not-connected": 9, "not-using": 2 }} sharedCredential={demoMatrix.sharedCredential} />
            </div>
            <div className="w-full border-t border-border pt-3">
              <IntegrationSummaryStrip counts={{ working: 1, "not-using": 1 }} />
            </div>
          </Section>

          <Section title="InfoTooltip — supporting details on hover, focus or tap">
            <div className="flex flex-wrap items-center gap-6">
              <span className="inline-flex items-center gap-1 text-sm">Average daily users
                <InfoTooltip label="How average daily users is counted">Reported daily user counts are averaged over the selected period. A person active on several days may appear in several daily counts.</InfoTooltip>
              </span>
              <InfoTooltip label="How the trend is drawn" trigger="7-day average">Each plotted point averages the reported daily values in its seven-day window. Missing dates are not converted to zero.</InfoTooltip>
            </div>
          </Section>

          <Section title="EvidencePopover (why this state — against / supporting)">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">against (a declared-live lane failing):</span>
              <EvidencePopover evidence={evAgainst} nowMs={NOW} contextLabel="Uptime · menu.example.org" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">supporting (needs-setup, delivering manually):</span>
              <EvidencePopover evidence={evSupporting} nowMs={NOW} contextLabel="Affiliate — CJ · plate.example.com" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">labelled trigger (an opened alert row):</span>
              <EvidencePopover
                evidence={[
                  { polarity: "supporting", source: "Arrived", detail: "22 in 24h", at: null },
                  { polarity: "supporting", source: "Normal · 7-day average", detail: "39.3/day", at: null },
                  { polarity: "supporting", source: "Chance if nothing changed", detail: "0.2% · fires below 1%", at: null },
                  { polarity: "supporting", source: "First seen", detail: "", at: new Date(NOW - 2 * 86_400_000).toISOString() },
                ]}
                nowMs={NOW}
                question="Why this fired"
                contextLabel="flow-poisson-low"
                triggerLabel="Evidence"
              />
            </div>
          </Section>

          <Section title="Popover (focus in, back on close, stays on scroll)">
            <Popover>
              <PopoverTrigger className={cn(pillClass, pillControlClass, "border-border")}>Open a popover</PopoverTrigger>
              <PopoverContent aria-label="Example popover" className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Focus is inside this panel</span>
                <span className="text-muted-foreground">Escape or a press outside returns it to the trigger.</span>
              </PopoverContent>
            </Popover>
          </Section>

          <Section title="IntegrationMatrix (lanes × assets; N/A quiet, evidence popovers)">
            <div className="w-full">
              <IntegrationMatrix matrix={demoMatrix} nowMs={NOW} />
            </div>
          </Section>

          <Section title="ProviderCard / ProviderCredentialForm / ProviderLink — connection states">
            <p className="w-full text-xs text-muted-foreground">
              One shared connection status, with credential source shown separately.
              Legacy credentials keep their import controls. The demos use
              fake handlers: Connect, Test and Disconnect all work here and
              touch nothing. The last two cards are the ones whose Test button
              is not the free read-only call a Test button is assumed to be:
              Discord&rsquo;s posts into the operator&rsquo;s own channel, and
              Clarity&rsquo;s calls nobody at all. Each carries the sentence
              that says so under the buttons, before the press rather than after
              it. Clarity is also the only <em>per-asset</em> credential, so its
              served-assets line is a checklist — a token per project, collected
              one at a time. The two metered providers carry a budget line from
              the same component in its two windows: DataForSEO&rsquo;s dollars
              against the portfolio month (first partly spent, then spent out —
              the state that stops next Monday&rsquo;s sweep) and
              Clarity&rsquo;s calls against each asset&rsquo;s day. Neither is
              read by calling the provider. Beside the DataForSEO bar sits the
              other number — the prepaid credit on the account, with how long
              ago DataForSEO last reported it, on the spent-out card the
              sentence for an account nobody has read yet, and on the third the
              warn-toned sentence for a sighting two weekly refreshes old —
              too old to plan Monday on. It is deliberately not a bar: a balance
              has no ceiling to draw against, and a figure without its age would
              read as today&rsquo;s.
            </p>
            {/* Keyed by INDEX as well as provider id: the two metered providers
                each appear twice, in the two ends of their meter, and a bare id
                would be a duplicate React key. */}
            {PROVIDER_CARD_DEMOS.map((demo, index) => (
              <div className="w-full" key={`${demo.status.provider.id}-${index}`}>
                <ProviderCard
                  guided={index === 0}
                  status={demo.status}
                  assets={demo.assets}
                  nowMs={NOW}
                  onConnect={demoConnect}
                  onTest={demo.probe}
                  onDisconnect={demoDisconnect}
                  onSetExpiry={
                    demo.status.provider.expiry.known === "never"
                      ? undefined
                      : demoSetExpiry
                  }
                />
              </div>
            ))}
            <p className="w-full text-xs text-muted-foreground">
              And the countdown (bead <code>ro-vu8d.8</code>, doc 15 flow C
              step 4). Three steps and no fourth severity: quiet while the date
              is far off, warn-toned inside the fourteen days doc 15 named, red
              once it has passed — and a card whose provider states no lifetime
              says so in the provider's own sentence rather than showing an
              invented date. The chip sits BESIDE the state chip because they
              are two facts: does this work now, and until when.
            </p>
            {PROVIDER_CARD_EXPIRY_DEMOS.map((demo, index) => (
              <div className="w-full" key={`expiry-${index}`}>
                <ProviderCard
                  status={demo}
                  assets={[]}
                  nowMs={NOW}
                  onConnect={demoConnect}
                  onTest={PROVIDER_CARD_CONNECTED.probe}
                  onDisconnect={demoDisconnect}
                  onSetExpiry={
                    demo.provider.expiry.known === "never" ? undefined : demoSetExpiry
                  }
                />
              </div>
            ))}
            <p className="w-full text-xs text-muted-foreground">
              The same legacy credential in both import modes
              (bead <code>ro-vu8d.7</code>). Where the OS is running the move is
              a <em>button</em> — the dev server has the operator's secrets file
              beside it. Everywhere else it stays a command with the
              deployment's own sentence under it, because a button that cannot
              work teaches an operator not to trust the page.
            </p>
            <div className="w-full">
              <ProviderCard
                status={PROVIDER_CARD_LEGACY_ENV.status}
                assets={PROVIDER_CARD_LEGACY_ENV.assets}
                nowMs={NOW}
                envImport={{ importable: true, reason: null, onImport: demoImportEnv }}
                onConnect={demoConnect}
                onTest={PROVIDER_CARD_LEGACY_ENV.probe}
                onDisconnect={demoDisconnect}
              />
            </div>
            <div className="w-full">
              <ProviderCard
                status={PROVIDER_CARD_LEGACY_ENV.status}
                assets={PROVIDER_CARD_LEGACY_ENV.assets}
                nowMs={NOW}
                envImport={{
                  importable: false,
                  reason: "elsewhere",
                  onImport: demoImportEnv,
                }}
                onConnect={demoConnect}
                onTest={PROVIDER_CARD_LEGACY_ENV.probe}
                onDisconnect={demoDisconnect}
              />
            </div>
            <p className="w-full text-xs text-muted-foreground">
              The property map a Google credential still has to carry (bead{" "}
              <code>ro-90mr</code>). Each asset's GA4 property and Search Console
              site is saved on that asset's own Sources tab, and the collectors
              stop reading the credential's copy the moment nothing needs it — so
              the card names what is still waiting, and says so when the answer
              becomes none. No tone either way: it is neither a fault nor
              connectivity, just one more thing the credential does, or one fewer.
            </p>
            {PROVIDER_CARD_PROPERTY_MAP_DEMOS.map((demo, index) => (
              <div className="w-full" key={`credential-map-${index}`}>
                <ProviderCard
                  status={demo}
                  assets={PROVIDER_CARD_LEGACY_ENV.assets}
                  nowMs={NOW}
                  onConnect={demoConnect}
                  onTest={PROVIDER_CARD_LEGACY_ENV.probe}
                  onDisconnect={demoDisconnect}
                  onSetExpiry={demoSetExpiry}
                />
              </div>
            ))}
            <p className="w-full text-xs text-muted-foreground">
              A credential stored a second ago: a PUT resets the outcome columns,
              because what the old key proved says nothing about the new one — so
              the verdict slot is a designed <em>not tested yet</em> with the
              Test button beside it, never a blank.
            </p>
            <div className="w-full">
              <ProviderCard
                status={PROVIDER_CARD_JUST_SAVED}
                assets={PROVIDER_CARD_CONNECTED.assets}
                nowMs={NOW}
                onConnect={demoConnect}
                onTest={PROVIDER_CARD_CONNECTED.probe}
                onDisconnect={demoDisconnect}
              />
            </div>
            <p className="w-full text-xs text-muted-foreground">
              And a deployment that cannot store anything yet — no{" "}
              <code>credentials</code> table, or no <code>CREDENTIALS_KEY</code>.
              Connect is disabled — the page's banner says why — while Disconnect
              stays live, because forgetting a credential nobody can read any
              more is exactly when you need to.
            </p>
            <div className="w-full">
              <ProviderCard
                status={PROVIDER_CARD_CONNECTED.status}
                assets={PROVIDER_CARD_CONNECTED.assets}
                nowMs={NOW}
                canConnect={false}
                onConnect={demoConnect}
                onTest={PROVIDER_CARD_CONNECTED.probe}
                onDisconnect={demoDisconnect}
              />
            </div>
          </Section>

          <Section title="ConnectPanel — one panel, save and test (bead ro-ujb9.96.7.1)">
            <p className="w-full text-xs text-muted-foreground">
              The panel drawn in place; on the desk it slides over
              /integrations as a sheet. Each demo answers after a beat so
              Checking can be seen: Bing accepts any key and reports two sites,
              the second Bing refuses whatever is pasted, DataForSEO accepts
              and reports its credit, the second DataForSEO does not answer,
              and the last cannot be pressed because the install cannot store
              a credential yet. Nothing is sent anywhere.
            </p>
            <ConnectSheetDemo />
            {CONNECT_PANEL_DEMOS.map((demo) => (
              <ConnectPanel
                key={demo.key}
                presentation="inline"
                provider={realProvider(demo.provider)}
                canConnect={demo.canConnect}
                // Opened from a site's Data sources, which has no banner of its
                // own: why Connect is off leads the panel (bead ro-e70g).
                blocked={demo.canConnect === false ? <ConnectBlockers blockers={connectBlockers({ blockers: ["key-missing"], keyPresent: false })} /> : undefined}
                onConnect={demo.answer}
                onClose={() => toast.success("Demo only — the panel would close")}
              />
            ))}
          </Section>

          <Section title="SiteTokens — a token pasted per site, saved on paste, Run now (bead ro-ujb9.96.7.9)">
            {/* Clarity's panel body: one site holds a token and works, one
                waits for its paste; the second demo has three calls left
                today. Saving and running answer after a beat; nothing is
                sent. */}
            {[10, 3].map((left) => (
              <ConnectPanel
                key={`clarity-${left}`}
                presentation="inline"
                provider={realProvider("clarity")}
                opened="sites"
                status={null}
                onConnect={CONNECT_PANEL_DEMOS[0]!.answer}
                next={() => (
                  <SiteTokens
                    provider={realProvider("clarity")}
                    sites={CONNECTION_DEMO_SITES.map((site, index) => ({ ...site, held: index === 0 }))}
                    cap={10}
                    statusOf={() => "working"}
                    remaining={() => left}
                    onSave={async () => { await new Promise((resolve) => setTimeout(resolve, 600)); toast.success("Demo only — nothing stored"); }}
                    onRun={async () => { await new Promise((resolve) => setTimeout(resolve, 600)); toast.success("Demo only — nothing run"); return null; }}
                  />
                )}
                onClose={() => toast.success("Demo only — the panel would close")}
              />
            ))}
          </Section>

          <Section title="ConnectBlockers / CopyCommand — why nothing can be connected yet, and its one command (beads ro-ujb9.96.6.19, ro-e70g)">
            {/* No credentials table (the command alone), then no encryption
                key (its binding beside the command). The same banners sit at
                the top of the connect panel's last demo above. */}
            <div className="flex w-full flex-col gap-2">
              <ConnectBlockers blockers={connectBlockers({ blockers: ["key-invalid"], keyPresent: true })} />
            </div>
          </Section>

          <Section title="GoogleSignInSetup — Google connected by signing in, in the panel (bead ro-ujb9.96.7.7)">
            {/* Self-hosted with no client yet (three console steps and the
                file), hosted (one button), and an address Google will not
                return to (the loopback press). Nothing is stored or opened. */}
            {([
              { key: "self-hosted", selfHosted: true, state: "app-missing", loopbackUrl: null },
              { key: "hosted", selfHosted: false, state: "ready", loopbackUrl: null },
              { key: "loopback", selfHosted: true, state: "redirect-unusable", loopbackUrl: "http://127.0.0.1:4747/integrations?connect=google" },
            ] as const).map((demo) => (
              <ConnectPanel
                key={`google-${demo.key}`}
                presentation="inline"
                provider={realProvider("google")}
                status={null}
                onConnect={CONNECT_PANEL_DEMOS[0]!.answer}
                setup={
                  <GoogleSignInSetup
                    card={{ state: demo.state, redirectUri: "http://127.0.0.1:4747/api/integrations/google/oauth/callback", loopbackUrl: demo.loopbackUrl, account: null, scopes: [], connectedAt: null }}
                    selfHosted={demo.selfHosted}
                    startHref="#google-demo"
                    publish={demo.selfHosted ? { url: "#google-demo", label: "Publish" } : null}
                    onSaveClient={async () => { await new Promise((resolve) => setTimeout(resolve, 600)); toast.success("Demo only — nothing stored"); }}
                  />
                }
                onClose={() => toast.success("Demo only — the panel would close")}
              />
            ))}
          </Section>

          <Section title="ConnectionActions — Replace and Disconnect on the connection (bead ro-ujb9.96.7.10)">
            {/* A connected provider's panel: its status, Replace (the key form,
                tested before it is kept) and Disconnect (one confirmation
                naming the sites that stop). The second is failing, so Replace
                leads; the third is the actions alone, as a provider's page
                draws them. The working one carries its collection's schedule
                (`schedule`, bead ro-ujb9.96.7.28), locked here so the gallery
                writes nothing. Nothing is sent or removed. */}
            {CONNECTION_DEMOS.map((demo) => (
              <ConnectPanel
                key={demo.key}
                presentation="inline"
                provider={realProvider(demo.provider)}
                opened="sites"
                status={<IntegrationStateChip state={demo.failing ? "failing" : "working"} subject={`integration:${demo.provider}`} />}
                onConnect={CONNECT_PANEL_DEMOS[0]!.answer}
                next={(_answer, close) => (
                  <SitePicker provider={realProvider(demo.provider)} payload={SITE_PICKER_DEMOS[0]!.payload} onStart={demoCollect(demo.provider)} siteStatus={() => ({ kind: "working", site: null })} onClose={close} />
                )}
                manage={{ stops: CONNECTION_DEMO_SITES, failing: demo.failing, onDisconnect: demoDisconnect }}
                schedule={demo.failing ? undefined : (
                  <ScheduleRows jobs={connectionCollections(demo.provider)} overrides={null} writable={false} />
                )}
                onClose={() => toast.success("Demo only — the panel would close")}
              />
            ))}
            <div className="w-full max-w-[430px] rounded-xl border border-border bg-card p-5">
              <ConnectionActions
                name="Mediavine"
                secret="login"
                onReplace={() => toast.success("Demo only — the form would open")}
                stops={CONNECTION_DEMO_SITES.slice(0, 1)}
                onDisconnect={demoDisconnect}
              />
            </div>
          </Section>

          <Section title="SitePicker — the account's sites, matched, and Start (bead ro-ujb9.96.7.2)">
            {SITE_PICKER_DEMOS.map((demo, index) => (
              <div key={demo.key} className="flex min-h-96 w-full max-w-[430px] flex-col rounded-xl border border-border bg-card p-5">
                <SitePicker
                  provider={realProvider(demo.provider)}
                  payload={demo.payload}
                  onStart={demoCollect(demo.provider, index === 2)}
                  siteStatus={() => ({ kind: "working", site: null })}
                  onClose={() => toast.success("Demo only — the panel would close")}
                />
              </div>
            ))}
            <div className="flex min-h-40 w-full max-w-[430px] flex-col rounded-xl border border-border bg-card p-5">
              <SitePicker provider={realProvider("bing-webmaster")} payload={undefined} onStart={async () => null} onClose={() => {}} />
            </div>
          </Section>

          <Section title="DeclineReasons — Not using, one press and a reason (beads ro-ujb9.96.7.13, .18)">
            <div className="flex w-full flex-col gap-3">
              <DeclineReasons subject="Microsoft Clarity" onChoose={(reason) => { toast.success(`Demo only — ${reason}`); }} onCancel={() => toast.success("Demo only — closed")} />
              <DeclineReasons subject="Second Example" selected="Replaced by another tool" onChoose={(reason) => { toast.success(`Demo only — ${reason}`); }} />
              <DeclineReasons subject="Second Example" selected="Moved to a paid plan" onChoose={(reason) => { toast.success(`Demo only — ${reason}`); }} />
              <DeclineReasons subject="Microsoft Clarity" busy onChoose={() => {}} onCancel={() => {}} />
            </div>
          </Section>

          <Section title="GoogleStartPress — link or hosted start">
            <GoogleStartPress href="/integrations" className="text-sm text-primary underline">
              Open integrations
            </GoogleStartPress>
            <GoogleStartPress
              href="/integrations"
              onStart={() => toast.success("Demo only — no sign-in started")}
              className="text-sm text-primary underline"
            >
              Sign in to Google
            </GoogleStartPress>
            <GoogleStartPress
              href="/integrations"
              onStart={() => toast.success("Demo only — no sign-in started")}
              starting
              className="text-sm text-muted-foreground"
            >
              Starting sign-in
            </GoogleStartPress>
          </Section>

          <Section title="ProviderCard / GoogleSignIn — signing in to Google">
            <p className="w-full text-xs text-muted-foreground">
              Four states, in the order an operator meets them. The panel is a
              prop on the same card rather than a rival component: the chip, the
              verdict, the served assets and the one-confirmation Disconnect are
              identical, and only the connect affordance differs. Every demo is
              live and touches nothing — the sign-in link goes nowhere, and{" "}
              <em>What can this account see?</em> resolves a fixture after a beat
              so the spinner is watchable.
            </p>
            {GOOGLE_OAUTH_DEMOS.map((demo) => (
              <div className="flex w-full flex-col gap-2" key={demo.key}>
                <p className="text-xs text-muted-foreground">{demo.note}</p>
                <ProviderCard
                  status={demo.status}
                  assets={[
                    {
                      id: "plate.example.com",
                      displayName: "plate.example.com",
                      domain: "plate.example.com",
                    },
                  ]}
                  nowMs={NOW}
                  oauth={demo.panel}
                  onConnect={demoConnect}
                  onTest={demoProbe({ ok: true, result: { outcome: "answered", facts: { sites: 3, account: "ops@example.com" } } })}
                  onDisconnect={demoDisconnect}
                />
              </div>
            ))}
          </Section>

          {/* The Wall is a DOCUMENT now (epic ro-lzmq): same payload, same
              widgets, two arrangements. `wall-root` is what puts the gallery's
              copy of it on the TV's true-black ground, and the fixed height is
              what makes the `fill` row's behaviour visible — the assets grid
              takes whatever the other rows leave.

              These boxes are NOT the television's 1920 (bead `ro-lzmq.5`):
              `wall-root` is a query container, so each draws the arrangement
              its own width earns rather than the one this browser window earns.
              That is the point — a gallery box is a box, and what it shows is
              what a Wall that size shows. The editor's preview at `/wall/edit`
              is where the real geometry is reviewed. */}
          <Section title="WallCanvas (the default · a rearranged one with a site filter)">
            <p className="w-full text-xs text-muted-foreground">
              With nothing saved in <code>config/tower.json</code> at{" "}
              <code>/wall</code>, this is what the television draws — D28.
            </p>
            <div className="wall-root h-[34rem] w-full overflow-hidden rounded-lg border border-border bg-background p-2">
              <WallCanvas
                layout={wallDefaultLayout}
                data={wallFixture}
                nowMs={NOW}
                connections={DEMO_CONNECTIONS}
                meetings={upcoming(
                  [
                    liveMeeting("work", "Standup", -10 * 60_000, 35, "Zoom · Engineering"),
                    ...REST_OF_DAY,
                  ],
                  2,
                  2,
                  PINNED_FEEDS,
                )}
                ga4Realtime={realtimeDemo}
              />
            </div>
            <p className="w-full text-xs text-muted-foreground">
              The same payload under a layout somebody arranged: the site rows
              first beside the feed, money under them, no strip, and both
              per-site widgets narrowed to two sites — in the layout's order,
              so Menu leads.
            </p>
            <div className="wall-root h-[34rem] w-full overflow-hidden rounded-lg border border-border bg-background p-2">
              <WallCanvas
                layout={wallArrangedLayout}
                data={wallFixture}
                nowMs={NOW}
                connections={DEMO_CONNECTIONS}
                meetings={upcoming(
                  [
                    liveMeeting("work", "Standup", -10 * 60_000, 35, "Zoom · Engineering"),
                    ...REST_OF_DAY,
                  ],
                  2,
                  2,
                  PINNED_FEEDS,
                )}
                ga4Realtime={realtimeDemo}
              />
            </div>
          </Section>

          {/* The live feed column (bead ro-trai.9). A gallery box holds one
              payload, so an arrival's slide and tint are proven by
              test/wall-feed-column.test.tsx and the Wall feed journey. */}
          <Section title="WallFeed (live rows · reconnecting · empty window)">
            <div className="wall-root grid h-[40rem] w-full grid-cols-1 gap-3 rounded-lg border border-border bg-background p-2 md:grid-cols-3">
              <WallFeed feed={feedDemo(FEED_DEMO_ITEMS)} nowMs={NOW} />
              <WallFeed feed={feedDemo(FEED_DEMO_ITEMS.slice(0, 4))} failed nowMs={NOW} />
              <WallFeed feed={feedDemo([])} nowMs={NOW} />
            </div>
          </Section>

          <Section title="CountdownWidget / CountdownFace (the desk's countdown · Configure · the proximity ramp)">
            <p className="w-full text-xs text-muted-foreground">
              <code>CountdownEditor</code>'s create and remove faces are{" "}
              <strong>deliberately not staged here</strong>, for the reason the
              Wall editor's demo never selects the countdown either: that form is
              live and would write <code>config/tower.json</code> for real, and a
              gallery visit must not add or delete the operator's landmark. Both
              are pinned in <code>apps/tower/test/settings-route.test.tsx</code>{" "}
              — one insert of the whole block on create, the same op backwards on
              remove.
            </p>
            <div className="grid w-full gap-4 lg:grid-cols-2">
              <CountdownWidget
                config={{
                  emoji: "🏁",
                  label: "Completed milestone",
                  targetAt: new Date(NOW - DAY).toISOString(),
                }}
                nowMs={NOW}
              />
              <CountdownWidget
                config={{
                  emoji: "🧭",
                  label: "Editable deadline",
                  targetAt: new Date(NOW + 10 * DAY).toISOString(),
                }}
                nowMs={NOW}
                interactive
              />
            </div>
            <p className="w-full text-xs text-muted-foreground">
              The emoji is the visual landmark; the first non-zero measure is the
              numeric hero, zero units disappear, and hours/minutes recede inside
              one fixed-height, borderless readout. The emoji spans the full left
              column while measures and the true-black Target strip stack on the
              right. The proximity ramp belongs only to the primary value, with
              the last two bands adding a flat background. Compare them side by
              side, since adjacent bands must stay distinguishable at 3 meters —
              and note where the ramp ends: once the target passes, the widget
              drops off the ramp to gray rather than staying red at an operator
              who can no longer do anything about it.
            </p>
            <div className="grid w-full gap-4 md:grid-cols-3 xl:grid-cols-6">
              {(
                [
                  ["Far · 60 days", 60],
                  ["Approaching · 20 days", 20],
                  ["Near · 10 days", 10],
                  ["Soon · 4 days", 4],
                  ["Imminent · 1 day", 1],
                  ["Reached · yesterday", -1],
                ] as const
              ).map(([label, days]) => (
                <CountdownFace
                  key={label}
                  config={{
                    emoji: "⏳",
                    label,
                    targetAt: new Date(NOW + days * DAY).toISOString(),
                  }}
                  nowMs={NOW}
                />
              ))}
            </div>
          </Section>

          <Section title="FunnelListEditor (saved funnels · add / remove / reorder steps · refused · empty · picked from PostHog)">
            <p className="w-full text-xs text-muted-foreground">
              An asset&apos;s PostHog funnels, written as one value. Fake writer: Save records the op
              and resolves. Clear a step&apos;s event, or leave one step, to see the rule the store
              save would return.
            </p>
            <div className="w-full">
              <FunnelListEditor
                assetId="demo.example"
                explain="Each step is an event name, optionally pinned to one page path; people are counted in step order within the window."
                current={DEMO_FUNNELS}
                refusal={(value) => posthogFunnelsRefusal(value)}
                makeOp={(value) => ({ kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/demo.example/posthog/funnels", expect: DEMO_FUNNELS as unknown as JsonValue, value: value as unknown as JsonValue })}
                onSave={demoSave}
              />
              <FunnelListEditor
                label="Funnels (none yet)"
                assetId="demo.example"
                current={null}
                refusal={(value) => posthogFunnelsRefusal(value)}
                makeOp={(value) => ({ kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/demo.example/posthog/funnels", expectAbsent: true, value: value as unknown as JsonValue })}
                onSave={demoSave}
              />
              {/* Picked from the project's saved funnels (bead ro-ujb9.96.7.24):
                  Add funnel offers what is not on the list; each change saves. */}
              <FunnelListEditor
                label="Funnels (picked from PostHog)"
                assetId="demo.example"
                current={DEMO_FUNNELS.slice(0, 1)}
                saved={DEMO_FUNNELS}
                refusal={(value) => posthogFunnelsRefusal(value)}
                makeOp={(value) => ({ kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/demo.example/posthog/funnels", expect: DEMO_FUNNELS.slice(0, 1) as unknown as JsonValue, value: value as unknown as JsonValue })}
                onSave={demoSave}
              />
            </div>
          </Section>

          <Section title="KnobEditor (text / number / datetime / select / toggle — Save writes it · a select whose Save writes two ops)">
            <p className="w-full text-xs text-muted-foreground">
              Live controls, fake writer: every editor here is given an{" "}
              <code className="font-mono">onSave</code> that records the op and resolves, so the
              gallery exercises the real validation, the real Save/Saving states and the real
              toast without touching the repo or the store. Each one buffers a draft; Save (or
              Enter in a text/number field) commits it.
            </p>
            <div className="w-full">
              <KnobEditor
                label="Metrics endpoint"
                explain="pull.json url — text control, validates URL shape before staging."
                assetId="demo.example"
                current="https://demo.example/metrics"
                format={(v) => String(v)}
                makeOp={fileDemo("config/pull.json", "/0/url", "https://demo.example/metrics")}
                control={{ type: "text", validate: validateUrl, mono: true, placeholder: "https://…" }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Anomaly sensitivity"
                explain="flag_defaults.alpha — number control, must be between 0 and 1."
                scopeNote="Applies to every asset"
                current={0.01}
                format={(v) => String(v)}
                makeOp={fileDemo("config/constants.json", "/flag_defaults/alpha", 0.01)}
                control={{ type: "number", validate: validateProbability, step: "0.001" }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Monthly data cap"
                explain="Number control, non-negative dollars."
                scopeNote="Applies to every asset"
                current={25}
                format={(v) => `$${v}`}
                makeOp={fileDemo("config/constants.json", "/monthly_caps/data_usd", 25)}
                control={{ type: "number", validate: validateUsd, step: "1" }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Countdown target"
                explain="Native local date/time input that stages an absolute ISO instant."
                current={new Date(NOW + 10 * DAY).toISOString()}
                format={(v) => String(v)}
                makeOp={fileDemo(
                  "config/tower.json",
                  "/countdown/targetAt",
                  new Date(NOW + 10 * DAY).toISOString(),
                )}
                control={{
                  type: "datetime",
                  validate: (raw) => validateFutureDateTime(raw, NOW),
                  toDraft: (value) => toLocalDateTimeInput(String(value)),
                }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Lifecycle stage"
                explain="Store column — plain select control over the lifecycle enum (no separate chip; the control is the display)."
                assetId="demo.example"
                current="onboarding"
                format={(v) => String(v)}
                makeOp={storeDemo("status", "onboarding")}
                control={{ type: "select", options: ASSET_STATUS.map((s) => ({ value: s, label: s })) }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Automation"
                explain="Store column — the toggle IS the state display: the selected segment carries the meaning color + dot (doc 14 one-representation)."
                assetId="demo.example"
                current={1}
                format={(v) => (v === 1 ? "Monitor only" : "Automation enabled")}
                makeOp={storeDemo("sense_only", 1)}
                control={{
                  type: "toggle",
                  onValue: 1,
                  offValue: 0,
                  onLabel: "Monitor only",
                  offLabel: "Automation enabled",
                  onTone: "declined",
                  offTone: "affirmative",
                }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Owning entity"
                explain="One setting, TWO ops (bead ro-aodz): which entity owns an asset is stored as the asset's id on that entity's own list, so choosing another takes it off one row and puts it on the other — in one changeset, with an Undo that reverses both."
                assetId="demo.example"
                current="demo-ventures"
                format={(v) =>
                  DEMO_ENTITIES.find((row) => row.slug === v)?.name ?? "Nobody has said"
                }
                makeOp={(value) =>
                  entityMoveOps(DEMO_ENTITIES, "demo.example", value === "" ? null : String(value))
                }
                control={{
                  type: "select",
                  options: [
                    { value: "", label: "Nobody has said" },
                    ...DEMO_ENTITIES.map((row) => ({ value: row.slug, label: entityLabel(row) })),
                  ],
                }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Time zone"
                explain="confirm=inline + autosave (bead ro-ujb9.96.6.3): picking a zone IS the save, and Saved · Undo appears beside the picker instead of in a toast — /settings' pattern for one low-risk choice."
                current={DEMO_ZONE_WEST}
                format={(v) => String(v)}
                makeOp={fileDemo("config/constants.json", "/os_time_zone", DEMO_ZONE_WEST)}
                autosave
                control={{
                  type: "select",
                  options: [DEMO_ZONE_WEST, DEMO_ZONE_EAST, "UTC"].map((zone) => ({ value: zone, label: zone })),
                }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Monthly data cap"
                explain="confirm=inline with an explicit Save (money keeps its Save): the confirmation and its Undo sit beside the field."
                current={25}
                format={(v) => String(v)}
                makeOp={fileDemo("config/constants.json", "/monthly_caps/data_usd", 25)}
                control={{ type: "number", validate: validateUsd, step: "1" }}
                onSave={demoSave}
              />
              <KnobEditor
                label="Time zone (refused)"
                explain="confirm=inline, refused (bead ro-ujb9.96.7.12): the writer says no, so the pick goes back to the stored zone and 'Not saved' with the refusal's own words sits beside the picker — no toast."
                current={DEMO_ZONE_WEST}
                format={(v) => String(v)}
                makeOp={fileDemo("config/constants.json", "/os_time_zone", DEMO_ZONE_WEST)}
                autosave
                control={{
                  type: "select",
                  options: [DEMO_ZONE_WEST, DEMO_ZONE_EAST, "UTC"].map((zone) => ({ value: zone, label: zone })),
                }}
                onSave={async () => {
                  throw new Error("Changed elsewhere — reload to see the current value");
                }}
              />
            </div>
          </Section>

          <Section title="SavesPaused (saves paused: said once for the screen · editors below show only a lock)">
            <div className="flex w-full flex-col gap-3" data-demo-saves-paused>
              <SavesPaused state={{ writable: false, reason: "Config store unreachable" }} />
              <SavesPaused state={{ writable: true, reason: null }} />
              <p className="text-xs text-muted-foreground">
                The second demo renders nothing: while saves work, there is no state to show.
              </p>
            </div>
          </Section>

          <Section title="InlineSaveState (saving · saved with Undo · not saved with the refusal · idle draws nothing)">
            <p className="w-full text-xs text-muted-foreground">
              A save's outcome beside the field that made it (bead ro-ujb9.96.7.12): KnobEditor inline,
              a CollectionEditor cell inline and a Settings schedule row all draw this one state.
            </p>
            <div className="flex w-full flex-col gap-3" data-demo-inline-save>
              <InlineSaveState subject="field:demo" save={{ state: "saving" }} />
              <InlineSaveState subject="field:demo" save={{ state: "saved", onUndo: () => toast.success("Demo only — Undo pressed") }} />
              <InlineSaveState subject="field:demo" save={{ state: "saved", undoing: true, onUndo: () => {} }} />
              <InlineSaveState subject="field:demo" save={{ state: "refused", refusal: "Changed elsewhere — reload to see the current value" }} />
              <InlineSaveState subject="field:demo" save={{ state: "idle" }} />
            </div>
          </Section>

          <Section title="CollectionEditor (rows · inline edit · a fixed join key · a picker that refuses / one that suggests · filter and sort past eight rows · a computed column · a subset of the declared columns · add from the schema · remove behind a confirm · unfiled asset · last row out · one row · loading / empty / read-only)">
            <p className="w-full text-xs text-muted-foreground">
              Live table, fake writer: every editor here is given an{" "}
              <code className="font-mono">onSave</code> that records the ops and
              resolves, so the gallery exercises the real controls, the real
              refusals and the real toast without writing a config file. Nothing
              below names a column — the columns, the controls, the Add form and
              every refusal come from the register's own declaration in{" "}
              <code className="font-mono">scripts/config-registers.mjs</code>,
              which is the same declaration the write lane refuses against.
            </p>
            <div className="flex w-full flex-col gap-6">
              <CollectionEditor
                register="domain-costs"
                rows={DEMO_DOMAIN_COSTS}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="domain-costs"
                title="Domain orders (long enough to narrow)"
                // Past eight rows a register offers a filter and sortable
                // headers, and the point of the demo is that neither reaches an
                // op: edit a row after filtering and sorting, and the pointer is
                // still the one it has in the file.
                rows={DEMO_LONG_DOMAIN_COSTS}
                derived={[
                  {
                    name: "amortized",
                    label: "Per month",
                    describe: "the order over its 12-month term — arithmetic, not a stored field",
                    render: (row) => (
                      <span className="tabular-nums">
                        {formatUsd(Number(row.values.paidUsd ?? 0) / 12, { cents: true })}
                      </span>
                    ),
                  },
                ]}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="value-events"
                params={{ asset: "demo.example" }}
                rows={["calculation_complete", "sign_up"]}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="signal-panels"
                rows={{
                  "demo.example": {
                    enabled: true,
                    reason: "live-lanes",
                    since: "2026-08-03",
                  },
                }}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="serp-panel-queries"
                params={{ asset: "demo.example" }}
                rows={["big mac calories", { query: "whopper calories", label: "Item head" }]}
                // The SAME prop as the asset picker two editors down, meaning
                // the other thing: this column's domain is open, so the bets
                // already in use are offered and a new one is still accepted.
                fieldOptions={{ label: ["Item head"] }}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="signal-panels"
                params={{ asset: "demo.example" }}
                rows={{
                  "demo.example": {
                    enabled: false,
                    reason: "no-lane-yet",
                    task: "ro-2zk.2",
                    since: "2026-09-04",
                  },
                }}
                oneRow
                title="Panel refresh"
                onSave={demoCollectionSave}
              />
              <CollectionEditor register="recurring-costs" rows={undefined} loading />
              <CollectionEditor
                register="task-hub-spokes"
                rows={[]}
                emptyHint="Tasks board empty"
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="ga4-event-params"
                params={{ asset: "demo.example" }}
                rows={null}
                emptyHint="JavaScript-error report skips this site"
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="task-hub-spokes"
                rows={[{ asset: "demo.example", prefix: "dem", database: "dem", repo: "../demo" }]}
                // The three things a page supplies that the declaration cannot:
                // the ids that actually exist, the row's own glyph, and the fact
                // that a landed row is not always the whole job.
                fieldOptions={{ asset: ["menu.example.org", "finance.example.org"] }}
                rowGlyph={(row) => <PropertyFavicon domain={row.key} displayName={row.key} />}
                onAdded={(row) => toast.success(`Mapped ${String(row.asset)} — three steps left`)}
                onSave={demoCollectionSave}
              />
              <div data-demo="projects-commit-auto">
                <CollectionEditor
                  register="task-hub-spokes"
                  title="Projects (commit auto: no Save in any cell)"
                  // /settings' Task projects and Ownership tables
                  // (bead ro-ujb9.96.7.12): a cell saves when it is left or its
                  // choice is picked, and says Saved · Undo or Not saved beneath.
                  rows={[
                    { asset: "demo.example", prefix: "dem", database: "dem" },
                    { asset: "other.example", prefix: "oth", database: "oth" },
                  ]}
                  columns={["asset", "prefix", "database"]}
                  commit="auto"
                  rowGlyph={(row) => <PropertyFavicon domain={row.key} displayName={row.key} />}
                  onSave={demoCollectionSave}
                />
              </div>
              <CollectionEditor
                register="task-hub-spokes"
                title="Projects (a computed column that marks only what is wrong)"
                rows={[
                  { asset: "demo.example", prefix: "dem", database: "dem", repo: "../demo" },
                  { asset: "other.example", prefix: "oth", database: "typo", repo: "../other" },
                ]}
                // The state /settings#task-hub renders (bead `ro-eb7z`): the OS
                // files a task about a project whose database does not exist,
                // and the page marks THAT row. An agreeing row is blank rather
                // than ticked — the board carries a bounded head of each list,
                // so absence can only ever mean "nothing says otherwise".
                derived={[
                  {
                    name: "found",
                    label: "Found",
                    describe:
                      "Marked when the OS could not find a database by this name where the tasks live.",
                    render: (row) =>
                      row.values.database === "typo" ? (
                        <SeverityDot
                          severity="warn"
                          size="sm"
                          title="No database named typo where the tasks live"
                        />
                      ) : null,
                  },
                ]}
                rowGlyph={(row) => <PropertyFavicon domain={row.key} displayName={row.key} />}
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="entities"
                title="Legal entities (a subset of the declared columns)"
                // Two spellings of one array, the same crossing /settings makes:
                // `EntityRow` names the fields a reader wants, `CollectionSource`
                // is the same rows as the JSON an op guards itself with.
                rows={DEMO_ENTITIES as unknown as JsonValue[]}
                // What /settings shows (bead `ro-aodz`): the entity, and never
                // its `assets` list. An asset belongs to one entity, no field of
                // one row can see another, and a list typed into two rows would
                // claim the same asset twice — so that column is edited on the
                // asset's own page, where the move is one change.
                columns={["slug", "name", "form", "jurisdiction"]}
                describe="one legal entity behind the portfolio"
                onSave={demoCollectionSave}
              />
              <CollectionEditor
                register="domain-costs"
                rows={DEMO_DOMAIN_COSTS}
                readOnly
                onSave={demoCollectionSave}
              />
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  Config is files; this build has none.
                </p>
                <CollectionEditor
                  register="value-events"
                  params={{ asset: "demo.example" }}
                  rows={["calculation_complete"]}
                  readOnly
                  statesReadOnly={false}
                  onSave={demoCollectionSave}
                />
              </div>
            </div>
            <p className="w-full text-xs text-muted-foreground">
              Top to bottom: an array register keyed by a field — whose{" "}
              <code className="font-mono">domain</code> column is FIXED, because
              a domain order records what a registrar charged for that name and
              renaming it rewrites a purchase (the declaration says so, and the
              write lane refuses the rename too, so the missing Save is a rule
              rather than a style); the SAME register past eight rows, which
              offers a filter box, sortable headers and a computed{" "}
              <em>Per month</em> column — narrow it to one asset, sort by amount,
              then edit a row and watch the pointer stay the one that row has in
              the file, which is the whole reason the narrowing lives in the
              component rather than in the page; a SCALAR
              register whose row is the string itself; an object register keyed
              by asset id; a one-term tracked panel, whose register declares that
              this file has no empty state — so the × on its LAST row removes the
              asset&apos;s whole entry rather than leaving{" "}
              <code className="font-mono">queries: []</code> behind, which the
              collector refuses — and whose Bet column offers the bets this panel
              already names WITHOUT refusing a new one, because that column&apos;s
              domain is open (type a case variant of an existing bet to meet the
              rule that makes the picker worth having); a ONE-ROW surface, which offers no Remove and no
              Add because membership there is an invariant rather than the
              operator&apos;s to grow; the loading state (the table&apos;s own
              shape, never a spinner); the empty state, which still offers the way
              to fill it; an asset the file has NO entry for, where the first Add
              files the asset&apos;s whole entry rather than appending to a list
              that is not there; a register whose asset column takes its choices
              from the PAGE (type an id that is not offered and it refuses naming
              the field; the database follows the prefix until you type into it;
              the row carries its own favicon); the read-only deployment, which
              drops every control and says why rather than offering a Save that
              cannot work; and the same read-only state with the sentence said
              once by the page above it, which is how a surface stacking several
              editors avoids saying it per table. Type a negative amount and press
              Save to see a field refuse itself before anything is sent; press the
              × on a row for the one confirm this component asks, because a
              removal has no inverse in place. The entities table is the one
              surface here that draws a SUBSET of its declared columns: the list
              of assets each entity owns is a declared field, and it is changed on
              the asset&apos;s own page — where moving one is a single change
              rather than two lists that can both claim it.
            </p>
          </Section>

          <Section title="TaskComposer / File task (handoff prefill · new task · open composer · read-only deployment)">
            <p className="w-full text-xs text-muted-foreground">
              Live form, fake writer: every demo here is given an{" "}
              <code className="font-mono">onFile</code> that returns a fabricated
              id and resolves, so the gallery exercises the real fields, the real
              refusals and the real toast without filing a bead on the portfolio
              task hub. The handoff prefill is built by{" "}
              <code className="font-mono">taskHandoffPrefill</code> — the same
              function the copied <code className="font-mono">bd create</code> is
              rendered from — so the locked labels and the hidden{" "}
              <code className="font-mono">noticeos_*</code> metadata below are the
              real ones.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <FileTaskButton
                prefill={DEMO_HANDOFF_PREFILL}
                subject="the demo finding"
                onFile={demoFileTask}
                projects={DEMO_SPOKES}
              />
              <FileTaskButton
                label="New task"
                variant="default"
                size="default"
                onFile={demoFileTask}
                projects={DEMO_SPOKES}
              />
              <FileTaskButton
                subject="a deployed build"
                capabilities={{ live: false, reason: "read_only_deployment" }}
                projects={DEMO_SPOKES}
              />
            </div>
            <p className="w-full text-xs text-muted-foreground">
              The composer itself is a `fixed inset-0` portal onto{" "}
              <code className="font-mono">document.body</code>, so it cannot be
              boxed beside its neighbours — press either enabled trigger above
              and the real slide-over opens over this page, prefilled, with a
              File task that resolves and nothing written.
            </p>
          </Section>

          <Section title="Timeline (events / from a task / truncated / lifecycle move / empty)">
            <div className="w-80">
              <Timeline
                items={[
                  { id: 1, at: iso(6 * HOUR), kind: "deploy", ref: "a1b2c3d", note: "ship CJ product cards" },
                  { id: 2, at: iso(20 * DAY), kind: "model-change", ref: "builder=claude-opus-4-8", note: "builder model upgrade" },
                  { id: 3, at: iso(30 * DAY), kind: "external", ref: "google-core-update", note: "Google June core update" },
                ]}
                nowMs={NOW}
              />
            </div>
            {/* The join (bead `ro-4ko`): the first two refs ARE beads and render
                as the task that caused the change, the third is a commit sha and
                stays the mono string it always was. The shipped one is the case
                to look at hardest — it must not read as "and it worked". */}
            <div className="w-80">
              <Timeline
                items={[
                  { id: 1, at: iso(2 * HOUR), kind: "deploy", ref: "mp-1w2", note: "rewrote the chipotle opener" },
                  { id: 2, at: iso(9 * DAY), kind: "deploy", ref: "mp-33j", note: "July title batch — 240 recipe titles" },
                  { id: 3, at: iso(21 * DAY), kind: "config", ref: "a1b2c3d", note: "raise alpha" },
                ]}
                beads={[
                  { kind: "query", key: "chipotle calories", beadId: "mp-1w2", status: "open", closedAt: null },
                  {
                    kind: "finding",
                    key: "search-striking-distance",
                    beadId: "mp-33j",
                    status: "closed",
                    closedAt: "2026-07-29T00:00:00.000Z",
                  },
                ]}
                nowMs={NOW}
              />
            </div>
            <div className="w-80">
              <Timeline
                items={[
                  { id: 1, at: iso(6 * HOUR), kind: "deploy", ref: "a1b2c3d", note: "ship CJ product cards" },
                  { id: 2, at: iso(20 * DAY), kind: "config", ref: "flags@41", note: "raise alpha" },
                ]}
                olderCount={7}
                nowMs={NOW}
              />
            </div>
            {/* A lifecycle move (bead `ro-3085`): the ref is machine text, so
                the row reads as a sentence and the mono string is dropped. The
                second one only LOOKS like a move — an unknown stage — and stays
                mono, exactly like an unresolved bead id. */}
            <div className="w-80">
              <Timeline
                items={[
                  { id: 1, at: iso(3 * HOUR), kind: "config", ref: "lifecycle:baselining>retired", note: null },
                  { id: 2, at: iso(11 * DAY), kind: "config", ref: "lifecycle:onboarding>baselining", note: null },
                  { id: 3, at: iso(30 * DAY), kind: "config", ref: "lifecycle:live>nowhere", note: null },
                ]}
                nowMs={NOW}
              />
            </div>
            <div className="w-80">
              <Timeline items={[]} nowMs={NOW} />
            </div>
          </Section>

          <Section title="ChangeChip (one named change / several / none)">
            <Labeled name="single (dated against the alert)">
              <ChangeChip changes={[deployAnnotation]} firedAt={iso(2 * HOUR)} />
            </Labeled>
            <Labeled name="same kind">
              <ChangeChip changes={twoDeploys} firedAt={iso(2 * HOUR)} />
            </Labeled>
            <Labeled name="mixed kinds">
              <ChangeChip changes={mixedChanges} firedAt={iso(2 * HOUR)} />
            </Labeled>
            <Labeled name="none (renders nothing)">
              <ChangeChip changes={[]} firedAt={iso(2 * HOUR)} />
            </Labeled>
          </Section>

          <Section title="AlertRow (open / settled with span / portfolio row with asset / milestone)">
            {/* Since bead `ro-78qo.17` the row is a `ListRow`, so it renders an
                `<li>` and every run of rows sits in an `AlertList`. PRESS ONE:
                closed it is a mark, a headline, one caption and an age, and the
                evidence, the dated facts and the verbs are all revealed in
                place. */}
            <div className="flex w-full flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                open — the four verbs and the evidence are inside the row
              </span>
              <AlertList label="Open alert demo">
                <AlertRow flag={alertRowFlags.open} nowMs={NOW} assetId="plate.example.com" />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                settled — the resolved mark, the disposition on the caption, and
                the span rule that grows with how long it stayed open
              </span>
              <AlertList label="Settled alert demo">
                <AlertRow flag={alertRowFlags.resolvedFast} nowMs={NOW} assetId="plate.example.com" history />
                <AlertRow flag={alertRowFlags.resolvedSlow} nowMs={NOW} assetId="plate.example.com" history />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                acknowledged — its note and expiry are behind the row
              </span>
              <AlertList label="Acknowledged alert demo">
                <AlertRow flag={alertRowFlags.acknowledged} nowMs={NOW} assetId="menu.example.org" history />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                portfolio row — names the asset with its favicon and links to
                that asset&rsquo;s Alerts tab
              </span>
              <AlertList label="Portfolio alert demo">
                <AlertRow
                  flag={alertRowFlags.resolvedSlow}
                  nowMs={NOW}
                  assetId="menu.example.org"
                  asset={{ id: "menu.example.org", domain: "menu.example.org", displayName: "Menu" }}
                  history
                />
                <AlertRow
                  flag={alertRowFlags.milestone}
                  nowMs={NOW}
                  assetId="codes.example.com"
                  asset={{ id: "codes.example.com", domain: "codes.example.com", displayName: "Codes" }}
                  history
                />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                already sent to the notification channel — open the row: the mark
                says the operator has heard about this one, and an unmarked row
                says they have not
              </span>
              <AlertList label="Notified alert demo">
                <AlertRow flag={alertRowFlags.notified} nowMs={NOW} assetId="menu.example.org" />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                tuned, then marked read — the rule change outlives the decision
                about the firing
              </span>
              <AlertList label="Tuned alert demo">
                <AlertRow flag={alertRowFlags.tunedThenRead} nowMs={NOW} assetId="plate.example.com" history />
              </AlertList>
              <span className="mt-2 text-xs text-muted-foreground">
                settled with no closing time recorded — the span renders nothing
                rather than a zero, and the value falls back to when it fired
              </span>
              <AlertList label="Undated disposition demo">
                <AlertRow flag={alertRowFlags.undatedDisposition} nowMs={NOW} assetId="finance.example.org" history />
              </AlertList>
            </div>
          </Section>

          <Section title="AttentionAllClear (the one all-clear line)">
            <div className="w-full">
              <AttentionAllClear />
            </div>
          </Section>

          <Section title="RevenueHero (on pace to pass last month / passed it / learning / no revenue source)">
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <RevenueHero portfolio={portfolioNormal} assets={revenueOnPace} nowMs={NOW} />
            </div>
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <RevenueHero portfolio={portfolioNormal} assets={revenuePassed} nowMs={NOW} />
            </div>
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <RevenueHero portfolio={portfolioNormal} assets={revenueLearning} nowMs={NOW} />
            </div>
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <RevenueHero portfolio={{ ...portfolioNormal, booked: NO_RESIDUE.booked, forecast: NO_RESIDUE.forecast, netTrend: [], firstRun: true }} assets={[]} />
            </div>
          </Section>

          <Section title="NeedsYou (top three with urgent tasks / nothing broken but urgent tasks / nothing needs you)">
            <div className="wall-root w-full max-w-3xl rounded-lg bg-background p-4">
              <NeedsYou
                issues={wallIssues({ assets: wallFixture.assets, attention: attentionItems, connections: DEMO_CONNECTIONS, nowMs: NOW })}
                operator={wallFixture.operator}
                nowMs={NOW}
              />
            </div>
            <div className="wall-root w-full max-w-3xl rounded-lg bg-background p-4">
              <NeedsYou issues={[]} operator={wallFixture.operator} nowMs={NOW} />
            </div>
            <div className="wall-root w-full max-w-3xl rounded-lg bg-background p-4">
              <NeedsYou
                issues={[]}
                operator={{ waiting: 0, urgent: 0, measuredProjects: 6, urgentMeasuredProjects: 6, projectCount: 6, capturedAt: iso(0) }}
                nowMs={NOW}
              />
            </div>
          </Section>

          <Section title="SiteRows (the demo sites with their marks / three sites, roomier / one site in depth / a failed live read)">
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <SiteRows
                assets={wallFixture.assets}
                issues={wallIssues({ assets: wallFixture.assets, attention: attentionItems, connections: DEMO_CONNECTIONS, nowMs: NOW })}
                ga4Realtime={realtimeDemo}
                nowMs={NOW}
              />
            </div>
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <SiteRows
                assets={wallFixture.assets.slice(0, 3)}
                issues={wallIssues({ assets: wallFixture.assets.slice(0, 3), attention: attentionItems, connections: DEMO_CONNECTIONS, nowMs: NOW })}
                ga4Realtime={realtimeDemo}
                nowMs={NOW}
              />
            </div>
            <div className="wall-root h-160 w-full rounded-lg bg-background p-4">
              <SiteRows assets={[cardLive]} issues={[]} ga4Realtime={realtimeDemo} nowMs={NOW} />
            </div>
            <div className="wall-root w-full rounded-lg bg-background p-4">
              <SiteRows assets={[cardLive]} issues={[]} ga4Realtime={realtimeDemo} ga4RealtimeError nowMs={NOW} />
            </div>
          </Section>

          <Section title="Wall layout editor">
            <WallEditorDemo />
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * The Wall's editor, live (bead `ro-lzmq.2`).
 *
 * It carries its own reducer because these five components are only honest
 * TOGETHER: the library goes dark as a unique widget is placed, the panel
 * becomes the inspector for whatever is clicked in the preview, the rows list
 * follows what the preview shows, and a drag moves a widget in all three at
 * once. Five static copies would show five snapshots and never the thing.
 *
 * It renders the COMPONENTS and not the route, so there is no Save anywhere in
 * it and no gallery visit can rearrange the operator's television. For the same
 * reason the selected widget starts on the assets grid rather than the
 * countdown, whose panel is the live `CountdownEditor` and would write
 * `config/tower.json` for real.
 */
function WallEditorDemo() {
  const [state, dispatch] = useReducer(
    wallEditorReducer,
    DEFAULT_WALL_LAYOUT,
    wallEditorState,
  );
  const [selected, setSelected] = useState<string | null>("assets");

  return (
    <div className="flex w-full flex-col gap-4">
      <WallPreview
        layout={state.layout}
        data={WALL_DEMO_PAYLOAD}
        meetings={null}
        nowMs={NOW}
        selectedId={selected}
        onSelect={setSelected}
        onRemove={(widgetId) => {
          setSelected((id) => (id === widgetId ? null : id));
          dispatch({ type: "remove", widgetId });
        }}
        onMove={(widgetId, toRowId, toIndex) =>
          dispatch({ type: "move", widgetId, toRowId, toIndex })
        }
      />
      <div className="grid w-full gap-4 lg:grid-cols-[14rem_minmax(0,1fr)_19rem]">
        <WallLibraryPanel
          layout={state.layout}
          onAdd={(widget) => dispatch({ type: "add", widget })}
        />
        <WallRowsPanel
          layout={state.layout}
          onAddRow={() => dispatch({ type: "add-row" })}
          onRemoveRow={(rowId) => dispatch({ type: "remove-row", rowId })}
          onMoveRow={(rowId, direction) => dispatch({ type: "move-row", rowId, direction })}
          onFillRow={(rowId) => dispatch({ type: "fill-row", rowId })}
          onMove={(widgetId, toRowId, toIndex) =>
            dispatch({ type: "move", widgetId, toRowId, toIndex })
          }
        />
        <div className="flex flex-col gap-4">
          <WallWidgetPanel
            layout={state.layout}
            selectedId={selected}
            assets={[cardLive, cardWarn]}
            nowMs={NOW}
            onSelect={setSelected}
            onWidth={(widgetId, width) => dispatch({ type: "width", widgetId, width })}
            onSettings={(widgetId, settings) =>
              dispatch({ type: "settings", widgetId, settings })
            }
            onNudge={(widgetId, direction) => dispatch({ type: "nudge", widgetId, direction })}
            onStack={(widgetId) => dispatch({ type: "stack", widgetId })}
            onRemove={(widgetId) => {
              setSelected((id) => (id === widgetId ? null : id));
              dispatch({ type: "remove", widgetId });
            }}
          />
          <WallVersions
            history={WALL_DEMO_HISTORY}
            nowMs={NOW}
            reverting={null}
            onRevert={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

/** Two assets and the quiet bands: enough for the canvas to draw something in
 * every track, and nothing this gallery is about. */
const WALL_DEMO_PAYLOAD: WallPayload = {
  generatedAt: iso(0),
  portfolio: portfolioNormal,
  system: systemNormal,
  dashboard: {
    countdown: { emoji: "🌁", label: "SF MOVE 2026", targetAt: isoAhead(30 * DAY) },
  },
  assets: [cardLive, cardWarn],
  attention: attentionItems.slice(0, 2),
  snoozed: [],
  operator: {
    waiting: 1,
    urgent: 0,
    measuredProjects: 6,
    urgentMeasuredProjects: 6,
    projectCount: 6,
    capturedAt: iso(0),
  },
  ledgerRecordedAt: iso(2 * DAY),
};

/** Two versions, so Revert has something to point at and the age line has two
 * different ages to format. */
const WALL_DEMO_HISTORY: WallLayoutVersion[] = [
  {
    savedAt: iso(2 * DAY),
    reason: "Moved Needs you up so it reads from the sofa",
    layout: {
      version: 1,
      rows: [
        {
          id: "horizon",
          height: "auto",
          widgets: [{ id: "needs", type: "needs", width: 1 }],
        },
        {
          id: "sites",
          height: "fill",
          widgets: [{ id: "sites", type: "sites", width: 1 }],
        },
      ],
    },
  },
  {
    savedAt: iso(30 * DAY),
    reason: "Sites only, while the ledger was still empty",
    layout: {
      version: 1,
      rows: [
        {
          id: "only",
          height: "fill",
          widgets: [{ id: "sites", type: "sites", width: 1 }],
        },
      ],
    },
  },
];

/** A glyph beside the sentence it means, on one line — the mark is three pixels
 * of ink and a centred caption under it would leave the reviewer guessing which
 * caption belongs to which weight. */
function GlyphRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex h-4 min-w-8 items-center">{children}</span>
      <span>{label}</span>
    </div>
  );
}

/**
 * `AddSitePanel` in each of its states (bead `ro-ujb9.96.7.5`). Static on
 * purpose: every state is one set of props, and the real sheet — the one
 * behaviour a picture cannot show — is one press away on `AddSiteButton`.
 */
const ADD_SITE_DEMOS: {
  key: string;
  domain: string;
  preview?: AddSitePanelProps["preview"];
  prelaunch?: boolean;
  issue?: AddSitePanelProps["issue"];
  blocked?: string;
  adding?: boolean;
  incomplete?: AddSitePanelProps["incomplete"];
}[] = [
  { key: "empty", domain: "" },
  { key: "from-domain", domain: "journey.example", preview: { id: "journey.example", name: "Journey Example", source: "domain", mark: null } },
  { key: "from-site", domain: "shop.example.com", preview: { id: "shop.example.com", name: "Example Shop", source: "site", mark: "shop.example.com" }, prelaunch: true },
  { key: "exists", domain: "second.example", issue: { field: "domain", message: "Already added", existing: "second.example" } },
  { key: "invalid", domain: "journey", issue: { field: "domain", message: "Not a domain — like example.com" } },
  { key: "adding", domain: "journey.example", preview: { id: "journey.example", name: "Journey Example", source: "domain", mark: null }, adding: true },
  { key: "blocked", domain: "journey.example", preview: { id: "journey.example", name: "Journey Example", source: "domain", mark: null }, blocked: "Config store unreachable — saves paused" },
  {
    key: "incomplete",
    domain: "journey.example",
    incomplete: {
      state: {
        id: "journey.example",
        reason: "The config store did not answer",
        changeset: JSON.stringify({ version: 1, slug: "add-asset-journey-example", ops: [{ kind: "file-json-insert", file: "config/integrations.json", pointer: "/assets/journey.example" }] }, null, 2),
      },
      retrying: false,
      canRetry: true,
      onRetry: () => toast.success("Demo only — Retry would re-send the setup"),
    },
  },
];

// --- the rule-tuning demos (bead `ro-u072`) --------------------------------
/** The three portfolio alert-rule settings, exactly as `/api/settings` sends
 * them. The gallery reads no payload, so it states the same fields the Worker's
 * own `buildRules` produces rather than inventing a different vocabulary. */
const TUNE_KNOBS: KnobFact[] = [
  {
    key: "alpha",
    label: "Anomaly sensitivity",
    jargon: "alpha",
    value: "0.01",
    explain:
      "How improbable a reading has to be before it alerts. Lower is quieter.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/alpha",
    raw: 0.01,
  },
  {
    key: "min_baseline_per_day",
    label: "Minimum daily volume",
    jargon: "min_baseline_per_day",
    value: "3",
    explain:
      "Below this many a day, one quiet day is noise and the multi-day rule takes over.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/min_baseline_per_day",
    raw: 3,
  },
  {
    key: "low_volume_window_hours",
    label: "Low-volume window",
    jargon: "low_volume_window_hours",
    value: "72",
    explain: "How many hours the low-volume rule adds up before it judges.",
    owner: "config/constants.json",
    pointer: "/flag_defaults/low_volume_window_hours",
    raw: 72,
  },
];

/** Build a thirty-day replay from a per-day script, so each demo below states
 * only what makes it different. */
function backtestDemo(
  script: (index: number) => { state: RuleBacktestDay["state"]; stored?: boolean },
): RuleBacktest {
  const days: RuleBacktestDay[] = Array.from({ length: 30 }, (_, index) => {
    const { state, stored = false } = script(index);
    const date = new Date(Date.UTC(2026, 5, 6) + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      state,
      firings:
        state === "fired" ? [{ metric: "signups", severity: "warn" as const }] : [],
      ...(state === "unjudged" ? { reason: "no-baseline" as const } : {}),
      stored,
    };
  });
  return {
    asset: "menu.example.org",
    ruleId: "flow-poisson-low",
    metric: "signups",
    config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
    windowDays: 30,
    firstDay: days[0]!.date,
    lastDay: days[29]!.date,
    days,
    wouldFire: days.filter((day) => day.state === "fired").length,
    judged: days.filter((day) => day.state === "fired" || day.state === "quiet").length,
    reported: days.filter((day) => day.state !== "no-report").length,
    firedInStore: days.filter((day) => day.stored).length,
  };
}

const BACKTEST_MIXED = backtestDemo((index) => {
  if (index === 3 || index === 4) return { state: "no-report" };
  if (index < 8) return { state: "unjudged" };
  if (index === 12 || index === 13 || index === 26) return { state: "fired", stored: true };
  if (index === 19) return { state: "fired" };
  return { state: "quiet", stored: index === 21 };
});

const BACKTEST_SILENT = backtestDemo((index) => ({
  state: "quiet",
  stored: index === 9 || index === 10 || index === 22 || index === 27,
}));

const BACKTEST_UNJUDGED = backtestDemo((index) => ({
  state: index % 7 === 0 ? "no-report" : "unjudged",
}));

const BACKTEST_EMPTY = backtestDemo(() => ({ state: "no-report" }));

/** The four things the panel can say about a replay. */
const TUNE_PREVIEWS: [string, RuleTunePreview][] = [
  ["ready", { state: "ready", backtest: BACKTEST_MIXED }],
  ["replaying", { state: "loading" }],
  ["value the detector refuses", { state: "invalid" }],
  [
    "replay refused",
    {
      state: "failed",
      message: "No preview for this rule — it is not judged by these settings.",
    },
  ],
];

/**
 * The five things a rule's tune record can say (bead `ro-ayxy`). The counts are
 * demo figures — the gallery has no store — but every state the shipped
 * component can reach is here, including the two that refuse to draw a bar.
 */
const TUNE_RATES: [string, AlertRuleStat | null][] = [
  [
    "a rule the operator keeps quietening",
    {
      ruleId: "flow-poisson-low",
      fired: 22,
      settled: 9,
      tuned: 4,
      tunedOpen: 0,
      acknowledged: 3,
      resolved: 2,
      // The store that HAS db/0030 applied: six saves behind four tuned
      // alerts, which is the whole point of the row per tune (bead `ro-6d1t`).
      tunes: 6,
    },
  ],
  [
    "answered every other way",
    {
      ruleId: "ingest-freshness",
      fired: 14,
      settled: 12,
      tuned: 0,
      tunedOpen: 0,
      acknowledged: 9,
      resolved: 3,
      // Measured, and it is zero — a rule nobody has ever tuned prints nothing
      // rather than a "0" that would read the same as a store that cannot say.
      tunes: 0,
    },
  ],
  [
    "tunes still open, outside the rate",
    {
      ruleId: "asset-declared",
      fired: 8,
      settled: 3,
      tuned: 1,
      tunedOpen: 2,
      acknowledged: 1,
      resolved: 1,
      // The install that has not applied the migration: unknown, never zero.
      tunes: 0,
    },
  ],
  [
    "fired, nothing settled yet",
    {
      ruleId: "flow-lowvol-window",
      fired: 3,
      settled: 0,
      tuned: 0,
      tunedOpen: 0,
      acknowledged: 0,
      resolved: 0,
      tunes: 0,
    },
  ],
  // 75% and the OS says nothing (bead `ro-bgny`): four settled alerts is under
  // the minimum the proposal waits for, and one more click either way would
  // move this share 25 points.
  [
    "over the line, too little settled to act on",
    {
      ruleId: "hygiene-sitemap",
      fired: 6,
      settled: 4,
      tuned: 3,
      tunedOpen: 0,
      acknowledged: 1,
      resolved: 0,
      tunes: 3,
    },
  ],
  ["no firings yet", null],
];

/** What the panel's own copy of the record shows in the gallery. */
const TUNE_RATE_PAYLOAD: AlertRuleStatsPayload = {
  generatedAt: "2026-09-04T12:00:00.000Z",
  windowDays: 90,
  since: "2026-06-06T12:00:00.000Z",
  rules: [TUNE_RATES[0]![1]!],
};

/* ═══════════════════════════════════════════════════════════════════════════
   DOC 21'S SURFACE VOCABULARY

   The fixture is plate.example.com's REAL 90-day series, 2026-06-08 → 2026-09-05,
   copied from the reference mockup beside doc 21
   (docs/briefs/2026-09-05-surface-redesign-mockup.html). Real data because the
   thing being reviewed here is whether a shape reads: a synthetic sine wave
   makes every chart look competent, and this series has the two facts that
   actually test the vocabulary — a reporting-timezone change on Sep 1 and a
   provisional last day that is a fifth of its neighbour.
   ═══════════════════════════════════════════════════════════════════════════ */

const PLATE_FIRST_DAY = "2026-06-08";

/** Consecutive days from the asset's first reported one, through the helper the
 * chart fixtures above already use — one date walker, not two. */
const plateDays = (values: number[], start = PLATE_FIRST_DAY): SeriesPoint[] =>
  dailySeries(values, start);

const PLATE_USERS = [
  552, 691, 572, 505, 390, 273, 353, 625, 567, 592, 629, 428, 369, 495, 728, 777, 754, 680, 570,
  352, 517, 810, 711, 729, 625, 479, 378, 578, 1142, 1118, 1112, 973, 906, 612, 693, 1164, 2059,
  1117, 1038, 1081, 843, 942, 1253, 1274, 1483, 1148, 1048, 636, 841, 1935, 1432, 1161, 1093, 930,
  698, 878, 1131, 1170, 1176, 1221, 1010, 710, 832, 2058, 1419, 2335, 1347, 1211, 659, 821, 1772,
  2017, 2456, 1876, 2015, 957, 1050, 2863, 2912, 2434, 3818, 2434, 1127, 1465, 2961, 3303, 4428,
  3660, 2652, 340,
];

const PLATE_GOOGLE_CLICKS = [
  165, 227, 156, 151, 122, 135, 149, 191, 196, 221, 195, 145, 130, 179, 250, 275, 238, 281, 196,
  167, 211, 336, 294, 314, 229, 198, 150, 210, 426, 387, 396, 392, 347, 252, 266, 484, 498, 426,
  338, 328, 283, 327, 503, 485, 472, 522, 398, 348, 414, 543, 557, 579, 473, 369, 374, 430, 568,
  543, 527, 502, 425, 370, 440, 540, 516, 557, 437, 493, 324, 366, 679, 713, 717, 579, 587, 375,
  448, 1010, 978, 835, 811, 648, 380, 428, 744, 788, 971, 620, 537, 24,
];

const PLATE_BING_CLICKS = [
  96, 57, 73, 147, 189, 162, 137, 112, 59, 106, 170, 166, 185, 190, 137, 103, 120, 246, 233, 235,
  206, 166, 91, 108, 196, 184, 172, 171, 114, 75, 123, 248, 276, 245, 232, 227, 102, 168, 274, 295,
  258, 250, 196, 119, 127, 277, 346, 319, 256, 181, 112, 120, 287, 301, 299, 275, 220, 104, 131,
  302, 309, 323, 297, 223, 140, 132, 369, 311, 320, 320, 274, 121, 151, 363, 366, 364, 366, 298,
  137, 208, 466, 501, 479, 494, 342, 185, 275, 472, 573, 520,
];

/** Sessions and impressions: the last 30 days are the real reported figures;
 * the 60 before them are scaled from users and clicks, exactly as the mockup
 * did — they are shape, and the shape is what this gallery reviews. */
const PLATE_SESSIONS = [
  ...PLATE_USERS.slice(0, 60).map((v) => Math.round(v * 1.32)),
  1293, 911, 1055, 2552, 1901, 2803, 1782, 1520, 838, 1052, 2245, 2613, 3015, 2374, 2430, 1143,
  1285, 3656, 3692, 3179, 4951, 3244, 1432, 1882, 3910, 4319, 5893, 5092, 3468, 418,
];

const PLATE_GOOGLE_IMPRESSIONS = [
  ...PLATE_GOOGLE_CLICKS.slice(0, 60).map((v) => v * 92),
  40462, 42915, 42090, 48537, 44780, 50657, 46680, 49196, 42852, 49049, 60502, 53745, 47876, 40285,
  35097, 31398, 41491, 43232, 47752, 45095, 38258, 36899, 33090, 33021, 31634, 32522, 29250, 26979,
  30405, 3256,
];

const PLATE_BING_IMPRESSIONS = [
  ...PLATE_BING_CLICKS.slice(0, 60).map((v) => v * 34),
  8904, 8851, 9584, 8277, 6175, 6382, 11521, 11521, 11908, 11043, 8820, 7806, 7596, 13896, 11765,
  11387, 12152, 10948, 6941, 8454, 13188, 12754, 11884, 12389, 9312, 5700, 7697, 13458, 14460,
  13011,
];

/** The asset's own nightly self-report — 30 days, so the product strip and the
 * search charts genuinely differ in length the way they do on the real page. */
const PLATE_SIGNUPS = [
  26, 28, 31, 31, 48, 41, 51, 43, 50, 33, 26, 48, 81, 55, 74, 45, 32, 36, 63, 98, 78, 102, 53, 43,
  67, 145, 126, 275, 144, 59,
];

const USERS = plateDays(PLATE_USERS);
const SESSIONS = plateDays(PLATE_SESSIONS);
const GOOGLE_CLICKS = plateDays(PLATE_GOOGLE_CLICKS);
const BING_CLICKS = plateDays(PLATE_BING_CLICKS);
const GOOGLE_IMPRESSIONS = plateDays(PLATE_GOOGLE_IMPRESSIONS);
const BING_IMPRESSIONS = plateDays(PLATE_BING_IMPRESSIONS);
const SIGNUPS = plateDays(PLATE_SIGNUPS, "2026-08-07");

/** The last reported day. Every fixture below anchors on it rather than on
 * `Date.now()`, so the gallery draws the same picture in every capture. */
const PLATE_LAST_DAY = "2026-09-05";

/** The ledger's own grain: three months of net, the newest still open. */
const NET_BY_MONTH: SeriesPoint[] = [
  { t: "2026-06", v: 118 },
  { t: "2026-07", v: 264 },
  { t: "2026-08", v: 436 },
  { t: "2026-09", v: 200 },
];

/**
 * THE SAME LEDGER, SIGNED (bead `ro-78qo.28`). plate.example.com's real months: June
 * spent $224 and earned nothing, July was still $70 under, and August is the
 * first month in the black. A zero-based scale can only draw this by dropping
 * two of the three months under the floor of the plot, which is why the chart
 * takes its bottom from the data whenever a series goes negative.
 */
const NET_BY_MONTH_SIGNED: SeriesPoint[] = [
  { t: "2026-06", v: -224.42 },
  { t: "2026-07", v: -69.87 },
  { t: "2026-08", v: 240.94 },
];

/** The same three months' two sides, so the Financials trio — revenue cyan
 * solid, cost violet dashed, net ink dotted — draws with its legend as the
 * toggles (bead `ro-ujb9.12`). */
const REVENUE_BY_MONTH: SeriesPoint[] = [
  { t: "2026-06", v: 212.18 },
  { t: "2026-07", v: 431.5 },
  { t: "2026-08", v: 402.39 },
];
const COST_BY_MONTH: SeriesPoint[] = REVENUE_BY_MONTH.map((point, index) => ({
  t: point.t,
  v: Math.round((point.v - NET_BY_MONTH_SIGNED[index]!.v) * 100) / 100,
}));

/** A count that only changes when something happens — the step form. */
const OPEN_ALERTS = plateDays(
  Array.from({ length: 90 }, (_, i) => (i < 30 ? 2 : i < 57 ? 3 : i < 86 ? 1 : 0)),
);

const TIMEZONE_MARK: SurfaceAnnotation[] = [
  {
    date: "2026-09-01",
    label: "GA4 reporting timezone changed; the days either side are not the same measurement",
  },
];

/** Which chart the strip is pointing at. */
type SurfaceMetric = "users" | "sessions" | "clicks" | "impressions" | "net" | "alerts";

const SURFACE_METRICS: Record<
  SurfaceMetric,
  {
    label: string;
    title: string;
    series: HeroSeries[];
    format: (value: number) => string;
    variant?: "line" | "monthly" | "step";
  }
> = {
  users: {
    label: "Active users",
    title: "Active users · daily",
    series: [{ name: "GA4", points: USERS, tone: "primary" }],
    format: formatInt,
  },
  sessions: {
    label: "Sessions",
    title: "Sessions · daily",
    series: [{ name: "GA4", points: SESSIONS, tone: "primary" }],
    format: formatInt,
  },
  clicks: {
    label: "Search clicks",
    title: "Search clicks · daily",
    series: [
      { name: "Google", points: GOOGLE_CLICKS, tone: "primary" },
      { name: "Bing", points: BING_CLICKS, tone: "bing" },
    ],
    format: formatInt,
  },
  impressions: {
    label: "Impressions",
    title: "Search impressions · daily",
    series: [
      { name: "Google", points: GOOGLE_IMPRESSIONS, tone: "primary" },
      { name: "Bing", points: BING_IMPRESSIONS, tone: "bing" },
    ],
    format: formatCompact,
  },
  net: {
    label: "Net · Aug",
    title: "Net · by month",
    series: [{ name: "Net", points: NET_BY_MONTH, tone: "primary" }],
    format: (value) => formatUsd(value),
    variant: "monthly",
  },
  alerts: {
    label: "Open alerts",
    title: "Open alerts · daily",
    series: [{ name: "Open", points: OPEN_ALERTS, tone: "warn" }],
    format: formatInt,
    variant: "step",
  },
};

/** The last `range` days of a metric's leading series, as its `Kpi` spark. */
function kpiSpark(metric: SurfaceMetric, range: number): SeriesPoint[] {
  return windowSeries(averageSeries(SURFACE_METRICS[metric].series[0]!.points), range);
}

/** The total the strip prints — the same window the delta compares. */
function windowTotal(metric: SurfaceMetric, range: number): number {
  return windowSeries(SURFACE_METRICS[metric].series[0]!.points, range).reduce(
    (sum, point) => sum + point.v,
    0,
  );
}

/**
 * The fused hero exactly as doc 21's Overview composes it: one `Card`, the
 * strip across the top, the chart the selected KPI chooses underneath, and one
 * range driving every figure on both.
 */
function SurfaceHero({ range }: { range: number }) {
  const [metric, setMetric] = useState<SurfaceMetric>("users");
  const chosen = SURFACE_METRICS[metric];
  const monthly = chosen.variant === "monthly";

  return (
    <Card className="w-full overflow-hidden p-0">
      <KpiStrip columns={6}>
        {(Object.keys(SURFACE_METRICS) as SurfaceMetric[]).map((key) => {
          const one = SURFACE_METRICS[key];
          const isMonthly = one.variant === "monthly";
          const length = isMonthly ? 1 : range;
          const delta = periodDelta(one.series[0]!.points, length, []);
          return (
            <Kpi
              key={key}
              label={one.label}
              value={one.format(
                isMonthly ? one.series[0]!.points.at(-1)!.v : windowTotal(key, range),
              )}
              valueTone={key === "alerts" ? "healthy" : "default"}
              // Doc 21: down is good for open alerts and errors; Net's movement
              // carries no verdict at all and shows its composition instead.
              improvement={key === "alerts" ? "down" : key === "net" ? "none" : "up"}
              delta={key === "alerts" ? null : delta}
              caption={key === "alerts" ? "last one 4d ago" : undefined}
              spark={isMonthly ? one.series[0]!.points : kpiSpark(key, range)}
              format={one.format}
              selected={key === metric}
              onSelect={() => setMetric(key)}
            />
          );
        })}
      </KpiStrip>
      <div className="border-t border-border p-4">
        <HeroChart
          title={chosen.title}
          series={chosen.series}
          range={monthly ? 4 : range}
          variant={chosen.variant}
          format={chosen.format}
          annotations={monthly ? [] : TIMEZONE_MARK}
          provisionalFrom={monthly ? null : PLATE_LAST_DAY}
        />
      </div>
    </Card>
  );
}

/** Doc 21's vocabulary, every state it names, over one real asset's series. */
function SurfaceSections() {
  const [range, setRange] = useState<number>(DEFAULT_RANGE_DAYS);
  const usersDelta = periodDelta(USERS, range);
  const impressionsDelta = periodDelta(GOOGLE_IMPRESSIONS, range);
  const flatDelta = periodDelta(plateDays(Array.from({ length: 60 }, () => 40)), range);
  const straddledDelta = periodDelta(USERS, range, [
    { effectiveOn: "2026-09-01", from: "UTC", to: DEMO_ZONE_EAST },
  ]);

  return (
    <>
      <Section title="Doc 21 · the page's range drives everything under it (RangeSelector)">
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <RangeSelector value={range} onChange={setRange} />
            <span className="text-xs text-muted-foreground">
              Live — every figure, spark and chart in the sections below is derived from this
              one control.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Labeled name="7d">
              <RangeSelector value={7} onChange={() => undefined} />
            </Labeled>
            <Labeled name="28d — the default">
              <RangeSelector value={28} onChange={() => undefined} />
            </Labeled>
            <Labeled name="90d">
              <RangeSelector value={90} onChange={() => undefined} />
            </Labeled>
            <Labeled name="custom options">
              <RangeSelector value={14} onChange={() => undefined} options={[14, 60]} />
            </Labeled>
          </div>
        </div>
      </Section>

      <Section title="FilterBar — filters and sort, one press on a phone">
        <div className="flex w-full flex-col gap-4">
          <Labeled name="one row, one filter on, an aside (narrow the window to see the fold)">
            <FilterBar active={1} className="flex flex-wrap items-center gap-2" aside={<span className="ms-auto text-xs text-muted-foreground">2m ago</span>}>
              <select className={fieldClass} aria-label="Severity" defaultValue="error">
                <option value="all">Any severity</option>
                <option value="error">Errors</option>
              </select>
              <select className={fieldClass} aria-label="Kind" defaultValue="all">
                <option value="all">Any kind</option>
              </select>
            </FilterBar>
          </Labeled>
          <Labeled name="parts: the toggle shares the range's row">
            <FilterFold active={0} label="Filters & sort">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <FilterToggle />
                <RangeSelector value={28} onChange={() => undefined} label="Traffic period" />
              </div>
              <FilterControls className="flex flex-wrap items-center gap-2">
                <select className={fieldClass} aria-label="Sort" defaultValue="seed">
                  <option value="seed">Default order</option>
                </select>
              </FilterControls>
            </FilterFold>
          </Labeled>
        </div>
      </Section>

      <Section title="SectionLabel — the eyebrow every section opens with">
        <div className="flex w-full flex-col gap-5">
          <SectionLabel title="Product use" />
          <SectionLabel
            title="Audience"
            caption="Google Analytics, daily · the bold line is the 7-day average"
          />
          <SectionLabel
            title="Search"
            caption="Google and Bing added, one line each"
            action={{ to: "/dev/kitchen-sink", label: "Queries, pages and the tracked panel →" }}
          />
          {/* The trailing slot as a NODE rather than a link: what sits at the
              end of a Settings or Sources panel header is its owner chip. */}
          <SectionLabel title="Identity" caption="the asset's own row">
            <OwnerChip path="db · assets row" />
          </SectionLabel>
          {/* A disclosure keeps its own control chrome and wraps this header
              (bead `ro-78qo.39`): `SectionLabel` never renders a summary. */}
          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 group-open:rotate-90 motion-safe:transition-transform"
              />
              <SectionLabel title="Tracked queries" caption="29" />
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">…the rows go here.</p>
          </details>
          {/* Home's assets panel: the same eyebrow, given the card's padding by
              its caller rather than growing a variant. */}
          <div className="rounded-[10px] border border-border bg-card">
            <SectionLabel
              title="Assets"
              caption="one row each"
              action={{ to: "/dev/kitchen-sink", label: "All assets →" }}
              className="px-4 pb-2 pt-3"
            />
            <p className="px-4 pb-3 text-xs text-muted-foreground">…the table goes here.</p>
          </div>
        </div>
      </Section>

      <Section title="Doc 21 · KpiStrip fused to HeroChart (the asset Overview's first screen)">
        <SurfaceHero range={range} />
      </Section>

      <Section title="Kpi — every state the strip can be in">
        <KpiStrip columns={4} className="w-full rounded-lg border border-border">
          <Kpi
            label="Active users"
            value={formatInt(windowTotal("users", range))}
            delta={usersDelta}
            spark={kpiSpark("users", range)}
            selected
            onSelect={() => undefined}
          />
          <Kpi
            label="Impressions"
            value={formatCompact(windowTotal("impressions", range))}
            delta={impressionsDelta}
            spark={kpiSpark("impressions", range)}
            format={formatCompact}
            onSelect={() => undefined}
          />
          <Kpi
            label="Signups"
            value={formatInt(1_842)}
            delta={flatDelta}
            spark={SIGNUPS}
          />
          <Kpi
            label="Net · Aug"
            value={formatUsd(436)}
            note="forecast"
            improvement="none"
            delta={null}
            caption="ads $441 · costs $5"
            // A MONTHLY series is not smoothed over seven of anything (bead
            // `ro-78qo.18`): seven periods here is seven MONTHS, and the mean
            // of a six-month ledger is a near-straight line with the only
            // interesting month averaged out of it. The last month is the one
            // still being lived in, so its cap stays hollow.
            spark={NET_BY_MONTH}
            sparkAverage={false}
            sparkProvisionalFrom={NET_BY_MONTH.at(-1)!.t}
            format={(value) => formatUsd(value)}
          />
        </KpiStrip>
        <KpiStrip columns={5} className="w-full rounded-lg border border-border">
          <Kpi
            label="Users · straddled"
            value={formatInt(windowTotal("users", range))}
            delta={straddledDelta}
            spark={kpiSpark("users", range)}
          />
          <Kpi
            label="Open alerts · falling is good"
            value={2}
            valueTone="healthy"
            improvement="down"
            delta={periodDelta(OPEN_ALERTS, range)}
            spark={windowSeries(OPEN_ALERTS, range)}
          />
          <Kpi
            label="Needs you"
            value={24}
            valueTone="warn"
            caption="urgent · 67 more waiting"
            // A COMPOSITION, not a hand-rolled bar. The inbox posture has no
            // history to draw, and what it has instead is how the total
            // divides — so it is the registry's `SegmentBar`, which carries
            // `data-composition` and is therefore the answer the surface audit
            // accepts (bead `ro-78qo.6`).
            footer={
              <SegmentBar
                className="mt-2"
                ariaLabel="24 of 91 waiting on you are urgent"
                segments={[
                  { name: "urgent", value: 24, fill: "bg-warn" },
                  { name: "rest", value: 67, fill: "bg-muted-foreground/30" },
                ]}
              />
            }
          />
          {/* THE THIRD ANSWER: not yet. A payload that keeps no history has
              neither a series nor a composition, and six grey "no series"
              placards in a strip say nothing — so the KPI draws nothing where
              the line would be and declares the gap, on itself, in words. */}
          <Kpi
            label="Ready"
            value={18}
            seriesUnavailable="the task hub keeps no by-day history of the queue"
          />
          {/* Expected reports split into fresh/stale; unconfigured sites stay neutral. */}
          <Kpi
            label="System"
            value={3}
            note="/ 4 fresh"
            valueTone="warn"
            caption="18 jobs"
            footer={
              <SegmentBar
                className="mt-2"
                ariaLabel="3 of 4 assets owing a report sent a fresh one; 1 is stale"
                title="3 fresh · 1 stale · 2 not expected to report"
                segments={[
                  { name: "fresh", value: 3, fill: "bg-healthy" },
                  { name: "stale", value: 1, fill: "bg-warn" },
                  { name: "not-expected", value: 2, fill: "bg-muted-foreground/30" },
                ]}
              />
            }
          />
        </KpiStrip>
      </Section>

      <Section title="HeroChart — interactive desk time-series variants">
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <HeroChart
              title="Active users · daily"
              series={SURFACE_METRICS.users.series}
              range={range}
              height={180}
              provisionalFrom={PLATE_LAST_DAY}
              annotations={TIMEZONE_MARK}
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Search clicks · Google and Bing"
              series={SURFACE_METRICS.clicks.series}
              range={range}
              height={180}
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Net · by month"
              series={SURFACE_METRICS.net.series}
              range={4}
              height={180}
              variant="monthly"
              format={(value) => formatUsd(value)}
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Signed · net by month"
              series={[{ name: "Net", points: NET_BY_MONTH_SIGNED, tone: "primary" }]}
              range={3}
              height={180}
              variant="monthly"
              format={(value) => formatSignedUsd(value)}
              footnote="June and July are real losses; the zero line is where the ledger turns."
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Revenue, cost and net · the key is the toggle"
              series={[
                { name: "Revenue", points: REVENUE_BY_MONTH, tone: "revenue", lineStyle: "solid" },
                { name: "Cost", points: COST_BY_MONTH, tone: "cost", lineStyle: "dashed" },
                { name: "Net", points: NET_BY_MONTH_SIGNED, tone: "primary", lineStyle: "dotted" },
              ]}
              range={3}
              height={180}
              average={false}
              area={false}
              format={(value) => formatSignedUsd(value)}
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Against a reference · same day last week"
              series={[
                { name: "GA4", points: USERS, tone: "primary" },
                { name: "Same day last week", points: USERS.map((point) => ({ t: point.t, v: Math.round(point.v * 0.85) })), provisionalFrom: null, reference: true },
              ]}
              range={range}
              height={180}
              provisionalFrom={PLATE_LAST_DAY}
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Open alerts · daily"
              series={SURFACE_METRICS.alerts.series}
              range={range}
              height={180}
              variant="step"
            />
          </Card>
          <Card className="p-4">
            <HeroChart
              title="Missing days break the line"
              series={[
                {
                  name: "GA4",
                  points: USERS.filter(
                    (point) => point.t < "2026-08-24" || point.t > "2026-08-29",
                  ),
                  tone: "primary",
                },
              ]}
              range={range}
              height={180}
              provisionalFrom={PLATE_LAST_DAY}
            />
          </Card>
          <Card className="p-4">
            <HeroChart title="Nothing reported yet" series={[]} height={180} />
          </Card>
        </div>
      </Section>

      <div id="daily-revenue-examples"><Section title="DailyRevenuePanel — saved earnings, zero and missing reports">
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <DailyRevenuePanel range={7} partialDates={["2026-09-08"]} notesByDate={{ "2026-09-08": "1 of 2 daily sources reported · Missing: Sample asset" }} history={{ from: "2026-09-03", to: "2026-09-09", reportedThrough: "2026-09-08", days: [
            { date: "2026-09-03", amountMinor: 4321 }, { date: "2026-09-04", amountMinor: 0 },
            { date: "2026-09-06", amountMinor: 2810 }, { date: "2026-09-08", amountMinor: 6100 },
          ] }} />
          <DailyRevenuePanel range={7} history={{ from: "2026-09-03", to: "2026-09-09", reportedThrough: null, days: [] }} />
        </div>
      </Section></div>

      <Section title="ChartEventMarkers — each event explains its own date and meaning">
        <div className="grid w-full gap-4 sm:grid-cols-2">
          <Card className="p-4">
            <p className="mb-4 text-sm text-muted-foreground">Single event · hover, focus or tap the marker</p>
            <div className="relative h-16 border-b border-border">
              <ChartEventMarkers events={[{
                date: "2026-09-01", position: 50, label: "Reporting timezone changed", glyph: "▲",
                detail: "The provider switched its daily reporting boundary. This date is not comparable with an ordinary full day.",
              }]} />
            </div>
          </Card>
          <Card className="p-4">
            <p className="mb-4 text-sm text-muted-foreground">Shared marker · both original events stay available</p>
            <div className="relative h-16 border-b border-border">
              <ChartEventMarkers events={[
                { date: "2026-09-02", position: 50, label: "Release published", glyph: "◆", detail: "The revised navigation became available to users." },
                { date: "2026-09-02", position: 50, label: "Review window started", glyph: "◆", detail: "The observation window began; no outcome has been attributed yet." },
              ]} />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="ChartLine / ChartArea / ChartDot — the charts' one language (bead ro-trai.19)">
        <ChartMarksDemo />
      </Section>

      <Section title="MinutePulse — a site's live users minute by minute (bead ro-trai.27)">
        <MinutePulseDemo />
      </Section>

      <Section title="LiveUsers — fresh / stale with its age / failed, last pulse kept / pulse refused / no GA4 (bead ro-trai.27)">
        <LiveUsersDemo />
      </Section>

      <Section title="Sparkline — the three sizes and what a line's colour may mean">
        <div className="flex flex-wrap items-end gap-6">
          <Labeled name="kpi 64×22">
            <Sparkline data={kpiSpark("users", 28)} />
          </Labeled>
          <Labeled name="table cell 96×24">
            <Sparkline data={kpiSpark("users", 28)} size="cell" />
          </Labeled>
          <Labeled name="raw line (average off)">
            <Sparkline data={windowSeries(USERS, 28)} size="cell" average={false} />
          </Labeled>
          <Labeled name="provisional endpoint">
            <Sparkline
              data={windowSeries(USERS, 28)}
              size="cell"
              provisionalFrom={PLATE_LAST_DAY}
            />
          </Labeled>
          <Labeled name="Google">
            <Sparkline data={kpiSpark("clicks", 28)} size="cell" tone="primary" />
          </Labeled>
          <Labeled name="Bing">
            <Sparkline data={windowSeries(BING_CLICKS, 28)} size="cell" tone="bing" />
          </Labeled>
          <Labeled name="up">
            <Sparkline data={kpiSpark("users", 28)} size="cell" tone="positive" />
          </Labeled>
          <Labeled name="down">
            <Sparkline data={kpiSpark("impressions", 28)} size="cell" tone="negative" />
          </Labeled>
          <Labeled name="single point">
            <Sparkline data={[{ t: PLATE_LAST_DAY, v: 12 }]} size="cell" />
          </Labeled>
          {/* A month nobody booked is a HOLE, not a zero and not an absent
              period: the line breaks over it (bead `ro-78qo.37`). */}
          <Labeled name="series with a hole">
            <Sparkline
              data={[
                { t: "2026-04", v: 96 },
                { t: "2026-05", v: 148 },
                { t: "2026-06", v: null },
                { t: "2026-07", v: 121 },
                { t: "2026-08", v: 241 },
              ]}
              size="cell"
              average={false}
            />
          </Labeled>
          {/* The empty state at all three sizes: one dash inside the box the
              size declares, with the reason on its hover (bead `ro-78qo.24`). */}
          <Labeled name="empty · kpi 64×22">
            <Sparkline data={[]} emptyReason="GA4 has reported nothing yet" />
          </Labeled>
          <Labeled name="empty · cell 96×24">
            <Sparkline data={[]} size="cell" emptyReason="GA4 has reported nothing yet" />
          </Labeled>
        </div>
        <div className="w-full">
          <Labeled name="empty · wide">
            <Sparkline
              data={[]}
              size="wide"
              emptyReason="GA4 has reported nothing yet"
              className="w-64"
            />
          </Labeled>
        </div>
        <div className="w-full">
          <Labeled name="wide, filled — the SmallMultiple form">
            <Sparkline data={SIGNUPS} size="wide" area className="w-64" />
          </Labeled>
        </div>
      </Section>

      <Section title="SmallMultiple — the product-use strip (five across, two on a phone)">
        <div className="flex w-full flex-col gap-4">
          <SmallMultipleStrip columns={5}>
            <SmallMultiple label="Signups" value={59} secondary="avg 122 / day" spark={SIGNUPS} />
            <SmallMultiple
              label="Plans saved"
              value={47}
              secondary="avg 90 / day"
              spark={SIGNUPS.map((point) => ({ t: point.t, v: Math.round(point.v * 0.74) }))}
            />
            <SmallMultiple
              label="Recipes saved"
              value={63}
              secondary="avg 104 / day"
              spark={SIGNUPS.map((point) => ({ t: point.t, v: Math.round(point.v * 0.86) }))}
            />
            <SmallMultiple
              label="Leads"
              value={5}
              secondary="avg 9 / day"
              spark={SIGNUPS.map((point) => ({ t: point.t, v: Math.round(point.v * 0.075) }))}
            />
            <SmallMultiple
              label="Feedback"
              value={16}
              secondary="avg 17 / day"
              spark={SIGNUPS.map((point, index) => ({ t: point.t, v: 6 + (index % 7) * 2 }))}
            />
          </SmallMultipleStrip>
          <SmallMultipleStrip columns={6}>
            <SmallMultiple label="Ranking" value={13} secondary="of 28" />
            <SmallMultiple label="Top 10" value={10} />
            <SmallMultiple label="Top 3" value={6} />
            <SmallMultiple label="AI Overview shown" value={17} secondary="of 28" />
            <SmallMultiple label="Cites us" value={5} secondary="of 17" />
            <SmallMultiple label="Best move" value="high fiber cereals" secondary="#12 → top 10" />
          </SmallMultipleStrip>
        </div>
      </Section>

      <Section title="ListPanel — three rows, an expander for the rest, evidence in place">
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <ListPanel
            title="Needs you"
            count="10 urgent · 67 open"
            action={{ label: "All tasks", to: "/work" }}
          >
            <ListRow
              tone="error"
              title="Move every recurring charge off the closing card"
              caption="Cloudflare, Clerk, Resend and Google first"
              value="3d"
              valueLabel="open"
            />
            <ListRow
              tone="error"
              title="File the dissolution before Sept 10"
              caption="consent, Delaware, wire out, IRS Form 966"
              value="3d"
              valueLabel="open"
            />
            <ListRow
              tone="warn"
              title="Apply to the ad network on Sept 18, when the domain turns six months old"
              caption="check the current network's exit terms first"
              value="13d"
              valueLabel="due"
            />
            <ListRow
              tone="info"
              title="Reconcile August's ad revenue against the payout"
              caption="the statement lands on the 20th"
              value="15d"
              valueLabel="due"
            />
            <ListRow
              tone="info"
              title="Renew the certificate on the staging host"
              caption="expires in five weeks"
              value="35d"
              valueLabel="due"
            />
          </ListPanel>

          <ListPanel
            title="What matters"
            count="8 findings · Jul 12 – Aug 31"
            action={{ label: "All findings", onClick: () => undefined }}
          >
            <ListRow
              tone="error"
              glyph="△"
              title="11.3% of sessions are unattributed"
              caption="Warning · high confidence"
              value={formatInt(8208)}
              valueLabel="sessions"
              defaultExpanded
              rowActions={<Button size="sm" variant="outline">File task</Button>}
              actions={
                <Button size="sm" variant="ghost">
                  Watch outcome
                </Button>
              }
            >
              GA4 reports them as Unassigned. Past 10%, every channel, landing-page and campaign
              split inherits that uncertainty, so this bounds how far the other findings can be
              trusted.
            </ListRow>
            <ListRow
              tone="error"
              glyph="△"
              title="JavaScript errors concentrate on one calculator page"
              caption="Warning · high confidence"
              value={formatInt(6279)}
              valueLabel="errors"
              rowActions={<Button size="sm" variant="outline">File task</Button>}
            />
            <ListRow
              tone="warn"
              glyph="↗"
              title="Move “high fiber cereals” up from #12"
              caption="Recommendation · 40,500 searches / month"
              value="#12"
              valueLabel="rank"
            />
          </ListPanel>

          {/* Decisions on the row (bead ro-ujb9.96.7.11): Approve on a gate,
              Answer and Dismiss on an ask, and the answer box Answer opens. */}
          <ListPanel title="Waiting on you" count="2 asks · 1 gate">
            <ListRow
              tone="warn"
              glyph="△"
              title="Approve the launch ad spend"
              caption="Plate · mp-gate"
              value="2h"
              valueLabel="waiting"
              rowActions={<Button size="sm">Approve</Button>}
            >
              Spend $40 on the launch ads.
            </ListRow>
            <ListRow
              tone="warn"
              title="Decide the Korea trip"
              caption="Plate · mp-9k1"
              value="1d"
              valueLabel="waiting"
              rowActions={
                <>
                  <Button size="sm" variant="outline" aria-expanded>Answer</Button>
                  <Button size="sm" variant="ghost" className="text-muted-foreground">Dismiss</Button>
                </>
              }
              below={
                <div className="flex items-start gap-2 pb-2 pe-2 ps-9 max-sm:flex-wrap">
                  <textarea rows={1} aria-label="Your answer (demo)" placeholder="Your answer" className={cn(fieldClass, "min-h-9 w-full flex-1 max-sm:basis-full")} />
                  <Button size="sm" disabled>Send</Button>
                  <Button size="sm" variant="ghost">Cancel</Button>
                </div>
              }
            />
          </ListPanel>

          <ListPanel title="All clear" count="0 open">
            <ListRow tone="ok" title="Every source answered this morning" caption="7 of 7 fresh" />
          </ListPanel>

          {/* The row action as a source Connect (bead ro-ujb9.96.7.5): a new asset's Data
              sources, each still-unconnected source pressed straight to its
              connect panel without opening the row; the first is the primary. */}
          <ListPanel title="Data sources" count="0 of 3 working" limit={3}>
            <ListRow
              title="Bing Webmaster Tools"
              rowActions={<Button asChild size="sm"><a href="#connect-bing">Connect</a></Button>}
              rowActionsInline
            >
              The mapping stays inside the row.
            </ListRow>
            <ListRow
              title="Google Analytics"
              rowActions={<Button asChild size="sm" variant="outline"><a href="#connect-google">Connect</a></Button>}
              rowActionsInline
            />
            <ListRow tone="info" title="Microsoft Clarity" value="Not using" />
          </ListPanel>

          {/* Grouped by subject (bead ro-ujb9.96.6.5): the page is the heading,
              said once; closed, the worst row of each of the three worst pages. */}
          <ListPanel
            title="Where it breaks"
            count="6 found"
            groups={[
              {
                key: "calculator",
                title: "/calculator",
                count: "3 found",
                rows: [
                  <ListRow key="speed" tone="error" glyph="△" title="Chrome OS Desktop" caption="Speed · poor" value="744 ms" valueLabel="INP p75" />,
                  <ListRow key="rage" tone="warn" glyph="△" title="heightFeet input" caption="Rage clicks · 1,493 of 18,826 visitors" value="7.9%" valueLabel="of visitors" />,
                  <ListRow key="error" tone="warn" glyph="△" title="TypeError: x is undefined" caption="Error · 1,900 times" value="264" valueLabel="people" />,
                ],
              },
              {
                key: "home",
                title: "/",
                count: "1 found",
                rows: [<ListRow key="error" tone="warn" glyph="△" title="Error: Script error." caption="Error · 5,000 times" value="1,438" valueLabel="people" />],
              },
              {
                key: "site",
                title: "Whole site",
                count: "1 found",
                rows: [<ListRow key="once" tone="warn" glyph="△" title="first_meal_logged fires 3.0× per person" caption="Named to happen once" value="3.0×" valueLabel="per person" />],
              },
              {
                key: "third-party",
                title: "Probably third-party",
                count: "1 found",
                rows: [<ListRow key="noise" tone="info" glyph="◦" title="TypeError: Load failed" caption="40,975 of 48,640 errors" value="84%" valueLabel="of errors" />],
              },
            ]}
          />

          <ListPanel title="Nothing waiting" empty="No open work on this asset." />
          <ListPanel title="Navigation" count="1 destination">
            <ListRow
              tone="info"
              title="Review the portfolio’s assets and their data connections"
              caption="Arrow opens a page; a chevron expands evidence in place."
              to="/assets"
              value={0}
              valueLabel="open errors"
            />
          </ListPanel>
        </div>
      </Section>

      <Section title="StatusBanner — only while its state is open">
        <div className="flex w-full flex-col gap-3">
          <StatusBanner
            subject="demo:banner-setting-up"
            lead="Setting up"
            ring={{ done: 3, total: 4, title: "3 of 4 setup steps done" }}
            action={{ label: "Finish in Sources", to: "/assets" }}
          >
            3 of 4 steps done. Clarity and uptime monitoring still need a source.
          </StatusBanner>
          <StatusBanner
            subject="demo:banner-automation-paused"
            lead="Automation paused"
            severity="warn"
            action={{ label: "Review", onClick: () => undefined }}
          >
            Nothing has been applied since Sept 2 while the budget question is open.
          </StatusBanner>
          <StatusBanner lead="Reported 14h ago" subject="demo:banner-reported" severity={null} />
          <StatusBanner open={false} lead="Closed" subject="demo:banner-closed">
            This state has closed, so the banner renders nothing at all.
          </StatusBanner>
          <span className="text-xs text-muted-foreground">
            The fourth banner above is closed and draws nothing — that is the state.
          </span>
        </div>
      </Section>

      <Section title="ProductJourney — what people do once they arrive, and where it breaks (PostHog)">
        <ProductJourneyDemos />
      </Section>

      <Section title="About — the one disclosure per screen that holds the prose">
        <div className="flex w-full flex-col gap-4">
          <About>
            <p className="m-0">
              Active users and sessions are GA4&rsquo;s daily counts in the asset&rsquo;s
              reporting timezone. Search clicks and impressions come from Search Console and Bing
              Webmaster Tools, one line each.
            </p>
            <p className="m-0">
              Net is this month&rsquo;s ledger: ad revenue booked or forecast, minus metered
              costs. Product use is the asset&rsquo;s own nightly report. A day the provider is
              still processing is marked provisional.
            </p>
          </About>
          <About title="About this comparison" defaultOpen>
            <p className="m-0">
              Every delta compares the chosen range with the same length of time immediately
              before it. When a reporting timezone changed inside that window the two sides are
              not the same measurement, so the figure stays and the colour is withdrawn.
            </p>
          </About>
        </div>
      </Section>
    </>
  );
}

/** The product block `scripts/signal-insights.mjs` emits for the PostHog
 * acceptance read (plate.example.com, 2026-09-08 → 09-22), run through the same
 * parser the asset payload uses. `scripts/posthog-panel.test.mjs` fails when the
 * producer's output and this file drift apart. */
const POSTHOG_PRODUCT: ProductSnapshot = parseProductSnapshot(posthogProductJson)!;

/** A read too thin to judge: every rule states which floor it missed. */
const POSTHOG_THIN: ProductSnapshot = {
  ...POSTHOG_PRODUCT,
  funnels: [],
  vitals: POSTHOG_PRODUCT.vitals ? { ...POSTHOG_PRODUCT.vitals, segments: [], unmeasuredSegments: 6 } : null,
  rageClicks: POSTHOG_PRODUCT.rageClicks ? { ...POSTHOG_PRODUCT.rageClicks, clusters: [] } : null,
  exceptions: null,
  onceEvents: [],
  checks: [
    { key: "posthog-slow-segment", label: "Real-visitor speed", state: "not-enough-data", detail: "No device and system segment on a top page reached 500 measurements." },
    { key: "posthog-rage-click-cluster", label: "Rage clicks", state: "clear", detail: "No element drew rage clicks from more than 5% of its page’s visitors." },
    { key: "posthog-error-concentration", label: "Errors", state: "not-enough-data", detail: "42 exceptions in the window; the rule needs 100." },
    { key: "posthog-funnel-drop", label: "Funnels", state: "not-collected", detail: "No PostHog funnel read has been collected yet." },
    { key: "posthog-once-event-repeats", label: "Once-only events", state: "clear", detail: "No event named first_* or *_created was captured in this window." },
  ],
};

/** Three funnels: the expander, and one with no earlier week to compare. */
const POSTHOG_FUNNELS: ProductSnapshot = (() => {
  const [calculator] = POSTHOG_PRODUCT.funnels;
  const extra: ProductFunnel[] = calculator
    ? [
        {
          ...calculator,
          id: "signup",
          name: "Account signup",
          steps: [
            { step: 1, event: "$pageview", path: "/signup", people: 4_210 },
            { step: 2, event: "signup_started", path: null, people: 2_980 },
            { step: 3, event: "account_created", path: null, people: 1_190 },
          ],
          conversion: 1_190 / 4_210,
          largestDrop: { fromStep: 2, toStep: 3, lostPeople: 1_790, stepConversion: 1_190 / 2_980 },
          prior: null,
        },
        {
          ...calculator,
          id: "recipe",
          name: "Recipe save",
          steps: [
            { step: 1, event: "$pageview", path: "/recipes", people: 9_800 },
            { step: 2, event: "recipe_saved", path: null, people: 610 },
          ],
          conversion: 610 / 9_800,
          largestDrop: { fromStep: 1, toStep: 2, lostPeople: 9_190, stepConversion: 610 / 9_800 },
        },
      ]
    : [];
  return { ...POSTHOG_PRODUCT, funnels: [...POSTHOG_PRODUCT.funnels, ...extra] };
})();

function ProductJourneyDemos() {
  return (
    <div className="flex w-full flex-col gap-8">
      <ProductDemo name="the acceptance read (plate.example.com, Sep 8–22) — every rule fired">
        <ProductJourney product={POSTHOG_PRODUCT} connection="connected" className="w-full" />
      </ProductDemo>
      <ProductDemo name="a thin read — each rule names the floor it missed">
        <ProductJourney product={POSTHOG_THIN} connection="connected" className="w-full" />
      </ProductDemo>
      <ProductDemo name="three funnels, one with no earlier week">
        <ProductJourney product={POSTHOG_FUNNELS} connection="connected" className="w-full" />
      </ProductDemo>
      <ProductDemo name="no product block: connected, not collected yet · not connected · not collected for this asset">
        <div className="flex w-full flex-col gap-3">
          <ProductJourney product={null} connection="connected" />
          <ProductJourney product={null} connection="not-connected" />
          <ProductJourney product={null} connection="off" />
        </div>
      </ProductDemo>
    </div>
  );
}

/** A full-width caption above one ProductJourney state (`Labeled` centres and
 * shrinks its child, and this section is a page-width surface). */
function ProductDemo({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <span className="text-xs text-muted-foreground">{name}</span>
      {children}
    </div>
  );
}

function Labeled({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      {children}
      <span className="text-xs text-muted-foreground">{name}</span>
    </div>
  );
}

/** One demo box per mark, in a stretched 1000×100 viewBox as the Wall draws
 * them: the line over its wash with a live now point, a comparison ghost, a
 * projection, a line cased over bars, and the dot's forms. */
function ChartMarksDemo() {
  const hours = [4, 3, 3, 5, 12, 30, 52, 70, 64];
  const lastWeek = [5, 4, 4, 6, 14, 36, 64, 78, 80, 70, 66, 70, 52, 48, 40, 36, 26, 28, 22, 18, 15, 12, 8, 9];
  const at = (index: number, value: number, of: number) => ({ x: 20 + (index / (of - 1)) * 960, y: 100 - value });
  const today = hours.map((value, index) => at(index, value, 24));
  const ghost = lastWeek.map((value, index) => at(index, value, 24));
  const pace = [20, 34, 41, 55, 60, 72].map((value, index) => at(index, value, 10));
  const ahead = [pace.at(-1)!, ...[78, 83, 88, 92].map((value, index) => at(index + 6, value, 10))];
  const box = (children: ReactNode) => (
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="h-24 w-72 overflow-visible" aria-hidden>
      {children}
    </svg>
  );
  return (
    <div className="flex flex-wrap items-end gap-8">
      <Labeled name="line · wash feathered at now · live dot">
        <span className="text-trend-negative">
          {box(
            <>
              <ChartLine runs={[ghost]} kind="ghost" width={2.5} />
              <ChartArea runs={[today]} baseline={100} strength={0.38} fadeEnd={0.22} />
              <ChartLine runs={[today]} width={4} />
              <ChartDot at={today.at(-1)!} size="lg" live />
            </>,
          )}
        </span>
      </Labeled>
      <Labeled name="solid · projection · halo">
        <span className="text-financial-revenue">
          {box(
            <>
              <ChartArea runs={[pace]} baseline={100} strength={0.4} fadeEnd={0.1} />
              <ChartLine runs={[ahead]} kind="projection" width={3} />
              <ChartLine runs={[pace]} width={4} />
              <ChartDot at={pace.at(-1)!} size="lg" />
            </>,
          )}
        </span>
      </Labeled>
      <Labeled name="traffic line · dot md · hollow sm">
        <span className="text-traffic">
          {box(
            <>
              <ChartLine runs={[ghost.map((point) => ({ ...point, y: point.y - 10 }))]} width={2.5} />
              <ChartDot at={{ x: ghost.at(-1)!.x, y: ghost.at(-1)!.y - 10 }} size="md" halo={false} />
              <ChartDot at={{ x: 500, y: 90 }} size="sm" hollow />
            </>,
          )}
        </span>
      </Labeled>
    </div>
  );
}

/** The pulse's three kinds of minute and its sizes: a climbing half hour, the
 * same reading dimmed, a quiet one (ticks on the floor), one whose newest
 * minutes were never read, and the roomier and one-site sizes. */
function MinutePulseDemo() {
  const climbing = Array.from({ length: 30 }, (_, minute) => Math.round(20 + minute * 1.6 + Math.sin(minute * 1.3) * 6));
  const quiet = Array.from({ length: 30 }, (_, minute) => (minute % 7 === 3 ? 1 : 0));
  const unread = [...climbing.slice(4), null, null, null, null];
  return (
    <div className="wall-root flex flex-wrap items-end gap-8 rounded-lg bg-background p-4">
      <Labeled name="row · live">
        <MinutePulse minutes={climbing} />
      </Labeled>
      <Labeled name="row · dimmed">
        <MinutePulse minutes={climbing} dimmed />
      </Labeled>
      <Labeled name="quiet minutes">
        <MinutePulse minutes={quiet} />
      </Labeled>
      <Labeled name="four unread minutes">
        <MinutePulse minutes={unread} dimmed />
      </Labeled>
      <Labeled name="roomy">
        <MinutePulse minutes={climbing} size="roomy" />
      </Labeled>
      <Labeled name="focus">
        <MinutePulse minutes={climbing} size="focus" />
      </Labeled>
    </div>
  );
}

/** A live cell whose next read is refused: it keeps the pulse it drew. */
function LiveUsersFailedLater() {
  const [snapshot, setSnapshot] = useState<Ga4RealtimeAsset>(realtimeLive);
  useEffect(() => {
    setSnapshot({ ...realtimeError, asset: realtimeLive.asset, observedAt: iso(20_000), nextAttemptAt: new Date(NOW + 4 * 60_000).toISOString() });
  }, []);
  return <LiveUsers asset={cardLive} snapshot={snapshot} reconnecting={false} nowMs={NOW + 4 * 60_000} cell={false} />;
}

function LiveUsersDemo() {
  const stale: Ga4RealtimeAsset = { ...realtimeLive, observedAt: iso(6 * 60_000) };
  const refused: Ga4RealtimeAsset | undefined = realtimeLive.status === "success" ? { ...realtimeLive, activeUsersByMinute: null } : undefined;
  const noGa4 = { ...cardLive, dataSources: cardLive.dataSources.filter((source) => source.id !== "ga4") };
  return (
    <div className="wall-root flex flex-wrap items-start gap-10 rounded-lg bg-background p-4">
      <Labeled name="fresh">
        <LiveUsers asset={cardLive} snapshot={realtimeLive} reconnecting={false} nowMs={NOW} cell={false} />
      </Labeled>
      <Labeled name="stale, with its age">
        <LiveUsers asset={cardLive} snapshot={stale} reconnecting={false} nowMs={NOW} cell={false} />
      </Labeled>
      <Labeled name="failed, last pulse kept">
        <LiveUsersFailedLater />
      </Labeled>
      <Labeled name="pulse refused">
        <LiveUsers asset={cardLive} snapshot={refused} reconnecting={false} nowMs={NOW} cell={false} />
      </Labeled>
      <Labeled name="no GA4">
        <LiveUsers asset={noGa4} snapshot={realtimeLive} reconnecting={false} nowMs={NOW} cell={false} />
      </Labeled>
      <Labeled name="one-site tile">
        <LiveUsers asset={cardLive} snapshot={realtimeLive} reconnecting={false} nowMs={NOW} cell={false} face="text-wall-hero-sm" size="focus" />
      </Labeled>
    </div>
  );
}

export default KitchenSinkRoute;
