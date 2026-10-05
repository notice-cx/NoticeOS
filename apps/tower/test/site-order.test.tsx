import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteOrder } from '@/routes/wall-edit/SiteOrder';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { createApi, type ApiTransport } from '@/lib/api';
import { decodeAssetOrder } from '@/lib/critical-response';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
const assets = [{ id: 'first.test', displayName: 'First' }, { id: 'second.test', displayName: 'Second' }];
const moved = { ok: true, asset: 'first.test', order: ['second.test', 'first.test'], revision: 'a'.repeat(64), undoTo: 'second.test' };
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.retire()); vi.clearAllMocks(); });
function setup(disabled = false) {
  const fetch = vi.fn<ApiTransport>(async () => Response.json(moved));
  const runtime = createBrowserRuntime({ mode: 'standalone', clientGeneration: 0 }, { origin: location.origin, fetch, sendAnswer: async () => {} });
  runtimes.push(runtime);
  const invalidate = vi.spyOn(runtime.queries, 'invalidateQueries');
  const ui = render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}>
    <QueryClientProvider client={runtime.queries}><SiteOrder assets={assets} disabled={disabled} /></QueryClientProvider>
  </BrowserRuntimeProvider>);
  return { ...ui, fetch, runtime, invalidate };
}
function undo() {
  const action = toasts.success.mock.calls.at(-1)?.[1]?.action as { onClick: () => void } | undefined;
  if (!action) throw new Error('Expected Undo');
  return action.onClick;
}
describe('site ordering from the Wall editor', () => {
  it('names the destination, refreshes shared data, and sends the exact saved revision on Undo', async () => {
    const f = setup();
    expect(screen.getByRole('button', { name: 'Move First up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Second down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(String(f.fetch.mock.calls[0]?.[0])).toBe(location.origin + '/api/assets/first.test/order');
    expect(JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body))).toEqual({ to: 'second.test' });
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['wall'] });
    act(undo());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body))).toEqual({ to: 'second.test', expectRevision: moved.revision });
    await waitFor(() => expect(toasts.success).toHaveBeenLastCalledWith('Site order restored', {}));
  });
  it('refuses read-only controls and an Undo captured by a retired browser context', async () => {
    const disabled = setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move First down' })); expect(disabled.fetch).not.toHaveBeenCalled();
    disabled.unmount();
    const f = setup(); fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const oldUndo = undo(); f.runtime.retire(); act(oldUndo);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('shows a stale Undo refusal and refreshes without reporting a restored order', async () => {
    const f = setup(); fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    f.fetch.mockResolvedValueOnce(Response.json({ error: 'expect_mismatch' }, { status: 409 }));
    act(undo());
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Site order changed elsewhere. Refresh before moving again.'));
    expect(toasts.success).toHaveBeenCalledTimes(1); expect(f.invalidate).toHaveBeenCalledTimes(2);
  });
});
describe('site-order response checks', () => {
  it.each([{ ...moved, asset: 'foreign.test' }, { ...moved, order: ['first.test', 'first.test'] },
    { ...moved, revision: '' }, { ...moved, undoTo: 'absent.test' }, { ...moved, undoTo: 'first.test' }])('refuses malformed success before exposing Undo', value => {
    expect(() => decodeAssetOrder(value, 'first.test')).toThrow('Save outcome unknown');
  });
  it('does not deliver a completed response to a retired owner', async () => {
    let active = true;
    const api = createApi(async () => { active = false; return Response.json(moved); }, () => { if (!active) throw new Error('retired'); });
    await expect(api.moveAsset('first.test', 'second.test')).rejects.toThrow('retired');
  });
});
