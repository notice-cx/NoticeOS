import { preloadCommandPalette } from "@/lib/palette-launch";
import { ASSET_TABS } from "@/routes/asset-detail/AssetTabs";
import { preloadAssetTab } from "@/routes/asset-detail/lazy-tabs";

/**
 * Have the code of every asset tab arrive before a suite draws the page.
 *
 * Since bead `ro-ujb9.84` each tab's code is fetched the first time the tab is
 * drawn, so the first render of a tab in a test file shows the neutral loading
 * frame for a moment. A suite about what a tab SAYS calls this in `beforeAll`:
 * code that has already arrived is drawn on the very first render (`lazyPart`),
 * which is the page every assertion in it was written against. Suites about the
 * loading itself (`lazy-parts.test.tsx`) never call it.
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
