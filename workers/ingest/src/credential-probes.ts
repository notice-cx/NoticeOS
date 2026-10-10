import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
// Connection tests: one least-privileged call per provider. Apart from the
// store (credentials.ts) on purpose: every collector imports the resolver, the
// probes import every collector's client, and one module would be an import
// cycle.
//
// Three rules. The call is the cheapest authenticated read the provider offers
// and free wherever it has a free tier; where it is not free of consequence
// (Discord's only real proof is a posted message) the provider declares that in
// `test.cost`. The response body is read for a count and dropped: a
// probe is not evidence, and the one thing kept is a fact about the credential
// (DataForSEO's prepaid credit, with the instant it was seen). No result
// contains a credential: a calendar failure names the label and never the url,
// and a transport error's own message is never copied. Every probe answers a
// `ProbeResult`; `message` is the same result as one line (`probeLine`).

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
import { DISCORD_TEST_MESSAGE } from '@noticeos/contract/provider-requests';
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
  // `credentialAuthState` already decided this credential is complete, so a
  // per-field re-check here would be a second rule. What is still worth
  // checking is Google's OAuth app: a stored refresh token with no client
  // secret beside it is complete by the store's rule and unusable by Google's.
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
    // A revoked or expired Google grant is its own result: swallowed into "no
    // answer" it would read as a flaky network. Everything else may be holding
    // a url, so it is only ever "no answer".
    probe = {
      ...answer(false, isGoogleOAuthRevoked(error)
        ? { outcome: 'refused', failing: ['Google sign-in'], fix: { kind: 'sign-in' } }
        : { outcome: 'unreachable' }),
      checkedAt,
    };
  }

  // A probe that made no provider call has no verdict to record: stamping
  // `last_ok_at` would put a green tick on an unproven credential and clear the
  // `last_error` a real collector run left. The declaration is the gate.
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

/** Mediavine's refusal kinds as results. */
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
 * PostHog: one plain read of each keyed asset's project settings. No query
 * runs, so the hourly query budget is untouched. Reported by asset id, never
 * by key; an asset holding a key but no saved region/project is named as not
 * checked rather than failed.
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
  // The account's one key reads every site whose entry maps a project and that
  // has no key of its own.
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
 * Google: a read-only token, then `sites.list` (the cheapest Search Console
 * call, and one that proves the grant). GA4 is checked with a property
 * metadata read, which spends no reporting quota. Identical for both ways in;
 * only the press a refusal offers differs (`googleFix`).
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
    // A sign-in with nothing mapped is the normal state right after connecting:
    // a pass with the gap named, never a failure.
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

/** What clears a Google refusal: the robot given `role` on the property, or
 * signing in with the account that has it. */
function googleFix(auth: GoogleAuth, product: 'Search Console' | 'Google Analytics', role: string): ProbeResult['fix'] {
  return auth.kind === 'service-account' ? { kind: 'grant', product, role, to: auth.account.clientEmail } : { kind: 'sign-in' };
}

/**
 * Which credential a Google probe or discovery runs on, and which GA4 property
 * is worth spot-checking. The sign-in wins where there is one: it is the
 * credential the collectors will use.
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
    // The saved register and clock, as the collectors read them.
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
 * The OAuth app: a shape check and the press that proves it, because there is
 * no free call that proves a client id and secret without a consent screen. An
 * honest "not checked, now sign in" rather than an unverified green tick.
 */
function probeGoogleOAuthApp(fields: Record<string, string>): ProbeFound {
  const clientId = fields.GOOGLE_OAUTH_CLIENT_ID ?? '';
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
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
  // No verified site is still a key that works.
  return { ok: true, result: { outcome: 'answered', facts: { sites: sites.size } } };
}

/**
 * DataForSEO: the free account endpoint, which also answers how much credit is
 * left. The credit is the one thing a probe keeps: a non-secret fact about the
 * credential, recorded with the instant it was seen so the card can age it.
 * The call lives in `dataforseo-balance.ts` because the weekly sweep makes the
 * same one.
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

/** Calendars: one bounded GET per feed, reported by label. The url is the
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
 * Discord: post one labelled message, the one probe with a side effect. A GET
 * on the webhook url would be cheaper and proves the wrong thing: a webhook
 * whose channel the operator lost still answers it. The url never appears in a
 * verdict, and neither does Discord's own error body.
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
  // The same reading a real delivery gets (notifier.ts).
  return discordWebhookAnswer(response.status);
}

/**
 * Clarity: no provider call. Its export API allows ten calls per project per
 * day and offers no account endpoint, so the cheapest probe would spend a
 * tenth of a day's budget. This reports how many sites hold a token as Not
 * checked, with the press that does prove them (Run now). `probeCredential`
 * will not stamp `last_ok_at` from it.
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
 * Forget one provider's credential, and for Google tell Google first. The
 * revoke lives here rather than in `deleteCredential` because the store knows
 * nothing about providers. Best effort, never blocking the delete.
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
 * read: two free list calls, nothing stored. Works for both ways in, and each
 * half is reported independently.
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
      // request url, which here carries a bearer token.
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
 * The Google account's sites, for the connect panel: every GA4 property and
 * Search Console site the account can read, each with the host it answers for.
 * A GA4 property states no domain of its own; its web data stream's default
 * address does (one free Admin API read per property, the first fifty). An
 * unverified Search Console site is listed, never ticked. A listing is not
 * evidence: no verdict is stamped. Both halves refusing is `refused`, neither
 * answering `unreachable`.
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
