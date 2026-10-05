import type { AssetStatus } from '@shared/asset-detail';
import { useAnnotationWriter } from './useAnnotationWriter';
import { useConfigSave } from './useConfigSave';
import { lifecycleSaveRequest } from '@/lib/asset-operations';

/** Stage changes and their Undo share the same timeline recording recipe. */
export function useAssetLifecycle(assetId: string) {
  const save = useConfigSave();
  const record = useAnnotationWriter(assetId);
  return (from: AssetStatus, to: AssetStatus, label?: string) =>
    save(lifecycleSaveRequest(assetId, from, to, record, label));
}
