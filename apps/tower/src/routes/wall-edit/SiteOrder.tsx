import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AssetCard } from '@shared/wall';
import { Button } from '@/components/ui/button';
import { SITES_ARRANGE_ITEM } from '@/components/nav-items';
import { useSiteMove } from '@/hooks/useSiteMove';

/** Stored site order is independent of the Wall layout draft. The Sites
 * page's Arrange holds the same order with drag and each site's switches;
 * these buttons are the keyboard's path from here. */
export function SiteOrder({ assets, disabled }: { assets: Pick<AssetCard, 'id' | 'displayName'>[]; disabled: boolean }) {
  const { move, pending } = useSiteMove();
  const save = (asset: string, to: string) => {
    if (disabled) return;
    void move(asset, to);
  };
  return <section aria-labelledby="site-order-heading" className="flex flex-col gap-2">
    <h2 id="site-order-heading" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Site order</h2>
    <Link to={SITES_ARRANGE_ITEM.to} data-site-order-arrange
      className="inline-flex min-h-11 items-center gap-1 self-start text-xs font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
      Drag them, and choose where each shows, in Arrange
      <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
    </Link>
    <ol aria-label="Site order" className="flex flex-col gap-1.5">
      {assets.map((asset, index) => <li key={asset.id} data-site-order={asset.id}
        className="flex items-center gap-2 border border-border bg-card p-2">
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{asset.displayName}</span>
        <div className="flex shrink-0 gap-1">
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${asset.displayName} up`}
            disabled={disabled || pending || index === 0}
            onClick={() => { save(asset.id, assets[index - 1]!.id); }}><ArrowUp className="size-4" /></Button>
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${asset.displayName} down`}
            disabled={disabled || pending || index === assets.length - 1}
            onClick={() => { save(asset.id, assets[index + 1]!.id); }}><ArrowDown className="size-4" /></Button>
        </div>
      </li>)}
    </ol>
  </section>;
}
