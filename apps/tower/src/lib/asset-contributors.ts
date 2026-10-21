import type { AssetCard } from "@shared/wall";
import type { BarStripContributor } from "@/components/viz/BarStrip";

const TONES = ["text-asset-1", "text-asset-2", "text-asset-3", "text-asset-4", "text-asset-5", "text-asset-6"] as const;

/** One identity per asset across Home's charts, independent of value and input order. */
export function assetContributors(assets: readonly Pick<AssetCard, "id" | "displayName">[]): BarStripContributor[] {
  return [...assets].sort((a, b) => a.id.localeCompare(b.id)).map((asset, index) => ({
    id: asset.id,
    name: asset.displayName,
    tone: TONES[index % TONES.length]!,
  }));
}
