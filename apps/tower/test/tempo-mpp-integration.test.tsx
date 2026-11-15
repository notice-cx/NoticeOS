import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from './render';
import { TEMPO_MPP_POINTER, TEMPO_MPP_TESTNET, type TempoMppSettings } from '@noticeos/contract/configuration';
import type { TempoMppSetup } from '@noticeos/contract/tempo-mpp';
import type { SaveRequest } from '@/hooks/useConfigSave';
import { TempoMppIntegration } from '@/routes/integrations/TempoMppIntegration';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<() => Promise<TempoMppSetup>>(),
  save: vi.fn<(input: SaveRequest) => Promise<boolean>>(),
}));
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  fetchTempoMppSetup: mocks.fetch,
}));
vi.mock('@/hooks/useConfigSave', () => ({ useConfigSave: () => mocks.save }));
vi.mock('@/hooks/useConfigWritable', () => ({ useConfigWritable: () => ({ writable: true }) }));

const WALLET = '0x0101010101010101010101010101010101010101';
const TOKEN = '0x0202020202020202020202020202020202020202';
const assets = [{ id: 'first.example', name: 'First site' }, { id: 'second.example', name: 'Second site' }];
const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const renderSettings = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TempoMppIntegration /></QueryClientProvider>);
};

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.save.mockReset();
});

it('sets up multiple assets on one wallet, restores the saved values, and pauses collection', async () => {
  const setup: TempoMppSetup = { settings: null, assets, payments: [], scan: null, hasMore: false };
  mocks.fetch.mockImplementation(async () => ({ ...setup }));
  mocks.save.mockImplementation(async ({ ops }) => {
    const op = ops[0];
    if (op?.kind !== 'file-json-set') throw new Error('Expected a settings save');
    setup.settings = op.value as TempoMppSettings;
    return true;
  });
  const mounted = renderSettings();
  await screen.findByRole('button', { name: 'Add mapping' });
  fill(/Network/, String(TEMPO_MPP_TESTNET));
  fill(/Receiving wallet/, WALLET);
  fill(/Token contract/, TOKEN);
  fill(/Start at block/, '123');
  const add = screen.getByRole('button', { name: 'Add mapping' });
  fireEvent.click(add);
  fireEvent.click(add);
  const [left, right] = screen.getAllByLabelText(/MPP realm/);
  fireEvent.change(left!, { target: { value: 'first.example.com' } });
  fireEvent.change(right!, { target: { value: 'first.example.com' } });
  const [first, second] = screen.getAllByLabelText(/^Asset/);
  fireEvent.change(first!, { target: { value: assets[0]!.id } });
  fireEvent.change(second!, { target: { value: assets[1]!.id } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Collect payments automatically' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(right!, { target: { value: 'second.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  const settings = {
    chainId: TEMPO_MPP_TESTNET, startBlock: 123, wallet: WALLET, token: TOKEN, enabled: true,
    mappings: [{ asset: assets[0]!.id, realm: 'first.example.com' }, { asset: assets[1]!.id, realm: 'second.example.com' }],
  };
  await waitFor(() => expect(mocks.save).toHaveBeenNthCalledWith(1, expect.objectContaining({
    ops: [{ kind: 'file-json-set', file: 'config/integrations.json', pointer: TEMPO_MPP_POINTER, expectAbsent: true, value: settings }],
  })));
  mounted.unmount();
  renderSettings();
  await screen.findByRole('button', { name: 'Add mapping' });
  expect(screen.getByLabelText(/Receiving wallet/)).toHaveValue(WALLET);
  expect(screen.getAllByLabelText(/^Asset/)[1]).toHaveValue(assets[1]!.id);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Collect payments automatically' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(mocks.save).toHaveBeenNthCalledWith(2, expect.objectContaining({
    ops: [{ kind: 'file-json-set', file: 'config/integrations.json', pointer: TEMPO_MPP_POINTER, expect: settings,
      value: { ...settings, enabled: false } }],
  })));
});

it('links a saved test transfer to the testnet explorer', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  mocks.fetch.mockResolvedValue({
    settings: null, scan: null, assets, hasMore: false,
    payments: [{ chainId: TEMPO_MPP_TESTNET, hash, logIndex: 14, asset: assets[0]!.id, baseUnits: '500000',
      settledAt: '2026-11-15T17:18:51Z', product: 'Carrier batch', state: 'test-payment' }],
  });
  renderSettings();
  expect(await screen.findByRole('link', { name: 'View transaction' }))
    .toHaveAttribute('href', `https://explore.testnet.tempo.xyz/tx/${hash}`);
});
