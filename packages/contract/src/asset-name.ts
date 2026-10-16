// What a person reads as an asset's name. The OS's own row (`assets.is_os =
// 1`, asset #0) is this installation's own system, not a site, so it is always
// called the System; its stored `display_name` is never displayed. Every
// payload, feed row and message that names an asset goes through
// `assetDisplayName`. The OS is known by `is_os`, never by its id.

/** The product's name. */
export const PRODUCT_NAME = 'NoticeOS';

/** The name a person reads for the OS's own row. */
export const SYSTEM_NAME = 'System';

/** The name a person reads for one row of `assets`: the System's name for the
 * OS's own row, the stored `display_name` for every other. `isOs` is the
 * column as stored (0 or 1) or already read as a boolean. */
export function assetDisplayName(isOs: number | boolean | null | undefined, storedName: string): string {
  return isOs === 1 || isOs === true ? SYSTEM_NAME : storedName;
}
