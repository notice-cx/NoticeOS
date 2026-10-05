import { describe, expect, it, vi } from 'vitest';
import type { MoveAssetResult } from '@noticeos/contract';
import { handleAssetOrderRequest } from '../worker/asset-order-route';

const url = new URL('https://tower.example/api/assets/first.test/order');
const success = { ok: true, asset: 'first.test', order: ['second.test', 'first.test'],
  revision: 'a'.repeat(64), undoTo: 'second.test' } as const;
function setup(result: MoveAssetResult = { ...success, order: [...success.order] }) {
  const moveAsset = vi.fn(async () => result);
  return { moveAsset, run: (body: unknown, headers: Record<string, string> = {}, method = 'PATCH') => {
    const request = new Request(url, { method, headers: { origin: url.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return handleAssetOrderRequest(request, url, { moveAsset }, 'first.test');
  } };
}
describe('the site-order write boundary', () => {
  it('forwards only the named move and optional Undo guard, returning the stored order', async () => {
    const f = setup();
    const response = await f.run({ to: 'second.test', expectRevision: 'b'.repeat(64) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(success);
    expect(f.moveAsset).toHaveBeenCalledExactlyOnceWith({ asset: 'first.test', to: 'second.test', expectRevision: 'b'.repeat(64) });
  });
  it.each<Record<string, string>>([{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }])('refuses cross-origin writes before RPC', async headers => {
    const f = setup(); expect((await f.run({ to: 'second.test' }, headers)).status).toBe(403);
    expect(f.moveAsset).not.toHaveBeenCalled();
  });
  it.each([null, [], { to: 'second.test', asset: 'foreign.test' }, { to: 'second.test', workspaceId: 'foreign' }, { to: 'x'.repeat(300_000) }])('refuses malformed or expanded envelopes before RPC', async body => {
    const f = setup(); expect((await f.run(body)).status).toBe(422); expect(f.moveAsset).not.toHaveBeenCalled();
  });
  it.each([
    [{ ok: false, error: 'expect_mismatch' }, 409],
    [{ ok: false, error: 'unknown_asset', asset: 'missing.test' }, 404],
    [{ ok: false, error: 'validation', issues: [] }, 422],
  ] as const)('preserves a refused move without reporting success', async (result, status) => {
    const f = setup(result as MoveAssetResult); expect((await f.run({ to: 'second.test' })).status).toBe(status);
  });
  it('keeps internal receiver errors opaque', async () => {
    const f = setup(); f.moveAsset.mockRejectedValueOnce(new Error('private connection detail'));
    const response = await f.run({ to: 'second.test' });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'asset_order_write_failed' });
  });
});
