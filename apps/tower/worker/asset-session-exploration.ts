import { readJourneyDefinitions } from '@noticeos/contract/journeys';
import { buildSessionExplorationSnapshot, readSessionExplorationReports, type SessionReportReceipt, type SessionExplorationSnapshot } from '@noticeos/contract/session-exploration';
import type { WorkspaceStore } from '@noticeos/postgres';

/** Read stored asset reports only; viewing a journey never queries an analytics provider. */
export async function readAssetSessionExploration(store: WorkspaceStore, asset: string, definitions: unknown, now: Date, timeZone?: string): Promise<SessionExplorationSnapshot[]> {
  const current = (readJourneyDefinitions(definitions) ?? []).filter(d => d.kind === 'exploration');
  if (current.length === 0) return [];
  const rows = await store.read(tx => tx.query<{report: string; generatedAt: string; receivedAt: string}>(
    `SELECT DISTINCT ON (report->>'journeyId', report->>'date')
            report::text AS report, generated_at::text AS "generatedAt", received_at::text AS "receivedAt"
       FROM noticeos.pulses
       CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(envelope->'sessionExploration') = 'array'
         THEN envelope->'sessionExploration' ELSE '[]'::json END) AS report
      WHERE asset_id = $1 AND pulse_date >= $2::date AND pulse_date <= $3::date
        AND report->>'journeyId' = ANY($4::text[]) AND report->>'date' >= $2::text AND report->>'date' < $3::text
      ORDER BY report->>'journeyId', report->>'date', received_at DESC, pulse_id DESC
      LIMIT 1024`,
    [asset, new Date(now.getTime() - 64 * 86_400_000).toISOString().slice(0,10), new Date(now.getTime() + 86_400_000).toISOString().slice(0,10), current.map(d => d.id)],
  ));
  const receipts: SessionReportReceipt[] = [];
  for (const row of rows) {
    try {
      const generatedAt = new Date(row.generatedAt).toISOString(), receivedAt = new Date(row.receivedAt).toISOString();
      const reports = readSessionExplorationReports([JSON.parse(row.report)], generatedAt);
      if (reports) receipts.push({generatedAt, receivedAt, reports: reports.filter(r => current.some(d => d.id === r.journeyId && d.version === r.journeyVersion))});
    } catch { /* Invalid historical reports remain unavailable. */ }
  }
  return current.map(d => buildSessionExplorationSnapshot(d.id, receipts, now, timeZone, d.reportingLagDays));
}
