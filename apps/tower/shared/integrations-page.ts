// The Integrations page's wire types, and the three derivations the page and
// its tests must agree on: what stands between this deployment and storing a
// credential, what state one is in, and how a typed field becomes the string
// the API stores (bead `ro-vu8d.2`).
//
// THE WIRE TYPES ARE RE-EXPORTED, NEVER RE-DECLARED. `packages/contract` is
// where the provider field schemas live, because three runtimes have to agree
// on them — the Tower renders the form, the ingest validates the submitted body,
// and `scripts/dev-secrets.mjs` imports the operator's existing secrets against
// the same list. This module was a hand-written MIRROR of them while
// `ro-vu8d.1` landed in parallel; it is a re-export since `ro-vu8d.6`, so a
// field added to a provider in the contract reaches the form with no edit here,
// and a shape that drifts fails typecheck instead of quietly rendering a
// missing input.
//
// It stays a module rather than every consumer importing the contract directly
// because the DERIVATIONS below are the Tower's own — the contract states what a
// credential IS, these state what the page does with it — and importing both
// from one place is what keeps a rule and the shape it reads in step.
//
// WHAT NEVER CROSSES THIS BOUNDARY: a credential VALUE. The payload carries
// field NAMES and timestamps only, so the browser cannot echo a secret back and
// a screenshot of this page cannot leak one.

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
 * The encryption key's bootstrap state.
 *
 * It is a fact about the DEPLOYMENT rather than about any provider, which is
 * why the page states them once above the cards instead of on each one — and
 * why they are derived here, so the banner and every card's Connect cannot
 * disagree about whether storing anything is possible.
 *
 * A STATE AND ONE COMMAND (bead `ro-ujb9.96.6.19`): the ingest answers codes,
 * and each is drawn as its lead and the command that clears it — never the
 * ingest's sentence.
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
 * The four states a provider card can be in — RE-EXPORTED, not declared here
 * (moved to `packages/contract` by bead `ro-vu8d.23`).
 *
 * They are NOT the five lane states in `shared/integrations.ts`
 * (`live`/`degraded`/`needs-setup`/`skipped`/`not-applicable`). Those are about
 * one asset × one lane and are derived from collector evidence; these are about
 * one CREDENTIAL and are derived from the store. A lane can be Working while
 * its credential is still Legacy env, and that difference is the whole point of
 * epic `ro-vu8d`.
 *
 * The rule moved because a SECOND runtime now asks it: the notifier interrupts
 * the operator when a data source turns *Failing*, and "failing" has to mean on
 * the wire exactly what it means on the card. Two derivations of one state is
 * what `ro-vu8d.22` had just finished removing next door.
 */
export type { ConnectionState, NotificationRule } from "@noticeos/contract";
export { connectionState } from "@noticeos/contract/integrations";

/**
 * What the OS sends to the operator's notification channel, and which catalog
 * data source that channel IS (bead `ro-vu8d.23`).
 *
 * Re-exported like every other contract fact on this page, so the card and the
 * ingest's notifier read one declaration: a card promising more than the sender
 * delivers is the defect that bead was filed against.
 */
export { NOTIFIED_CONDITIONS } from "@noticeos/contract/notifications";

/** The `config/integrations.json` data source the notification channel powers —
 * named once so the card asks "is this the notification credential" rather than
 * matching on a provider id. */
export const NOTIFICATION_LANE = "discord-webhooks";

/**
 * Which providers still resolve their credential from the environment file
 * (bead `ro-vu8d.5`).
 *
 * Both /integrations and /health read it — one page to fix it on, one page an
 * operator opens when something is off — so the rule lives here rather than in
 * either of them. Provider ids, in catalog order: this is the answer to *how
 * much of D21 is done on this install*, and a list of names is the whole of it.
 *
 * Deliberately NOT a lane state. `/health` speaks in asset × lane and a lane can
 * be Working while its credential is Legacy env; folding this into that
 * vocabulary would erase the gap epic `ro-vu8d` exists to close.
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
 * The worst expiry across every provider, and who it belongs to (bead
 * `ro-vu8d.8`).
 *
 * WHY THIS IS THE SURFACE, and why the warning does NOT join the attention band
 * through the flag lane. `flags.asset` is `NOT NULL REFERENCES assets(id)`
 * (db/0001): every flag is a statement about ONE asset, and each credential
 * here is portfolio-shared — pinning "the DataForSEO password expires in nine
 * days" onto any one site would be false, and pinning it onto asset #0 would
 * file a credential's lifecycle into the OS self-pulse lane, which counts
 * pulses, ledger rows and cron runs and RESOLVES ON A PULSE. An expiry does not
 * resolve on a pulse; it resolves when the operator reconnects.
 *
 * D15 settles the rest: where a roll-up and an action list describe one fact,
 * the ACTION LIST owns it. The action list here is the provider card — Reconnect
 * is on it — so the card carries the countdown and the sidebar carries a dot
 * pointing at the card. A sentence in the Alerts band would be the same fact in
 * a second vocabulary, in the one place where nothing can be done about it.
 *
 * AND THAT IS THE CEILING — decided 2026-09-05, bead `ro-vu8d.19`, after the
 * question was asked again: `/wall` shows nothing and Home's Alerts list shows
 * nothing, so should either carry it? No, and for four reasons that all point
 * the same way.
 *
 *  1. D15, again. The Wall's attention rail and Home's Alerts list are BOTH
 *     roll-ups of the action list that owns this fact. The rule does not stop
 *     applying because the roll-up is on a different page.
 *  2. Nobody can act from the Wall. It is a television; Reconnect is a desk
 *     action. `shared/materiality.ts`'s inventory already refuses the TV's
 *     scarcest space to a row nobody is being asked to act on — that is written
 *     down for `snoozed`, and an expiry countdown is exactly that row.
 *  3. The Wall already tells the truth when it matters. A credential that
 *     actually expires stops its collector, and a stopped collector is a
 *     `degraded` source on the asset cards and a gap in reporting coverage —
 *     OBSERVED, rather than a prediction the TV would have to carry for
 *     fourteen days to be right once.
 *  4. Home is a desk page, so the sidebar's dot is already on it. A second mark
 *     in its Alerts list would be D15's duplication exactly.
 *
 * THE ONE HOLE THE DECISION LEFT was the small screen, where the sidebar is
 * behind a Menu button: a ceiling the operator cannot see on their phone is not
 * a ceiling. The bar that hides the sidebar wears the same dot, from
 * {@link expiringCredentialSeverity} and {@link expiringCredentialSummary}.
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

/** What the sidebar's Integrations entry should wear: `error` once something has
 * expired, `warn` inside the T-14d window, nothing otherwise. Deliberately the
 * severity scale rather than a scale of its own — an expiring credential IS an
 * ordinary warning, and a rival color for it would be a fourth severity. */
export function expiringCredentialSeverity(
  rows: readonly ExpiringCredential[],
): "warn" | "error" | null {
  if (rows.some((row) => row.expiry.state === "expired")) return "error";
  return rows.length > 0 ? "warn" : null;
}

/**
 * What that dot SAYS — one sentence, wherever the dot appears (bead
 * `ro-vu8d.19`).
 *
 * A dot is a pointer and the sentence is the whole of what it carries, so the
 * sidebar entry and the small-screen bar that replaces it read it from here
 * rather than each composing their own. Two spellings of one fact is doc 14's
 * rule broken in the least visible place: nobody compares two hovers.
 *
 * `null` exactly when {@link expiringCredentialSeverity} is null — no dot, no
 * sentence.
 */
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

/**
 * Validate one field's typed text into the string the PUT carries.
 *
 * Every kind sends a STRING, so this is about refusing what the provider would
 * refuse anyway — locally, before a secret leaves the browser. A service-account
 * JSON that does not parse is a paste that lost its last brace, and finding that
 * out from a 422 three seconds later is worse than finding it out on the field.
 */
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

/**
 * One address that is itself the credential — a Discord webhook (bead
 * `ro-vu8d.18`).
 *
 * The commonest way to get this wrong is to paste the webhook's ID out of the
 * Discord UI instead of the URL behind **Copy Webhook URL**, so the refusal
 * names what a URL looks like rather than saying "invalid". The ingest re-checks
 * the same rule; this is the copy that arrives before a secret leaves the
 * browser.
 */
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

/**
 * A per-asset credential's map, as the sub-editor already serialized it (bead
 * `ro-vu8d.9`).
 *
 * The form draws ONE INPUT PER ASSET and hands this the JSON it built, so what
 * is checked here is the thing the ingest will check: a non-empty object of
 * asset id → a key with something in it. An operator never types a brace, and
 * the message never names a key.
 */
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
  // Re-serialized rather than passed through: what is stored is then exactly
  // what was parsed, with no trailing prose a text field would have carried.
  return { ok: true, value: JSON.stringify(parsed) };
}

/**
 * One feed per line, `name = https://…`, into the `{ name: url }` object the
 * store holds.
 *
 * A LINE-BASED editor rather than a JSON one because these are calendar
 * subscription URLs the operator copies out of a calendar app one at a time,
 * and asking them to hand-write JSON braces around a pasted URL is asking them
 * to make a syntax error. A line with no `=` is still a feed — it gets a
 * positional name — because a single-feed setup should not have to invent a
 * label before it works.
 */
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

/**
 * Which of four things the Google card's sign-in half should be showing (bead
 * `ro-vu8d.3`).
 *
 * DERIVED, not stored, and derived HERE rather than inside the component,
 * because the same three facts decide the card, the kitchen-sink gallery and
 * every test: is the OAuth app entered, will Google return to this address, and
 * is there a grant. A component working this out inline would be a fourth copy
 * of the rule that only a browser could run.
 */
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
   * what the card links to when this one is refused (bead `ro-ujb9.96.6.1`).
   * Null when Google accepts this address, or it is not one. */
  loopbackUrl: string | null;
  /** Whose account is connected. Null until it is. */
  account: string | null;
  /** What the grant covers, in the operator's words. */
  scopes: GrantedScope[];
  /** When the sign-in was made. */
  connectedAt: string | null;
}

/**
 * What the Google card knows about its two halves.
 *
 * `app` is the `google-oauth-app` credential — a separate row that never gets a
 * card of its own (`companionOf` in the contract), because a client id and
 * secret configure HOW you connect Google rather than being a second thing to
 * connect.
 */
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
  // ORDER IS THE ARGUMENT, and `connected` is checked FIRST on purpose: a
  // credential that already works must keep saying so even from a browser
  // Google would refuse to return to. An operator connects once at the loopback
  // address and then reads the card from the LAN like every other page — being
  // told the connection is impossible at that point would simply be false.
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

/**
 * The scope URLs in plain English (doc 14 rule 8: a string an operator would
 * have to be told is a string that fails).
 *
 * An unrecognized scope keeps its URL rather than being dropped: a grant
 * carrying something this build has not heard of is exactly the thing worth
 * showing, and hiding it would make the card claim less access than the account
 * actually gave.
 */
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
 * link lands (bead ro-ujb9.96.7.7). */
const GOOGLE_PROVIDER_PAGE = "/integrations?connect=google";

/** What to say when the browser comes back from Google: what happened, and —
 * where the fix is one press somewhere else — that press (bead
 * `ro-ujb9.96.6.1`). The toast carries the action as its button, so the
 * message never has to spell the fix out. */
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

/**
 * The callback carries a CODE, never a sentence (`GoogleOAuthFailure` in the
 * contract), and this page owns the wording — so nothing Google or the network
 * said can be reflected into the page through a query parameter. An
 * unrecognized value gets the generic sentence rather than being printed.
 */
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
