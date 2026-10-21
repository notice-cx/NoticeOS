import assert from 'node:assert/strict';
import test from 'node:test';
import { backupEvidenceFromReport, isBackupRunEvidence, BACKUP_PARTS } from '../packages/contract/src/backup-evidence.mjs';
import { captureWorkflowOutput, isWorkflowStepOutput } from './workflow-output.mjs';

function report() {
  return { startedAt: '2026-09-09T04:00:00.200Z', finishedAt: '2026-09-09T04:00:25.000Z',
    backupSet: { path: '/state/.local/backups/2026-09-09', complete: true }, context: 'backup-worker',
    locations: { offsite: { path: '/backup-offsite/backups/2026-09-09' } },
    stages: Object.fromEntries([...BACKUP_PARTS, 'publication', 'offsite'].map(id => [id, {
      status: id === 'assets' ? 'not_configured' : 'completed', copied: id === 'assets' ? 0 : 2, expected: id === 'assets' ? null : 2,
      errors: [{ detail: 'private material that must not cross the channel' }],
    }])) };
}
test('projects run contents and destinations without raw report material or current settings', () => {
  const source = report(); source.stages.taskHub.targets = ['example_tasks'];
  source.CREDENTIALS_KEY = 'private fixture marker';
  const evidence = backupEvidenceFromReport(source);
  assert.ok(isBackupRunEvidence(evidence));
  assert.equal(evidence.parts.find(p => p.id === 'assets').status, 'not_configured');
  assert.deepEqual(evidence.parts.find(p => p.id === 'taskHub').targets, ['example_tasks']);
  assert.equal(evidence.local.path, source.backupSet.path);
  assert.equal(evidence.offsite.path, source.locations.offsite.path);
  assert.ok(!JSON.stringify(evidence).includes('private'));
  const output = captureWorkflowOutput({ backup: evidence });
  assert.ok(isWorkflowStepOutput(output));
  assert.deepEqual(output.backup, evidence);
});
test('legacy report omissions stay unknown instead of inventing destinations or contents', () => {
  const source = report(); delete source.context; delete source.locations; delete source.stages.recovery;
  const evidence = backupEvidenceFromReport(source);
  assert.equal(evidence.offsite.path, null);
  assert.equal(evidence.local.context, 'recorded');
  assert.equal(evidence.parts.find(p => p.id === 'recovery').status, 'unrecorded');
});
test('failed handoff remains distinct from a complete local set and incomplete capture', () => {
  const source = report(); source.stages.offsite.status = 'failed';
  const evidence = backupEvidenceFromReport(source);
  assert.equal(evidence.complete, true); assert.equal(evidence.offsite.status, 'failed');
  source.backupSet.complete = false; source.backupSet.path = null; source.stages.publication.status = 'blocked';
  source.stages.assets = { status: 'failed', copied: 1, expected: 2, targets: ['example.com', 'other.example'] };
  assert.equal(backupEvidenceFromReport(source).parts.find(p => p.id === 'assets').copied, 1);
});
test('rejects malformed, oversized and secret-bearing structured evidence', () => {
  const evidence = backupEvidenceFromReport(report());
  for (const mutate of [
    e => { e.token = 'private'; }, e => { e.parts[0].errors = ['private']; },
    e => { e.offsite.path = 'https://user:password@example.test/?token=private'; },
    e => { e.parts[0].copied = 3; }, e => { e.parts[0].expected = -1; },
    e => { e.parts[0].copied = 1; }, e => { e.parts[0].status = 'failed'; },
    e => { e.parts[2].status = 'blocked'; }, e => { e.parts[4].status = 'unrecorded'; },
    e => { e.parts[0].targets = Array(33).fill('example'); e.parts[0].totalTargets = 33; },
    e => { e.finishedAt = 'not-a-date'; }, e => { e.parts.pop(); },
  ]) {
    const bad = structuredClone(evidence); mutate(bad);
    assert.equal(isBackupRunEvidence(bad), false);
    assert.equal(captureWorkflowOutput({ backup: bad }), undefined);
  }
});
