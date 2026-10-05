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
function canonicalOrigin(value: unknown): string {
  if (typeof value !== 'string') refuse();
  let parsed: URL;
  try { parsed = new URL(value); } catch { refuse(); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.hostname.includes('*')
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) refuse();
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


export function createBrowserRequestPolicy(trustedOrigin: string): BrowserRequestPolicy {
  const origin = canonicalOrigin(trustedOrigin);
  return Object.freeze({ origin, assertEffect(request: Request): void {
    if (!(request instanceof Request)) refuse();
    browserEffect(request, origin);
  } });
}
