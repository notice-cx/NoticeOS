// After a connection is accepted: which sites, and collect them now. The
// ingest Worker lists what a connected account can see and runs the first
// collection; the Tower composes that list with the portfolio's assets; the
// connect panel draws the result and sends one press.
//
// Nothing here carries a credential. A site is a public identity plus the
// mapping fields the asset's Data sources tab would write for it (the
// `asset-lane` register fields in `scripts/config-registers.mts`).

import type { PosthogFunnel } from './configuration.mjs';

/**
 * One site, property or project a connected account lists, or — for a
 * provider that covers the portfolio's own sites rather than an account's
 * (DataForSEO) — one asset it would collect.
 */
export interface DiscoveredSite {
  /** The data source (register lane id) this site is collected on. */
  lane: string;
  /** The provider's own id for the site: a Bing site URL, a GA4 property id,
   * a Mediavine site id. Stable; what a row keys on. */
  ref: string;
  /** The provider's own name for it. */
  label: string;
  /** The host it answers for, normalized by {@link siteHost}, or null when the
   * provider states none. Matching to an asset compares this and nothing else. */
  host: string | null;
  /** The `asset-lane` register fields this site writes on an asset, exactly as
   * the asset's Data sources tab writes them (`siteUrl`, `propertyId`,
   * `host` + `projectId`, `mediavineSiteId`). Empty when the lane needs no
   * mapping to collect (DataForSEO asks in the asset's own market). */
  mapping: Record<string, string | number>;
  /** For a portfolio provider: the asset this site IS. */
  asset?: string;
  /** PostHog: the project's saved funnel insights, as the register's funnels.
   * Start writes them only where the site's entry holds none. */
  funnels?: PosthogFunnel[];
  /** False when the provider lists the site but will not serve it yet — a
   * Bing site whose ownership was never verified. Such a site is listed, never
   * dropped, and never pre-ticked. */
  ready: boolean;
}

/**
 * What a connected account can see, or why that could not be read.
 *
 * `account` — the provider lists the sites (Bing, Google, Mediavine, PostHog).
 * `portfolio` — the provider collects the portfolio's own sites by their
 * domain (DataForSEO); `sites` are the ones its collector's own membership
 * rule covers today.
 */
export type SiteDiscovery =
  | { ok: true; provider: string; kind: 'account' | 'portfolio'; checkedAt: string; sites: DiscoveredSite[] }
  | { ok: false; provider: string; checkedAt: string; reason: SiteDiscoveryFailure };

/** `not-connected` — no credential is stored; `refused` — the provider said
 * no; `unreachable` — it did not answer; `not-supported` — this provider does
 * not list sites here. */
export type SiteDiscoveryFailure = 'not-connected' | 'refused' | 'unreachable' | 'not-supported';

/**
 * The one host rule: what "matches by domain" means, everywhere. Lowercased
 * hostname, a leading `www.` dropped, any scheme, port, path or query ignored;
 * a Search Console domain property (`sc-domain:example.com`) reads as its
 * domain. A test pins it equal to the Bing collector's `normalizeBingHost`.
 * Anything unparseable is null: a guess is never a match.
 */
export function siteHost(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const domain = /^sc-domain:(.+)$/i.exec(trimmed)?.[1];
  // Parsed by hand rather than with `URL`: this package types no runtime
  // globals.
  const authority = (domain ?? trimmed).replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  return host.replace(/^www\./, '');
}

// --- collect now --------------------------------------------------------------

/** One press on the connect panel: collect these assets' first data now. */
export interface CollectNowInput {
  provider: string;
  assets: string[];
}

/**
 * What the first collection did for one asset, as the lane's own run reported
 * it. Its status is never read from here: the connection model reads the
 * stored attempt, so a site is Working only once its result is stored.
 *
 * `collected` — the lane stored a result; `failed` — the provider refused or
 * failed it (`code` is the lane's own error code); `unmeasured` — the OS could
 * not reach the provider (the egress gate's verdict); `skipped` — nothing was
 * due, or the lane's own rules (cap, lease) held it back.
 */
export interface CollectNowSite {
  asset: string;
  outcome: 'collected' | 'failed' | 'unmeasured' | 'skipped';
  code: string | null;
  /** Reports the run stored, where the lane counts reports (DataForSEO). */
  reports?: number;
  /** What the run cost, where the lane records a cost. */
  costUsd?: number;
}

export type CollectNowResult =
  | {
      ok: true;
      provider: string;
      /** The scheduled job whose step ran (`scripts/scheduled-jobs.mts`). */
      job: string;
      startedAt: string;
      finishedAt: string;
      sites: CollectNowSite[];
    }
  | {
      ok: false;
      provider: string;
      error: CollectNowRefusal;
      /** The scheduled job the step belongs to, when there is one. */
      job?: string;
    };

/**
 * Why nothing ran. `not-supported` — the provider has no collect-now step;
 * `not-connected` — no credential is stored; `paused` — the operator paused
 * the job on its schedule; `in-flight` — the lane's own lease is held by a
 * run already collecting; `no-sites` — none of the named assets is one the
 * lane collects.
 */
export type CollectNowRefusal = 'not-supported' | 'not-connected' | 'paused' | 'in-flight' | 'no-sites';

/**
 * A metered provider's spend preview, shown before its first collection
 * (DataForSEO). Every figure is read from the OS's own cost records — never a
 * provider call — and the ceiling is what the lane's budget gate reserves
 * before each report, so "at most" is a promise the lane enforces.
 */
export interface SiteSpendPreview {
  /** The UTC month the spend and cap are counted in, 'YYYY-MM'. */
  period: string;
  /** Month-to-date spend, the same reader the cap gate sums. */
  spentUsd: number;
  unknownPrices: number;
  /** `monthly_caps.data_usd`. */
  capUsd: number;
  /** What one site's weekly reports cost on average over the recorded weeks,
   * or null when nothing has been recorded yet. */
  perSiteWeekUsd: number | null;
  /** What the budget gate reserves for one site's reports: the most one site's
   * first collection can cost. */
  perSiteCeilingUsd: number;
}
