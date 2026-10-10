// What a person reads as an asset's name. The OS's own row (`assets.is_os =
// 1`, asset #0) is the product, not a site, so its name is always the
// product's name; its stored `display_name` is never displayed. Every payload,
// feed row and message that names an asset goes through `assetDisplayName`.
// The OS is known by `is_os`, never by its id.

/** The product's name. */
export const PRODUCT_NAME = 'NoticeOS';

/** The name a person reads for one row of `assets`: the product's name for the
 * OS's own row, the stored `display_name` for every other. `isOs` is the
 * column as stored (0 or 1) or already read as a boolean. */
export function assetDisplayName(isOs: number | boolean | null | undefined, storedName: string): string {
  return isOs === 1 || isOs === true ? PRODUCT_NAME : storedName;
}
