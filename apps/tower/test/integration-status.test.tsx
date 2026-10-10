import { cleanup, fireEvent, render, screen } from './render';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { CredentialSummary, IntegrationHealthItem, IntegrationHealthPayload, IntegrationProviderStatus } from '@noticeos/contract';
import { integrationProvider } from '@noticeos/contract';
import { CONNECTION_HISTORY_GAP, connectionCounts, connectionStatus, currentHealth } from '@shared/connection-status';
import { integrationStatus } from '@shared/integration-status';
import { IntegrationHealthPanel } from '@/components/IntegrationHealthPanel';
import { fetchIntegrationHealth } from '@/lib/api';
const AT = '2026-09-12T12:00:00Z'; const NOW = Date.parse(AT);
function item(patch: Partial<IntegrationHealthItem> = {}): IntegrationHealthItem {
  return { id: 'a', provider: 'google', capability: 'ga4-realtime', label: 'Live active users', state: 'failing', asset: 'example.test', detail: null, report: null, reportDate: null,
    lastAttemptAt: AT, lastSuccessAt: '2026-09-12T11:55:00Z', nextAttemptAt: '2026-09-12T12:05:00Z', failure: 'rate-limit', code: 'rate-limit-daily', action: 'Wait for the displayed retry.', coverage: 'monitored', ...patch };
}
function payload(items: IntegrationHealthItem[]): IntegrationHealthPayload { return { generatedAt: AT, available: true, items, events: [] }; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const connected = (id: string): IntegrationProviderStatus => ({
  provider: integrationProvider(id)!, assets: [], meter: null,
  credential: { provider: id, source: 'store', fields: ['KEY'], assetsHeld: [], missingFields: [], auth: null, metadata: null, keyVersion: 1,
    createdAt: AT, updatedAt: AT, lastUsedAt: AT, lastOkAt: AT, lastError: null } as CredentialSummary,
});
const failing = (patch: Partial<IntegrationHealthItem> = {}) => item({ capability: 'ga4-daily', label: 'Analytics daily reports', failure: 'access', code: 'access', lastSuccessAt: null, ...patch });
const healthy = (patch: Partial<IntegrationHealthItem> = {}) => item({ capability: 'ga4-daily', label: 'Analytics daily reports', state: 'healthy', failure: null, code: null, lastSuccessAt: AT, ...patch });

it('counts sites failing now, never report dates an outage left behind', () => {
  const data = payload([
    ...['a', 'b', 'c'].map((asset) => healthy({ id: asset, asset })),
    failing({ id: 'd', asset: 'd' }),
    item({ id: 'gap', asset: 'a', capability: 'ga4-archive', label: 'Analytics report archive', detail: 'events · 2026-09-10', report: 'events', reportDate: '2026-09-10', failure: 'network', code: 'network', lastAttemptAt: '2026-09-10T12:00:00Z', lastSuccessAt: null }),
    item({ id: 'today', asset: 'a', capability: 'ga4-archive', label: 'Analytics report archive', detail: 'events · 2026-09-11', report: 'events', reportDate: '2026-09-11', state: 'healthy', failure: null, code: null }),
  ]);
  const state = integrationStatus(data, false, NOW);
  expect(state).toMatchObject({ attention: 1, failing: 1, working: 3, affectedAssets: ['d'] });
  expect(state.providers[0]?.sites.find((site) => site.key === 'a')).toMatchObject({ kind: 'working', missing: 1 });
});
it('keeps inactive connections neutral and separates missing evidence from incidents', () => {
  const data = payload(['idle', 'paused', 'disconnected', 'never-run', 'unknown', 'unmonitored'].map((state, i) => item({ id: String(i), asset: `site-${i}`, state: state as IntegrationHealthItem['state'] })));
  expect(integrationStatus(data, false, NOW)).toMatchObject({ attention: 0, failing: 0, unconfirmed: 3, idle: 1 });
});
it('cannot show retained success as working after an error, stale snapshot or future timestamp', () => {
  const data = payload([healthy()]);
  for (const [error, now] of [[true, NOW], [false, NOW + 90_000], [false, NOW - 60_000]] as const) expect(integrationStatus(data, error, now)).toMatchObject({ current: false, available: false, working: 0, unconfirmed: 1 });
  expect(integrationStatus(payload([failing()]), true, NOW).failing).toBe(1);
});
it('an empty integration inventory is unconfirmed, while explicit disconnected evidence is neutral', () => {
  expect(integrationStatus(payload([]), false, NOW).available).toBe(false);
  expect(integrationStatus(payload([item({ state: 'disconnected' })]), false, NOW)).toMatchObject({ available: true, attention: 0, working: 0, idle: 0 });
});
it('groups connections by provider, then site: one row per provider with its one status', () => {
  const data = payload([healthy({ id: 'g1', asset: 'a.test' }), healthy({ id: 'g2', asset: 'b.test' }),
    failing({ id: 'b1', provider: 'bing-webmaster', capability: 'bing-daily', label: 'Bing daily reports', asset: 'pt.test' }),
    healthy({ id: 'b2', provider: 'bing-webmaster', capability: 'bing-daily', label: 'Bing daily reports', asset: 'a.test' }),
    healthy({ id: 'b3', provider: 'bing-webmaster', capability: 'bing-daily', label: 'Bing daily reports', asset: 'b.test' })]);
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={data} nowMs={NOW} providers={[connected('google'), connected('bing-webmaster'), { ...connected('discord'), credential: { ...connected('discord').credential, source: 'none', fields: [] } }]} /></MemoryRouter>);
  // Needs you: Bing only, with the one failing site under it.
  const rows = container.querySelectorAll('[data-connection-row]');
  expect([...rows].map((row) => row.getAttribute('data-connection-row'))).toEqual(['bing-webmaster']);
  const bing = rows[0]!;
  expect(bing.querySelector('[data-status-for="integration:bing-webmaster"][data-connection]')).toHaveAttribute('data-connection', 'working');
  expect(bing).toHaveTextContent('1 site failing');
  expect(bing.querySelectorAll('[data-site]')).toHaveLength(1);
  expect(bing.querySelector('[data-site="pt.test"] [data-connection]')).toHaveAttribute('data-connection', 'failing');
  fireEvent.click(screen.getByRole('button', { name: /^All/ }));
  expect([...container.querySelectorAll('[data-connection-row]')].map((row) => row.getAttribute('data-connection-row'))).toEqual(['google', 'bing-webmaster', 'discord']);
  expect(container.querySelector('[data-connection-row="discord"] [data-connection]')).toHaveAttribute('data-connection', 'not-connected');
  // Each provider is named once; its operations never repeat its name.
  expect(screen.getAllByText('Bing Webmaster Tools')).toHaveLength(1);
});
// The strip's four numbers are the connection model's one derivation
// (`connectionCounts`), which is what a daily record of them must use; until
// one exists each declares its series missing, and why.
it('states the four connection counts from the one derivation, and declares their history missing', () => {
  const data = payload([
    ...['a', 'b', 'c'].map((asset) => healthy({ id: asset, asset })),
    failing({ id: 'd', asset: 'd' }),
    item({ id: 'gap', asset: 'a', capability: 'ga4-archive', label: 'Analytics report archive', detail: 'events · 2026-09-10', report: 'events', reportDate: '2026-09-10', failure: 'network', code: 'network', lastAttemptAt: '2026-09-10T12:00:00Z', lastSuccessAt: null }),
    item({ id: 'today', asset: 'a', capability: 'ga4-archive', label: 'Analytics report archive', detail: 'events · 2026-09-11', report: 'events', reportDate: '2026-09-11', state: 'healthy', failure: null, code: null }),
  ]);
  const providers = [connected('google')];
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={data} nowMs={NOW} providers={providers} /></MemoryRouter>);
  const counts = connectionCounts(providers.map((entry) => connectionStatus(entry.provider.id, entry.credential, currentHealth(data, false, NOW).items)));
  expect(counts).toEqual({ sitesFailing: 1, sitesOverdue: 0, reportsMissing: 1, sitesWorking: 3 });
  const kpi = (label: string) => container.querySelector(`[data-connections] [data-kpi="${label}"]`)!;
  expect(kpi('Sites failing')).toHaveTextContent(String(counts.sitesFailing));
  expect(kpi('Sites overdue')).toHaveTextContent(String(counts.sitesOverdue));
  expect(kpi('Reports missing')).toHaveTextContent(String(counts.reportsMissing));
  expect(kpi('Sites working')).toHaveTextContent(String(counts.sitesWorking));
  for (const label of ['Sites failing', 'Sites overdue', 'Reports missing', 'Sites working']) {
    expect(kpi(label)).toHaveAttribute('data-series', 'unavailable');
    expect(kpi(label)).toHaveAttribute('data-series-reason', CONNECTION_HISTORY_GAP);
  }
});
it('opens a failing site on what failed, what to do and when it last worked', () => {
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={payload([failing({ lastSuccessAt: '2026-09-12T11:55:00Z' })])} nowMs={NOW} provider="google" /></MemoryRouter>);
  const summary = container.querySelector('details summary')!;
  fireEvent.click(summary);
  fireEvent(summary.parentElement!, new Event('toggle'));
  expect(screen.getByText('Access was refused.')).toBeVisible();
  expect(screen.getByText('Wait for the displayed retry.')).toBeVisible();
  expect(screen.getByText('5 minutes ago')).toHaveAttribute('title', expect.stringContaining('UTC'));
  expect(screen.getByRole('link', { name: 'Open example.test' })).toHaveAttribute('href', '/assets/example.test/sources');
  expect(screen.queryByText('access')).toBeNull();
});
it('shows a provider page nothing to list for a provider that is not connected', () => {
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={payload([item({ state: 'disconnected' })])} nowMs={NOW} provider="google" /></MemoryRouter>);
  expect(container).toBeEmptyDOMElement();
});
it('flags monitoring it cannot confirm, and keeps recorded recovery history', () => {
  const data = payload([failing()]);
  data.available = false;
  data.events.push({ id: 'recovery', itemId: 'a', provider: 'google', label: 'Hourly traffic comparison', asset: 'example.test', at: AT, kind: 'recovered' });
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={data} nowMs={NOW} providers={[connected('google')]} /></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('Monitoring incomplete');
  expect(container.querySelector('ol')).toHaveTextContent('Recovered · Hourly traffic comparison');
});
it('uses a read-only saved-health endpoint and rejects malformed responses', async () => {
  const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(payload([item()]))));
  await fetchIntegrationHealth();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/integrations/health', expect.objectContaining({ headers: {accept:'application/json'} }));
  fetch.mockResolvedValue(new Response(JSON.stringify({available:true,items:[{}]})));
  await expect(fetchIntegrationHealth()).rejects.toThrow('invalid response');
});
it.each([{lastSuccessAt:'broken'}, {nextAttemptAt:'broken'}, {coverage:'invented'}, {failure:'invented'}, {failure:['access']}, {reportDate:'yesterday'}, {report:7}, {report:undefined}])('rejects invalid monitoring evidence %j', async patch => {
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(payload([{...item(),...patch} as IntegrationHealthItem]))));
  await expect(fetchIntegrationHealth()).rejects.toThrow('invalid response');
});
it('rejects malformed transition times and event kinds', async () => {
  const data = payload([item()]);
  const fetch = vi.spyOn(globalThis,'fetch');
  for (const event of [{at:'broken',kind:'recovered'}, {at:AT,kind:'invented'}, {at:AT,kind:['recovered']}]) {
    fetch.mockResolvedValue(new Response(JSON.stringify({...data,events:[{id:'event',itemId:'a',provider:'google',label:'Live active users',asset:null,...event}]})));
    await expect(fetchIntegrationHealth()).rejects.toThrow('invalid response');
  }
});
it('takes both new and older Wall links to the shared section', () => {
  const scroll = vi.fn(); const old = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = scroll;
  try {
    render(<MemoryRouter initialEntries={['/health#integration-health']}><IntegrationHealthPanel data={payload([item()])} nowMs={NOW} /></MemoryRouter>);
    expect(scroll).toHaveBeenCalledWith({block:'start'});
    expect(screen.getByRole('region',{name:'Connections'})).toHaveFocus();
  } finally { HTMLElement.prototype.scrollIntoView = old; }
});
