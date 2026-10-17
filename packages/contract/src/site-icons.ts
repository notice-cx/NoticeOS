// A site's icons as its home page declares them. The ingest reads them once a
// day and stores each read (workers/ingest/src/site-icons.ts,
// noticeos.asset_icons); the Tower carries them on every site card
// (apps/tower/shared/wall.ts AssetCard), with any address the operator set on
// the site's Settings tab in place of the one read. Types and constants only,
// so browser code imports this module by subpath.

/**
 * What one read of a site's home page found: `read`, at least one declared
 * icon; `no-icon`, the page answered and declared none; `unreachable`, no page
 * came back.
 */
export const SITE_ICON_OUTCOMES = ['read', 'no-icon', 'unreachable'] as const;
export type SiteIconOutcome = (typeof SITE_ICON_OUTCOMES)[number];

/** The icons a site's card carries. */
export interface SiteIcons {
  /** Absolute address of the icon every light surface draws: the address set
   * on the site's Settings tab, else the one read, else null. A read icon for
   * light surfaces has no media query, or one that is not
   * prefers-color-scheme: dark. */
  light: string | null;
  /** Absolute address of the icon every dark surface draws: the address set
   * on the site's Settings tab, else the one read (an icon whose media query
   * matches prefers-color-scheme: dark), else null. */
  dark: string | null;
  /** When the newest read that reached the home page ran, ISO 8601 UTC; null
   * when no read has reached it. A site that did not answer one morning keeps
   * what it declared the day before. */
  readAt: string | null;
  /** What that read found: `read` when either address was declared, `no-icon`
   * when neither was; null when no read has reached the page. */
  outcome: Exclude<SiteIconOutcome, 'unreachable'> | null;
  /** The addresses that read found, before an address set on the Settings tab
   * replaces one. Absent on a payload from before addresses could be set:
   * `light` and `dark` are then the read ones. */
  read?: { light: string | null; dark: string | null };
  /** When a newer read than `readAt` found the page unreachable, its time:
   * the addresses above stand from the read before. Absent otherwise. */
  unreachableAt?: string;
}

/** Read one site's icons now (the site's Settings tab, Read again). */
export interface SiteIconsReadInput {
  asset: string;
}

/**
 * One Read again, as the ingest answers it: the read it stored, or why
 * nothing was read. `unmeasured` is a read the OS could not make because it
 * could not reach the network itself, which stores nothing.
 */
export type SiteIconsReadResult =
  | {
      ok: true;
      asset: string;
      readAt: string;
      outcome: SiteIconOutcome | 'unmeasured';
      light: string | null;
      dark: string | null;
    }
  | { ok: false; asset: string; error: SiteIconsReadRefusal };

/**
 * Why a Read again read nothing: `paused`, the daily job that reads icons is
 * paused; `no-site`, the site has no domain, is retired or is the System;
 * `not-migrated`, the store has no table for icon reads yet; `failed`, the
 * read could not be stored.
 */
export type SiteIconsReadRefusal = 'paused' | 'no-site' | 'not-migrated' | 'failed';
