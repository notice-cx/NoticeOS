import { env } from 'cloudflare:test';
import { openWorkspaceStore } from '@noticeos/postgres';
import { PORTFOLIO_BRIEF_ABSTENTION, type PortfolioBriefEvidence } from '@noticeos/contract/portfolio-brief';
import { beforeEach, expect, it, vi } from 'vitest';
import { putCredential, deleteCredential } from '../src/credentials.js';
import { readPortfolioBrief, refreshPortfolioBrief } from '../src/portfolio-brief.js';
import { asOwner, reset } from './helpers.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;
const fields = { LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_MODEL_ID: 'synthetic-model' };
const selected = () => ({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' });
const evidence = (at = NOW): PortfolioBriefEvidence => ({ schemaVersion: 1, asOf: new Date(at).toISOString(), timeZone: 'UTC',
  facts: [{ id: 'asset:example', label: 'Example report', href: '/assets/example', observedAt: new Date(at).toISOString(), period: null,
    data: { trafficChangePercent: 50, revenueChangePercent: -20, complete: true } }], insightEvidenceIds: ['asset:example'], limitations: ['Synthetic evidence only.'],
  coverage: { assets: 1, includedAssets: 1, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } });
const result = () => ({ headline: 'Review the available evidence', assessment: 'Coverage supports a focused review.', insights: [{
  observation: 'The report has complete traffic coverage.', why: 'This permits checking changes against other reported outcomes.',
  action: 'Compare the complete report with the next revenue report.', evidenceIds: ['asset:example'], confidence: 'medium',
}] });
const response = (value: unknown = result()) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
function memoryCache() {
  const entries = new Map<string, Response>();
  const key = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);
  const cache = {
    match: vi.fn(async (input: RequestInfo | URL) => entries.get(key(input))?.clone()),
    put: vi.fn(async (input: RequestInfo | URL, value: Response) => { entries.set(key(input), value.clone()); }),
    delete: vi.fn(async (input: RequestInfo | URL) => entries.delete(key(input))),
  } as unknown as Cache;
  return cache;
}
async function connect(target: IngestEnv = selected(), model = fields.LOCAL_MODEL_ID) {
  expect(await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_ID: model } })).toMatchObject({ ok: true });
}
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
beforeEach(reset);

it('reads an empty or populated cache without ever asking the model', async () => {
  const target = selected();
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  expect(await readPortfolioBrief(target, { cache, fetchImpl })).toMatchObject({ state: 'disconnected', briefing: null });
  await connect(target);
  expect(await readPortfolioBrief(target, { cache, fetchImpl })).toMatchObject({ state: 'awaiting', briefing: null });
  expect(fetchImpl).not.toHaveBeenCalled();
  const refreshed = await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
  expect(refreshed).toMatchObject({ state: 'ready', briefing: { model: fields.LOCAL_MODEL_ID, result: result() } });
  expect(refreshed.briefing?.sources[0]).not.toHaveProperty('data');
  expect(await readPortfolioBrief(target, { cache, fetchImpl, clock: () => NOW })).toEqual(refreshed);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('publishes an empty evidence review without a model call when no comparison qualifies', async () => {
  const target = selected(); await connect(target);
  const packet = evidence(); packet.insightEvidenceIds = [];
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const reviewed = await refreshPortfolioBrief(target, packet, HOUR, { cache, fetchImpl, clock: () => NOW });
  expect(reviewed).toMatchObject({ state: 'ready', briefing: { model: null, result: PORTFOLIO_BRIEF_ABSTENTION }, error: null });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await readPortfolioBrief(target, { cache, clock: () => NOW })).toEqual(reviewed);
  const observations = await target.STORE.read(tx => tx.query(
    "SELECT 1 FROM noticeos.integration_capability_state s JOIN noticeos.capability_targets t USING(workspace_id,target_seq) WHERE t.capability = 'portfolio-brief'"));
  expect(observations).toHaveLength(0);
});

it('replaces earlier insights when evidence becomes insufficient and resumes when comparisons return', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
  const empty = evidence(NOW + HOUR); empty.insightEvidenceIds = [];
  expect(await refreshPortfolioBrief(target, empty, HOUR, { cache, fetchImpl, clock: () => NOW + HOUR }))
    .toMatchObject({ state: 'ready', briefing: { model: null, result: { insights: [] } } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await refreshPortfolioBrief(target, evidence(NOW + 2 * HOUR), HOUR, { cache, fetchImpl, clock: () => NOW + 2 * HOUR }))
    .toMatchObject({ state: 'ready', briefing: { model: fields.LOCAL_MODEL_ID, result: result() } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('rejects insights citing only static context even if the packet also has a meaningful change', async () => {
  const target = selected(); await connect(target);
  const packet = evidence(); packet.facts.push({ ...packet.facts[0]!, id: 'context', data: { bookedRevenue: 100 } });
  const invalid = result(); invalid.insights[0]!.evidenceIds = ['context'];
  expect(await refreshPortfolioBrief(target, packet, HOUR, { cache: memoryCache(), fetchImpl: async () => response(invalid), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null });
});

it('coordinates concurrent refreshes through the database and enforces cooldown even after cache loss', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const started = gate<void>(), finished = gate<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => { started.release(); return finished.promise; });
  const first = refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
  await started.promise;
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW })).toMatchObject({ state: 'awaiting' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  finished.release(response());
  expect(await first).toMatchObject({ state: 'ready' });
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW + 1_000 })).toMatchObject({ state: 'ready' });
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { cache: memoryCache(), fetchImpl, clock: () => NOW + 1_000 })).toMatchObject({ state: 'awaiting' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const leases = await target.STORE.read(tx => tx.query<{ cooldown_until: string }>('SELECT cooldown_until FROM noticeos.integration_leases WHERE lease_key LIKE $1', ['portfolio-brief:%']));
  expect(leases).toHaveLength(1);
  expect(Date.parse(leases[0]!.cooldown_until)).toBe(NOW + 15 * 60_000);
});

it('keeps the last good briefing after a failed refresh and suppresses retries until cooldown ends', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('private model endpoint'));
  const good = await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
  const later = NOW + HOUR;
  const failed = await refreshPortfolioBrief(target, evidence(later), HOUR, { cache, fetchImpl, clock: () => later });
  expect(failed).toMatchObject({ state: 'unavailable', briefing: good.briefing, stale: true,
    nextAttemptAt: new Date(later + 15 * 60_000).toISOString(), error: 'The local model could not complete the briefing.' });
  expect(JSON.stringify(failed)).not.toContain('private model endpoint');
  expect(await refreshPortfolioBrief(target, evidence(later + 60_000), HOUR, { cache, fetchImpl, clock: () => later + 60_000 })).toEqual(failed);
  expect(await readPortfolioBrief(target, { cache, clock: () => later + 60_000 })).toEqual(failed);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each(['unknown-citation', 'malformed', 'oversized', 'too-many-words', 'too-many-insights', 'unfinished-sentence'])('never publishes %s model output', async kind => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const invalid = result();
  if (kind === 'unknown-citation') invalid.insights[0]!.evidenceIds = ['not-in-evidence'];
  if (kind === 'malformed') invalid.insights[0]!.confidence = 'certain';
  if (kind === 'too-many-words') invalid.assessment = 'word '.repeat(200).trim();
  if (kind === 'too-many-insights') invalid.insights = Array.from({ length: 3 }, () => ({ ...invalid.insights[0]! }));
  if (kind === 'unfinished-sentence') invalid.assessment = 'Reporting coverage is complete, but';
  const fetchImpl = vi.fn<typeof fetch>(async () => kind === 'oversized' ? new Response('x'.repeat(1_048_577)) : response(invalid));
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW })).toMatchObject({ state: 'unavailable', briefing: null });
  expect((await readPortfolioBrief(target, { cache, clock: () => NOW })).briefing).toBeNull();
});

it.each(['reconnect', 'disconnect'])('hides an in-flight result after %s', async action => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const started = gate<void>(), finished = gate<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => { started.release(); return finished.promise; });
  const pending = refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
  await started.promise;
  if (action === 'reconnect') await connect(target, 'replacement-model');
  else await deleteCredential(target, 'local-model');
  finished.release(response());
  expect((await pending).briefing).toBeNull();
  expect(await readPortfolioBrief(target, { cache, clock: () => NOW })).toMatchObject({ state: action === 'reconnect' ? 'awaiting' : 'disconnected', briefing: null });
});

it('isolates shared cache and leases between workspaces with identical model configuration', async () => {
  const target = selected(); await connect(target);
  const workspaceId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES('${workspaceId}','brief-fixture','Brief fixture')`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  const other = { ...target, STORE: store };
  try {
    await connect(other);
    const cache = memoryCache();
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW });
    expect(await readPortfolioBrief(other, { cache, clock: () => NOW })).toMatchObject({ state: 'awaiting', briefing: null });
    expect(await refreshPortfolioBrief(other, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW })).toMatchObject({ state: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await store.close();
    await asOwner(['integration_health_events', 'integration_capability_state', 'capability_targets', 'integration_leases', 'connection_secrets', 'integration_connections', 'workspace_counters', 'workspaces']
      .map(table => `DELETE FROM noticeos.${table} WHERE workspace_id='${workspaceId}';`).join('\n'));
  }
});

it.each(['hosted', 'demo'])('blocks %s reads and refresh before network or cache access', async profile => {
  const target = { ...env, NOTICEOS_WORKSPACE_PROFILE: profile };
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await readPortfolioBrief(target, { cache, fetchImpl })).toMatchObject({ state: 'unsupported', briefing: null });
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { cache, fetchImpl, clock: () => NOW })).toMatchObject({ state: 'unsupported', briefing: null });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(cache.match).not.toHaveBeenCalled();
});

it('rejects stale, oversized or invalid evidence before inference', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(refreshPortfolioBrief(target, evidence(NOW - 6 * 60_000), HOUR, { cache, fetchImpl, clock: () => NOW })).rejects.toThrow('not current');
  const large = evidence(); large.facts[0]!.data = { text: 'x'.repeat(100_001) };
  await expect(refreshPortfolioBrief(target, large, HOUR, { cache, fetchImpl, clock: () => NOW })).rejects.toThrow('limit');
  const invalid = evidence(); invalid.facts.push(invalid.facts[0]!);
  await expect(refreshPortfolioBrief(target, invalid, HOUR, { cache, fetchImpl, clock: () => NOW })).rejects.toThrow();
  const unknown = evidence(); unknown.insightEvidenceIds = ['missing'];
  await expect(refreshPortfolioBrief(target, unknown, HOUR, { cache, fetchImpl, clock: () => NOW })).rejects.toThrow('supplied facts');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('retains cached briefings across supported long refresh intervals', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const puts = vi.spyOn(cache, 'put');
  await refreshPortfolioBrief(target, evidence(), 32 * 86_400_000, { cache, fetchImpl: async () => response(), clock: () => NOW });
  const stored = puts.mock.calls[0]?.[1];
  expect(stored?.headers.get('cache-control')).toBe('max-age=5529600');
});


it('does not let the longest schedule gap suppress shorter scheduled intervals', async () => {
  const target = selected(); await connect(target);
  const cache = memoryCache();
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const weekendGap = 72 * HOUR;
  const first = await refreshPortfolioBrief(target, evidence(), weekendGap, { cache, fetchImpl, clock: () => NOW });
  expect(first.nextAttemptAt).toBe(new Date(NOW + 15 * 60_000).toISOString());
  const tomorrow = NOW + 24 * HOUR;
  expect(await refreshPortfolioBrief(target, evidence(tomorrow), weekendGap, { cache, fetchImpl, clock: () => tomorrow })).toMatchObject({ state: 'ready' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const health = await target.STORE.read(tx => tx.query<{ next_attempt_at: string | null }>(
    "SELECT s.next_attempt_at FROM noticeos.integration_capability_state s JOIN noticeos.capability_targets t USING(workspace_id,target_seq) WHERE t.capability = 'portfolio-brief'"));
  expect(health).toHaveLength(1);
  expect(health[0]!.next_attempt_at).toBeNull();
});
