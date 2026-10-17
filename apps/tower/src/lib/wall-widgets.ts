// What a Wall widget needs from the payload before it is worth a track. A
// widget with nothing to show renders nothing and yields its track: an empty
// grid track is a hole on the TV for a feature nobody set up. The library
// declares which widgets may vanish (`hidesWhenEmpty` in `shared/wall-layout`);
// this answers whether one of them has anything today. A widget added with
// `hidesWhenEmpty` must answer here, or the build's first render says so.

import type { AttentionItem, AssetCard, WallPayload } from "@shared/wall";
import { sitesShownOn } from "@shared/site-display";
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
  return attentionAbout(items, (asset) => ids.includes(asset));
}

/** The alerts about the sites `wanted` keeps: a cross-site row keeps only
 * those members, and leaves when none is left. */
function attentionAbout(items: AttentionItem[], wanted: (asset: string) => boolean): AttentionItem[] {
  const kept: AttentionItem[] = [];
  for (const item of items) {
    if (item.members === undefined) {
      if (wanted(item.asset)) kept.push(item);
      continue;
    }
    const members = item.members.filter((member) => wanted(member.asset));
    if (members.length > 0) kept.push({ ...item, members });
  }
  return kept;
}

/** The payload the TV draws, and the sites left off it. */
export interface WallOnTv {
  data: WallPayload;
  /** The site ids whose TV switch is off, for the widgets that read their
   * own data (the live feed). */
  hidden: ReadonlySet<string>;
}

/**
 * The payload as the TV draws it: only the sites whose TV switch is on
 * (`siteShownOn`) and only the alerts about them, before any widget's own
 * site list narrows it further. The System's own alerts stay.
 */
export function wallOnTv(data: WallPayload): WallOnTv {
  const shown = sitesShownOn(data.assets, data.dashboard.sites, "tv");
  if (shown.length === data.assets.length) return { data, hidden: new Set() };
  const kept = new Set(shown.map((asset) => asset.id));
  const hidden = new Set(data.assets.filter((asset) => !kept.has(asset.id)).map((asset) => asset.id));
  const attention = attentionAbout(data.attention, (asset) => !hidden.has(asset));
  return { data: { ...data, assets: shown, attention }, hidden };
}

/** The sites with a row in the TV's Work this week: their Work this week
 * switch is on. Read on a payload `wallOnTv` already narrowed, so a site off
 * the TV has no row either. */
export function sitesInWork(data: Pick<WallPayload, "assets" | "dashboard">): AssetCard[] {
  return sitesShownOn(data.assets, data.dashboard.sites, "work");
}
