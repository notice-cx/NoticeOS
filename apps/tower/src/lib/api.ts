import { demoFetch } from './demo-visit';
import { responseJson } from './response-value';
import { decodeWallMoney, decodeAssetMoney, decodeFinancials } from './money-response';
import { DEMO_PRESENTATION_PATH, decodeDemoPresentation, type DemoPresentation } from '@shared/demo-presentation';
import { fetchMembershipsRequest, manageMembershipRequest } from './membership-client';
import {
  ALERT_HISTORY_PAGE,
  type AlertHistoryPayload,
  type AlertHistoryQuery,
  alertHistoryQueryString,
} from "@shared/alert-history";
import type { AlertRuleStatsPayload } from "@shared/alert-rules";
import type {
  AssetStatusValue,
  FileJsonInsertOp,
  FileJsonSetOp,
  FileOp,
  JsonValue,
  StoreColumn,
} from "@shared/changeset";
import type { FinancialsPayload } from "@shared/financials";
import { ASSET_STATUS } from "@shared/changeset";
import {
  INTEGRATION_HEALTH_LABELS,
} from "@noticeos/contract/integration-health";
import {
  CONNECTION_COUNT_KEYS,
  type ConnectionCountsHistory,
  type IntegrationHealthResponse,
} from "@shared/connection-status";
import type { CalendarUpcoming } from "@noticeos/contract/calendar-upcoming";
import { GA4_PULSE_MINUTES, type Ga4RealtimePayload } from "@noticeos/contract/ga4-realtime";
import type {
  AnnotationKind,
  DecisionKind,
  DecisionStatus,
} from "@shared/asset-detail";
import type { AssetDetailResponse, AssetDetailView } from "@shared/asset-detail-views";
import type {
  CollectNowResult,
  ConnectVerdict,
  RuleBacktest,
  RuleBacktestInput,
  WatchQueryHistory,
  MediavineResult,
  MediavineStatus,
  RevenueHolidayCalendar,
} from "@noticeos/contract";
import {
  ENV_IMPORT_PATH,
  type EnvImportAvailability,
  type EnvImportResult,
} from "@shared/env-import";
import { integrationLabel, type IntegrationsMatrix } from "@shared/integrations";
import type {
  CredentialProbe,
  GooglePropertyDiscovery,
  IntegrationCredentialsPayload,
} from "@shared/integrations-page";
import { GOOGLE_PROPERTIES_PATH, GOOGLE_OAUTH_START_PATH, GOOGLE_OAUTH_AUTHORIZE_URL, googleOAuthRedirectUri } from "@noticeos/contract/google-oauth";
import type { SettingsPayload } from "@shared/settings";
import type { SitesPayload } from "@shared/site-discovery";
import { SITE_NAME_PATH } from "@shared/site-name";
import type { TunedSetting } from "@shared/tune";
import type { WallPayload } from "@shared/wall";
import type { WallFeedPayload } from "@shared/wall-feed";
import type { WorkPayload } from "@shared/work";
import type { WorkflowsPayload } from "@shared/workflows";
import type { TaskSourcePayload } from "@shared/task-source";
import {
  READ_ONLY_DEPLOYMENT,
  type LiveTaskDetail,
  type LiveTasksPayload,
  type TaskCreated,
  type TasksCapabilities,
  type TaskProject,
} from "@shared/tasks";

/** The single read the Wall makes. The Worker always returns a fully-formed
 * payload (every band has a designed empty state), so callers never branch on
 * missing sections — only on the query's loading/error state. */
async function fetchWallRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<WallPayload> {
  const res = await fetch("/api/wall", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // The status rides the error, so a page whose first read failed can say
    // which (`ReadFailed`, bead ro-ujb9.218).
    throw new ApiError(`GET /api/wall failed: ${res.status}`, res.status);
  }
  return decodeWallMoney(await responseJson(res, 'Portfolio money'));
}

/** The Wall's live feed (bead ro-trai.9): its own 30-second read, apart from
 * `/api/wall`, so a slow union never delays the rest of the TV. */
async function fetchWallFeedRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<WallFeedPayload> {
  const res = await fetch("/api/wall/feed", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/wall/feed failed: ${res.status}`);
  return (await res.json()) as WallFeedPayload;
}

/** On-demand GA4 realtime snapshot. The Tower Worker proxies a private ingest
 * Service Binding, so this browser call never sees a Google credential. */
const healthInstant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
/** The strip's daily record, or nothing when it is absent or malformed — a
 * history the page cannot read is a gap, never a reason to lose the read. */
function countsHistoryOf(value: unknown): ConnectionCountsHistory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { days, series } = value as { days?: unknown; series?: unknown };
  if (!(typeof days === 'number' && Number.isInteger(days) && days >= 0) || !series || typeof series !== 'object') return undefined;
  const points = (list: unknown) => Array.isArray(list) && list.every((point) => point && typeof point === 'object'
    && typeof (point as { t?: unknown }).t === 'string' && typeof (point as { v?: unknown }).v === 'number');
  return CONNECTION_COUNT_KEYS.every((key) => points((series as Record<string, unknown>)[key])) ? value as ConnectionCountsHistory : undefined;
}
async function fetchIntegrationHealthRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<IntegrationHealthResponse> {
  const res = await fetch('/api/integrations/health', { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Integration health could not be refreshed');
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('generatedAt' in data) || !healthInstant(data.generatedAt) || !('available' in data) || typeof data.available !== 'boolean'
    || !('items' in data) || !Array.isArray(data.items) || !('events' in data) || !Array.isArray(data.events)
    || !data.items.every((item: unknown) => item && typeof item === 'object' && 'state' in item && typeof item.state === 'string' && Object.hasOwn(INTEGRATION_HEALTH_LABELS, item.state)
      && ['id', 'provider', 'capability', 'label', 'action', 'coverage'].every(key => key in item && typeof (item as Record<string, unknown>)[key] === 'string')
      && ['asset', 'detail', 'code', 'report'].every(key => key in item && ((item as Record<string, unknown>)[key] === null || typeof (item as Record<string, unknown>)[key] === 'string'))
      // A report's day is a calendar day or nothing (bead ro-ujb9.96.7.17).
      && 'reportDate' in item && (item.reportDate === null || typeof item.reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.reportDate))
      && ['lastAttemptAt', 'lastSuccessAt', 'nextAttemptAt'].every(key => key in item && ((item as Record<string, unknown>)[key] === null || healthInstant((item as Record<string, unknown>)[key])))
      && 'coverage' in item && ['monitored', 'setup', 'gap'].includes(String(item.coverage))
      && 'failure' in item && (item.failure === null || typeof item.failure === 'string' && ['access', 'rate-limit', 'budget', 'network', 'provider', 'invalid-report', 'incomplete-report', 'configuration', 'monitoring'].includes(item.failure)))
    || !data.events.every((event: unknown) => event && typeof event === 'object' && ['id', 'itemId', 'provider', 'label'].every(key => key in event && typeof (event as Record<string, unknown>)[key] === 'string')
      && 'asset' in event && (event.asset === null || typeof event.asset === 'string') && 'at' in event && healthInstant(event.at) && 'kind' in event && typeof event.kind === 'string' && ['failed', 'changed', 'recovered'].includes(event.kind)))
    throw new Error('Integration health returned an invalid response');
  const { countsHistory, ...read } = data as IntegrationHealthResponse;
  const history = countsHistoryOf(countsHistory);
  return history ? { ...read, countsHistory: history } : read;
}

async function fetchGa4RealtimeRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<Ga4RealtimePayload> {
  const res = await fetch("/api/ga4/realtime", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // Release the unread error stream before rejecting the poll. Keep the HTTP
    // failure even if the transport has already aborted during cancellation.
    await res.body?.cancel().catch(() => {});
    throw new Error(`GET /api/ga4/realtime failed: ${res.status}`);
  }
  const payload: unknown = await res.json();
  if (!isGa4RealtimePayload(payload)) {
    throw new Error("GET /api/ga4/realtime returned an invalid payload");
  }
  return payload;
}

/** The Wall's next-meetings snapshot. Like the realtime read, the Tower Worker
 * proxies a private ingest Service Binding, so this browser call never sees a
 * calendar feed URL. */
async function fetchCalendarUpcomingRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<CalendarUpcoming> {
  const res = await fetch("/api/calendar/upcoming", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/calendar/upcoming failed: ${res.status}`);
  }
  const payload: unknown = await res.json();
  if (!isCalendarUpcoming(payload)) {
    throw new Error("GET /api/calendar/upcoming returned an invalid payload");
  }
  return payload;
}

/**
 * The two counts are the reason this is validated rather than cast: the panel
 * renders NOTHING when no feed is configured, so a malformed payload that lost
 * `feedsConfigured` must fail here instead of reaching a surface that would read
 * the absence as "set up and clear".
 */
function isCalendarUpcoming(value: unknown): value is CalendarUpcoming {
  if (
    !isRecord(value) ||
    !isIso(value.fetchedAt) ||
    !nonNegativeInteger(value.feedsConfigured) ||
    !nonNegativeInteger(value.feedsOk) ||
    value.feedsOk > value.feedsConfigured ||
    !Array.isArray(value.calendars) ||
    !Array.isArray(value.meetings)
  ) {
    return false;
  }
  // Feed order is load-bearing (it decides identity hues), so the list has to
  // arrive as a list; a pinned color stays a free-form CSS string, since the
  // operator's calendar app is the authority on what their feeds look like.
  // `status` is a CLOSED set, unlike the color: the panel turns each value into
  // a different instruction to the operator, so an unrecognized one is a value
  // this build does not know how to act on and is refused here rather than
  // silently reading as healthy.
  if (
    !value.calendars.every(
      (feed) =>
        isRecord(feed) &&
        typeof feed.id === "string" &&
        (feed.color === null || typeof feed.color === "string") &&
        (feed.status === "ok" ||
          feed.status === "unreachable" ||
          feed.status === "misconfigured"),
    )
  ) {
    return false;
  }
  return value.meetings.every(
    (meeting) =>
      isRecord(meeting) &&
      typeof meeting.calendar === "string" &&
      typeof meeting.title === "string" &&
      isIso(meeting.startsAt) &&
      isIso(meeting.endsAt) &&
      typeof meeting.allDay === "boolean" &&
      (meeting.location === null || typeof meeting.location === "string"),
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGa4RealtimePayload(value: unknown): value is Ga4RealtimePayload {
  if (!isRecord(value) || !isIso(value.generatedAt) || !Array.isArray(value.assets)) {
    return false;
  }
  return value.assets.every(
    (asset) =>
      isRecord(asset) &&
      typeof asset.asset === "string" &&
      (asset.status === "success" || asset.status === "error") &&
      nullableNonNegativeInteger(asset.activeUsers5m) &&
      nullableNonNegativeInteger(asset.activeUsers30m) &&
      validMinuteBuckets(asset.activeUsersByMinute) &&
      (asset.status === "success" || asset.activeUsersByMinute == null) &&
      validHourlyActiveUsers(asset.hourlyActiveUsers) &&
      isIso(asset.observedAt) &&
      (asset.nextAttemptAt === undefined || isIso(asset.nextAttemptAt)) &&
      (asset.hourlyObservedAt === undefined || isIso(asset.hourlyObservedAt)) &&
      (asset.hourlyNextAttemptAt === undefined || isIso(asset.hourlyNextAttemptAt)) &&
      (asset.rateLimit === undefined || (typeof asset.rateLimit === 'string' && ['daily-tokens', 'daily-requests', 'hourly-tokens', 'project-hourly-tokens', 'concurrency', 'server-errors', 'requests-per-minute', 'requests-per-second', 'unspecified'].includes(asset.rateLimit))) &&
      (asset.hourlyErrorCode === undefined || asset.hourlyErrorCode === null || (typeof asset.hourlyErrorCode === 'string' && asset.hourlyErrorCode.length > 0)) &&
      (asset.errorCode === null || typeof asset.errorCode === "string") &&
      (asset.status === "success"
        ? asset.activeUsers5m !== null &&
          asset.activeUsers30m !== null &&
          (Array.isArray(asset.hourlyActiveUsers) ||
            (asset.hourlyActiveUsers === null && typeof asset.hourlyErrorCode === "string" && asset.hourlyErrorCode.length > 0)) &&
          asset.errorCode === null
        : asset.activeUsers5m === null &&
          asset.activeUsers30m === null &&
          asset.hourlyActiveUsers === null &&
          typeof asset.errorCode === "string"),
  );
}

/** The minute pulse (bead `ro-trai.27`): thirty buckets, each a count or
 * `null` for a minute the reading did not cover. Absent from an ingest that
 * predates it, and `null` when its read was refused — the snapshot stands. */
function validMinuteBuckets(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length === GA4_PULSE_MINUTES && value.every(nullableNonNegativeInteger);
}

function validHourlyActiveUsers(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length !== 24) return false;
  return value.every(
    (point, index) =>
      isRecord(point) &&
      point.hour === index &&
      typeof point.hour === "number" &&
      Number.isInteger(point.hour) &&
      point.hour >= 0 &&
      point.hour <= 23 &&
      nullableNonNegativeInteger(point.today) &&
      nullableNonNegativeInteger(point.sameDayLastWeek) &&
      point.sameDayLastWeek !== null,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

/** An error carrying the HTTP status, so callers can render a designed 404
 * ("no such asset") state distinctly from a transient failure. `code` is the
 * server's machine code (`expect_mismatch`, `read_only_deployment`, …) when it
 * sent one: a save branches on the code, and shows the message. `field` is the
 * one the server refused (`422 invalid_asset` names it), so a form can put the
 * sentence beside the input the operator has to change instead of at the top of
 * the page as a failure. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A `?period=` on /financials the ledger cannot answer — a month it holds no
 * rows for, or a value that is not a month at all (bead `ro-dm67`).
 *
 * It carries `periods[]` off the refusal body, because the only useful thing to
 * say to a reader who followed a stale bookmark is which months DO exist. It is
 * an `ApiError` so a caller that only cares about the status still reads it as
 * one.
 */
export class FinancialsPeriodError extends ApiError {
  constructor(
    code: "period_not_found" | "period_malformed",
    status: number,
    readonly periods: string[],
  ) {
    super(code, status, code);
    this.name = "FinancialsPeriodError";
  }
}

/**
 * An `?offset=`/`?limit=` on the alerts archive that is not a whole number of
 * rows (bead `ro-oefa`) — the same refusal `FinancialsPeriodError` carries for
 * a `?period=` that is not a month.
 *
 * It carries `total` and `limit` off the refusal body for the same reason that
 * one carries `periods[]`: the only useful thing to say to a reader who
 * followed a corrupted link is how much there actually is to page through.
 */
export class AlertHistoryPageError extends ApiError {
  constructor(
    status: number,
    readonly total: number,
    readonly limit: number,
  ) {
    super("page_malformed", status, "page_malformed");
    this.name = "AlertHistoryPageError";
  }
}

/** The desk-only asset drill-down read. 404 → ApiError(status: 404) so the page
 * can show a designed "unknown asset" state rather than a generic failure.
 * `view` asks for one tab's read (bead `ro-ujb9.64`); without it, the whole
 * page. */
async function fetchAssetDetailRequest(fetch: ApiTransport,
  id: string,
  signal?: AbortSignal,
  view?: AssetDetailView,
): Promise<AssetDetailResponse> {
  const query = view ? `?view=${encodeURIComponent(view)}` : "";
  const path = `/api/assets/${encodeURIComponent(id)}`;
  const res = await fetch(`${path}${query}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(`GET ${path} failed: ${res.status}`, res.status);
  }
  const payload = decodeAssetMoney(await responseJson(res, 'Site financials'), id, view);
  payload.integrations.lanes = payload.integrations.lanes.map((lane) => ({
    ...lane, catalog: { ...lane.catalog, label: integrationLabel(lane.catalog.id, lane.catalog.label) },
  }));
  return payload;
}

/** One exact query's provider-final daily history, loaded only for its composer. */
async function fetchWatchQueryHistoryRequest(fetch: ApiTransport,
  asset: string,
  query: string,
  metric: string,
  signal?: AbortSignal,
): Promise<WatchQueryHistory> {
  const params = new URLSearchParams({ query, metric });
  const path = `/api/assets/${encodeURIComponent(asset)}/watch-query-history?${params}`;
  const res = await fetch(path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(`GET ${path} failed: ${res.status}`, res.status);
  }
  const payload: unknown = await res.json();
  if (!isWatchQueryHistory(payload)) {
    throw new Error(`GET ${path} returned an invalid payload`);
  }
  if (payload.query !== query || payload.metric !== metric) {
    throw new Error(`GET ${path} returned history for another query or metric`);
  }
  return payload;
}

function isWatchQueryHistory(value: unknown): value is WatchQueryHistory {
  if (!isRecord(value)) return false;
  const archiveFirstDay = value.archiveFirstDay;
  const archiveLastDay = value.archiveLastDay;
  const archiveSpanValid =
    (archiveFirstDay === null && archiveLastDay === null) ||
    (isDayString(archiveFirstDay) &&
      isDayString(archiveLastDay) &&
      archiveFirstDay <= archiveLastDay);
  return (
    value.integration === "gsc" &&
    typeof value.metric === "string" &&
    typeof value.query === "string" &&
    typeof value.firstDay === "string" &&
    isDayString(value.firstDay) &&
    archiveSpanValid &&
    typeof value.archiveDays === "number" &&
    Number.isInteger(value.archiveDays) &&
    value.archiveDays >= 0 &&
    typeof value.observedDays === "number" &&
    Number.isInteger(value.observedDays) &&
    value.observedDays >= 0 &&
    Array.isArray(value.values) &&
    value.observedDays <= value.archiveDays &&
    value.archiveDays <= value.values.length &&
    isRecordedChangeCalendar(
      value.recordedChanges,
      value.firstDay,
      value.values.length,
    ) &&
    value.values.every(
      (point) => point === null || (typeof point === "number" && Number.isFinite(point)),
    )
  );
}

function isRecordedChangeCalendar(
  value: unknown,
  firstDay: string,
  historyDays: number,
): boolean {
  if (!isRecord(value) || historyDays < 1) return false;
  const lastDay = new Date(
    Date.parse(`${firstDay}T00:00:00.000Z`) + (historyDays - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return (
    value.firstDay === firstDay &&
    value.lastDay === lastDay &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.days) &&
    value.days.every(
      (day) => isDayString(day) && day >= firstDay && day <= lastDay,
    ) &&
    new Set(value.days).size === value.days.length
  );
}

function isDayString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The portfolio integration matrix (desk-only). Always a fully-formed payload
 * with a designed empty state, so callers branch only on loading/error. */
async function fetchIntegrationsRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<IntegrationsMatrix> {
  const res = await fetch("/api/integrations", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/integrations failed: ${res.status}`);
  }
  const payload = (await res.json()) as IntegrationsMatrix;
  payload.catalog = payload.catalog.map((lane) => ({ ...lane, label: integrationLabel(lane.id, lane.label) }));
  payload.derivedLanes = payload.derivedLanes.map((lane) => ({
    ...lane, catalog: { ...lane.catalog, label: integrationLabel(lane.catalog.id, lane.catalog.label) },
  }));
  return payload;
}

/**
 * Every portfolio-wide setting, in one read (bead `ro-pbzu.2`).
 *
 * The Worker builds it purely from the config compiled into the bundle — no
 * store query — so this read cannot fail on an empty or unreachable database.
 * A save through the write lane restarts the local Worker, and `useConfigSave`
 * invalidates this query once the restart has landed.
 */
async function fetchSettingsRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<SettingsPayload> {
  const res = await fetch("/api/settings", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // The status reaches the page's failed read (`ReadFailed`, bead ro-ujb9.242).
    throw new ApiError(`GET /api/settings failed: ${res.status}`, res.status);
  }
  const { decodeSettings } = await import('./critical-response');
  return decodeSettings(await responseJson(res, 'Settings'));
}

/** Which task source every task screen shows, and each source's row on
 * Integrations (D32). */
async function fetchTaskSourceRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<TaskSourcePayload> {
  const res = await fetch("/api/task-source", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/task-source failed: ${res.status}`);
  }
  return (await res.json()) as TaskSourcePayload;
}

/** The read-only work board (desk-only). Always a fully-formed payload with a
 * designed empty state, so callers branch only on loading/error. */
async function fetchWorkRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<WorkPayload> {
  const res = await fetch("/api/work", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // The status rides the error, as `fetchWall`'s does, so the Tasks page's
    // failed first read says which (`ReadFailed`, bead ro-ujb9.218).
    throw new ApiError(`GET /api/work failed: ${res.status}`, res.status);
  }
  return (await res.json()) as WorkPayload;
}

/**
 * One page of the portfolio's SETTLED alerts (bead `ro-ju7f`).
 *
 * The query string is built by the shared `alertHistoryQueryString`, the exact
 * function the Worker parses with, so a filter the page can express is a filter
 * the read understands — and the unfiltered first page is a bare path, which
 * keeps the TanStack cache key honest about what actually varies.
 */
async function fetchAlertHistoryRequest(fetch: ApiTransport,
  query: AlertHistoryQuery,
  signal?: AbortSignal,
): Promise<AlertHistoryPayload> {
  const search = alertHistoryQueryString(query);
  const path = `/api/alerts/history${search ? `?${search}` : ""}`;
  const res = await fetch(path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // A page param that is not a whole number is a corrupted LINK, not a broken
    // archive (bead `ro-oefa`). Losing the distinction here would leave the page
    // saying "the history read failed" about a URL it can name the fix for.
    const refused = await pageRefusal(res);
    if (refused) throw refused;
    throw new ApiError(`GET ${path} failed: ${res.status}`, res.status);
  }
  return (await res.json()) as AlertHistoryPayload;
}

/** The `/api/alerts/history` refusal about the requested page, read back with
 * the size of the archive it refused to page into. Anything else is `null` — a
 * real failure, which the page renders as one. */
async function pageRefusal(res: Response): Promise<AlertHistoryPageError | null> {
  if (res.status !== 400) return null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A refusal with no body cannot be the designed one; it falls through.
  }
  const record = isRecord(body) ? body : {};
  if (record.error !== "page_malformed") return null;
  return new AlertHistoryPageError(
    res.status,
    typeof record.total === "number" ? record.total : 0,
    typeof record.limit === "number" ? record.limit : ALERT_HISTORY_PAGE,
  );
}

/**
 * What each rule has COST — fired, settled, and how many of those the operator
 * answered by tuning the rule (bead `ro-ayxy`).
 *
 * Its own read rather than a field on `/api/settings`, because that payload is a
 * pure builder over config and must not be able to fail on an empty store, and
 * because the Tune panel needs the same figure on surfaces that never load
 * `/settings`.
 */
async function fetchAlertRuleStatsRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<AlertRuleStatsPayload> {
  const res = await fetch("/api/alerts/rules", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(`GET /api/alerts/rules failed: ${res.status}`, res.status);
  }
  return (await res.json()) as AlertRuleStatsPayload;
}

/**
 * "How often would this alert rule have fired in the last 30 days with these
 * settings?" (bead `ro-u072`).
 *
 * A POST that READS. The question's key is a whole settings object the operator
 * is still typing, which does not survive a query string honestly — the same
 * reasoning the research-log lookup records — and nothing on either side of the
 * binding is written: the answer is `evaluatePulse` replayed over stored pulses.
 *
 * Refusals arrive as `ApiError` with the server's own code, because the panel
 * renders a different sentence for each: `unsupported_rule` is "no preview for
 * this rule", `unknown_asset` is an asset that is gone, and `validation` is a
 * value the detector will not accept.
 */
async function fetchRuleBacktestRequest(fetch: ApiTransport,
  input: RuleBacktestInput,
  signal?: AbortSignal,
): Promise<RuleBacktest> {
  const res = await fetch("/api/alerts/backtest", {
    method: "POST",
    signal,
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw await refusal(res, `POST /api/alerts/backtest failed: ${res.status}`);
  }
  return (await res.json()) as RuleBacktest;
}

export type FlagAction =
  | "acknowledge"
  | "resolve"
  | "snooze"
  | "unsnooze"
  | "tune";

/** What one action needs beyond its own name: a date for `snooze`, the setting
 * that moved for `tune`. Nothing for the other three. */
export interface FlagActionDetail {
  /** `snooze` only — a validated ISO instant (`shared/snooze`). */
  until?: string;
  /** `tune` only — which setting changed, and between which values
   * (`shared/tune`). The stored note is composed by the Worker from this, so no
   * free text ever reaches `disposition_note`. */
  tuned?: TunedSetting;
}

/**
 * Move one alert through its lifecycle (docs/15 flow E): mark it read, record
 * that its issue is resolved, park it until a date, bring a parked one back, or
 * record that the rule behind it was tuned.
 *
 * `until` is required for `snooze` and ignored otherwise. It is validated on
 * BOTH sides — here so the operator sees a refusal without a round trip, and in
 * the Worker because a rule only the browser enforces is not a rule
 * (`shared/snooze`). A rejected date throws `ApiError` carrying the store's own
 * code, which is what the toast reads.
 *
 * `tune` rides the SAME lane and the same 409-when-not-open guard (bead
 * `ro-van6`) rather than arriving as a second endpoint: one row's disposition is
 * written in one place, or "only an open alert may be dispositioned" would have
 * two implementations to keep in step.
 */
async function updateFlagRequest(fetch: ApiTransport,
  id: number,
  action: FlagAction,
  detail: FlagActionDetail = {},
): Promise<void> {
  const res = await fetch(`/api/flags/${id}`, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      action === "snooze"
        ? { action, until: detail.until }
        : action === "tune"
          ? { action, tuned: detail.tuned }
          : { action },
    ),
  });
  if (!res.ok) {
    throw new ApiError(`PATCH /api/flags/${id} failed: ${res.status}`, res.status);
  }
}

function decisionsUrl(asset: string): string {
  return `/api/assets/${encodeURIComponent(asset)}/decisions`;
}

/** Record what the operator decided about one query or finding. Repeating the
 * same decision is a no-op on the server, so callers may fire without first
 * checking what is already stored. */
async function recordDecisionRequest(fetch: ApiTransport,
  asset: string,
  input: { kind: DecisionKind; key: string; status: DecisionStatus; note?: string },
): Promise<void> {
  const res = await fetch(decisionsUrl(asset), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiError(
      `POST ${decisionsUrl(asset)} failed: ${res.status}`,
      res.status,
    );
  }
}

/** Record one timeline event the operator did (a deploy, a config change, an
 * incident). Backdating is expected: an event is annotated at the time it
 * happened. Re-posting an identical event is a no-op on the server. */
async function createAnnotationRequest(fetch: ApiTransport,
  asset: string,
  input: { kind: AnnotationKind; at?: string; note?: string; ref?: string | null },
): Promise<void> {
  const path = `/api/assets/${encodeURIComponent(asset)}/annotations`;
  const res = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiError(`POST ${path} failed: ${res.status}`, res.status);
  }
}

/**
 * Register one pre-registered outcome check on this asset (bead `ro-71r`).
 *
 * The body is the ingest route's documented shape, built once by
 * `watchDraftBody` — this call adds nothing and defaults nothing, because a
 * field the composer never showed is a comparison the operator did not choose.
 * A 422 comes back with ingest's own sentence in `detail`, so a refusal the UI
 * failed to anticipate is still readable rather than a silent retry.
 */
async function createWatchWindowRequest(fetch: ApiTransport,
  asset: string,
  body: Record<string, unknown>,
): Promise<void> {
  const path = `/api/assets/${encodeURIComponent(asset)}/watch-windows`;
  const res = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await refusalDetail(res);
    throw new ApiError(
      detail ?? `POST ${path} failed: ${res.status}`,
      res.status,
    );
  }
}

/** The store's own reason, when it sent one. A failed read of the error body is
 * not itself an error: the caller falls back to the status line. */
async function refusalDetail(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const detail = isRecord(body) ? body.detail : null;
    return typeof detail === "string" && detail.length > 0 ? detail : null;
  } catch {
    return null;
  }
}

/**
 * The refusal, as the caller has to render it: the server's own sentence when it
 * sent one, its machine code either way, and — for `expect_mismatch` — the
 * mismatch list, because "changed elsewhere" is only useful beside what is
 * actually there now. One reader for every write below, so no save surface has
 * to re-derive how a refusal is shaped.
 */
async function refusal(res: Response, fallback: string): Promise<ApiError> {
  return refusalOf(await refusalBody(res), res.status, fallback);
}

/** A refusal's body, or an empty one. */
async function refusalBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return isRecord(body) ? body : {};
  } catch {
    // A refusal with no body is still a refusal; the status line carries it.
    return {};
  }
}

function refusalOf(record: Record<string, unknown>, status: number, fallback: string): ApiError {
  const code = typeof record.error === "string" ? record.error : null;
  const detail = typeof record.detail === "string" ? record.detail : null;
  const field = typeof record.field === "string" ? record.field : null;
  return new ApiError(detail ?? code ?? fallback, status, code, field);
}

const JSON_WRITE_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
};

/** Where the value a page is rendering came from, per config file — the store
 * once an install is seeded, otherwise the copy compiled into the build (D22,
 * epic `ro-syok`). */
export type ConfigSource = "store" | "file";

/** Whether configuration documents can be saved from this deployment; the one
 * sentence a disabled field shows when they cannot; and where each config
 * document the page is rendering actually came from. */
export interface ConfigWritability {
  writable: boolean;
  reason: string | null;
  /**
   * Per config file, where the value this deployment renders came from: `store`
   * once the document is seeded, `file` while the copy compiled into the build
   * is still answering (D22).
   *
   * EMPTY when the deployment did not say — the local dev lane answers this
   * route itself and reports only whether a Save can land — so absence is
   * "unknown", never "all files".
   *
   * It is the SAME field the payloads were built from, which is why a surface
   * describing when a save takes effect derives its sentence from this rather
   * than stating one of its own (`laneMappingTiming`), and why
   * `configSaveDelayMs` reads it to decide whether a save has a Worker restart
   * to wait out at all (bead `ro-ssgu`).
   */
  sources: Record<string, ConfigSource>;
}

async function fetchConfigWritableRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<ConfigWritability> {
  const res = await fetch("/api/config", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw await refusal(res, `GET /api/config failed: ${res.status}`);
  }
  const { decodeConfigWritable } = await import('./critical-response');
  return decodeConfigWritable(await responseJson(res, 'Settings availability'));
}

/** How many guarded ops landed. Store saves create no changeset file or Git
 * commit; the legacy response fields remain for compatibility. */
export interface ConfigSaveResult {
  applied: number;
  archive: string | null;
  commit: string | null;
  /** False means the authoritative save landed but this Mac's file export did
   * not. Absent on runtimes without a local checkout. Never retry that Save. */
  exported?: boolean;
}

/**
 * Save configuration documents — one PUT and one guarded store write.
 *
 * Every op carries `expect`, the value the field was rendered from, and the lane
 * applies NONE of them if any one is stale: a 409 comes back with what is
 * actually there. The local write lane and the deployed Worker's private
 * INGEST binding both apply store saves. Availability is stated by
 * `useConfigWritable` and checked again on every write.
 */
async function saveConfigRequest(fetch: ApiTransport,
  ops: FileOp[],
  slug?: string,
): Promise<ConfigSaveResult> {
  const { decodeConfigSave } = await import('./critical-response');
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(slug === undefined ? { ops } : { ops, slug }),
  });
  if (!res.ok) {
    throw await refusal(res, `PUT /api/config failed: ${res.status}`);
  }
  let body: unknown;
  try { body = await responseJson(res, 'Save'); }
  catch (error) {
    if (error instanceof Error && error.message === 'Save returned an invalid response.') throw new Error('Save outcome unknown — refresh before retrying.');
    throw error;
  }
  return decodeConfigSave(body, ops.length, ops.map(op => op.file));
}

/**
 * Write a NEW asset's config entries — one PUT and one guarded store write
 * (bead `ro-qsoo`).
 *
 * It is `saveConfig` with a narrower door, and it exists because the two writes
 * are different acts. A SETTING save is invertible: the Undo in its toast is the
 * same op with `expect` and `value` swapped, which is why `useConfigSave` takes
 * only `file-json-set` and `store-asset-set`. Adding an asset's entries is
 * STRUCTURAL — the inverse of an insert is a delete at a pointer that has moved
 * — so the add-asset flow submits its inserts here instead, and owns its own way
 * back (deleting the asset it just made).
 *
 * The ops arrive as ONE guarded request deliberately, so an asset's
 * integrations, counters and fetch entries land together or not at all.
 *
 * NOT EVERY OP IS AN INSERT since bead `ro-aodz`. The owning entity is this
 * asset's id appended to a row that already exists in `config/entities.json`,
 * which is a SET — an entity is not a thing an asset is born into, it is one
 * that outlives every asset it owns. It travels in the same document for the
 * same reason as the rest: an asset that exists and belongs to nobody is not a
 * state Create should be able to leave behind.
 */
async function createAssetConfigRequest(fetch: ApiTransport,
  ops: (FileJsonInsertOp | FileJsonSetOp)[],
  slug: string,
): Promise<ConfigSaveResult> {
  return saveConfigRequest(fetch, ops, slug);
}

/**
 * Save one store-owned setting on one asset — its lifecycle stage or its
 * automation mode. Works in every deployment: these two columns live in the
 * store, not in a file, so the Worker writes them over its ingest binding.
 *
 * `expect` is the same guard the config lane applies: 409 when the row moved
 * since the page rendered it.
 */
async function patchAssetColumnRequest(fetch: ApiTransport,
  id: string,
  column: StoreColumn,
  value: JsonValue,
  expect: JsonValue,
): Promise<void> {
  const path = `/api/assets/${encodeURIComponent(id)}`;
  const res = await fetch(path, {
    method: "PATCH",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ column, value, expect }),
  });
  if (!res.ok) {
    throw await refusal(res, `PATCH ${path} failed: ${res.status}`);
  }
}

async function moveAssetRequest(fetch: ApiTransport, asset: string, to: string, expectRevision?: string) {
  const { decodeAssetOrder } = await import('./critical-response');
  const path = `/api/assets/${encodeURIComponent(asset)}/order`;
  const response = await fetch(path, { method: 'PATCH', headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ to, ...(expectRevision === undefined ? {} : { expectRevision }) }) });
  if (!response.ok) throw await refusal(response, 'Site order could not be saved.');
  return decodeAssetOrder(await responseJson(response, 'Site order'), asset);
}

/**
 * Rename one asset. A convenience over `patchAssetColumn`, because "rename" is
 * what the operator is doing and `display_name` is an implementation detail of
 * where the name lives — and because the expect guard is easy to forget when the
 * argument is a plain string.
 */
async function renameAssetRequest(fetch: ApiTransport,
  id: string,
  displayName: string,
  expect: string,
): Promise<void> {
  await patchAssetColumnRequest(fetch, id, "display_name", displayName, expect);
}

/** A new asset, as the wizard describes it. `status` and `senseOnly` are
 * optional; the store starts an asset `onboarding` and sense-only. */
export interface NewAsset {
  id: string;
  displayName: string;
  domain?: string | null;
  status?: AssetStatusValue;
  senseOnly?: 0 | 1;
}

/** The row the store actually wrote, read back rather than echoed. */
export interface CreatedAsset {
  id: string;
  domain: string | null;
  displayName: string;
  status: AssetStatusValue;
  senseOnly: number;
  isOs: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create an asset — the row under the add-asset wizard (bead `ro-z349.1`).
 *
 * Throws `AssetExistsError` (409) when the store already holds the id or the
 * domain, naming the site that holds it, and `ApiError` `"invalid_asset"`
 * (422) with the store's own sentence about the field it refused; the screen
 * shows either beside the field rather than as a failure. Works in every
 * deployment: the row is in the store, not in a file.
 */
async function createAssetRequest(fetch: ApiTransport, asset: NewAsset): Promise<CreatedAsset> {
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(asset),
  });
  if (!res.ok) {
    const record = await refusalBody(res);
    if (record.error === "asset_exists" && typeof record.id === "string") {
      throw new AssetExistsError(res.status, record.id, ASSET_STATUS.find(status => status === record.existingStatus));
    }
    throw refusalOf(record, res.status, `POST /api/assets failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  const record = isRecord(body) ? body : {};
  return record.asset as CreatedAsset;
}

/**
 * The store already holds this site: `holder` is the one it holds the id or
 * the domain under (bead `ro-ujb9.76.4.6`). It can differ from the id just
 * typed, where an imported or seeded site holds the domain under another id.
 */
export class AssetExistsError extends ApiError {
  constructor(
    status: number,
    readonly holder: string,
    readonly existingStatus?: AssetStatusValue,
  ) {
    super("Already added", status, "asset_exists");
    this.name = "AssetExistsError";
  }
}

/**
 * The name a site gives itself (bead `ro-ujb9.96.7.5`), or null when it did not
 * answer with one. Never throws: the add screen already shows the name the
 * domain gives, and a lookup that failed changes nothing about what Add writes.
 */
async function fetchSiteNameRequest(fetch: ApiTransport, domain: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${SITE_NAME_PATH}?domain=${encodeURIComponent(domain)}`, { signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const name = isRecord(body) ? body.name : null;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/** Clear a decision — the findings "Restore". Clearing an untouched item
 * succeeds; absence is the state the caller asked for. */
async function clearDecisionRequest(fetch: ApiTransport,
  asset: string,
  kind: DecisionKind,
  key: string,
): Promise<void> {
  const res = await fetch(decisionsUrl(asset), {
    method: "DELETE",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind, key }),
  });
  if (!res.ok) {
    throw new ApiError(
      `DELETE ${decisionsUrl(asset)} failed: ${res.status}`,
      res.status,
    );
  }
}

/**
 * The ledger for one accounting period. `period` is the month the reader asked
 * for through the URL (bead `ro-69vb`); omitted, the payload picks the latest
 * month that has rows rather than an empty current one.
 */
async function fetchFinancialsRequest(fetch: ApiTransport,
  period?: string | null,
  signal?: AbortSignal,
): Promise<FinancialsPayload> {
  const path = period ? `/api/financials?period=${encodeURIComponent(period)}` : "/api/financials";
  const res = await fetch(path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // A month the ledger cannot answer is a MISS, not a broken ledger (bead
    // `ro-dm67`). Both refusals carry `periods[]`, and losing it here is what
    // left the page with nothing to say but "the ledger did not answer" — and
    // no selector, because it is drawn from a payload that never arrived.
    const refused = await periodRefusal(res);
    if (refused) throw refused;
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return decodeFinancials(await responseJson(res, 'Financials'), period);
}

/** The two `/api/financials` refusals about the requested month, read back with
 * the months the ledger does hold. Anything else is `null` — a real failure,
 * which the page renders as one. */
async function periodRefusal(res: Response): Promise<FinancialsPeriodError | null> {
  if (res.status !== 404 && res.status !== 400) return null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A refusal with no body cannot be the designed one; it falls through.
  }
  const record = isRecord(body) ? body : {};
  const code = typeof record.error === "string" ? record.error : null;
  if (code !== "period_not_found" && code !== "period_malformed") return null;
  const periods = Array.isArray(record.periods)
    ? record.periods.filter((entry): entry is string => typeof entry === "string")
    : [];
  return new FinancialsPeriodError(code, res.status, periods);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks — the operator's live lane into the portfolio's task hub (D19)
// ─────────────────────────────────────────────────────────────────────────────
//
// Answered by the local dev server's task lane (apps/tower/vite/task-lane.ts),
// which runs an allowlisted set of `bd` verbs in the spoke named by
// config/beads.json and records `--actor` as the operator. A deployed build has
// no `bd` and no route to the hub, so its Worker answers `live: false` with the
// reason and 501 on everything else — the board falls back to the once-a-minute
// snapshot at `/api/work`, which every deployment can serve.
//
// `bd` remains the path an AGENT uses, in the repo where the work happens. That
// rule is unchanged by any of this (config/beads.README.md, AGENTS.md).

/** Can this deployment reach the task hub? Asked once per session. */
async function fetchTasksCapabilitiesRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<TasksCapabilities> {
  const res = await fetch("/api/tasks/capabilities", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw await refusal(res, `GET /api/tasks/capabilities failed: ${res.status}`);
  }
  const payload: unknown = await res.json();
  const record = isRecord(payload) ? payload : {};
  return {
    live: record.live === true,
    ...(typeof record.writable === 'boolean' ? { writable: record.writable } : {}),
    ...(typeof record.projectSelection === 'boolean' ? { projectSelection: record.projectSelection } : {}),
    ...(Array.isArray(record.operations) && record.operations.every(value => typeof value === 'string') ? { operations: record.operations as string[] } : {}),
    ...(Array.isArray(record.editableFields) && record.editableFields.every(value => typeof value === 'string') ? { editableFields: record.editableFields as string[] } : {}),
    // A code this build knows, or nothing: an older Worker's sentence is not
    // rendered — `live: false` alone already draws the Read-only state.
    reason: record.reason === READ_ONLY_DEPLOYMENT ? READ_ONLY_DEPLOYMENT : null,
  };
}

async function fetchTaskProjectsRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<readonly TaskProject[]> {
  const res = await fetch('/api/tasks/projects', { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw await refusal(res, `GET /api/tasks/projects failed: ${res.status}`);
  const payload: unknown = await res.json();
  if (!isRecord(payload) || !Array.isArray(payload.projects)) throw new Error('Task projects are unavailable.');
  return payload.projects as TaskProject[];
}

/** One project's live board: active/parked work and every recent closure.
 * `status` narrows the stored statuses; closed rows always use the bounded
 * date window reported in `closedSince`. */
async function fetchTasksRequest(fetch: ApiTransport,
  project: string,
  status?: string,
  signal?: AbortSignal,
): Promise<LiveTasksPayload> {
  const params = new URLSearchParams({ project });
  if (status !== undefined) params.set("status", status);
  const path = `/api/tasks?${params}`;
  const res = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw await refusal(res, `GET ${path} failed: ${res.status}`);
  return (await res.json()) as LiveTasksPayload;
}

/** Hosted task pages select their logical project explicitly. Standalone's
 * existing id-only URLs remain supported by its own server lane. */
async function fetchTaskRequest(fetch: ApiTransport,
  id: string,
  signal?: AbortSignal,
  project?: string,
): Promise<LiveTaskDetail> {
  const path = `/api/tasks/${encodeURIComponent(id)}${project === undefined ? '' : `?${new URLSearchParams({ project })}`}`;
  const res = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw await refusal(res, `GET ${path} failed: ${res.status}`);
  return (await res.json()) as LiveTaskDetail;
}

/** What the composer sends. `metadata` carries the `noticeos_*` handoff grammar
 * when a task is filed from a finding, so a filed bead matches the one the
 * copied `bd create` command would have made. */
export interface NewTask {
  project: string;
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  labels?: string[];
  parent?: string;
  acceptance?: string;
  metadata?: Record<string, unknown>;
}

async function createTaskRequest(fetch: ApiTransport, input: NewTask): Promise<TaskCreated> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await refusal(res, `POST /api/tasks failed: ${res.status}`);
  return (await res.json()) as TaskCreated;
}

/** The fields the lane will edit. Anything else is refused by name — `bd
 * update` can do more than an operator edits from a board. */
export interface TaskEdit {
  /** Atomic: assignee plus `in_progress`, idempotent. */
  claim?: true;
  status?: string;
  priority?: number;
  assignee?: string;
  parent?: string;
  /** A date `bd` understands (`+1d`, `next monday`, `2026-10-01`); the empty
   * string clears the deferral. */
  defer?: string;
  title?: string;
  description?: string;
  acceptance?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

async function updateTaskRequest(fetch: ApiTransport, id: string, edit: TaskEdit, project?: string): Promise<void> {
  const path = `/api/tasks/${encodeURIComponent(id)}`;
  const res = await fetch(path, {
    method: "PATCH",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ ...edit, ...(project === undefined ? {} : { project }) }),
  });
  if (!res.ok) throw await refusal(res, `PATCH ${path} failed: ${res.status}`);
}

/** `keepalive` lets an answer still inside its Undo window be sent while the
 * page is leaving (`lib/answer-queue.ts`); every other write omits it. */
export interface TaskWriteOptions {
  keepalive?: boolean;
  project?: string;
}

async function actOnTaskRequest(fetch: ApiTransport,
  id: string,
  action: string,
  payload: Record<string, unknown>,
  options?: TaskWriteOptions,
): Promise<void> {
  const path = `/api/tasks/${encodeURIComponent(id)}/${action}`;
  const res = await fetch(path, {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ ...payload, ...(options?.project === undefined ? {} : { project: options.project }) }),
    ...(options?.keepalive ? { keepalive: true } : {}),
  });
  if (!res.ok) throw await refusal(res, `POST ${path} failed: ${res.status}`);
}

/** The reason is required, not decoration: completion is evidence, and the
 * closer cites what proves it (config/beads.README.md). */
function closeTaskRequest(fetch: ApiTransport, id: string, reason: string, project?: string): Promise<void> {
  return actOnTaskRequest(fetch, id, "close", { reason }, project === undefined ? undefined : { project });
}

function commentOnTaskRequest(fetch: ApiTransport, id: string, text: string, project?: string): Promise<void> {
  return actOnTaskRequest(fetch, id, "comments", { text }, project === undefined ? undefined : { project });
}

/** Answer an ask carrying the `human` label: the response is added as a comment
 * and the bead closes. */
function respondToTaskRequest(fetch: ApiTransport, id: string, response: string, options?: TaskWriteOptions): Promise<void> {
  return actOnTaskRequest(fetch, id, "respond", { response }, options);
}

/** Decline one permanently. The reason is optional — declining is itself the
 * answer. */
function dismissTaskRequest(fetch: ApiTransport, id: string, reason?: string, options?: TaskWriteOptions): Promise<void> {
  return actOnTaskRequest(fetch, id, "dismiss", reason === undefined ? {} : { reason }, options);
}

/** Release a gate holding a bead out of `bd ready`. Its own path because a gate
 * is not a task: it is the wait condition in front of one. */
async function resolveGateRequest(fetch: ApiTransport, id: string, reason?: string, options?: TaskWriteOptions): Promise<void> {
  const path = `/api/gates/${encodeURIComponent(id)}/resolve`;
  const res = await fetch(path, {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ ...(reason === undefined ? {} : { reason }), ...(options?.project === undefined ? {} : { project: options.project }) }),
    ...(options?.keepalive ? { keepalive: true } : {}),
  });
  if (!res.ok) throw await refusal(res, `POST ${path} failed: ${res.status}`);
}

// --- Integrations: connect, test and disconnect a provider (bead ro-vu8d.2) --

/**
 * The credential read's path, as ONE constant.
 *
 * `/api/integrations` was already taken when this landed — it is the Health
 * page's lane × asset matrix (`fetchIntegrations` above) — so the provider
 * credential list sits one segment deeper, beside the per-provider writes it
 * belongs with. Naming it once means reconciling with `ro-vu8d.1` is a one-line
 * change rather than a search.
 */
export const INTEGRATION_PROVIDERS_PATH = "/api/integrations/providers";

function credentialPath(provider: string): string {
  return `/api/integrations/${encodeURIComponent(provider)}/credential`;
}

/**
 * Every provider, its field schema, and what the store holds for it — field
 * NAMES and timestamps only, never a value (bead `ro-vu8d.2`).
 *
 * It never answers 501 and it is never read-only: credentials are STORE writes,
 * so this page works the same in a deployed Worker as on the operator's Mac.
 * That is true of nothing else editable on the desk yet — D18 leaves file-owned
 * settings read-only wherever the local write lane is not running.
 */
async function fetchIntegrationProvidersRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<IntegrationCredentialsPayload> {
  const res = await fetch(INTEGRATION_PROVIDERS_PATH, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw await refusal(res, `GET ${INTEGRATION_PROVIDERS_PATH} failed: ${res.status}`);
  }
  const { decodeIntegrationProviders } = await import('./integration-response');
  return decodeIntegrationProviders(await responseJson(res, 'Integration accounts'));
}

/**
 * Store one provider's credential — the only moment a secret leaves the
 * browser.
 *
 * The interesting refusal is `422 invalid_credential`, which NAMES the field it
 * refused on `ApiError.field`, so the form puts the reason under the input the
 * operator has to fix instead of at the bottom of the card. `503
 * credentials_key_missing` carries the ingest's own sentence about generating
 * the bootstrap key.
 */
async function saveProviderCredentialRequest(fetch: ApiTransport,
  provider: string,
  fields: Record<string, string>,
): Promise<void> {
  const path = credentialPath(provider);
  const res = await fetch(path, {
    method: "PUT",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw await refusal(res, `PUT ${path} failed: ${res.status}`);
}

/**
 * Record when one provider's credential stops working, or that it does not
 * (bead `ro-vu8d.8`).
 *
 * The one write on this page that carries no secret: an expiry is a public
 * fact, kept beside the ciphertext rather than inside it. `null` is a real
 * answer — *this does not expire* — and is what a published Google app sends to
 * switch off the Testing-mode countdown for good.
 */
async function saveProviderExpiryRequest(fetch: ApiTransport,
  provider: string,
  expiresAt: string | null,
): Promise<void> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/expiry`;
  const res = await fetch(path, {
    method: "PUT",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ expiresAt }),
  });
  if (!res.ok) throw await refusal(res, `PUT ${path} failed: ${res.status}`);
}

/**
 * Forget one provider's credential. Idempotent by contract (204 even when the
 * store held nothing) and deliberately works WITHOUT the bootstrap key:
 * removing a credential nobody can read any more is exactly when you need to.
 */
async function deleteProviderCredentialRequest(fetch: ApiTransport, provider: string): Promise<void> {
  const path = credentialPath(provider);
  const res = await fetch(path, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await refusal(res, `DELETE ${path} failed: ${res.status}`);
}

/**
 * One real authenticated call against the provider (doc 15 flow C step 2:
 * validation comes from a collector attempt, never a manual health toggle).
 *
 * `ok: false` is a 200 with the provider's own reason in `message` — a wrong
 * password is an ANSWER, not a transport failure, so the card renders it as a
 * sentence rather than as a thrown error.
 */
async function testProviderCredentialRequest(fetch: ApiTransport,
  provider: string,
): Promise<CredentialProbe> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/test`;
  const res = await fetch(path, {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: "{}",
  });
  if (!res.ok) throw await refusal(res, `POST ${path} failed: ${res.status}`);
  return (await res.json()) as CredentialProbe;
}

/**
 * The connect panel's one press (bead `ro-ujb9.96.7.1`): send what the operator
 * entered, and hear the provider's verdict. The ingest asks the provider FIRST
 * and stores the credential only when it accepts, so `accepted` means stored
 * and proven, and `refused` / `unreachable` mean nothing was kept.
 *
 * A refusal is a 200, like the Test button's: it is the answer, not a fault.
 * `422 invalid_credential` names its field on `ApiError.field`, so the panel
 * puts the reason under the input to fix.
 */
async function connectProviderCredentialRequest(fetch: ApiTransport,
  provider: string,
  fields: Record<string, string>,
): Promise<ConnectVerdict> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/connect`;
  const res = await fetch(path, {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw await refusal(res, `POST ${path} failed: ${res.status}`);
  return (await res.json()) as ConnectVerdict;
}

/**
 * One site's token for a provider that issues one per site (Clarity, bead
 * `ro-ujb9.96.7.9`), saved on its row the moment it is pasted. The ingest
 * merges it into the per-site map; nothing comes back but the status.
 */
async function saveSiteTokenRequest(fetch: ApiTransport, provider: string, asset: string, token: string): Promise<void> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/site-token`;
  const res = await fetch(path, { method: "PUT", headers: JSON_WRITE_HEADERS, body: JSON.stringify({ asset, token }) });
  if (!res.ok) throw await refusal(res, `PUT ${path} failed: ${res.status}`);
}

/**
 * What a connected account lists, beside the portfolio's assets and what the
 * register already maps (bead `ro-ujb9.96.7.2`): the connect panel's second
 * screen. One free provider read inside the ingest; nothing is stored.
 */
async function fetchProviderSitesRequest(fetch: ApiTransport, provider: string, signal?: AbortSignal): Promise<SitesPayload> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/sites`;
  const res = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw await refusal(res, `GET ${path} failed: ${res.status}`);
  return (await res.json()) as SitesPayload;
}

/**
 * Start collecting: the provider's scheduled job step, run now for these
 * assets (bead `ro-ujb9.96.7.2`). Answers once the lane's run has finished; a
 * refusal (paused, already running) is an answer, not a thrown error.
 */
async function collectProviderSitesRequest(fetch: ApiTransport, provider: string, assets: string[]): Promise<CollectNowResult> {
  const path = `/api/integrations/${encodeURIComponent(provider)}/collect`;
  const res = await fetch(path, { method: "POST", headers: JSON_WRITE_HEADERS, body: JSON.stringify({ assets }) });
  if (!res.ok) throw await refusal(res, `POST ${path} failed: ${res.status}`);
  return (await res.json()) as CollectNowResult;
}

/**
 * What the connected Google account can actually see (bead `ro-vu8d.3`).
 *
 * Two free, read-only list calls; nothing is stored. It answers the question an
 * operator has one second after signing in — *did I use the right Google
 * account* — and the same payload is what the per-asset property picker
 * (`ro-vu8d.4`) will read.
 *
 * A failure inside Google is a 200 with `ok: false` and the reason, exactly
 * like the connection test: "Search Console would not answer" is an answer.
 */
async function fetchGooglePropertiesRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<GooglePropertyDiscovery> {
  const res = await fetch(GOOGLE_PROPERTIES_PATH, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw await refusal(res, `GET ${GOOGLE_PROPERTIES_PATH} failed: ${res.status}`);
  }
  return (await res.json()) as GooglePropertyDiscovery;
}

/**
 * Can the legacy env credentials be imported from HERE (bead `ro-vu8d.7`)?
 *
 * The local dev server can: the operator's `.dev.secrets.json` is beside it, and
 * its import lane reads the file. Anywhere else the answer is no, with a
 * reason code the card draws beside the command it falls back to. Two facts, one
 * question, because a card that draws a button and then hears 404 teaches an
 * operator not to trust the page.
 */
async function fetchEnvImportAvailabilityRequest(fetch: ApiTransport,
  signal?: AbortSignal,
): Promise<EnvImportAvailability> {
  const res = await fetch(ENV_IMPORT_PATH, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw await refusal(res, `GET ${ENV_IMPORT_PATH} failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  const record = isRecord(body) ? body : {};
  return {
    importable: record.importable === true,
    reason: record.reason === "elsewhere" || record.reason === "no-file" ? record.reason : null,
  };
}

/**
 * Move every complete provider in this machine's secrets file into the store —
 * what `pnpm dev:secrets:import` does, as a button.
 *
 * The whole FILE moves, not one provider: the import is the operator's one
 * crossing from the env path to the store, and there is nothing to say for
 * doing it a quarter at a time. The answer names providers and field names, so
 * the toast can report what actually moved without ever holding a value.
 */
async function importEnvCredentialsRequest(fetch: ApiTransport): Promise<EnvImportResult> {
  const res = await fetch(ENV_IMPORT_PATH, {
    method: "POST",
    headers: JSON_WRITE_HEADERS,
    body: "{}",
  });
  if (!res.ok) throw await refusal(res, `POST ${ENV_IMPORT_PATH} failed: ${res.status}`);
  const body: unknown = await res.json();
  const record = isRecord(body) ? body : {};
  return {
    imported: Array.isArray(record.imported)
      ? (record.imported as EnvImportResult["imported"])
      : [],
    skipped: Array.isArray(record.skipped)
      ? (record.skipped as EnvImportResult["skipped"])
      : [],
    failed: Array.isArray(record.failed) ? (record.failed as EnvImportResult["failed"]) : [],
  };
}

/** One implementation for both an explicitly bound owner and the standalone desk.
 * The lifetime check also covers decoding, including helpers that catch errors. */
export type ApiTransport = typeof globalThis.fetch;

/** Hosted start commits custody before answering. Only Google's fixed consent
 * endpoint and this entry's callback may become a browser navigation. */
async function beginGoogleOAuthRequest(fetch: ApiTransport, origin: string | undefined, signal?: AbortSignal): Promise<string> {
  if (!origin) throw new Error('Google sign-in requires a bound browser entry.');
  const response = await fetch(GOOGLE_OAUTH_START_PATH, { method: 'POST', signal,
    headers: { accept: 'application/json' } });
  if (!response.ok) throw new ApiError('Google sign-in could not start.', response.status);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true
    || !('authorizeUrl' in value) || typeof value.authorizeUrl !== 'string'
    || !('redirectUri' in value) || value.redirectUri !== googleOAuthRedirectUri(origin)) {
    throw new Error('Google sign-in could not start.');
  }
  let target: URL;
  try { target = new URL(value.authorizeUrl); } catch { throw new Error('Google sign-in could not start.'); }
  const fixed = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  const keys = [...target.searchParams.keys()];
  if (value.authorizeUrl.length > 12288 || target.origin !== fixed.origin || target.pathname !== fixed.pathname
    || target.username || target.password || target.hash || new Set(keys).size !== keys.length
    || target.searchParams.get('redirect_uri') !== value.redirectUri
    || target.searchParams.get('response_type') !== 'code' || !target.searchParams.get('state')) {
    throw new Error('Google sign-in could not start.');
  }
  return target.toString();
}
async function mediavineRequest(fetch: ApiTransport, action: string, method: string, body?: unknown): Promise<MediavineStatus> {
  const response = await fetch(`/api/integrations/mediavine/${action}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as MediavineResult<MediavineStatus> & { message?: string };
  if (!response.ok || !result.ok) throw new Error(result.message ?? 'Mediavine could not complete this action. Try again.');
  return result.value;
}
const fetchMediavineStatusRequest = (fetch: ApiTransport, asset: string) => mediavineRequest(fetch, `status?asset=${encodeURIComponent(asset)}`, 'GET');
const syncMediavineRequest = (fetch: ApiTransport, input: { asset: string; start?: string; end?: string }) => mediavineRequest(fetch, 'sync', 'POST', input);
const saveMediavineSettingsRequest = (fetch: ApiTransport, input: { asset: string; siteId: string; enabled: boolean; holidayCalendar: RevenueHolidayCalendar }) => mediavineRequest(fetch, 'settings', 'PUT', input);
async function fetchWorkflowsRequest(fetch: ApiTransport, runId?: string, signal?: AbortSignal): Promise<WorkflowsPayload> {
  const response = await fetch(`/api/workflows${runId ? `?run=${encodeURIComponent(runId)}` : ''}`, { signal });
  if (!response.ok) throw new ApiError(`GET /api/workflows failed: ${response.status}`, response.status);
  return response.json() as Promise<WorkflowsPayload>;
}
async function fetchDemoPresentationRequest(fetch: ApiTransport, signal?: AbortSignal): Promise<DemoPresentation> {
  const response = await fetch(DEMO_PRESENTATION_PATH, { signal });
  if (!response.ok) throw new ApiError('Demo generation unavailable.', response.status);
  return decodeDemoPresentation(await responseJson(response, 'Demo generation'));
}
export function createApi(fetch: ApiTransport, assertActive: () => void = () => {}, entryOrigin?: string) {
  const bind = <Args extends unknown[], Result>(work: (fetch: ApiTransport, ...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      assertActive();
      try {
        const result = await work(fetch, ...args);
        assertActive();
        return result;
      } catch (error) {
        assertActive();
        throw error;
      }
    };
  return Object.freeze({
    fetchDemoPresentation: bind(fetchDemoPresentationRequest),
    fetchMembers: bind((fetch: ApiTransport, after?: string, signal?: AbortSignal) => fetchMembershipsRequest(fetch, 'members', after, signal)),
    fetchInvitations: bind((fetch: ApiTransport, after?: string, signal?: AbortSignal) => fetchMembershipsRequest(fetch, 'invitations', after, signal)),
    manageMembership: bind(manageMembershipRequest),
    beginGoogleOAuth: bind((fetch: ApiTransport, signal?: AbortSignal) => beginGoogleOAuthRequest(fetch, entryOrigin, signal)),
    fetchMediavineStatus: bind(fetchMediavineStatusRequest),
    syncMediavine: bind(syncMediavineRequest),
    saveMediavineSettings: bind(saveMediavineSettingsRequest),
    fetchWorkflows: bind(fetchWorkflowsRequest),
    fetchWall: bind(fetchWallRequest),
    fetchWallFeed: bind(fetchWallFeedRequest),
    fetchIntegrationHealth: bind(fetchIntegrationHealthRequest),
    fetchGa4Realtime: bind(fetchGa4RealtimeRequest),
    fetchCalendarUpcoming: bind(fetchCalendarUpcomingRequest),
    fetchAssetDetail: bind(fetchAssetDetailRequest),
    fetchWatchQueryHistory: bind(fetchWatchQueryHistoryRequest),
    fetchIntegrations: bind(fetchIntegrationsRequest),
    fetchSettings: bind(fetchSettingsRequest),
    fetchTaskSource: bind(fetchTaskSourceRequest),
    fetchWork: bind(fetchWorkRequest),
    fetchAlertHistory: bind(fetchAlertHistoryRequest),
    fetchAlertRuleStats: bind(fetchAlertRuleStatsRequest),
    fetchRuleBacktest: bind(fetchRuleBacktestRequest),
    updateFlag: bind(updateFlagRequest),
    recordDecision: bind(recordDecisionRequest),
    createAnnotation: bind(createAnnotationRequest),
    createWatchWindow: bind(createWatchWindowRequest),
    fetchConfigWritable: bind(fetchConfigWritableRequest),
    saveConfig: bind(saveConfigRequest),
    createAssetConfig: bind(createAssetConfigRequest),
    patchAssetColumn: bind(patchAssetColumnRequest),
    moveAsset: bind(moveAssetRequest),
    renameAsset: bind(renameAssetRequest),
    createAsset: bind(createAssetRequest),
    fetchSiteName: bind(fetchSiteNameRequest),
    clearDecision: bind(clearDecisionRequest),
    fetchFinancials: bind(fetchFinancialsRequest),
    fetchTasksCapabilities: bind(fetchTasksCapabilitiesRequest),
    fetchTaskProjects: bind(fetchTaskProjectsRequest),
    fetchTasks: bind(fetchTasksRequest),
    fetchTask: bind(fetchTaskRequest),
    createTask: bind(createTaskRequest),
    updateTask: bind(updateTaskRequest),
    closeTask: bind(closeTaskRequest),
    commentOnTask: bind(commentOnTaskRequest),
    respondToTask: bind(respondToTaskRequest),
    dismissTask: bind(dismissTaskRequest),
    resolveGate: bind(resolveGateRequest),
    fetchIntegrationProviders: bind(fetchIntegrationProvidersRequest),
    saveProviderCredential: bind(saveProviderCredentialRequest),
    saveProviderExpiry: bind(saveProviderExpiryRequest),
    deleteProviderCredential: bind(deleteProviderCredentialRequest),
    testProviderCredential: bind(testProviderCredentialRequest),
    connectProviderCredential: bind(connectProviderCredentialRequest),
    saveSiteToken: bind(saveSiteTokenRequest),
    fetchProviderSites: bind(fetchProviderSitesRequest),
    collectProviderSites: bind(collectProviderSitesRequest),
    fetchGoogleProperties: bind(fetchGooglePropertiesRequest),
    fetchEnvImportAvailability: bind(fetchEnvImportAvailabilityRequest),
    importEnvCredentials: bind(importEnvCredentialsRequest),
  });
}
export type TowerApi = ReturnType<typeof createApi>;

// Compatibility only: hosted callers must use their owner's createApi instance.
export const {
  fetchDemoPresentation,
  fetchMembers,
  fetchInvitations,
  manageMembership,
  beginGoogleOAuth,
  fetchMediavineStatus,
  syncMediavine,
  saveMediavineSettings,
  fetchWorkflows,
  fetchWall,
  fetchWallFeed,
  fetchIntegrationHealth,
  fetchGa4Realtime,
  fetchCalendarUpcoming,
  fetchAssetDetail,
  fetchWatchQueryHistory,
  fetchIntegrations,
  fetchSettings,
  fetchTaskSource,
  fetchWork,
  fetchAlertHistory,
  fetchAlertRuleStats,
  fetchRuleBacktest,
  updateFlag,
  recordDecision,
  createAnnotation,
  createWatchWindow,
  fetchConfigWritable,
  saveConfig,
  createAssetConfig,
  patchAssetColumn,
  moveAsset,
  renameAsset,
  createAsset,
  fetchSiteName,
  clearDecision,
  fetchFinancials,
  fetchTasksCapabilities,
  fetchTaskProjects,
  fetchTasks,
  fetchTask,
  createTask,
  updateTask,
  closeTask,
  commentOnTask,
  respondToTask,
  dismissTask,
  resolveGate,
  fetchIntegrationProviders,
  saveProviderCredential,
  saveProviderExpiry,
  deleteProviderCredential,
  testProviderCredential,
  connectProviderCredential,
  saveSiteToken,
  fetchProviderSites,
  collectProviderSites,
  fetchGoogleProperties,
  fetchEnvImportAvailability,
  importEnvCredentials,
} = createApi(demoFetch);
