import { beginCollection, recordCollectedHealth, collectionMonitoring } from '../src/collection-attempt.js';
import { archiveCollectedDump, archiveDumpFailure, integrationArchivePlan } from '../src/signal-dumps.js';
import { env } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { asOwner, emptyTables, forgetConfigDocuments, pgExecute, refuseHealthStates, reset, setConnection, storeArchiveRun, storeArchiveRuns, storedCount, storedHealthEvents, storeSignalRun, WORKERD_TRANSPORT_ERROR } from './helpers.js';
import { POSTHOG_FAMILIES } from '@noticeos/contract';
import { EGRESS_BEACONS } from '../src/egress.js';
import { runPosthogDumps } from '../src/posthog-dumps.js';
import { putCredential, resolveCredential } from '../src/credentials.js';
import { healthConnection, observeIntegration } from '../src/integration-health-context.js';
import { readIntegrationHealth } from '../src/integration-health-read.js';
import { recordSignalFailure, recordSignalSuccess, SignalError } from '../src/signal-store.js';
import { resolveGoogleCredential } from '../src/google-oauth.js';
import { googleTargets, googleCredentialResolver } from '../src/google-signals.js';
import { getConfigDocument, seedConfigDocuments, forgetConfigCache } from '../src/config-store.js';
import type { LaneRegister } from '../src/lane-mapping.js';
const NOW = Date.now();
const PRIVATE = 'https://calendar.example.test/private-marker/basic.ics';
beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
  const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
  const reads = await Promise.all(files.map(file => getConfigDocument(env, file)));
  await seedConfigDocuments(env, { documents: Object.fromEntries(reads.map(read => [read.file, read.body])), actor: 'test' });
});
afterEach(() => { vi.restoreAllMocks(); forgetConfigCache(); });
async function calendar() {
  await putCredential(env, { provider: 'calendar', fields: { CALENDAR_FEEDS: JSON.stringify({ Team: PRIVATE }) } });
  return healthConnection(env, 'calendar');
}
it('reads persistent per-feed failure and recovery without calling a provider or writing state', async () => {
  const connection = await calendar();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Health must not fetch'));
  await observeIntegration(env, connection, { capability: 'calendar-feed', target: PRIVATE, family: 'Team', observedAt: new Date(NOW - 1000).toISOString(), ok: false, code: 'network' });
  const before = (await storedHealthEvents()).length;
  const first = await readIntegrationHealth(env, NOW);
  const second = await readIntegrationHealth(env, NOW + 86_400_000);
  expect(first.items.find(i => i.capability === 'calendar-feed')).toMatchObject({ state: 'failing', failure: 'network' });
  expect(second.items.find(i => i.capability === 'calendar-feed')?.state).toBe('failing');
  expect(await storedHealthEvents()).toHaveLength(before);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(JSON.stringify(first)).not.toContain('private-marker');
  expect(JSON.stringify(first)).not.toContain(connection.revision);
  await observeIntegration(env, connection, { capability: 'calendar-test', observedAt: new Date(NOW).toISOString(), ok: true });
  expect((await readIntegrationHealth(env, NOW)).items.find(i => i.capability === 'calendar-feed')?.state).toBe('failing');
  await observeIntegration(env, connection, { capability: 'calendar-feed', target: PRIVATE, family: 'Team', observedAt: new Date(NOW + 1000).toISOString(), ok: true });
  const recovered = await readIntegrationHealth(env, NOW + 2000);
  expect(recovered.items.find(i => i.capability === 'calendar-feed')?.state).toBe('healthy');
  expect(recovered.events.some(i => i.kind === 'recovered' && i.label === 'Upcoming meetings')).toBe(true);
});
it('does not stamp an old request as proof of a replaced connection', async () => {
  await calendar();
  const old = await resolveCredential(env, 'calendar');
  await setConnection('calendar', { updated_at: '2026-09-11T00:00:00Z' });
  const captured = await healthConnection(env, 'calendar', old);
  expect(captured.changedAt).toBe(old.revision?.updatedAt);
  expect(await observeIntegration(env, captured, { capability: 'calendar-feed', target: PRIVATE, family: 'Team', observedAt: new Date(NOW).toISOString(), ok: true })).toBe(false);
  expect((await readIntegrationHealth(env, NOW)).items.find(i => i.capability === 'calendar-feed')?.state).toBe('never-run');
});
it('removing a feed removes its incident from current health without deleting history', async () => {
  const connection = await calendar();
  await observeIntegration(env, connection, { capability: 'calendar-feed', target: PRIVATE, family: 'Team', observedAt: new Date(NOW).toISOString(), ok: false, code: 'provider' });
  await putCredential(env, { provider: 'calendar', fields: { CALENDAR_FEEDS: JSON.stringify({ 'New team': 'https://calendar.example.test/changed/basic.ics' }) } });
  const result = await readIntegrationHealth(env, NOW + 1000);
  expect(result.items.some(i => i.detail === 'Team')).toBe(false);
  expect(result.events).toEqual([]);
  expect(await storedHealthEvents()).toHaveLength(1);
});
it('monitoring storage failure makes observed health unknown instead of green', async () => {
  await calendar();
  await asOwner('ALTER TABLE noticeos.integration_capability_state RENAME TO held_health_state');
  try {
    const result = await readIntegrationHealth(env, NOW);
    expect(result.available).toBe(false);
    expect(result.items.find(i => i.capability === 'calendar-feed')?.state).toBe('unknown');
  } finally { await asOwner('ALTER TABLE noticeos.held_health_state RENAME TO integration_capability_state'); }
});
it('keeps copied and reconstructed target evidence attached, including a usable zero', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const connection = await healthConnection(env, 'google');
  const monitoring = beginCollection(env.STORE, connection);
  const window = { start: '2026-09-10', end: '2026-09-11', dataState: 'final' as const, provisionalFrom: null };
  await recordSignalFailure(env, { ...target }, window, NOW - 1000, new SignalError('http_429', 'Quota refusal'), monitoring);

  let result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('failing');
  await recordSignalSuccess(env, { asset: target.asset, integration: target.integration, credentialRef: target.credentialRef, propertyRef: target.propertyRef }, window, new Date(NOW).toISOString(), { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null }, monitoring);

  result = await readIntegrationHealth(env, Math.max(NOW, Date.now()) + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('healthy');
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-realtime')?.state).toBe('never-run');
});

it('keeps incomplete archives and failed report dates separate from other successful dates', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const connection = await healthConnection(env, 'google');
  const monitoring = beginCollection(env.STORE, connection);
  const plan = await integrationArchivePlan(env.STORE, target, NOW);
  const first = plan[0]!;
  const observedAt = new Date(NOW).toISOString();
  await archiveDumpFailure(env.STORE, { monitoring, target, report: first.report, reportDate: first.date, requestedAt: observedAt, dataState: 'revision-window', error: new SignalError('http_429', 'Refused') });
  const run = { asset: target.asset, integration: target.integration, report: first.report, credential_ref: target.credentialRef, property_ref: target.propertyRef, data_state: 'revision-window' as const, request_count: 1, object_bytes: 10 };
  await storeArchiveRun({ ...run, id: 'truncated-fixture', report_date: first.date, finished_at: new Date(NOW + 1000).toISOString(), provider_rows: 1000, provider_truncated: true, object_key: 'object' });
  await recordCollectedHealth({ target: target, monitoring, attempt: { id: 'truncated-fixture', startedAt: new Date(NOW + 1000).toISOString(), finishedAt: new Date(NOW + 1000).toISOString(), source: 'signal_dump_runs', ok: false, code: 'incomplete-report', report: first.report, reportDate: first.date } });
  let result = await readIntegrationHealth(env, NOW + 2000);
  expect(result.items.find(i => i.asset === target.asset && i.detail === `${first.report} · ${first.date}`)).toMatchObject({ state: 'failing', failure: 'incomplete-report', report: first.report, reportDate: first.date });
  // The report and its day are fields: every item that is not one archive
  // report carries neither.
  expect(result.items.filter(i => i.report === null).every(i => i.reportDate === null)).toBe(true);
  expect(result.items.some(i => i.capability === 'ga4-daily' && i.report === null)).toBe(true);
  await storeArchiveRun({ ...run, id: 'other-date-fixture', report_date: '2026-01-01', finished_at: new Date(NOW + 1500).toISOString(), object_key: 'object2' });
  result = await readIntegrationHealth(env, NOW + 3000);
  expect(result.items.find(i => i.asset === target.asset && i.detail === `${first.report} · ${first.date}`)?.state).toBe('failing');
});

it('does not substitute bundled settings for missing saved inventory', async () => {
  await forgetConfigDocuments(['config/integrations.json']);
  forgetConfigCache();
  const result = await readIntegrationHealth(env);
  expect(result.available).toBe(false);
  expect(result.items).toEqual([]);
});
it('does not silently accept a malformed calendar configuration', async () => {
  const result = await readIntegrationHealth({ ...env, CALENDAR_FEEDS: '{broken' });
  expect(result.items.find(i => i.provider === 'calendar')?.state).toBe('unknown');
  expect(result.available).toBe(false);
});

it('a new environment credential cannot borrow prior collection success', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  await recordSignalSuccess(env, target, { start: '2026-09-10', end: '2026-09-11' }, new Date(NOW).toISOString(), { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null });
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('unknown');
});
it('the credit read appears once and remains idle until an actual sweep requests it', async () => {
  const result = await readIntegrationHealth({ ...env, DATAFORSEO_LOGIN: 'test@example.test', DATAFORSEO_PASSWORD: 'fixture' }, Date.now());
  const credit = result.items.filter(i => i.capability === 'dataforseo-credit');
  expect(credit).toHaveLength(1);
  expect(credit[0]?.state).toBe('idle');
});

it('overlapping old daily and new archive requests keep their actual connection', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const current = await healthConnection(env, 'google');
  const oldTarget = { ...target };
  const oldMonitoring = beginCollection(env.STORE, { ...current, revision: 'previous-connection' });
  const monitoring = beginCollection(env.STORE, current);
  await recordSignalFailure(env, target, { start: '2026-09-10', end: '2026-09-11' }, NOW - 2000, new SignalError('http_403', 'Access refused'), monitoring);
  await recordSignalSuccess(env, oldTarget, { start: '2026-09-10', end: '2026-09-11' }, new Date(NOW - 1000).toISOString(), { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null }, oldMonitoring);
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('failing');
});
it('changes Google revision when a referenced service-account key changes', async () => {
  const fields = { GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({ test: { service_account_binding: 'TEST_GOOGLE_KEY', properties: {} } }) };
  const resolved = { workspaceId: await env.STORE.workspaceId(), connectionId: null, provider: 'google', source: 'env' as const, fields, legacySlots: {} };
  const first = await healthConnection({ ...env, TEST_GOOGLE_KEY: 'first-fixture' } as IngestEnv, 'google', resolved);
  const second = await healthConnection({ ...env, TEST_GOOGLE_KEY: 'second-fixture' } as IngestEnv, 'google', resolved);
  expect(first.revision).not.toBe(second.revision);
});
it('includes the actual Google OAuth app snapshot in the connection identity', async () => {
  const resolved = { workspaceId: await env.STORE.workspaceId(), connectionId: null, provider: 'google', source: 'env' as const, fields: { GOOGLE_OAUTH_REFRESH_TOKEN: 'grant-fixture' }, legacySlots: {} };
  const first = await healthConnection(env, 'google', resolved, ['client-fixture', 'first-fixture']);
  const second = await healthConnection(env, 'google', resolved, ['client-fixture', 'second-fixture']);
  expect(first.revision).not.toBe(second.revision);
});

it('invalidates an older green result when a newer source attempt could not be monitored', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const monitoring = beginCollection(env.STORE, await healthConnection(env, 'google'));
  const window = { start: '2026-09-10', end: '2026-09-11' };
  await recordSignalSuccess(env, target, window, new Date(NOW - 2000).toISOString(), { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null }, monitoring);
  const undo = await refuseHealthStates();
  try { await recordSignalFailure(env, target, window, NOW - 1000, new SignalError('http_429', 'Refused'), monitoring); }
  finally { await undo(); }
  expect(collectionMonitoring(monitoring)).toEqual({ monitoringAvailable: false });
  expect(await storedCount('SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE asset_id = $1', [target.asset])).toBe(2);
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('unknown');
});

it('keeps an unresolved archived failure when an unmonitored source success moves it outside the current plan', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const monitoring = beginCollection(env.STORE, await healthConnection(env, 'google'));
  const first = (await integrationArchivePlan(env.STORE, target, NOW))[0]!;
  const date = '2026-01-01';
  await archiveDumpFailure(env.STORE, { monitoring, target, report: first.report, reportDate: date, requestedAt: new Date(NOW - 2000).toISOString(), dataState: 'provider-final', error: new SignalError('http_429', 'Refused') });
  await storeArchiveRun({ id: 'unmonitored-recovery', asset: target.asset, integration: target.integration, report: first.report, credential_ref: target.credentialRef,
    property_ref: target.propertyRef, report_date: date, finished_at: new Date(NOW - 1000).toISOString(), data_state: 'provider-final', request_count: 1, object_key: 'object', object_bytes: 10 });
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.find(i => i.asset === target.asset && i.detail === `${first.report} · ${date}`)?.state).toBe('failing');
  expect(result.events.some(event => event.kind === 'recovered')).toBe(false);
});

it('says a list of unresolved archive failures was cut at 256, and how many there are', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const report = (await integrationArchivePlan(env.STORE, target, NOW))[0]!.report;
  const day = (n: number) => new Date(Date.parse('2025-01-01T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
  await storeArchiveRuns(Array.from({ length: 300 }, (_, n) => ({
    id: `failed-date-${n}`, asset: target.asset, integration: target.integration, report, credential_ref: target.credentialRef,
    property_ref: target.propertyRef, report_date: day(n), finished_at: new Date(NOW - 10_000 - n).toISOString(),
    data_state: 'provider-final', status: 'error', error_code: 'http_500', error_message: 'Refused',
  })));
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  const overflow = result.items.filter(i => i.asset === target.asset && i.detail?.startsWith('256 of '));
  expect(overflow).toEqual([expect.objectContaining({ detail: '256 of 300 report dates · 300 unresolved failures', state: 'unknown', code: 'monitoring' })]);
});

it('does not let thousands of resolved historical archive dates exhaust current health coverage', async () => {
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const target = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const monitoring = beginCollection(env.STORE, await healthConnection(env, 'google'));
  const report = (await integrationArchivePlan(env.STORE, target, NOW))[0]!.report;
  await recordCollectedHealth({ target: target, monitoring, attempt: { id: 'archive-template', startedAt: new Date(NOW - 1000).toISOString(), finishedAt: new Date(NOW - 1000).toISOString(), source: 'signal_dump_runs', ok: true, report: 'historical', reportDate: '2020-01-01' } });
  // 2,050 more resolved dates of the template's target, each a target of its own.
  await env.STORE.write((tx) => tx.execute(`WITH template AS (
      SELECT t.provider, t.connection_revision, t.capability, t.asset_id, t.target_id,
             s.attempt_id, s.started_at, s.finished_at, s.outcome, s.evidence_source, s.evidence_id
        FROM noticeos.capability_targets t
        JOIN noticeos.integration_capability_state s ON s.workspace_id = t.workspace_id AND s.target_seq = t.target_seq
       WHERE s.attempt_id = 'archive-template'
    ), made AS (
      INSERT INTO noticeos.capability_targets (workspace_id, provider, connection_revision, capability, asset_id, target_id, family)
      SELECT $1::uuid, provider, connection_revision, capability, asset_id, target_id, format('["historical",%s,"",""]', n)
        FROM template CROSS JOIN generate_series(1, 2050) AS n
      RETURNING target_seq
    )
    INSERT INTO noticeos.integration_capability_state (workspace_id, target_seq, attempt_id, started_at, finished_at, outcome, evidence_source, evidence_id)
    SELECT $1::uuid, made.target_seq, template.attempt_id, template.started_at, template.finished_at, template.outcome, template.evidence_source, template.evidence_id
      FROM made CROSS JOIN template`, [tx.workspaceId]));
  // 2,050 resolved report dates, one stored object between them.
  await storeArchiveRun({ id: 'old-source-object', asset: target.asset, integration: target.integration, report, credential_ref: target.credentialRef,
    property_ref: target.propertyRef, report_date: '2020-01-01', finished_at: new Date(NOW - 3000).toISOString(), data_state: 'provider-final',
    request_count: 1, object_key: 'object', object_bytes: 10 });
  await pgExecute(
    `INSERT INTO noticeos.archive_runs (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref, report_date,
       requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count, provider_truncated, object_seq, cost_usd, cost_state)
     SELECT r.workspace_id, 'old-source-' || n, r.asset_id, r.integration, r.report, r.credential_ref, r.property_ref, date '2020-01-01' + n,
            r.requested_at, r.finished_at, 'success', 'provider-final', 1, 0, 1, false, r.object_seq, 0, 'reported'
       FROM noticeos.archive_runs r CROSS JOIN generate_series(1, 2050) AS n
      WHERE r.run_id = 'old-source-object'`,
  );
  await recordSignalSuccess(env, target, { start: '2026-09-10', end: '2026-09-11' }, new Date(NOW).toISOString(), { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null }, monitoring);
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.available).toBe(true);
  expect(result.items.some(i => i.asset === target.asset && i.capability === 'ga4-archive' && i.state === 'unknown')).toBe(false);
  expect(result.items.find(i => i.asset === target.asset && i.capability === 'ga4-daily')?.state).toBe('healthy');
});

it('retires a current-state network failure once a later attempt was answered — never a refusal, never a dated archive', async () => {
  const hour = (h: number) => new Date(NOW - (10 - h) * 3_600_000).toISOString();
  const collected = { pages: [{ request: {}, response: { d: [] } }], providerRows: 0, providerTruncated: false };
  const bing = beginCollection(env.STORE, await healthConnection(env, 'bing-webmaster'));
  const site = { asset: 'meadow.example', integration: 'bing-webmaster' as const, credentialRef: 'env:BING_WEBMASTER_API_KEY', propertyRef: 'https://meadow.example/' };
  // Filed under the bare domain: that night's site-list call never came back.
  const standIn = { ...site, propertyRef: 'meadow.example' };
  await archiveDumpFailure(env.STORE, { monitoring: bing, target: standIn, report: 'rank-traffic', reportDate: '2026-09-13', requestedAt: hour(1), dataState: 'provider-snapshot', error: new SignalError('request_failed', 'no answer') });
  await archiveDumpFailure(env.STORE, { monitoring: bing, target: site, report: 'crawl-stats', reportDate: '2026-09-13', requestedAt: hour(1), dataState: 'provider-snapshot', error: new SignalError('bwt_http_400', 'refused') });
  for (const report of ['rank-traffic', 'crawl-stats']) {
    await archiveCollectedDump(env, { monitoring: bing, provider: 'microsoft', target: site, report, reportDate: '2026-09-14', requestedAt: hour(2), dataState: 'provider-snapshot', collected });
  }

  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const google = await resolveGoogleCredential(env);
  const ga4 = googleTargets(google, google.source, googleCredentialResolver(env), register).find(t => t.integration === 'ga4')!;
  const googleMonitoring = beginCollection(env.STORE, await healthConnection(env, 'google'));
  const report = (await integrationArchivePlan(env.STORE, ga4, NOW))[0]!.report;
  await archiveDumpFailure(env.STORE, { monitoring: googleMonitoring, target: ga4, report, reportDate: '2026-01-01', requestedAt: hour(1), dataState: 'revision-window', error: new SignalError('request_failed', 'no answer') });
  await archiveCollectedDump(env, { monitoring: googleMonitoring, provider: 'google', target: ga4, report, reportDate: '2026-01-02', requestedAt: hour(2), dataState: 'revision-window', collected });

  const result = await readIntegrationHealth(env, Date.now() + 1000);
  const item = (detail: string) => result.items.find(i => i.detail === detail);
  // Bing can only answer "now": the later snapshot is the answer to that night.
  expect(item('rank-traffic · 2026-09-13 · meadow.example')).toBeUndefined();
  expect(item('rank-traffic · 2026-09-14 · https://meadow.example/')).toMatchObject({ failure: null, report: 'rank-traffic', reportDate: '2026-09-14' });
  // A refusal stays the provider's story until its own date succeeds.
  expect(item('crawl-stats · 2026-09-13 · https://meadow.example/')).toMatchObject({ state: 'failing', failure: 'provider' });
  // A dated archive is asked again instead, so its failure stays until it is.
  expect(result.items.find(i => i.asset === ga4.asset && i.detail === `${report} · 2026-01-01`)).toMatchObject({ state: 'failing', failure: 'network' });
});
// The properties a Bing site was saved under come from its daily runs and its
// report runs, one statement over both: this site has daily runs alone.
it('finds a Bing site by the property its daily runs were saved under, when its archive has none', async () => {
  const bing = beginCollection(env.STORE, await healthConnection(env, 'bing-webmaster'));
  const site = { asset: 'meadow.example', integration: 'bing-webmaster' as const, credentialRef: 'env:BING_WEBMASTER_API_KEY', propertyRef: 'https://meadow.example/' };
  await recordSignalSuccess(env, site, { start: '2026-09-13', end: '2026-09-13' }, new Date(NOW - 1000).toISOString(),
    { observations: [], providerRows: 0, dataState: 'final', provisionalFrom: null }, bing);
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.filter(i => i.asset === 'meadow.example' && i.capability === 'bing-daily').map(i => i.detail))
    .toEqual(['https://meadow.example/']);
});
it('lists a Bing site\'s saved properties once each, in text order, from both kinds of run', async () => {
  const bing = beginCollection(env.STORE, await healthConnection(env, 'bing-webmaster'));
  const site = { asset: 'meadow.example', integration: 'bing-webmaster' as const, credentialRef: 'env:BING_WEBMASTER_API_KEY', propertyRef: 'https://meadow.example/' };
  const collected = { pages: [{ request: {}, response: { d: [] } }], providerRows: 0, providerTruncated: false };
  await storeSignalRun({ id: 'daily-www', asset: 'meadow.example', integration: 'bing-webmaster', property_ref: 'https://www.meadow.example/', finished_at: new Date(NOW - 3000).toISOString() });
  await storeSignalRun({ id: 'daily-bare', asset: 'meadow.example', integration: 'bing-webmaster', property_ref: 'https://meadow.example/', finished_at: new Date(NOW - 2000).toISOString() });
  await archiveCollectedDump(env, { monitoring: bing, provider: 'microsoft', target: site, report: 'rank-traffic', reportDate: '2026-09-14', requestedAt: new Date(NOW - 1000).toISOString(), dataState: 'provider-snapshot', collected });
  const result = await readIntegrationHealth(env, Date.now() + 1000);
  expect(result.items.filter(i => i.asset === 'meadow.example' && i.capability === 'bing-daily').map(i => i.detail))
    .toEqual(['https://meadow.example/', 'https://www.meadow.example/']);
});
it('shows no PostHog network failure once the next healthy run has asked the lost window again', async () => {
  await putCredential(env, { provider: 'posthog', fields: { POSTHOG_KEYS: JSON.stringify({ 'meadow.example': 'phx_health_read_fixture' }) } });
  // Connected long before the dark night.
  await setConnection('posthog', { updated_at: '2026-09-01T00:00:00.000Z' });
  const register = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  /** PostHog as the world sees it: the reference sites always answer, PostHog
   * only when `up` — a project in New York with nothing counted yet. */
  const posthog = (up: boolean): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((EGRESS_BEACONS as readonly string[]).includes(url)) return new Response('h=1');
    if (!up) throw new Error(WORKERD_TRANSPORT_ERROR);
    return init?.method === 'GET' ? Response.json({ id: 424242, timezone: 'America/New_York' }) : Response.json({ results: [] });
  }) as typeof fetch;
  const network = (payload: Awaited<ReturnType<typeof readIntegrationHealth>>) =>
    payload.items.filter(i => i.provider === 'posthog' && i.failure === 'network');

  // PostHog never answered, so every window ending 09-13 failed at the network.
  await runPosthogDumps(env, { nowMs: Date.parse('2026-09-14T12:30:00.000Z'), fetchImpl: posthog(false), laneRegister: register });
  // Read on today's clock: an attempt finishes when the test runs, and a read
  // dated before that would not count it yet.
  const stuck = await readIntegrationHealth(env, Date.now() + 1000);
  expect(network(stuck).map(i => i.detail).sort()).toEqual(POSTHOG_FAMILIES.map(family => `${family} · 2026-09-13`).sort());
  expect(network(stuck).every(i => i.state === 'failing')).toBe(true);

  // The next healthy run asks those windows again beside its own.
  const next = await runPosthogDumps(env, { nowMs: Date.parse('2026-09-15T12:30:00.000Z'), fetchImpl: posthog(true), laneRegister: register });
  expect(next.retried).toBe(POSTHOG_FAMILIES.length);
  const after = await readIntegrationHealth(env, Date.now() + 1000);
  expect(network(after)).toEqual([]);
  // Each family reads by today's window, not the one re-collected beside it,
  // and nothing about the lost night is left on the page.
  const items = after.items.filter(i => i.provider === 'posthog' && i.capability === 'posthog-archive');
  expect(items.map(i => i.detail).sort()).toEqual(POSTHOG_FAMILIES.map(family => `${family} · 2026-09-14`).sort());
  expect(items.every(i => i.failure === null)).toBe(true);
});
