import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import type { AlertDailyPayload } from "../shared/alert-daily";
import { JSON_HEADERS, jsonError } from "./http";

type SnapshotRow = { day: string; observedAt: string; open: number; errors: number; warnings: number };

export async function buildAlertDailyPayload(store: WorkspaceStore, now: Date): Promise<AlertDailyPayload> {
  // The portfolio row already includes every open alert. Adding site rows to
  // it would double-count, and warnings + errors can omit other severities.
  const rows = await store.read((tx) => tx.query<SnapshotRow>(`
    SELECT day, observed_at AS "observedAt", open, errors, warnings
      FROM noticeos.alert_daily_counts
     WHERE asset_id IS NULL
     ORDER BY day ASC`));
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: AlertDailyPayload["days"] = [];
  if (rows.length > 0) {
    const last = Date.parse(`${rows.at(-1)!.day}T00:00:00Z`);
    for (let at = Date.parse(`${rows[0]!.day}T00:00:00Z`); at <= last; at += 86_400_000) {
      const day = new Date(at).toISOString().slice(0, 10);
      const row = byDay.get(day);
      days.push(row ? { ...row, observedAt: javascriptInstant(row.observedAt) }
        : { day, observedAt: null, open: null, errors: null, warnings: null });
    }
  }
  return { generatedAt: now.toISOString(), days };
}

export async function handleAlertDailyRequest(request: Request, store: WorkspaceStore, now: Date): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  try {
    return Response.json(await buildAlertDailyPayload(store, now), { headers: JSON_HEADERS });
  } catch {
    return jsonError("alert_daily_read_failed", 500);
  }
}
