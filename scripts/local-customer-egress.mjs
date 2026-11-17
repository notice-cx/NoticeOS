import { hostedTaskProviderOperation } from './hosted-task-request.mjs';

function googleDailyQuery(url, method) {
  if (method !== 'POST' || url.search || url.hash || url.username || url.password) return false;
  if (url.origin === 'https://oauth2.googleapis.com') return url.pathname === '/token';
  if (url.origin === 'https://analyticsdata.googleapis.com') return /^\/v1beta\/properties\/[0-9]+:runReport$/u.test(url.pathname);
  return url.origin === 'https://www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/u.test(url.pathname);
}

/** Workers have no fallback to public fetch. The controller belongs to the
 * scheduler lease and also cancels an accepted request if that lease ends. */
export function localCustomerOutbound({ ntasksOrigin, googleDaily = false, signal, transport = fetch } = {}) {
  return async request => {
    const url = new URL(request.url);
    const ntasksAllowed = url.origin === ntasksOrigin && !url.username && !url.password && !url.hash
      && hostedTaskProviderOperation(url.pathname, request.method);
    const googleAllowed = googleDaily && googleDailyQuery(url, request.method);
    if (!ntasksAllowed && !googleAllowed) return new Response(null, { status: 403 });
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
