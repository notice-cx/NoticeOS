// Each site's icons as the ingest last read them from its home page
// (noticeos.asset_icons, written by workers/ingest/src/site-icons.ts). A card
// carries the newest read that reached the page, so a morning on which a site
// did not answer leaves the icons it declared the day before.

import type { SiteIcons } from "@noticeos/contract/site-icons";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";

export const NEWEST_SITE_ICONS_SQL = `
SELECT DISTINCT ON (asset_id)
       asset_id AS asset, light_url AS light, dark_url AS dark, read_at AS "readAt", outcome
  FROM noticeos.asset_icons
 WHERE outcome <> 'unreachable'
 ORDER BY asset_id, read_at DESC`;

type Row = { asset: string; light: string | null; dark: string | null; readAt: string; outcome: string };

/**
 * Every site's icons, by site id; a site no read has reached is absent. A store
 * that migration 0017 has not reached yet holds no icons, which is what it
 * answers, so no payload fails before the operator applies it.
 */
export async function loadSiteIcons(store: WorkspaceStore): Promise<Map<string, SiteIcons>> {
  const rows = await store.read(async (tx) => {
    const [table] = await tx.query<{ present: boolean }>(
      `SELECT to_regclass('noticeos.asset_icons') IS NOT NULL AS present`,
    );
    return table?.present ? tx.query<Row>(NEWEST_SITE_ICONS_SQL) : [];
  });
  return new Map(
    rows.map((row) => [
      row.asset,
      {
        light: row.light,
        dark: row.dark,
        readAt: javascriptInstant(row.readAt),
        outcome: row.outcome === "read" ? "read" : "no-icon",
      },
    ]),
  );
}
