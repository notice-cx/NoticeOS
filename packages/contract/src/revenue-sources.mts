// The revenue sources product code writes under by name. Each is a row of the
// store's vocabulary (`noticeos_ref.revenue_sources`), which holds its
// provider, family, the name readers show and its reporting clock; readers
// take those from the row, never from here.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

/** What Mediavine's publisher dashboard reports: a site's daily Journey ad
 * revenue estimate. */
export const MEDIAVINE_REVENUE_SOURCE = 'mediavine-journey';
