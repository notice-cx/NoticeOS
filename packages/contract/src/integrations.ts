/** The provider credential contract — declared ONCE, here (epic `ro-vu8d`).
 *
 * WHY IT LIVES IN THE CONTRACT PACKAGE. Three runtimes have to agree on what a
 * Google credential is called and what shape it takes: the Tower renders the
 * form from this list, the ingest Worker validates a submitted body against the
 * same list before it encrypts anything, and `scripts/dev-secrets.mjs` reads it
 * to move the operator's existing `.dev.secrets.json` into the store without
 * retyping. Two copies of a field name would be two answers, and the one that
 * lost would be the one an operator typed a password into.
 *
 * WHAT A FIELD NAME IS. Deliberately the LEGACY ENV BINDING NAME
 * (`BING_WEBMASTER_API_KEY`, not `apiKey`). Every provider client resolves
 * store-first and falls back to `env[<field name>]`, so one name means one
 * value whichever half of the move a given install is on — and the import
 * script is a copy rather than a translation.
 *
 * WHAT NEVER APPEARS HERE OR IN ANYTHING DERIVED FROM IT: a value. Every type
 * below carries field NAMES and metadata. `CredentialSummary.fields` is a list
 * of names, `secret` describes how a form should behave, and no route, RPC or
 * log line in this system returns a stored credential to a caller. The
 * plaintext exists inside the ingest Worker at call time and nowhere else.
 */

import { legacyBindingAsset } from './configuration.mjs';

/** How the Tower renders one field, and how a value is validated.
 *
 * `json` is a JSON document pasted or uploaded whole (a Google service-account
 * map); `url-list` is a JSON object of `label -> url` (or `label -> {url, …}`),
 * which is what a calendar feed map is. Both cross the wire as the JSON TEXT,
 * so every field value is a string on every hop.
 *
 * `url` is ONE http(s) address that is itself the credential — a Discord
 * webhook. It is its own kind rather than a `text` field because the check that
 * matters is *is this an address at all*, and having the browser and the ingest
 * read that rule off the same declaration is what stops a pasted webhook id
 * being stored as if it were a URL.
 *
 * `asset-map` is a JSON object of `asset id -> that asset's own key`, which is
 * the whole of what a `per-asset` credential is (bead `ro-vu8d.9`). It crosses
 * the wire as JSON text like the two above, and the form draws one input PER
 * ASSET rather than a text box somebody has to hand-write braces into.
 */
export type IntegrationFieldKind =
  | 'text'
  | 'password'
  | 'json'
  | 'url-list'
  | 'url'
  | 'asset-map';

/**
 * Whether one credential covers the portfolio or is issued per asset.
 *
 * Microsoft Clarity is the first `per-asset` one (bead `ro-vu8d.9`), and the
 * shape it arrived in is the point: it is still ONE encrypted row keyed on the
 * provider, holding an `asset-map` field. The alternative — a compound
 * `(provider, asset)` primary key — is a migration, migrations are
 * operator-only (AGENTS.md), and it would have bought a second `credentials`
 * shape to answer a question a JSON object already answers. What *per-asset*
 * changes is the FORM (one input per asset instead of one box) and the CARD
 * (which assets have a key, not merely which fields are set); the store, the
 * probe contract and the resolver are unchanged.
 */
export type IntegrationScope = 'shared' | 'per-asset';

/**
 * Who was able to say when a credential dies (bead `ro-vu8d.8`).
 *
 * `flow` — the connection itself recorded it, because the provider states a
 * lifetime for that kind of grant. `operator` — the operator typed a date, or
 * typed the ABSENCE of one; either way it is their answer and no flow may
 * overwrite it, because they are the only party who can see the console the
 * date comes from.
 */
export type CredentialExpirySource = 'flow' | 'operator';

/**
 * Whether an expiry date can ever be known for this provider, and the sentence
 * the card shows where there is no date (bead `ro-vu8d.8`).
 *
 * IT IS A PER-PROVIDER FACT AND IT IS DECLARED, not inferred. Doc 15 flow C
 * step 4 has asked for a T-14d warning since the doc was written, and the one
 * way to build it dishonestly is to invent a date for a key that has none. A
 * Bing Webmaster key does not expire; a Google sign-in made against a consent
 * screen still in Testing expires in seven days. Those are different facts and
 * the card has to be able to say which it is holding.
 */
export interface IntegrationExpiry {
  /**
   * `flow` — a connection flow records the date (Google's sign-in).
   * `operator` — nobody but the operator knows; the card offers a date field.
   * `never` — this credential has no expiry date to state at all, and the card
   *   shows exactly that value rather than a field that would collect a guess.
   *
   * The card renders this as a VALUE ("No expiry date", a date, a countdown),
   * never as a sentence about why (bead `ro-ujb9.96.6.1`): the reasons live in
   * doc 11, and a card that needs a paragraph to state a date is the wrong card.
   */
  known: CredentialExpirySource | 'never';
  /**
   * Where the operator makes a flow-dated credential stop expiring, when the
   * provider offers that — Google's consent screen, whose Publish button ends
   * the seven-day Testing grant. Rendered as a link beside the date.
   */
  fix?: IntegrationLink;
}

/** A deep link into the provider's own screen, and the words on it
 * ("Get a key", "Publish app"). Two or three words: the destination is the
 * explanation. */
export interface IntegrationLink {
  url: string;
  label: string;
}

/**
 * What pressing **Test connection** actually does to the outside world.
 *
 * DECLARED, BECAUSE THE CARD HAS TO SAY IT BEFORE THE PRESS. Every probe in
 * this system is meant to be the provider's cheapest free read (see
 * `workers/ingest/src/credential-probes.ts`), and for four providers it is. Two
 * cannot be:
 *
 *  - `side-effect` — the only call that proves the credential does something an
 *    operator would notice. A Discord webhook has no read that proves delivery,
 *    which is exactly what the register says *live* means for it, so the test
 *    posts a labelled message into their channel.
 *  - `none` — no provider call is made at all, because the only one available
 *    would cost something the operator was saving. The button still answers,
 *    with what the OS can honestly check and the sentence saying what it could
 *    not.
 *
 * A button that surprises somebody once is a button they stop pressing, so
 * anything but `free` is printed beside it rather than discovered afterwards.
 */
export type ProbeCost = 'free' | 'side-effect' | 'none';

/**
 * HOW THE INTEGRATIONS CONNECT PANEL SETS THIS PROVIDER UP (bead
 * `ro-ujb9.96.7.1`, epic `ro-ujb9.96.7`).
 *
 * One panel on `/integrations` connects every provider: the operator enters
 * what the provider issued, presses Connect, and the ingest asks the provider
 * BEFORE it stores anything — Grafana's "Save & test", with the order
 * reversed so a refused key is never kept. The panel shows Checking, then Key
 * accepted or the provider's refusal; a connection is never called connected
 * ahead of that answer.
 *
 * DECLARED, BECAUSE BOTH SIDES READ IT. The Tower opens the panel only for a
 * provider that declares a kind, and the ingest's save-and-test
 * (`workers/ingest/src/credential-connect.ts`) refuses a provider that does
 * not — so the two can never disagree about which providers skip the old
 * multi-step card. Absent means the provider still uses its own setup page.
 * Where each value comes from is the field's own `link`, read by the panel and
 * the provider page alike.
 *
 * `key`: every field is typed or pasted, and one provider call proves them —
 * a free read (Bing's verified sites, DataForSEO's account, PostHog's projects
 * in whichever region answers, Mediavine's sign-in and site list, each
 * calendar feed), or Discord's one test message, the side effect its `test`
 * declares and the panel names beside the press (bead `ro-ujb9.96.7.14`).
 * `site-tokens`: a token pasted per site (Clarity). `sign-in`: the provider's
 * own consent screen (Google).
 */
export interface IntegrationConnect {
  /**
   * `key` — typed once and proven by one provider call before it is kept (Bing,
   * DataForSEO, PostHog, Mediavine, Discord, calendar feeds). `site-tokens` — the provider issues one token per
   * site and offers no free read (Clarity, bead `ro-ujb9.96.7.9`): each site's
   * token is pasted on its own row in the panel and saved on paste, and the
   * proof is the export itself, run by an explicit Run now that says what it
   * spends. `sign-in` — the provider is connected by signing in on its own
   * consent screen (Google, bead `ro-ujb9.96.7.7`): the panel's body is the
   * sign-in — one button where the OAuth client is already present (hosted),
   * or the one-time console setup and the client file where it is not
   * (self-hosted) — and the account's sites follow the sign-in back.
   */
  kind: 'key' | 'site-tokens' | 'sign-in';
  /**
   * WHAT THE OPERATOR GIVES (bead `ro-ujb9.96.7.25`), and so what an accepted
   * connection is called: an API key or token (`api-key`, "Key accepted"), a
   * person's own email and password (`login`) or a consent screen (`oauth`),
   * both "Signed in", or an address that is itself the secret (`url` — a
   * webhook, a calendar feed — "URL accepted"). REQUIRED, like `expiry` and
   * `test`: a provider added here must not inherit "Key accepted" for a login
   * nobody gave it a key for. Read through {@link acceptedAs}.
   */
  credential: ConnectCredential;
  /**
   * `false` for a connection of the whole installation with no site to match
   * (Discord's webhook, the calendar feeds — bead `ro-ujb9.96.7.14`): the
   * panel ends on the provider's answer and Done, with no site list after
   * it. Absent: the account's sites follow an accepted key.
   */
  sites?: false;
  /** Where the operator adds a site the account does not hold yet, and the
   * link's words ("Add in Bing") — offered on the connect panel's site list
   * for an asset the account lists nothing for (bead `ro-ujb9.96.7.2`).
   * Absent for a provider whose sites are the portfolio's own (DataForSEO). */
  addSite?: { url: string; label: string };
}

/** What the operator gives a provider to connect it (`IntegrationConnect`). */
export type ConnectCredential = 'api-key' | 'login' | 'oauth' | 'url';

/**
 * WHAT AN ACCEPTED CONNECTION IS CALLED — the one derivation (bead
 * `ro-ujb9.96.7.25`): `key` ("Key accepted"), `sign-in` ("Signed in") or
 * `url` ("URL accepted"). The stored credential's own way in decides where a
 * provider offers two (Google's sign-in or its service-account key); otherwise
 * the provider's declared credential does. The connect panel's answer, the
 * Integrations row, a provider's page and System health all read it here, so
 * an email and a password are never called a key on one screen and a sign-in
 * on the next.
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
 * draws rather than a sentence it prints (bead `ro-ujb9.96.7.1`).
 *
 *  - `accepted` — the provider answered the test call and the credential is now
 *    stored, with what that call showed: Bing's verified-site count, or
 *    DataForSEO's prepaid credit (null when the answer stated none — an absent
 *    balance is not a zero one).
 *  - `refused` — the provider answered and said no. Nothing was stored, and a
 *    credential already stored for this provider is untouched.
 *  - `unreachable` — the provider did not answer usably (a timeout, a network
 *    failure, a 5xx). Nothing was stored; the same details can be sent again.
 *
 * `checkedAt` is when the answer arrived. No field ever carries a credential.
 */
export interface ConnectFacts {
  /** Bing Webmaster Tools: verified sites the key can read. */
  sites?: number;
  /** DataForSEO: prepaid credit in USD, the digits the account endpoint
   * reported (`ExactUsd`). */
  creditUsd?: ExactUsd | null;
  /** PostHog: the projects the key can read (bead `ro-ujb9.96.7.8`). */
  projects?: number;
  /** PostHog: the Cloud region that answered for the key — found by asking
   * both, never typed. */
  region?: 'us' | 'eu';
  /** Calendar feeds: how many feeds answered with a calendar (bead
   * `ro-ujb9.96.7.14`) — all of them, or the connect is refused. */
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

/** One site's token for a `site-tokens` provider, saved on its own row (bead
 * `ro-ujb9.96.7.9`): merged into the provider's per-site map, never replacing
 * the other sites' tokens. */
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
  /** What the press does, said by the button itself (bead `ro-ujb9.96.6.1`):
   * `free` is "Test connection", `side-effect` names the message it sends,
   * `none` names the local check it runs. No sentence beside it. */
  cost: ProbeCost;
}

/**
 * WHAT A METERED PROVIDER SPENDS, AND WHAT THE OS CAN COUNT OF IT
 * (beads `ro-vu8d.25`, `ro-qpas`; doc 15 flow C step 3).
 *
 * Doc 15 has asked since it was written for a live widget to show QUOTA REALITY —
 * its own example is "Clarity: 7/10 calls left today" — "so the operator never
 * wonders why a data source paused". Nothing rendered it, and the cards
 * explained their caps in PROSE instead, which is what the OS says when it
 * cannot show a number.
 *
 * IT IS DECLARED ONLY WHERE THE OS ALREADY HOLDS THE EVIDENCE, and the two
 * metered providers hold it in two different shapes — which is why this is a
 * union rather than one interface with optional halves. Clarity's ceiling is
 * CALLS, per asset per day, and every call it makes writes a manifest row.
 * DataForSEO's ceiling is DOLLARS, portfolio-wide per calendar month, and every
 * report it buys records what it cost on the same rows. Neither reading is a
 * provider call: on a ten-a-day cap the meter would be spending the thing it
 * measures, and on a prepaid account it would be asking a vendor a question the
 * OS's own archive already answers.
 *
 * WHAT NEITHER SHAPE CLAIMS TO BE is the provider's own account. DataForSEO's
 * prepaid credit is not a ceiling this OS can count — it is a figure the vendor
 * reports — so it is recorded as a dated SIGHTING beside the credential
 * (`CredentialMetadata.balance`) and rendered with its age beside the cap line,
 * never inside the bar (bead `ro-qpas`). A stored figure nobody had refreshed,
 * drawn as though it were current, is the one failure that task forbids.
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
 * A ceiling counted in DOLLARS, portfolio-wide per calendar month — the
 * `monthly_caps.data_usd` reserve that fails closed before a metered call.
 *
 * THE CEILING IS NOT DECLARED HERE. It is an operator-owned setting in
 * `config/constants.json`, so the card would go stale the day it was changed;
 * it rides on the reading instead, from the same place `/settings`' budget
 * meter and the Health page's spend summary read it.
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
  /** The UTC day these counts cover — the same calendar the metered spend
   * summary is written in, and the only day boundary the OS can state without
   * claiming to know the provider's own. */
  day: string;
  assets: ProviderMeterAsset[];
}

export interface PortfolioMonthMeterReading {
  window: 'portfolio-month';
  /** The UTC calendar month the sum covers, 'YYYY-MM'. */
  period: string;
  /** Month-to-date spend, in dollars — the SAME figure `DataSpendSummary`
   * carries, from the same reader, so the card and the budget meter cannot
   * disagree by a float. */
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

/** What is left of one ceiling. Floored at zero: a provider that let one extra
 * call through — or a month that overran its reserve — is not a negative
 * budget, and the card would be reporting an arithmetic curiosity instead of
 * "nothing left". One rule, so a day of calls and a month of dollars round the
 * same way at the bottom. */
export function meterRemaining(cap: number, spent: number): number {
  return Math.max(0, cap - spent);
}

/** How long before an expiry the OS starts warning — doc 15 flow C step 4's
 * "expiring creds flag at T-14d", stated once so the chip, the nav dot and
 * every test read the same horizon. */
export const CREDENTIAL_EXPIRY_WARN_DAYS = 14;

/**
 * How long a Google refresh token lives when the consent screen is still in
 * **Testing** — Google's own documented lifetime, and the reason bead
 * `ro-vu8d.14` exists: it is the first credential in this portfolio that dies on
 * a clock rather than on an operator action.
 */
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
 * Read one credential's expiry against a clock — the ONE derivation, so the
 * chip on the card, the dot in the sidebar and every test agree on when T-14d
 * starts.
 *
 * An unparseable stored date reads `unstated` rather than `expired`: a defective
 * timestamp is not evidence that a credential died, and telling an operator to
 * reconnect a working provider is the more expensive mistake.
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
 * How a provider is authenticated, where it offers more than one way.
 *
 * Google is the only provider with two (bead `ro-vu8d.3`): an OAuth grant the
 * operator makes by signing in, or the service-account key they used to have to
 * paste. BOTH stay valid — an install already running on a service account is
 * not asked to move — so this is a fact the card reports, never a mode the
 * product picks for you.
 *
 * PostHog has two as well (bead `ro-ujb9.96.7.8`): one personal API key for
 * the account (`account-key`), whose region and projects the OS discovers, or
 * the older key per site (`site-keys`), which an install that connected before
 * keeps collecting with.
 */
export type CredentialAuthKind = 'oauth' | 'service-account' | 'account-key' | 'site-keys';

/**
 * One complete way to authenticate a provider: every field it needs, together.
 *
 * A provider that declares these marks NO field `required`, because "required"
 * cannot express *either these two or that one*. Completeness is instead "some
 * path holds all of its fields", and the DECLARATION ORDER is the preference —
 * the first path is what a first-run card offers, and the first COMPLETE path
 * is the one in force.
 */
export interface IntegrationAuthPath {
  kind: CredentialAuthKind;
  /** What the card calls this way in — "Sign in with Google". */
  label: string;
  /** Every field name this path needs. All of them, or the path is incomplete. */
  fields: readonly string[];
}

/** Where the value a client actually used came from. Recorded on the run so
 * "the collector is still on `.dev.vars`" is a fact you can read rather than a
 * thing you assume. */
export type CredentialSource = 'store' | 'env' | 'none';

/**
 * AN OLDER ENV BINDING THAT CARRIES ONE ASSET'S KEY (bead `ro-vu8d.24`).
 *
 * Clarity is the only one: `CLARITY_PROJECT_API_TOKEN` is the single-project
 * shape the operator configured before an asset map existed, hard-bound to one
 * asset. It deliberately gets no form input — offering "the token, but only for
 * that one asset" would teach a shape the product is replacing — but it is a
 * WORKING credential, and a card that reads *Not connected* over a collector
 * that collects is the false red this catalog exists to stop.
 *
 * So it is DECLARED instead of deleted: the summary folds it into the asset map
 * as that asset's key, the importer moves it into the store as one map entry,
 * and the collector reads it under its own binding name so a run still records
 * which slot answered. Nothing renders an input for it, and nothing ever writes
 * one back.
 */
export interface LegacyAssetBinding {
  /** The env binding name, exactly as an install still holds it. */
  name: string;
  /**
   * The lane whose asset it serves. WHICH asset is never written here (bead
   * `ro-ujb9.118`): it is `legacyBindingAsset(lane, register)` — the first
   * asset, in the installation's own data-source register order, with this
   * lane.
   */
  lane: string;
  /**
   * That asset, where a reader holding the register has answered — the Tower's
   * providers route fills it for the env importer. Absent in the catalog.
   */
  asset?: string | null;
}

export interface IntegrationField {
  /** The field's name AND its legacy env binding name. See the module header. */
  name: string;
  /** What the form calls it. */
  label: string;
  /**
   * True when the value is a secret: the form masks it, and it is never
   * rendered back.
   *
   * It does NOT gate whether the value can leave the ingest — nothing can. A
   * `secret: false` field (a DataForSEO API login) is still write-only; it is
   * marked false only because typing it in the clear is safe and a masked field
   * an operator cannot proof-read is a support ticket.
   */
  secret: boolean;
  kind: IntegrationFieldKind;
  required: boolean;
  /**
   * WHERE THE VALUE COMES FROM, as a deep link beside the label ("Get a key")
   * rather than a sentence under the input (bead `ro-ujb9.96.6.1`; the connect
   * panel's pattern, bead `ro-ujb9.96.7.1`). Absent for a value the operator
   * already knows (an email) or a flow writes (`managed`).
   */
  link?: IntegrationLink;
  /** What a value looks like, shown in the empty input — the format, never an
   * instruction ("….apps.googleusercontent.com"). */
  placeholder?: string;
  /** The access the value must carry, one short label each ("Query: read"),
   * drawn as chips beside the field — PostHog's own pattern for a restricted
   * key (docs/briefs/2026-09-23-integration-setup-copy.md#prior-art). */
  grants?: readonly string[];
  /**
   * True when a FLOW writes this value and an operator never types it — the
   * Google refresh token, which the OAuth round-trip stores, and PostHog's
   * older per-site key map, which an existing install keeps but nothing asks
   * for any more (bead `ro-ujb9.96.7.8`).
   *
   * The connect form skips it, because a text box for a refresh token invites
   * somebody to paste something that cannot work; the card still reports
   * whether the store holds it, because *is this connected* is exactly the
   * question the field answers.
   */
  managed?: boolean;
  /**
   * For an `asset-map` field: an older single-asset binding whose value is one
   * entry of this map (bead `ro-vu8d.24`). See {@link LegacyAssetBinding}.
   */
  legacyAssetBinding?: LegacyAssetBinding;
}

export interface IntegrationProvider {
  id: IntegrationProviderId;
  label: string;
  /** Where the reader goes for the full story. */
  docRef: string;
  scope: IntegrationScope;
  /** The `config/integrations.json` catalog lane ids this ONE credential
   * unlocks — `google` powers both `ga4` and `gsc`. It is what turns "which
   * assets use this provider" into an answer. */
  lanes: readonly string[];
  /**
   * Lanes whose PROVIDER fixes the reporting day for every property, whoever
   * runs the OS (bead `ro-ujb9.118`). A fact about the provider, never the
   * installation's clock — that is the saved `os_time_zone`. Read through
   * {@link providerReportingTimeZone}; this is the one place product code may
   * name a zone (`scripts/neutral-code-gate.mjs`).
   */
  reportingTimeZones?: Readonly<Record<string, string>>;
  fields: readonly IntegrationField[];
  /**
   * The ways in, when there is more than one. Absent means the single implicit
   * path of every `required` field — which is every provider but Google.
   */
  authPaths?: readonly IntegrationAuthPath[];
  /**
   * Whether this credential can ever carry an expiry date, and who knows it
   * (bead `ro-vu8d.8`). REQUIRED, so a provider added here cannot quietly
   * inherit "no expiry" from an omission — the honest answer for a key with no
   * stated lifetime is a declared `never` carrying the sentence that says so.
   */
  expiry: IntegrationExpiry;
  /**
   * What the *Test connection* button does for this provider. REQUIRED for the
   * same reason `expiry` is: a provider added here must not inherit "free and
   * invisible" from an omission, because the one probe an operator has to be
   * warned about is exactly the one somebody forgot to describe.
   */
  test: IntegrationTest;
  /**
   * What this provider meters, where the OS's own rows can count it (beads
   * `ro-vu8d.25`, `ro-qpas`). Absent for every provider with no cap the OS can
   * measure — and a provider with no meter shows nothing rather than a full
   * bar, because an unmetered bar reads as a measured zero.
   */
  meter?: IntegrationMeter;
  /** How the connect panel sets this provider up. Absent = its own setup page
   * (see `IntegrationConnect`). */
  connect?: IntegrationConnect;
  /**
   * When set, this credential gets NO card of its own: it is a prerequisite the
   * named provider's card asks for in place.
   *
   * `google-oauth-app` is the only one. Its client id and secret configure HOW
   * you connect Google rather than being a second thing to connect, and a fifth
   * card on `/integrations` reading "Google OAuth app · Not connected" beside
   * "Google · Connected" would be one connection stated as two.
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
  | 'posthog';

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    id: 'mediavine', label: 'Mediavine', scope: 'shared', lanes: ['ad-network'],
    docRef: 'docs/11-integrations.md#mediavine-revenue',
    // A password has no lifetime, and the saved session refreshes its own
    // access tokens; Mediavine states no refresh-token lifetime to date.
    expiry: { known: 'never' },
    // Reads the sites the account can access, reusing the saved session.
    test: { cost: 'free' },
    // Signs in and lists the account's sites before the login is kept (bead
    // `ro-ujb9.96.7.6`); a site is added to Mediavine by applying, so there is
    // no Add link to offer. An email and a password: signed in, not a key.
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
    // The SIGN-IN is the half with a clock on it, and the console setup this OS
    // prescribes (doc 11 "the one-time console setup" step 3: External, add
    // yourself as a test user) produces a consent screen in Testing — which
    // Google expires every refresh token from after seven days. Publishing the
    // consent screen ends that, so the card's date carries the link that does
    // it. The service account has no expiry at all.
    expiry: {
      known: 'flow',
      fix: { url: 'https://console.cloud.google.com/apis/credentials/consent', label: 'Publish app' },
    },
    // Mints a read-only token, lists the Search Console sites and reads one GA4
    // property's metadata: no day of data, no reporting quota.
    test: { cost: 'free' },
    // TWO WAYS IN, and the sign-in is first because it is the one an operator
    // can finish without leaving the product (bead `ro-vu8d.3`). Neither field
    // is `required`: either alone is a working Google credential, and marking
    // both required would refuse the very save the OAuth callback makes.
    // Connected in the panel by signing in (bead `ro-ujb9.96.7.7`); the
    // service-account path keeps the provider's own page.
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
    // NOT a card of its own — the Google card asks for it in place. See
    // `companionOf`.
    id: 'google-oauth-app',
    label: 'Google OAuth app',
    docRef: 'docs/11-integrations.md#connecting-google',
    scope: 'shared',
    lanes: [],
    // A client secret is rotated on the operator's schedule, and Google states
    // no lifetime for one. Nothing here could produce a date that was not a
    // guess.
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
        // sign-in, and an operator who cannot proof-read it against the console
        // is one support ticket away from a redirect-mismatch they cannot see.
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
    // Bing prints no expiry on a Webmaster key. The operator may still have a
    // date — a rotation they scheduled, a key issued on a temporary account —
    // and that date is worth a warning, so the card offers the field. It stays
    // empty until they fill it, and an empty field is not a fabricated date.
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
    // THE OTHER METER THE OS CAN READ WITHOUT ASKING (bead `ro-qpas`). What
    // decides whether next Monday's sweep runs is the $25/month portfolio
    // reserve, not the prepaid credit — the reserve is what fails closed before
    // a call, and it is the one of the two the OS records for itself: every
    // report writes its exact cost onto the same rows Clarity's meter counts.
    // The credit balance is the vendor's own figure and is only ever seen
    // inside an answer DataForSEO sends, so it is stamped beside the credential
    // whenever one carries it and shown with its age — a separate line, not a
    // second bar, because only one of the two is a ceiling this OS enforces.
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
    // A secret ICS address has no lifetime: it works until the operator resets
    // it in the calendar, which is an action rather than a date.
    expiry: { known: 'never' },
    // Reads each feed once and reports it by name; writes nothing.
    test: { cost: 'free' },
    // Every feed read before the map is kept (bead `ro-ujb9.96.7.14`): one
    // bounded GET per feed, the proof the Test button runs.
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
    // WHY IT IS HERE AT ALL (bead `ro-vu8d.18`). Discord was env-only for no
    // reason anyone had written down: one shared url, one probe that already
    // existed in `pnpm creds:check`, and no row in this catalog — so it could
    // not be connected in the product, got no card, and was not moved by the
    // Import button. It falsified the epic's promise that a fresh install needs
    // only the bootstrap secrets defined in docs/06-operations.md.
    id: 'discord',
    label: 'Discord (operator notifications)',
    // The catalog anchor, like Bing's and DataForSEO's: the card renders this
    // string verbatim, and the "How to connect one" heading's own anchor is a
    // seventy-character line of slugified prose sitting under the provider name.
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'shared',
    lanes: ['discord-webhooks'],
    // A webhook has no lifetime: it works until somebody deletes it in Discord,
    // which is an action rather than a date — the same shape as a calendar
    // address, and for the same reason.
    expiry: { known: 'never' },
    // THE ONE PROBE IN THIS CATALOG WITH A SIDE EFFECT, and the reason the cost
    // is declared at all. Discord offers a read of the webhook object, but the
    // register's own definition of live for this data source is that the OS can
    // DELIVER a notification — "not merely that a webhook URL exists" — and a
    // read proves the second, not the first. So the test posts, and the button
    // says so in its own label before the press ("Send test message").
    test: { cost: 'side-effect' },
    // Connected in the panel (bead `ro-ujb9.96.7.14`): the webhook is kept
    // only once its test message is delivered, and the panel names that
    // message beside the press.
    connect: { kind: 'key', credential: 'url', sites: false },
    fields: [
      {
        name: 'DISCORD_WEBHOOK_URL',
        label: 'Webhook URL',
        // The url IS the credential — anyone holding it can post to that
        // channel — so it is never echoed and never logged. It is not MASKED,
        // for the same reason the calendar feed map is not: an operator who
        // cannot proof-read the address they pasted cannot see the mistake that
        // makes it 404.
        secret: true,
        kind: 'url',
        required: true,
        link: { url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks', label: 'Create a webhook' },
        placeholder: 'https://discord.com/api/webhooks/…',
      },
    ],
  },
  {
    // THE FIRST PER-ASSET CREDENTIAL (bead `ro-vu8d.9`). Clarity issues a
    // data-export token per PROJECT, so there is no portfolio credential to
    // enter — and that, plus having no call cheap enough to probe, is why it sat
    // on its env binding while every other provider became a form.
    //
    // Neither obstacle needed a new table. The per-asset dimension is one
    // `asset-map` field inside the one encrypted row (see `IntegrationScope`),
    // and the missing probe is DECLARED as missing (`test.cost: 'none'`) instead
    // of faked with a call that would spend a tenth of an asset's daily budget.
    id: 'clarity',
    label: 'Microsoft Clarity (data export)',
    docRef: 'docs/11-integrations.md#the-catalog',
    scope: 'per-asset',
    lanes: ['clarity'],
    // A data-export token has no stated lifetime, and — unlike Bing's — no
    // operator date field either: one row here holds a token per asset, and a
    // single date could not honestly describe a map of them.
    expiry: { known: 'never' },
    // NO CALL AT ALL, and this is the honest half of the bead. Clarity's export
    // API allows 10 calls per project per DAY and offers no free account or
    // metadata endpoint, so the cheapest probe available would spend a tenth of
    // one asset's daily budget to learn what the 04:30 export learns for free a
    // few hours later. So the button checks what the OS can see — which assets
    // hold a token — and is named for that check ("Check keys").
    test: { cost: 'none' },
    // THE ONE METER THE OS CAN READ WITHOUT SPENDING FROM IT (bead
    // `ro-vu8d.25`). The cap that made this card's Test button call nobody is
    // the same cap doc 15 flow C step 3 asked to SHOW, and the number is
    // knowable: the export writes one manifest row per call, so what is left
    // today is arithmetic over rows this OS wrote (UTC day; Clarity resets on
    // its own clock, and a call made elsewhere is invisible here).
    meter: {
      window: 'asset-day',
      perAssetPerDay: 10,
      unit: 'call',
      countedFrom: 'clarity',
    },
    // ONE PASTE PER SITE, IN THE PANEL (bead `ro-ujb9.96.7.9`): each site's
    // token on its own row, saved on paste into this map; the first export is
    // an explicit Run now that says it spends one of the day's ten calls.
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
        // THE SHAPE THIS ONE REPLACED, kept readable rather than deleted (bead
        // `ro-vu8d.24`). An install still holding the single-project binding
        // collects perfectly well, and before this declaration its card said
        // Not connected — the same false red `ro-vu8d.15` closed for Google.
        // Connect moves it into the map; there is no input for it.
        legacyAssetBinding: {
          name: 'CLARITY_PROJECT_API_TOKEN',
          lane: 'clarity',
        },
      },
    ],
  },
  {
    // PRODUCT ANALYTICS (beads `ro-ghis.1`, `ro-ujb9.96.7.8`). ONE PERSONAL API
    // KEY FOR THE ACCOUNT: the connect panel shows it to PostHog's US and EU
    // clouds at once, keeps it only when one answers, and lists that region's
    // projects — matched to sites by the domains each project records, with
    // the project's saved funnels — so region, project id and funnel steps are
    // discovered, never typed. Which region and project each site reads is NOT
    // secret and does not live here: Start saves it on the site's Data sources
    // entry (`host`, `projectId`, `funnels`), as that tab would.
    //
    // THE OLDER SHAPE STILL COLLECTS. An install that connected a key per site
    // (`POSTHOG_KEYS`, bead `ro-ghis.1`) keeps its map; a site with a key of its
    // own uses it, and every other site the account key. Nothing asks for a new
    // per-site key any more, so the map is `managed` — never a form field.
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

/** The provider with this id, or null. The one lookup every runtime uses, so an
 * unknown id is one answer rather than four spellings of a 404. */
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
  /** Which way, when the provider offers more than one. `null` for the four
   * providers with a single implicit path — there is no choice to report. */
  auth: CredentialAuthKind | null;
  /** Field names still needed before anything works. Empty when complete. */
  missing: string[];
}

/**
 * Read a set of held field names against one provider's schema — the ONE rule
 * for "is this credential usable", wherever the names came from.
 *
 * It is called with the store's field list, with the env bindings that are set,
 * and (mirrored, because Node cannot import this package's TypeScript) by
 * `scripts/dev-secrets.mjs` against `.dev.secrets.json`. One rule, so a
 * credential the card calls connected is one the collector can actually run.
 *
 * WHEN NOTHING IS COMPLETE the `missing` list names the CLOSEST path rather
 * than every field of every path: an operator who has pasted a service-account
 * map and is one grant short must not be told to go and sign in instead.
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

/** One provider's legacy env bindings, read once (bead `ro-vu8d.24`). */
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
 * WHAT THE ENVIRONMENT HOLDS FOR ONE PROVIDER — the one rule, so the card, the
 * collector and the importer cannot disagree about whether a legacy binding
 * counts (bead `ro-vu8d.24`).
 *
 * Before this, three readers answered separately: the collector read
 * `CLARITY_PROJECT_API_TOKEN` and collected, the summary read only the DECLARED
 * field names and called the card *Not connected*, and the importer moved
 * nothing. An install on the older shape therefore had a working data source
 * and a red card — and no way to move.
 *
 * THE MAP WINS wherever both name the same asset: it is the shape that can
 * express the whole portfolio, so a single-asset binding must never override an
 * explicit entry. A map that does not parse is left exactly as it is rather
 * than replaced, because a broken value is a validation refusal the operator
 * has to see, not a value to quietly discard.
 *
 * WHICH ASSET the legacy binding serves is `legacyBindingAsset` over
 * `register` — the installation's own data-source register, store first (bead
 * `ro-ujb9.118`). A caller without it folds nothing: the binding serves no
 * asset rather than one the product guessed.
 */
export function readEnvCredential(
  provider: IntegrationProvider,
  bindings: Record<string, unknown>,
  register?: unknown,
): EnvCredentialRead {
  const fields: Record<string, string> = {};
  const legacySlots: Record<string, string> = {};
  // This integration started with the vault. Disconnect must not revive a legacy environment login.
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

/** What is known about one provider's credential — NAMES and metadata only.
 *
 * `source` is the question the page exists to answer: `store` (entered in the
 * product), `env` (the legacy `.dev.vars` path, still working), or `none`. A
 * store credential missing a required field still reads `store`, with the gap
 * named in `missingFields` — half-configured is its own state and must not
 * masquerade as unconfigured.
 */
/**
 * What a credential can say about ITSELF without naming a secret.
 *
 * Deliberately stored in the CLEAR, beside the ciphertext rather than inside
 * it (`credentials.fields_json`): the Integrations page has to render these,
 * and `listCredentialSummaries` answers without the bootstrap key on purpose —
 * so a rotated key still leaves a card an operator can read and disconnect.
 * Nothing here is a credential: an email address identifies the grant, and the
 * scopes are what Google itself would show on the account's permissions page.
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
   * When this credential stops working, where that is knowable (bead
   * `ro-vu8d.8`). Null for every credential whose provider states no lifetime
   * and whose operator has not named one — never a guess, and never a date
   * derived from age alone.
   *
   * Non-secret by construction, which is why it rides here rather than inside
   * the ciphertext: a card whose bootstrap key was rotated must still be able
   * to say "this expires on Friday" while it says "reconnect me".
   */
  expiresAt: string | null;
  /** Who supplied the date above. `operator` is sticky — a later sign-in must
   * not overwrite the operator's own answer (including their answer that there
   * is NO expiry, which is `expiresAt: null` with this set). */
  expirySource: CredentialExpirySource | null;
  /**
   * What the provider's own PREPAID ACCOUNT held the last time this OS saw the
   * figure (bead `ro-qpas`). Absent for every provider that has no such account
   * — six of the seven — which is why it is optional rather than a null every
   * credential has to carry.
   *
   * Non-secret in the same way the expiry is: a dollar amount identifies no
   * login, and it rides in the clear beside the ciphertext so a card whose
   * bootstrap key was rotated can still say what the account held.
   */
  balance?: CredentialBalance | null;
}

/**
 * A PREPAID BALANCE AND THE INSTANT IT WAS SEEN, never one without the other
 * (bead `ro-qpas`).
 *
 * DataForSEO is prepaid, and the credit left on the account is the number an
 * operator reaches for when they ask whether next Monday's sweep can run. It
 * comes back only inside a provider answer, so it is a SIGHTING rather than a
 * reading: what the OS can honestly say is what it saw and when. The two travel
 * as one object because a figure that lost its timestamp would be renderable as
 * though it were current, which is the one thing this must not do.
 */
export interface CredentialBalance {
  /** Dollars of credit, the digits the provider reported (`ExactUsd`); the
   * store keeps six decimals. */
  usd: ExactUsd;
  /** When the OS saw it — the instant of the answer that carried it. */
  seenAt: string;
}

/**
 * When a credit sighting is TOO OLD TO ACT ON (bead `ro-vu8d.27`): two missed
 * weekly refreshes. The sweep refreshes the figure once a week and its read is
 * deliberately silent when refused, so three weeks of failed reads look exactly
 * like three weeks of not looking — and the operator uses this number to
 * decide whether next Monday's sweep can run. One bad week is not an alarm;
 * two is the figure quietly ageing, and the card must say so rather than show
 * it plainly.
 */
export const CREDENTIAL_BALANCE_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * An amount of US dollars as exact decimal text: a JSON number's own digits
 * (`42.5`, `-0.25`), never a floating-point number (bead `ro-ujb9.76.4.4`). A
 * float cannot hold most cents exactly — `(1.005).toFixed(2)` is `1.00` — so
 * a prepaid balance crosses from the provider to the store (`numeric(14,6)`,
 * as provider prices) and on to the card as the text it arrived as.
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
 * Read one credential's last-seen account balance against a clock — the ONE
 * derivation, so the card, the gallery and every test age it the same way
 * (bead `ro-qpas`).
 *
 * NOTHING RECORDED AND NOTHING READABLE ANSWER THE SAME WAY: null, which the
 * card renders as the sentence saying no figure has been seen yet. A sighting
 * whose timestamp does not parse is exactly the case where showing the number
 * would be showing an undated one, so it is dropped rather than shown bare —
 * the same rule `credentialExpiry` applies to a defective date.
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
  source: CredentialSource;
  /** Field NAMES the store holds for this provider. Never values. */
  fields: string[];
  /**
   * For a `per-asset` provider: the ASSET IDS this credential holds a key for
   * (bead `ro-vu8d.9`). Ids only — never a key, and never how long one is.
   * Always empty for a `shared` provider, which has no per-asset dimension to
   * report.
   *
   * It rides beside the ciphertext in `fields_json`, in the clear, for the same
   * reason the metadata does: `listCredentialSummaries` answers WITHOUT the
   * bootstrap key on purpose, and a card that could not say which assets are
   * covered until somebody found the key would go blank exactly when the key is
   * the problem. An asset id is not a secret — it is in
   * `config/integrations.json` and in the URL of every asset page.
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
   * For the one credential that can ALSO carry a per-asset property map:
   * whether that map is still the only answer for anything (beads `ro-90mr`,
   * `ro-vu8d.22`).
   *
   * `null` for every provider that holds no such map — which is all of them but
   * Google — and for a Google install with no account blob at all. It carries no
   * credential CONTENT: the answer is asset ids and data-source ids, which is
   * exactly what `IntegrationProviderStatus.assets` already carries.
   *
   * IT COMES FROM THE INGEST because only the ingest can read the blob, and the
   * question is *which assets does the credential name*. The Tower used to
   * derive its own version from `config/integrations.json` alone and the two
   * could disagree about an ORPHAN — an asset the credential names that the
   * register has no entry for — with the card telling the operator they could
   * delete ids that were still steering a run.
   */
  propertyMap?: CredentialPropertyMapUse | null;
}

/** One provider as the Integrations page renders it: the schema, the connection
 * state, and which assets are counting on it. */
export interface IntegrationProviderStatus {
  provider: IntegrationProvider;
  credential: CredentialSummary;
  /** Assets that declare one of this provider's lanes in
   * `config/integrations.json`, with the lanes they declare. Ids only: the
   * register knows nothing about display names, and a page that had to read the
   * store for them could go blank when the store is the thing that is broken. */
  assets: IntegrationProviderAssetRef[];
  /**
   * Spend against `provider.meter` — today's calls, or this month's dollars —
   * from the manifest rows this OS wrote (beads `ro-vu8d.25`, `ro-qpas`).
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
 * WHETHER A CREDENTIAL'S OWN PROPERTY MAP IS STILL LOAD-BEARING (bead `ro-90mr`).
 *
 * Google's `GOOGLE_SIGNAL_ACCOUNTS` blob holds a per-asset `ga4_property_id` /
 * `gsc_site_url` map, and since `ro-vu8d.16` each asset's own Sources tab holds
 * the same fact and wins. Two places holding one fact is a state D21 refuses to
 * make permanent, so the collectors let go of the copy the moment nothing needs
 * it — and the card has to be able to say WHEN that is, because otherwise the
 * operator has no way to know the ids in their credential are dead weight.
 *
 * ONE FUNCTION ANSWERS IT, and it is the collector's own
 * (`credentialPropertyMapUse` in `workers/ingest/src/lane-mapping.ts`, bead
 * `ro-vu8d.22`). This type is what that answer looks like on the wire.
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
 * ONE asset row on a provider card: who declares this provider, and — for a
 * per-asset credential — whether a key is actually held for them.
 *
 * THE SINGLE REPRESENTATION OF "WHICH ASSETS DOES THIS CREDENTIAL SERVE"
 * (bead `ro-vu8d.9`). Two facts arrive from two places: the catalog says which
 * assets DECLARE this provider's data sources, and the store says which assets
 * a key is HELD for. They disagree in both directions and both disagreements
 * matter — an asset waiting on a token is the most actionable row on the card,
 * and a token stored for an asset nothing maps is a secret nobody is using. So
 * they are merged HERE, once, and the card, the connect form and the tests all
 * read this list rather than each pairing the two up their own way.
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
  // A key stored for an asset the catalog does not map is NAMED rather than
  // dropped: it is either a typo in an asset id or a data source somebody
  // forgot to declare, and both are invisible if the card only lists the
  // catalog's side.
  for (const id of held) {
    if (!declared.has(id)) rows.push({ id, lanes: [], held: true });
  }
  return rows;
}

/**
 * The four states a provider card leads with, in the operator's words.
 *
 * These are NOT the five data-source states the Health page renders
 * (`live`/`degraded`/`needs-setup`/`skipped`/`not-applicable`). Those are about
 * one asset × one data source and are derived from collector evidence; these are
 * about one CREDENTIAL and are derived from the store. A data source can be
 * Working while its credential is still Legacy env, and that difference is the
 * whole point of epic `ro-vu8d`.
 */
export type ConnectionState = 'connected' | 'legacy-env' | 'not-connected' | 'failing';

/**
 * What the card says, from the credential summary alone.
 *
 * ORDER IS THE ARGUMENT. Nothing stored (or stored incomplete) is *not
 * connected* first, because there is no connection to call broken. Then a
 * credential whose last use did not work is *failing*, whatever it is stored
 * in — that is the fact that decides what the operator does next, and a green
 * chip over a failing key is the lie the Integrations page exists to stop. Only
 * then does WHERE it lives get to speak.
 *
 * "Its last use did not work" is derived rather than trusted, because
 * `lastError` carries no timestamp of its own: an error older than the last
 * success is one that has already been fixed, and must not shout. The ingest
 * does clear the column on success, so this is belt-and-braces — but the
 * derivation is what makes the rendering correct either way.
 *
 * IT LIVES IN THE CONTRACT, not in the Tower, since bead `ro-vu8d.23`: the
 * notifier interrupts the operator when a data source turns *Failing*, so
 * "failing" has to mean in the ingest exactly what it means on the card. Two
 * derivations of one state is what `ro-vu8d.22` had just finished removing.
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

/** What makes a `CREDENTIALS_KEY`: 32 random bytes, base64 (doc 06, bootstrap
 * secrets). The key itself is set where the ingest reads its environment. */
export const CREDENTIALS_KEY_COMMAND = 'openssl rand -base64 32';

/** `GET /api/integrations/providers`.
 *
 * Deliberately NOT `/api/integrations`, which already answers with the
 * portfolio lane matrix the Health page renders. Two payloads, two paths.
 */
export interface IntegrationCredentialsPayload {
  generatedAt: string;
  /** Whether `CREDENTIALS_KEY` is set and usable. */
  keyPresent: boolean;
  /** Why nothing can be stored yet, as codes the Tower draws — a state and the
   * one command that clears it (bead `ro-ujb9.96.6.19`). Empty when a
   * credential can be stored. `keyReason` keeps the long
   * sentence for the command line (`pnpm dev:secrets:import`); the Tower
   * renders these instead. */
  blockers: CredentialBlocker[];
  /** When it is not: the sentence naming how to generate one and where to put
   * it. Rendered in place of the forms, so nobody types a password into a field
   * that cannot save it. */
  keyReason: string | null;
  providers: IntegrationProviderStatus[];
}

/**
 * WHY A CREDENTIAL CANNOT BE STORED YET (bead `ro-ujb9.96.6.19`), as a code:
 *
 *  - `key-missing` — `CREDENTIALS_KEY` is not set;
 *  - `key-invalid` — it is set but is not 32 base64 bytes (or the previous
 *    key a rotation reads is not).
 *
 * The Tower draws each as a state and the one command that clears it, and the
 * ingest's own line for the command line is the same state, binding and
 * command (bead `ro-ujb9.96.6.25`), so the two can never say different things.
 */
export type CredentialBlocker = 'key-missing' | 'key-invalid';

/** Each blocker's state, in two or three words — the Integrations banner's
 * lead and the start of the ingest's line. Where to set the key is doc 06's
 * (bootstrap secrets), linked, never restated. */
export const CREDENTIAL_BLOCKER_LEADS: Readonly<Record<CredentialBlocker, string>> = {
  'key-missing': 'No encryption key',
  'key-invalid': 'Encryption key unusable',
};

/**
 * WHAT A CONNECTION TEST FOUND, AS FACTS (bead `ro-ujb9.96.6.19`).
 *
 * The Tower draws a result — a mark, counted facts, the parts that failed by
 * the operator's own names — and, where one exists, the one press that clears
 * it; never a sentence the ingest wrote. Nothing here is a credential or a
 * provider's own text: a feed is named by its label, a site by its id, a
 * Google identity by the account or robot address the card already shows.
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
 * THE ONE PRESS THAT CLEARS A RESULT:
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
 * work is an ANSWER to the question the button asked, not a transport failure.
 * `result` is what the Tower draws (bead `ro-ujb9.96.6.19`); `message` is the
 * same result as one short line (`probeLine`) for the command line and the
 * credential's stored last error. Neither ever contains a credential, and the
 * probe never stores the provider's response body.
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

/**
 * A result as ONE short line — `Answered · 3 sites`, `Refused · HTTP 403 ·
 * Search Console` — for the command line and the stored last error, so what a
 * failing card reads later is the same result the test showed, in a dozen
 * words at most.
 */
export function probeLine(result: ProbeResult): string {
  const facts = result.facts ?? {};
  const count = (n: number | undefined, one: string, many: string) => (n === undefined ? null : `${n} ${n === 1 ? one : many}`);
  const credit = exactUsd(facts.creditUsd);
  const parts = [
    PROBE_OUTCOME_WORDS[result.outcome],
    result.status !== undefined ? `HTTP ${result.status}` : null,
    count(facts.sites, 'site', 'sites'),
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
   * The non-secret facts to record beside the ciphertext.
   *
   * Only the OAuth callback sets this, inside the ingest Worker. The Tower's
   * PUT route builds `{ provider, fields }` explicitly and cannot forward it —
   * an operator's browser has no business asserting whose account a grant
   * belongs to.
   */
  metadata?: CredentialMetadata;
}

export type PutCredentialResult =
  | { ok: true; summary: CredentialSummary }
  | { ok: false; error: 'unknown_provider'; provider: string }
  | { ok: false; error: 'key_missing'; message: string }
  /** The table is not in the store yet. A Save that silently did nothing is the
   * worst outcome available, so this is an answer rather than a degradation. */
  | { ok: false; error: 'store_unavailable'; message: string }
  | { ok: false; error: 'validation'; issues: CredentialIssue[] };

export type DeleteCredentialResult =
  | { ok: true; summary: CredentialSummary }
  | { ok: false; error: 'unknown_provider'; provider: string };

/**
 * `PUT /api/integrations/:provider/expiry` — record (or clear) the one fact
 * about a credential that only the operator can see (bead `ro-vu8d.8`).
 *
 * DELIBERATELY NOT PART OF `PutCredentialInput`. Recording a rotation date must
 * not require retyping a password, and re-sealing the ciphertext to write a
 * public date would clear the last verdict for no reason. The expiry lives in
 * `fields_json`, in the clear, so this write needs no bootstrap key at all —
 * the same reason `deleteCredential` does not.
 *
 * `expiresAt: null` is a STATEMENT, not an omission: it says "this does not
 * expire", is stamped `operator`, and is what a published Google app answers
 * with so the next sign-in does not put the seven-day countdown back.
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
  /** Why nothing can be stored yet, as codes (bead `ro-ujb9.96.6.19`). */
  blockers: CredentialBlocker[];
  summaries: CredentialSummary[];
}
