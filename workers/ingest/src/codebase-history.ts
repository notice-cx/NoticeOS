import { type CodebaseHistoryImport } from '@noticeos/contract';
import { releaseAnnotationNote } from '@noticeos/contract/release-annotations';
import type { WorkspaceStore } from '@noticeos/postgres';
import { holdCondition } from './alert-store.js';

/** One transaction per bounded bundle. A retry reads the existing identities;
 * snapshots never replace an existing day, and no alert writer runs here. */
export async function importCodebaseHistory(store: WorkspaceStore, bundle: CodebaseHistoryImport, preview: boolean, now = new Date()) {
  return store.write(async tx => {
    await holdCondition(tx, bundle.asset, 'codebase-history');
    const [latest] = await tx.query<{ date: string | null }>(
      `SELECT max(report_date)::text AS date FROM noticeos.codebase_reports WHERE asset_id = $1`, [bundle.asset]);
    const result = { reports: 0, releases: 0, skippedReports: 0, skippedReleases: 0, preview, alertsChanged: 0 };
    const reportDays = new Set<string>();
    for (const report of bundle.reports) {
      const effectiveAt = report.history!.effectiveAt;
      const day = new Date(effectiveAt).toISOString().slice(0, 10);
      if (Date.parse(report.generatedAt) > now.getTime() + 300_000 || Date.parse(effectiveAt) > now.getTime()) throw new Error('history contains a future report');
      const existing = await tx.query(`SELECT 1 FROM noticeos.codebase_reports WHERE asset_id = $1 AND report_date = $2::date`, [bundle.asset, day]);
      if (existing.length || reportDays.has(day)) { result.skippedReports++; continue; }
      if (!latest?.date || day >= latest.date) throw new Error('send a current report first; imported dates must be earlier than the latest stored report');
      reportDays.add(day);
      result.reports++;
      if (preview) continue;
      await holdCondition(tx, bundle.asset, `codebase-report:${day}`);
      await tx.execute(`INSERT INTO noticeos.codebase_reports
        (workspace_id, asset_id, report_date, revision, commit, ref, generated_at, received_at, envelope)
        VALUES ($1::uuid, $2, $3::date, 1, $4, $5, $6::timestamptz, $7::timestamptz, $8::json)`,
      [tx.workspaceId, bundle.asset, day, report.repository.commit, report.repository.ref, report.generatedAt, now.toISOString(), JSON.stringify(report)]);
    }
    const releaseIds = new Set<string>();
    for (const release of bundle.releases) {
      const at = release.deployedAt ?? release.recordedAt;
      if (Math.max(Date.parse(at), Date.parse(release.recordedAt)) > now.getTime() + 300_000) throw new Error('history contains a future release');
      const note = releaseAnnotationNote(release);
      const existing = await tx.query(`SELECT 1 FROM noticeos.annotations WHERE asset_id = $1 AND note = $2`, [bundle.asset, note]);
      if (existing.length || releaseIds.has(note)) { result.skippedReleases++; continue; }
      releaseIds.add(note);
      result.releases++;
      if (preview) continue;
      await tx.execute(`INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
        VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6)`,
      [tx.workspaceId, bundle.asset, at, release.deployedAt ? 'deploy' : 'external', release.commit, note]);
    }
    return result;
  });
}
