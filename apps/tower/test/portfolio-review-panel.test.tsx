import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from './render';
import type { SettingsPayload } from '@shared/settings';
import { PortfolioReviewPanel } from '@/routes/settings/PortfolioReviewPanel';
import { configSaveReply } from './config-save-reply';
const state = vi.hoisted(() => ({ writable: true }));
vi.mock('@/hooks/useConfigWritable', () => ({ useConfigWritable: () => ({ writable: state.writable }) }));
const assets = [{ id: 'alpha.example', displayName: 'Alpha' }, { id: 'beta.example', displayName: 'Beta' }];
let client: QueryClient;
function show(assetIds: string[] | null = null) {
  const writes: { ops: unknown[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return new Response('Unexpected read', { status: 404 });
    writes.push(JSON.parse(String(init.body)));
    return Response.json(configSaveReply(init));
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const settings: SettingsPayload['portfolioReview'] = { owner: 'config/constants.json', assetIds, assets };
  return { ...render(<QueryClientProvider client={client}><PortfolioReviewPanel settings={settings} /></QueryClientProvider>), writes };
}
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); state.writable = true; });
describe('AI portfolio review asset selection', () => {
  it('defaults to every current and future asset and saves a guarded subset with Undo', async () => {
    const { writes } = show();
    expect(screen.getByRole('radio', { name: 'All assets' })).toBeChecked();
    expect(screen.getByText('Includes new assets automatically.')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Choose assets' }));
    expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Beta/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save asset selection' })); });
    expect(await screen.findByText('Saved')).toBeVisible();
    expect(writes[0]!.ops).toEqual([{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/portfolio_brief/asset_ids', expect: null, value: ['alpha.example'] }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.ops).toEqual([{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/portfolio_brief/asset_ids', expect: ['alpha.example'], value: null }]);
    expect(screen.getByRole('radio', { name: 'All assets' })).toBeChecked();
  });
  it('retains saved order in the guard and permits an explicit empty selection', async () => {
    const { writes } = show(['beta.example', 'alpha.example']);
    expect(screen.getByRole('radio', { name: 'Choose assets' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Beta/ }));
    expect(screen.getByText('No assets selected. Portfolio review will not run.')).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save asset selection' })); });
    expect(await screen.findByText('Saved')).toBeVisible();
    expect(writes[0]!.ops).toEqual([{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/portfolio_brief/asset_ids', expect: ['beta.example', 'alpha.example'], value: [] }]);
    expect(screen.getByRole('radio', { name: 'Choose assets' })).toBeChecked();
    expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).checked)).toBe(true);
  });
  it('renders a persisted subset and keeps selection controls read-only when saves are paused', () => {
    state.writable = false;
    show(['beta.example']);
    expect(screen.getByRole('checkbox', { name: /Beta/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Alpha/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'All assets' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Beta/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save asset selection' })).toBeDisabled();
  });
});
