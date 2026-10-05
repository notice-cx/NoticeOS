import type { WorkspaceStore } from "@noticeos/postgres";
import { javascriptInstant } from "@noticeos/postgres";
import type { RecommendationSourceEvidence, RecommendationSourceReport } from "../shared/recommendation-validity";
import { signalEvidenceFloor } from "./integration-evidence";

/** Read only the latest attempt for each exact report family. A later error
 * cannot borrow an older success, and provider-wide freshness is not a family
 * manifest. The cap is disclosed; neither empty nor partial grants validity.
 * On Postgres (bead ro-ujb9.76.5.4): of two attempts finished in one instant,
 * the one written last; families listed byte by byte, as D1 listed them. */
export async function readRecommendationSources(store: WorkspaceStore, asset: string, nowMs: number): Promise<RecommendationSourceEvidence> {
  if (!Number.isFinite(new Date(nowMs).getTime())) return { available: false, truncated: false, reports: [] };
  const since = signalEvidenceFloor(nowMs);
  type Latest = { source: string; reportDate: string; collectedAt: string; status: RecommendationSourceReport["status"] };
  try {
    const results = await store.read((tx) =>
      tx.query<Latest>(
        `SELECT integration || '/' || report AS source, report_date AS "reportDate",
                finished_at AS "collectedAt", status
           FROM (
             SELECT DISTINCT ON (integration, report) integration, report, report_date, finished_at, status
               FROM noticeos.archive_runs
              WHERE asset_id = $1 AND finished_at >= $2::timestamptz
              ORDER BY integration, report, finished_at DESC, run_seq DESC
           ) latest
          ORDER BY (integration || '/' || report) COLLATE "C"
          LIMIT 201`,
        [asset, since],
      ),
    );
    const reports = results.map((row) => ({ ...row, collectedAt: javascriptInstant(row.collectedAt) }));
    return { available: true, truncated: reports.length > 200, reports: reports.slice(0, 200), since };
  } catch {
    // A failed read is unknown, never evidence of no new input.
    return { available: false, truncated: false, reports: [], since };
  }
}
