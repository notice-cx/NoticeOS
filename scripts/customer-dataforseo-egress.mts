import { readBoundedJsonText } from './bounded-json-body.mjs';

export const DATAFORSEO_ORIGIN = 'https://api.dataforseo.com';
export const DATAFORSEO_ACCOUNT_PATH = '/v3/appendix/user_data';
export const DATAFORSEO_REPORT_PATHS = {
  rankedKeywords: '/dataforseo_labs/google/ranked_keywords/live',
  backlinksSummary: '/backlinks/summary/live',
  backlinksNewLost: '/backlinks/timeseries_new_lost_summary/live',
  referringDomains: '/backlinks/referring_domains/live',
  anchors: '/backlinks/anchors/live',
  keywordIdeas: '/dataforseo_labs/google/keyword_ideas/live',
  competitors: '/dataforseo_labs/google/competitors_domain/live',
  panel: '/serp/google/organic/live/advanced',
  llmMentions: '/ai_optimization/llm_mentions/target_metrics/live',
} as const;

const API_VERSION = '/v3';
const paidPaths = new Set(Object.values(DATAFORSEO_REPORT_PATHS).map(path => `${API_VERSION}${path}`));
/** How long a paid call may wait, by report path. The panel asks the provider
 * to resolve Google's redirect links, which the provider allows 260 seconds;
 * a shorter deadline abandons a call the provider still bills. */
export const dataForSeoPaidTimeoutMs = (path: string): number =>
  path === DATAFORSEO_REPORT_PATHS.panel ? 270_000 : 130_000;
// Existing connection checks carry no provider credential.
export const DATAFORSEO_EGRESS_BEACONS = [
  'https://www.cloudflare.com/cdn-cgi/trace', 'https://www.google.com/generate_204',
] as const;
const beacons = new Set<string>(DATAFORSEO_EGRESS_BEACONS);
const refused = () => new Response(null, { status: 403 });

/** Only the scheduler's paid-only Worker receives this outbound transport. */
export function localDataForSeoOutbound({ signal, transport = fetch }: { signal?: AbortSignal; transport?: typeof fetch } = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const clean = url.origin === DATAFORSEO_ORIGIN && !url.search && !url.hash && !url.username && !url.password;
    const paid = clean && request.method === 'POST' && paidPaths.has(url.pathname);
    const account = clean && request.method === 'GET' && url.pathname === DATAFORSEO_ACCOUNT_PATH;
    if (!(paid || account || request.method === 'GET' && beacons.has(url.href))) return refused();
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (paid || account) {
      const authorization = request.headers.get('authorization');
      if (!authorization || authorization.length > 8192 || !/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(authorization)) return refused();
      headers.authorization = authorization;
    }
    let body;
    if (paid) {
      try {
        body = await readBoundedJsonText(request, 16_384);
        const tasks: unknown = JSON.parse(body);
        if (!Array.isArray(tasks) || tasks.length !== 1 || !tasks[0] || typeof tasks[0] !== 'object' || Array.isArray(tasks[0])) return refused();
      } catch { return refused(); }
      headers['content-type'] = 'application/json';
    }
    const bounded = AbortSignal.any([AbortSignal.timeout(paid ? dataForSeoPaidTimeoutMs(url.pathname.slice(API_VERSION.length)) : 10_000), request.signal, ...(signal ? [signal] : [])]);
    bounded.throwIfAborted();
    const response = await transport(url.href, { method: request.method, headers, body, redirect: 'manual', signal: bounded });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return response;
  };
}
