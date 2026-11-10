import { readJourneyDefinitions, type JourneyFunnelResult } from '@noticeos/contract/journeys';
import { buildFirstPartyFunnelResult, readFirstPartyFunnelReports, type FirstPartyFunnelReceipt } from '@noticeos/contract/first-party-funnels';
import type { WorkspaceStore } from '@noticeos/postgres';

/** 12 weekly periods, the current week, the largest reporting lag and a day of slack. */
const HISTORY_DAYS = 13 * 7 + 14 + 1;

/** Read stored asset reports only; viewing a journey never asks the site or a provider. */
export async function readAssetFirstPartyFunnels(store: WorkspaceStore, asset: string, definitions: unknown, now: Date): Promise<JourneyFunnelResult[]> {
  const current = (readJourneyDefinitions(definitions) ?? []).filter(d => d.kind === 'funnel' && d.source === 'first-party' && d.status === 'active');
  if (current.length === 0) return [];
  const from = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const rows = await store.read(tx => tx.query<{ report: string; generatedAt: string; receivedAt: string }>(
    `SELECT DISTINCT ON (report->>'journeyId', report->>'date')
            report::text AS report, generated_at::text AS "generatedAt", received_at::text AS "receivedAt"
       FROM noticeos.pulses
       CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(envelope->'firstPartyFunnels') = 'array'
         THEN envelope->'firstPartyFunnels' ELSE '[]'::json END) AS report
      WHERE asset_id = $1 AND pulse_date >= $2::date AND pulse_date <= $3::date
        AND report->>'journeyId' = ANY($4::text[]) AND report->>'date' >= $2::text AND report->>'date' < $3::text
      ORDER BY report->>'journeyId', report->>'date', received_at DESC, pulse_id DESC
      LIMIT 1024`,
    [asset, from, to, current.map(d => d.id)],
  ));
  const receipts: FirstPartyFunnelReceipt[] = [];
  for (const row of rows) {
    try {
      const generatedAt = new Date(row.generatedAt).toISOString(), receivedAt = new Date(row.receivedAt).toISOString();
      const reports = readFirstPartyFunnelReports([JSON.parse(row.report)], generatedAt);
      if (reports) receipts.push({ generatedAt, receivedAt, reports });
    } catch { /* An invalid stored report leaves its day unavailable. */ }
  }
  return current.flatMap(d => buildFirstPartyFunnelResult(d, receipts, now) ?? []);
}
