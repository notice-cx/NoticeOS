import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioBriefEvidence, PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import type { TowerConfig } from '../worker/config-source';
import { handlePortfolioBriefRequest } from '../worker/portfolio-brief-route';
import { BRIEFING_TICK, runTowerCron, type TowerCronEnv } from '../worker/tower-cron';

const models = vi.hoisted(() => ({ wall: vi.fn(), work: vi.fn(), revenue: vi.fn(), evidence: vi.fn() }));
vi.mock('../worker/wall-payload', () => ({ buildWallPayload: models.wall }));
vi.mock('../worker/work-payload', () => ({ buildWorkPayload: models.work }));
vi.mock('../worker/daily-revenue', () => ({ loadRevenueHistories: models.revenue }));
vi.mock('../worker/portfolio-brief-evidence', () => ({ buildPortfolioBriefEvidence: models.evidence }));
const NOW = new Date('2026-11-06T12:00:00Z');
const saved: PortfolioBriefRead = { state: 'awaiting', briefing: null, error: null, stale: false, lastAttemptAt: null, nextAttemptAt: null };
const evidence: PortfolioBriefEvidence = { schemaVersion: 1, asOf: NOW.toISOString(), timeZone: 'UTC', facts: [], limitations: [], coverage: { assets: 0, includedAssets: 0, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } };
function environment(state: PortfolioBriefRead = saved, schedules: TowerConfig['schedules'] = null) {
  const cfg = { schedules, osTimeZone: 'UTC', beads: { spokes: [] } } as unknown as TowerConfig;
  const ingest = { portfolioBrief: vi.fn(async () => state), refreshPortfolioBrief: vi.fn(async () => ({ ...saved, state: 'ready' as const })) };
  const config = vi.fn(async () => cfg);
  const env = { STORE: {}, INGEST: {}, config: vi.fn(), briefing: { ingest, config } } as unknown as TowerCronEnv;
  return { env, ingest, config };
}
beforeEach(() => {
  vi.clearAllMocks();
  models.wall.mockResolvedValue({ assets: [] }); models.work.mockResolvedValue({ projects: [] });
  models.revenue.mockResolvedValue(new Map()); models.evidence.mockReturnValue(evidence);
});
afterEach(() => vi.restoreAllMocks());

describe('cached portfolio briefing route', () => {
  it('reads only the saved result without building evidence or invoking generation', async () => {
    const { ingest } = environment();
    const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief'), ingest);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(saved);
    expect(ingest.portfolioBrief).toHaveBeenCalledOnce();
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
    expect(models.wall).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('rejects %s without reading or generating', async method => {
    const { ingest } = environment();
    const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief', { method }), ingest);
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET');
    expect(ingest.portfolioBrief).not.toHaveBeenCalled(); expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('returns a generic failure for an absent or failed cached reader', async () => {
    for (const ingest of [{}, { portfolioBrief: async () => { throw new Error('private binding details'); } }]) {
      const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief'), ingest);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'portfolio_brief_unavailable' });
    }
  });
});

describe('background portfolio briefing orchestration', () => {
  it('builds evidence from the same Tower models, then requests one scheduled generation', async () => {
    const { env, ingest } = environment();
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW)).toEqual([expect.objectContaining({ id: 'portfolio-brief', state: 'succeeded' })]);
    expect(models.wall).toHaveBeenCalledOnce(); expect(models.work).toHaveBeenCalledOnce(); expect(models.revenue).toHaveBeenCalledOnce();
    expect(models.evidence).toHaveBeenCalledExactlyOnceWith({ assets: [] }, { projects: [] }, { now: NOW, revenueByAsset: new Map() });
    expect(ingest.refreshPortfolioBrief).toHaveBeenCalledExactlyOnceWith(evidence, 3_600_000);
  });
  it.each(['disconnected', 'unsupported'] as const)('does no model or store work when %s', async state => {
    const { env, ingest, config } = environment({ ...saved, state });
    await runTowerCron(BRIEFING_TICK, env, () => NOW);
    expect(config).not.toHaveBeenCalled(); expect(models.wall).not.toHaveBeenCalled(); expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('does not collect evidence or generate when the saved schedule is paused', async () => {
    const { env, ingest } = environment(saved, { 'portfolio-brief': { enabled: false, cron: BRIEFING_TICK } });
    await runTowerCron(BRIEFING_TICK, env, () => NOW);
    expect(models.wall).not.toHaveBeenCalled(); expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('waits until the next attempt and retries failed generations once that time arrives', async () => {
    const waiting = environment({ ...saved, state: 'unavailable', nextAttemptAt: '2026-11-06T12:01:00Z' });
    await runTowerCron(BRIEFING_TICK, waiting.env, () => NOW);
    expect(waiting.ingest.refreshPortfolioBrief).not.toHaveBeenCalled(); expect(models.wall).not.toHaveBeenCalled();
    await runTowerCron(BRIEFING_TICK, waiting.env, () => new Date('2026-11-06T12:01:00Z'));
    expect(waiting.ingest.refreshPortfolioBrief).toHaveBeenCalledOnce();
  });
  it('records a returned model failure as a failed step without throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, ingest } = environment();
    ingest.refreshPortfolioBrief.mockResolvedValue({ ...saved, state: 'ready', error: 'generation unavailable' });
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW)).toEqual([expect.objectContaining({ id: 'portfolio-brief', state: 'failed' })]);
    expect(log).toHaveBeenCalledOnce();
  });
  it('does not generate after an evidence read fails or when no briefing binding exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, ingest } = environment(); models.wall.mockRejectedValueOnce(new Error('fixture unavailable'));
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
    await runTowerCron(BRIEFING_TICK, { ...env, briefing: undefined }, () => NOW);
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
});
