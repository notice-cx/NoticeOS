import { describe, expect, it } from 'vitest';
import { render, screen, within } from './render';
import { BackupRunDetails } from '@/routes/workflows/BackupRunDetails';
import { backupForRun } from '../vite/workflow-history';
import { BACKUP_PARTS, backupEvidenceFromReport } from '../../../packages/contract/src/backup-evidence.mjs';
import type { WorkflowRun } from '@noticeos/contract';
import { createWorkflowHistoryReader } from '../vite/workflow-history';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const startedAt = '2026-09-09T04:00:00.000Z', finishedAt = '2026-09-09T04:00:26.000Z';
const run: WorkflowRun = { id: `backup@${startedAt}`, workflowId: 'backup', definitionVersion: 1, startedAt, finishedAt, state: 'succeeded', steps: null };
function report() {
  return { startedAt: '2026-09-09T04:00:00.200Z', finishedAt: '2026-09-09T04:00:25.000Z',
    backupSet: { path: '/example/state/.local/backups/2026-09-09', complete: true }, context: 'host',
    locations: { offsite: { path: '/example/Drive/backups/2026-09-09', context: 'host' } },
    stages: Object.fromEntries([...BACKUP_PARTS, 'publication', 'offsite'].map(id => [id, {
      status: id === 'assets' ? 'not_configured' : 'completed', copied: id === 'assets' ? 0 : 8, expected: id === 'assets' ? null : 8,
    }])) };
}
describe('backup run evidence', () => {
  it('reads a matching private report from an isolated installation and rejects its replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'backup-history-'));
    try {
      await mkdir(path.join(root, '.local/logs'), { recursive: true });
      await writeFile(path.join(root, '.local/logs/job-runs.jsonl'), JSON.stringify({ job: 'backup', at: startedAt, outcome: 'ran', ms: 26_000 }) + '\n');
      await writeFile(path.join(root, '.local/backup-report.json'), JSON.stringify(report()));
      const read = createWorkflowHistoryReader(root);
      expect((await read(Date.parse(finishedAt), run.id)).backup?.evidence.local.path).toBe(report().backupSet.path);
      await writeFile(path.join(root, '.local/backup-report.json'), JSON.stringify({ ...report(), startedAt: '2026-09-10T04:00:00.200Z', finishedAt: '2026-09-10T04:00:25.000Z' }));
      expect((await read(Date.parse(finishedAt), run.id)).backup).toBeNull();
      await writeFile(path.join(root, '.local/backup-report.json'), ' '.repeat(256 * 1024 + 1));
      expect((await read(Date.parse(finishedAt), run.id)).backup).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('matches a legacy report only to its containing finished backup execution', () => {
    const r = report();
    expect(backupForRun(run, r)?.source).toBe('report');
    expect(backupForRun({ ...run, workflowId: 'counters' }, r)).toBeNull();
    expect(backupForRun({ ...run, finishedAt: undefined }, r)).toBeNull();
    expect(backupForRun(run, { ...r, startedAt: '2026-09-08T04:00:00.000Z' })).toBeNull();
    expect(backupForRun(run, { ...r, finishedAt: '2026-09-10T04:00:00.000Z' })).toBeNull();
    const overlapping = { ...run, id: 'backup@overlapping', startedAt: '2026-09-09T04:00:00.100Z' };
    expect(backupForRun(run, r, [run, overlapping])).toBeNull();
    expect(backupForRun(overlapping, r, [run, overlapping])).toBeNull();
  });
  it('uses the captured execution after a newer report replaces the latest report', () => {
    const backup = backupEvidenceFromReport(report())!;
    const captured: WorkflowRun = { ...run, steps: [{ id: 'execute', attempt: 1, startedAt, finishedAt, state: 'succeeded',
      output: { version: 1, fields: [], metrics: [], items: [], totalItems: 0, truncated: false, backup } }] };
    expect(backupForRun(captured, { ...report(), startedAt: '2026-09-10T04:00:00.000Z' })?.source).toBe('execution');
  });
  it('shows contents, the actual recorded folders, omitted assets and separate cloud/restore evidence', () => {
    render(<BackupRunDetails run={run} captured={backupForRun(run, report())} pending={false} />);
    expect(screen.getByRole('heading', { name: 'Local backup complete' })).toBeVisible();
    expect(screen.getByText('/example/state/.local/backups/2026-09-09')).toBeVisible();
    expect(screen.getByText('/example/Drive/backups/2026-09-09')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Captured backup contents' });
    expect(within(table).getByRole('row', { name: /Asset databases/ })).toHaveTextContent('None selected');
    expect(within(table).getByRole('row', { name: /Recovery keys and settings/ })).toHaveTextContent('Excluded');
    expect(screen.getByText('Cloud upload: unverified')).toBeVisible();
    expect(screen.getByText('Restore test: unverified')).toBeVisible();
  });
  it('names included assets and shows failed handoff separately from the complete local set', () => {
    const r = report(); r.stages.assets = { status: 'completed', copied: 1, expected: 1, targets: ['example.com'] } as NonNullable<typeof r.stages.assets>;
    r.stages.offsite!.status = 'failed';
    render(<BackupRunDetails run={run} captured={backupForRun(run, r)} pending={false} />);
    expect(screen.getByText('Included: example.com')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Local backup complete' })).toBeVisible();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
  });
  it('does not show another run’s contents or invent locations for an older report', () => {
    const r = report(); delete (r as Partial<typeof r>).locations;
    render(<BackupRunDetails run={run} captured={backupForRun(run, r)} pending={false} />);
    expect(screen.getByText('Folder path was not recorded for this run')).toBeVisible();
  });
  it('shows unavailable evidence instead of a newer run’s inventory', () => {
    const captured = backupForRun(run, report())!;
    render(<BackupRunDetails run={{ ...run, id: 'backup@older' }} captured={captured} pending={false} />);
    expect(screen.getByRole('heading', { name: 'Backup contents unavailable' })).toBeVisible();
    expect(screen.queryByText('/example/Drive/backups/2026-09-09')).toBeNull();
  });
});
