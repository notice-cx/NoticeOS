import type { IntegrationProviderId } from './integrations.js';

/** Monitoring inventory, not a claim that every adapter is already installed.
 * Scheduled evidence is already durable. Other coverage gaps stay explicit
 * until the recorder described in docs/24 is connected (ro-klom). */
export interface IntegrationMonitorDefinition {
  id: string;
  label: string;
  lanes: readonly string[];
  owner: string;
  scope: 'property' | 'family' | 'feed' | 'account' | 'delivery';
  /** When the work runs. What it runs on is the monitor's comment below, not
   * payload text: nothing on screen reads it (bead ro-ujb9.96.6.2). */
  trigger: 'scheduled' | 'demand' | 'event' | 'setup';
  evidence: 'signal_runs' | 'signal_dump_runs' | 'mediavine_runs' | 'live-only' | 'success-only' | 'setup-only';
  action: string;
}
const monitor = (id: string, label: string, lanes: readonly string[], owner: string, scope: IntegrationMonitorDefinition['scope'], trigger: IntegrationMonitorDefinition['trigger'], evidence: IntegrationMonitorDefinition['evidence'], action: string): IntegrationMonitorDefinition =>
  ({ id, label, lanes, owner: `workers/ingest/src/${owner}.ts`, scope, trigger, evidence, action });

/** Adding a connected provider requires a monitoring decision at compile time. */
export const INTEGRATION_MONITORS = {
  cloudflare: [monitor('cloudflare-test', 'D1 account access', [], 'cloudflare-d1-client', 'account', 'event', 'live-only', 'Review the Cloudflare account and D1 token permissions.')],
  google: [
    // Saved Google collection schedule.
    monitor('ga4-daily', 'Analytics daily reports', ['ga4'], 'google-signals', 'property', 'scheduled', 'signal_runs', 'Review the property connection or the failed collection.'),
    // Saved Google collection schedule.
    monitor('gsc-daily', 'Search Console daily reports', ['gsc'], 'google-signals', 'property', 'scheduled', 'signal_runs', 'Review the Search Console property connection.'),
    // Shared 30-second reads while a display is visible; refusal cooldown applies.
    monitor('ga4-realtime', 'Live active users', ['ga4'], 'ga4-realtime', 'property', 'demand', 'live-only', 'Wait for the displayed retry, or review Google access when requested.'),
    // Shared 15-minute reads while a display is visible; refusal cooldown applies.
    monitor('ga4-hourly', 'Hourly traffic comparison', ['ga4'], 'ga4-realtime', 'property', 'demand', 'live-only', 'Review the hourly report failure; live counts can keep working.'),
    // One obligation per due family and report date from the collector plan.
    monitor('ga4-archive', 'Analytics report archive', ['ga4'], 'signal-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review the failed report family and its quota or access guidance.'),
    // One obligation per due family and report date from the collector plan.
    monitor('gsc-archive', 'Search Console report archive', ['gsc'], 'signal-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review the failed Search Console report family.'),
    // Explicit property discovery only.
    monitor('google-discovery', 'Google property discovery', ['ga4', 'gsc'], 'credential-probes', 'account', 'event', 'live-only', 'Review the connected account and its property permissions.'),
    // Explicit connection test; never clears a reporting failure.
    monitor('google-test', 'Google connection test', [], 'credential-probes', 'account', 'event', 'live-only', 'Review the account and property permissions shown by the test.'),
  ],
  // Local shape validation; never proof of remote access.
  'google-oauth-app': [monitor('google-app-setup', 'Google sign-in setup', [], 'credential-probes', 'account', 'setup', 'setup-only', 'Complete Google sign-in in Integrations.')],
  'bing-webmaster': [
    // Saved Bing collection schedule.
    monitor('bing-daily', 'Bing daily reports', ['bing-webmaster'], 'bing-signals', 'property', 'scheduled', 'signal_runs', 'Review the verified site and Bing connection.'),
    // Each family’s existing daily or weekly obligation.
    monitor('bing-archive', 'Bing report archive', ['bing-webmaster'], 'signal-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review the failed report family; delayed reporting is separate from request failure.'),
    // Explicit connection test only.
    monitor('bing-discovery', 'Bing site discovery', ['bing-webmaster'], 'credential-probes', 'account', 'event', 'live-only', 'Review Bing site verification in Integrations.'),
  ],
  mediavine: [
    // Existing daily target and bounded retry plan in mediavine_state.
    monitor('mediavine-revenue', 'Daily ad revenue', ['ad-network'], 'mediavine', 'property', 'scheduled', 'mediavine_runs', 'Review missing report dates; reconnect if the session is blocked.'),
    // Explicit site discovery with existing 15-minute cache/cooldown.
    monitor('mediavine-discovery', 'Ad revenue site discovery', ['ad-network'], 'mediavine-connection', 'account', 'event', 'live-only', 'Review the publisher connection and permitted sites.'),
    // Explicit connection test; never clears a revenue report failure.
    monitor('mediavine-test', 'Mediavine connection test', [], 'mediavine-connection', 'account', 'event', 'live-only', 'Review the publisher connection and permitted sites.'),
  ],
  dataforseo: [
    // Each applicable family’s collector plan, including tracked terms and device scope.
    monitor('dataforseo-research', 'Search intelligence', ['dataforseo'], 'dataforseo-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review the failed report and recorded budget or credit reason.'),
    // Existing credit check after a successful sweep or explicit test.
    monitor('dataforseo-credit', 'Search data credit', ['dataforseo'], 'dataforseo-balance', 'account', 'event', 'live-only', 'Review the dated credit balance in Integrations.'),
    // Explicit connection test; never clears a research report failure.
    monitor('dataforseo-test', 'Search data connection test', [], 'credential-probes', 'account', 'event', 'live-only', 'Review the Search data connection in Integrations.'),
  ],
  clarity: [
    // Existing export schedule and project request cap.
    monitor('clarity-export', 'Behavior reports', ['clarity'], 'clarity-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review this asset’s Clarity project connection.'),
    // Local shape check only; does not spend an export request.
    monitor('clarity-setup', 'Clarity connection setup', [], 'credential-probes', 'account', 'setup', 'setup-only', 'Wait for a successful export to confirm that the connection works.'),
  ],
  posthog: [
    // One attempt per family per asset on the daily product analytics schedule; a family PostHog’s hourly allowance stopped is recorded as skipped.
    monitor('posthog-archive', 'Product analytics reports', ['posthog'], 'posthog-dumps', 'family', 'scheduled', 'signal_dump_runs', 'Review this asset’s PostHog key, region and project.'),
    // Explicit connection test; reads each asset’s project settings and never clears a report failure.
    monitor('posthog-test', 'PostHog connection test', [], 'credential-probes', 'account', 'event', 'live-only', 'Review the PostHog keys and each asset’s region and project.'),
  ],
  calendar: [
    // Existing five-minute feed cache while the calendar is requested.
    monitor('calendar-feed', 'Upcoming meetings', [], 'calendar', 'feed', 'demand', 'live-only', 'Review the named calendar feed in Integrations.'),
    // Explicit bounded GET/content check; does not prove parsed event availability.
    monitor('calendar-test', 'Calendar connection test', [], 'credential-probes', 'account', 'event', 'live-only', 'Review the calendar address and access settings.'),
  ],
  discord: [
    // Only when a real notification is requested; silence is not an outage.
    monitor('discord-delivery', 'Alert delivery', ['discord-webhooks'], 'notifier', 'delivery', 'event', 'success-only', 'Review the Discord destination and the failed delivery.'),
    // Explicit test message only; never clears a failed alert delivery.
    monitor('discord-test', 'Discord connection test', [], 'credential-probes', 'delivery', 'event', 'live-only', 'Review the test destination in Integrations.'),
  ],
} satisfies Record<IntegrationProviderId, readonly IntegrationMonitorDefinition[]>;

/** Why a catalog lane has no automatic attempt monitor: nothing collects it
 * yet (`no-collector`), or the OS sees only what arrives, never what an
 * upstream sender failed to send (`receipt-only`, deploy annotations). A code
 * the item carries, not a sentence (bead ro-ujb9.96.6.2). */
export type IntegrationMonitoringGap = 'no-collector' | 'receipt-only';

/** Catalog entries with no complete automatic health evidence must be visible
 * as monitoring gaps when enabled, never promoted by a manual “live” setting. */
export const INTEGRATION_MONITORING_GAPS: Readonly<Record<string, IntegrationMonitoringGap>> = {
  uptime: 'no-collector',
  'affiliate-cj': 'no-collector',
  'affiliate-amazon': 'no-collector',
  'deploy-annotations': 'receipt-only',
  'github-app': 'no-collector',
};

export type IntegrationFailureKind = 'access' | 'rate-limit' | 'budget' | 'network' | 'provider' | 'invalid-report' | 'incomplete-report' | 'configuration' | 'monitoring';
export interface IntegrationHealthScope {
  workspace: string;
  provider: string;
  /** Opaque connection revision, never a token, address or credential hash. */
  connection: string;
  capability: string;
  asset: string;
  /** Opaque property/feed identifier; never a private calendar or webhook URL. */
  target: string;
  family: string;
}
export interface IntegrationObservation {
  scope: IntegrationHealthScope;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'failure';
  failure: IntegrationFailureKind | null;
  /** Registry-owned safe code, not provider error prose. */
  code: string | null;
  nextAttemptAt: string | null;
}
export type IntegrationHealthState = 'healthy' | 'failing' | 'stale' | 'never-run' | 'idle' | 'paused' | 'disconnected' | 'unmonitored' | 'unknown';
export interface IntegrationCapabilityHealth {
  scope: IntegrationHealthScope;
  state: IntegrationHealthState;
  latest: IntegrationObservation | null;
  lastSuccessAt: string | null;
}
export function integrationScopeKey(scope: IntegrationHealthScope): string {
  return JSON.stringify([scope.workspace, scope.provider, scope.connection, scope.capability, scope.asset, scope.target, scope.family]);
}

/** Pure projection used by all surfaces once adapters are connected. The
 * obligation owner supplies dueAt; this adds no measurement thresholds. */
export function integrationCapabilityHealth(input: {
  scope: IntegrationHealthScope;
  connection: 'connected' | 'paused' | 'disconnected';
  covered: boolean;
  observerAvailable: boolean;
  trigger: IntegrationMonitorDefinition['trigger'];
  observations: readonly IntegrationObservation[];
  /** Latest attempt must satisfy this obligation, or it is stale. */
  requiredSince: string | null;
  nowMs: number;
}): IntegrationCapabilityHealth {
  const relevant = input.observations.filter((item) => integrationScopeKey(item.scope) === integrationScopeKey(input.scope));
  const valid = relevant.filter((item) => Number.isFinite(Date.parse(item.startedAt)) && Number.isFinite(Date.parse(item.finishedAt)) && Date.parse(item.finishedAt) >= Date.parse(item.startedAt) && Date.parse(item.finishedAt) <= input.nowMs);
  // A delayed old success never clears a newer-started failure. In a clock
  // tie, failure wins conservatively until a later success is recorded.
  valid.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || Number(b.outcome === 'failure') - Number(a.outcome === 'failure'));
  const latest = valid[0] ?? null;
  const lastSuccessAt = valid.find((item) => item.outcome === 'success')?.finishedAt ?? null;
  const state: IntegrationHealthState = input.connection !== 'connected' ? input.connection
    : !input.covered ? 'unmonitored'
      : !input.observerAvailable || valid.length !== relevant.length ? 'unknown'
        : latest?.outcome === 'failure' ? 'failing'
          : !latest ? (input.trigger === 'event' || input.trigger === 'setup') && input.requiredSince === null ? 'idle' : 'never-run'
            : input.requiredSince !== null && (!Number.isFinite(Date.parse(input.requiredSince)) || Date.parse(latest.startedAt) < Date.parse(input.requiredSince)) ? 'stale'
              : input.requiredSince === null && input.trigger !== 'scheduled' ? 'idle' : 'healthy';
  return { scope: input.scope, state, latest, lastSuccessAt };
}

/** Existing display cadences, shared with the Wall; this adds no new threshold. */
export const INTEGRATION_CADENCE_HOURS = { signals: 0.25, bingSignals: 24, dataforseoSignals: 24 * 7, posthogSignals: 24 } as const;
export interface IntegrationHealthItem {
  id: string;
  provider: string;
  capability: string;
  label: string;
  asset: string | null;
  /** Display text only: what the row says about this work. Never parsed —
   * the report and its date are the two fields below. */
  detail: string | null;
  /**
   * An archive item's report family ("Search Console · queries") and report
   * day (YYYY-MM-DD), as fields (bead `ro-ujb9.96.7.17`): the connection model
   * judges each report by its own latest attempt and counts and dates the
   * missing ones from these, so rewording `detail` can never merge two reports
   * into one or drop a missing date. Null for every item that is not one
   * report of an archive.
   */
  report: string | null;
  reportDate: string | null;
  state: IntegrationHealthState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  failure: IntegrationFailureKind | null;
  code: string | null;
  action: string;
  coverage: 'monitored' | 'setup' | 'gap';
}
export interface IntegrationHealthEvent {
  id: string;
  itemId: string;
  provider: string;
  label: string;
  asset: string | null;
  at: string;
  kind: 'failed' | 'changed' | 'recovered';
}
export interface IntegrationHealthPayload {
  generatedAt: string;
  available: boolean;
  items: IntegrationHealthItem[];
  events: IntegrationHealthEvent[];
}
export const INTEGRATION_HEALTH_LABELS: Record<IntegrationHealthState, string> = {
  healthy: 'Working', failing: 'Failing', stale: 'Overdue', 'never-run': 'Awaiting first result', idle: 'Idle',
  paused: 'Paused', disconnected: 'Not connected', unmonitored: 'Not monitored', unknown: 'Unknown',
};
export function integrationHealthNeedsAttention(item: Pick<IntegrationHealthItem, 'state'>): boolean {
  return ['failing', 'stale', 'never-run', 'unmonitored', 'unknown'].includes(item.state);
}
export function integrationHealthSummary(payload: IntegrationHealthPayload | undefined) {
  const items = payload?.items ?? [];
  return { available: payload?.available === true, failing: items.filter(i => i.state === 'failing').length,
    attention: items.filter(integrationHealthNeedsAttention).length, working: items.filter(i => i.state === 'healthy').length,
    assets: [...new Set(items.filter(integrationHealthNeedsAttention).flatMap(i => i.asset ? [i.asset] : []))] };
}
export function integrationFailureMessage(item: Pick<IntegrationHealthItem, 'failure' | 'code'>): string | null {
  if (item.code === 'rate-limit-daily') return 'The daily request allowance is exhausted.';
  if (item.code === 'rate-limit-hourly') return 'The hourly request allowance is exhausted.';
  return item.failure === null ? null : ({ access: 'Access was refused.', 'rate-limit': 'The provider is limiting requests.',
    budget: 'The provider balance or spending allowance is exhausted.', network: 'The provider could not be reached.',
    provider: 'The provider could not complete the request.', 'invalid-report': 'The response could not be used.',
    'incomplete-report': 'The report is incomplete.', configuration: 'The connection or mapping needs attention.',
    monitoring: 'NoticeOS could not record or coordinate this operation.' } satisfies Record<IntegrationFailureKind, string>)[item.failure];
}
