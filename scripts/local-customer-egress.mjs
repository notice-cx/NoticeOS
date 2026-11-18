import { hostedTaskProviderOperation } from './hosted-task-request.mjs';

function googleDailyQuery(url, method) {
  if (method !== 'POST' || url.search || url.hash || url.username || url.password) return false;
  if (url.origin === 'https://oauth2.googleapis.com') return url.pathname === '/token';
  if (url.origin === 'https://analyticsdata.googleapis.com') return /^\/v1beta\/properties\/[0-9]+:runReport$/u.test(url.pathname);
  return url.origin === 'https://www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/u.test(url.pathname);
}

function stripeReport(url, method) {
  if (method !== 'GET' || url.origin !== 'https://api.stripe.com') return false;
  return /^\/v1\/(?:account|balance|balance_transactions(?:\/txn_[a-zA-Z0-9_]+)?|subscriptions|checkout\/sessions(?:\/cs_[a-zA-Z0-9_]+\/line_items)?|invoice_payments|invoices\/in_[a-zA-Z0-9_]+\/lines|charges\/(?:ch|py)_[a-zA-Z0-9_]+|refunds\/(?:re|pyr)_[a-zA-Z0-9_]+)$/u.test(url.pathname);
}

function bingReport(url, method) {
  if (method !== 'GET' || url.origin !== 'https://ssl.bing.com' || !url.searchParams.get('apikey')) return false;
  if (url.pathname === '/webmaster/api.svc/json/GetUserSites') return url.searchParams.size === 1;
  return url.pathname === '/webmaster/api.svc/json/GetRankAndTrafficStats'
    && url.searchParams.size === 2 && !!url.searchParams.get('siteUrl');
}

/** Workers have no fallback to public fetch. The controller belongs to the
 * scheduler lease and also cancels an accepted request if that lease ends. */
export function localCustomerOutbound({ ntasksOrigin, googleDaily = false, collectorProviders = [], sitePulls = [], signal, transport = fetch } = {}) {
  const allowed = new Set(collectorProviders);
  const pullUrls = new Set(sitePulls.flatMap(site => site.urls));
  return async request => {
    const url = new URL(request.url);
    if (url.username || url.password || url.hash) return new Response(null, { status: 403 });
    const ntasksAllowed = url.origin === ntasksOrigin && hostedTaskProviderOperation(url.pathname, request.method);
    const googleAllowed = googleDaily && googleDailyQuery(url, request.method);
    const stripeAllowed = allowed.has('stripe') && stripeReport(url, request.method);
    const bingAllowed = allowed.has('bing-webmaster') && bingReport(url, request.method);
    const mediavineAllowed = allowed.has('mediavine') && request.method === 'POST' && url.href === 'https://api-publishers.mediavine.com/graphql';
    const pullAllowed = request.method === 'GET' && pullUrls.has(url.href);
    if (!(ntasksAllowed || googleAllowed || stripeAllowed || bingAllowed || mediavineAllowed || pullAllowed)) return new Response(null, { status: 403 });
    const timeout = AbortSignal.timeout(10000);
    const bounded = AbortSignal.any([timeout, ...(signal ? [signal] : []), ...(request.signal ? [request.signal] : [])]);
    bounded.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set('accept-encoding', 'identity');
    const response = await transport(url.href, { method: request.method, headers: Object.fromEntries(headers),
      body: request.body ? await request.arrayBuffer() : undefined, redirect: 'manual', signal: bounded });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return response;
  };
}
