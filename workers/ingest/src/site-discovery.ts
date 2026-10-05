// WHAT A CONNECTED ACCOUNT CAN SEE (bead `ro-ujb9.96.7.2`, epic `ro-ujb9.96.7`).
//
// The connect panel's second screen: once a key is accepted, the account's
// sites are listed and the Tower matches them to the portfolio's assets by
// domain. This module is the listing half — it runs here because the
// credential lives here and never leaves.
//
// ONE FREE READ, NOTHING STORED. A listing is not evidence: it records no
// credential verdict and no health observation (the connect press and the
// collectors do that), so opening the panel twice can never move a status.
// What comes back are public identities — a site URL, an asset's domain — and
// the register fields the asset's Data sources tab would write for each.
//
// ONE CASE PER PROVIDER, and every provider without one answers
// `not-supported` rather than an empty list: "this account lists nothing" and
// "this panel cannot ask" are different facts. PostHog joined under
// `ro-ujb9.96.7.8`, Mediavine under `ro-ujb9.96.7.6`, Google (GA4 and Search
// Console, two lanes on one row) under `ro-ujb9.96.7.7`.

import type { DiscoveredSite, IntegrationProviderId, SiteDiscovery } from '@noticeos/contract';
import { integrationProvider, siteHost } from '@noticeos/contract';
import { BING_CREDENTIAL_REF, bingRequest, bingResponseRows } from './bing-client.js';
import { bingRefused } from './credential-connect.js';
import { discoverGoogleSites } from './credential-probes.js';
import { resolveCredential } from './credentials.js';
import { dataForSeoCandidates } from './dataforseo-dumps.js';
import { discoverMediavineSites } from './mediavine-connection.js';
import { POSTHOG_ACCOUNT_KEY_SLOT, discoverPosthogProjects } from './posthog-account.js';
import { POSTHOG_KEY_SLOT, resolvePosthogKeys } from './posthog-dumps.js';

export interface DiscoverSitesOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/** List what `provider`'s stored credential can see. Never throws. */
export async function discoverSites(
  env: IngestEnv,
  provider: string,
  options: DiscoverSitesOptions = {},
): Promise<SiteDiscovery> {
  const checkedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const declared = integrationProvider(provider);
  if (declared === null || !['bing-webmaster', 'dataforseo', 'posthog', 'mediavine', 'google'].includes(declared.id)) {
    return { ok: false, provider, checkedAt, reason: 'not-supported' };
  }
  const credential = await resolveCredential(env, declared.id as IntegrationProviderId);
  if (credential.source === 'none') return { ok: false, provider, checkedAt, reason: 'not-connected' };

  if (declared.id === 'posthog') {
    return { provider, checkedAt, ...(await posthogSites(credential.fields, options.fetchImpl ?? fetch)) };
  }

  if (declared.id === 'mediavine') return { provider, checkedAt, ...(await mediavineSites(env, options)) };

  if (declared.id === 'google') return { provider, checkedAt, ...(await discoverGoogleSites(env, options)) };

  if (declared.id === 'dataforseo') {
    // The collector's OWN membership rule, so the list is exactly what the
    // weekly reports cover — no second copy of which assets qualify.
    const candidates = await dataForSeoCandidates(env.STORE);
    return {
      ok: true, provider, kind: 'portfolio', checkedAt,
      sites: candidates.map((candidate) => ({
        lane: 'dataforseo', ref: candidate.asset, label: candidate.domain, host: siteHost(candidate.domain),
        mapping: {}, asset: candidate.asset, ready: true,
      })),
    };
  }

  const apiKey = credential.fields[BING_CREDENTIAL_REF];
  if (!apiKey) return { ok: false, provider, checkedAt, reason: 'not-connected' };
  try {
    const body = await bingRequest('GetUserSites', {}, apiKey, options.fetchImpl ?? fetch);
    return { ok: true, provider, kind: 'account', checkedAt, sites: bingSites(bingResponseRows(body, 'bwt_sites_invalid_response')) };
  } catch (error) {
    return { ok: false, provider, checkedAt, reason: bingRefused(error) ? 'refused' : 'unreachable' };
  }
}

/** The most distinct keys one PostHog listing asks with. */
const POSTHOG_MAX_KEYS = 10;

/**
 * PostHog (bead `ro-ujb9.96.7.8`): the projects the connected key reads, in
 * the region that accepts it, each with the domain it records and its saved
 * funnels. An install still on a key per site is listed through each of its
 * keys (the first ten), merged by project, so its panel shows what those keys
 * can see rather than nothing. Every key refusing is `refused`; no key
 * answering at all is `unreachable`.
 */
async function posthogSites(
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; kind: 'account'; sites: DiscoveredSite[] } | { ok: false; reason: 'refused' | 'unreachable' | 'not-connected' }> {
  let perSite: string[] = [];
  try {
    perSite = [...resolvePosthogKeys(fields[POSTHOG_KEY_SLOT]).values()];
  } catch {
    // A map that does not parse holds no key this listing can use.
  }
  const keys = [...new Set([fields[POSTHOG_ACCOUNT_KEY_SLOT], ...perSite].filter((key): key is string => typeof key === 'string' && key !== ''))]
    .slice(0, POSTHOG_MAX_KEYS);
  if (keys.length === 0) return { ok: false, reason: 'not-connected' };
  const answers = await Promise.all(keys.map((key) => discoverPosthogProjects(key, fetchImpl)));
  const sites = new Map<string, DiscoveredSite>();
  for (const answer of answers) if (answer.ok) for (const site of answer.sites) if (!sites.has(site.ref)) sites.set(site.ref, site);
  if (answers.some((answer) => answer.ok)) return { ok: true, kind: 'account', sites: [...sites.values()] };
  return { ok: false, reason: answers.every((answer) => !answer.ok && answer.reason === 'refused') ? 'refused' : 'unreachable' };
}

/**
 * Mediavine (bead `ro-ujb9.96.7.6`): the sites the login reads — straight
 * after Connect, the list its sign-in already fetched, so the panel asks
 * Mediavine nothing more; later, one call under the Mediavine lease. Each
 * site maps as its id, which is what the ad revenue entry stores.
 */
async function mediavineSites(
  env: IngestEnv,
  options: DiscoverSitesOptions,
): Promise<{ ok: true; kind: 'account'; sites: DiscoveredSite[] } | { ok: false; reason: 'refused' | 'unreachable' }> {
  const listed = await discoverMediavineSites(env, { ...options, evidence: false });
  if (!listed.ok) return { ok: false, reason: listed.kind === 'auth' || listed.kind === 'permission' ? 'refused' : 'unreachable' };
  return { ok: true, kind: 'account', sites: mediavineDiscovered(listed.value) };
}

/** Mediavine's sites as discovered sites: every one listed, matched and
 * named by its domain (its title where it states none). */
export function mediavineDiscovered(sites: readonly { id: string; title: string; domain: string }[]): DiscoveredSite[] {
  return sites.map((site) => ({
    lane: 'ad-network', ref: site.id, label: site.domain || site.title, host: siteHost(site.domain),
    mapping: { mediavineSiteId: site.id }, ready: true,
  }));
}

/**
 * Bing's `GetUserSites` rows as sites: every site the account holds, the
 * unverified ones included (listed, never pre-ticked — the collector cannot
 * read them until their owner is verified in Bing). The mapping is `siteUrl`
 * exactly as Bing spells it, which is what the register field stores.
 */
export function bingSites(rows: unknown[]): DiscoveredSite[] {
  const sites: DiscoveredSite[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const url = typeof record?.Url === 'string' ? record.Url : typeof record?.url === 'string' ? record.url : typeof value === 'string' ? value : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const verified = record?.IsVerified !== false && record?.isVerified !== false;
    sites.push({ lane: 'bing-webmaster', ref: url, label: url, host: siteHost(url), mapping: { siteUrl: url }, ready: verified });
  }
  return sites;
}
