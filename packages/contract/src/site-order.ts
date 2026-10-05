// THE ORDER SITES ARE LISTED IN, in one place for both Workers (beads
// ro-ujb9.76.4.2 and ro-ujb9.76.52; the site list is `noticeos.assets` on
// Postgres).
//
// Each site stores its place in the list, `list_position`: 1 is first, and no
// two sites of a workspace share one (db/postgres/migrations/0001_baseline.sql
// `assets`). The order is that stored fact, never an accident of when or under
// what id a site was written:
//   - a new site takes the next place, at the end, even when two are added at
//     once (the store hands places out as it hands out every per-workspace
//     number);
//   - the import carries D1's order over: D1 listed sites in the order its rows
//     were inserted (`ORDER BY rowid`), and that order becomes the places, so
//     the switch to Postgres moves no site;
//   - retiring or restoring a site keeps its place;
//   - the operator moves a site with one write (`moveAsset`,
//     workers/ingest/src/asset-state.ts).
// The Tower's cards and panels and the ingest's collectors read one list in
// this one order.

/** The ORDER BY expression for `noticeos.assets`, unqualified. */
export const SITE_ORDER = 'list_position';
