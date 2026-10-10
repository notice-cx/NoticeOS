// What a connected account can see: the connect panel's second screen lists
// the account's sites and the Tower matches them to assets by domain. It runs
// here because the credential lives here and never leaves. One free read,
// nothing stored: a listing records no credential verdict and no health
// observation, so opening the panel twice can never move a status. Every
// provider without a case answers `not-supported`, not an empty list.

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
 * PostHog: the projects the connected key reads, in the region that accepts
 * it, each with the domain it records and its saved funnels. An install still
 * on a key per site is listed through each of its keys (the first ten), merged
 * by project. Every key refusing is `refused`; no key answering is `unreachable`.
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
 * Mediavine: the sites the login reads. Straight after Connect, the list its
 * sign-in already fetched; later, one call under the Mediavine lease. Each
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
