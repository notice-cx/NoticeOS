// The daily rollup of the integrations matrix — one row per lane per calendar
// day (`noticeos.connection_daily_counts`, bead `ro-78qo.30`).
//
// WHY IT EXISTS. /health states how many connections are working, degraded and
// not set up, and doc 14 asks for a series behind each figure plus a step chart
// of freshness by lane. `buildIntegrationsMatrix` computes all of that at RENDER
// TIME — from `config/integrations.json`, `signal_runs`, open flags and
// `egress_checks` — and kept none of it, so the two figures that are not a
// composition (Degraded, Not set up) had nothing to draw and declared it.
//
// WRITTEN BY THE HOURLY TICK, NOT BY A PAGE LOAD (bead `ro-ujb9.96.7.31`).
// The effective state of a lane is decided by `effectiveLaneState` and its
// loaders, in this Worker; the ingest is a separate build that cannot import
// them, and a history drawn from a second implementation is a line that can
// disagree with the number printed above it. So the recorder is a Tower step
// of the hourly Data freshness checks job (worker/tower-cron.ts), which builds
// the matrix with the page's own derivation (`recordTodaysSourceHistory` in
// integrations-payload.ts) and upserts the day's rows. A day the OS ran has a
// point whether or not anyone opened a page, and building the matrix for a
// page only reads — the same move bead `ro-ujb9.96.7.29` made for System
// health's four counts (connection-status-daily.ts).
//
// ON POSTGRES (`noticeos.connection_daily_counts`, bead ro-ujb9.76.5.6), in the
// call's store. A migrated store has the table, so the write lands and the read
// answers: an empty history means the rollup holds no days yet.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import {
  INTEGRATION_STATES,
  type IntegrationCellBase,
  type IntegrationState,
  type IntegrationsMatrix,
} from "../shared/integrations";
import type { SeriesPoint } from "../shared/wall";

/** How long the rollup keeps a day. Fixed here AND in `model.json`'s retention. */
export const CONNECTION_DAILY_RETENTION_DAYS = 400;

/** A daily line needs three points before it is a shape rather than a segment. */
export const CONNECTION_HISTORY_MIN_POINTS = 3;

/**
 * One lane's day, as the payload carries it.
 *
 * `states` is keyed by `IntegrationState` so a reader can draw any of the five
 * without this module having an opinion about which two /health happens to put
 * in its strip today.
 */
export interface ConnectionDay {
  day: string;
  /** When inside that day the matrix was built — the instant the freshness
   * ages below are measured from. */
  observedAt: string;
  states: Record<IntegrationState, number>;
  /** The newest dated evidence this lane carried that day, or null when it
   * carried none — which is not the same as evidence dated long ago. */
  newestEvidenceAt: string | null;
}

export interface ConnectionHistory {
  /** One entry per lane the rollup holds days for. */
  byLane: Map<string, ConnectionDay[]>;
  /** How many distinct calendar days the table holds, across every lane. */
  days: number;
}

type DailyRow = {
  source: string;
  day: string;
  observedAt: string;
  live: number;
  degraded: number;
  needsSetup: number;
  skipped: number;
  notApplicable: number;
  newestEvidenceAt: string | null;
};

/** Empty counts, so no caller special-cases a missing state key. */
function emptyStates(): Record<IntegrationState, number> {
  return { live: 0, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0 };
}

/**
 * What one lane looked like across every asset column, right now.
 *
 * PER LANE RATHER THAN PER CELL because neither question /health asks is
 * per-asset: the strip sums the states across everything, and the freshness
 * chart draws one line per lane. Summing these rows over a day reproduces the
 * strip's own counts exactly, so the history cannot disagree with the headline.
 */
export function laneDay(cells: IntegrationCellBase[]): {
  states: Record<IntegrationState, number>;
  newestEvidenceAt: string | null;
} {
  const states = emptyStates();
  let newest: string | null = null;
  for (const cell of cells) {
    states[cell.effective] += 1;
    for (const evidence of cell.evidence) {
      // An undated piece of evidence is real evidence whose time context lives
      // in its sentence; it just cannot move a freshness line.
      if (evidence.at && (newest === null || evidence.at > newest)) newest = evidence.at;
    }
  }
  return { states, newestEvidenceAt: newest };
}

/** Every lane on the matrix, declared and derived, with its cells. */
type MatrixLanes = Pick<IntegrationsMatrix, "catalog" | "assets" | "cells" | "derivedLanes">;

export function matrixLanes(matrix: MatrixLanes): Map<string, IntegrationCellBase[]> {
  const byLane = new Map<string, IntegrationCellBase[]>();
  for (let index = 0; index < matrix.catalog.length; index += 1) {
    const lane = matrix.catalog[index]!;
    const cells: IntegrationCellBase[] = [];
    for (const asset of matrix.assets) {
      // `cells[asset]` is aligned index-for-index with `catalog`, which is the
      // matrix's own documented invariant — the join is positional and there is
      // no lane id on a cell to match on.
      const cell = matrix.cells[asset.id]?.[index];
      if (cell) cells.push(cell);
    }
    byLane.set(lane.id, cells);
  }
  for (const derived of matrix.derivedLanes) {
    byLane.set(derived.catalog.id, Object.values(derived.cells));
  }
  return byLane;
}

const UPSERT = `INSERT INTO noticeos.connection_daily_counts AS kept
       (workspace_id, source, day, observed_at, live, degraded, needs_setup, skipped, not_applicable,
        newest_evidence_at)
     VALUES ($1::uuid, $2, $3::date, $4::timestamptz, $5, $6, $7, $8, $9, $10::timestamptz)
     ON CONFLICT (workspace_id, source, day) DO UPDATE SET
       observed_at        = excluded.observed_at,
       live               = excluded.live,
       degraded           = excluded.degraded,
       needs_setup        = excluded.needs_setup,
       skipped            = excluded.skipped,
       not_applicable     = excluded.not_applicable,
       newest_evidence_at = excluded.newest_evidence_at
      WHERE excluded.observed_at >= kept.observed_at`;

/**
 * Write today's row for every lane on the matrix, and drop the days past
 * retention, in one transaction. Returns how many lanes it wrote.
 *
 * The upsert refuses an observation OLDER than the one already stored, so two
 * ticks finishing out of order cannot walk the day backwards.
 */
export async function recordConnectionDay(
  store: WorkspaceStore,
  matrix: MatrixLanes,
  now: Date,
): Promise<number> {
  const observedAt = now.toISOString();
  const day = observedAt.slice(0, 10);
  const cutoff = new Date(now.getTime() - CONNECTION_DAILY_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return store.write(async (tx) => {
    let written = 0;
    for (const [lane, cells] of matrixLanes(matrix)) {
      // A lane with no columns at all is not an observation of anything.
      if (cells.length === 0) continue;
      written += 1;
      const { states, newestEvidenceAt } = laneDay(cells);
      await tx.execute(UPSERT, [
        tx.workspaceId,
        lane,
        day,
        observedAt,
        states.live,
        states.degraded,
        states["needs-setup"],
        states.skipped,
        states["not-applicable"],
        newestEvidenceAt,
      ]);
    }
    await tx.execute(`DELETE FROM noticeos.connection_daily_counts WHERE day < $1::date`, [cutoff]);
    return written;
  });
}

/**
 * Every day the rollup holds, per lane.
 *
 * One read for the whole window: 400 days across a dozen lanes is a few
 * thousand short rows, and a query per lane would be a dozen round trips to
 * save nothing.
 */
export async function loadConnectionHistory(store: WorkspaceStore): Promise<ConnectionHistory> {
  const rows = await store.read((tx) =>
    tx.query<DailyRow>(
      `SELECT source,
              day,
              observed_at        AS "observedAt",
              live,
              degraded,
              needs_setup        AS "needsSetup",
              skipped,
              not_applicable     AS "notApplicable",
              newest_evidence_at AS "newestEvidenceAt"
         FROM noticeos.connection_daily_counts
        ORDER BY day ASC, source COLLATE "C" ASC`,
    ),
  );

  const byLane = new Map<string, ConnectionDay[]>();
  const days = new Set<string>();
  for (const row of rows) {
    if (typeof row.source !== "string" || typeof row.day !== "string") continue;
    days.add(row.day);
    const list = byLane.get(row.source) ?? [];
    list.push({
      day: row.day,
      observedAt: javascriptInstant(row.observedAt),
      states: {
        live: Number(row.live) || 0,
        degraded: Number(row.degraded) || 0,
        "needs-setup": Number(row.needsSetup) || 0,
        skipped: Number(row.skipped) || 0,
        "not-applicable": Number(row.notApplicable) || 0,
      },
      newestEvidenceAt: row.newestEvidenceAt === null ? null : javascriptInstant(row.newestEvidenceAt),
    });
    byLane.set(row.source, list);
  }
  return { byLane, days: days.size };
}

/**
 * The portfolio's series per state — the strip's own numbers, day by day.
 *
 * Every lane that has a row for a day contributes to it, and a lane that has
 * none contributes nothing: one build of the matrix writes a row for every lane
 * it could see, so in the ordinary case the days line up and this costs
 * nothing. Where they do not — a lane added to the register last Tuesday — the
 * earlier days are simply smaller by a lane that did not exist, which is what
 * happened rather than a hole in every series at once.
 */
export function portfolioSeries(
  history: ConnectionHistory,
): Record<IntegrationState, SeriesPoint[]> {
  const byDay = new Map<string, Record<IntegrationState, number>>();
  for (const days of history.byLane.values()) {
    for (const entry of days) {
      const cell = byDay.get(entry.day) ?? emptyStates();
      for (const state of INTEGRATION_STATES) cell[state] += entry.states[state];
      byDay.set(entry.day, cell);
    }
  }
  const ordered = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = {} as Record<IntegrationState, SeriesPoint[]>;
  for (const state of INTEGRATION_STATES) {
    out[state] = ordered.map(([day, counts]) => ({ t: day, v: counts[state] }));
  }
  return out;
}

/**
 * How stale each lane's evidence was, day by day — doc 14's freshness-by-lane
 * step chart, in hours.
 *
 * The age is measured from the instant the day was OBSERVED rather than from
 * midnight or from now: it is the number /health already prints beside each
 * lane ("2d ago"), recorded rather than recomputed, so the chart and the strip
 * beside it are the same measurement.
 *
 * A day whose lane carried no dated evidence at all is left OUT of that lane's
 * series. It is not "infinitely stale" and it is certainly not fresh; it is a
 * day the lane gave nothing to date, and the honest drawing of that is a gap.
 */
export function freshnessSeries(history: ConnectionHistory): { source: string; points: SeriesPoint[] }[] {
  const out: { source: string; points: SeriesPoint[] }[] = [];
  for (const [lane, days] of history.byLane) {
    const points: SeriesPoint[] = [];
    for (const entry of days) {
      if (!entry.newestEvidenceAt) continue;
      const observedMs = Date.parse(entry.observedAt);
      const evidenceMs = Date.parse(entry.newestEvidenceAt);
      if (!Number.isFinite(observedMs) || !Number.isFinite(evidenceMs)) continue;
      // Negative would mean evidence dated after the observation that read it —
      // a provider clock ahead of ours. Floored at zero: "as fresh as it gets"
      // is the only honest reading, and a negative age would draw below the
      // axis.
      points.push({ t: entry.day, v: Math.max(0, (observedMs - evidenceMs) / 3_600_000) });
    }
    if (points.length > 0) out.push({ source: lane, points });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

/** The recorded history, as the payload carries it. */
export function connectionHistoryPayload(history: ConnectionHistory): {
  days: number;
  states: Record<IntegrationState, SeriesPoint[]>;
  sources: { source: string; points: SeriesPoint[] }[];
} {
  return {
    days: history.days,
    states: portfolioSeries(history),
    sources: freshnessSeries(history),
  };
}
