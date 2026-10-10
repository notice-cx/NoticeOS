// The order sites are listed in, in one place for both Workers. Each site
// stores its place, `list_position`: 1 is first, and no two sites of a
// workspace share one. A new site takes the next place at the end, retiring
// or restoring a site keeps its place, and the operator moves a site with one
// write (`moveAsset`, workers/ingest/src/asset-state.ts).

/** The ORDER BY expression for `noticeos.assets`, unqualified. */
export const SITE_ORDER = 'list_position';
