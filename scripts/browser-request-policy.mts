/** Nonsecret selectors only: fresh server identity remains the authority. */
export const WORKSPACE_SELECTION_HEADER = 'x-noticeos-workspace-id';
export const WORKSPACE_SESSION_HEADER = 'x-noticeos-session-id';

/** Browser request evidence for hosted effects, including first login.
 * This validates one server-declared origin; it grants no identity or workspace authority. */
export interface BrowserRequestPolicy {
  readonly origin: string;
  assertEffect(request: Request): void;
}
export class BrowserRequestRefused extends Error {
  override name = 'BrowserRequestRefused';
  constructor() { super('Browser request is not authorized.'); }
}
function refuse(): never { throw new BrowserRequestRefused(); }
/** Only a server-declared origin may opt an OrbStack browser into private HTTP. */
export function isPrivateTowerOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== value || url.protocol !== 'http:' || Number(url.port) < 1024) return false;
  const hostname = url.hostname;
  const privateIPv4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(hostname)
    && /^\d+\.\d+\.\d+\.\d+$/u.test(hostname);
  return privateIPv4 || (hostname.length <= 253 && hostname.endsWith('.local')
    && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)));
}

function canonicalOrigin(value: unknown, localTowerOrigin?: string): string {
  if (typeof value !== 'string') refuse();
  let parsed: URL;
  try { parsed = new URL(value); } catch { refuse(); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const privateTower = value === localTowerOrigin && isPrivateTowerOrigin(value);
  const allowedHttp = parsed.protocol === 'http:' && (loopback || privateTower);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.hostname.includes('*')
    || (parsed.protocol !== 'https:' && !allowedHttp)) refuse();
  return value;
}
/** Better Auth's documented trusted-origin/Fetch Metadata principle, applied
 * to semantic app effects too: GET providers can spend/record, POST can read.
 * No wildcard, forwarded Host, permissive native fallback or callback exception.
 * https://better-auth.com/docs/reference/security#csrf-protection */
function browserEffect(proof: Request, trustedOrigin: string): void {
  if (new URL(proof.url).origin !== trustedOrigin) refuse();
  const site = proof.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') refuse();
  const origin = proof.headers.get('origin');
  if (origin === null || origin === 'null') {
    if (site !== 'same-origin') refuse();
  } else if (origin !== trustedOrigin) refuse();
  const mode = proof.headers.get('sec-fetch-mode');
  const dest = proof.headers.get('sec-fetch-dest');
  if (mode !== null && !['cors', 'same-origin'].includes(mode)) refuse();
  if (dest !== null && dest !== 'empty') refuse();
}


export function createBrowserRequestPolicy(trustedOrigin: string, localTowerOrigin?: string): BrowserRequestPolicy {
  const origin = canonicalOrigin(trustedOrigin, localTowerOrigin);
  return Object.freeze({ origin, assertEffect(request: Request): void {
    if (!(request instanceof Request)) refuse();
    browserEffect(request, origin);
  } });
}
