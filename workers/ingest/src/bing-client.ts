// Shared, read-only Bing Webmaster API boundary.
//
// Both the live chart collector and the analysis archive use this module so
// site discovery, response limits, error normalization, and date parsing
// cannot drift. API keys are added only to the outbound URL and are never
// returned to callers or written into an archive request descriptor.

import type { WorkspaceStore } from '@noticeos/postgres';
import { SITE_ORDER } from '@noticeos/contract';
import { SignalError, boundedResponseJson, type SignalTarget } from './signal-store.js';
import {
  type LaneRegister,
  type ResolvedMapping,
  resolveLaneRef,
} from './lane-mapping.js';
import { asRecord, stringField, utcDay } from './shared.js';

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;

export const BING_CREDENTIAL_REF = 'BING_WEBMASTER_API_KEY';

export interface BingPortfolioCandidate {
  asset: string;
  domain: string;
}

export interface BingWebmasterTarget extends SignalTarget {
  integration: 'bing-webmaster';
}

/** The sites Bing is asked about: every one but the OS that is not retired and
 * has a domain. */
export async function loadBingPortfolioCandidates(
  store: WorkspaceStore,
): Promise<BingPortfolioCandidate[]> {
  return store.read((tx) =>
    tx.query<{ asset: string; domain: string }>(
      `SELECT asset_id AS asset, domain
         FROM noticeos.assets
        WHERE NOT is_os
          AND status <> 'retired'
          AND domain IS NOT NULL
        ORDER BY ${SITE_ORDER}`,
    ),
  );
}

/**
 * `credentialRef` names which credential ran the pull and where it came from:
 * the caller passes `sourcedCredentialRef(BING_CREDENTIAL_REF, source)`,
 * `store:BING_WEBMASTER_API_KEY` for a product-held key and the bare binding
 * name for the legacy env one, which is also the default.
 */
export function bingTarget(
  candidate: BingPortfolioCandidate,
  propertyRef = candidate.domain,
  credentialRef: string = BING_CREDENTIAL_REF,
): BingWebmasterTarget {
  return {
    asset: candidate.asset,
    integration: 'bing-webmaster',
    credentialRef,
    propertyRef,
  };
}

/**
 * Which Bing site this asset is, for both Bing lanes. The register's `siteUrl`
 * wins where the operator has stated one: Bing spells a site as a URL and the
 * account may hold several that share a host, which the domain match cannot
 * tell apart. Otherwise the asset's own domain is matched against the sites
 * the account lists as verified, and `null` means `bwt_site_unverified`.
 * `sites` is null when the credential itself failed; a register-mapped asset
 * still resolves, because the mapping is a fact about the asset.
 */
export function bingSiteMapping(
  asset: string,
  domain: string,
  sites: Map<string, string> | null,
  register?: LaneRegister,
): ResolvedMapping<string> | null {
  const matched = sites === null ? null : sites.get(normalizeBingHost(domain)) ?? null;
  return resolveLaneRef(
    asset,
    'bing-webmaster',
    { value: matched, source: 'domain-match' },
    register,
  );
}

export async function getBingVerifiedSites(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  const body = await bingRequest('GetUserSites', {}, apiKey, fetchImpl);
  const rows = bingResponseRows(body, 'bwt_sites_invalid_response');
  const sites = new Map<string, string>();
  for (const value of rows) {
    const record = asRecord(value);
    if (record?.IsVerified === false || record?.isVerified === false) continue;
    const siteUrl =
      stringField(record, 'Url') ??
      stringField(record, 'url') ??
      (typeof value === 'string' ? value : null);
    if (!siteUrl) continue;
    const host = normalizeBingHost(siteUrl);
    if (host) sites.set(host, siteUrl);
  }
  return sites;
}

export async function bingRequest(
  method: string,
  query: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('apikey', apiKey);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await boundedResponseJson(response, 'Bing Webmaster', RESPONSE_BYTE_LIMIT);
  if (!response.ok || hasProviderError(body)) {
    throw bingProviderError(response.status, body);
  }
  return body;
}

export function bingResponseRows(body: unknown, code: string): unknown[] {
  const wrapped = asRecord(body)?.d;
  const rows = Array.isArray(wrapped)
    ? wrapped
    : Array.isArray(body)
      ? body
      : null;
  if (!rows) {
    throw new SignalError(code, 'Bing Webmaster returned an unexpected response.');
  }
  return rows;
}

export function parseBingDate(
  value: unknown,
  errorCode = 'bwt_traffic_invalid_response',
): string | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const legacy = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
    if (legacy) {
      const time = Number(legacy[1]);
      return Number.isFinite(time) ? utcDay(new Date(time)) : null;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return utcDay(new Date(value));
  }
  throw new SignalError(
    errorCode,
    'Bing Webmaster returned a malformed date.',
  );
}

export function normalizeBingHost(value: string): string {
  try {
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hasProviderError(body: unknown): boolean {
  const record = asRecord(body);
  const errorCode = record?.ErrorCode ?? record?.errorCode;
  return Boolean(
    stringField(record, 'Message') ||
      stringField(record, 'ErrorMessage') ||
      (errorCode !== undefined && errorCode !== null && Number(errorCode) !== 0),
  );
}

function bingProviderError(status: number, body: unknown): SignalError {
  const record = asRecord(body);
  const nested = asRecord(record?.error);
  const message =
    stringField(record, 'Message') ??
    stringField(record, 'ErrorMessage') ??
    stringField(nested, 'Message') ??
    stringField(nested, 'message') ??
    `Bing Webmaster request failed with HTTP ${status}.`;
  return new SignalError(`bwt_http_${status}`, message.slice(0, 500));
}
