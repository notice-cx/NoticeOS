import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from './render';
import { integrationProvider, type CredentialSummary } from '@noticeos/contract';
import { ProviderConnectPanel } from '@/routes/integrations/ProviderConnectPanel';

vi.mock('@/hooks/useIntegrationProviders', () => ({ INTEGRATION_PROVIDERS_KEY: ['integration-providers'], useIntegrationProviders: () => ({ data: { providers: [] } }) }));
vi.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('@/hooks/useConfigWritable', () => ({ useConfigWritable: () => ({ writable: true }) }));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function show(over: Partial<CredentialSummary> = {}) {
  const credential: CredentialSummary = { provider: 'local-model', source: 'store', fields: ['LOCAL_MODEL_BASE_URL', 'LOCAL_MODEL_ID'], assetsHeld: [], missingFields: [],
    auth: null, metadata: null, keyVersion: 1, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: '2026-11-06T12:00:00.000Z', lastError: null,
    modelOutputTokens: 16384, ...over };
  const changed = vi.fn(async () => {});
  return { ...render(<QueryClientProvider client={client}><MemoryRouter><ProviderConnectPanel
    status={{ provider: integrationProvider('local-model')!, credential, assets: [] }} opened="sites" asset={null} canConnect items={[]} names={new Map()}
    onClose={() => {}} onChanged={changed} /></MemoryRouter></QueryClientProvider>), changed };
}
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
describe('a connected model generation budget', () => {
  it('prepopulates the saved budget and updates it without reentering connection fields or discovering models', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const { changed } = show();
    const input = screen.getByLabelText('Generation budget');
    expect(input).toHaveValue(16384);
    expect(screen.queryByLabelText(/^API base URL/)).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Model *' })).toBeNull();
    fireEvent.change(input, { target: { value: '24576' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save generation budget' })); });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/integrations/local-model/budget', {
      method: 'PUT', headers: expect.objectContaining({ 'content-type': 'application/json' }), body: JSON.stringify({ modelOutputTokens: 24576 }),
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByText('Generation budget saved.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save generation budget' })).toBeDisabled();
  });
  it('uses the default for an older connection and blocks invalid budgets', () => {
    show({ modelOutputTokens: undefined });
    const input = screen.getByLabelText('Generation budget');
    expect(input).toHaveValue(8192);
    fireEvent.change(input, { target: { value: '32769' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save generation budget' })).toBeDisabled();
    expect(screen.getByText('Use a whole number from 1,024 to 32,768.')).toBeVisible();
  });
  it('shows a legacy environment budget without silently replacing the connection', () => {
    show({ source: 'env', modelOutputTokens: 12288 });
    expect(screen.getByLabelText('Generation budget')).toHaveValue(12288);
    expect(screen.getByLabelText('Generation budget')).toBeDisabled();
    expect(screen.getByText('Replace this connection to change its generation budget.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save generation budget' })).toBeDisabled();
  });
});
