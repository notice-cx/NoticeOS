import { deriveAlertEvidence, type AlertEvidenceResult, type AlertPulseEvidence, type AlertWatchEvidence } from "../shared/alert-evidence";
import { isAttentionEligible } from "../shared/signal-liveness";
import { groupConditionFirings, type ConditionFiring, type ConditionGroup } from "../shared/wall";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";

export interface EvidenceFlagRow extends ConditionFiring {
  kind: string;
  severity: string;
  pulseId?: number | null;
  ruleInputs: string | null;
  resolvedAt?: string | null;
}

export function parseAlertInputs(json: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = json ? JSON.parse(json) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** A site's latest report as the store returns it. */
type LatestReportRow = { id: number; asset: string; date: string; receivedAt: string; envelope: string };

export interface ReviewedCondition<F extends EvidenceFlagRow> extends ConditionGroup<F>, AlertEvidenceResult {}

/** One indexed latest-report seek per requested asset. Malformed latest
 * evidence must NOT fall back to an older good report. Read failures propagate:
 * the payload is unavailable, never a clean queue.
 *
 * The reports are on Postgres (bead ro-ujb9.76.5.2): the latest is the newest
 * day's newest revision, and its id is the DAY's number (`day_number`), as an
 * alert's `pulseId` is — so an alert raised from an earlier revision of the
 * same day still reads as that report's, as it did when D1 kept one row per
 * day. The readback windows are on Postgres too (bead ro-ujb9.76.5.7): one
 * statement for every window the alerts name, where D1 went 80 at a time. */
export async function reviewAlertConditions<F extends EvidenceFlagRow>(
  store: WorkspaceStore, rows: readonly F[], nowMs: number,
): Promise<ReviewedCondition<F>[]> {
  const pulseAssets = [...new Set(rows.filter((row) =>
    ["asset-declared", "flow-poisson-low", "flow-lowvol-window"].includes(row.ruleId),
  ).map((row) => row.asset))];
  const pulses = new Map<string, AlertPulseEvidence>();
  const watches = new Map<string, AlertWatchEvidence>();
  const watchIds = [...new Set(rows.filter((row) => row.ruleId === "watch-window-closed")
    .map((row) => parseAlertInputs(row.ruleInputs)?.watchWindowId)
    .filter((id): id is string => typeof id === "string"))];
  if (pulseAssets.length > 0) {
    const latest = await store.read((tx) =>
      tx.query<LatestReportRow>(
        `SELECT c.day_number::int AS id, a.asset_id AS asset, c.pulse_date::text AS date,
                c.received_at AS "receivedAt", c.envelope::text AS envelope
           FROM noticeos.assets a
           CROSS JOIN LATERAL (
             SELECT p.day_number, p.pulse_date, p.received_at, p.envelope
               FROM noticeos.current_pulses p
              WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
              ORDER BY p.pulse_date DESC, p.received_at DESC, p.pulse_id DESC
              LIMIT 1) c
          WHERE a.asset_id = ANY($1::text[])`,
        [pulseAssets],
      ),
    );
    for (const row of latest) pulses.set(row.asset, { ...row, receivedAt: javascriptInstant(row.receivedAt) });
  }
  if (watchIds.length > 0) {
    const windows = await store.read((tx) =>
      tx.query<{ id: string; asset: string; outcome: string | null; readbackBead: string | null }>(
        `SELECT window_id AS id, asset_id AS asset, outcome, readback_bead AS "readbackBead"
           FROM noticeos.watch_windows
          WHERE window_id = ANY($1::text[])`,
        [watchIds],
      ),
    );
    for (const row of windows) watches.set(`${row.asset}\u0000${row.id}`, row);
  }
  const newestFirst = (left: F, right: F) => {
    const leftAt = Date.parse(left.firedAt);
    const rightAt = Date.parse(right.firedAt);
    return (Number.isFinite(rightAt) ? rightAt : Infinity)
      - (Number.isFinite(leftAt) ? leftAt : Infinity) || right.id - left.id;
  };
  const rank = (severity: string) => severity === "error" ? 0 : severity === "warn" ? 1 : 2;
  return groupConditionFirings(rows).map((condition) => {
    // Input is severity-first, NOT newest-first. Evidence and current severity
    // must come from the latest firing even when yesterday was more severe.
    const row = [...condition.firings].sort(newestFirst)[0]!;
    const ruleInputs = parseAlertInputs(row.ruleInputs);
    const watchId = ruleInputs?.watchWindowId;
    return {
      ...condition,
      latest: row,
      ...deriveAlertEvidence({ ...row, ruleInputs }, nowMs, pulses.get(row.asset) ?? null,
        typeof watchId === "string" ? watches.get(`${row.asset}\u0000${watchId}`) ?? null : null),
    };
  }).sort((left, right) => rank(left.latest.severity) - rank(right.latest.severity)
    || newestFirst(left.latest, right.latest));
}

/** Condition grain on BOTH payloads, matching the actionable rows. Repeated
 * firings remain in occurrences; they do not inflate warning badges. */
export function countAttentionConditions<F extends EvidenceFlagRow>(conditions: readonly ReviewedCondition<F>[]) {
  const counts = new Map<string, { err: number; warn: number; worst: number }>();
  for (const condition of conditions) {
    if (!isAttentionEligible(condition.liveness)) continue;
    const row = condition.latest;
    const item = counts.get(row.asset) ?? { err: 0, warn: 0, worst: 0 };
    if (row.severity === "error") item.err++;
    if (row.severity === "warn") item.warn++;
    item.worst = Math.max(item.worst, row.severity === "error" ? 3 : row.severity === "warn" ? 2 : 0);
    counts.set(row.asset, item);
  }
  return counts;
}
