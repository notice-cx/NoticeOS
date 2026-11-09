/** Evidence about the organic projection, independent of collection health and AI Overviews. */
export const SERP_PANEL_FAMILY = 'dataforseo-serp-panel';

const GOOGLE_SEARCH_DOMAIN = /^(?:www\.)?google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/iu;
const GOOGLE_HOST = /^(?:[^.]+\.)*google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/iu;
const MIN_QUERIES = 5;
const COLLAPSE_FRACTION = 0.9;

interface DomainSource {
  reportedDomain: string;
  urlDomain: string;
  googleUrlKind: 'internal' | 'hosted' | null;
}

interface OrganicObservation {
  report_date: string;
  query: string;
  device: string;
  best_rank: string | number | null;
  top3_domains: string | null;
  top3_reported_domains?: string | null;
  top3_url_domains?: string | null;
  top3_google_url_kinds?: string | null;
}

export interface SerpOrganicQuality {
  reportDate: string;
  status: 'suspect' | 'clear' | 'unassessed';
  rows: number;
  usableRows: number;
  rankedRows: number;
  googleOnlyRows: number;
  googleOnlyQueries: number;
  sourceRows: number;
  googleInternalUrls: number;
  conflictingDomains: number;
  provenance: 'legacy-top-domains' | 'source-fields';
}

/** Keep hosts and Google URL kind so the projected domain can be traced to
 * the provider's declared domain or its URL. Query strings can carry tokens. */
export function serpDomainSource(reportedDomain: string, value: string): DomainSource {
  let url: URL;
  try { url = new URL(value); } catch { return { reportedDomain, urlDomain: '', googleUrlKind: null }; }
  const urlDomain = url.hostname.replace(/^www\./iu, '');
  const bare = GOOGLE_SEARCH_DOMAIN.test(urlDomain);
  const internal = bare && /^\/(?:url|search|imgres|aclk)\/?$/u.test(url.pathname);
  const hosted = GOOGLE_HOST.test(urlDomain) && (!bare || url.pathname !== '/');
  return { reportedDomain, urlDomain, googleUrlKind: internal ? 'internal' : hosted ? 'hosted' : null };
}

/** Flag a panel-wide collapse across distinct terms. A legitimate Google
 * destination can rank, and a site can be outside the tracked depth. */
export function assessSerpOrganicQuality(rows: readonly OrganicObservation[]): SerpOrganicQuality | null {
  const reportDate = rows.reduce((latest, row) => row.report_date > latest ? row.report_date : latest, '');
  if (!reportDate) return null;
  const newest = new Map<string, OrganicObservation>();
  for (const row of rows) {
    if (row.report_date !== reportDate || !row.query.trim()) continue;
    const key = JSON.stringify([row.query.trim().toLowerCase(), row.device.trim().toLowerCase() || 'desktop']);
    if (!newest.has(key)) newest.set(key, row);
  }
  const usableQueries = new Set<string>();
  const googleOnlyQueries = new Set<string>();
  let usableRows = 0, rankedRows = 0, googleOnlyRows = 0, unresolvedGoogleRows = 0;
  let sourceRows = 0, googleInternalUrls = 0, conflictingDomains = 0;
  for (const row of newest.values()) {
    if (Number(row.best_rank) > 0) rankedRows++;
    const query = row.query.trim().toLowerCase();
    const domains = row.top3_domains?.split('|').map(domain => domain.trim()) ?? [];
    if (domains.length === 3 && domains.every(Boolean)) {
      usableRows++;
      usableQueries.add(query);
    }
    const reportedDomains = row.top3_reported_domains?.split('|') ?? [];
    const urlDomains = row.top3_url_domains?.split('|') ?? [];
    const urlKinds = row.top3_google_url_kinds?.split('|') ?? [];
    if (reportedDomains.some(Boolean) || urlDomains.some(Boolean)) sourceRows++;
    googleInternalUrls += urlKinds.filter(kind => kind === 'internal').length;
    for (const [index, reported] of reportedDomains.entries()) {
      if (reported && urlDomains[index] && reported !== urlDomains[index]) conflictingDomains++;
    }
    if (domains.length !== 3 || !domains.every(domain => GOOGLE_SEARCH_DOMAIN.test(domain))) continue;
    googleOnlyRows++;
    if (urlKinds.length === 3 && urlKinds.every(kind => kind === 'hosted')) continue;
    unresolvedGoogleRows++;
    googleOnlyQueries.add(query);
  }

  const status = usableQueries.size < MIN_QUERIES ? 'unassessed'
    : rankedRows === 0 && googleOnlyQueries.size >= MIN_QUERIES && unresolvedGoogleRows >= newest.size * COLLAPSE_FRACTION
      ? 'suspect' : 'clear';
  return {
    reportDate, status, rows: newest.size, usableRows, rankedRows, googleOnlyRows, googleOnlyQueries: googleOnlyQueries.size,
    sourceRows, googleInternalUrls, conflictingDomains, provenance: sourceRows ? 'source-fields' : 'legacy-top-domains',
  };
}
