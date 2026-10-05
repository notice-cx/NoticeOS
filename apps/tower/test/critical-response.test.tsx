import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@/lib/api';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { decodeBrowserSession, fetchBrowserSession } from '@/lib/browser-session';
import { fetchMembershipsRequest } from '@/lib/membership-client';
import { decodeSettings, decodeConfigWritable, decodeConfigSave, decodeIntegrationProviders } from '@/lib/critical-response';
import { responseInstant } from '@/lib/response-value';
import { useFieldConfigSave } from '@/hooks/useConfigSave';
import { buildSettingsPayload } from '../worker/settings-payload';
import { INTEGRATION_PROVIDERS } from '@noticeos/contract/integrations';
import type { IntegrationCredentialsPayload } from '@shared/integrations-page';

const now = '2026-10-01T12:00:00.000Z';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const op = { kind: 'file-json-set' as const, file: 'config/constants.json' as const,
  pointer: '/operator_rate_usd_per_min', value: 0, expect: 2 };
function settings() {
  return buildSettingsPayload({ now: new Date(now), osTimeZone: 'Etc/UTC', timeZoneChosen: false,
    monthlyCaps: { dataUsd: 0 }, operatorRateUsdPerMin: 0, flagDefaults: { alpha: 0.01 }, signalPanels: {}, pullConfig: [],
    integrations: { catalog: [{ id: 'custom', label: 'Custom', docRef: 'docs/example.md' }], assets: {} }, dashboard: {}, entities: [], beads: { spokes: [] } });
}
function accounts(): IntegrationCredentialsPayload {
  return { generatedAt: now, keyPresent: false, blockers: ['key-missing'], keyReason: 'Key missing',
    providers: INTEGRATION_PROVIDERS.map(provider => ({ provider: structuredClone(provider), assets: [], meter: null,
      credential: { provider: provider.id, source: 'none', fields: [], assetsHeld: [], missingFields: [], auth: null,
        metadata: null, keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null } })) };
}
function session() { return { mode: 'hosted', session: { principalId: id, sessionId: id, expiresAt: now },
  workspaces: [{ workspaceId: id, displayName: 'First', role: 'owner', status: 'active' }], nextCursor: null,
  selectedWorkspace: { workspaceId: id, displayName: 'First', role: 'owner', status: 'active' } }; }
function api(value: unknown) { return createApi(vi.fn(async () => Response.json(value))); }
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.retire(); vi.restoreAllMocks(); });

describe('settings response', () => {
  it('accepts the actual current builder, empty sections, optional saved fields and observed zero verbatim', async () => {
    const value = settings();
    expect(decodeSettings(value)).toBe(value);
    expect(await api(value).fetchSettings()).toEqual(value);
    expect(value.budget.knobs[0]?.value).toBe(0);
    expect(value.sources.rows[0]).not.toHaveProperty('credential');
  });
  it.each([
    ['clock truth', (value: ReturnType<typeof settings>) => { Object.assign(value.clock, { chosen: 'false' }); }],
    ['clock zone', (value: ReturnType<typeof settings>) => { value.clock.timeZone = 'invalid-zone'; }],
    ['owner', (value: ReturnType<typeof settings>) => { value.budget.owner = 'config/pull.json'; }],
    ['finite budget', (value: ReturnType<typeof settings>) => { value.budget.knobs[0]!.value = Infinity; }],
    ['raw guard', (value: ReturnType<typeof settings>) => { Object.assign(value.alertRules.knobs[0]!, { raw: false }); }],
    ['catalog enum', (value: ReturnType<typeof settings>) => { Object.assign(value.sources.rows[0]!, { scope: 'customer' }); }],
    ['chosen enum type', (value: ReturnType<typeof settings>) => { Object.assign(value.sources.rows[0]!, { scope: { toString: 'property' } }); }],
    ['collection key', (value: ReturnType<typeof settings>) => { Object.assign(value.collection, { knobs: [{ key: 'unknown', value: 0 }] }); }],
    ['schedule bool', (value: ReturnType<typeof settings>) => { Object.assign(value.collection, { schedules: { pull: { enabled: 0, cron: '* * * * *' } } }); }],
    ['entity list', (value: ReturnType<typeof settings>) => { Object.assign(value.entities, { rows: [{ slug: 'company', name: 'Company', assets: 'site.example' }] }); }],
    ['hub port', (value: ReturnType<typeof settings>) => { Object.assign(value.taskHub, { hub: { host: 'localhost', port: 0, user: 'fixture', dataDir: './hub' } }); }],
    ['date', (value: ReturnType<typeof settings>) => { value.generatedAt = '2026-02-30T12:00:00Z'; }],
  ] as const)('refuses malformed %s without repairing the payload', (_name, mutate) => {
    const value = settings(); mutate(value);
    expect(() => decodeSettings(value)).toThrow('invalid response');
  });
  it('preserves countdown/layout history, retired originals and named refusals without normalizing them', () => {
    const value = settings();
    const saved = { countdown: { emoji: '' }, extra: ['raw', null] };
    value.dashboard = { countdown: { emoji: '🗓️', label: 'Launch', targetAt: now },
      wall: { layout: { version: 1, rows: [{ id: 'row', height: 'fill', widgets: [{ id: 'sites', type: 'sites', width: 1 }] }] },
        history: [], retired: { saved, replaced: false } }, refused: { countdown: { saved, reason: 'Unreadable countdown' } } };
    expect(decodeSettings(value)).toBe(value);
    value.dashboard.countdown!.targetAt = '2026-01-01T24:00:00Z';
    expect(() => decodeSettings(value)).toThrow('invalid response');
  });
});

describe('config acknowledgement', () => {
  it('accepts both deployed store and legacy local shapes without fabricating file sources or archive paths', async () => {
    expect(await api({ writable: false, reason: 'Read only' }).fetchConfigWritable()).toEqual({ writable: false, reason: 'Read only', sources: {} });
    expect(await api({ writable: true, reason: null, sources: { 'config/constants.json': 'store' },
      versions: { 'config/constants.json': 1 }, store: { ready: true, reason: null } }).fetchConfigWritable()).toMatchObject({ writable: true });
    const saved = { applied: 1, archive: null, commit: null, exported: false, documents: [{ file: op.file, version: 1 }] };
    expect(await api(saved).saveConfig([op])).toEqual({ applied: 1, archive: null, commit: null, exported: false });
    expect(decodeConfigSave({ applied: 0, archive: 'changeset.json', commit: 'legacy' }, 0, [])).toMatchObject({ applied: 0 });
  });
  it.each([{}, { writable: 'true', reason: null }, { writable: true }, { writable: true, reason: null, sources: { 'config/constants.json': 'fallback' } },
    { writable: true, reason: null, sources: { 'private.json': 'store' } }, { writable: false, reason: null, versions: { 'config/constants.json': 1.5 } }])(
    'refuses malformed permissions/source metadata %#', value => expect(() => decodeConfigWritable(value)).toThrow('invalid response'));
  it.each([{}, { applied: 1, archive: null }, { applied: '1', archive: null, commit: null },
    { applied: 0, archive: null, commit: null }, { applied: 1.5, archive: null, commit: null }, { applied: Infinity, archive: null, commit: null },
    { applied: 1, archive: null, commit: null, exported: 'false' },
    { applied: 1, archive: null, commit: null, documents: [{ file: 'config/constants.json', version: 0 }] },
    { applied: 1, archive: null, commit: null, documents: [{ file: 'config/pull.json', version: 1 }] }])(
    'does not invent a saved result %#', value => expect(() => decodeConfigSave(value, 1, [op.file])).toThrow('outcome unknown'));
  it('does not echo malformed JSON response excerpts', async () => {
    const client = createApi(async () => new Response('private malformed body', { status: 200 }));
    await expect(client.fetchSettings()).rejects.toThrow('Settings returned an invalid response');
    await expect(client.saveConfig([op])).rejects.toThrow('Save outcome unknown');
  });
  it('real owner field keeps its draft, offers no Undo, publishes no cache success and does not retry an unknown save', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'PUT' ? {}
      : { writable: true, reason: null, sources: { 'config/constants.json': 'store' } }));
    const runtime = createBrowserRuntime({ mode: 'hosted', principalId: id, sessionId: id, workspaceId: id, clientGeneration: 1 },
      { origin: window.location.origin, fetch, sendAnswer: async () => {} });
    runtimes.push(runtime);
    runtime.queries.setQueryData(['settings'], 'unchanged');
    const invalidate = vi.spyOn(runtime.queries, 'invalidateQueries');
    function Editor() {
      const save = useFieldConfigSave(); const [draft, setDraft] = useState('Unsaved'); const [status, setStatus] = useState('Editing');
      return <><input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
        <button onClick={() => { void save({ ops: [op], label: 'Rate' }).then(outcome => setStatus(outcome.saved ? 'Saved' : outcome.refusal)); }}>Save</button>
        <span role="status">{status}</span></>;
    }
    render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'First' }}><QueryClientProvider client={runtime.queries}><Editor /></QueryClientProvider></BrowserRuntimeProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'My unsaved choice' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('My unsaved choice');
    expect(screen.getByRole('status')).toHaveTextContent('Save outcome unknown');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled(); expect(runtime.queries.getQueryData(['settings'])).toBe('unchanged');
  });
});

describe('integration account metadata', () => {
  it('accepts all current declarations, missing metadata, zero exact balance and legacy asset metadata without defaults', async () => {
    const value = accounts();
    const data = value.providers.find(item => item.provider.id === 'dataforseo')!;
    data.credential.metadata = { account: 'account.example', scopes: [], connectedAt: now, expiresAt: null, expirySource: 'operator', balance: { usd: '0', seenAt: now } };
    const clarity = value.providers.find(item => item.provider.id === 'clarity')!;
    const field = clarity.provider.fields.find(item => item.legacyAssetBinding)!;
    field.legacyAssetBinding = { ...field.legacyAssetBinding!, asset: 'site.example' };
    expect(decodeIntegrationProviders(value)).toBe(value);
    expect(await api(value).fetchIntegrationProviders()).toEqual(value);
    delete data.credential.metadata.balance;
    expect(decodeIntegrationProviders(value)).toBe(value);
  });
  it.each([
    ['provider mismatch', (value: IntegrationCredentialsPayload) => { value.providers[0]!.credential.provider = 'google'; }],
    ['duplicate providers', (value: IntegrationCredentialsPayload) => { value.providers.push(value.providers[0]!); }],
    ['provider declaration', (value: IntegrationCredentialsPayload) => { Object.assign(value.providers[0]!.provider.test, { cost: 'unexpected' }); }],
    ['expiry enum', (value: IntegrationCredentialsPayload) => { Object.assign(value.providers[0]!.credential, { auth: 'admin' }); }],
    ['key truth', (value: IntegrationCredentialsPayload) => { value.keyPresent = true; }],
    ['missing dates', (value: IntegrationCredentialsPayload) => { Reflect.deleteProperty(value.providers[0]!.credential, 'createdAt'); }],
    ['invalid balance date', (value: IntegrationCredentialsPayload) => { value.providers[0]!.credential.metadata = { account: null, scopes: [], connectedAt: null,
      expiresAt: null, expirySource: null, balance: { usd: '0', seenAt: '2026-02-30T00:00:00Z' } }; }],
    ['balance currency', (value: IntegrationCredentialsPayload) => { Object.assign(value.providers[0]!.credential, { metadata: { account: null, scopes: [], connectedAt: null,
      expiresAt: null, expirySource: null, balance: { usd: '0', seenAt: now, currency: 'EUR' } } }); }],
    ['nonfinite balance', (value: IntegrationCredentialsPayload) => { Object.assign(value.providers[0]!.credential, { metadata: { account: null, scopes: [], connectedAt: null,
      expiresAt: null, expirySource: null, balance: { usd: '1e999', seenAt: now } } }); }],
    ['meter date', (value: IntegrationCredentialsPayload) => { value.providers[0]!.meter = { window: 'asset-day', day: '2026-04-31', assets: [] }; }],
  ] as const)('rejects malformed %s', (_name, mutate) => { const value = accounts(); mutate(value); expect(() => decodeIntegrationProviders(value)).toThrow('invalid response'); });
});

describe('existing account decoder compatibility', () => {
  it('keeps signed-out zero membership facts and verifies requested selection outside the current page', async () => {
    const value = session(); value.workspaces = []; value.selectedWorkspace.workspaceId = other;
    expect(await fetchBrowserSession(async () => Response.json(value), { selected: other })).toMatchObject({ selectedWorkspace: { workspaceId: other } });
    expect(decodeBrowserSession({ mode: 'hosted', session: null, workspaces: [], nextCursor: null, selectedWorkspace: null })).toMatchObject({ session: null });
    await expect(fetchBrowserSession(async () => Response.json(value), { selected: id })).rejects.toThrow('invalid response');
  });
  it.each(['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01', '2026-01-01T12:00:00+24:00'])('rejects invalid account instant %s', async expiresAt => {
    expect(responseInstant(expiresAt)).toBe(false);
    const value = session(); value.session.expiresAt = expiresAt;
    expect(() => decodeBrowserSession(value)).toThrow('invalid response');
    await expect(fetchMembershipsRequest(async () => Response.json({ ok: true, collection: 'invitations', items: [{ id, email: 'person@example.com', role: 'viewer', expiresAt }], nextCursor: null }), 'invitations')).rejects.toThrow('invalid response');
  });
  it('keeps valid offset timestamps and ordinary member/invitation pages', async () => {
    expect(responseInstant('2028-02-29T23:59:59.123456+02:00')).toBe(true);
    expect(await fetchMembershipsRequest(async () => Response.json({ ok: true, collection: 'members', items: [{ id, email: 'person@example.com', name: 'Person', role: 'viewer' }], nextCursor: null }), 'members')).toMatchObject({ items: [{ id, name: 'Person' }] });
  });
});
