import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { BRIEFING_TICK, runTowerCron, type TowerCronEnv } from '../worker/tower-cron';
import { withTowerSteps } from '../worker/runner-route';

vi.mock('../worker/wall-payload', () => ({ buildWallPayload: vi.fn(async () => ({ assets: [] })) }));
vi.mock('../worker/work-payload', () => ({ buildWorkPayload: vi.fn(async () => ({})) }));
vi.mock('../worker/daily-revenue', () => ({ loadRevenueHistories: vi.fn(async () => ({})) }));
vi.mock('../worker/portfolio-brief-evidence', () => ({ buildPortfolioBriefEvidence: vi.fn(() => ({ insightEvidenceIds: [] })) }));

describe('manual briefing safeguards', () => {
  it('records insufficient comparable evidence as skipped instead of claiming model generation', async () => {
    const state: PortfolioBriefRead = { state: 'awaiting', nextAttemptAt: null, briefing: null, lastAttemptAt: null, error: null, stale: false };
    const refreshPortfolioBrief = vi.fn(async () => ({ ...state, lastAttemptAt: '2026-11-06T12:00:00.000Z' }));
    const config = vi.fn(async () => ({ schedules: {}, beads: { spokes: [] }, osTimeZone: 'UTC' }));
    const steps = await runTowerCron(BRIEFING_TICK, {
      STORE: {} as WorkspaceStore, INGEST: { listCredentialSummaries: async () => ({ keyPresent: false, keyReason: null, blockers: [], summaries: [] }) }, config,
      briefing: { config, ingest: { portfolioBrief: async () => state, refreshPortfolioBrief } },
    } as unknown as TowerCronEnv, () => new Date('2026-11-06T12:00:00.000Z'), 'manual');
    expect(steps).toMatchObject([{ state: 'skipped', summary: 'No comparable evidence is available for briefing insights' }]);
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
