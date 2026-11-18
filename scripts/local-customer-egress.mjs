import { hostedTaskProviderOperation } from './hosted-task-request.mjs';
import { cloudflareD1DownloadAddress } from './cloudflare-d1-download.mjs';
import { revenueWebhookId, siteCheckAddress } from './customer-collection-policy.mjs';

function googleDailyQuery(url, method, extendedArchives) {
  if (method !== 'POST' || url.search || url.hash || url.username || url.password) return false;
  if (url.origin === 'https://oauth2.googleapis.com') return url.pathname === '/token';
  if (url.origin === 'https://analyticsdata.googleapis.com') return /^\/v1beta\/properties\/[0-9]+:runReport$/u.test(url.pathname)
    || extendedArchives && /^\/v1alpha\/properties\/[0-9]+:runFunnelReport$/u.test(url.pathname);
  return url.origin === 'https://www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/u.test(url.pathname);
}

async function googleSetupRequest(url, request) {
  if (request.method === 'POST' && url.href === 'https://oauth2.googleapis.com/token'
    && request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
    const fields = new URLSearchParams(await request.clone().text());
    return ['authorization_code', 'refresh_token'].includes(fields.get('grant_type'));
  }
  if (request.method !== 'GET' || !request.headers.get('authorization')?.startsWith('Bearer ')) return false;
  if (url.origin === 'https://www.googleapis.com' && !url.search) {
    return ['/oauth2/v3/userinfo', '/webmasters/v3/sites'].includes(url.pathname);
  }
  if (url.origin === 'https://analyticsadmin.googleapis.com') {
    return url.pathname === '/v1beta/accountSummaries' && url.search === '?pageSize=200'
      || /^\/v1beta\/properties\/[0-9]+\/dataStreams$/u.test(url.pathname) && !url.search;
  }
  return url.origin === 'https://adsense.googleapis.com' && /^\/v2\/accounts(?:\/pub-[0-9]+\/sites)?$/u.test(url.pathname)
    && url.searchParams.get('pageSize') === '100'
    && (url.searchParams.size === 1 || url.searchParams.size === 2 && Boolean(url.searchParams.get('pageToken')));
}

function stripeReport(url, method) {
  if (method !== 'GET' || url.origin !== 'https://api.stripe.com') return false;
  return /^\/v1\/(?:account|balance|balance_transactions(?:\/txn_[a-zA-Z0-9_]+)?|subscriptions|checkout\/sessions(?:\/cs_[a-zA-Z0-9_]+\/line_items)?|invoice_payments|invoices\/in_[a-zA-Z0-9_]+\/lines|charges\/(?:ch|py)_[a-zA-Z0-9_]+|refunds\/(?:re|pyr)_[a-zA-Z0-9_]+)$/u.test(url.pathname);
}

function bingReport(url, method, extendedArchives) {
  if (method !== 'GET' || url.origin !== 'https://ssl.bing.com' || !url.searchParams.get('apikey')) return false;
  if (url.pathname === '/webmaster/api.svc/json/GetUserSites') return url.searchParams.size === 1;
  return (url.pathname === '/webmaster/api.svc/json/GetRankAndTrafficStats' || extendedArchives
    && /^\/webmaster\/api\.svc\/json\/Get(?:QueryStats|PageStats|CrawlStats|CrawlIssues|Feeds)$/u.test(url.pathname))
    && url.searchParams.size === 2 && !!url.searchParams.get('siteUrl');
}

function posthogReport(url, method) {
  if (!['https://us.posthog.com', 'https://eu.posthog.com'].includes(url.origin) || url.search) return false;
  return method === 'GET' && /^\/api\/projects\/[0-9]+\/$/u.test(url.pathname)
    || method === 'POST' && /^\/api\/projects\/[0-9]+\/query\/$/u.test(url.pathname);
}

function clarityReport(url, method) {
  return method === 'GET' && url.origin === 'https://www.clarity.ms'
    && url.pathname === '/export-data/api/v1/project-live-insights'
    && url.searchParams.size === 2 && url.searchParams.get('numOfDays') === '3' && url.searchParams.get('dimension1') === 'URL';
}

/** Workers have no fallback to public fetch. The controller belongs to the
 * scheduler lease and also cancels an accepted request if that lease ends. */
export function localCustomerOutbound({ ntasksOrigin, googleDaily = false, googleSetup = false, googleSetupTransport, extendedArchives = false, collectorProviders = [], sitePulls = [], siteChecks = [], revenueNotices = [], signal, transport = fetch } = {}) {
  const allowed = new Set(collectorProviders);
  const pullUrls = new Set(sitePulls.flatMap(site => site.urls));
  const siteOrigins = siteChecks.flatMap(site => site.origins);
  const webhooks = new Set(revenueNotices.map(notice => notice.webhookId));
  return async request => {
    const url = new URL(request.url);
    if (url.username || url.password || url.hash) return new Response(null, { status: 403 });
    const ntasksAllowed = url.origin === ntasksOrigin && hostedTaskProviderOperation(url.pathname, request.method);
    const googleAllowed = googleDaily && googleDailyQuery(url, request.method, extendedArchives);
    const setupAllowed = googleSetup && await googleSetupRequest(url, request);
    const stripeAllowed = allowed.has('stripe') && stripeReport(url, request.method);
    const bingAllowed = allowed.has('bing-webmaster') && bingReport(url, request.method, extendedArchives);
    const posthogAllowed = allowed.has('posthog') && posthogReport(url, request.method);
    const clarityAllowed = allowed.has('clarity') && clarityReport(url, request.method);
    const mediavineAllowed = allowed.has('mediavine') && request.method === 'POST' && url.href === 'https://api-publishers.mediavine.com/graphql';
    const pullAllowed = request.method === 'GET' && pullUrls.has(url.href);
    const website = siteOrigins.length > 0 && request.method === 'GET' && siteCheckAddress(url, siteOrigins)
      && !request.headers.has('authorization') && !request.headers.has('cookie');
    const discord = request.method === 'POST' && webhooks.has(revenueWebhookId(url));
    if (!(website || discord || ntasksAllowed || googleAllowed || setupAllowed || stripeAllowed || bingAllowed || mediavineAllowed || posthogAllowed || clarityAllowed || pullAllowed)) return new Response(null, { status: 403 });
    const timeout = AbortSignal.timeout(10000);
    const bounded = AbortSignal.any([timeout, ...(signal ? [signal] : []), ...(request.signal ? [request.signal] : [])]);
    bounded.throwIfAborted();
    const headers = website ? new Headers() : new Headers(request.headers);
    if (website) for (const name of ['user-agent', 'accept']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    headers.set('accept-encoding', 'identity');
    const send = setupAllowed && googleSetupTransport ? googleSetupTransport : transport;
    const response = await send(url.href, { method: request.method, headers: Object.fromEntries(headers),
      body: request.body ? await request.arrayBuffer() : undefined, redirect: 'manual', signal: bounded });
    if (response.status >= 300 && response.status < 400 && !(website)) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return response;
  };
}

/** The private D1 backup Worker may export and download saved targets only. */
export function localD1BackupOutbound({ signal, transport = fetch } = {}) {
  return async request => {
    const url = new URL(request.url);
    const exporting = request.method === 'POST' && url.origin === 'https://api.cloudflare.com'
      && !url.search && !url.hash && !url.username && !url.password
      && /^\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/export$/u.test(url.pathname);
    const downloading = request.method === 'GET' && cloudflareD1DownloadAddress(request.url);
    if (!exporting && !downloading) return new Response(null, { status: 403 });
    const bounded = AbortSignal.any([AbortSignal.timeout(exporting ? 10_000 : 180_000),
      ...(signal ? [signal] : []), ...(request.signal ? [request.signal] : [])]);
    bounded.throwIfAborted();
    const headers = { 'accept-encoding': 'identity' };
    let body;
    if (exporting) {
      const token = request.headers.get('authorization');
      if (!token || !/^Bearer [!-~]{1,8192}$/u.test(token)) return new Response(null, { status: 403 });
      body = await request.arrayBuffer();
      if (body.byteLength > 4096) return new Response(null, { status: 403 });
      headers.authorization = token;
      headers['content-type'] = 'application/json';
    }
    const response = await transport(url.href, { method: request.method, headers, body, redirect: 'manual', signal: bounded });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return response;
  };
}
