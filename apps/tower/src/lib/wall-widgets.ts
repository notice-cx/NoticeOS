// What a Wall widget needs from the payload before it is worth a track. A
// widget with nothing to show renders nothing and yields its track: an empty
// grid track is a hole on the TV for a feature nobody set up. The library
// declares which widgets may vanish (`hidesWhenEmpty` in `shared/wall-layout`);
// this answers whether one of them has anything today. A widget added with
// `hidesWhenEmpty` must answer here, or the build's first render says so.

import type { AttentionItem, AssetCard } from "@shared/wall";
import {
  type WallWidgetSettings,
  type WallWidgetType,
  wallWidgetSpec,
} from "@shared/wall-layout";

/**
 * Has this widget anything to draw?
 *
 * A widget the library does not let vanish is always true — its own empty state
 * is a fact worth the space (a calm Needs you, a month with no revenue source).
 * A widget that may vanish takes what its answer reads as a second argument
 * when one is added.
 */
export function wallWidgetHasContent(type: WallWidgetType): boolean {
  if (!wallWidgetSpec(type).hidesWhenEmpty) return true;
  // A `hidesWhenEmpty` widget with no answer here would silently keep its
  // track forever, so it fails loudly instead.
  throw new Error(`no emptiness rule for the ${type} widget`);
}

/**
 * The `assets` setting, applied to a list of asset cards.
 *
 * The LAYOUT's order wins, not the payload's: an operator who put one asset first
 * asked for it first, and the payload's own order is the seed order every other
 * surface uses. An absent filter is every asset, untouched — the setting exists
 * to narrow a Wall, never to reorder one nobody narrowed.
 */
export function filterWallAssets(
  assets: AssetCard[],
  settings: WallWidgetSettings | undefined,
): AssetCard[] {
  const ids = settings?.assets;
  // An empty filter is "every asset" too: the validator reads a stored `[]`
  // that way, and so must the renderer.
  if (ids === undefined || ids.length === 0) return assets;
  return ids
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is AssetCard => asset !== undefined);
}

/**
 * The same setting, applied to the alerts Needs you lists. A cross-asset row
 * ("Four assets have never reported") states one fact about several assets,
 * so it survives while any of its members is on the filtered Wall, and it
 * states it about those members only. Rows are kept in payload order, which
 * is severity order.
 */
export function filterWallAttention(
  items: AttentionItem[],
  settings: WallWidgetSettings | undefined,
): AttentionItem[] {
  const ids = settings?.assets;
  if (ids === undefined || ids.length === 0) return items;
  const wanted = new Set(ids);
  const kept: AttentionItem[] = [];
  for (const item of items) {
    if (item.members === undefined) {
      if (wanted.has(item.asset)) kept.push(item);
      continue;
    }
    const members = item.members.filter((member) => wanted.has(member.asset));
    if (members.length > 0) kept.push({ ...item, members });
  }
  return kept;
}
