import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from './render';
import * as api from '@/lib/api';
import { CloudflareD1Panel } from '@/routes/integrations/CloudflareD1Panel';
import { ConnectPanel } from '@/components/ConnectPanel';
import { integrationProvider } from '@noticeos/contract';
import type { D1Receipt, D1Status } from '@noticeos/contract/cloudflare-d1';

const accountId = 'a'.repeat(32), databaseId = '11111111-1111-4111-8111-111111111111';
const inventory = { accountId, databases: [{ id: databaseId, name: 'Example database' }] };
const initial: D1Status = { accountId, selection: null, accountMismatch: false, receipts: [] };
const receipt: D1Receipt = { version: 1, accountId, databaseId, asset: 'example.com', runId: '22222222-2222-4222-8222-222222222222',
  startedAt: '2026-10-01T12:00:00Z', finishedAt: '2026-10-01T12:00:01Z', state: 'complete', bytes: 42, sha256: 'b'.repeat(64), failure: null };
beforeEach(() => vi.restoreAllMocks());
function panel(canSave = true, connect = false) {
  const body = <CloudflareD1Panel inventory={inventory} names={new Map([['example.com', 'Example']])} canSave={canSave} onChanged={async () => {}} />;
  return render(<QueryClientProvider client={new QueryClient()}>{connect ? <ConnectPanel provider={integrationProvider('cloudflare')!} canConnect onClose={() => {}}
    presentation="inline" onConnect={async () => ({ verdict: 'accepted', checkedAt: receipt.startedAt, facts: { databases: 1, cloudflareD1: inventory } })}
    next={() => body} /> : body}</QueryClientProvider>);
}
it('connects then explicitly selects an asset and starts backup with one action', async () => {
  const read = vi.spyOn(api, 'fetchD1Status').mockResolvedValue(initial);
  const save = vi.spyOn(api, 'saveD1Selection').mockResolvedValue(initial);
  const run = vi.spyOn(api, 'exportD1Database').mockResolvedValue(receipt);
  panel(true, true);
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: accountId } });
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const database = await screen.findByRole('checkbox', { name: 'Example database' });
  expect(read).toHaveBeenCalledWith(false);
  fireEvent.click(database);
  expect(screen.getByRole('button', { name: 'Clear selection' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Asset for Example database' }), { target: { value: 'example.com' } });
  expect(screen.getByText('Export temporarily blocks database queries.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Back up selected' }));
  await screen.findByText('Export stored');
  expect(save).toHaveBeenCalledWith({ version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }] });
  expect(run).toHaveBeenCalledWith(accountId, databaseId);
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!);
});
it('shows a stored export failure on its database and preserves the saved selection', async () => {
  vi.spyOn(api, 'fetchD1Status').mockResolvedValue({ ...initial, selection: { version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }] } });
  vi.spyOn(api, 'saveD1Selection').mockResolvedValue(initial);
  vi.spyOn(api, 'exportD1Database').mockResolvedValue({ ...receipt, state: 'failed', bytes: null, sha256: null, failure: 'access_denied' });
  panel();
  const button = await screen.findByRole('button', { name: 'Back up selected' });
  fireEvent.click(button);
  await screen.findByText('Review D1 export permission');
  expect(screen.getByRole('checkbox', { name: 'Example database' })).toBeChecked();
});
it('requires explicit remapping after account change and disables effects for a reader', async () => {
  vi.spyOn(api, 'fetchD1Status').mockResolvedValue({ ...initial, accountMismatch: true, selection: { version: 1, accountId: 'b'.repeat(32), targets: [{ databaseId, asset: 'example.com' }] } });
  const save = vi.spyOn(api, 'saveD1Selection').mockResolvedValue(initial);
  panel(false);
  await screen.findByText('Account changed · choose databases again');
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Example database' })).not.toBeChecked());
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Clear selection' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});
it('replaces carried inventory when the accepted account changed before the panel loaded', async () => {
  const currentId = crypto.randomUUID();
  const read = vi.spyOn(api, 'fetchD1Status').mockResolvedValueOnce({ ...initial, accountId: 'b'.repeat(32) })
    .mockResolvedValue({ ...initial, accountId: 'b'.repeat(32), databases: [{ id: currentId, name: 'Current database' }] });
  panel();
  await screen.findByRole('checkbox', { name: 'Current database' });
  expect(screen.queryByRole('checkbox', { name: 'Example database' })).toBeNull();
  expect(read.mock.calls).toEqual([[false], [true]]);
});
