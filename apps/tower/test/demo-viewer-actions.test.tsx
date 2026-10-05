import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from './render';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_PROVIDERS, type MediavineStatus } from '@noticeos/contract';
import type { IntegrationProviderStatus } from '@shared/integrations-page';
import { validateDemoViewer } from '@shared/demo-viewer';
import { WATCH_SERIES } from '@noticeos/contract';
import { ProviderCard } from '@/components/ProviderCard';
import { ExecutiveFindingsList } from '@/components/ExecutiveFindingsList';
import { AddSiteButton } from '@/components/AddSite';
import { ArchiveCard } from '@/routes/asset-detail/AssetRetirement';
import { FetchEndpointEditor } from '@/routes/asset-detail/CollectionSetup';
import { ActivityTab } from '@/routes/asset-detail/ActivityTab';
import { MediavineSettings } from '@/routes/asset-detail/MediavineSettings';
import { everyTabPayload } from './asset-detail-fixture';

const lifecycle = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAssetLifecycle', () => ({ useAssetLifecycle: () => lifecycle }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); window.localStorage.removeItem('noticeos:property-findings:example.com'); });
const now = Date.parse('2026-09-16T12:00:00.000Z');
function enableDemo() {
  vi.stubGlobal('__DEMO_VIEWER__', validateDemoViewer({ version: 1, synthetic: true,
    release: '1'.repeat(40), scenarioHash: '2'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111',
    cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null }));
}
function connected(): IntegrationProviderStatus {
  const provider = INTEGRATION_PROVIDERS.find(provider => provider.id === 'bing-webmaster')!;
  return { provider, credential: { provider: provider.id, source: 'store', fields: provider.fields.map(field => field.name),
    assetsHeld: [], missingFields: [], auth: 'account-key', metadata: null, keyVersion: 1,
    createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null },
    assets: [{ id: 'example.com', lanes: ['bing-webmaster'] }] };
}
function withQueries(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>);
  return () => { view.unmount(); client.clear(); };
}

describe('demo operations stay separate from stored reads', () => {
  it('never lifts a visitor’s old preferences into shared findings or replaces the shared story', () => {
    enableDemo();
    const snapshot = { ...everyTabPayload().executive!, asset: 'example.com' };
    const preferences = JSON.stringify({ marked: [snapshot.items[0]!.key], dismissed: [] });
    window.localStorage.setItem('noticeos:property-findings:example.com', preferences);
    const decide = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ writable: true, reason: null, sources: {} })));
    const close = withQueries(<ExecutiveFindingsList snapshot={snapshot} onDecide={decide} />);
    expect(screen.queryByRole('button', { name: 'Mark' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeEnabled();
    expect(window.localStorage.getItem('noticeos:property-findings:example.com')).toBe(preferences);
    expect(decide).not.toHaveBeenCalled(); close();
  });
  it('keeps a connected card navigable while no credential operation can run', () => {
    const operations = { onConnect: vi.fn(), onTest: vi.fn(), onDisconnect: vi.fn(), onSetExpiry: vi.fn(), onReplace: vi.fn() };
    render(<MemoryRouter><ProviderCard status={connected()} assets={[{ id: 'example.com', displayName: 'Example', domain: null }]}
      nowMs={now} guided readOnly {...operations} /></MemoryRouter>);
    const test = screen.getByRole('button', { name: 'Test connection' });
    expect(test).toBeDisabled(); fireEvent.click(test);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose sites' }));
    expect(screen.getByRole('link', { name: 'Example' })).toHaveAttribute('href', '/assets/example.com/sources');
    fireEvent.click(screen.getByRole('button', { name: /Settings$/ }));
    expect(screen.getByText('No expiry date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record an expiry…' })).toBeNull();
    for (const operation of Object.values(operations)) expect(operation).not.toHaveBeenCalled();
  });
  it('ordinary connected cards retain their existing operations', () => {
    render(<MemoryRouter><ProviderCard status={connected()} assets={[]} nowMs={now}
      onConnect={vi.fn()} onTest={vi.fn()} onDisconnect={vi.fn()} onSetExpiry={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record an expiry…' })).toBeEnabled();
  });
  it('does not open site creation, endpoint setup or archive/restore actions', async () => {
    enableDemo();
    const fetch = vi.fn(async () => Response.json({ writable: true, reason: null, sources: {} }));
    vi.stubGlobal('fetch', fetch);
    const data = everyTabPayload();
    const close = withQueries(<><AddSiteButton /><FetchEndpointEditor asset={data.asset.id} />
      <ArchiveCard asset={data.asset} timeline={data.annotations} /></>);
    for (const name of ['Add a site', 'Fetch from an endpoint', 'Archive site…']) {
      const button = screen.getByRole('button', { name }); expect(button).toBeDisabled(); fireEvent.click(button);
    }
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull(); expect(lifecycle).not.toHaveBeenCalled();
    close();
    const restore = withQueries(<ArchiveCard asset={{ ...data.asset, status: 'retired' }} timeline={data.annotations} />);
    expect(screen.getByRole('button', { name: /^Restore/ })).toBeDisabled();
    expect(lifecycle).not.toHaveBeenCalled(); restore();
  });
  it('shows the recorded timeline without opening an annotation or seeded watch composer', () => {
    enableDemo();
    const data = everyTabPayload();
    const close = withQueries(<ActivityTab data={data} nowMs={now}
      seed={{ subject: 'Example outcome', series: WATCH_SERIES[0]!, query: null, beadId: null }} onSeedDone={vi.fn()} />);
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Watch an outcome' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Something happened' })).toBeNull(); close();
  });
  it('reads saved revenue and date rows without refresh, backfill or calendar writes', async () => {
    enableDemo();
    const status = { connected: true, siteId: 'synthetic', enabled: true, holidayCalendar: 'none' as const,
      daily: [{ date: '2026-09-15', amountMinor: 1234 }], availableThrough: '2026-09-15', reportedThrough: '2026-09-15',
      lastSuccessAt: null, lastAttemptAt: null, nextAttemptAt: null, differenceMinor: null, error: null };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true, value: status satisfies Partial<MediavineStatus> }));
    vi.stubGlobal('fetch', fetch);
    const close = withQueries(<MediavineSettings asset="example.com" />);
    await screen.findByRole('button', { name: 'Refresh revenue' });
    for (const name of ['Refresh revenue', 'Fetch dates', 'Save forecast calendar']) {
      const button = screen.getByRole('button', { name }); expect(button).toBeDisabled(); fireEvent.click(button);
    }
    expect(screen.getByRole('combobox', { name: 'Forecast holiday calendar' })).toBeDisabled();
    fireEvent.click(screen.getByText('Saved daily revenue · 1 days'));
    expect(screen.getByRole('cell', { name: '$12.34' })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([input]) => String(input).startsWith('/api/integrations/mediavine/'))).toHaveLength(1); close();
  });
});
