/** Connecting Google by signing in: the shapes the Tower (which renders the
 * card and the redirect URI) and the ingest Worker (which builds the
 * authorization URL and exchanges the code) have to agree on. Nothing here is
 * a token, a client secret or a state nonce; the plaintext never leaves the
 * ingest Worker (`workers/ingest/src/credentials.ts`).
 */

/**
 * Exactly what the OS asks Google for: two read-only data scopes plus the
 * operator's address. `analytics.readonly` covers the Data API and the Admin
 * API that lists properties; `webmasters.readonly` is Search Console's read
 * scope, not `webmasters`, which can also verify and delete sites. `openid` +
 * `email` is what lets the card say whose account is connected.
 */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
] as const;

/** Google's own endpoints. Constants rather than config: an install that
 * could point them elsewhere could be phished into sending a code elsewhere. */
export const GOOGLE_OAUTH_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Where "Sign in with Google" goes — same origin, so it is an ordinary link. */
export const GOOGLE_OAUTH_START_PATH = '/api/integrations/google/oauth/start';

/** Where Google sends the operator back. The path half of the redirect URI the
 * operator registers in the console. */
export const GOOGLE_OAUTH_CALLBACK_PATH =
  '/api/integrations/google/oauth/callback';

/** What the callback discovers about the account it can see. */
export const GOOGLE_PROPERTIES_PATH = '/api/integrations/google/properties';

/** How long a started sign-in stays valid. Long enough to read a consent screen
 * and pick an account, short enough that a state left in a browser history is
 * worthless by the time anybody finds it. */
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The redirect URI for a Tower reached at this origin. Derived from the
 * request's own origin, never configured: a configured copy would be a second
 * answer, and the one that lost would produce `redirect_uri_mismatch`.
 */
export function googleOAuthRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

/** Whether Google will accept a redirect URI at this origin at all, and why
 * not as a code: `not-an-address` — the origin does not parse;
 * `insecure-host` — plain http on a host that is not loopback. The press that
 * clears the second is `googleLoopbackOrigin`'s address. */
export interface GoogleRedirectVerdict {
  usable: boolean;
  /** Null when usable. */
  problem: 'not-an-address' | 'insecure-host' | null;
}

/** Loopback hosts Google exempts from its https rule. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `scheme://host[:port]`, parsed without `URL`: this package's tsconfig
 * carries no DOM lib, so a shared contract cannot use a browser global. */
const ORIGIN_PATTERN = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/?#:]+)(?::(\d+))?$/i;

/**
 * Google refuses a plain-http redirect URI unless it is loopback: no private
 * LAN address, no `.local` name. A Tower reached over the LAN would get an
 * `invalid_request` with no hint why, so the card checks first and offers the
 * loopback address.
 */
export function googleRedirectVerdict(origin: string): GoogleRedirectVerdict {
  const match = ORIGIN_PATTERN.exec(origin.replace(/\/+$/, ''));
  if (match === null) return { usable: false, problem: 'not-an-address' };
  const [, scheme, host] = match;
  if (scheme!.toLowerCase() === 'https') return { usable: true, problem: null };
  if (LOOPBACK_HOSTS.has(host!.toLowerCase())) return { usable: true, problem: null };
  return { usable: false, problem: 'insecure-host' };
}

/**
 * The loopback address of the same Tower — what an operator on a LAN address
 * Google refuses opens instead. Null when `origin` is not an address at all.
 */
export function googleLoopbackOrigin(origin: string): string | null {
  const match = ORIGIN_PATTERN.exec(origin.replace(/\/+$/, ''));
  if (match === null) return null;
  const port = match[3];
  return `http://127.0.0.1${port ? `:${port}` : ''}`;
}

/**
 * What `beginGoogleOAuth` answers: where to send the browser, or why not. A
 * refusal is a code and nothing else: the page words each one and puts its
 * one press beside it (`googleOAuthNotice` in the Tower).
 */
export type GoogleOAuthStart =
  | { ok: true; authorizeUrl: string; redirectUri: string }
  | {
      ok: false;
      /** `app_missing` — no client id/secret yet. `redirect_unusable` — the
       * origin is one Google refuses. `key_missing` — no `CREDENTIALS_KEY`, so
       * no state can be signed and nothing could be stored anyway. */
      error: 'app_missing' | 'redirect_unusable' | 'key_missing';
    };

/** What `completeGoogleOAuth` answers. Never carries a token, and a refusal
 * carries its code and facts, never a sentence (see `GoogleOAuthStart`). */
export type GoogleOAuthCompletion =
  | {
      ok: true;
      /** The account the operator signed in as, for the card and the toast. */
      account: string | null;
      scopes: string[];
    }
  | {
      ok: false;
      error: GoogleOAuthFailure;
      /** `scope_incomplete`: the products whose box was unticked. */
      withheld?: GoogleReadProduct[];
      /** `exchange_failed`: the HTTP status Google refused the exchange with. */
      status?: number;
    };

/** The two products a sign-in has to grant, by the names Google's consent
 * screen shows them under. */
export type GoogleReadProduct = 'Google Analytics' | 'Search Console';

/**
 * Why a sign-in did not complete. These ride back to the browser as a query
 * parameter on `/integrations`, so they are a CLOSED vocabulary — the page
 * renders its own sentence per code rather than echoing whatever arrived.
 *
 * `exchange_failed` is Google answering no (its press is the OAuth client's
 * console page); `unreachable` is Google not answering at all, whose press is
 * simply trying again — two different instructions, so two codes.
 */
export type GoogleOAuthFailure =
  | 'state_invalid'
  | 'state_expired'
  | 'denied'
  | 'app_missing'
  | 'exchange_failed'
  | 'unreachable'
  | 'no_refresh_token'
  | 'scope_incomplete'
  | 'store_failed';

/** The query parameter the callback lands on `/integrations` with. */
export const GOOGLE_OAUTH_RESULT_PARAM = 'google';

/** Its value on the happy path. Everything else is a `GoogleOAuthFailure`. */
export const GOOGLE_OAUTH_CONNECTED = 'connected';

/** One GA4 property or Search Console site the connected account can see. */
export interface GoogleDiscoveredProperty {
  /** Which of the two lanes this belongs to. */
  lane: 'ga4' | 'gsc';
  /** What a collector would store as `propertyRef`: the numeric GA4 property
   * id, or the Search Console site url exactly as Google spells it. */
  ref: string;
  /** What the operator sees in Google's own UI. */
  label: string;
  /** GA4: the account the property sits under. GSC: the permission level
   * Search Console reports. Null where the provider says nothing. */
  detail: string | null;
}

/**
 * `GET /api/integrations/google/properties` — what the connected account can
 * see, read-only. The per-asset picker consumes it, and the card lists it so
 * an operator can tell whether they signed in with the right account. Nothing
 * is stored: two free list calls, and a discovery is not evidence.
 */
export interface GooglePropertyDiscovery {
  monitoringAvailable?: boolean;
  ok: boolean;
  /** The verdict in one sentence, whichever way it went. */
  message: string;
  checkedAt: string;
  /** Whose account answered. Null when the read failed before it was known. */
  account: string | null;
  /** How the credential authenticated, so a discovery run on a service account
   * is not mistaken for proof that a sign-in worked. */
  auth: 'oauth' | 'service-account' | null;
  properties: GoogleDiscoveredProperty[];
}
