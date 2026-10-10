import { preloadCommandPalette } from "@/lib/palette-launch";
import { ASSET_TABS } from "@/routes/asset-detail/AssetTabs";
import { preloadAssetTab } from "@/routes/asset-detail/lazy-tabs";

/**
 * Have the code of every asset tab arrive before a suite draws the page, so a
 * first render does not show the loading frame. Suites about the loading itself
 * (`lazy-parts.test.tsx`) never call it.
 */
export async function loadAssetTabs(): Promise<void> {
  const arrived = await Promise.all(ASSET_TABS.map((tab) => preloadAssetTab(tab)));
  const missing = ASSET_TABS.filter((_, index) => !arrived[index]);
  if (missing.length > 0) throw new Error(`asset tab code did not load: ${missing.join(", ")}`);
}

/** The same for the command palette, which arrives on first open. */
export async function loadCommandPalette(): Promise<void> {
  if (!(await preloadCommandPalette())) throw new Error("the command palette's code did not load");
}
