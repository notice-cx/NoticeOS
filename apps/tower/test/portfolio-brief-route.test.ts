// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { portfolioBriefEvidenceSchema, type PortfolioBriefDomain, type PortfolioBriefEvidence, type PortfolioBriefFact, type PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import type { TowerConfig } from '../worker/config-source';
import { handlePortfolioBriefRequest } from '../worker/portfolio-brief-route';
import { BRIEFING_TICK, runTowerCron, type TowerCronEnv } from '../worker/tower-cron';

const models = vi.hoisted(() => ({ wall: vi.fn(), work: vi.fn(), revenue: vi.fn(), evidence: vi.fn(), readings: vi.fn(), acquisition: vi.fn() }));
vi.mock('../worker/wall-payload', () => ({ buildWallPayload: models.wall }));
vi.mock('../worker/work-payload', () => ({ buildWorkPayload: models.work }));
vi.mock('../worker/daily-revenue', () => ({ loadRevenueHistories: models.revenue }));
vi.mock('../worker/portfolio-brief-evidence', () => ({ buildPortfolioBriefEvidence: models.evidence }));
vi.mock('../worker/portfolio-brief-readings', () => ({ loadPortfolioBriefReadings: models.readings }));
vi.mock('../worker/portfolio-brief-acquisition', () => ({ loadPortfolioBriefAcquisition: models.acquisition }));
const NOW = new Date('2026-11-06T12:00:00Z');
const saved: PortfolioBriefRead = { state: 'awaiting', briefing: null, error: null, stale: false, lastAttemptAt: null, nextAttemptAt: null };
const evidence: PortfolioBriefEvidence = { schemaVersion: 1, asOf: NOW.toISOString(), timeZone: 'UTC', facts: [], insightEvidenceIds: [], limitations: [], coverage: { assets: 0, includedAssets: 0, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } };
function environment(state: PortfolioBriefRead = saved, schedules: TowerConfig['schedules'] = null, selection: string[] | null = null, inventory: {id: string; displayName: string}[] = []) {
  const cfg = { schedules, osTimeZone: 'UTC', beads: { spokes: [] }, portfolioReviewAssetIds: selection } as unknown as TowerConfig;
  const ingest = { portfolioBrief: vi.fn(async () => state), refreshPortfolioBrief: vi.fn(async (_evidence: PortfolioBriefEvidence, _freshnessMs: number): Promise<PortfolioBriefRead> => ({ ...saved, state: 'ready' as const, lastAttemptAt: NOW.toISOString() })) };
  const config = vi.fn(async () => cfg);
  const env = { STORE: {read: vi.fn(async () => inventory)}, INGEST: {}, config: vi.fn(), briefing: { ingest, config } } as unknown as TowerCronEnv;
  return { env, ingest, config };
}
beforeEach(() => {
  vi.clearAllMocks();
  models.wall.mockResolvedValue({ assets: [] }); models.work.mockResolvedValue({ projects: [] });
  models.revenue.mockResolvedValue(new Map()); models.evidence.mockReturnValue(evidence);
  models.readings.mockResolvedValue({ facts: [], insightEvidenceIds: [] });
  models.acquisition.mockResolvedValue({ facts: [], insightEvidenceIds: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('saved portfolio briefing route', () => {
  it('reads only the saved result without building evidence or invoking generation', async () => {
    const { ingest } = environment();
    const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief'), ingest);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(saved);
    expect(ingest.portfolioBrief).toHaveBeenCalledOnce();
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
    expect(models.wall).not.toHaveBeenCalled();
    expect(models.work).not.toHaveBeenCalled(); expect(models.revenue).not.toHaveBeenCalled();
    expect(models.readings).not.toHaveBeenCalled(); expect(models.acquisition).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('rejects %s without reading or generating', async method => {
    const { ingest } = environment();
    const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief', { method }), ingest);
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET');
    expect(ingest.portfolioBrief).not.toHaveBeenCalled(); expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('returns a generic failure for an absent or failed saved reader', async () => {
    for (const ingest of [{}, { portfolioBrief: async () => { throw new Error('private binding details'); } }]) {
      const response = await handlePortfolioBriefRequest(new Request('https://tower.example.com/api/portfolio-brief'), ingest);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'portfolio_brief_unavailable' });
    }
  });
});

describe('manual portfolio briefing orchestration', () => {
  it('builds evidence from the same Tower models and saves an empty review without observations', async () => {
    const { env, ingest } = environment();
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual')).toEqual([expect.objectContaining({ id: 'portfolio-brief', state: 'skipped' })]);
    expect(models.wall).toHaveBeenCalledOnce(); expect(models.work).toHaveBeenCalledOnce(); expect(models.revenue).toHaveBeenCalledOnce();
    expect(models.evidence).toHaveBeenCalledExactlyOnceWith({ assets: [] }, { projects: [] }, { now: NOW, revenueByAsset: new Map(), reviewAssetIds: null });
    expect(ingest.refreshPortfolioBrief).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...evidence, context: expect.objectContaining({ maxBytes: 24_000 }) }), 86_400_000);
    expect(models.readings).toHaveBeenCalledOnce(); expect(models.acquisition).toHaveBeenCalledOnce();
  });
  it.each(['disconnected', 'unsupported'] as const)('does no model or store work when %s', async state => {
    const { env, ingest, config } = environment({ ...saved, state });
    await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual');
    expect(config).not.toHaveBeenCalled(); expect(models.wall).not.toHaveBeenCalled();
    expect(models.work).not.toHaveBeenCalled(); expect(models.revenue).not.toHaveBeenCalled();
    expect(models.readings).not.toHaveBeenCalled(); expect(models.acquisition).not.toHaveBeenCalled(); expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('ignores automatic ticks before reading state or collecting evidence', async () => {
    const { env, ingest, config } = environment();
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW)).toEqual([]);
    expect(ingest.portfolioBrief).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(models.wall).not.toHaveBeenCalled();
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
  it('honours an explicit refresh despite an old paused schedule or retry time', async () => {
    const { env, ingest } = environment({ ...saved, state: 'unavailable', nextAttemptAt: '2026-11-06T12:01:00Z' },
      { 'portfolio-brief': { enabled: false, cron: BRIEFING_TICK } });
    await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual');
    expect(ingest.refreshPortfolioBrief).toHaveBeenCalledOnce();
  });
  it('passes a bounded packet with contemporary questions and retained citations across all six domains', async () => {
    const fact = (domain: PortfolioBriefDomain, index: number): PortfolioBriefFact => ({ id: `${domain}:synthetic-${index}`, label: `${domain} observation`,
      domain, basis: 'current-state', observedAt: NOW.toISOString(), period: null, href: '/health', data: { observation: '観測🙂'.repeat(80) } });
    const base = ['delivery', 'operations'].flatMap(domain => Array.from({ length: 20 }, (_, index) => fact(domain as PortfolioBriefDomain, index)));
    const supplementary = ['finance', 'product', 'outcomes'].flatMap(domain => Array.from({ length: 20 }, (_, index) => fact(domain as PortfolioBriefDomain, index)));
    const acquisition = Array.from({ length: 20 }, (_, index) => fact('acquisition', index));
    models.evidence.mockReturnValue({ ...evidence, facts: base, insightEvidenceIds: base.map(fact => fact.id) });
    models.readings.mockResolvedValue({ facts: supplementary, insightEvidenceIds: supplementary.map(fact => fact.id) });
    models.acquisition.mockResolvedValue({ facts: acquisition, insightEvidenceIds: acquisition.map(fact => fact.id) });
    const { env, ingest } = environment();
    await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual');
    expect(ingest.refreshPortfolioBrief).toHaveBeenCalledOnce();
    const packet = ingest.refreshPortfolioBrief.mock.calls[0]![0] as PortfolioBriefEvidence;
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(24_000);
    expect(packet.context!.domains.map(row => row.domain)).toEqual(['finance', 'acquisition', 'product', 'delivery', 'outcomes', 'operations']);
    for (const domain of packet.context!.domains) {
      expect(domain.question).toMatch(/\?$/);
      expect(domain.availableFacts).toBe(20);
      expect(domain.includedFacts).toBeGreaterThan(0);
      expect(domain.eligibleFacts).toBe(domain.includedFacts);
      expect(domain.omittedFacts).toBe(20 - domain.includedFacts);
    }
    expect(packet.insightEvidenceIds.every(id => packet.facts.some(fact => fact.id === id))).toBe(true);
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  });

  it.each(['readings', 'acquisition'] as const)('keeps the saved briefing and never generates after a %s read failure', async source => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state: PortfolioBriefRead = { ...saved, state: 'ready', lastAttemptAt: '2026-11-06T11:00:00Z',
      briefing: { model: 'saved-model', generatedAt: '2026-11-06T11:00:00Z', evidenceAsOf: '2026-11-06T11:00:00Z',
        result: { headline: 'Review the saved finding', assessment: 'The previous briefing remains available.', insights: [] }, sources: [], limitations: [] } };
    const original = structuredClone(state);
    const { env, ingest } = environment(state);
    models[source].mockRejectedValueOnce(new Error('synthetic unavailable source'));
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual')).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
    expect(state).toEqual(original);
  });

  it('records a returned model failure as a failed step without throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, ingest } = environment();
    ingest.refreshPortfolioBrief.mockResolvedValue({ ...saved, state: 'ready', error: 'generation unavailable' });
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual')).toEqual([expect.objectContaining({ id: 'portfolio-brief', state: 'failed' })]);
    expect(log).toHaveBeenCalledOnce();
  });
  it('does not generate after an evidence read fails or when no briefing binding exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, ingest } = environment(); models.wall.mockRejectedValueOnce(new Error('fixture unavailable'));
    expect(await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual')).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
    await runTowerCron(BRIEFING_TICK, { ...env, briefing: undefined }, () => NOW, 'manual');
    expect(ingest.refreshPortfolioBrief).not.toHaveBeenCalled();
  });
});

it.each([{selection: null}, {selection: ['noticeos']}])('reviews OS inventory without a Wall card with selection $selection', async ({selection}) => {
  const inventory = [{id: 'noticeos', displayName: 'NoticeOS'}];
  const {env, ingest} = environment(saved, null, selection, inventory);
  const fact: PortfolioBriefFact = {id: 'work:noticeos:progress', domain: 'delivery', basis: 'current-state', label: 'NoticeOS delivery',
    href: '/tasks', observedAt: NOW.toISOString(), period: null, data: {asset: 'noticeos', counts: {open: 2}}};
  models.evidence.mockReturnValue({...evidence, reviewAssetIds: selection, facts: [fact], insightEvidenceIds: [fact.id]});
  expect(await runTowerCron(BRIEFING_TICK, env, () => NOW, 'manual')).toEqual([expect.objectContaining({state: 'succeeded'})]);
  expect(models.readings).toHaveBeenCalledWith(env.STORE, expect.objectContaining({assets: inventory, reviewAssetIds: selection}));
  expect(models.acquisition).toHaveBeenCalledWith(env.STORE, expect.objectContaining({assets: inventory}));
  expect(models.revenue).toHaveBeenCalledWith(env.STORE, expect.objectContaining({assets: ['noticeos']}));
  expect(ingest.refreshPortfolioBrief).toHaveBeenCalledWith(expect.objectContaining({reviewAssetIds: selection, insightEvidenceIds: [fact.id]}), expect.any(Number));
});
