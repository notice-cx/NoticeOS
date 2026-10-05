import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
// Connection tests — one least-privileged call per provider (bead `ro-vu8d.1`).
//
// APART FROM THE STORE (credentials.ts) ON PURPOSE. Every collector imports the resolver;
// the probes import every collector's client. Keeping both in one module would
// make that an import cycle, so the store knows nothing about providers and
// this file knows about both.
//
// THE THREE RULES, all load-bearing:
//   1. The call is the CHEAPEST AUTHENTICATED READ the provider offers, and free
//      wherever it has a free tier. A connection test must never cost money or
//      a metered quota an operator was saving for evidence. Where the cheapest
//      call is NOT free of consequence — Discord's only real proof is a posted
//      message — the provider DECLARES that in `IntegrationTest` and the card
//      says so before the press. A cost nobody was warned about is the same
//      failure as a cost nobody could afford.
//   2. The response body is read for a count and DROPPED. A probe is not
//      evidence: nothing here writes an observation, a manifest, or an R2
//      object, and nothing persists a provider payload. The one thing kept is a
//      fact about the CREDENTIAL rather than about the provider's data —
//      DataForSEO's prepaid credit, stamped with the instant it was seen so the
//      card can age it (bead `ro-qpas`), exactly as the verdict below is.
//   3. No result contains a credential. A calendar failure names the
//      operator's LABEL and never the url — the url IS the credential — and a
//      transport error's own message is never copied, because workerd puts
//      request urls inside some of them.
//
// A RESULT, NOT A SENTENCE (bead `ro-ujb9.96.6.19`). Every probe answers a
// `ProbeResult` — an outcome, counted facts, the parts that failed by the
// operator's own names, and the one press that clears it — which the Tower
// draws as a mark, values and a button. `message` is that same result as one
// short line (`probeLine`), for the command line and the stored last error.

import type {
  CredentialProbe,
  DeleteCredentialResult,
  DiscoveredSite,
  GoogleDiscoveredProperty,
  GooglePropertyDiscovery,
  IntegrationProviderId,
  ProbeResult,
} from '@noticeos/contract';
import { OS_TIME_ZONE, integrationProvider, probeLine, savedOsTimeZone, siteHost } from '@noticeos/contract';
import { getBingVerifiedSites } from './bing-client.js';
import { readDataForSeoAccount, recordDataForSeoBalance } from './dataforseo-balance.js';
import {
  credentialAssetKeys,
  credentialFeedUrl,
  deleteCredential,
  recordCredentialOutcome,
  resolveCredential,
} from './credentials.js';
import {
  type GoogleAuth,
  GOOGLE_SCOPES,
  googleAccessToken,
  googleAuthIdentity,
  isGoogleOAuthRevoked,
} from './google-auth.js';
import { MediavineError } from '@noticeos/mediavine';
import {
  listGa4Properties,
  listGscSites,
  resolveGoogleCredential,
  revokeGoogleGrant,
} from './google-oauth.js';
import { parseGoogleTargets } from './google-signals.js';
import { SignalError } from './signal-store.js';
import { discoverMediavineSites } from './mediavine-connection.js';
import { discordWebhookAnswer } from './notifier.js';
import { CloudflareD1Error, listD1Databases } from './cloudflare-d1-client.js';
import { POSTHOG_KEY_SLOT, posthogOrigin, resolvePosthogKeys } from './posthog-dumps.js';
import { POSTHOG_ACCOUNT_KEY_SLOT, readPosthogAccount } from './posthog-account.js';
import { posthogSettings, type LaneRegister } from './lane-mapping.js';
import { readCollectorConfigs } from './config-store.js';
import { disconnectMediavine } from './mediavine.js';
import { PROBE_CAPABILITY } from './probe-capability.js';

/** How long a probe waits on a provider before calling it unreachable. */
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/**
 * Ask the provider whether the credential works, with the cheapest
 * authenticated call it offers.
 *
 * Rules, all three load-bearing: the call is READ-ONLY and free where the
 * provider has a free tier (Google's token mint plus a sites list, Bing's
 * GetUserSites, DataForSEO's account endpoint, a calendar HEAD); the response
 * body is read for a count and then DROPPED — nothing is persisted, because a
 * connection test is not evidence; and no message ever contains a credential,
 * which is why a calendar failure names the operator's label and never the url.
 */
export async function probeCredential(
  env: IngestEnv,
  providerId: string,
  options: ProbeOptions = {},
): Promise<CredentialProbe> {
  // Discovery owns the probe timestamp and records only actual provider calls.
  if (providerId === 'mediavine') {
    const listed = await discoverMediavineSites(env, options, 'mediavine-test');
    return {
      ...answer(listed.ok, listed.ok ? { outcome: 'answered', facts: { sites: listed.value.length } } : mediavineRefusal(listed.kind)),
      checkedAt: listed.checkedAt,
      ...(listed.monitoringAvailable === false ? { monitoringAvailable: false } : {}),
    };
  }
  const checkedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const provider = integrationProvider(providerId);
  if (provider === null) {
    return { ...answer(false, { outcome: 'invalid', failing: [String(providerId)] }), checkedAt };
  }
  const resolved = await resolveCredential(env, provider.id);
  if (resolved.source === 'none') {
    return { ...answer(false, { outcome: 'not-connected', fix: { kind: 'connect' } }), checkedAt };
  }
  // `credentialAuthState` decided this credential is complete before the source
  // could read `store` or `env` at all (credentials.ts), so a per-field
  // re-check here would be a second rule that could disagree with it. What is
  // still worth checking is Google's SECOND half — the OAuth app — because a
  // stored refresh token with no client secret beside it is complete by the
  // store's rule and unusable by Google's.
  if (provider.id === 'google') {
    const google = await resolveGoogleCredential(env);
    if (
      google.oauth === null &&
      resolved.fields.GOOGLE_OAUTH_REFRESH_TOKEN !== undefined &&
      resolved.fields.GOOGLE_SIGNAL_ACCOUNTS === undefined
    ) {
      // Signed in, but the OAuth client beside the sign-in is gone.
      return { ...answer(false, { outcome: 'invalid', failing: ['OAuth client'], fix: { kind: 'connect' } }), checkedAt };
    }
  }

  const health = await tryHealthConnection(env, provider.id, resolved);
  const fetchImpl = options.fetchImpl ?? fetch;
  let probe: CredentialProbe;
  try {
    const found = await runProbe(env, provider.id, resolved.fields, fetchImpl, options.nowMs ?? Date.now());
    probe = { ...answer(found.ok, found.result), checkedAt };
  } catch (error) {
    // A revoked or expired Google grant is its own result (bead `ro-vu8d.14`):
    // swallowing it into "no answer" told the operator their network was the
    // problem while the real answer was that they had to sign in again. A
    // dead credential that reads as a flaky API is exactly the failure this
    // whole store exists to stop. Everything else may be holding a url
    // (workerd puts request urls inside some transport errors), so it is only
    // ever "no answer".
    probe = {
      ...answer(false, isGoogleOAuthRevoked(error)
        ? { outcome: 'refused', failing: ['Google sign-in'], fix: { kind: 'sign-in' } }
        : { outcome: 'unreachable' }),
      checkedAt,
    };
  }

  // A PROBE THAT MADE NO PROVIDER CALL HAS NO VERDICT TO RECORD (bead
  // `ro-vu8d.9`). `last_ok_at` is what the card renders as "this credential
  // worked", and for Clarity and the OAuth app nothing outside this Worker was
  // asked anything — so stamping it would put a green tick on an unproven
  // credential, and, worse, would clear the `last_error` a real 04:30 collector
  // run had left there. The declaration is the gate, so a provider added with
  // `cost: 'none'` inherits the rule instead of having to remember it.
  if (resolved.source === 'store' && provider.test.cost !== 'none') {
    await recordCredentialOutcome(env, provider.id, {
      ok: probe.ok,
      error: probe.ok ? null : probe.message,
      at: checkedAt,
    });
  }
  if (provider.test.cost !== 'none') {
    const capability = PROBE_CAPABILITY[provider.id];
    const available = await observeIntegration(env, health, { capability, observedAt: checkedAt, ok: probe.ok, code: 'provider', evidenceSource: 'probe' });
    if (!available) probe.monitoringAvailable = false;
  }
  return probe;
}

/** A probe's verdict: whether the credential works, and what was found. */
export interface ProbeFound {
  ok: boolean;
  result: ProbeResult;
}

/** A result as the payload carries it: the result, and the same result as one
 * short line for the command line and the stored last error. */
function answer(ok: boolean, result: ProbeResult): Pick<CredentialProbe, 'ok' | 'message' | 'result'> {
  return { ok, result, message: probeLine(result) };
}

/** Mediavine's refusal kinds as results: its login refused (replace it), a
 * wait it asked for or a sync holding the lease (try again soon), or no
 * answer. */
function mediavineRefusal(kind: MediavineError['kind'] | 'network' | undefined): ProbeResult {
  if (kind === 'auth' || kind === 'permission') return { outcome: 'refused', fix: { kind: 'replace' } };
  if (kind === 'rate-limit' || kind === 'busy') return { outcome: 'rate-limited', fix: { kind: 'wait' } };
  return { outcome: 'unreachable' };
}

async function runProbe(
  env: IngestEnv,
  provider: IntegrationProviderId,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<ProbeFound> {
  if (provider === 'cloudflare') {
    try { return { ok: true, result: { outcome: 'answered', facts: { databases: (await listD1Databases(fields, fetchImpl)).length } } }; }
    catch (error) { return { ok: false, result: error instanceof CloudflareD1Error && error.code === 'access_denied' ? { outcome: 'refused', fix: { kind: 'replace' } } : { outcome: 'unreachable' } }; }
  }
  if (provider === 'google') return probeGoogle(env, fields, fetchImpl, nowMs);
  if (provider === 'google-oauth-app') return probeGoogleOAuthApp(fields);
  if (provider === 'bing-webmaster') return probeBing(fields, fetchImpl);
  if (provider === 'dataforseo') return probeDataForSeo(env, fields, fetchImpl, nowMs);
  if (provider === 'calendar') return probeCalendar(fields, fetchImpl);
  if (provider === 'discord') return probeDiscord(fields, fetchImpl);
  if (provider === 'posthog') return probePosthog(env, fields, fetchImpl);
  return probeClarity(fields);
}

/**
 * PostHog: one plain read of each keyed asset's project settings, in the
 * region and project saved on that asset's Sources tab (bead `ro-ghis.1`).
 *
 * No query runs, so none of the hourly query budget the daily archive spends
 * is touched. Reported by ASSET ID, never by key; an asset holding a key but no
 * saved region/project is named as not checked rather than failed, because the
 * key itself was never asked anything.
 */
async function probePosthog(
  env: IngestEnv,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ProbeFound> {
  let keys: Map<string, string>;
  try {
    keys = resolvePosthogKeys(fields[POSTHOG_KEY_SLOT]);
  } catch {
    return { ok: false, result: { outcome: 'invalid', failing: ['PostHog keys'], fix: { kind: 'replace' } } };
  }
  const account = fields[POSTHOG_ACCOUNT_KEY_SLOT];
  const configs = await readCollectorConfigs(env, ['config/integrations.json']);
  const register = configs.documents['config/integrations.json'] as LaneRegister | undefined;
  // The account's one key (bead `ro-ujb9.96.7.8`) reads every site whose
  // entry maps a project and that has no key of its own.
  if (account) {
    for (const asset of Object.keys(register?.assets ?? {})) {
      if (!keys.has(asset) && posthogSettings(asset, register).ok) keys.set(asset, account);
    }
  }
  if (keys.size === 0) {
    if (account) {
      // Nothing mapped yet: the key itself is what can be checked.
      const read = await readPosthogAccount(account, fetchImpl, PROBE_TIMEOUT_MS);
      if (read.verdict === 'accepted') return { ok: true, result: { outcome: 'answered', facts: { projects: read.projects.length, region: read.region } } };
      return { ok: false, result: read.verdict === 'refused' ? { outcome: 'refused', fix: { kind: 'replace' } } : { outcome: 'unreachable' } };
    }
    return { ok: false, result: { outcome: 'not-connected', fix: { kind: 'connect' } } };
  }
  const answered: string[] = [];
  const unmapped: string[] = [];
  const failures: string[] = [];
  let refused = false;
  let status: number | undefined;
  for (const [asset, key] of keys) {
    const read = posthogSettings(asset, register);
    if (!read.ok) {
      unmapped.push(asset);
      continue;
    }
    try {
      const response = await fetchImpl(
        `${posthogOrigin(read.settings.host)}/api/projects/${read.settings.projectId}/`,
        { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      await response.body?.cancel();
      if (response.ok) answered.push(asset);
      else {
        // A refused key, or a project that is not in that region, is PostHog
        // answering no; anything else is its status.
        failures.push(asset);
        refused ||= [401, 403, 404].includes(response.status);
        status ??= response.status;
      }
    } catch {
      failures.push(asset);
    }
  }
  const result: ProbeResult = {
    outcome: failures.length > 0 ? (refused ? 'refused' : 'unreachable') : answered.length > 0 ? 'answered' : 'not-checked',
    facts: { sites: answered.length },
    ...(failures.length > 0 ? { failing: failures } : {}),
    ...(unmapped.length > 0 ? { unchecked: unmapped } : {}),
    ...(status !== undefined ? { status } : {}),
    // The one press: the key when PostHog refused it, else the project for
    // the sites nothing was asked about, picked on their own rows.
    ...(refused ? { fix: { kind: 'replace' as const } } : unmapped.length > 0 ? { fix: { kind: 'map' as const, sites: unmapped } } : {}),
  };
  return { ok: failures.length === 0 && answered.length > 0, result };
}

/**
 * Google: get a read-only token, then `sites.list` — the cheapest call Search
 * Console has, and one that proves the GRANT as well as the credential. GA4 is
 * checked with a property metadata read, which returns no rows and spends no
 * reporting quota.
 *
 * IDENTICAL FOR BOTH WAYS IN (bead `ro-vu8d.3`). The only difference is the
 * press a refusal offers: give the robot the role on the property, or sign in
 * with the account that already has access (`googleFix`).
 */
async function probeGoogle(
  env: IngestEnv,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<ProbeFound> {
  const resolved = await probeGoogleAuth(env, fields);
  if (resolved === null) {
    return { ok: false, result: { outcome: 'invalid', failing: ['Service-account map'], fix: { kind: 'replace' } } };
  }
  const { auth, ga4Property } = resolved;
  const who = googleAuthIdentity(auth);

  const gscToken = await googleAccessToken(auth, GOOGLE_SCOPES.gsc, nowMs, fetchImpl);
  const sites = await fetchImpl('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${gscToken}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!sites.ok) {
    await sites.body?.cancel();
    return {
      ok: false,
      result: { outcome: 'refused', status: sites.status, failing: ['Search Console'], facts: { account: who }, fix: googleFix(auth, 'Search Console', 'Full user') },
    };
  }
  const listed = (await sites.json()) as { siteEntry?: unknown[] };
  const siteCount = Array.isArray(listed.siteEntry) ? listed.siteEntry.length : 0;

  if (ga4Property === null) {
    // A sign-in with nothing mapped is the NORMAL state right after connecting
    // — the asset ↔ property mapping is `ro-vu8d.4` — so it is reported as a
    // pass with the gap named, never as a failure on a credential that works.
    return { ok: true, result: { outcome: 'answered', facts: { sites: siteCount, account: who, ga4Unmapped: true } } };
  }
  const ga4Token = await googleAccessToken(auth, GOOGLE_SCOPES.ga4, nowMs, fetchImpl);
  const metadata = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(ga4Property)}/metadata`,
    {
      headers: { authorization: `Bearer ${ga4Token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  await metadata.body?.cancel();
  if (!metadata.ok) {
    return {
      ok: false,
      result: { outcome: 'refused', status: metadata.status, failing: [`GA4 ${ga4Property}`], facts: { sites: siteCount, account: who }, fix: googleFix(auth, 'Google Analytics', 'Viewer') },
    };
  }
  return { ok: true, result: { outcome: 'answered', facts: { sites: siteCount, account: who } } };
}

/** What clears a Google refusal: the robot given `role` on the property, or —
 * signed in as a person — signing in with the account that has it. */
function googleFix(auth: GoogleAuth, product: 'Search Console' | 'Google Analytics', role: string): ProbeResult['fix'] {
  return auth.kind === 'service-account' ? { kind: 'grant', product, role, to: auth.account.clientEmail } : { kind: 'sign-in' };
}

/**
 * Which credential a Google probe or discovery should run on, and which GA4
 * property (if any) is worth spot-checking.
 *
 * The sign-in wins where there is one: it is the credential the collectors will
 * use, so it is the one a test has to prove.
 */
async function probeGoogleAuth(
  env: IngestEnv,
  fields: Record<string, string>,
): Promise<{ auth: GoogleAuth; ga4Property: string | null } | null> {
  const google = await resolveGoogleCredential(env);
  const accounts = fields.GOOGLE_SIGNAL_ACCOUNTS ?? google.accounts;
  let ga4Property: string | null = null;
  let serviceAccountAuth: GoogleAuth | null = null;
  if (accounts !== undefined) {
    // The saved register and clock, as the collectors read them — never only
    // the product defaults compiled into this Worker (bead ro-ujb9.125).
    const configs = await readCollectorConfigs(env, ['config/integrations.json', 'config/constants.json']);
    const targets = parseGoogleTargets(
      accounts,
      undefined,
      'env',
      google.oauth,
      configs.documents['config/integrations.json'] as LaneRegister | undefined,
      savedOsTimeZone(configs.documents['config/constants.json'], OS_TIME_ZONE),
    );
    ga4Property = targets.find((target) => target.integration === 'ga4')?.propertyRef ?? null;
    const first = targets[0];
    if (first !== undefined && first.auth.kind === 'service-account') {
      serviceAccountAuth = first.auth;
    }
    if (targets.length === 0 && google.oauth === null) return null;
  }
  const auth: GoogleAuth | null =
    google.oauth !== null ? { kind: 'oauth', grant: google.oauth } : serviceAccountAuth;
  return auth === null ? null : { auth, ga4Property };
}

/**
 * The OAuth app: checked WITHOUT calling Google, because there is no free call
 * that proves a client id and secret without dragging a person through a
 * consent screen.
 *
 * So this is a shape check and the press that proves it — an honest "not
 * checked, now sign in" rather than a green tick that would be claiming
 * something nobody verified. The real verdict is the sign-in itself, and its
 * refusals (`invalid_client`, `redirect_uri_mismatch`) name what is wrong.
 */
function probeGoogleOAuthApp(fields: Record<string, string>): ProbeFound {
  const clientId = fields.GOOGLE_OAUTH_CLIENT_ID ?? '';
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    // Not a Google client id: they end in .apps.googleusercontent.com.
    return { ok: false, result: { outcome: 'invalid', failing: ['Client ID'], fix: { kind: 'replace' } } };
  }
  return { ok: true, result: { outcome: 'not-checked', fix: { kind: 'sign-in' } } };
}

/** Bing: `GetUserSites`, the same call the collector opens with. */
async function probeBing(
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ProbeFound> {
  const sites = await getBingVerifiedSites(fields.BING_WEBMASTER_API_KEY!, fetchImpl);
  // No verified site is still a key that works: the card draws `0 sites`
  // beside the provider's own Add link.
  return { ok: true, result: { outcome: 'answered', facts: { sites: sites.size } } };
}

/**
 * DataForSEO: the account endpoint. Free, and it answers the second question an
 * operator has — how much credit is left before the metered lane stops.
 *
 * THE ONE THING A PROBE KEEPS (bead `ro-qpas`). Rule 2 at the top of this file
 * says the body is read for a count and dropped, and that rule is about the
 * PROVIDER'S DATA: no observation, no manifest, no R2 object, nothing that
 * would make a free button into evidence. The credit balance is not that. It is
 * a non-secret fact about the CREDENTIAL — the same public half as the expiry
 * this probe's verdict already writes to. It is recorded WITH the instant it was
 * seen, and the card shows that age, so nothing here can ever be read as a live
 * figure.
 *
 * The call itself lives in `dataforseo-balance.ts` because the weekly sweep now
 * makes the same one (bead `ro-vu8d.26`), and two copies of a free read are two
 * places to get "free" wrong. What stays here is what only a probe owes: the
 * result the operator reads under the button.
 */
async function probeDataForSeo(
  env: IngestEnv,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<ProbeFound> {
  const auth = btoa(`${fields.DATAFORSEO_LOGIN}:${fields.DATAFORSEO_PASSWORD}`);
  const read = await readDataForSeoAccount(`Basic ${auth}`, fetchImpl, PROBE_TIMEOUT_MS);
  if (!read.ok) {
    if (read.reason === 'unauthorized') return { ok: false, result: { outcome: 'refused', fix: { kind: 'replace' } } };
    if (read.reason === 'http') return { ok: false, result: { outcome: 'unreachable', status: read.status } };
    // DataForSEO's own status code in the body: it answered, and said no.
    return { ok: false, result: { outcome: 'refused', ...(read.statusCode === undefined || read.statusCode === null ? {} : { status: read.statusCode }), fix: { kind: 'replace' } } };
  }
  if (read.usd !== null) {
    await recordDataForSeoBalance(env, read.usd, new Date(nowMs).toISOString());
  }
  return { ok: true, result: { outcome: 'answered', facts: { creditUsd: read.usd } } };
}

/** Calendars: one bounded GET per feed, reported BY LABEL. The url is the
 * credential and never appears in the verdict. */
export async function probeCalendar(
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ProbeFound> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fields.CALENDAR_FEEDS ?? '');
  } catch {
    return { ok: false, result: { outcome: 'invalid', failing: ['Feed map'], fix: { kind: 'replace' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, result: { outcome: 'invalid', failing: ['Feed map'], fix: { kind: 'replace' } } };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, result: { outcome: 'not-connected', facts: { feeds: 0, feedsTotal: 0 }, fix: { kind: 'replace' } } };
  }

  const failures: string[] = [];
  for (const [label, entry] of entries) {
    const url = credentialFeedUrl(entry);
    if (url === null) {
      failures.push(label);
      continue;
    }
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'text/calendar, text/plain;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = response.ok ? (await response.text()).slice(0, 2048) : '';
      if (!response.ok) {
        await response.body?.cancel();
        failures.push(label);
      } else if (!text.includes('BEGIN:VCALENDAR')) {
        // A rotated secret link most often answers 200 with a sign-in page.
        failures.push(label);
      }
    } catch {
      failures.push(label);
    }
  }
  const ok = failures.length === 0;
  const facts = { feeds: entries.length - failures.length, feedsTotal: entries.length };
  // A failing feed is most often a rotated secret link: its fix is a new one.
  return ok
    ? { ok, result: { outcome: 'answered', facts } }
    : { ok, result: { outcome: 'refused', facts, failing: failures, fix: { kind: 'replace' } } };
}

/**
 * The line a Discord connection test posts. ONE constant, because
 * `scripts/creds-check.mjs` posts the same sentence from Node (it cannot import
 * this TypeScript) and two wordings would be two things an operator has to
 * recognize in their own channel at 2am.
 *
 * It says what it is and that nothing is wrong, in that order: somebody reading
 * an alert channel sees the first four words before they see anything else.
 */
export const DISCORD_TEST_MESSAGE =
  'NoticeOS connection test — nothing is wrong, you can ignore this.';

/**
 * Discord: post one labelled message. The ONE probe in this file with a side
 * effect, and it is deliberate.
 *
 * Discord does offer a read (`GET` on the webhook url returns the webhook
 * object), and it would have been the cheaper call. It proves the wrong thing.
 * `config/integrations.json` defines this data source as live when *the OS can
 * deliver operator notifications — not merely that a webhook URL exists*, and a
 * read cannot tell those apart: a webhook whose channel the operator lost
 * access to still answers a GET. So the test does the thing the credential
 * exists to do, the provider declares that cost (`IntegrationTest`), and the
 * card prints it beside the button before anybody presses it.
 *
 * The url never appears in a verdict — it IS the credential — and neither does
 * Discord's own error body, which is provider-controlled text.
 */
export async function probeDiscord(
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ProbeFound> {
  const response = await fetchImpl(fields.DISCORD_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: DISCORD_TEST_MESSAGE }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await response.body?.cancel();
  // The same reading a real delivery gets (notifier.ts), so the card says one
  // thing about a dead webhook whichever of the two found it.
  return discordWebhookAnswer(response.status);
}

/**
 * Clarity: NO PROVIDER CALL, and the result says which half of the question
 * that leaves unanswered (bead `ro-vu8d.9`).
 *
 * Rule 1 of this file is that a probe is the provider's cheapest FREE read.
 * Clarity has none — its export API allows ten calls per project per DAY and
 * offers no account or metadata endpoint — so the cheapest available probe
 * would spend a tenth of one asset's daily budget to learn a few hours early
 * what the 04:30 export learns for nothing. That is not a test, it is a tax on
 * pressing a button.
 *
 * So this reports what the OS genuinely knows — how many sites hold a token —
 * as Not checked, with the press that does prove them: the export itself, Run
 * now in the connect panel, which says what it spends. `probeCredential` above
 * will not stamp `last_ok_at` from it, so the card's verdict keeps coming from
 * the collector, which is the only thing that ever proved anything here.
 */
function probeClarity(fields: Record<string, string>): ProbeFound {
  const assets = credentialAssetKeys(fields.CLARITY_TOKENS);
  if (assets.length === 0) return { ok: false, result: { outcome: 'not-connected', facts: { tokens: 0 }, fix: { kind: 'connect' } } };
  return { ok: true, result: { outcome: 'not-checked', facts: { tokens: assets.length }, fix: { kind: 'run-now' } } };
}

// ---------------------------------------------------------------------------
// Disconnect, and what an account can see
// ---------------------------------------------------------------------------

/**
 * Forget one provider's credential — and, for Google, tell Google first.
 *
 * WHY THE REVOKE LIVES HERE AND NOT IN `deleteCredential`. The store knows
 * nothing about providers on purpose (credentials.ts header): every collector
 * imports it, so a Google client imported back would be an import cycle. This
 * module is the one already allowed to know about both, so it is where "a
 * disconnect is a revoke and then a delete" belongs — and every caller gets
 * that ordering by calling ONE function rather than remembering two.
 *
 * The revoke is BEST EFFORT and never blocks the delete: an operator pressing
 * Disconnect on a plane still gets the credential removed.
 */
export async function disconnectCredential(
  env: IngestEnv,
  providerId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DeleteCredentialResult> {
  if (providerId === 'mediavine') return disconnectMediavine(env);
  if (providerId === 'google') {
    await revokeGoogleGrant(env, options.fetchImpl ?? fetch);
  }
  return deleteCredential(env, providerId);
}

export interface DiscoverOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/**
 * The GA4 properties and Search Console sites the connected credential can
 * read — two free list calls, nothing stored.
 *
 * It answers the question an operator has one second after connecting: *did I
 * sign in with the right Google account*. The per-asset picker (`ro-vu8d.4`)
 * consumes exactly this payload; on the card it renders as a read-only list.
 *
 * It works for BOTH ways in. A service-account install gets the same list,
 * which is how they find out the robot was granted on three properties and not
 * the fourth. Each half is reported independently: one API being down must not
 * hide what the other answered.
 */
export async function discoverGoogleProperties(
  env: IngestEnv,
  options: DiscoverOptions = {},
): Promise<GooglePropertyDiscovery> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();

  const health = await tryHealthConnection(env, 'google');
  const resolved = await probeGoogleAuth(env, {});
  if (resolved === null) {
    return {
      ok: false,
      message: 'Google is not connected yet, so there is nothing to list.',
      checkedAt,
      account: null,
      auth: null,
      properties: [],
    };
  }
  const { auth } = resolved;

  let monitoringAvailable = true;
  const properties: GoogleDiscoveredProperty[] = [];
  const failures: string[] = [];
  for (const [label, scope, list] of [
    ['Analytics', GOOGLE_SCOPES.ga4, listGa4Properties],
    ['Search Console', GOOGLE_SCOPES.gsc, listGscSites],
  ] as const) {
    try {
      const token = await googleAccessToken(auth, scope, nowMs, fetchImpl);
      properties.push(...(await list(token, fetchImpl)));
      if (!await observeIntegration(env, health, { capability: 'google-discovery', family: label, observedAt: checkedAt, ok: true, evidenceSource: 'probe' })) monitoringAvailable = false;
    } catch (error) {
      // The code, never the thrown message: a transport error can be holding a
      // request url, and a request url here carries a bearer token.
      if (!await observeIntegration(env, health, { capability: 'google-discovery', family: label, observedAt: checkedAt, ok: false, code: error instanceof SignalError ? error.code : 'network', evidenceSource: 'probe' })) monitoringAvailable = false;
      failures.push(
        `${label} (${error instanceof SignalError ? error.code : 'unreachable'})`,
      );
    }
  }

  const ga4 = properties.filter((entry) => entry.lane === 'ga4').length;
  const gsc = properties.length - ga4;
  return {
    ok: failures.length === 0,
    ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
    message:
      failures.length > 0
        ? `Could not list ${failures.join(' or ')}.`
        : `${ga4} GA4 ${ga4 === 1 ? 'property' : 'properties'} and ${gsc} Search Console ${gsc === 1 ? 'site' : 'sites'}.`,
    checkedAt,
    account: googleAuthIdentity(auth),
    auth: auth.kind,
    properties,
  };
}

/** The most GA4 properties one listing reads a web stream for. */
const GOOGLE_MAX_PROPERTIES = 50;

/**
 * THE GOOGLE ACCOUNT'S SITES, FOR THE CONNECT PANEL (bead `ro-ujb9.96.7.7`):
 * every GA4 property and Search Console site the signed-in account (or the
 * service account) can read, each with the host it answers for, so the panel
 * matches both to a site by domain — two lanes on one row.
 *
 * A GA4 property states no domain of its own; its web data stream's default
 * address does (one free Admin API read per property, the first fifty), and a
 * property whose name is a domain answers for that. A Search Console site is
 * its own address; an unverified one is listed, never ticked.
 *
 * A LISTING IS NOT EVIDENCE, as for every provider (site-discovery.ts): no
 * verdict is stamped and no observation recorded. Each half answers on its
 * own; both refusing is `refused`, neither answering `unreachable`.
 */
export async function discoverGoogleSites(
  env: IngestEnv,
  options: DiscoverOptions = {},
): Promise<{ ok: true; kind: 'account'; sites: DiscoveredSite[] } | { ok: false; reason: 'not-connected' | 'refused' | 'unreachable' }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  const resolved = await probeGoogleAuth(env, {});
  if (resolved === null) return { ok: false, reason: 'not-connected' };
  const { auth } = resolved;
  const sites: DiscoveredSite[] = [];
  let answered = 0;
  let refused = 0;
  const refusal = (error: unknown) => isGoogleOAuthRevoked(error)
    || (error instanceof SignalError && /_http_(400|401|403)$/.test(error.code));
  try {
    const token = await googleAccessToken(auth, GOOGLE_SCOPES.ga4, nowMs, fetchImpl);
    const properties = await listGa4Properties(token, fetchImpl);
    for (const property of properties.slice(0, GOOGLE_MAX_PROPERTIES)) {
      const host = (await ga4StreamHost(property.ref, token, fetchImpl)) ?? siteHost(property.label);
      sites.push({ lane: 'ga4', ref: property.ref, label: property.label, host, mapping: { propertyId: property.ref }, ready: true });
    }
    answered += 1;
  } catch (error) {
    if (refusal(error)) refused += 1;
  }
  try {
    const token = await googleAccessToken(auth, GOOGLE_SCOPES.gsc, nowMs, fetchImpl);
    for (const site of await listGscSites(token, fetchImpl)) {
      sites.push({
        lane: 'gsc', ref: site.ref, label: site.ref, host: siteHost(site.ref), mapping: { siteUrl: site.ref },
        // Google lists a site the account has not verified; the collector
        // cannot read it until it is.
        ready: site.detail !== 'siteUnverifiedUser',
      });
    }
    answered += 1;
  } catch (error) {
    if (refusal(error)) refused += 1;
  }
  if (answered === 0) return { ok: false, reason: refused > 0 ? 'refused' : 'unreachable' };
  return { ok: true, kind: 'account', sites };
}

/** The host a GA4 property's first web data stream answers for, or null. */
async function ga4StreamHost(propertyId: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/dataStreams`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = (await response.json()) as { dataStreams?: { webStreamData?: { defaultUri?: unknown } }[] };
    for (const stream of body.dataStreams ?? []) {
      const host = siteHost(typeof stream?.webStreamData?.defaultUri === 'string' ? stream.webStreamData.defaultUri : null);
      if (host !== null) return host;
    }
    return null;
  } catch {
    return null;
  }
}
