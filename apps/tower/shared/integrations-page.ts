// The Integrations page's wire types, and the derivations the page and its
// tests must agree on: what stands between this deployment and storing a
// credential, what state one is in, and how a typed field becomes the string
// the API stores. The wire types are re-exported from `packages/contract`,
// never re-declared. A credential value never crosses this boundary: the
// payload carries field names and timestamps only.

export type {
  CredentialAssetRow,
  CredentialAuthKind,
  CredentialBalance,
  CredentialBalanceReading,
  CredentialExpiryReading,
  CredentialExpirySource,
  CredentialExpiryState,
  CredentialMetadata,
  CredentialProbe,
  CredentialPropertyMapRef,
  CredentialPropertyMapUse,
  CredentialSource,
  CredentialSummary,
  GoogleDiscoveredProperty,
  GooglePropertyDiscovery,
  IntegrationAuthPath,
  IntegrationCredentialsPayload,
  IntegrationExpiry,
  IntegrationField,
  IntegrationFieldKind,
  IntegrationLink,
  IntegrationProvider,
  IntegrationProviderAssetRef,
  IntegrationProviderId,
  IntegrationProviderStatus,
  IntegrationScope,
  AssetDayMeter,
  AssetDayMeterReading,
  IntegrationMeter,
  IntegrationTest,
  LegacyAssetBinding,
  PortfolioMonthMeter,
  PortfolioMonthMeterReading,
  ProbeCost,
  ProbeFix,
  ProbeOutcome,
  ProbeResult,
  ProviderMeterAsset,
  ProviderMeterReading,
  CredentialBlocker,
} from "@noticeos/contract";

import type {
  CredentialBlocker,
  CredentialExpiryReading,
  GoogleOAuthFailure,
  GoogleOAuthStart,
  IntegrationCredentialsPayload,
  IntegrationFieldKind,
  IntegrationProviderId,
  IntegrationProviderStatus,
} from "@noticeos/contract";
import {
  GOOGLE_OAUTH_CONNECTED,
  googleLoopbackOrigin,
  googleOAuthRedirectUri,
  googleRedirectVerdict,
} from "@noticeos/contract/google-oauth";
import {
  CREDENTIAL_BLOCKER_LEADS,
  CREDENTIALS_KEY_COMMAND,
  credentialExpiry,
} from "@noticeos/contract/integrations";
export {
  credentialAssetRows,
  credentialBalance,
  credentialExpiry,
  meterRemaining,
} from "@noticeos/contract/integrations";

// --- what stands between this deployment and storing anything --------------

/**
 * The encryption key's bootstrap state: a fact about the deployment rather
 * than any provider, stated once above the cards. The ingest answers codes,
 * and each is drawn as its lead and the command that clears it.
 */
export interface ConnectBlocker {
  kind: CredentialBlocker;
  /** The state, in two or three words. */
  lead: string;
  /** The one command that clears it, copied verbatim. */
  command: string;
  /** The environment binding the command's output goes into, where there is one. */
  binding: string | null;
}

const BLOCKERS: Record<CredentialBlocker, Omit<ConnectBlocker, "kind" | "lead">> = {
  "key-missing": { command: CREDENTIALS_KEY_COMMAND, binding: "CREDENTIALS_KEY" },
  "key-invalid": { command: CREDENTIALS_KEY_COMMAND, binding: "CREDENTIALS_KEY" },
};

export function connectBlockers(
  payload: Pick<IntegrationCredentialsPayload, "keyPresent"> & { blockers?: readonly CredentialBlocker[] },
): ConnectBlocker[] {
  const kinds = payload.blockers ?? (payload.keyPresent ? [] : ["key-missing" as const]);
  return kinds.map((kind) => ({ kind, lead: CREDENTIAL_BLOCKER_LEADS[kind], ...BLOCKERS[kind] }));
}

// --- the state a card leads with -------------------------------------------

/**
 * The four states a provider card can be in, re-exported from
 * `packages/contract` because the notifier reads the same rule. They are not
 * the five lane states in `shared/integrations.ts`: those are about one asset
 * × one lane and derived from collector evidence; these are about one
 * credential and derived from the store. A lane can be Working while its
 * credential is still Legacy env.
 */
export type { ConnectionState, NotificationRule } from "@noticeos/contract";
export { connectionState } from "@noticeos/contract/integrations";

/** What the OS sends to the operator's notification channel, re-exported so
 * the card and the ingest's notifier read one declaration. */
export { NOTIFIED_CONDITIONS } from "@noticeos/contract/notifications";

/** The `config/integrations.json` data source the notification channel powers —
 * named once so the card asks "is this the notification credential" rather than
 * matching on a provider id. */
export const NOTIFICATION_LANE = "discord-webhooks";

/**
 * Which providers still resolve their credential from the environment file,
 * as provider ids in catalog order. Both /integrations and /health read it.
 * Deliberately not a lane state: a lane can be Working while its credential is
 * Legacy env.
 */
export function legacyEnvProviders(
  payload: Pick<IntegrationCredentialsPayload, "providers"> | undefined,
): string[] {
  return (payload?.providers ?? [])
    .filter((status) => status.credential.source === "env")
    .map((status) => status.provider.id);
}

// --- an expiry the operator has not opened the page to see -----------------

/**
 * The worst expiry across every provider, and who it belongs to. It does not
 * join the attention band through the flag lane: every flag is a statement
 * about one asset, and a credential here is portfolio-shared. The provider
 * card carries the countdown (Reconnect is on it), and the sidebar and the
 * small-screen bar carry a dot pointing at the card, from
 * {@link expiringCredentialSeverity} and {@link expiringCredentialSummary}.
 * The Wall and Home's Alerts list carry nothing: a credential that actually
 * expires stops its collector, and that is observed on the cards.
 *
 * Ordering is worst-first: expired beats expiring, and among expiring the one
 * that dies soonest wins the dot. `null` means nothing is worth a mark.
 */
export interface ExpiringCredential {
  provider: IntegrationProviderId;
  label: string;
  expiry: CredentialExpiryReading;
}

export function expiringCredentials(
  payload: Pick<IntegrationCredentialsPayload, "providers"> | undefined | null,
  nowMs: number,
): ExpiringCredential[] {
  const rows: ExpiringCredential[] = [];
  for (const status of payload?.providers ?? []) {
    const expiry = credentialExpiry(status.credential.metadata, nowMs);
    if (expiry.state !== "warn" && expiry.state !== "expired") continue;
    rows.push({
      provider: status.provider.id,
      label: status.provider.label,
      expiry,
    });
  }
  return rows.sort(
    (a, b) => (a.expiry.msRemaining ?? 0) - (b.expiry.msRemaining ?? 0),
  );
}

/** What the sidebar's Integrations entry should wear: `error` once something
 * has expired, `warn` inside the T-14d window, nothing otherwise. The severity
 * scale, not a scale of its own. */
export function expiringCredentialSeverity(
  rows: readonly ExpiringCredential[],
): "warn" | "error" | null {
  if (rows.some((row) => row.expiry.state === "expired")) return "error";
  return rows.length > 0 ? "warn" : null;
}

/** What that dot says — one sentence, wherever the dot appears. `null`
 * exactly when {@link expiringCredentialSeverity} is null. */
export function expiringCredentialSummary(
  rows: readonly ExpiringCredential[],
): string | null {
  const worst = rows[0];
  if (!worst) return null;
  if (rows.length > 1) return `${rows.length} credentials are expiring or expired`;
  return worst.expiry.state === "expired"
    ? `${worst.label} — the credential has expired`
    : `${worst.label} — expires in ${worst.expiry.daysRemaining ?? 0} days`;
}

// --- turning a typed field into the string the API stores ------------------

export type FieldParse =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Validate one field's typed text into the string the PUT carries: refusing
 * what the provider would refuse anyway, before a secret leaves the browser. */
export function parseFieldValue(
  kind: IntegrationFieldKind,
  raw: string,
): FieldParse {
  if (kind === "json") return parseJsonField(raw);
  if (kind === "url-list") return parseUrlList(raw);
  if (kind === "url") return parseUrl(raw);
  if (kind === "asset-map") return parseAssetMap(raw);
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "This field is empty." };
  return { ok: true, value };
}

/** One address that is itself the credential — a Discord webhook. The
 * commonest mistake is pasting the webhook's ID instead of its URL, so the
 * refusal names what a URL looks like. The ingest re-checks the same rule. */
function parseUrl(raw: string): FieldParse {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "This field is empty." };
  let scheme: string;
  try {
    scheme = new URL(value).protocol;
  } catch {
    return {
      ok: false,
      error: "That is not a URL — paste the whole address, starting with https://.",
    };
  }
  if (scheme !== "https:" && scheme !== "http:") {
    return { ok: false, error: "The address has to start with https://." };
  }
  return { ok: true, value };
}

/** A per-asset credential's map, as the sub-editor serialized it: a non-empty
 * object of asset id → a key with something in it. An operator never types a
 * brace, and the message never names a key. */
function parseAssetMap(raw: string): FieldParse {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, error: "Add a key for at least one site." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not a set of per-site keys." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "That is not a set of per-site keys." };
  }
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, key]) => typeof key === "string" && key.trim().length > 0,
  );
  if (entries.length === 0) {
    return { ok: false, error: "Add a key for at least one site." };
  }
  return {
    ok: true,
    value: JSON.stringify(
      Object.fromEntries(entries.map(([asset, key]) => [asset, String(key).trim()])),
    ),
  };
}

function parseJsonField(raw: string): FieldParse {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "This field is empty." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not valid JSON — check the paste is complete." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object, like { … }." };
  }
  // Re-serialized rather than passed through, so what is stored is exactly what was parsed.
  return { ok: true, value: JSON.stringify(parsed) };
}

/** One feed per line, `name = https://…`, into the `{ name: url }` object the
 * store holds. A line with no `=` is still a feed and gets a positional name. */
export function parseUrlList(raw: string): FieldParse {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    return { ok: false, error: "Add at least one feed, one per line." };
  }
  const feeds: Record<string, string> = {};
  for (const [index, line] of lines.entries()) {
    const split = line.indexOf("=");
    const name = split === -1 ? `feed-${index + 1}` : line.slice(0, split).trim();
    const url = split === -1 ? line : line.slice(split + 1).trim();
    if (name.length === 0) {
      return { ok: false, error: `Line ${index + 1} has no name before the =.` };
    }
    if (!/^https?:\/\/\S+$/i.test(url) && !/^webcal:\/\/\S+$/i.test(url)) {
      return {
        ok: false,
        error: `Line ${index + 1} is not a feed URL — it must start with https:// or webcal://.`,
      };
    }
    feeds[name] = url;
  }
  return { ok: true, value: JSON.stringify(feeds) };
}

// --- signing in to Google ---------------------------------------------------

/** Which of four things the Google card's sign-in half should be showing,
 * derived from three facts: is the OAuth app entered, will Google return to
 * this address, and is there a grant. */
export type GoogleOAuthState =
  /** The console app has not been entered, so there is nothing to sign in to. */
  | "app-missing"
  /** The app is set, but Google refuses to return to this address (a LAN host). */
  | "redirect-unusable"
  /** Everything is in place; the operator has not signed in. */
  | "ready"
  /** A grant is stored. */
  | "connected";

export interface GoogleOAuthCardState {
  state: GoogleOAuthState;
  /** The exact string to paste into the Google Cloud console, derived from the
   * address this browser has the Tower open at. */
  redirectUri: string;
  /** Where the same Tower answers on loopback, the address Google accepts —
   * what the card links to when this one is refused. Null when Google accepts
   * this address, or it is not one. */
  loopbackUrl: string | null;
  /** Whose account is connected. Null until it is. */
  account: string | null;
  /** What the grant covers, in the operator's words. */
  scopes: GrantedScope[];
  /** When the sign-in was made. */
  connectedAt: string | null;
}

/** What the Google card knows about its two halves. `app` is the
 * `google-oauth-app` credential, a row that never gets a card of its own
 * (`companionOf` in the contract). */
export function googleOAuthCardState(
  google: IntegrationProviderStatus,
  app: IntegrationProviderStatus | null,
  origin: string,
): GoogleOAuthCardState {
  const verdict = googleRedirectVerdict(origin);
  const metadata = google.credential.metadata;
  const connected = google.credential.auth === "oauth";
  const loopback = verdict.usable ? null : googleLoopbackOrigin(origin);
  const base = {
    redirectUri: googleOAuthRedirectUri(origin),
    loopbackUrl: loopback === null ? null : `${loopback}${GOOGLE_PROVIDER_PAGE}`,
    account: metadata?.account ?? null,
    scopes: grantedScopes(metadata?.scopes ?? []),
    connectedAt: metadata?.connectedAt ?? null,
  };
  // `connected` is checked first: a credential that already works must keep
  // saying so even from a browser Google would refuse to return to.
  if (connected) return { ...base, state: "connected" };
  if (app === null || app.credential.source === "none") {
    return { ...base, state: "app-missing" };
  }
  if (!verdict.usable) return { ...base, state: "redirect-unusable" };
  return { ...base, state: "ready" };
}

/** One granted scope, named for a person rather than by its URL. */
export interface GrantedScope {
  scope: string;
  label: string;
}

/** The scope URLs in plain English. An unrecognized scope keeps its URL
 * rather than being dropped, so the card never claims less access than the
 * account gave. */
const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  email: "Your email address",
  "https://www.googleapis.com/auth/analytics.readonly": "Analytics — read only",
  "https://www.googleapis.com/auth/webmasters.readonly": "Search Console — read only",
};

export function grantedScopes(scopes: readonly string[]): GrantedScope[] {
  return scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] ?? scope }));
}

/** Google's connect panel — where the sign-in returns, and where a loopback
 * link lands. */
const GOOGLE_PROVIDER_PAGE = "/integrations?connect=google";

/** What to say when the browser comes back from Google: what happened, and,
 * where the fix is one press somewhere else, that press as the toast's
 * button. */
export interface GoogleOAuthNotice {
  tone: "ok" | "bad";
  message: string;
  action?: GoogleOAuthNoticeAction;
}

export interface GoogleOAuthNoticeAction {
  label: string;
  href: string;
  /** True for Google's own screens (a new tab); false for this Tower on
   * another address (the same tab). */
  external: boolean;
}

/** The callback carries a code, never a sentence, and this page owns the
 * wording, so nothing Google or the network said can be reflected into the
 * page through a query parameter. An unrecognized value gets the generic
 * sentence. */
const OAUTH_FAILURE_MESSAGES: Record<GoogleOAuthFailure | Extract<GoogleOAuthStart, { ok: false }>["error"], string> = {
  denied: "You cancelled the Google sign-in, so nothing changed.",
  state_invalid:
    "That sign-in did not come back from where it started. Try Sign in with Google again.",
  state_expired: "That sign-in sat too long before coming back. Try it again.",
  app_missing:
    "Google has not been told about this OS yet — add the OAuth client ID and secret first.",
  redirect_unusable: "Google won't return to this address.",
  key_missing:
    "There is no encryption key, so a sign-in could not be stored. Set CREDENTIALS_KEY first.",
  exchange_failed: "Google refused to finish the sign-in.",
  unreachable: "Google did not answer. Try again.",
  no_refresh_token: "Google sent a sign-in that expires within the hour.",
  scope_incomplete:
    "Analytics or Search Console was not granted. Connect again and leave both boxes ticked.",
  store_failed: "The sign-in worked, but it could not be stored.",
};

/** The one press that fixes a failure, where there is one. `origin` is the
 * address this browser has the Tower open at. */
function oauthFailureAction(code: string, origin: string): GoogleOAuthNoticeAction | undefined {
  if (code === "redirect_unusable") {
    const loopback = googleLoopbackOrigin(origin);
    return loopback === null
      ? undefined
      : { label: "Open on 127.0.0.1", href: `${loopback}${GOOGLE_PROVIDER_PAGE}`, external: false };
  }
  // The client ID, secret and redirect URI all live on this one console screen.
  if (code === "exchange_failed") {
    return { label: "Check OAuth client", href: "https://console.cloud.google.com/apis/credentials", external: true };
  }
  // Google withholds a refresh token while an earlier grant stands: removing
  // that grant, then signing in again from this page, is the fix.
  if (code === "no_refresh_token") {
    return { label: "Remove old access", href: "https://myaccount.google.com/connections", external: true };
  }
  return undefined;
}

export function googleOAuthNotice(value: string | null, origin = ""): GoogleOAuthNotice | null {
  if (value === null || value === "") return null;
  if (value === GOOGLE_OAUTH_CONNECTED) {
    return { tone: "ok", message: "Signed in to Google." };
  }
  const action = oauthFailureAction(value, origin);
  return {
    tone: "bad",
    message:
      (OAUTH_FAILURE_MESSAGES as Record<string, string>)[value] ??
      "The Google sign-in did not finish. Try Sign in with Google again.",
    ...(action ? { action } : {}),
  };
}
