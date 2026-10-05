import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AssetCard } from '@shared/wall';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useOwnerMutation, useOwnerToast, useTowerApi } from '@/lib/browser-context';

/** Stored site order is independent of the Wall layout draft. */
export function SiteOrder({ assets, disabled }: { assets: Pick<AssetCard, 'id' | 'displayName'>[]; disabled: boolean }) {
  const api = useTowerApi();
  const queryClient = useQueryClient();
  const toast = useOwnerToast();
  const busy = useRef(false);
  const move = useOwnerMutation({
    mutationFn: async ({ asset, to, expectRevision }: { asset: string; to: string; expectRevision?: string }) => {
      const result = await api.moveAsset(asset, to, expectRevision);
      await queryClient.invalidateQueries({ queryKey: ['wall'] });
      return result;
    },
  });
  async function save(asset: string, to: string, expectRevision?: string) {
    if (busy.current || disabled) return;
    busy.current = true;
    try {
      const result = await move.mutateAsync({ asset, to, expectRevision });
      toast.success(expectRevision ? 'Site order restored' : 'Site order saved', {
        ...(expectRevision === undefined && result.undoTo !== null ? {
          action: { label: 'Undo', onClick: () => { void save(asset, result.undoTo!, result.revision); } },
        } : {}),
      });
    } catch (error) {
      toast.error(error instanceof ApiError && error.code === 'expect_mismatch'
        ? 'Site order changed elsewhere. Refresh before moving again.'
        : 'Site order could not be confirmed. Refresh before retrying.');
      await queryClient.invalidateQueries({ queryKey: ['wall'] });
    } finally { busy.current = false; }
  }
  return <section aria-labelledby="site-order-heading" className="flex flex-col gap-2">
    <h2 id="site-order-heading" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Site order</h2>
    <ol aria-label="Site order" className="flex flex-col gap-1.5">
      {assets.map((asset, index) => <li key={asset.id} data-site-order={asset.id}
        className="flex items-center gap-2 border border-border bg-card p-2">
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{asset.displayName}</span>
        <div className="flex shrink-0 gap-1">
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${asset.displayName} up`}
            disabled={disabled || move.isPending || index === 0}
            onClick={() => { void save(asset.id, assets[index - 1]!.id); }}><ArrowUp className="size-4" /></Button>
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${asset.displayName} down`}
            disabled={disabled || move.isPending || index === assets.length - 1}
            onClick={() => { void save(asset.id, assets[index + 1]!.id); }}><ArrowDown className="size-4" /></Button>
        </div>
      </li>)}
    </ol>
  </section>;
}
