// A site's icons as its home page declares them. The ingest reads them once a
// day and stores each read (workers/ingest/src/site-icons.ts,
// noticeos.asset_icons); the Tower carries them on every site card
// (apps/tower/shared/wall.ts AssetCard). Types and constants only, so browser
// code imports this module by subpath.

/**
 * What one read of a site's home page found: `read`, at least one declared
 * icon; `no-icon`, the page answered and declared none; `unreachable`, no page
 * came back.
 */
export const SITE_ICON_OUTCOMES = ['read', 'no-icon', 'unreachable'] as const;
export type SiteIconOutcome = (typeof SITE_ICON_OUTCOMES)[number];

/** The icons a site's card carries: those of the newest read that reached its
 * home page, so a site that did not answer one morning keeps what it declared. */
export interface SiteIcons {
  /** Absolute address of the icon for light surfaces, or null when the page
   * declares none: an icon with no media query, or one whose query is not
   * prefers-color-scheme: dark. */
  light: string | null;
  /** Absolute address of the icon for dark surfaces, or null when the page
   * declares none: an icon whose media query matches prefers-color-scheme: dark. */
  dark: string | null;
  /** When the ingest read the page, ISO 8601 UTC. */
  readAt: string;
  /** `read` when either address is set, `no-icon` when neither is. */
  outcome: Exclude<SiteIconOutcome, 'unreachable'>;
}
