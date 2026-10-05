// GET /api/alerts/history — the portfolio's SETTLED alerts, newest close first
// (bead `ro-ju7f`).
//
// WHY IT IS ITS OWN READ. The wall payload is what a television polls every 60
// seconds and it carries open work only; the asset payload carries one asset's
// `flags.history`. Neither can answer "what alerted last week" across the
// portfolio, and neither should be made to: a paged archive inside a poll would
// ship rows nobody is looking at on every TV refresh, and a cross-asset slice
// bolted onto one asset's payload is a slice that asset does not own.
//
// WHAT IT IS NOT. It is READ-ONLY. Disposition and resolution are
// `flag-actions.ts`'s business and stay there; nothing here writes a row, and
// settled rows are rendered without the action pair for exactly that reason.

import type { AnnotationItem, AnnotationKind } from "../shared/annotations";
import type { FlagRecord } from "../shared/asset-detail";
import {
  CORRELATION_WINDOW_HOURS,
} from "../shared/alert-language";
import {
  type AlertHistoryAsset,
  type AlertHistoryPayload,
  type AlertHistoryQuery,
  type AlertHistoryRow,
  parseAlertHistoryQuery,
} from "../shared/alert-history";
import { assetDisplayName } from "@noticeos/contract/asset-name";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSitesById } from "./asset-registry";
import {
  FLAG_COLUMNS,
  type FlagDbRow,
  flagDbRow,
  toFlagRecord,
} from "./flag-records";
import { readFlagReadings, readingsOf } from "./flag-evidence";
import { loadNotifiedAt, settledAtSql, settledFlagsSql } from "./flag-scope";
import { JSON_HEADERS, jsonError } from "./http";

/**
 * SETTLED, from the one module that defines the three states
 * (`@noticeos/contract`'s `flag-open.ts`) rather than hand-written here.
 *
 * NOT "everything that is not open" (bead `ro-ujb9.194`). That was this read's
 * definition, and it filed an ACTIVE snooze here with the ✓ of a finished thing
 * while the Open view listed the same row under Snoozed — and "Settled · 7d"
 * went up by one for every snooze. A snooze is put off, not decided: it lives
 * under Open until its date, and then it is open again. Nor is a row whose
 * snooze has passed, which is back on the Open list.
 *
 * A row that is merely no longer current is not settled either: it stays open
 * in the store, and the asset page's `notCurrent` list is where it belongs.
 *
 * Carries no `?`: settled is the one state no date moves a row into or out of.
 */
const SETTLED = settledFlagsSql();

/** Ordered by WHEN EACH ROW WAS CLOSED, which is the question the page answers.
 * The alert's own order is the tiebreak: two rows closed in the same
 * millisecond must not be able to swap places between page 1 and page 2. */
const ORDER = `${settledAtSql()} DESC, flag_id DESC`;

type HistoryDbRow = FlagDbRow & {
  asset: string;
};

interface AnnotationDbRow extends Record<string, unknown> {
  id: number;
  asset: string;
  at: string;
  kind: string;
  ref: string | null;
  note: string | null;
}

export interface AlertHistoryDeps {
  now: Date;
}

/** The filter clause and its bound values, built from the parsed query alone —
 * every operator-supplied value is a placeholder, never interpolated. */
function filters(query: AlertHistoryQuery): { sql: string; args: string[] } {
  const clauses = [SETTLED];
  const args: string[] = [];
  if (query.asset !== null) {
    args.push(query.asset);
    clauses.push(`asset_id = $${args.length}`);
  }
  if (query.severity !== null) {
    args.push(query.severity);
    clauses.push(`severity = $${args.length}`);
  }
  return { sql: clauses.join(" AND "), args };
}

export async function buildAlertHistoryPayload(
  /** The call's store: the alerts, the site names and the changes beside
   * them are all on Postgres (beads ro-ujb9.76.4.2, ro-ujb9.76.5.2,
   * ro-ujb9.76.5.7). */
  store: WorkspaceStore,
  query: AlertHistoryQuery,
  deps: AlertHistoryDeps,
): Promise<AlertHistoryPayload> {
  const { sql, args } = filters(query);

  // On Postgres (bead ro-ujb9.76.5.2): every alert as its newest reading
  // states it, known by its workspace number, and never one a same-day report
  // retry replaced — D1 had deleted those.
  const { total, flagRows } = await store.read(async (tx) => {
    const [counted] = await tx.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM noticeos.current_flags WHERE ${sql}`,
      args,
    );
    // No join: the identities are a second, tiny read keyed by the ids this
    // page actually returned — never the whole assets table.
    const rows = await tx.query<HistoryDbRow>(
      `SELECT ${FLAG_COLUMNS}, asset_id AS asset
         FROM noticeos.current_flags
        WHERE ${sql}
        ORDER BY ${ORDER}
        LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, query.limit, query.offset],
    );
    return { total: counted?.total ?? 0, flagRows: rows.map(flagDbRow) };
  });

  const assets = await readAssetIdentities(
    store,
    [...new Set(flagRows.map((row) => row.asset))],
  );
  const changes = await readChanges(store, flagRows);
  // Which of these the operator actually heard about (bead `ro-vu8d.23`) — a
  // settled alert that was never notified is exactly the row worth knowing about
  // when the operator is asking why they only found out by opening the Tower.
  const notifiedAt = await loadNotifiedAt(store, flagRows.map((row) => row.id));
  // Each alert's stored readings (bead `ro-ujb9.220`): a settled outage reads
  // back night by night.
  const readings = await readFlagReadings(store, flagRows.map((row) => row.id));

  const rows: AlertHistoryRow[] = flagRows.map((row) => ({
    // History is one row per FIRING and each row stands for itself, exactly as
    // the asset payload builds it: `occurrences: 1`, aged from its own
    // `fired_at`. Grouping belongs to open conditions, where several firings
    // are one live problem; two rows an operator dispositioned on different
    // days are two decisions and the audit trail must show both.
    flag: {
      ...toFlagRecord(row, changes.get(row.asset) ?? [], {
        occurrences: 1,
        firstFiredAt: row.firedAt,
      }),
      notifiedAt: notifiedAt.get(row.id) ?? null,
      ...readingsOf(readings, row.id),
      liveness: { state: "historical" as const },
    } satisfies FlagRecord,
    asset: assets.get(row.asset) ?? unknownAsset(row.asset),
  }));

  return {
    rows,
    total,
    offset: query.offset,
    limit: query.limit,
    hasMore: query.offset + rows.length < total,
    generatedAt: deps.now.toISOString(),
  };
}

/** An alert whose asset row cannot be read is still an alert. The id IS the
 * name then — never a blank cell, and never a dropped row. */
function unknownAsset(id: string): AlertHistoryAsset {
  return { id, domain: null, displayName: id };
}

async function readAssetIdentities(
  store: WorkspaceStore,
  ids: string[],
): Promise<Map<string, AlertHistoryAsset>> {
  const found = new Map<string, AlertHistoryAsset>();
  for (const row of (await readSitesById(store, ids)).values()) {
    found.set(row.id, {
      id: row.id,
      domain: row.domain,
      displayName: assetDisplayName(row.isOs, row.displayName),
    });
  }
  return found;
}

/**
 * The timeline events that might explain the alerts on THIS page, per asset.
 *
 * One query bounded by the page's own fired-at span rather than one query per
 * asset: twenty-five rows must not become twenty-five round trips. The window
 * is the same 48 hours before onset the asset page uses (`correlateChanges`),
 * so a row's change chip says the same thing on both surfaces.
 */
async function readChanges(
  store: WorkspaceStore,
  flagRows: HistoryDbRow[],
): Promise<Map<string, AnnotationItem[]>> {
  const byAsset = new Map<string, AnnotationItem[]>();
  const times = flagRows
    .map((row) => Date.parse(row.firedAt))
    .filter((t) => !Number.isNaN(t));
  const assets = [...new Set(flagRows.map((row) => row.asset))];
  if (times.length === 0 || assets.length === 0) return byAsset;

  const from = new Date(
    Math.min(...times) - CORRELATION_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  // On Postgres (bead ro-ujb9.76.5.7): the sites as one array, a change by its
  // workspace's number, two at one instant newest-filed first as D1's index
  // gave them.
  const rows = await store.read((tx) =>
    tx.query<AnnotationDbRow>(
      `SELECT annotation_number::int AS id, asset_id AS asset, at, kind, ref, note
         FROM noticeos.annotations
        WHERE asset_id = ANY($1::text[])
          AND at >= $2::timestamptz AND at <= $3::timestamptz
        ORDER BY at DESC, annotation_number DESC`,
      [assets, from, to],
    ),
  );

  for (const row of rows) {
    const list = byAsset.get(row.asset) ?? [];
    list.push({
      id: row.id,
      at: javascriptInstant(row.at),
      kind: row.kind as AnnotationKind,
      ref: row.ref,
      note: row.note,
    });
    byAsset.set(row.asset, list);
  }
  return byAsset;
}

/**
 * The route. GET only, and unauthenticated for the same reason every other
 * `/api/*` read here is: identical evidence, one trust boundary (worker/index.ts).
 *
 * A PAGE PARAM IT CANNOT READ IS REFUSED 400, carrying how much there is to page
 * through (bead `ro-oefa`) — the answer `/api/financials` gives a malformed
 * `?period=`, for the reason that route gives: both params arrive from a URL the
 * operator can share, edit and bookmark, and a corrupted one that quietly lands
 * on page one is indistinguishable from a link that worked.
 */
export async function handleAlertHistoryRequest(
  request: Request,
  url: URL,
  store: WorkspaceStore,
  deps: AlertHistoryDeps,
): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  try {
    const query = parseAlertHistoryQuery(url.searchParams);
    const payload = await buildAlertHistoryPayload(store, query, deps);
    // The read happens FIRST even when the answer is a refusal, which is what
    // lets the 400 state the size of the archive — the same order, and the same
    // trade, `/api/financials` makes to name its months.
    if (query.malformed !== null) {
      return jsonError("page_malformed", 400, {
        total: payload.total,
        limit: payload.limit,
      });
    }
    return Response.json(payload, { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: "alert_history_failed", message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
