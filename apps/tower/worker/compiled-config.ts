// The settings this bundle was compiled with, injected by vite.config.ts (and
// by apps/tower/e2e/fixtures.ts `INJECTED`). They are the fallback, not the
// source: `config-source.ts` resolves each setting from the store per request
// and answers with these only when the store holds no document, so a Worker
// with an empty or unreachable store can still render the page that fixes it.

import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import type {
  Ga4EventParamsConfig,
  PullConfigEntry,
  SerpPanelConfig,
  SignalPanelsConfig,
  ValueEventsConfig,
} from "./asset-config";
import type { TowerConfigFallbacks } from "./config-source";
import type { CountersConfig } from "./counters";
import type { EntityRow } from "../shared/entities";
import type { IntegrationsConfig } from "../shared/integrations";
import type { DashboardConfig } from "../shared/dashboard";
import type { BeadsConfig } from "../shared/settings";
import type { DomainOrder, RecurringCost } from "../shared/financials";

declare const __MONTHLY_CAPS__: { dataUsd: number };
declare const __FLAG_DEFAULTS__: Record<string, number | string>;
declare const __PULL_CONFIG__: PullConfigEntry[];
declare const __OPERATOR_RATE__: number;
declare const __NO_NIGHTLY_REPORT__: string[] | null;
declare const __SCHEDULES__: ScheduleOverrides | null;
declare const __INTEGRATIONS__: IntegrationsConfig;
declare const __COUNTERS__: CountersConfig;
declare const __DASHBOARD__: DashboardConfig;
declare const __OS_TIME_ZONE__: string;
declare const __SERP_PANEL__: SerpPanelConfig;
declare const __SIGNAL_PANELS__: SignalPanelsConfig;
// The GA4 lane's two per-asset declarations, edited on an asset's Sources tab.
declare const __VALUE_EVENTS__: ValueEventsConfig;
declare const __GA4_EVENT_PARAMS__: Ga4EventParamsConfig;
declare const __DOMAIN_COSTS__: DomainOrder[];
declare const __RECURRING_COSTS__: RecurringCost[];
// Which legal entity owns which assets (config/entities.json).
declare const __ENTITIES__: EntityRow[];
// config/beads.json, spokes only — the hub connection never leaves this machine.
declare const __BEADS__: BeadsConfig;

/**
 * The compiled config, gathered once so `config-source.ts` never touches a
 * `define` and a test can hand it a whole configuration without a bundler.
 *
 * `__BEADS__` already carries `hub: null` in a build (vite.config.ts strips this
 * machine's internal topology out of a deployed bundle), and the resolver keeps
 * that answer rather than taking a hub out of a stored document.
 */
export function compiledConfig(): TowerConfigFallbacks {
  return {
    monthlyCaps: __MONTHLY_CAPS__,
    flagDefaults: __FLAG_DEFAULTS__,
    operatorRateUsdPerMin: __OPERATOR_RATE__,
    osTimeZone: __OS_TIME_ZONE__,
    noNightlyReport: __NO_NIGHTLY_REPORT__,
    schedules: __SCHEDULES__,
    pullConfig: __PULL_CONFIG__,
    integrations: __INTEGRATIONS__,
    counters: __COUNTERS__,
    dashboard: __DASHBOARD__,
    serpPanel: __SERP_PANEL__,
    signalPanels: __SIGNAL_PANELS__,
    valueEvents: __VALUE_EVENTS__,
    ga4EventParams: __GA4_EVENT_PARAMS__,
    domainOrders: __DOMAIN_COSTS__,
    recurringCosts: __RECURRING_COSTS__,
    entities: __ENTITIES__,
    beads: __BEADS__,
  };
}
