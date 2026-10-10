// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { emptyDraft, planWrites } from '@shared/asset-wizard';
import { lifecycleMoveRef } from '@noticeos/contract/configuration';
import { createAssetOperations, lifecycleSaveRequest } from '@/lib/asset-operations';
import { ApiError, AssetExistsError, type CreatedAsset } from '@/lib/api';

function planned() {
  return planWrites({ ...emptyDraft(), domain: 'example.com', displayName: 'Example' }, [], []);
}
const row: CreatedAsset = { id: 'example.com', domain: 'example.com', displayName: 'Example', status: 'pre-launch', senseOnly: 1, isOs: 0, createdAt: '2026-09-14', updatedAt: '2026-09-14' };
function ports() {
  return {
    createAsset: vi.fn(async () => row),
    createAssetConfig: vi.fn(async () => ({ applied: 1, archive: '', commit: null })),
  };
}

describe('asset operation confirmation and recovery', () => {
  it('does not attach configuration after an uncertain create or a duplicate on retry', async () => {
    const writes = ports();
    writes.createAsset.mockRejectedValueOnce(new Error('connection lost'))
      .mockRejectedValueOnce(new ApiError('exists', 409, 'asset_exists'));
    const operation = createAssetOperations(writes);
    expect(await operation.create(planned())).toEqual({ kind: 'failed', message: 'connection lost' });
    expect(await operation.create(planned())).toMatchObject({ kind: 'rejected', field: 'domain' });
    expect(writes.createAssetConfig).not.toHaveBeenCalled();
  });

  // One site per domain: the store names the site that holds it, whose id can
  // differ from the one just typed (an imported site).
  it('offers the site the store names as holding the domain, not the id just typed', async () => {
    const writes = ports();
    writes.createAsset.mockRejectedValueOnce(new AssetExistsError(409, 'archived-site', 'retired'))
      .mockRejectedValueOnce(new ApiError('exists', 409, 'asset_exists'));
    const operation = createAssetOperations(writes);
    expect(await operation.create(planned())).toEqual({ kind: 'rejected', field: 'domain', message: 'Already added', existing: 'archived-site', existingStatus: 'retired' });
    // A refusal that names no site offers no way to one.
    expect(await operation.create(planned())).toEqual({ kind: 'rejected', field: 'domain', message: 'Already added' });
    expect(writes.createAssetConfig).not.toHaveBeenCalled();
  });

  it('pins the acknowledged plan and retries only setup, preserving its conflict guards', async () => {
    const writes = ports();
    writes.createAssetConfig.mockRejectedValueOnce(new Error('setup response lost'));
    const operation = createAssetOperations(writes);
    const plan = planned();
    const originalOps = structuredClone(plan.ops);
    const first = await operation.create(plan);
    expect(first.kind).toBe('setup-needed');
    if (first.kind !== 'setup-needed') throw new Error('expected recovery');
    expect(JSON.parse(first.report.changeset).ops).toEqual(originalOps);
    plan.row.id = 'different.com';
    plan.ops.length = 0;
    expect(await operation.create(plan)).toMatchObject({ kind: 'created', plan: { row: { id: 'example.com' }, ops: originalOps } });
    expect(writes.createAsset).toHaveBeenCalledTimes(1);
    expect(writes.createAssetConfig.mock.calls).toEqual([[originalOps, 'add-asset-example-com'], [originalOps, 'add-asset-example-com']]);
  });

  it('does not infer confirmation from a different returned identity', async () => {
    const writes = ports();
    writes.createAsset.mockResolvedValueOnce({ ...row, id: 'different.com' });
    expect(await createAssetOperations(writes).create(planned())).toMatchObject({ kind: 'failed' });
    expect(writes.createAssetConfig).not.toHaveBeenCalled();
  });

  it('suppresses overlapping submissions before any second write starts', async () => {
    const writes = ports();
    let acknowledge!: (asset: CreatedAsset) => void;
    writes.createAsset.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const operation = createAssetOperations(writes);
    const first = operation.create(planned());
    expect(await operation.create(planned())).toEqual({ kind: 'busy' });
    expect(writes.createAssetConfig).not.toHaveBeenCalled();
    acknowledge(row);
    expect(await first).toMatchObject({ kind: 'created' });
    expect(writes.createAsset).toHaveBeenCalledTimes(1);
    expect(writes.createAssetConfig).toHaveBeenCalledTimes(1);
  });

  it('records the acknowledged stage move and its inverse using the same recipe', async () => {
    const record = vi.fn(async () => {});
    const request = lifecycleSaveRequest(row.id, 'baselining', 'retired', record);
    expect(record).not.toHaveBeenCalled();
    expect(request.ops).toEqual([{ kind: 'store-asset-set', asset: row.id, column: 'status', expect: 'baselining', value: 'retired' }]);
    await request.record!(request.ops);
    await request.record!([{ kind: 'store-asset-set', asset: row.id, column: 'status', expect: 'retired', value: 'baselining' }]);
    expect(record.mock.calls).toEqual([
      [{ kind: 'config', ref: lifecycleMoveRef({ from: 'baselining', to: 'retired' }) }],
      [{ kind: 'config', ref: lifecycleMoveRef({ from: 'retired', to: 'baselining' }) }],
    ]);
  });
});
