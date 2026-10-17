// Each site's icons as the ingest last read them from its home page
// (noticeos.asset_icons, written by workers/ingest/src/site-icons.ts), with
// any address the operator set on the site's Settings tab in place of the one
// read (config/tower.json `/sites`). Every surface draws `card.icons`, so this
// is the one place an address set there wins.

import type { SiteIcons } from "@noticeos/contract/site-icons";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { configRegister, fieldOf, fieldRefusal } from "../shared/config-registers";
import { SITE_ICON_KEY, type SiteIconScheme } from "../shared/site-display";

/** Per site: the newest read that reached the page, and the newest read when
 * it found the page unreachable after that. */
export const NEWEST_SITE_ICONS_SQL = `
WITH reached AS (
  SELECT DISTINCT ON (asset_id) asset_id, light_url, dark_url, read_at, outcome
    FROM noticeos.asset_icons
   WHERE outcome <> 'unreachable'
   ORDER BY asset_id, read_at DESC
), newest AS (
  SELECT DISTINCT ON (asset_id) asset_id, read_at, outcome
    FROM noticeos.asset_icons
   ORDER BY asset_id, read_at DESC
)
SELECT n.asset_id AS asset, r.light_url AS light, r.dark_url AS dark, r.read_at AS "readAt", r.outcome,
       CASE WHEN n.outcome = 'unreachable' THEN n.read_at END AS "unreachableAt"
  FROM newest n
  LEFT JOIN reached r ON r.asset_id = n.asset_id`;

type Row = {
  asset: string;
  light: string | null;
  dark: string | null;
  readAt: string | null;
  outcome: string | null;
  unreachableAt: string | null;
};

/** One site's icons as the store holds them, before an address set here. */
export interface StoredSiteIcons {
  light: string | null;
  dark: string | null;
  readAt: string | null;
  outcome: SiteIcons["outcome"];
  unreachableAt: string | null;
}

/**
 * Every site's stored icons, by site id; a site no read has run for is
 * absent. A store that migration 0017 has not reached yet holds no icons,
 * which is what it answers, so no payload fails before the operator applies it.
 */
export async function loadSiteIcons(store: WorkspaceStore): Promise<Map<string, StoredSiteIcons>> {
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
        readAt: row.readAt === null ? null : javascriptInstant(row.readAt),
        outcome: row.outcome === null ? null : row.outcome === "read" ? "read" : "no-icon",
        unreachableAt: row.unreachableAt === null ? null : javascriptInstant(row.unreachableAt),
      },
    ]),
  );
}

/** An address set on the Settings tab, if the register's own rule for its
 * field takes it. The TV reads the stored map without that rule, so an address
 * that reached the store by another route is checked here before any screen
 * draws it. */
function setAddress(set: Partial<Record<SiteIconScheme, string>>, scheme: SiteIconScheme): string | undefined {
  const address = set[scheme];
  if (address === undefined) return undefined;
  const field = fieldOf(configRegister("site-display"), SITE_ICON_KEY[scheme])!;
  return fieldRefusal(field, address) === null ? address : undefined;
}

/**
 * The icons a site's card carries: each address the operator set in place of
 * the one read. Null when nothing was read and nothing is set, which every
 * surface draws as it did before any read.
 */
export function cardIcons(
  stored: StoredSiteIcons | undefined,
  addresses: Partial<Record<SiteIconScheme, string>>,
): SiteIcons | null {
  const set = { light: setAddress(addresses, "light"), dark: setAddress(addresses, "dark") };
  if (stored === undefined && set.light === undefined && set.dark === undefined) return null;
  const read = { light: stored?.light ?? null, dark: stored?.dark ?? null };
  return {
    light: set.light ?? read.light,
    dark: set.dark ?? read.dark,
    readAt: stored?.readAt ?? null,
    outcome: stored?.outcome ?? null,
    read,
    ...(stored?.unreachableAt ? { unreachableAt: stored.unreachableAt } : {}),
  };
}
