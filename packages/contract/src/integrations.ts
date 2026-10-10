/** The provider credential contract, declared once: the Tower renders the
 * form from this list, the ingest validates a submitted body against it before
 * encrypting anything, and `scripts/dev-secrets.mjs` reads it to import env
 * bindings.
 *
 * A field name is the legacy env binding name (`BING_WEBMASTER_API_KEY`, not
 * `apiKey`): every provider client resolves store-first and falls back to
 * `env[<field name>]`, so one name means one value on either path.
 *
 * Nothing here or derived from it carries a value: field names and metadata
 * only. The plaintext exists inside the ingest Worker at call time and nowhere
 * else.
 */

import { legacyBindingAsset } from './configuration.mjs';

/** How the Tower renders one field, and how a value is validated.
 *
 * `json` is a JSON document pasted whole; `url-list` is a JSON object of
 * `label -> url` (or `label -> {url, …}`); `asset-map` is a JSON object of
 * `asset id -> that asset's own key`, drawn as one input per asset. All three
 * cross the wire as JSON text, so every field value is a string on every hop.
 * `url` is one http(s) address that is itself the credential (a webhook), its
 * own kind so the browser and the ingest validate it as an address.
 */
export type IntegrationFieldKind =
  | 'text'
  | 'password'
  | 'json'
  | 'url-list'
  | 'url'
  | 'asset-map';

/**
 * Whether one credential covers the portfolio or is issued per asset. A
 * `per-asset` credential is still one encrypted row keyed on the provider,
 * holding an `asset-map` field; only the form and the card differ.
 */
export type IntegrationScope = 'shared' | 'per-asset';

/**
 * Who said when a credential dies. `flow` — the connection itself recorded it.
 * `operator` — the operator typed a date, or typed the absence of one; either
 * way it is their answer and no flow may overwrite it.
 */
export type CredentialExpirySource = 'flow' | 'operator';

/**
 * Whether an expiry date can ever be known for this provider. Declared per
 * provider, never inferred: a Bing Webmaster key does not expire, a Google
 * sign-in made against a consent screen still in Testing expires in seven
 * days, and the card must not invent a date for a key that has none.
 */
export interface IntegrationExpiry {
  /**
   * `flow` — a connection flow records the date. `operator` — nobody but the
   * operator knows; the card offers a date field. `never` — there is no expiry
   * date to state, and the card shows that rather than a field that would
   * collect a guess.
   */
  known: CredentialExpirySource | 'never';
  /**
   * Where the operator makes a flow-dated credential stop expiring, when the
   * provider offers that (Google's consent screen). Rendered beside the date.
   */
  fix?: IntegrationLink;
}

/** A deep link into the provider's own screen, and the words on it ("Get a
 * key"). */
export interface IntegrationLink {
  url: string;
  label: string;
}

/**
 * What pressing Test connection does to the outside world, declared so the
 * card says it before the press. `free` is the provider's cheapest read
 * (`workers/ingest/src/credential-probes.ts`). `side-effect` is the only call
 * that proves the credential (a webhook has no read that proves delivery, so
 * the test posts a message). `none` makes no provider call, because the only
 * one available would cost something; the button answers with what the OS can
 * check locally.
 */
export type ProbeCost = 'free' | 'side-effect' | 'none';

/**
 * How the connect panel on `/integrations` sets this provider up: the operator
 * enters what the provider issued, and the ingest asks the provider before it
 * stores anything, so a refused key is never kept. The Tower opens the panel
 * only for a provider that declares a kind, and the ingest's save-and-test
 * (`workers/ingest/src/credential-connect.ts`) refuses one that does not.
 * Absent means the provider uses its own setup page.
 */
export interface IntegrationConnect {
  /**
   * `key` — every field is typed or pasted and one provider call proves them
   * before they are kept. `site-tokens` — the provider issues one token per
   * site and offers no free read: each site's token is saved on paste, and the
   * proof is the export itself, run by an explicit Run now. `sign-in` — the
   * provider's own consent screen; the account's sites follow the sign-in
   * back.
   */
  kind: 'key' | 'site-tokens' | 'sign-in';
  /**
   * What the operator gives, and so what an accepted connection is called:
   * `api-key` ("Key accepted"), `login` or `oauth` ("Signed in"), or `url`, an
   * address that is itself the secret ("URL accepted"). Required, like
   * `expiry` and `test`: a provider must not inherit "Key accepted" for a
   * login. Read through {@link acceptedAs}.
   */
  credential: ConnectCredential;
  /**
   * `false` for a connection of the whole installation with no site to match
   * (a webhook, calendar feeds): the panel ends on the provider's answer.
   * Absent: the account's sites follow an accepted key.
   */
  sites?: false;
  /** Where the operator adds a site the account does not hold yet, and the
   * link's words ("Add in Bing"). Absent for a provider whose sites are the
   * portfolio's own. */
  addSite?: { url: string; label: string };
}

/** What the operator gives a provider to connect it (`IntegrationConnect`). */
export type ConnectCredential = 'api-key' | 'login' | 'oauth' | 'url';

/**
 * What an accepted connection is called, derived once for the connect panel,
 * the Integrations row, a provider's page and System health. The stored
 * credential's own way in decides where a provider offers two; otherwise the
 * provider's declared credential does.
 */
export type AcceptedAs = 'key' | 'sign-in' | 'url';

export function acceptedAs(
  provider: { connect?: Pick<IntegrationConnect, 'credential'> },
  auth: CredentialAuthKind | null = null,
): AcceptedAs {
  if (auth === 'oauth') return 'sign-in';
  if (auth !== null) return 'key';
  const credential = provider.connect?.credential ?? 'api-key';
  return credential === 'login' || credential === 'oauth' ? 'sign-in' : credential === 'url' ? 'url' : 'key';
}

/**
 * What the provider said to the details the panel sent, as facts the panel
 * draws rather than a sentence it prints.
 *
 *  - `accepted` — the credential is now stored, with what the test call showed
 *    (a null credit means the answer stated none; an absent balance is not a
 *    zero one).
 *  - `refused` — the provider said no. Nothing was stored, and a credential
 *    already stored for this provider is untouched.
 *  - `unreachable` — no usable answer (a timeout, a network failure, a 5xx).
 *    Nothing was stored; the same details can be sent again.
 *
 * `checkedAt` is when the answer arrived. No field ever carries a credential.
 */
export interface ConnectFacts {
  cloudflareD1?: { accountId: string; databases: { id: string; name: string }[] };
  /** Bing Webmaster Tools: verified sites the key can read. */
  sites?: number;
  /** Cloudflare: D1 databases the account token can list. */
  databases?: number;
  /** DataForSEO: prepaid credit in USD, the digits the account endpoint
   * reported (`ExactUsd`). */
  creditUsd?: ExactUsd | null;
  /** PostHog: the projects the key can read. */
  projects?: number;
  /** PostHog: the Cloud region that answered for the key — found by asking
   * both, never typed. */
  region?: 'us' | 'eu';
  /** Calendar feeds: how many feeds answered with a calendar — all of them,
   * or the connect is refused. */
  feeds?: number;
}

export type ConnectVerdict =
  | { verdict: 'accepted'; checkedAt: string; facts: ConnectFacts }
  | { verdict: 'refused'; checkedAt: string }
  | { verdict: 'unreachable'; checkedAt: string };

/** The ingest's answer to one save-and-test. A refusal and an unreachable
 * provider are ANSWERS (`ok: true` with the verdict); `ok: false` is a request
 * the ingest could not act on at all. */
export type ConnectCredentialResult =
  | ({ ok: true } & ConnectVerdict)
  | { ok: false; error: 'unknown_provider'; provider: string }
  /** The provider declares no `connect` kind, so it keeps its own setup page. */
  | { ok: false; error: 'not_supported'; provider: string }
  | { ok: false; error: 'key_missing'; message: string }
  | { ok: false; error: 'store_unavailable'; message: string }
  | { ok: false; error: 'validation'; issues: CredentialIssue[] };

/** One site's token for a `site-tokens` provider: merged into the provider's
 * per-site map, never replacing the other sites' tokens. */
export interface PutSiteTokenInput {
  provider: string;
  asset: string;
  token: string;
}

/** The store's answer to one site's token: the credential write's own, or
 * `not_supported` for a provider that does not take tokens per site. */
export type PutSiteTokenResult =
  | PutCredentialResult
  | { ok: false; error: 'not_supported'; provider: string };

export interface IntegrationTest {
  /** What the press does, said by the button itself: `free` is "Test
   * connection", `side-effect` names the message it sends, `none` names the
   * local check it runs. */
  cost: ProbeCost;
}

/**
 * What a metered provider spends, where the OS's own rows can count it. The
 * two shapes differ, hence a union: Clarity's ceiling is calls per asset per
 * day, DataForSEO's is dollars portfolio-wide per calendar month, and both are
 * counted from manifest rows this OS wrote, never from a provider call. A
 * vendor's prepaid credit is not a ceiling the OS can count; it is recorded as
 * a dated sighting (`CredentialMetadata.balance`) and rendered with its age,
 * never inside the bar.
 */
export type IntegrationMeter = AssetDayMeter | PortfolioMonthMeter;

/** A ceiling counted in CALLS, per asset per day — Clarity's data export. */
export interface AssetDayMeter {
  window: 'asset-day';
  /** The provider's ceiling, per asset per day. */
  perAssetPerDay: number;
  /** What one unit is, in the operator's words — "call". Singular; a
   * renderer pluralizes. */
  unit: string;
  /** The data-source id whose OWN runs are the evidence. */
  countedFrom: string;
}

/**
 * A ceiling counted in dollars, portfolio-wide per calendar month — the
 * `monthly_caps.data_usd` reserve that fails closed before a metered call. The
 * ceiling is an operator-owned setting in `config/constants.json` and rides on
 * the reading, so the card cannot go stale when it changes.
 */
export interface PortfolioMonthMeter {
  window: 'portfolio-month';
  /** The data-source id whose OWN recorded costs are the evidence. */
  countedFrom: string;
}

/** How much of one metered provider's window is left. */
export type ProviderMeterReading = AssetDayMeterReading | PortfolioMonthMeterReading;

export interface AssetDayMeterReading {
  window: 'asset-day';
  /** The UTC day these counts cover; the OS cannot know the provider's own
   * day boundary. */
  day: string;
  assets: ProviderMeterAsset[];
}

export interface PortfolioMonthMeterReading {
  window: 'portfolio-month';
  /** The UTC calendar month the sum covers, 'YYYY-MM'. */
  period: string;
  /** Month-to-date spend, in dollars — the same figure `DataSpendSummary`
   * carries, from the same reader. */
  spentUsd: number;
  unknownPrices: number;
  /** `monthly_caps.data_usd` as this deployment holds it. */
  capUsd: number;
}

export interface ProviderMeterAsset {
  asset: string;
  /** Calls this OS made for that asset today. Never negative. */
  spent: number;
}

/** What is left of one ceiling, floored at zero: an overrun is "nothing
 * left", not a negative budget. */
export function meterRemaining(cap: number, spent: number): number {
  return Math.max(0, cap - spent);
}

/** How long before an expiry the OS starts warning, stated once for the
 * chip, the nav dot and the tests. */
export const CREDENTIAL_EXPIRY_WARN_DAYS = 14;

/** How long a Google refresh token lives while the consent screen is still in
 * Testing: Google's own documented lifetime. */
export const GOOGLE_TESTING_GRANT_DAYS = 7;

/** What a card knows about when this credential stops working. */
export type CredentialExpiryState =
  /** No date, and none can be known — the honest answer for a key with no
   * stated lifetime. */
  | 'unstated'
  /** A date is known and is further off than the warning horizon. */
  | 'ok'
  /** Inside the warning horizon: this is the only state that wears warn. */
  | 'warn'
  /** The date has passed. The credential may still be working — some providers
   * are late to enforce — so this is not the same as `failing`. */
  | 'expired';

export interface CredentialExpiryReading {
  state: CredentialExpiryState;
  /** The ISO instant, or null when there is none. */
  expiresAt: string | null;
  /** Milliseconds left, negative once past. Null when there is no date. */
  msRemaining: number | null;
  /** Whole days left, rounded toward zero. Null when there is no date. */
  daysRemaining: number | null;
  /** Who said so, so the card can offer the right correction. */
  source: CredentialExpirySource | null;
}

/**
 * Read one credential's expiry against a clock — the one derivation for the
 * card's chip, the sidebar dot and the tests. An unparseable stored date reads
 * `unstated` rather than `expired`: a defective timestamp is not evidence that
 * a credential died.
 */
export function credentialExpiry(
  metadata: CredentialMetadata | null,
  nowMs: number,
): CredentialExpiryReading {
  const iso = metadata?.expiresAt ?? null;
  const source = metadata?.expirySource ?? null;
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (iso === null || !Number.isFinite(at)) {
    return {
      state: 'unstated',
      expiresAt: null,
      msRemaining: null,
      daysRemaining: null,
      source,
    };
  }
  const msRemaining = at - nowMs;
  const daysRemaining = Math.trunc(msRemaining / 86_400_000);
  return {
    state:
      msRemaining <= 0
        ? 'expired'
        : msRemaining <= CREDENTIAL_EXPIRY_WARN_DAYS * 86_400_000
          ? 'warn'
          : 'ok',
    expiresAt: iso,
    msRemaining,
    daysRemaining,
    source,
  };
}

/**
 * How a provider is authenticated, where it offers more than one way: Google
 * by an OAuth grant or a service-account key, PostHog by one personal API key
 * for the account or the older key per site. Every way stays valid; this is a
 * fact the card reports, never a mode the product picks.
 */
export type CredentialAuthKind = 'oauth' | 'service-account' | 'account-key' | 'site-keys';

/**
 * One complete way to authenticate a provider: every field it needs, together.
 * A provider that declares these marks no field `required`; completeness is
 * "some path holds all of its fields", and declaration order is the
 * preference: the first path is what a first-run card offers, and the first
 * complete path is the one in force.
 */
export interface IntegrationAuthPath {
  kind: CredentialAuthKind;
  /** What the card calls this way in — "Sign in with Google". */
  label: string;
  /** Every field name this path needs. All of them, or the path is incomplete. */
  fields: readonly string[];
}

/** Where the value a client actually used came from. Recorded on the run. */
export type CredentialSource = 'store' | 'env' | 'none';

/**
 * An older env binding that carries one asset's key (Clarity's
 * `CLARITY_PROJECT_API_TOKEN`). It gets no form input, but it is a working
 * credential: the summary folds it into the asset map as that asset's key, the
 * importer moves it into the store as one map entry, and the collector reads
 * it under its own binding name. Nothing ever writes one back.
 */
export interface LegacyAssetBinding {
  /** The env binding name, exactly as an install still holds it. */
  name: string;
  /**
   * The lane whose asset it serves. Which asset is never written here: it is
   * `legacyBindingAsset(lane, register)`, the first asset in the installation's
   * own data-source register with this lane.
   */
  lane: string;
  /**
   * That asset, where a reader holding the register has answered. Absent in
   * the catalog.
   */
  asset?: string | null;
}

export interface IntegrationField {
  /** The field's name and its legacy env binding name. */
  name: string;
  /** What the form calls it. */
  label: string;
  /**
   * True when the value is a secret: the form masks it, and it is never
   * rendered back. It does not decide whether the value can leave the ingest —
   * nothing can; a `secret: false` field is still write-only.
   */
  secret: boolean;
  kind: IntegrationFieldKind;
  required: boolean;
  /**
   * Where the value comes from, as a deep link beside the label. Absent for a
   * value the operator already knows (an email) or a flow writes (`managed`).
   */
  link?: IntegrationLink;
  /** What a value looks like, shown in the empty input — the format, never an
   * instruction ("….apps.googleusercontent.com"). */
  placeholder?: string;
  /** The access the value must carry, one short label each ("Query: read"),
   * drawn as chips beside the field. */
  grants?: readonly string[];
  /**
   * True when a flow writes this value and an operator never types it (a
   * refresh token, an older per-site key map). The connect form skips it; the
   * card still reports whether the store holds it.
   */
  managed?: boolean;
  /** For an `asset-map` field: an older single-asset binding whose value is
   * one entry of this map. */
  legacyAssetBinding?: LegacyAssetBinding;
}

export interface IntegrationProvider {
  id: IntegrationProviderId;
  label: string;
  /** Where the reader goes for the full story. */
  docRef: string;
  scope: IntegrationScope;
  /** The `config/integrations.json` catalog lane ids this one credential
   * unlocks — `google` powers both `ga4` and `gsc`. */
  lanes: readonly string[];
  /**
   * Lanes whose provider fixes the reporting day for every property, whoever
   * runs the OS: a fact about the provider, never the installation's clock.
   * Read through {@link providerReportingTimeZone}; this is the one place
   * product code may name a zone (`scripts/neutral-code-gate.mjs`).
   */
  reportingTimeZones?: Readonly<Record<string, string>>;
  fields: readonly IntegrationField[];
  /**
   * The ways in, when there is more than one. Absent means the single implicit
   * path of every `required` field.
   */
  authPaths?: readonly IntegrationAuthPath[];
  /**
   * Whether this credential can ever carry an expiry date, and who knows it.
   * Required, so a provider cannot inherit "no expiry" from an omission.
   */
  expiry: IntegrationExpiry;
  /**
   * What the Test connection button does for this provider. Required for the
   * same reason `expiry` is.
   */
  test: IntegrationTest;
  /**
   * What this provider meters, where the OS's own rows can count it. Absent
   * for a provider with no cap the OS can measure; the card then shows nothing
   * rather than a full bar.
   */
  meter?: IntegrationMeter;
  /** How the connect panel sets this provider up. Absent = its own setup page
   * (see `IntegrationConnect`). */
  connect?: IntegrationConnect;
  /**
   * When set, this credential gets no card of its own: it is a prerequisite
   * the named provider's card asks for in place (`google-oauth-app` configures
   * how you connect Google rather than being a second thing to connect).
   */
  companionOf?: IntegrationProviderId;
}

/** The providers whose credentials the product can hold. */
export type IntegrationProviderId =
  | 'google'
  | 'google-oauth-app'
  | 'bing-webmaster'
  | 'dataforseo'
  | 'calendar'
  | 'discord'
  | 'mediavine'
  | 'clarity'
  | 'posthog'
  | 'cloudflare';

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    id: 'cloudflare', label: 'Cloudflare (D1 backups)', scope: 'shared', lanes: [],
    docRef: 'docs/11-integrations.md#cloudflare-d1-backups',
    expiry: { known: 'operator' }, test: { cost: 'free' },
    connect: { kind: 'key', credential: 'api-key', sites: false },
    fields: [
      { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', kind: 'text', required: true, secret: false,
        link: { url: 'https://dash.cloudflare.com/', label: 'Find account' } },
      { name: 'CLOUDFLARE_API_TOKEN', label: 'API token', kind: 'password', required: true, secret: true,
        link: { url: 'https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/', label: 'Create token' },
        grants: ['Account: D1 Edit'] },
      { name: 'CLOUDFLARE_D1_TARGETS', label: 'D1 databases', kind: 'json', required: false, secret: false, managed: true },
    ],
  },
  {
    id: 'mediavine', label: 'Mediavine', scope: 'shared', lanes: ['ad-network'],
    docRef: 'docs/11-integrations.md#mediavine-revenue',
    // A password has no lifetime, and the saved session refreshes its own
    // access tokens.
    expiry: { known: 'never' },
    // Reads the sites the account can access, reusing the saved session.
    test: { cost: 'free' },
    // Signs in and lists the account's sites before the login is kept; a site
    // is added to Mediavine by applying, so there is no Add link to offer.
    connect: { kind: 'key', credential: 'login' },
    fields: [
      { name: 'MEDIAVINE_USER', label: 'Email', secret: false, kind: 'text', required: true, placeholder: 'you@example.com' },
      { name: 'MEDIAVINE_PASSWORD', label: 'Password', secret: true, kind: 'password', required: true },
    ],
  },
  {
    id: 'google',
    label: 'Google (Analytics 4 + Search Console)',
    docRef: 'docs/11-integrations.md#connecting-google',
    scope: 'shared',
    lanes: ['ga4', 'gsc'],
    // Google's reporting day for Search Console, the same for every installation — not the operator's clock.
    reportingTimeZones: { gsc: 'America/Los_Angeles' },
    // The sign-in is the half with a clock on it: a consent screen in Testing
    // expires every refresh token after seven days, and publishing it ends
    // that, so the date carries the link. The service account has no expiry.
    expiry: {
      known: 'flow',
      fix: { url: 'https://console.cloud.google.com/apis/credentials/consent', label: 'Publish app' },
    },
    // Mints a read-only token, lists the Search Console sites and reads one GA4
    // property's metadata: no day of data, no reporting quota.
    test: { cost: 'free' },
    // Two ways in; the sign-in is first because an operator can finish it
    // without leaving the product. Neither field is `required`: either alone
    // is a working credential, and marking both required would refuse the
    // save the OAuth callback makes. The service-account path keeps the
    // provider's own page.
    connect: { kind: 'sign-in', credential: 'oauth' },
    authPaths: [
      { kind: 'oauth', label: 'Sign in with Google', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'] },
      { kind: 'service-account', label: 'Service account', fields: ['GOOGLE_SIGNAL_ACCOUNTS'] },
    ],
    fields: [
      {
        // Written by Sign in with Google; Disconnect revokes it at Google.
        name: 'GOOGLE_OAUTH_REFRESH_TOKEN',
        label: 'Google sign-in',
        secret: true,
        kind: 'password',
        required: false,
        managed: true,
      },
      {
        // account label → { service_account_b64, properties }: a base64 JSON
        // key per Google Cloud service account, and the properties it reads.
        name: 'GOOGLE_SIGNAL_ACCOUNTS',
        label: 'Service-account map',
        secret: true,
        kind: 'json',
        required: false,
        link: { url: 'https://console.cloud.google.com/iam-admin/serviceaccounts', label: 'Service accounts' },
        placeholder: '{ "main": { "service_account_b64": "…", "properties": ["…"] } }',
        grants: ['GA4 Viewer', 'Search Console Full user'],
      },
    ],
  },
  {
    // Not a card of its own: the Google card asks for it in place.
    id: 'google-oauth-app',
    label: 'Google OAuth app',
    docRef: 'docs/11-integrations.md#connecting-google',
    scope: 'shared',
    lanes: [],
    // Google states no lifetime for a client secret.
    expiry: { known: 'never' },
    // No free Google call proves a client ID and secret without a person on a
    // consent screen, so the check stops at the shape; signing in is the verdict.
    test: { cost: 'none' },
    companionOf: 'google',
    fields: [
      {
        name: 'GOOGLE_OAUTH_CLIENT_ID',
        label: 'Client ID',
        // Not a secret: Google publishes it to every browser that starts a
        // sign-in, and the operator needs to proof-read it against the console.
        secret: false,
        kind: 'text',
        required: true,
        link: { url: 'https://console.cloud.google.com/apis/credentials/oauthclient', label: 'Create client' },
        placeholder: '….apps.googleusercontent.com',
      },
      {
        // Shown beside the client ID when it is created, and downloadable there.
        name: 'GOOGLE_OAUTH_CLIENT_SECRET',
        label: 'Client secret',
        secret: true,
        kind: 'password',
        required: true,
        placeholder: 'GOCSPX-…',
      },
    ],
  },
  {
    id: 'bing-webmaster',
    label: 'Bing Webmaster Tools',
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'shared',
    lanes: ['bing-webmaster'],
    // Bing prints no expiry on a Webmaster key; the operator may still have a
    // rotation date worth a warning, so the card offers the field.
    expiry: { known: 'operator' },
    // Asks Bing for the verified sites — the free call the collector opens with.
    test: { cost: 'free' },
    connect: {
      kind: 'key',
      credential: 'api-key',
      addSite: { url: 'https://www.bing.com/webmasters/', label: 'Add in Bing' },
    },
    fields: [
      {
        // One key covers every site verified in that Bing account.
        name: 'BING_WEBMASTER_API_KEY',
        label: 'API key',
        secret: true,
        kind: 'password',
        required: true,
        link: { url: 'https://www.bing.com/webmasters/settings/api', label: 'Get a key' },
      },
    ],
  },
  {
    id: 'dataforseo',
    label: 'DataForSEO',
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'shared',
    lanes: ['dataforseo'],
    // Same shape as Bing: the provider states no lifetime, the operator may
    // have one in their own calendar.
    expiry: { known: 'operator' },
    // Reads the free account endpoint, which also reports the credit left; the
    // OS records that figure with the date it saw it.
    test: { cost: 'free' },
    // The monthly portfolio reserve is what fails closed before a call, and
    // the OS records it for itself: every report writes its exact cost onto
    // the same rows Clarity's meter counts. The credit balance is the vendor's
    // figure, seen only inside a DataForSEO answer, so it is stamped beside
    // the credential and shown with its age — a separate line, not a bar.
    meter: { window: 'portfolio-month', countedFrom: 'dataforseo' },
    connect: { kind: 'key', credential: 'api-key' },
    fields: [
      {
        // The API login from API Access, which is not the account email.
        name: 'DATAFORSEO_LOGIN',
        label: 'API login',
        secret: false,
        kind: 'text',
        required: true,
        link: { url: 'https://app.dataforseo.com/api-access', label: 'Get API access' },
      },
      {
        // Issued beside the login, and not the account password.
        name: 'DATAFORSEO_PASSWORD',
        label: 'API password',
        secret: true,
        kind: 'password',
        required: true,
      },
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar feeds',
    docRef: 'workers/ingest/README.md#calendar-rpc-the-walls-next-meetings',
    scope: 'shared',
    lanes: [],
    // A secret ICS address works until the operator resets it: an action, not
    // a date.
    expiry: { known: 'never' },
    // Reads each feed once and reports it by name; writes nothing.
    test: { cost: 'free' },
    // Every feed is read before the map is kept: one bounded GET per feed.
    connect: { kind: 'key', credential: 'url', sites: false },
    fields: [
      {
        // feed name → secret ICS url (Google Calendar → the calendar →
        // Integrate calendar → Secret address in iCal format). The url IS the
        // credential: anyone holding it reads the whole calendar.
        name: 'CALENDAR_FEEDS',
        label: 'Feeds',
        secret: true,
        kind: 'url-list',
        required: true,
        link: { url: 'https://calendar.google.com/calendar/r/settings', label: 'Calendar settings' },
        placeholder: 'work = https://calendar.google.com/calendar/ical/…/basic.ics',
      },
    ],
  },
  {
    id: 'discord',
    label: 'Discord (operator notifications)',
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'shared',
    lanes: ['discord-webhooks'],
    // A webhook works until somebody deletes it in Discord: an action, not a
    // date.
    expiry: { known: 'never' },
    // The one probe with a side effect: a read of the webhook object proves it
    // exists, not that the OS can deliver, so the test posts and the button's
    // own label says so before the press.
    test: { cost: 'side-effect' },
    // The webhook is kept only once its test message is delivered.
    connect: { kind: 'key', credential: 'url', sites: false },
    fields: [
      {
        name: 'DISCORD_WEBHOOK_URL',
        label: 'Webhook URL',
        // The url is the credential — anyone holding it can post to that
        // channel — so it is never echoed or logged. It is not masked, so the
        // operator can proof-read the address they pasted.
        secret: true,
        kind: 'url',
        required: true,
        link: { url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks', label: 'Create a webhook' },
        placeholder: 'https://discord.com/api/webhooks/…',
      },
    ],
  },
  {
    // Clarity issues a data-export token per project: the per-asset dimension
    // is one `asset-map` field inside the one encrypted row, and with no call
    // cheap enough to probe, the missing probe is declared (`test.cost:
    // 'none'`) rather than faked.
    id: 'clarity',
    label: 'Microsoft Clarity (data export)',
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'per-asset',
    lanes: ['clarity'],
    // No stated lifetime and no operator date field: one row holds a token per
    // asset, and a single date could not describe a map of them.
    expiry: { known: 'never' },
    // Clarity's export API allows 10 calls per project per day and has no free
    // metadata endpoint, so a probe would spend a tenth of an asset's daily
    // budget. The button checks which assets hold a token ("Check keys").
    test: { cost: 'none' },
    // The export writes one manifest row per call, so what is left today is
    // arithmetic over rows this OS wrote (UTC day; Clarity resets on its own
    // clock, and a call made elsewhere is invisible here).
    meter: {
      window: 'asset-day',
      perAssetPerDay: 10,
      unit: 'call',
      countedFrom: 'clarity',
    },
    // One paste per site in the panel, saved into this map; the first export
    // is an explicit Run now that says it spends one of the day's calls.
    connect: { kind: 'site-tokens', credential: 'api-key' },
    fields: [
      {
        // One per asset: Clarity issues these per project (project → Settings
        // → Data export → Generate new API token).
        name: 'CLARITY_TOKENS',
        label: 'Project tokens',
        secret: true,
        kind: 'asset-map',
        required: true,
        link: { url: 'https://clarity.microsoft.com/projects', label: 'Clarity projects' },
        // The single-project binding an older install may still hold. Connect
        // moves it into the map; there is no input for it.
        legacyAssetBinding: {
          name: 'CLARITY_PROJECT_API_TOKEN',
          lane: 'clarity',
        },
      },
    ],
  },
  {
    // One personal API key for the account: the connect panel shows it to
    // PostHog's US and EU clouds, keeps it when one answers, and lists that
    // region's projects, matched to sites by the domains each project records.
    // Which region and project each site reads is not secret and lives on the
    // site's Data sources entry (`host`, `projectId`, `funnels`). An install
    // that connected a key per site (`POSTHOG_KEYS`) keeps its map: a site with
    // its own key uses it, every other site the account key; the map is
    // `managed`, never a form field.
    id: 'posthog',
    label: 'PostHog (product analytics)',
    docRef: 'docs/11-integrations.md#posthog',
    scope: 'shared',
    lanes: ['posthog'],
    // PostHog can put an expiry on a personal API key, but it does not report
    // that date to the key's holder, so there is nothing true to show.
    expiry: { known: 'never' },
    // A plain read of the mapped projects' settings: no query runs, so none of
    // the hourly query budget the daily archive needs is spent.
    test: { cost: 'free' },
    connect: { kind: 'key', credential: 'api-key' },
    authPaths: [
      { kind: 'account-key', label: 'Personal API key', fields: ['POSTHOG_API_KEY'] },
      { kind: 'site-keys', label: 'A key per site', fields: ['POSTHOG_KEYS'] },
    ],
    fields: [
      {
        // One personal API key; the region is whichever cloud accepts it.
        name: 'POSTHOG_API_KEY',
        label: 'Personal API key',
        secret: true,
        kind: 'password',
        required: false,
        link: { url: 'https://app.posthog.com/settings/user-api-keys', label: 'Create a key' },
        placeholder: 'phx_…',
        grants: ['Project: read', 'Insight: read', 'Query: read'],
      },
      {
        // The older map of site → key, kept for the installs that hold one.
        name: 'POSTHOG_KEYS',
        label: 'Keys per site',
        secret: true,
        kind: 'asset-map',
        required: false,
        managed: true,
      },
    ],
  },
] as const;

export const INTEGRATION_PROVIDER_IDS: readonly IntegrationProviderId[] =
  INTEGRATION_PROVIDERS.map((provider) => provider.id);

/** The provider with this id, or null. */
export function integrationProvider(id: string): IntegrationProvider | null {
  return INTEGRATION_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** The day boundary a provider fixes for one lane, or null when the lane's days
 * follow the property's own setting (GA4) or the installation's clock. */
export function providerReportingTimeZone(lane: string): string | null {
  for (const provider of INTEGRATION_PROVIDERS) {
    const zone = provider.reportingTimeZones?.[lane];
    if (zone) return zone;
  }
  return null;
}

/** The providers that get a CARD. A companion credential is asked for inside
 * the card of the provider it belongs to, so it is not one of these. */
export function integrationProviderCards(): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter(
    (provider) => provider.companionOf === undefined,
  );
}

/** Whether one credential can authenticate at all, and what is still missing. */
export interface CredentialAuthState {
  /** True when SOME way in is fully held. */
  complete: boolean;
  /** Which way, when the provider offers more than one. `null` for a provider
   * with a single implicit path. */
  auth: CredentialAuthKind | null;
  /** Field names still needed before anything works. Empty when complete. */
  missing: string[];
}

/**
 * Read a set of held field names against one provider's schema — the one rule
 * for "is this credential usable", wherever the names came from. It is
 * mirrored by `scripts/dev-secrets.mjs`, because Node cannot import this
 * package's TypeScript. When nothing is complete, `missing` names the closest
 * path rather than every field of every path.
 */
export function credentialAuthState(
  provider: IntegrationProvider,
  held: readonly string[],
): CredentialAuthState {
  const has = (name: string) => held.includes(name);

  if (provider.authPaths === undefined || provider.authPaths.length === 0) {
    const missing = provider.fields
      .filter((field) => field.required && !has(field.name))
      .map((field) => field.name);
    const required = provider.fields.filter((field) => field.required);
    return {
      // A provider with no required fields at all cannot be "complete" by
      // holding nothing — that would put a green chip on an empty row.
      complete: required.length > 0 && missing.length === 0,
      auth: null,
      missing,
    };
  }

  let closest: { missing: string[]; kind: CredentialAuthKind } | null = null;
  for (const path of provider.authPaths) {
    const missing = path.fields.filter((name) => !has(name));
    if (missing.length === 0) {
      return { complete: true, auth: path.kind, missing: [] };
    }
    // Declaration order breaks ties, so the preferred path wins when both are
    // equally far off — which is the first-run case.
    if (closest === null || missing.length < closest.missing.length) {
      closest = { missing, kind: path.kind };
    }
  }
  return { complete: false, auth: null, missing: closest?.missing ?? [] };
}

/** One provider's legacy env bindings, read once. */
export interface EnvCredentialRead {
  /** Field name → the value the environment holds, with any legacy
   * single-asset binding already folded into its `asset-map` field. */
  fields: Record<string, string>;
  /** Asset id → the binding NAME that supplied that asset's key, for every
   * asset a legacy single-asset binding answered for. Empty for every provider
   * that declares none, and for a map that already named the asset itself. */
  legacySlots: Record<string, string>;
}

/**
 * What the environment holds for one provider — the one rule, so the card, the
 * collector and the importer agree on whether a legacy binding counts.
 *
 * The map wins wherever both name the same asset. A map that does not parse is
 * left as it is: a broken value is a validation refusal the operator has to
 * see, not a value to discard. Which asset the legacy binding serves is
 * `legacyBindingAsset` over `register`; a caller without a register folds
 * nothing.
 */
export function readEnvCredential(
  provider: IntegrationProvider,
  bindings: Record<string, unknown>,
  register?: unknown,
): EnvCredentialRead {
  const fields: Record<string, string> = {};
  const legacySlots: Record<string, string> = {};
  // Mediavine never had an env login; Disconnect must not revive one.
  if (provider.id === 'mediavine') return { fields, legacySlots };
  for (const field of provider.fields) {
    const direct = bindings[field.name];
    let value = typeof direct === 'string' && direct.trim() !== '' ? direct : undefined;
    const legacy = field.legacyAssetBinding;
    if (legacy !== undefined && field.kind === 'asset-map') {
      const raw = bindings[legacy.name];
      const token = typeof raw === 'string' ? raw.trim() : '';
      const asset = token === '' ? null : legacyBindingAsset(legacy.lane, register);
      if (asset !== null) {
        const merged = mergeAssetMapEntry(value, asset, token);
        if (merged !== null) {
          value = merged;
          legacySlots[asset] = legacy.name;
        }
      }
    }
    if (value !== undefined) fields[field.name] = value;
  }
  return { fields, legacySlots };
}

/** The map text with `asset` set to `token`, or null when the map already
 * answers for that asset (or cannot be parsed at all). */
function mergeAssetMapEntry(
  mapText: string | undefined,
  asset: string,
  token: string,
): string | null {
  if (mapText === undefined) return JSON.stringify({ [asset]: token });
  let parsed: unknown;
  try {
    parsed = JSON.parse(mapText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const held = record[asset];
  if (typeof held === 'string' && held.trim() !== '') return null;
  return JSON.stringify({ ...record, [asset]: token });
}

/**
 * What a credential can say about itself without naming a secret. Stored in
 * the clear beside the ciphertext (`credentials.fields_json`), so
 * `listCredentialSummaries` answers without the bootstrap key and a rotated
 * key still leaves a card an operator can read and disconnect.
 */
export interface CredentialMetadata {
  /** Whose account this is — the Google address the operator signed in as. */
  account: string | null;
  /** The scopes the provider actually granted, as it reported them. */
  scopes: string[];
  /** When the grant was completed. Distinct from `updatedAt`, which any later
   * write also moves. */
  connectedAt: string | null;
  /**
   * When this credential stops working, where that is knowable. Null where the
   * provider states no lifetime and the operator has not named one — never a
   * date derived from age alone. In the clear, so a card whose bootstrap key
   * was rotated can still say it.
   */
  expiresAt: string | null;
  /** Who supplied the date above. `operator` is sticky: a later sign-in must
   * not overwrite the operator's own answer, including the answer that there
   * is no expiry (`expiresAt: null` with this set). */
  expirySource: CredentialExpirySource | null;
  /**
   * What the provider's prepaid account held the last time this OS saw the
   * figure. Optional: most providers have no such account. Non-secret, and in
   * the clear beside the ciphertext like the expiry.
   */
  balance?: CredentialBalance | null;
}

/**
 * A prepaid balance and the instant it was seen, never one without the other:
 * the figure comes back only inside a provider answer, so it is a sighting
 * rather than a reading, and one that lost its timestamp could be rendered as
 * though it were current.
 */
export interface CredentialBalance {
  /** Dollars of credit, the digits the provider reported (`ExactUsd`); the
   * store keeps six decimals. */
  usd: ExactUsd;
  /** When the OS saw it — the instant of the answer that carried it. */
  seenAt: string;
}

/**
 * When a credit sighting is too old to act on: two missed weekly refreshes.
 * The sweep's read is silent when refused, so weeks of failed reads look like
 * weeks of not looking, and the card must say the figure is ageing.
 */
export const CREDENTIAL_BALANCE_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * An amount of US dollars as exact decimal text: a JSON number's own digits
 * (`42.5`, `-0.25`), never a float, which cannot hold most cents exactly
 * (`(1.005).toFixed(2)` is `1.00`). It crosses from the provider to the store
 * (`numeric(14,6)`) and on to the card as the text it arrived as.
 */
export type ExactUsd = `${number}`;

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/** `value` as exact dollars when it is a JSON number's text; null otherwise. */
export function exactUsd(value: unknown): ExactUsd | null {
  return typeof value === 'string' && JSON_NUMBER.test(value) ? (value as ExactUsd) : null;
}

const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

/** Dollars and cents, `42.50`, rounded half away from zero on the decimal
 * itself: `Intl.NumberFormat` formats a numeric string without a float. */
export function usdCents(value: ExactUsd): string {
  return CENTS.format(value);
}

/** One sighting, aged against a clock. Never a live figure. */
export interface CredentialBalanceReading {
  usd: ExactUsd;
  seenAt: string;
  /** How long ago the sighting was, in milliseconds. Never negative. */
  ageMs: number;
  /** Older than `CREDENTIAL_BALANCE_STALE_MS` — the card warns instead of
   * stating the figure as though it could be acted on. */
  stale: boolean;
}

/**
 * Read one credential's last-seen account balance against a clock — the one
 * derivation for the card, the gallery and the tests. Nothing recorded and
 * nothing readable both answer null; a sighting whose timestamp does not parse
 * is dropped rather than shown undated.
 */
export function credentialBalance(
  metadata: CredentialMetadata | null,
  nowMs: number,
): CredentialBalanceReading | null {
  const balance = metadata?.balance ?? null;
  const usd = exactUsd(balance?.usd);
  if (balance === null || usd === null) return null;
  const seen = Date.parse(balance.seenAt);
  if (!Number.isFinite(seen)) return null;
  const ageMs = Math.max(0, nowMs - seen);
  return { usd, seenAt: balance.seenAt, ageMs, stale: ageMs > CREDENTIAL_BALANCE_STALE_MS };
}

export interface CredentialSummary {
  provider: IntegrationProviderId;
  /** `store` (entered in the product), `env` (the legacy path, still working)
   * or `none`. A store credential missing a required field still reads
   * `store`, with the gap named in `missingFields`. */
  source: CredentialSource;
  /** Field names the store holds for this provider. Never values. */
  fields: string[];
  /**
   * For a `per-asset` provider: the asset ids this credential holds a key for.
   * Ids only, never a key. Always empty for a `shared` provider. In the clear
   * beside the ciphertext, so the card can say which assets are covered when
   * the key is the problem.
   */
  assetsHeld: string[];
  /** Field names still needed before this credential works. Empty when
   * complete. For a provider with two ways in, the closest one's remainder —
   * see `credentialAuthState`. */
  missingFields: string[];
  /** Which way in is in force, for a provider that offers more than one. Null
   * for every single-path provider, and null while nothing is connected. */
  auth: CredentialAuthKind | null;
  /** The non-secret facts about the connection — whose account, which scopes,
   * connected when. Null wherever none were recorded. */
  metadata: CredentialMetadata | null;
  /** Which `CREDENTIALS_KEY` generation encrypted the row, so a future rotation
   * can tell re-encrypted rows from ones still on the old key. */
  keyVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** When a provider client last resolved this credential for a real call. */
  lastUsedAt: string | null;
  /** When such a call last SUCCEEDED — the timestamp a green check means. */
  lastOkAt: string | null;
  /** The last failure's sentence, or null. Never carries a value. */
  lastError: string | null;
  /**
   * For the one credential that can also carry a per-asset property map
   * (Google): whether that map is still the only answer for anything. `null`
   * for every other provider, and for a Google install with no account blob.
   * Answered by the ingest, which alone can read the blob; it carries asset ids
   * and data-source ids, never credential content.
   */
  propertyMap?: CredentialPropertyMapUse | null;
}

/** One provider as the Integrations page renders it: the schema, the connection
 * state, and which assets are counting on it. */
export interface IntegrationProviderStatus {
  provider: IntegrationProvider;
  credential: CredentialSummary;
  /** Assets that declare one of this provider's lanes in
   * `config/integrations.json`, with the lanes they declare. Ids only. */
  assets: IntegrationProviderAssetRef[];
  /**
   * Spend against `provider.meter`, from the manifest rows this OS wrote.
   * `null` for a provider that declares no meter, and for a store that could
   * not answer — a card must never invent a budget.
   */
  meter?: ProviderMeterReading | null;
}

export interface IntegrationProviderAssetRef {
  id: string;
  lanes: string[];
}

/**
 * Whether a credential's own property map is still load-bearing. Google's
 * `GOOGLE_SIGNAL_ACCOUNTS` blob holds a per-asset `ga4_property_id` /
 * `gsc_site_url` map; each asset's own Sources tab holds the same fact and
 * wins, so the collectors let go of the copy once nothing needs it, and the
 * card says when that is. Answered by `credentialPropertyMapUse` in
 * `workers/ingest/src/lane-mapping.ts`.
 */
export interface CredentialPropertyMapUse {
  /** True while at least one entry is listed below. */
  needed: boolean;
  /**
   * Every (asset, data source) pair whose property is not saved on the asset's
   * own Sources tab, so this credential's own map is what a run would read.
   * Empty exactly when `needed` is false.
   */
  answersFor: CredentialPropertyMapRef[];
}

export interface CredentialPropertyMapRef {
  /** The asset id, which is also where the card links. */
  asset: string;
  /** The data source's catalog id — `ga4`, `gsc`. */
  id: string;
  /** Its label, as `config/integrations.json`'s catalog spells it. */
  label: string;
}

/**
 * One asset row on a provider card: who declares this provider, and, for a
 * per-asset credential, whether a key is held for them. The catalog says which
 * assets declare the provider's data sources and the store says which assets a
 * key is held for; they disagree in both directions and both matter, so they
 * are merged here, once.
 */
export interface CredentialAssetRow {
  id: string;
  /** The data sources this asset declares for this provider. Empty for an asset
   * the store holds a key for and the catalog does not map. */
  lanes: string[];
  /** Whether a key is stored for this asset. Always false for a `shared`
   * provider — the credential covers every row at once, and a per-asset tick
   * there would be inventing a distinction the credential does not make. */
  held: boolean;
}

export function credentialAssetRows(
  status: Pick<IntegrationProviderStatus, 'provider' | 'credential' | 'assets'>,
): CredentialAssetRow[] {
  const perAsset = status.provider.scope === 'per-asset';
  const held = new Set(perAsset ? status.credential.assetsHeld : []);
  const rows: CredentialAssetRow[] = status.assets.map((asset) => ({
    id: asset.id,
    lanes: asset.lanes,
    held: held.has(asset.id),
  }));
  const declared = new Set(rows.map((row) => row.id));
  // A key stored for an asset the catalog does not map is named rather than
  // dropped: a typo in an asset id or an undeclared data source is invisible
  // otherwise.
  for (const id of held) {
    if (!declared.has(id)) rows.push({ id, lanes: [], held: true });
  }
  return rows;
}

/**
 * The four states a provider card leads with. Not the data-source states the
 * Health page renders: those are about one asset × one data source, derived
 * from collector evidence; these are about one credential, derived from the
 * store. A data source can be Working while its credential is still Legacy
 * env.
 */
export type ConnectionState = 'connected' | 'legacy-env' | 'not-connected' | 'failing';

/**
 * What the card says, from the credential summary alone. Order is the
 * argument: nothing stored (or stored incomplete) is not connected, because
 * there is no connection to call broken; then a credential whose last use did
 * not work is failing, wherever it is stored; only then does where it lives
 * speak.
 *
 * "Its last use did not work" is derived rather than trusted, because
 * `lastError` carries no timestamp of its own: an error older than the last
 * success has already been fixed and must not shout. It lives in the contract
 * because the notifier and the card must mean the same thing by failing.
 */
export function connectionState(credential: CredentialSummary): ConnectionState {
  if (credential.source === 'none') return 'not-connected';
  if (credential.source === 'store' && credential.missingFields.length > 0) {
    return 'not-connected';
  }
  if (credential.lastError !== null && !succeededOnLastUse(credential)) {
    return 'failing';
  }
  return credential.source === 'env' ? 'legacy-env' : 'connected';
}

/** Whether the most recent use of this credential was the one that worked. An
 * absent `lastOkAt` means it has never worked at all. */
function succeededOnLastUse(credential: CredentialSummary): boolean {
  const ok = parseInstant(credential.lastOkAt);
  if (ok === null) return false;
  const used = parseInstant(credential.lastUsedAt);
  return used === null || ok >= used;
}

function parseInstant(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** What makes a `CREDENTIALS_KEY`: 32 random bytes, base64. */
export const CREDENTIALS_KEY_COMMAND = 'openssl rand -base64 32';

/** `GET /api/integrations/providers`. Not `/api/integrations`, which answers
 * with the portfolio lane matrix the Health page renders. */
export interface IntegrationCredentialsPayload {
  generatedAt: string;
  /** Whether `CREDENTIALS_KEY` is set and usable. */
  keyPresent: boolean;
  /** Why nothing can be stored yet, as codes the Tower draws. Empty when a
   * credential can be stored. `keyReason` keeps the long sentence for the
   * command line. */
  blockers: CredentialBlocker[];
  /** When it is not: the sentence naming how to generate one and where to put
   * it. Rendered in place of the forms, so nobody types a password into a field
   * that cannot save it. */
  keyReason: string | null;
  providers: IntegrationProviderStatus[];
}

/**
 * Why a credential cannot be stored yet: `key-missing` — `CREDENTIALS_KEY` is
 * not set; `key-invalid` — it is set but is not 32 base64 bytes (or the
 * previous key a rotation reads is not). The Tower and the ingest's command
 * line both draw the state and the one command that clears it from here.
 */
export type CredentialBlocker = 'key-missing' | 'key-invalid';

/** Each blocker's state, in two or three words. Where to set the key is doc
 * 06's, linked, never restated. */
export const CREDENTIAL_BLOCKER_LEADS: Readonly<Record<CredentialBlocker, string>> = {
  'key-missing': 'No encryption key',
  'key-invalid': 'Encryption key unusable',
};

/**
 * What a connection test found, as facts the Tower draws, never a sentence the
 * ingest wrote. Nothing here is a credential or a provider's own text: a feed
 * is named by its label, a site by its id, a Google identity by the account
 * address the card already shows.
 *
 *  - `answered` — the provider answered and the credential works;
 *  - `refused` — the provider answered no (all of it, or the parts in
 *    `failing`);
 *  - `unreachable` — the provider did not answer usably;
 *  - `not-checked` — nothing was asked: the provider has no free call
 *    (Clarity), or nothing is set up to ask about (`unchecked` names it);
 *  - `not-connected` — nothing is stored;
 *  - `invalid` — what is stored cannot be used as it is (a feed map that is
 *    not a map, a client id that is not Google's);
 *  - `rate-limited` — the provider asked to wait.
 */
export type ProbeOutcome = 'answered' | 'refused' | 'unreachable' | 'not-checked' | 'not-connected' | 'invalid' | 'rate-limited';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** What the answer counted: sites, projects, feeds, the sites holding a
   * token, the prepaid credit, the region, the Google identity used. */
  facts?: ProbeFacts;
  /** The parts that failed, by the operator's own names (`Search Console`,
   * `GA4 313598867`, a feed's label, a site id). */
  failing?: string[];
  /** The parts nothing was asked about (a PostHog site with no project picked). */
  unchecked?: string[];
  /** The provider's HTTP status, where it answered with one. */
  status?: number;
  /** The one press that clears it. */
  fix?: ProbeFix;
}

export interface ProbeFacts {
  sites?: number;
  databases?: number;
  projects?: number;
  /** Calendar feeds that answered, of `feedsTotal`. */
  feeds?: number;
  feedsTotal?: number;
  /** Sites holding a token (Clarity). */
  tokens?: number;
  /** DataForSEO: prepaid credit in USD, the digits the provider reported. */
  creditUsd?: ExactUsd | null;
  region?: 'us' | 'eu';
  /** The Google account or service-account address the test used. */
  account?: string;
  /** GA4 was not checked: no property is mapped to a site yet. */
  ga4Unmapped?: boolean;
}

/**
 * The one press that clears a result:
 *  - `replace` — the key, login or webhook is refused or gone: Replace it;
 *  - `sign-in` — Google no longer accepts the sign-in: sign in again;
 *  - `grant` — Google refused the service account `to` on `product`: give it
 *    `role` there (the provider's own access page);
 *  - `map` — pick the project for these sites on their Data sources rows;
 *  - `wait` — try again in a minute;
 *  - `run-now` — no free check exists: the collection itself proves it (Run
 *    now in the connect panel);
 *  - `connect` — nothing is stored yet.
 */
export type ProbeFix =
  | { kind: 'replace' }
  | { kind: 'sign-in' }
  | { kind: 'grant'; product: 'Search Console' | 'Google Analytics'; role: string; to: string | null }
  | { kind: 'map'; sites: string[] }
  | { kind: 'wait' }
  | { kind: 'run-now' }
  | { kind: 'connect' };

/** `POST /api/integrations/:provider/test` — one real, least-privileged call.
 *
 * `ok: false` is a 200 with the reason in `result`: a credential that does not
 * work is an answer, not a transport failure. `result` is what the Tower
 * draws; `message` is the same result as one short line (`probeLine`) for the
 * command line and the credential's stored last error. Neither ever contains a
 * credential, and the probe never stores the provider's response body.
 */
export interface CredentialProbe {
  monitoringAvailable?: boolean;
  ok: boolean;
  message: string;
  result: ProbeResult;
  checkedAt: string;
}

const PROBE_OUTCOME_WORDS: Record<ProbeOutcome, string> = {
  answered: 'Answered',
  refused: 'Refused',
  unreachable: 'No answer',
  'not-checked': 'Not checked',
  'not-connected': 'Not connected',
  invalid: 'Not usable',
  'rate-limited': 'Rate limited',
};

/** A result's mark, as the card's chip says it. */
export function probeOutcomeLabel(outcome: ProbeOutcome): string {
  return PROBE_OUTCOME_WORDS[outcome];
}

/** A result as one short line — `Answered · 3 sites`, `Refused · HTTP 403 ·
 * Search Console` — for the command line and the stored last error. */
export function probeLine(result: ProbeResult): string {
  const facts = result.facts ?? {};
  const count = (n: number | undefined, one: string, many: string) => (n === undefined ? null : `${n} ${n === 1 ? one : many}`);
  const credit = exactUsd(facts.creditUsd);
  const parts = [
    PROBE_OUTCOME_WORDS[result.outcome],
    result.status !== undefined ? `HTTP ${result.status}` : null,
    count(facts.sites, 'site', 'sites'),
    count(facts.databases, 'database', 'databases'),
    count(facts.projects, 'project', 'projects'),
    facts.feedsTotal !== undefined ? `${facts.feeds ?? 0} of ${facts.feedsTotal} feeds` : null,
    count(facts.tokens, 'token', 'tokens'),
    credit === null ? null : `$${usdCents(credit)} credit`,
    facts.region ? facts.region.toUpperCase() : null,
    result.failing && result.failing.length > 0 ? result.failing.slice(0, 3).join(', ') : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

/** One rejected field, in the `{path, code, message}` shape every ingest lane
 * reports. `message` names the field, never the value. */
export interface CredentialIssue {
  path: string;
  code: string;
  message: string;
}

/** What the Tower PUTs. Values are strings — a `json`/`url-list` field carries
 * its JSON text. */
export interface PutCredentialInput {
  provider: string;
  fields: Record<string, string>;
  /**
   * The non-secret facts to record beside the ciphertext. Only the OAuth
   * callback sets this, inside the ingest Worker; the Tower's PUT route cannot
   * forward it, because a browser must not assert whose account a grant is.
   */
  metadata?: CredentialMetadata;
}

export type PutCredentialResult =
  | { ok: true; summary: CredentialSummary }
  | { ok: false; error: 'unknown_provider'; provider: string }
  | { ok: false; error: 'key_missing'; message: string }
  /** The table is not in the store yet: an answer, never a silent no-op. */
  | { ok: false; error: 'store_unavailable'; message: string }
  | { ok: false; error: 'validation'; issues: CredentialIssue[] };

export type DeleteCredentialResult =
  | { ok: true; summary: CredentialSummary }
  | { ok: false; error: 'unknown_provider'; provider: string };

/**
 * `PUT /api/integrations/:provider/expiry` — record (or clear) the one fact
 * about a credential that only the operator can see. Not part of
 * `PutCredentialInput`: recording a rotation date must not require retyping a
 * password, and the expiry lives in `fields_json` in the clear, so this write
 * needs no bootstrap key. `expiresAt: null` is a statement ("this does not
 * expire"), stamped `operator`, so the next sign-in does not put a countdown
 * back.
 */
export interface SetCredentialExpiryInput {
  provider: string;
  /** An ISO instant, or null for "there is no expiry". */
  expiresAt: string | null;
}

export type SetCredentialExpiryResult =
  | { ok: true; summary: CredentialSummary }
  | { ok: false; error: 'unknown_provider'; provider: string }
  /** No stored row: there is no credential whose expiry this would describe. */
  | { ok: false; error: 'not_stored'; message: string }
  /** The provider states no expiry AND offers no operator field — accepting a
   * date here would be storing a fact the card has already said cannot exist. */
  | { ok: false; error: 'not_expirable'; message: string }
  | { ok: false; error: 'validation'; issues: CredentialIssue[] };

/** What `listCredentialSummaries()` answers: the key's state plus one summary
 * per provider, always all of them and always in catalog order — a provider
 * with nothing stored is a card that says "not connected", not a missing row. */
export interface CredentialStoreState {
  keyPresent: boolean;
  keyReason: string | null;
  /** Why nothing can be stored yet, as codes. */
  blockers: CredentialBlocker[];
  summaries: CredentialSummary[];
}
