import { env } from 'cloudflare:test';
import { openWorkspaceStore } from '@noticeos/postgres';
import { PORTFOLIO_BRIEF_ABSTENTION, portfolioBriefFactOpening, type PortfolioBriefEvidence, type PortfolioBriefRead, type PortfolioBriefRefreshRead } from '@noticeos/contract/portfolio-brief';
import { beforeEach, expect, it, vi } from 'vitest';
import { putCredential, deleteCredential } from '../src/credentials.js';
import { readPortfolioBrief, refreshPortfolioBrief } from '../src/portfolio-brief.js';
import { asOwner, reset, emptyTables } from './helpers.js';
import { MODEL_GENERATION_TIMEOUT_MS, portfolioBriefFailure } from '../../../scripts/portfolio-brief-failure.mjs';
import { forgetConfigCache } from '../src/config-store.js';
import { LocalModelError } from '../src/local-model.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;
const comparison = { current: { start: '2026-10-30', end: '2026-11-05' }, previous: { start: '2026-10-23', end: '2026-10-29' }, timeZone: 'UTC' };
const SECRET = 'fixture-diagnostic-token-marker';
const fields = { LOCAL_MODEL_API_TOKEN: SECRET, LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_MODEL_ID: 'synthetic-model' };
const selected = () => ({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' });
const evidence = (at = NOW): PortfolioBriefEvidence => ({ schemaVersion: 1, asOf: new Date(at).toISOString(), timeZone: 'UTC',
  facts: [{ id: 'asset:example', label: 'Example report', href: '/assets/example', observedAt: new Date(at).toISOString(), period: null, comparison,
    data: { trafficChangePercent: 50, revenueChangePercent: -20, complete: true } }], insightEvidenceIds: ['asset:example'], limitations: ['Synthetic evidence only.'],
  coverage: { assets: 1, includedAssets: 1, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } });
const result = () => ({ headline: 'Review the available evidence', assessment: 'Coverage supports a focused review.', insights: [{
  title: 'Investigate the yield change',
  observation: 'Over the latest 7 days versus the previous 7, traffic rose while revenue fell.', why: 'This warrants checking the relationship between traffic and revenue.',
  action: 'Compare the complete report with the next revenue report.', evidenceIds: ['asset:example'],
}] });
const prose = (value = result(), packet = evidence()): string => value.insights.length === 0 ? 'NO_INSIGHTS' : [
  `Headline: ${value.headline}`, `Summary: ${value.assessment}`,
  ...value.insights.map(insight => [
    `## ${insight.title}`, `Sources: ${insight.evidenceIds.map(id => { const index = packet.facts.findIndex(fact => fact.id === id); return index < 0 ? 'S999' : `S${index + 1}`; }).join(', ')}`,
    `Observation: ${insight.observation}`, `Why: ${insight.why}`, `Next: ${insight.action}`,
  ].join('\n')),
].join('\n');
const response = (value: ReturnType<typeof result> | string = result(), packet = evidence()) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : prose(value, packet) } }] });
function readOnlyResult(value: PortfolioBriefRefreshRead): PortfolioBriefRead {
  const { diagnostics: _diagnostics, ...read } = value;
  return read;
}
async function connect(target: IngestEnv = selected(), model = fields.LOCAL_MODEL_ID) {
  expect(await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_ID: model } })).toMatchObject({ ok: true });
}
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
beforeEach(async () => { await reset(); await emptyTables(['config_changes', 'config_documents']); forgetConfigCache(); });

it('reads durable saved briefings without asking the model', async () => {
  const target = selected();

  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  expect(await readPortfolioBrief(target, { fetchImpl })).toMatchObject({ state: 'disconnected', briefing: null });
  await connect(target);
  expect(await readPortfolioBrief(target, { fetchImpl })).toMatchObject({ state: 'awaiting', briefing: null });
  expect(fetchImpl).not.toHaveBeenCalled();
  const refreshed = await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  expect(refreshed).toMatchObject({ state: 'ready', briefing: { model: fields.LOCAL_MODEL_ID, result: result() } });
  expect(refreshed.briefing?.sources[0]).not.toHaveProperty('data');
  expect(refreshed.briefing?.sources[0]?.comparison).toEqual(comparison);
  expect(await readPortfolioBrief(target, { fetchImpl, clock: () => NOW })).toEqual(readOnlyResult(refreshed));
  expect(refreshed.diagnostics?.input?.text).toContain('Sources:');
  expect(refreshed.diagnostics?.output?.text).toContain('Headline:');
  expect(await readPortfolioBrief(target, { clock: () => NOW })).not.toHaveProperty('diagnostics');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('publishes an empty evidence review without a model call when no comparison qualifies', async () => {
  const target = selected(); await connect(target);
  const packet = evidence(); packet.insightEvidenceIds = [];

  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const reviewed = await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl, clock: () => NOW });
  expect(reviewed).toMatchObject({ state: 'ready', briefing: { model: null, result: PORTFOLIO_BRIEF_ABSTENTION }, error: null });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toEqual(readOnlyResult(reviewed));
  const observations = await target.STORE.read(tx => tx.query(
    "SELECT 1 FROM noticeos.integration_capability_state s JOIN noticeos.capability_targets t USING(workspace_id,target_seq) WHERE t.capability = 'portfolio-brief'"));
  expect(observations).toHaveLength(0);
});

it('replaces earlier insights when evidence becomes insufficient and resumes when comparisons return', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  const empty = evidence(NOW + HOUR); empty.insightEvidenceIds = [];
  expect(await refreshPortfolioBrief(target, empty, HOUR, { fetchImpl, clock: () => NOW + HOUR }))
    .toMatchObject({ state: 'ready', briefing: { model: null, result: { insights: [] } } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await refreshPortfolioBrief(target, evidence(NOW + 2 * HOUR), HOUR, { fetchImpl, clock: () => NOW + 2 * HOUR }))
    .toMatchObject({ state: 'ready', briefing: { model: fields.LOCAL_MODEL_ID, result: result() } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('rejects insights citing only static context even if the packet also has a meaningful change', async () => {
  const target = selected(); await connect(target);
  const packet = evidence(); packet.facts.push({ ...packet.facts[0]!, id: 'context', data: { bookedRevenue: 100 } });
  const invalid = result(); invalid.insights[0]!.evidenceIds = ['context'];
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl: async () => response(invalid, packet), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'briefing-sources' } });
});

it('coordinates concurrent refreshes and permits a new explicit run after completion', async () => {
  const target = selected(); await connect(target);
  const started = gate<void>(), finished = gate<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => { started.release(); return finished.promise; });
  const first = refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  await started.promise;
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW })).toMatchObject({ state: 'awaiting' });
  const pastOldLease = NOW + 4 * 60_000;
  expect(await refreshPortfolioBrief(target, evidence(pastOldLease), HOUR, { fetchImpl, clock: () => pastOldLease })).toMatchObject({ state: 'awaiting' });
  const active = await target.STORE.read(tx => tx.query<{ expires_at: string }>('SELECT expires_at FROM noticeos.integration_leases WHERE lease_key LIKE $1', ['portfolio-brief:%']));
  expect(Date.parse(active[0]!.expires_at)).toBe(NOW + MODEL_GENERATION_TIMEOUT_MS + 60_000);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  finished.release(response());
  expect(await first).toMatchObject({ state: 'ready' });
  fetchImpl.mockImplementation(async () => response());
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW + 1_000 })).toMatchObject({ state: 'ready' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('discards a late answer after its lease expires and a newer run publishes', async () => {
  const target = selected(); await connect(target);
  const started = gate<void>(), finished = gate<Response>();
  const first = refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => { started.release(); return finished.promise; } });
  await started.promise;
  await target.STORE.write(tx => tx.execute(
    'UPDATE noticeos.integration_leases SET expires_at = $1 WHERE lease_key LIKE $2',
    [new Date(NOW - 1), 'portfolio-brief:%']));
  const later = NOW + 1_000;
  const newer = await refreshPortfolioBrief(target, evidence(later), HOUR, { clock: () => later, fetchImpl: async () => response() });
  finished.release(response());
  expect(readOnlyResult(await first)).toEqual(readOnlyResult(newer));
  expect(await readPortfolioBrief(target, { clock: () => later })).toEqual(readOnlyResult(newer));
});

it('keeps the last good briefing after a failed refresh and permits an explicit retry', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error(`Connection refused at ${fields.LOCAL_MODEL_BASE_URL} ${SECRET}`)).mockResolvedValueOnce(response());
  const good = await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  const later = NOW + HOUR;
  const failed = await refreshPortfolioBrief(target, evidence(later), HOUR, { fetchImpl, clock: () => later });
  expect(failed).toMatchObject({ state: 'unavailable', briefing: good.briefing, stale: true,
    nextAttemptAt: null, error: portfolioBriefFailure({ kind: 'network' }).summary, failure: { kind: 'network' } });
  expect(failed.diagnostics?.error?.text).toContain('Connection refused');
  expect(failed.diagnostics?.error?.text).toContain('network');
  expect(failed.diagnostics?.error?.redacted).toBe(true);
  expect(JSON.stringify(failed)).not.toContain(SECRET);
  expect(failed.diagnostics?.error?.text).toContain(fields.LOCAL_MODEL_BASE_URL);
  expect(JSON.stringify(readOnlyResult(failed))).not.toContain('Connection refused');
  expect(await readPortfolioBrief(target, { clock: () => later + 60_000 })).toEqual(readOnlyResult(failed));
  expect(await refreshPortfolioBrief(target, evidence(later + 60_000), HOUR, { fetchImpl, clock: () => later + 60_000 })).toMatchObject({ state: 'ready', error: null, nextAttemptAt: null });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it.each([
  [401, 'access'], [429, 'rate-limited'], [404, 'not-found'], [302, 'redirect'], [503, 'network'],
] as const)('persists safe %s model failure details without provider response text', async (status, kind) => {
  const target = selected(); await connect(target);
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, {
    clock: () => NOW, fetchImpl: async () => new Response(`private provider response ${SECRET} ${fields.LOCAL_MODEL_BASE_URL}`, { status }),
  });
  expect(failed).toMatchObject({ state: 'unavailable', failure: { kind, status }, error: portfolioBriefFailure({ kind }).summary });
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toEqual(readOnlyResult(failed));
  expect(failed.diagnostics?.output?.text).toContain('private provider response');
  expect(failed.diagnostics?.output?.redacted).toBe(true);
  expect(JSON.stringify(failed)).not.toContain(SECRET);
  expect(failed.diagnostics?.output?.text).toContain(fields.LOCAL_MODEL_BASE_URL);
  expect(JSON.stringify(await readPortfolioBrief(target, { clock: () => NOW }))).not.toContain('private provider response');
});

it('keeps malformed prose out of the saved Home briefing while capturing the actual response', async () => {
  const target = selected(); await connect(target);
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => response('private malformed prose without the required sections') });
  expect(failed).toMatchObject({ state: 'unavailable', failure: { kind: 'briefing-format' } });
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toEqual(readOnlyResult(failed));
  expect(failed.diagnostics?.output?.text).toContain('private malformed prose');
  expect(JSON.stringify(await readPortfolioBrief(target, { clock: () => NOW }))).not.toContain('private malformed prose');
});

it('reports reasoning-only budget exhaustion and retains the actual usage for troubleshooting', async () => {
  const target = selected(); await connect(target);
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: {
      content: '', reasoning_content: 'Synthetic reasoning that reached the generation limit.',
    } }], usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } } }) });
  expect(failed).toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'reasoning-limit' } });
  expect(failed.error).toBe(portfolioBriefFailure({ kind: 'reasoning-limit' }).summary);
  expect(failed.diagnostics?.output?.text).toContain('reasoning_tokens');
});

it('redacts the trimmed token sent to the provider from captured error bodies', async () => {
  const target = selected();
  expect(await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_API_TOKEN: `  ${SECRET}  ` } })).toMatchObject({ ok: true });
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => new Response(`Rejected ${SECRET}`, { status: 401 }) });
  expect(failed.diagnostics?.output?.text).toContain('Rejected [REDACTED]');
  expect(JSON.stringify(failed)).not.toContain(SECRET);
});

it('redacts a credential fragment at the raw response preview boundary', async () => {
  const target = selected();
  const token = 'sensitive-diagnostic-boundary-'.repeat(32);
  expect(await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_API_TOKEN: token } })).toMatchObject({ ok: true });
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => new Response(`${'x'.repeat(65_400)}${token}`, { status: 401 }) });
  expect(failed.diagnostics?.output).toMatchObject({ truncated: true, redacted: true });
  expect(failed.diagnostics?.output?.text).not.toContain('sensitive-diagnostic-boundary-');
});

it('does not treat a clipped API-address prefix as credential material', async () => {
  const target = selected(); await connect(target);
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => new Response(`${'x'.repeat(65_535)}h trailing`, { status: 401 }) });
  expect(failed.diagnostics?.output).toMatchObject({ truncated: true, redacted: false });
});

it('persists the bounded timeout classification without exception details', async () => {
  const target = selected(); await connect(target);
  const failed = await refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => { throw new LocalModelError('timeout'); } });
  expect(failed).toMatchObject({ state: 'unavailable', failure: { kind: 'timeout' }, error: portfolioBriefFailure({ kind: 'timeout' }).summary });
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toEqual(readOnlyResult(failed));
});

it.each([
  ['unknown-citation', 'briefing-sources'], ['malformed', 'briefing-format'], ['oversized', 'too-large'],
  ['too-many-words', 'briefing-length'], ['oversized-field', 'briefing-length'], ['too-many-insights', 'briefing-length'],
  ['wrong-current-period', 'briefing-periods'], ['wrong-baseline', 'briefing-periods'],
] as const)('never publishes %s model output', async (kind, failure) => {
  const target = selected(); await connect(target);
  const invalid = result();
  if (kind === 'unknown-citation') invalid.insights[0]!.evidenceIds = ['not-in-evidence'];
  if (kind === 'oversized-field') invalid.headline = 'x'.repeat(141);
  if (kind === 'too-many-words') invalid.assessment = 'word '.repeat(361).trim();
  if (kind === 'too-many-insights') invalid.insights = Array.from({ length: 4 }, () => ({ ...invalid.insights[0]! }));
  if (kind === 'wrong-current-period') invalid.insights[0]!.observation = 'Over the latest 30 days versus the previous 7, traffic rose while revenue fell.';
  if (kind === 'wrong-baseline') invalid.insights[0]!.observation = 'Over the latest 7 days versus the previous 30, traffic rose while revenue fell.';
  const fetchImpl = vi.fn<typeof fetch>(async () => kind === 'oversized' ? new Response('x'.repeat(1_048_577)) : kind === 'malformed' ? response('Headline: Missing the required sections') : response(invalid));
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: failure } });
  expect((await readPortfolioBrief(target, { clock: () => NOW })).briefing).toBeNull();
});

it('accepts formatted prose without JSON response mode or model confidence', async () => {
  const target = selected(); await connect(target);
  const valid = result();
  valid.headline = 'Review the yield change';
  valid.assessment = 'Traffic and revenue moved apart';
  valid.insights[0]!.observation = 'Traffic rose. Revenue fell';
  valid.insights[0]!.why = 'The relationship deserves a closer look';
  valid.insights[0]!.action = 'Compare revenue across traffic sources';
  const packet = evidence();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).not.toHaveProperty('response_format');
    return response(valid, packet);
  });
  const ready = await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl, clock: () => NOW });
  expect(ready).toMatchObject({ state: 'ready', briefing: { result: {
    headline: valid.headline, assessment: `${valid.assessment}.`, insights: [{ title: valid.insights[0]!.title,
      observation: `${portfolioBriefFactOpening(packet.facts[0]!)}Traffic rose. Revenue fell.`,
      why: `${valid.insights[0]!.why}.`, action: `${valid.insights[0]!.action}.`, evidenceIds: ['asset:example'] }],
  } } });
  expect(ready.briefing?.result.insights[0]).not.toHaveProperty('confidence');
});

it('binds narrative periods to cited source windows before caching a result', async () => {
  const target = selected(); await connect(target);
  const packet = evidence();
  packet.facts.push({ ...packet.facts[0]!, id: 'second', comparison: { ...comparison, timeZone: 'Europe/Paris' } });
  packet.insightEvidenceIds.push('second');
  const mixed = result(); mixed.insights[0]!.evidenceIds.push('second');
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl: async () => response(mixed, packet), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'briefing-periods' } });
});

it('accepts multiple citations sharing the same comparison and supplies a bounded natural opening', async () => {
  const target = selected(); await connect(target);
  const packet = evidence(); packet.facts.push({ ...packet.facts[0]!, id: 'second' });
  packet.insightEvidenceIds.push('second');
  const valid = result(); valid.insights[0]!.evidenceIds.push('second');
  const fetchImpl = vi.fn<typeof fetch>(async () => response(valid, packet));
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl, clock: () => NOW }))
    .toMatchObject({ state: 'ready', briefing: { result: valid } });
});

it.each(['task-dependency', 'current-state', 'period-observation'] as const)('lets %s evidence reach editorial judgment without a traffic comparison', async basis => {
  const target = selected(); await connect(target);
  const packet = evidence();
  packet.facts = [{ id: 'observation', domain: basis === 'period-observation' ? 'product' : 'delivery', basis,
    label: 'Synthetic observation', href: '/tasks', observedAt: packet.asOf,
    period: basis === 'period-observation' ? { start: '2026-10-30', end: '2026-11-05' } : null,
    data: { decision: 'Choose release scope', sampledBlockedDependents: ['example-1', 'example-2'] } }];
  packet.insightEvidenceIds = ['observation'];
  const valid = result();
  valid.insights[0] = { ...valid.insights[0]!, title: 'Review release scope', evidenceIds: ['observation'],
    observation: `${basis === 'period-observation' ? 'Over the 7 days ending Nov 5, ' : 'Currently, '}the supplied observations support a focused review.` };
  const fetchImpl = vi.fn<typeof fetch>(async () => response(valid, packet));
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl, clock: () => NOW }))
    .toMatchObject({ state: 'ready', briefing: { result: valid } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('accepts model abstention even when recent observations are available', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>(async () => response('NO_INSIGHTS'));
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW }))
    .toMatchObject({ state: 'ready', briefing: { result: { insights: [] } } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('rejects an invented prior period for a current operational observation', async () => {
  const target = selected(); await connect(target);
  const packet = evidence();
  packet.facts = [{ id: 'asset:example', basis: 'current-state', label: 'Current dependency', href: '/tasks', observedAt: packet.asOf, period: null, data: {} }];
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl: async () => response(), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'briefing-periods' } });
});

it('does not let current operational context qualify an old comparison as a new insight', async () => {
  const target = selected(); await connect(target);
  const packet = evidence();
  packet.facts.push({ id: 'current', basis: 'current-state', label: 'Current work', href: '/tasks', observedAt: packet.asOf, period: null, data: {} });
  packet.insightEvidenceIds = ['current'];
  const invalid = result(); invalid.insights[0]!.evidenceIds.push('current');
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl: async () => response(invalid, packet), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'briefing-sources' } });
});

it('rejects product observations from different source windows under one timeframe', async () => {
  const target = selected(); await connect(target);
  const packet = evidence();
  packet.facts = ['first', 'second'].map((id, index) => ({ id, basis: 'period-observation' as const, label: 'Product observations', href: '/assets/example.com',
    observedAt: packet.asOf, period: { start: index ? '2026-11-01' : '2026-10-30', end: '2026-11-05' }, data: {} }));
  packet.insightEvidenceIds = ['first', 'second'];
  const invalid = result(); invalid.insights[0]!.evidenceIds = packet.insightEvidenceIds;
  invalid.insights[0]!.observation = 'Over the 7 days ending Nov 5, checkout errors and drop-off increased.';
  expect(await refreshPortfolioBrief(target, packet, HOUR, { fetchImpl: async () => response(invalid, packet), clock: () => NOW }))
    .toMatchObject({ state: 'unavailable', briefing: null, failure: { kind: 'briefing-periods' } });
});

it.each(['reconnect', 'disconnect', 'token-rotation'])('hides an in-flight result after %s', async action => {
  const target = selected(); await connect(target);
  const started = gate<void>(), finished = gate<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => { started.release(); return finished.promise; });
  const pending = refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  await started.promise;
  if (action === 'reconnect') await connect(target, 'replacement-model');
  else if (action === 'token-rotation') await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_API_TOKEN: 'replacement-token' } });
  else await deleteCredential(target, 'local-model');
  finished.release(response());
  const completed = await pending;
  expect(completed.briefing).toBeNull();
  expect(completed.diagnostics?.output?.text).toContain('Headline:');
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toMatchObject({ state: action === 'disconnect' ? 'disconnected' : 'awaiting', briefing: null });
});

it('hides saved guidance when a stored token changes without changing the model', async () => {
  const target = selected(); await connect(target);
  await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl: async () => response(), clock: () => NOW });
  await putCredential(target, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_API_TOKEN: 'replacement-token' } });
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toMatchObject({ state: 'awaiting', briefing: null });
});

it('rejects an in-flight legacy token replacement with unchanged model settings', async () => {
  const target = { ...selected(), ...fields };
  const started = gate<void>(), finished = gate<Response>();
  const pending = refreshPortfolioBrief(target, evidence(), HOUR, { clock: () => NOW,
    fetchImpl: async () => { started.release(); return finished.promise; } });
  await started.promise;
  target.LOCAL_MODEL_API_TOKEN = 'replacement-token';
  finished.release(response());
  expect(await pending).toMatchObject({ state: 'awaiting', briefing: null });
  expect(await readPortfolioBrief(target, { clock: () => NOW })).toMatchObject({ state: 'awaiting', briefing: null });
});

it('isolates saved briefings and leases between workspaces with identical model configuration', async () => {
  const target = selected(); await connect(target);
  const workspaceId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES('${workspaceId}','brief-fixture','Brief fixture')`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  const other = { ...target, STORE: store };
  try {
    await connect(other);

    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
    expect(await readPortfolioBrief(other, { clock: () => NOW })).toMatchObject({ state: 'awaiting', briefing: null });
    expect(await refreshPortfolioBrief(other, evidence(), HOUR, { fetchImpl, clock: () => NOW })).toMatchObject({ state: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await store.close();
    await asOwner(['portfolio_briefings', 'integration_health_events', 'integration_capability_state', 'capability_targets', 'integration_leases', 'connection_secrets', 'integration_connections', 'workspace_counters', 'workspaces']
      .map(table => `DELETE FROM noticeos.${table} WHERE workspace_id='${workspaceId}';`).join('\n'));
  }
});

it.each(['hosted', 'demo'])('blocks %s reads and refresh before inference', async profile => {
  const target = { ...env, NOTICEOS_WORKSPACE_PROFILE: profile };

  const fetchImpl = vi.fn<typeof fetch>();
  expect(await readPortfolioBrief(target, { fetchImpl })).toMatchObject({ state: 'unsupported', briefing: null });
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW })).toMatchObject({ state: 'unsupported', briefing: null });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects stale, oversized or invalid evidence before inference', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(refreshPortfolioBrief(target, evidence(NOW - 6 * 60_000), HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow('not current');
  const large = evidence(); large.facts[0]!.data = { text: 'x'.repeat(100_001) };
  await expect(refreshPortfolioBrief(target, large, HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow('limit');
  const invalid = evidence(); invalid.facts.push(invalid.facts[0]!);
  await expect(refreshPortfolioBrief(target, invalid, HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow();
  const unknown = evidence(); unknown.insightEvidenceIds = ['missing'];
  await expect(refreshPortfolioBrief(target, unknown, HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow('supplied facts');
  const undated = evidence(); delete undated.facts[0]!.comparison;
  await expect(refreshPortfolioBrief(target, undated, HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow('comparison periods');
  const reversed = evidence(); reversed.facts[0]!.comparison = { ...comparison, previous: comparison.current };
  await expect(refreshPortfolioBrief(target, reversed, HOUR, { fetchImpl, clock: () => NOW })).rejects.toThrow('ordered and separate');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('reads persisted insights through a fresh store after their freshness window', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const saved = await refreshPortfolioBrief(target, evidence(), HOUR, { fetchImpl, clock: () => NOW });
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId: await target.STORE.workspaceId() });
  try {
    forgetConfigCache();
    expect(await readPortfolioBrief({ ...target, STORE: store }, { fetchImpl, clock: () => NOW + 90 * 24 * HOUR }))
      .toMatchObject({ state: 'ready', briefing: saved.briefing, stale: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { await store.close(); }
});


it('does not turn the freshness window into a generation delay or scheduled retry', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const weekendGap = 72 * HOUR;
  const first = await refreshPortfolioBrief(target, evidence(), weekendGap, { fetchImpl, clock: () => NOW });
  expect(first.nextAttemptAt).toBeNull();
  const tomorrow = NOW + 24 * HOUR;
  expect(await refreshPortfolioBrief(target, evidence(tomorrow), weekendGap, { fetchImpl, clock: () => tomorrow })).toMatchObject({ state: 'ready' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const health = await target.STORE.read(tx => tx.query<{ next_attempt_at: string | null }>(
    "SELECT s.next_attempt_at FROM noticeos.integration_capability_state s JOIN noticeos.capability_targets t USING(workspace_id,target_seq) WHERE t.capability = 'portfolio-brief'"));
  expect(health).toHaveLength(1);
  expect(health[0]!.next_attempt_at).toBeNull();
});

async function selectReviewAssets(ids: string[] | null) {
  await env.STORE.write(tx => tx.execute(`INSERT INTO noticeos.config_documents(workspace_id, document_key, body, version, updated_at, updated_by)
    VALUES ($2::uuid, 'constants', $1::json, 1, now(), 'fixture')
    ON CONFLICT (workspace_id, document_key) DO UPDATE SET body = EXCLUDED.body, version = noticeos.config_documents.version + 1`,
    [JSON.stringify({ flag_defaults: {}, portfolio_brief: { asset_ids: ids } }), tx.workspaceId]));
}

it('hides saved briefings immediately when review scope changes, including none', async () => {
  const target = selected(); await connect(target);
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  await refreshPortfolioBrief(target, evidence(), HOUR, {fetchImpl, clock: () => NOW});
  await selectReviewAssets(['example']);
  expect(await readPortfolioBrief(target, {clock: () => NOW})).toMatchObject({state: 'awaiting', briefing: null});
  expect(await refreshPortfolioBrief(target, evidence(), HOUR, {fetchImpl, clock: () => NOW})).toMatchObject({state: 'awaiting', briefing: null});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await selectReviewAssets([]);
  const packet = {...evidence(), reviewAssetIds: []};
  expect(await refreshPortfolioBrief(target, packet, HOUR, {fetchImpl, clock: () => NOW})).toMatchObject({state: 'awaiting', briefing: null});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('accepts equivalent selection order and rejects an in-flight answer after a scope change', async () => {
  const target = selected(); await connect(target); await selectReviewAssets(['second', 'example']);
  const started = gate<void>(), finished = gate<Response>();
  const packet = {...evidence(), reviewAssetIds: ['example', 'second']};
  const fetchImpl = vi.fn<typeof fetch>(async () => {started.release(); return finished.promise;});
  const pending = refreshPortfolioBrief(target, packet, HOUR, {fetchImpl, clock: () => NOW});
  await started.promise;
  await selectReviewAssets(['example']);
  finished.release(response());
  expect(await pending).toMatchObject({state: 'awaiting', briefing: null});
  expect(await readPortfolioBrief(target, {clock: () => NOW})).toMatchObject({state: 'awaiting', briefing: null});
});
