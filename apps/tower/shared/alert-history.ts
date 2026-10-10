// The portfolio's settled alerts, across every asset. A read of its own rather
// than part of the wall payload, which a television polls every minute.

import type { FlagRecord } from "./asset-detail";
import type { Severity } from "./wall";

/** Which asset a settled alert belongs to. The row needs the identity, not the
 * asset card: a favicon, a name, and the link to that asset's Alerts tab. */
export interface AlertHistoryAsset {
  id: string;
  /** `assets.domain` — NULL for asset #0, which is an internal service. */
  domain: string | null;
  displayName: string;
}

/** One settled alert, with the asset it happened to. `flag` is the asset
 * page's own row shape, so both surfaces render one component over one type. */
export interface AlertHistoryRow {
  flag: FlagRecord;
  asset: AlertHistoryAsset;
}

/**
 * Paged by offset and limit, with a total. Not a cursor: rows are ordered by
 * when each was closed (`COALESCE(resolved_at, disposition_at, fired_at)`),
 * which the operator's own clicks write, so there is no stable frontier.
 */
export interface AlertHistoryPayload {
  rows: AlertHistoryRow[];
  /** Rows matching the filters, ignoring the page window. */
  total: number;
  offset: number;
  limit: number;
  /** `offset + rows.length < total`, precomputed so no surface re-derives it. */
  hasMore: boolean;
  generatedAt: string;
}

/** A page param the URL asked for and this read cannot honour, kept raw so the
 * refusal can say it back. */
export interface AlertHistoryPageRefusal {
  param: "offset" | "limit";
  value: string;
}

/** What the browser may ask for. `asset`/`severity` null mean "every one" —
 * absence is the unfiltered read, never an empty result. */
export interface AlertHistoryQuery {
  asset: string | null;
  severity: Severity | null;
  offset: number;
  limit: number;
  /** The page param this read cannot honour, or null when both read. `offset`
   * and `limit` still carry their defaults, so the refusal can state the total. */
  malformed: AlertHistoryPageRefusal | null;
}

/** One screenful. Enough that the first page answers most questions without
 * paging, small enough that the read stays a page rather than a dump. */
export const ALERT_HISTORY_PAGE = 25;

/** The hard ceiling on `limit`. A caller may ask for a bigger page; nothing may
 * ask for an unbounded one. */
export const ALERT_HISTORY_MAX_LIMIT = 100;

const SEVERITIES: readonly Severity[] = ["error", "warn", "info"];

/**
 * Query string → the read's parameters, clamped. Shared by the Worker and the
 * browser hook so both understand the same filters.
 *
 * A filter it cannot read is dropped, which is visible (the select shows "Any
 * severity"). A page param it cannot read is refused, because a dropped
 * `?offset=` is invisible: page one looks the same however you got there.
 */
export function parseAlertHistoryQuery(
  params: URLSearchParams,
): AlertHistoryQuery {
  const asset = params.get("asset")?.trim() ?? "";
  const severity = params.get("severity")?.trim() ?? "";
  const offset = pageParam(params, "offset");
  const limit = pageParam(params, "limit");
  return {
    asset: asset === "" || asset === "all" ? null : asset,
    severity: (SEVERITIES as readonly string[]).includes(severity)
      ? (severity as Severity)
      : null,
    offset: offset.value ?? 0,
    limit: Math.min(
      Math.max(1, limit.value ?? ALERT_HISTORY_PAGE),
      ALERT_HISTORY_MAX_LIMIT,
    ),
    // `offset` leads when both are wrong: it is the one a shared link carries.
    malformed: offset.refusal ?? limit.refusal,
  };
}

/** Absent is absent, a non-negative whole number is the number (clamped by the
 * caller), and anything else is refused verbatim. */
function pageParam(
  params: URLSearchParams,
  param: "offset" | "limit",
): { value: number | null; refusal: AlertHistoryPageRefusal | null } {
  const raw = params.get(param);
  if (raw === null || raw.trim() === "") return { value: null, refusal: null };
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0
    ? { value, refusal: null }
    : { value: null, refusal: { param, value: raw } };
}

/** The query string for one read — the client's half of `parseAlertHistoryQuery`.
 * Defaults are OMITTED, so the unfiltered first page is a bare path and the URL
 * only ever names what the operator actually chose. */
export function alertHistoryQueryString(query: AlertHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.asset !== null) params.set("asset", query.asset);
  if (query.severity !== null) params.set("severity", query.severity);
  if (query.offset > 0) params.set("offset", String(query.offset));
  if (query.limit !== ALERT_HISTORY_PAGE) params.set("limit", String(query.limit));
  // The bad value is asked again verbatim; re-serializing the clamped default
  // would turn a corrupted link into a silent request for page one.
  if (query.malformed !== null) {
    params.set(query.malformed.param, query.malformed.value);
  }
  return params.toString();
}

/** How long a settled alert was open, in milliseconds. Null when the row
 * carries no closing time, so an unmeasurable span renders nothing, not zero. */
export function alertOpenMs(flag: {
  firstFiredAt: string;
  resolvedAt: string | null;
  dispositionAt: string | null;
}): number | null {
  const closed = flag.resolvedAt ?? flag.dispositionAt;
  if (closed === null) return null;
  const from = Date.parse(flag.firstFiredAt);
  const to = Date.parse(closed);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
}
