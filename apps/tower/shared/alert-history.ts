// The portfolio's SETTLED alerts — what closed, across every asset (bead
// `ro-ju7f`).
//
// The wall payload carries `attention[]`, which is open work and nothing else,
// and each asset's own payload carries `flags.history` for that one asset. So
// "what alerted last week" could only be answered asset by asset, one page at a
// time, and `/alerts` could show what is wrong now but never what was.
//
// This is a NARROW read of its own rather than a slice bolted onto the wall
// payload: the wall payload is polled every 60 seconds by a television, and
// history is a page an operator opens on purpose, pages through, and leaves.
// Putting a paged archive inside a poll would make every TV refresh carry rows
// nobody is looking at.

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

/** One settled alert, with the asset it happened to.
 *
 * `flag` is EXACTLY the asset page's own row shape (`FlagRecord`), so the two
 * surfaces render one component over one type: an alert cannot say one thing on
 * `/alerts/history` and another on its asset's Alerts tab (doc 14, one
 * representation per fact). */
export interface AlertHistoryRow {
  flag: FlagRecord;
  asset: AlertHistoryAsset;
}

/**
 * PAGING IS OFFSET + LIMIT, and it states a total.
 *
 * A cursor is the better shape for an append-only log read newest-first, and
 * `flags` is append-only — but this list is not ordered by insertion. It is
 * ordered by when each row was CLOSED (`COALESCE(resolved_at, disposition_at,
 * fired_at)`), which is a column the operator's own clicks write, so "the next
 * page after this row" is not a stable frontier a cursor could name honestly.
 *
 * The total is the other half. The page an operator opens to answer "what
 * alerted last week" has to say how much there is — `1–25 of 137` — and a
 * cursor cannot produce that without a second count anyway. The volumes are
 * small (the whole store holds hundreds of settled rows, not millions), so the
 * offset scan is cheap and the count is one more index-free pass over the same
 * predicate.
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

/**
 * A page param the URL asked for and this read cannot honour (bead `ro-oefa`).
 *
 * The raw string is kept rather than dropped, because it is the only useful
 * thing to say back to somebody who followed a corrupted link: `“nonsense”` and
 * `“-4”` are visibly different mistakes, and neither is "page one".
 */
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
  /**
   * The page param this read cannot honour, or null when both read.
   *
   * `offset` and `limit` still carry their defaults alongside it, so the route
   * can count the archive it is refusing to page into and say how big it is —
   * the same way `/api/financials` reads the store even for a malformed
   * `?period=` so its 400 can name the months that exist.
   */
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
 * Query string → the read's parameters, clamped.
 *
 * Shared by the Worker (which must never trust a URL) and the browser hook
 * (which builds the same URL from the same state), so a filter the client can
 * express is a filter the server understands, and vice versa.
 *
 * A FILTER it cannot read is DROPPED: `?severity=purple` narrows to nothing a
 * rule can fire, and answering 422 to a stale bookmark would turn a mistyped
 * filter into a broken page. A dropped filter is visible — the select shows
 * "Any severity" and the rows are all of them.
 *
 * A PAGE PARAM it cannot read is REFUSED (bead `ro-oefa`), because the same
 * argument runs the other way: a dropped `?offset=` is INVISIBLE. Page one of
 * the archive looks exactly like page one of the archive however the reader got
 * there, so an operator who shared "page 4" and got page 1 back has no way to
 * see that anything was lost. That is the answer `/api/financials` already
 * gives a malformed `?period=`, and two routes taking the same kind of input
 * should take it the same way.
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

/**
 * ONE RULE for both page params: absent is absent, a non-negative whole number
 * is the number, and anything else is refused verbatim.
 *
 * A readable number that is out of range is still readable — `limit=0` and
 * `limit=100000` clamp above rather than refuse, exactly as a well-formed month
 * the ledger has no rows for is a different answer from a value that is not a
 * month at all.
 */
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
  // THE BAD VALUE IS ASKED AGAIN, VERBATIM (bead `ro-oefa`). Re-serializing the
  // clamped default here would quietly turn a corrupted link into a request for
  // page one — the browser would never see the refusal, and the page it lands
  // on would be the lie this route just stopped telling.
  if (query.malformed !== null) {
    params.set(query.malformed.param, query.malformed.value);
  }
  return params.toString();
}

/**
 * How long a settled alert was open, in milliseconds — the fact neither of its
 * two dates states.
 *
 * "fired 5d ago" and "closed 2d ago" are recencies; the operator's question is
 * which of these dragged on, and that is a DURATION. Null when the row carries
 * no closing time at all (a disposition written before `disposition_at`
 * existed), because an unmeasurable span renders nothing rather than zero.
 */
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
