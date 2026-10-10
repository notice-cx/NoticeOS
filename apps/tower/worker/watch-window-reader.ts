import type {
  WatchOutcome,
  WatchSlice,
  WatchWindowItem,
} from "../shared/asset-detail";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { storedWatchScope, watchVerdictFigures } from "../shared/watch-windows";
import { isTaskId } from "../shared/tasks";

// A window's offsets are an integer array; the offsets it has read are its rows
// in `watch_window_readings`.
interface WatchWindowStoreRow extends Record<string, unknown> {
  id: string;
  metricIntegration: string;
  metric: string;
  scopeJson: string | null;
  refKind: string;
  ref: string;
  registeredAt: string;
  checkOffsets: number[];
  readOffsets: number[];
  status: string;
  outcome: string | null;
  outcomeNote: string | null;
  closedAt: string | null;
  note: string | null;
  readbackBead: string | null;
}

/** A few recent answers contextualize open watches without becoming history. */
const CLOSED_WATCH_LIMIT = 4;

function addDaysUTC(iso: string, days: number): string | null {
  const time = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function toWatchWindowItem(row: WatchWindowStoreRow): WatchWindowItem {
  const offsets = [...row.checkOffsets].sort((a, b) => a - b);
  const alreadyRead = new Set(row.readOffsets);
  const nextOffset = offsets.find((offset) => !alreadyRead.has(offset));
  return {
    id: row.id,
    metricIntegration: row.metricIntegration as WatchWindowItem["metricIntegration"],
    metric: row.metric,
    scope: storedWatchScope(row.scopeJson),
    refKind: row.refKind as WatchWindowItem["refKind"],
    ref: row.ref,
    registeredAt: row.registeredAt,
    nextCheckDate:
      nextOffset === undefined ? null : addDaysUTC(row.registeredAt, nextOffset),
    readings: alreadyRead.size,
    checks: offsets.length,
    status: row.status === "closed" ? "closed" : "open",
    outcome: (row.outcome as WatchOutcome | null) ?? null,
    outcomeNote: watchVerdictFigures(row.outcomeNote, row.metricIntegration, row.metric),
    closedAt: row.closedAt,
    note: row.note,
    ...(isTaskId(row.readbackBead) ? { readbackTaskId: row.readbackBead } : {}),
  };
}

/** One asset's full read for its detail-page timeline, on its (site, ref)
 * index; each window's read offsets through the readings' key. */
export const WATCH_WINDOWS_SQL = `SELECT w.window_id AS id, w.metric_integration AS "metricIntegration", w.metric,
       w.scope::text AS "scopeJson", w.ref_kind AS "refKind", w.ref, w.registered_at AS "registeredAt",
       w.check_offsets AS "checkOffsets",
       ARRAY(SELECT r.offset_days FROM noticeos.watch_window_readings r
              WHERE r.workspace_id = w.workspace_id AND r.window_id = w.window_id
              ORDER BY r.offset_days) AS "readOffsets",
       w.status, w.outcome, w.outcome_note AS "outcomeNote", w.closed_at AS "closedAt", w.note,
       w.readback_bead AS "readbackBead"
  FROM noticeos.watch_windows w
 WHERE w.asset_id = $1
 ORDER BY w.status ASC, w.registered_at DESC, w.window_id COLLATE "C" ASC`;

/** One asset's full read for its detail-page timeline. */
export async function readWatchWindows(store: WorkspaceStore, asset: string): Promise<WatchSlice> {
  const rows = (await store.read((tx) => tx.query<WatchWindowStoreRow>(WATCH_WINDOWS_SQL, [asset]))).map(
    (row) => ({
      ...row,
      registeredAt: javascriptInstant(row.registeredAt),
      closedAt: row.closedAt === null ? null : javascriptInstant(row.closedAt),
    }),
  );

  const open = rows
    .filter((row) => row.status !== "closed")
    .map(toWatchWindowItem)
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  const closed = rows
    .filter((row) => row.status === "closed")
    .map(toWatchWindowItem)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, CLOSED_WATCH_LIMIT);
  return { open, closed, history: [] };
}
