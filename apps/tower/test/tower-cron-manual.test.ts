import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { BRIEFING_TICK, HOURLY_TICK, runTowerCron, type TowerCronEnv } from '../worker/tower-cron';
import { withTowerSteps } from '../worker/runner-route';
import { portfolioBriefFailure } from '../../../scripts/portfolio-brief-failure.mjs';
import { buildWorkflowHistory } from '../../../scripts/workflow-history-view.mjs';

vi.mock('../worker/connection-status-daily', async importOriginal => ({ ...await importOriginal<typeof import('../worker/connection-status-daily')>(), recordTodaysConnectionCounts: vi.fn(async () => ({ written: 1 })) }));
vi.mock('../worker/integrations-payload', async importOriginal => ({ ...await importOriginal<typeof import('../worker/integrations-payload')>(), recordTodaysSourceHistory: vi.fn(async () => ({ outcome: 'ran', written: 1 })) }));
vi.mock('../worker/wall-payload', () => ({ buildWallPayload: vi.fn(async () => ({ assets: [] })) }));
vi.mock('../worker/work-payload', () => ({ buildWorkPayload: vi.fn(async () => ({})) }));
vi.mock('../worker/daily-revenue', () => ({ loadRevenueHistories: vi.fn(async () => ({})) }));
vi.mock('../worker/portfolio-brief-readings', () => ({ loadPortfolioBriefReadings: vi.fn(async () => ({ facts: [], insightEvidenceIds: [] })) }));
vi.mock('../worker/portfolio-brief-acquisition', () => ({ loadPortfolioBriefAcquisition: vi.fn(async () => ({ facts: [], insightEvidenceIds: [] })) }));
vi.mock('../worker/portfolio-brief-evidence', () => ({ buildPortfolioBriefEvidence: vi.fn(() => ({
  schemaVersion: 1, asOf: '2026-11-06T12:00:00.000Z', timeZone: 'UTC', facts: [], insightEvidenceIds: [], limitations: [],
  coverage: { assets: 0, includedAssets: 0, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 },
})) }));

describe('manual briefing safeguards', () => {
  it('preserves the model failure and next step through the saved workflow history', async () => {
    const state: PortfolioBriefRead = { state: 'awaiting', nextAttemptAt: null, briefing: null, lastAttemptAt: null, error: null, stale: false };
    const failure = { kind: 'timeout' as const };
    const detail = portfolioBriefFailure(failure);
    const diagnostics = {
      input: { text: 'Actual model prompt and supplied observations', truncated: false, redacted: false },
      output: { text: 'Actual unfinished model answer', truncated: true, redacted: false },
      error: { text: 'The request timed out', truncated: false, redacted: false },
    };
    const refreshPortfolioBrief = vi.fn(async () => ({ ...state, state: 'unavailable' as const, lastAttemptAt: '2026-11-06T12:00:00.000Z', error: detail.summary, failure, diagnostics }));
    const config = vi.fn(async () => ({ schedules: {}, beads: { spokes: [] }, osTimeZone: 'UTC' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const steps = await runTowerCron(BRIEFING_TICK, {
        STORE: {} as WorkspaceStore, INGEST: { listCredentialSummaries: async () => ({ keyPresent: false, keyReason: null, blockers: [], summaries: [] }) }, config,
        briefing: { config, ingest: { portfolioBrief: async () => state, refreshPortfolioBrief } },
      } as unknown as TowerCronEnv, () => new Date('2026-11-06T12:00:00.000Z'), 'manual');
      expect(steps).toMatchObject([{ state: 'failed', summary: detail.summary, output: { fields: [
        { key: 'reason', label: 'Reason', value: detail.summary }, { key: 'nextAction', label: 'Next step', value: detail.action },
      ] } }]);
      expect(withTowerSteps({ outcome: 'ran', detail: 'Execution completed', steps: [] }, steps)).toMatchObject({ outcome: 'failed', detail: detail.summary });
      const run = { id: 'portfolio-brief@manual/2026-11-06T12:00:00.000Z', workflowId: 'portfolio-brief', definitionVersion: 1,
        startedAt: steps[0]!.startedAt, finishedAt: steps[0]!.finishedAt, state: 'failed', trigger: { kind: 'manual' }, steps };
      const history = buildWorkflowHistory([], [run], [], Date.now() + 1000, run.id);
      expect(history.selectedRun?.steps).toEqual(steps);
      expect(history.selectedRun?.steps?.[0]?.diagnostics).toEqual(diagnostics);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(detail.summary));
    } finally { log.mockRestore(); }
  });
  it('records insufficient recent observations as skipped instead of claiming model generation', async () => {
    const state: PortfolioBriefRead = { state: 'awaiting', nextAttemptAt: null, briefing: null, lastAttemptAt: null, error: null, stale: false };
    const refreshPortfolioBrief = vi.fn(async () => ({ ...state, lastAttemptAt: '2026-11-06T12:00:00.000Z' }));
    const config = vi.fn(async () => ({ schedules: {}, beads: { spokes: [] }, osTimeZone: 'UTC' }));
    const steps = await runTowerCron(BRIEFING_TICK, {
      STORE: {} as WorkspaceStore, INGEST: { listCredentialSummaries: async () => ({ keyPresent: false, keyReason: null, blockers: [], summaries: [] }) }, config,
      briefing: { config, ingest: { portfolioBrief: async () => state, refreshPortfolioBrief } },
    } as unknown as TowerCronEnv, () => new Date('2026-11-06T12:00:00.000Z'), 'manual');
    expect(steps).toMatchObject([{ state: 'skipped', summary: 'No recent observations are available for briefing insights' }]);
    expect(refreshPortfolioBrief).toHaveBeenCalledOnce();
  });
  it.each([
    ['disconnected', null, 'Connect a model provider before generating a briefing'],
    ['unsupported', null, 'Briefing generation is unavailable'],
    ['ready', '2026-11-06T12:15:00.000Z', 'Briefing generation is limited to once every 15 minutes'],
  ] as const)('records %s as skipped without generating', async (state, nextAttemptAt, summary) => {
    const refreshPortfolioBrief = vi.fn();
    const config = vi.fn();
    const steps = await runTowerCron(BRIEFING_TICK, {
      STORE: {} as WorkspaceStore, INGEST: { listCredentialSummaries: async () => ({ keyPresent: false, keyReason: null, blockers: [], summaries: [] }) }, config,
      briefing: { config, ingest: {
        portfolioBrief: async () => ({ state, nextAttemptAt, briefing: null, lastAttemptAt: null, error: null, stale: false } as PortfolioBriefRead),
        refreshPortfolioBrief,
      } },
    } satisfies TowerCronEnv, () => new Date('2026-11-06T12:00:00.000Z'), 'manual');
    expect(steps).toMatchObject([{ id: 'portfolio-brief', state: 'skipped', summary }]);
    expect(withTowerSteps({ outcome: 'ran', detail: 'Execution completed', steps: [{ id: 'config', state: 'succeeded', startedAt: '', attempt: 1 }] }, steps))
      .toMatchObject({ outcome: 'skipped', detail: summary });
    expect(refreshPortfolioBrief).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  });
});


it('captures source-history timing and asset keys without retaining account configuration', async () => {
  const accountId = 'private-account-fixture-947318265';
  const at = new Date('2026-11-06T12:00:00.000Z');
  const config = vi.fn(async () => ({ integrations: { catalog: [], assets: { 'example.com': { ga4: { ga4PropertyId: accountId } } } },
    pullConfig: [{ asset: 'example.com', accountId }], monthlyCaps: { dataUsd: 10 }, serpPanel: { assets: { 'example.com': { accountId } } } }));
  const steps = await runTowerCron(HOURLY_TICK, { STORE: {} as WorkspaceStore, INGEST: {}, config } as unknown as TowerCronEnv, () => at);
  const source = steps.find(step => step.id === 'source-history')!;
  expect(source.state).toBe('succeeded');
  expect(JSON.parse(source.diagnostics!.input!.text)).toEqual({ now: at.toISOString(), assets: ['example.com'] });
  expect(JSON.stringify(steps)).not.toContain(accountId);
  expect(source.diagnostics!.input!.text).not.toContain('monthlyCaps');
  expect(source.diagnostics!.input!.text).not.toContain('pullConfig');
});
